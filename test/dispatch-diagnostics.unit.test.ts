import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./harness/run-pi.ts";

const root = repoRoot();
const diagnosticsPath = join(root, ".pi/extensions/gitjig/dispatch/diagnostics.ts");

interface AdmitModule {
	admitReturn(path: string): { admitted: boolean; class: string; cause?: string };
	RETURN_LIMIT_BYTES: number;
}

interface DiagnosticsModule {
	DIAGNOSTIC_MESSAGES: Readonly<Record<string, string>>;
	RETURN_CODE_BY_CLASS: Readonly<Record<string, string>>;
	makeDiagnostic(input: Record<string, unknown>): unknown;
	serializeDiagnostic(value: unknown): string;
}

async function diagnostics(): Promise<DiagnosticsModule> {
	assert.ok(existsSync(diagnosticsPath), "#267 diagnostics owner is absent");
	return (await import(`${pathToFileURL(diagnosticsPath).href}?v=${Date.now()}`)) as DiagnosticsModule;
}

describe("#267 closed dispatcher diagnostics", () => {
	it("owns the exact one-to-one code/message vocabulary", async () => {
		const mod = await diagnostics();
		assert.deepEqual(mod.DIAGNOSTIC_MESSAGES, {
			PARAMETER_REFUSED: "dispatch refused: dispatcher parameters were invalid; nothing started",
			PROVISION_FAILED: "dispatch refused: the isolated execution context could not be provisioned; nothing started",
			SPAWN_FAILED: "dispatch refused: the delegate could not be started; no return was inspected",
			SIGNAL_TERMINATED: "dispatch refused: the delegate terminated by signal; no return was inspected",
			TIMED_OUT: "dispatch refused: the delegate exceeded its run bound; no return was inspected",
			ABORTED: "dispatch refused: the delegate run was aborted; no return was inspected",
			RETURN_MISSING: "dispatch refused: no return file was present after the delegate exited",
			RETURN_NOT_REGULAR: "dispatch refused: the return slot was not a regular file",
			RETURN_OVERSIZE: "dispatch refused: the return exceeded the 65536-byte bound",
			RETURN_UNREADABLE: "dispatch refused: the return could not be read exactly",
			RETURN_JSON_INVALID: "dispatch refused: the return was not valid UTF-8 JSON",
			RETURN_SCHEMA_INVALID: "dispatch refused: the return did not match the closed schema",
			RETURN_OPERAND_REJECTED: "dispatch refused: the return named a caller-held operand",
			INTERNAL_FAILED: "dispatch refused: the dispatcher encountered an internal failure",
			ADMITTED: "dispatch admitted",
		});
	});

	it("owns the exact return-class to code mapping", async () => {
		const mod = await diagnostics();
		assert.deepEqual(mod.RETURN_CODE_BY_CLASS, {
			missing: "RETURN_MISSING",
			"not-regular": "RETURN_NOT_REGULAR",
			oversize: "RETURN_OVERSIZE",
			unreadable: "RETURN_UNREADABLE",
			"json-invalid": "RETURN_JSON_INVALID",
			"schema-invalid": "RETURN_SCHEMA_INVALID",
			"operand-rejected": "RETURN_OPERAND_REJECTED",
		});
	});

	it("classifies each directly constructible return failure without collapsing it", async () => {
		const admitPath = join(root, ".pi/extensions/gitjig/dispatch/admit.ts");
		const admit = (await import(`${pathToFileURL(admitPath).href}?v=${Date.now()}`)) as AdmitModule;
		const dir = mkdtempSync(join(tmpdir(), "gitjig-267-return-"));
		assert.equal(admit.admitReturn(join(dir, "missing.json")).class, "missing");
		mkdirSync(join(dir, "directory.json"));
		assert.equal(admit.admitReturn(join(dir, "directory.json")).class, "not-regular");
		symlinkSync("missing-target", join(dir, "link.json"));
		assert.equal(admit.admitReturn(join(dir, "link.json")).class, "not-regular");
		writeFileSync(join(dir, "oversize.json"), "x".repeat(admit.RETURN_LIMIT_BYTES + 1));
		assert.equal(admit.admitReturn(join(dir, "oversize.json")).class, "oversize");
		writeFileSync(join(dir, "json.json"), Buffer.from([0xff]));
		assert.equal(admit.admitReturn(join(dir, "json.json")).class, "json-invalid");
		writeFileSync(join(dir, "schema.json"), '{"ok":true,"summary":"x","extra":1}');
		assert.equal(admit.admitReturn(join(dir, "schema.json")).class, "schema-invalid");
	});

	it("binds every ordinary code to its exact phase, run class, and return class", async () => {
		const mod = await diagnostics();
		const rows = [
			["PARAMETER_REFUSED", "preflight", "not-started", "not-inspected"],
			["PROVISION_FAILED", "provision", "not-started", "not-inspected"],
			["SPAWN_FAILED", "spawn", "not-started", "not-inspected"],
			["SIGNAL_TERMINATED", "run", "signaled", "not-inspected"],
			["TIMED_OUT", "run", "timed-out", "not-inspected"],
			["ABORTED", "run", "aborted", "not-inspected"],
			["RETURN_MISSING", "return", "exited", "missing"],
			["RETURN_NOT_REGULAR", "return", "exited", "not-regular"],
			["RETURN_OVERSIZE", "return", "exited", "oversize"],
			["RETURN_UNREADABLE", "return", "exited", "unreadable"],
			["RETURN_JSON_INVALID", "return", "exited", "json-invalid"],
			["RETURN_SCHEMA_INVALID", "return", "exited", "schema-invalid"],
			["RETURN_OPERAND_REJECTED", "return", "exited", "operand-rejected"],
		] as const;
		for (const [code, phase, runClass, returnClass] of rows) {
			const value = mod.makeDiagnostic({
				status: "refused",
				phase,
				run: {
					class: runClass,
					exitCode: runClass === "exited" ? 17 : null,
					signal: runClass === "signaled" ? "SIGTERM" : null,
				},
				return: { class: returnClass },
				compare: { class: "not-reached" },
				durationMs: 1,
				code,
			}) as { code: string };
			assert.equal(value.code, code);
			const wrong = mod.makeDiagnostic({
				status: "refused",
				phase: phase === "return" ? "run" : "return",
				run: {
					class: runClass,
					exitCode: runClass === "exited" ? 17 : null,
					signal: runClass === "signaled" ? "SIGTERM" : null,
				},
				return: { class: returnClass },
				compare: { class: "not-reached" },
				durationMs: 1,
				code,
			}) as { code: string };
			assert.equal(wrong.code, "INTERNAL_FAILED", `${code} admitted the wrong phase`);
		}
	});

	it("rejects out-of-range exit codes and preserves completed compare facts for serialize failure", async () => {
		const mod = await diagnostics();
		const huge = mod.makeDiagnostic({
			status: "admitted",
			phase: "return",
			run: { class: "exited", exitCode: 2 ** 40, signal: null },
			return: { class: "admitted" },
			compare: { class: "not-requested" },
			durationMs: 1,
			code: "ADMITTED",
		}) as { code: string };
		assert.equal(huge.code, "INTERNAL_FAILED");
		const preserved = mod.makeDiagnostic({
			status: "refused",
			phase: "serialize",
			run: { class: "exited", exitCode: 0, signal: null },
			return: { class: "admitted" },
			compare: { class: "confirmed" },
			durationMs: 1,
			code: "INTERNAL_FAILED",
		}) as { code: string; compare: { class: string } };
		assert.deepEqual([preserved.code, preserved.compare.class], ["INTERNAL_FAILED", "confirmed"]);
		for (const impossible of [
			{
				phase: "return",
				run: { class: "not-started", exitCode: null, signal: null },
				return: { class: "missing" },
				compare: { class: "not-reached" },
			},
			{
				phase: "serialize",
				run: { class: "timed-out", exitCode: null, signal: null },
				return: { class: "admitted" },
				compare: { class: "not-requested" },
			},
			{
				phase: "preflight",
				run: { class: "exited", exitCode: 0, signal: null },
				return: { class: "json-invalid" },
				compare: { class: "not-reached" },
			},
		] as const) {
			const normalized = mod.makeDiagnostic({
				status: "refused",
				...impossible,
				durationMs: 1,
				code: "INTERNAL_FAILED",
			}) as {
				run: { class: string };
				return: { class: string };
			};
			assert.deepEqual([normalized.run.class, normalized.return.class], ["internal-failed", "not-inspected"]);
		}
	});

	it("turns an impossible constructor request into INTERNAL_FAILED", async () => {
		const mod = await diagnostics();
		const value = mod.makeDiagnostic({
			status: "admitted",
			phase: "compare",
			run: { class: "exited", exitCode: 0, signal: "SIGTERM" },
			return: { class: "missing" },
			compare: { class: "confirmed" },
			durationMs: Number.POSITIVE_INFINITY,
			code: "ADMITTED",
		}) as { code: string; status: string; durationMs: number };
		assert.deepEqual([value.code, value.status, value.durationMs], ["INTERNAL_FAILED", "refused", 0]);
	});

	it("serializes the closed grammar in normative key order", async () => {
		const mod = await diagnostics();
		const value = mod.makeDiagnostic({
			status: "refused",
			phase: "run",
			run: { class: "timed-out", exitCode: null, signal: null },
			return: { class: "not-inspected" },
			compare: { class: "not-reached" },
			durationMs: 7,
			code: "TIMED_OUT",
		});
		assert.equal(
			mod.serializeDiagnostic(value),
			'{"schemaVersion":1,"status":"refused","phase":"run","run":{"class":"timed-out","exitCode":null,"signal":null},"return":{"class":"not-inspected"},"compare":{"class":"not-reached"},"durationMs":7,"code":"TIMED_OUT","message":"dispatch refused: the delegate exceeded its run bound; no return was inspected"}',
		);
	});
});

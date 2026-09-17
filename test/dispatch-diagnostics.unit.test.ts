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

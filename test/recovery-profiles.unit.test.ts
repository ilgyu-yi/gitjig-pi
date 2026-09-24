import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { hasRecoveryRetryReserve } from "../.pi/extensions/gitjig/recovery/coordinator.ts";
import {
	loadRecoveryProfiles,
	materializeRecoveryProfile,
	preflightRecoveryExecutable,
	RECOVERY_INITIAL_PROMPT,
} from "../.pi/extensions/gitjig/recovery/profiles.ts";

const HELP = [
	"Options:",
	"  --print, -p  x",
	"  --thinking <level>  x",
	"  --no-session  x",
	"  --no-extensions, -ne  x",
	"  --no-skills, -ns  x",
	"  --no-context-files, -nc  x",
	"  --approve, -a  x",
	"  --  End option parsing;",
	"Extensions can register additional flags",
].join("\n");

function withPi(script: string, run: () => void): void {
	const root = mkdtempSync(join(tmpdir(), "gitjig-profile-preflight-"));
	const path = join(root, "pi");
	writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
	chmodSync(path, 0o700);
	const prior = process.env.PATH;
	process.env.PATH = `${root}:${prior ?? ""}`;
	try {
		run();
	} finally {
		if (prior === undefined) delete process.env.PATH;
		else process.env.PATH = prior;
		rmSync(root, { recursive: true, force: true });
	}
}

describe("closed Phase-A recovery profiles", () => {
	it("loads exactly five ambient-default profiles with one canonical digest", () => {
		const loaded = loadRecoveryProfiles();
		assert.ok(loaded);
		assert.match(loaded.digest, /^[0-9a-f]{64}$/);
		assert.deepEqual(
			loaded.set.profiles.map((profile) => profile.id),
			["recovery-diagnosis", "recovery-measurement", "recovery-selector", "stagnation-blast-radius", "stagnation-root"],
		);
		assert.ok(loaded.set.profiles.every((profile) => profile.runBoundMs === 600_000));
	});

	it("materializes the sole argv and accepts no provider/model flag", () => {
		const loaded = loadRecoveryProfiles();
		assert.ok(loaded);
		const value = materializeRecoveryProfile(loaded, "recovery-selector");
		assert.ok(value);
		assert.equal(
			RECOVERY_INITIAL_PROMPT,
			"Read ../brief.md completely. Write a complete provisional ../return.json early, then overwrite it with the final closed return before the stated deadline.",
		);
		assert.deepEqual(value.argv, [
			"pi",
			"-p",
			"--thinking",
			"high",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--approve",
			"--",
			RECOVERY_INITIAL_PROMPT,
		]);
		assert.doesNotMatch(value.argv.join(" "), /--provider|--model/);
		assert.match(value.digest, /^[0-9a-f]{64}$/);
	});

	it("pins the slot maxima and exact missing-return retry reserve", () => {
		assert.equal(hasRecoveryRetryReserve(599_999, 0), false);
		assert.equal(hasRecoveryRetryReserve(600_000, 0), true);
		const source = readFileSync(new URL("../.pi/extensions/gitjig/recovery/coordinator.ts", import.meta.url), "utf8");
		assert.match(source, /SLOT_OPERATION_MS = 1_200_000/);
		assert.match(source, /SLOT_RESERVE_MS = 1_260_000/);
		assert.match(source, /RETRY_REMAINING_MS = 660_000/);
	});

	it("kills private-copy retry reserve and slot arithmetic mutants at the exact boundary", async () => {
		const root = mkdtempSync(join(tmpdir(), "gitjig-retry-mutants-"));
		try {
			cpSync(new URL("../.pi/extensions/gitjig", import.meta.url), join(root, "gitjig"), { recursive: true });
			symlinkSync(new URL("../node_modules", import.meta.url), join(root, "node_modules"), "dir");
			const path = join(root, "gitjig", "recovery", "coordinator.ts");
			const original = readFileSync(path, "utf8");
			assert.equal(hasRecoveryRetryReserve(600_000, 0), true);
			assert.equal(hasRecoveryRetryReserve(599_999, 0), false);
			for (const [index, [needle, replacement]] of (
				[
					["RETRY_REMAINING_MS = 660_000", "RETRY_REMAINING_MS = 660_001"],
					["SLOT_RESERVE_MS = 1_260_000", "SLOT_RESERVE_MS = 1_259_999"],
					["SLOT_OPERATION_MS = 1_200_000", "SLOT_OPERATION_MS = 1_200_001"],
				] as const
			).entries()) {
				assert.equal(original.split(needle).length, 2);
				writeFileSync(path, original.replace(needle, replacement));
				const mutant = await import(`${new URL(`file://${path}`).href}?retryMutant=${String(index)}`);
				assert.equal(mutant.hasRecoveryRetryReserve(600_000, 0), false);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("kills the private-copy retained-record byte-cap mutant in its owner test", () => {
		const root = mkdtempSync(join(tmpdir(), "gitjig-record-cap-mutant-"));
		try {
			mkdirSync(join(root, ".pi", "extensions"), { recursive: true });
			cpSync(new URL("../.pi/extensions/gitjig", import.meta.url), join(root, ".pi", "extensions", "gitjig"), {
				recursive: true,
			});
			mkdirSync(join(root, "test"));
			cpSync(
				new URL("./recovery-coordinator.unit.test.ts", import.meta.url),
				join(root, "test", "recovery-coordinator.unit.test.ts"),
			);
			symlinkSync(new URL("../node_modules", import.meta.url), join(root, "node_modules"), "dir");
			const path = join(root, ".pi", "extensions", "gitjig", "recovery", "coordinator.ts");
			const original = readFileSync(path, "utf8");
			assert.equal(original.split("MAX_RETAINED_RECORD_BYTES = 192 * 1024").length, 2);
			writeFileSync(
				path,
				original.replace("MAX_RETAINED_RECORD_BYTES = 192 * 1024", "MAX_RETAINED_RECORD_BYTES = 1920 * 1024"),
			);
			const result = spawnSync(
				process.execPath,
				[
					"--test",
					"--test-name-pattern=pins the exact 192 KiB durable consumed-record cap",
					join(root, "test", "recovery-coordinator.unit.test.ts"),
				],
				{
					cwd: process.cwd(),
					env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("NODE_TEST"))),
					encoding: "utf8",
					timeout: 30_000,
				},
			);
			assert.equal(result.signal, null, result.stderr);
			assert.equal(result.status, 1, `retained-record cap mutant survived\n${result.stdout}\n${result.stderr}`);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("kills private-copy recovery payload and route-text guard mutants through owner refusals", () => {
		const root = mkdtempSync(join(tmpdir(), "gitjig-recovery-input-mutants-"));
		try {
			mkdirSync(join(root, ".pi", "extensions"), { recursive: true });
			cpSync(new URL("../.pi/extensions/gitjig", import.meta.url), join(root, ".pi", "extensions", "gitjig"), {
				recursive: true,
			});
			mkdirSync(join(root, "test"));
			cpSync(
				new URL("./recovery-coordinator.unit.test.ts", import.meta.url),
				join(root, "test", "recovery-coordinator.unit.test.ts"),
			);
			symlinkSync(new URL("../node_modules", import.meta.url), join(root, "node_modules"), "dir");
			const path = join(root, ".pi", "extensions", "gitjig", "recovery", "coordinator.ts");
			const original = readFileSync(path, "utf8");
			for (const [needle, replacement, arm] of [
				["Object.keys(value).length === keys.length &&", "true &&", "rejects duplicate/extra payload keys"],
				[
					'if (value !== value.normalize("NFC")) return false;',
					"if (false) return false;",
					"rejects duplicate/extra payload keys",
				],
				[
					"if (hasDuplicateJsonKeys(outcome.payload)) return undefined;",
					"if (false) return undefined;",
					"rejects duplicate/extra payload keys",
				],
				[
					'outcome.compare !== "confirmed" ||',
					"false ||",
					"rejects a recovery payload without independently confirmed head compare",
				],
				["codePoint <= 0x1f ||", "false ||", "rejects duplicate/extra payload keys"],
			] as const) {
				assert.equal(original.split(needle).length, 2, needle);
				writeFileSync(path, original.replace(needle, replacement));
				const result = spawnSync(
					process.execPath,
					["--test", `--test-name-pattern=${arm}`, join(root, "test", "recovery-coordinator.unit.test.ts")],
					{
						cwd: process.cwd(),
						env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("NODE_TEST"))),
						encoding: "utf8",
						timeout: 30_000,
					},
				);
				assert.equal(result.signal, null, result.stderr);
				assert.equal(result.status, 1, `recovery guard mutant survived: ${needle}\n${result.stdout}\n${result.stderr}`);
				writeFileSync(path, original);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("kills private-copy route work and terminal deadline mutants through durable owner probes", () => {
		const root = mkdtempSync(join(tmpdir(), "gitjig-route-mutants-"));
		try {
			mkdirSync(join(root, ".pi", "extensions"), { recursive: true });
			cpSync(new URL("../.pi/extensions/gitjig", import.meta.url), join(root, ".pi", "extensions", "gitjig"), {
				recursive: true,
			});
			mkdirSync(join(root, "test"));
			cpSync(
				new URL("./recovery-coordinator.unit.test.ts", import.meta.url),
				join(root, "test", "recovery-coordinator.unit.test.ts"),
			);
			symlinkSync(new URL("../node_modules", import.meta.url), join(root, "node_modules"), "dir");
			const path = join(root, ".pi", "extensions", "gitjig", "recovery", "coordinator.ts");
			const original = readFileSync(path, "utf8");
			for (const [needle, replacement] of [
				["ROUTE_WORK_MS = 3_780_000", "ROUTE_WORK_MS = 3_780_001"],
				["ROUTE_TERMINAL_MS = 3_840_000", "ROUTE_TERMINAL_MS = 3_840_001"],
			] as const) {
				assert.equal(original.split(needle).length, 2);
				writeFileSync(path, original.replace(needle, replacement));
				const result = spawnSync(
					process.execPath,
					[
						"--test",
						"--test-name-pattern=pins both sides of the route work cutoff",
						join(root, "test", "recovery-coordinator.unit.test.ts"),
					],
					{
						cwd: process.cwd(),
						env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("NODE_TEST"))),
						encoding: "utf8",
						timeout: 30_000,
					},
				);
				assert.equal(result.signal, null, result.stderr);
				assert.equal(result.status, 1, `route mutant survived: ${needle}\n${result.stdout}\n${result.stderr}`);
				assert.match(result.stdout, /✖ pins both sides of the route work cutoff/);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("kills a private-copy attempt-bound mutant and observes min(bound, remaining) at the dispatcher seam", async () => {
		const root = mkdtempSync(join(tmpdir(), "gitjig-attempt-bound-"));
		const priorLog = process.env.RECOVERY_TIMEOUT_LOG;
		try {
			cpSync(new URL("../.pi/extensions/gitjig", import.meta.url), join(root, "gitjig"), { recursive: true });
			symlinkSync(new URL("../node_modules", import.meta.url), join(root, "node_modules"), "dir");
			const path = join(root, "gitjig", "recovery", "coordinator.ts");
			const original = readFileSync(path, "utf8");
			const needle = 'import { runDispatch } from "../dispatch/index.ts";';
			assert.equal(original.split(needle).length, 2);
			const shim = join(root, "gitjig", "recovery", "timeout-shim.ts");
			writeFileSync(
				shim,
				`import {writeFileSync} from "node:fs"; import {makeDiagnostic} from "../dispatch/diagnostics.ts"; export async function runDispatch(options){writeFileSync(process.env.RECOVERY_TIMEOUT_LOG,String(options.timeoutMs));return {disposition:"refused",cause:"absent",diagnostic:makeDiagnostic({status:"refused",phase:"spawn",run:{class:"not-started",exitCode:null,signal:null},return:{class:"not-inspected"},compare:{class:"not-reached"},durationMs:0,code:"SPAWN_FAILED"})};}`,
			);
			const log = join(root, "timeout.log");
			process.env.RECOVERY_TIMEOUT_LOG = log;
			const ledger = await import(new URL(`file://${join(root, "gitjig", "review", "orchestrate.ts")}`).href);
			for (const [index, bound] of ([600_000, 600_001] as const).entries()) {
				const source =
					index === 0 ? original : original.replace("ATTEMPT_BOUND_MS = 600_000", "ATTEMPT_BOUND_MS = 600_001");
				writeFileSync(path, source.replace(needle, 'import { runDispatch } from "./timeout-shim.ts";'));
				const coordinator = await import(`${new URL(`file://${path}`).href}?bound=${String(index)}`);
				for (const [remaining, expected] of [
					[650_000, bound],
					[500_000, 500_000],
				] as const) {
					const dispatch = coordinator.makeRecoveryProfileDispatcher({ repoRoot: process.cwd(), stateRoot: root });
					await dispatch(
						ledger.createRecoveryAttemptLedger(performance.now()),
						"recovery-selector",
						"brief",
						"b".repeat(40),
						performance.now() + remaining,
					);
					const observed = Number(readFileSync(log, "utf8"));
					if (remaining === 650_000) {
						assert.equal(observed, expected);
						if (index === 1) assert.notEqual(observed, 600_000, "mutant must fail the owner bound assertion");
					} else assert.ok(observed <= 500_000 && observed >= 499_000, `remaining bound: ${String(observed)}`);
				}
			}
		} finally {
			if (priorLog === undefined) delete process.env.RECOVERY_TIMEOUT_LOG;
			else process.env.RECOVERY_TIMEOUT_LOG = priorLog;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("pins the installed executable help grammar before claim", () => {
		assert.equal(preflightRecoveryExecutable(), true);
	});

	it("refuses every missing or duplicate help declaration and boundary", () => {
		withPi(`printf '%b\\n' ${JSON.stringify(HELP)}`, () => assert.equal(preflightRecoveryExecutable(), true));
		const required = HELP.split("\n").slice(1, -1);
		for (const line of required) {
			withPi(`printf '%b\\n' ${JSON.stringify(HELP.replace(`${line}\n`, ""))}`, () =>
				assert.equal(preflightRecoveryExecutable(), false),
			);
			withPi(`printf '%b\\n' ${JSON.stringify(HELP.replace(line, `${line}\n${line}`))}`, () =>
				assert.equal(preflightRecoveryExecutable(), false),
			);
		}
		for (const boundary of ["Options:", "Extensions can register additional flags"]) {
			withPi(`printf '%b\\n' ${JSON.stringify(HELP.replace(boundary, ""))}`, () =>
				assert.equal(preflightRecoveryExecutable(), false),
			);
			withPi(`printf '%b\\n' ${JSON.stringify(`${boundary}\n${HELP}`)}`, () =>
				assert.equal(preflightRecoveryExecutable(), false),
			);
		}
	});

	it("refuses nonzero, signal, invalid UTF-8, oversized output, timeout, and spawn failure", () => {
		withPi("exit 7", () => assert.equal(preflightRecoveryExecutable(), false));
		withPi("kill -TERM $$", () => assert.equal(preflightRecoveryExecutable(), false));
		withPi("printf '\\377'", () => assert.equal(preflightRecoveryExecutable(), false));
		withPi("dd if=/dev/zero bs=1048577 count=1 2>/dev/null", () => assert.equal(preflightRecoveryExecutable(), false));
		withPi("sleep 11", () => assert.equal(preflightRecoveryExecutable(), false));
		const prior = process.env.PATH;
		const empty = mkdtempSync(join(tmpdir(), "gitjig-profile-no-pi-"));
		try {
			process.env.PATH = empty;
			assert.equal(preflightRecoveryExecutable(), false);
		} finally {
			process.env.PATH = prior;
			rmSync(empty, { recursive: true, force: true });
		}
	});

	it("kills each omitted materialized flag and initial prompt in a private copy", async () => {
		const root = mkdtempSync(join(tmpdir(), "gitjig-argv-mutants-"));
		try {
			cpSync(new URL("../.pi/extensions/gitjig", import.meta.url), join(root, "gitjig"), { recursive: true });
			symlinkSync(new URL("../node_modules", import.meta.url), join(root, "node_modules"), "dir");
			const path = join(root, "gitjig", "recovery", "profiles.ts");
			const original = readFileSync(path, "utf8");
			const baseline = loadRecoveryProfiles();
			assert.ok(baseline);
			const expected = materializeRecoveryProfile(baseline, "recovery-selector")?.argv;
			assert.ok(expected);
			for (const [index, token] of [
				"-p",
				"--thinking",
				"high",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-context-files",
				"--approve",
				"--",
				"RECOVERY_INITIAL_PROMPT",
			].entries()) {
				const target = `\t\t"${token}",`;
				const needle = token === "RECOVERY_INITIAL_PROMPT" ? "\t\tRECOVERY_INITIAL_PROMPT," : target;
				assert.equal(original.split(needle).length, 2, token);
				writeFileSync(path, original.replace(needle, ""));
				const mutated = await import(`${new URL(`file://${path}`).href}?argvMutant=${String(index)}`);
				const set = mutated.loadRecoveryProfiles();
				assert.ok(set);
				const argv = mutated.materializeRecoveryProfile(set, "recovery-selector")?.argv;
				assert.notDeepEqual(argv, expected, `owner exact argv assertion must reject missing ${token}`);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("kills closed profile schema and digest-input mutants in an isolated copy", async () => {
		const root = mkdtempSync(join(tmpdir(), "gitjig-profile-mutants-"));
		try {
			cpSync(new URL("../.pi/extensions/gitjig", import.meta.url), join(root, "gitjig"), { recursive: true });
			symlinkSync(new URL("../node_modules", import.meta.url), join(root, "node_modules"), "dir");
			const path = join(root, "gitjig", "recovery", "profiles.json");
			const original = JSON.parse(readFileSync(path, "utf8")) as {
				schemaVersion: number;
				profiles: Record<string, unknown>[];
			};
			const mutants: ((value: typeof original) => void)[] = [
				(value) => {
					value.schemaVersion = 2;
				},
				(value) => {
					value.profiles.pop();
				},
				(value) => {
					value.profiles[0].id = "unsupported";
				},
				(value) => {
					value.profiles[0].provider = "claimed-provider";
				},
				(value) => {
					value.profiles[0].model = "claimed-model";
				},
				(value) => {
					value.profiles[0].thinking = "low";
				},
				(value) => {
					value.profiles[0].runBoundMs = 600001;
				},
				(value) => {
					value.profiles[0].extra = true;
				},
			];
			for (let index = 0; index < mutants.length; index += 1) {
				const value = structuredClone(original);
				mutants[index](value);
				writeFileSync(path, JSON.stringify(value));
				const module = await import(
					`${new URL(`file://${join(root, "gitjig", "recovery", "profiles.ts")}`).href}?mutant=${String(index)}`
				);
				assert.equal(module.loadRecoveryProfiles(), undefined);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

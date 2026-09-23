import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

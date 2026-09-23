import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
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

	it("pins the installed executable help grammar before claim", () => {
		assert.equal(preflightRecoveryExecutable(), true);
	});

	it("refuses missing/duplicate approve declarations and nonzero preflight", () => {
		withPi(`printf '%b\\n' ${JSON.stringify(HELP)}`, () => assert.equal(preflightRecoveryExecutable(), true));
		withPi(`printf '%b\\n' ${JSON.stringify(HELP.replace("  --approve, -a  x\n", ""))}`, () =>
			assert.equal(preflightRecoveryExecutable(), false),
		);
		withPi(
			`printf '%b\\n' ${JSON.stringify(HELP.replace("  --approve, -a  x", "  --approve, -a  x\n  --approve, -a  duplicate"))}`,
			() => assert.equal(preflightRecoveryExecutable(), false),
		);
		withPi("exit 7", () => assert.equal(preflightRecoveryExecutable(), false));
	});
});

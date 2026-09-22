import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	loadRecoveryProfiles,
	materializeRecoveryProfile,
	preflightRecoveryExecutable,
	RECOVERY_INITIAL_PROMPT,
} from "../.pi/extensions/gitjig/recovery/profiles.ts";

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
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadProfiles, profileArgv, profileMaterializationDigest } from "../.pi/extensions/gitjig/recovery/profiles.ts";
import { PHASE_A_PROFILE_IDS } from "../.pi/extensions/gitjig/recovery/types.ts";

describe("#332 closed recovery profiles", () => {
	it("admits exactly the five sorted fixed profiles", () => {
		const loaded = loadProfiles();
		assert.ok(loaded);
		assert.deepEqual(
			loaded.set.profiles.map((profile) => profile.id),
			[...PHASE_A_PROFILE_IDS].sort(),
		);
		assert.match(loaded.digest, /^[0-9a-f]{64}$/);
	});
	it("materializes the mandatory isolated argv with an option terminator", () => {
		for (const id of PHASE_A_PROFILE_IDS) {
			const argv = profileArgv(id);
			assert.deepEqual(argv?.slice(0, 4), ["pi", "-p", "--thinking", "high"]);
			assert.equal(argv?.at(-2), "--");
			assert.match(argv?.at(-1) ?? "", /provisional \.\.\/return\.json early/);
			assert.match(profileMaterializationDigest(id) ?? "", /^[0-9a-f]{64}$/);
		}
	});
});

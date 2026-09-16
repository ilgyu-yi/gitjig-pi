import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withoutPlatformRetargetingEnv } from "../.pi/extensions/gitjig/dispatch/provision.ts";

const RETARGETING_KEYS = [
	"GH_REPO",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_COMMON_DIR",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
] as const;

describe("platform child repository environment", () => {
	it("removes every repository-retargeting key without mutating the caller", () => {
		const source: NodeJS.ProcessEnv = { SAFE: "kept" };
		for (const key of RETARGETING_KEYS) source[key] = `poison-${key}`;

		const admitted = withoutPlatformRetargetingEnv(source);

		assert.equal(admitted.SAFE, "kept");
		for (const key of RETARGETING_KEYS) {
			assert.equal(admitted[key], undefined, `${key} crossed into a platform child`);
			assert.equal(source[key], `poison-${key}`, `${key} was deleted from the caller environment`);
		}
	});

	for (const key of RETARGETING_KEYS) {
		it(`independently removes ${key}`, () => {
			const admitted = withoutPlatformRetargetingEnv({ SAFE: "kept", [key]: "poison" });
			assert.deepEqual(admitted, { SAFE: "kept" });
		});
	}
});

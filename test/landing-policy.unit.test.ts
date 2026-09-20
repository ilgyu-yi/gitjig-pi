import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";

describe("retired landing App policy", () => {
	it("has no handed-over carrier or runtime module", () => {
		assert.equal(existsSync(new URL("../.github/landing-policy.json", import.meta.url)), false);
		assert.equal(existsSync(new URL("../.github/workflows/landing-policy.mjs", import.meta.url)), false);
	});
});

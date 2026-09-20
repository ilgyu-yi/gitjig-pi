import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	eligibleApprovalCount,
	invalidatesLandingAdvisory,
	RECORD_MARKERS,
} from "../.github/workflows/gitjig-lifecycle.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
describe("settled lifecycle ownership", () => {
	it("zero native quorum is satisfied, never an escape", () => {
		assert.deepEqual(eligibleApprovalCount([], "author", A, 0), {
			ok: true,
			arm: "quorum-satisfied",
			count: 0,
			quorum: 0,
		});
		assert.equal(
			Object.keys(RECORD_MARKERS).some((key) => /escape|claim|landingTerminal/i.test(key)),
			false,
		);
	});
	it("synchronize invalidates only an observed head change", () => {
		assert.equal(
			invalidatesLandingAdvisory({ kind: "synchronize", before: A, after: B, eventRef: null, baseRef: "main" }),
			true,
		);
		assert.equal(
			invalidatesLandingAdvisory({ kind: "synchronize", before: A, after: A, eventRef: null, baseRef: "main" }),
			false,
		);
	});
	it("base push invalidates only an exact matching ref and changed live base", () => {
		assert.equal(
			invalidatesLandingAdvisory({
				kind: "base-push",
				before: A,
				after: B,
				eventRef: "refs/heads/main",
				baseRef: "main",
			}),
			true,
		);
		assert.equal(
			invalidatesLandingAdvisory({
				kind: "base-push",
				before: A,
				after: B,
				eventRef: "refs/heads/release",
				baseRef: "main",
			}),
			false,
		);
	});
});

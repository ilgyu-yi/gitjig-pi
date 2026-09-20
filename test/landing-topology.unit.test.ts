import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { examineBootstrap, executeBootstrapLanding } from "../.pi/extensions/gitjig/landing/bootstrap.ts";

describe("superseded topology bootstrap", () => {
	it("is retained only as non-callable Phase-6 input", async () => {
		const input = {} as never;
		assert.deepEqual(examineBootstrap(input), { ok: false, arm: "bootstrap-superseded-dormant" });
		assert.deepEqual(await executeBootstrapLanding(input, {}), {
			outcome: "refused",
			arm: "bootstrap-superseded-dormant",
		});
	});
});

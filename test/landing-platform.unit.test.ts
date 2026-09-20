import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activeRulesetApplies, newestCheckConclusions } from "../.pi/extensions/gitjig/landing/platform.ts";

describe("interim current-platform predicates", () => {
	it("matches only an active branch ruleset addressing the exact default branch", () => {
		const rule = {
			target: "branch",
			enforcement: "active",
			conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
		};
		assert.equal(activeRulesetApplies(rule, "main", "main"), true);
		assert.equal(activeRulesetApplies(rule, "topic", "main"), false);
		assert.equal(activeRulesetApplies({ ...rule, enforcement: "disabled" }, "main", "main"), false);
	});
	it("refuses ambiguous check populations and selects newest names", () => {
		assert.equal(
			newestCheckConclusions([
				{ id: 1, name: "suite", status: "completed", conclusion: "success" },
				{ id: 1, name: "suite", status: "completed", conclusion: "failure" },
			]),
			undefined,
		);
		assert.equal(
			newestCheckConclusions([
				{ id: 1, name: "suite", status: "completed", conclusion: "failure" },
				{ id: 2, name: "suite", status: "completed", conclusion: "success" },
			])?.get("suite")?.conclusion,
			"success",
		);
	});
});

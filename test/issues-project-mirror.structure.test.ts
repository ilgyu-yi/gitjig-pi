import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const workflow = readFileSync(join(repoRoot(), ".github/workflows/issues-to-project-mirror.yml"), "utf8");

describe("issues-to-project mirror authority boundary", () => {
	it("mirrors lifecycle labels without independently deciding lifecycle state", () => {
		assert.ok(
			workflow.includes("types: [opened, edited, labeled, unlabeled, closed, reopened, milestoned, demilestoned]"),
		);
		assert.ok(workflow.includes("Mirror only"));
		assert.ok(workflow.includes("must not infer,"));
		assert.ok(workflow.includes("apply, or clear lifecycle labels"));
		assert.ok(workflow.includes("awaiting-author"));
		assert.ok(workflow.includes('index("blocked")'));
		assert.ok(!workflow.includes("status:blocked"));
		assert.ok(!workflow.includes("issue_comment"));
	});
});

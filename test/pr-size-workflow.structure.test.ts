import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

/* #408: the pr-size reporting check's workflow runs trusted default-branch bytes and reads no PR code. */
const WORKFLOW = readFileSync(join(repoRoot(), ".github/workflows/pr-size.yml"), "utf8");

/** Every property the workflow owes, as one predicate, so a removal of any is a red. */
function owes(workflow: string): string[] {
	const missing: string[] = [];
	const need = (label: string, pattern: RegExp) => {
		if (!pattern.test(workflow)) missing.push(label);
	};
	need(
		"pull_request_target on main and maintenance lines",
		/pull_request_target:\n {4}branches:\n {6}- main\n {6}- '\*-maintenance'/,
	);
	need("re-evaluation on escape comments", /issue_comment:\n {4}types: \[created, edited, deleted\]/);
	need("trusted default-branch checkout", /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
	need("no checkout credentials", /persist-credentials: false/);
	need("runs the check", /run: node \.github\/workflows\/pr-size\.mjs/);
	need("source-only declaration on its first line", /^# gitjig: source-only\n/);
	need("re-runs on a retarget", /types: \[opened, synchronize, reopened, edited\]/);
	need("check-run write only", /checks: write/);
	need("queued, never cancelled", /cancel-in-progress: false/);
	if (/^\s+(?!checks:)[a-z-]+: write\b/m.test(workflow)) missing.push("no other write permission");
	if (/github\.event\.pull_request\.head\.(?:sha|ref)/.test(workflow)) missing.push("no pull-request code checked out");
	return missing;
}

describe("#408 pr-size workflow", () => {
	it("owes every property", () => {
		assert.deepEqual(owes(WORKFLOW), []);
	});

	it("reds when the check is removed or any property is weakened", () => {
		const mutants: ReadonlyArray<readonly [string, string]> = [
			["run: node .github/workflows/pr-size.mjs", "run: echo skipped"],
			["      - '*-maintenance'\n", ""],
			["  issue_comment:\n    types: [created, edited, deleted]\n", ""],
			["ref: ${{ github.event.repository.default_branch }}", "ref: ${{ github.event.pull_request.head.sha }}"],
			["persist-credentials: false", "persist-credentials: true"],
			["cancel-in-progress: false", "cancel-in-progress: true"],
			["  contents: read", "  contents: write"],
			["  issues: read", "  issues: read\n  statuses: write"],
			["# gitjig: source-only\n", ""],
			["reopened, edited]", "reopened]"],
		];
		for (const [from, to] of mutants) {
			const at = WORKFLOW.indexOf(from);
			assert.ok(at >= 0 && at === WORKFLOW.lastIndexOf(from), `anchor stale or ambiguous: ${from}`);
			assert.notDeepEqual(owes(WORKFLOW.replace(from, () => to)), [], `survived: ${from}`);
		}
	});
});

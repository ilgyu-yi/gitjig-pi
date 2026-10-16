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
	// Closed allowlists, so no spelling of a pull-request ref or a second
	// checkout reaches the job (R2): every expression, action and command in
	// the file must be one of these.
	const expressions = [...workflow.matchAll(/\$\{\{([^}]*)\}\}/g)].map((match) => (match[1] ?? "").trim());
	const allowed = new Set([
		"github.repository_id",
		"github.event.pull_request.number || github.event.issue.number",
		"github.event.pull_request || github.event.issue.pull_request",
		"github.event.repository.default_branch",
		"github.token",
	]);
	if (expressions.length === 0 || expressions.some((expression) => !allowed.has(expression)))
		missing.push("only allowlisted expressions");
	const uses = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((match) => match[1]);
	if (uses.length !== 1 || uses[0] !== "actions/checkout@v4") missing.push("exactly one checkout action");
	const runs = [...workflow.matchAll(/^\s*(?:-\s+)?run:\s*(.+)$/gm)].map((match) => match[1]);
	if (runs.length !== 1 || runs[0] !== "node .github/workflows/pr-size.mjs")
		missing.push("exactly one command, the check");
	const checkout = /uses: actions\/checkout@v4\n {8}with:\n((?: {10}[a-z-]+: .+\n)+)/.exec(workflow)?.[1] ?? "";
	const keys = [...checkout.matchAll(/^ {10}([a-z-]+):/gm)].map((match) => match[1]).sort();
	if (keys.join(",") !== "persist-credentials,ref") missing.push("checkout takes only ref and credentials");
	return missing;
}

describe("#408 pr-size workflow", () => {
	it("owes every property", () => {
		assert.deepEqual(owes(WORKFLOW), []);
	});

	it("reds when the check is removed or any property is weakened", () => {
		const mutants: ReadonlyArray<readonly [string, string]> = [
			["ref: ${{ github.event.repository.default_branch }}", "ref: ${{ github.event.pull_request.merge_commit_sha }}"],
			[
				"          persist-credentials: false\n",
				"          persist-credentials: false\n          repository: ${{ github.event.repository.full_name }}\n",
			],
			[
				"run: node .github/workflows/pr-size.mjs",
				"run: git fetch origin pull/${{ github.event.pull_request.number }}/head && node .github/workflows/pr-size.mjs",
			],
			[
				"      - name: Measure the pull request",
				"      - uses: actions/checkout@v4\n      - name: Measure the pull request",
			],
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

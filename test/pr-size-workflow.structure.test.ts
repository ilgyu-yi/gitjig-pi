import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { repoRoot } from "./harness/run-pi.ts";

/*
 * #408: the pr-size workflow, parsed and compared whole. Earlier text pins
 * (R1–R3) each missed a spelling — an unanchored ref, a quoted scope, an
 * expression in another place — so the arm now compares the parsed document
 * with the one shape it may have: any change to a trigger, permission,
 * expression, step, ref or command reds it. The source-only declaration is a
 * comment, which parsing drops, so its first line is read as text.
 */
const TEXT = readFileSync(join(repoRoot(), ".github/workflows/pr-size.yml"), "utf8");

const EXPECTED = {
	name: "pr-size",
	on: {
		pull_request_target: {
			branches: ["main", "*-maintenance"],
			types: ["opened", "synchronize", "reopened", "edited"],
		},
		issue_comment: { types: ["created", "edited", "deleted"] },
	},
	permissions: { contents: "read", "pull-requests": "read", issues: "read", checks: "write" },
	concurrency: {
		group: "pr-size-${{ github.repository_id }}-${{ github.event.pull_request.number || github.event.issue.number }}",
		"cancel-in-progress": false,
	},
	jobs: {
		measure: {
			name: "pr-size-evaluator",
			if: "${{ github.event.pull_request || github.event.issue.pull_request }}",
			"runs-on": "ubuntu-latest",
			"timeout-minutes": 5,
			steps: [
				{
					name: "Check out trusted default-branch check",
					uses: "actions/checkout@v4",
					with: { ref: "${{ github.event.repository.default_branch }}", "persist-credentials": false },
				},
				{
					name: "Measure the pull request against SPEC §1.11's bound",
					env: { GITHUB_TOKEN: "${{ github.token }}" },
					run: "node .github/workflows/pr-size.mjs",
				},
			],
		},
	},
};

/** Whether a workflow text is exactly the owed shape, declaration included. */
function owed(text: string): boolean {
	if (!text.startsWith("# gitjig: source-only\n")) return false;
	let document: unknown;
	try {
		document = parse(text);
	} catch {
		return false;
	}
	try {
		assert.deepStrictEqual(document, EXPECTED);
		return true;
	} catch {
		return false;
	}
}

describe("#408 pr-size workflow", () => {
	it("is exactly the owed shape: trusted default-branch bytes, checks: write only, no pull-request code", () => {
		assert.equal(owed(TEXT), true);
	});

	it("reds on every weakening, in any spelling", () => {
		const mutants: ReadonlyArray<readonly [string, string]> = [
			["run: node .github/workflows/pr-size.mjs", "run: echo skipped"],
			["      - '*-maintenance'\n", ""],
			["  issue_comment:\n    types: [created, edited, deleted]\n", ""],
			["reopened, edited]", "reopened]"],
			["ref: ${{ github.event.repository.default_branch }}", "ref: ${{ github.event.pull_request.head.sha }}"],
			["ref: ${{ github.event.repository.default_branch }}", "ref: ${{ github.event.pull_request.merge_commit_sha }}"],
			[
				"ref: ${{ github.event.repository.default_branch }}",
				"ref: ${{ github.event.pull_request.head.sha }} # ${{ github.event.repository.default_branch }}",
			],
			["persist-credentials: false", "persist-credentials: true"],
			[
				"          persist-credentials: false\n",
				"          persist-credentials: false\n          repository: ${{ github.event.repository.full_name }}\n",
			],
			["cancel-in-progress: false", "cancel-in-progress: true"],
			["  contents: read", "  contents: write"],
			["  pull-requests: read", '  pull-requests: "write"'],
			["  issues: read", "  issues: read\n  statuses: write"],
			["# gitjig: source-only\n", ""],
			[
				"run: node .github/workflows/pr-size.mjs",
				"run: git fetch origin pull/${{ github.event.pull_request.number }}/head && node .github/workflows/pr-size.mjs",
			],
			[
				"      - name: Measure the pull request",
				"      - uses: actions/checkout@v4\n      - name: Measure the pull request",
			],
		];
		for (const [from, to] of mutants) {
			const at = TEXT.indexOf(from);
			assert.ok(at >= 0 && at === TEXT.lastIndexOf(from), `anchor stale or ambiguous: ${from}`);
			assert.equal(owed(TEXT.replace(from, () => to)), false, `survived: ${to}`);
		}
	});
});

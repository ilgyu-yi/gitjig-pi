import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const workflow = readFileSync(join(repoRoot(), ".github/workflows/lifecycle-transitions.yml"), "utf8");
const adapter = readFileSync(join(repoRoot(), ".github/workflows/lifecycle-event.mjs"), "utf8");

describe("#276 identity-aware lifecycle workflow", () => {
	it("listens only to the settled producer and clearer events", () => {
		assert.match(workflow, /pull_request_review:\n\s+types: \[submitted\]/);
		assert.match(workflow, /pull_request:\n\s+types: \[synchronize\]/);
		assert.match(workflow, /issues:\n\s+types: \[edited\]/);
		for (const retired of ["issue_comment", "dismissed", "approved", "reopened", "labeled"])
			assert.doesNotMatch(workflow, new RegExp(retired));
	});

	it("executes trusted base bytes through literal handed-over edges", () => {
		assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
		assert.match(workflow, /! -f \.github\/workflows\/lifecycle-event\.mjs/);
		assert.match(workflow, /node \.github\/workflows\/lifecycle-event\.mjs/);
		assert.match(adapter, /from "\.\/gitjig-lifecycle\.mjs"/);
		assert.match(workflow, /group: lifecycle-/);
	});

	it("re-reads addressed subjects, reviews, comments, permissions, and labels", () => {
		for (const path of ["/pulls/${number}", "/pulls/${number}/reviews", "/issues/${number}/comments"])
			assert.ok(adapter.includes(path));
		assert.ok(adapter.includes("/collaborators/${encodeURIComponent(login)}/permission"));
		assert.ok(adapter.includes("/issues/${number}/labels?per_page=100"));
		assert.match(adapter, /event\.changes\?\.body === undefined/);
	});
});

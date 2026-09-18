import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const workflow = readFileSync(join(repoRoot(), ".github/workflows/lifecycle-transitions.yml"), "utf8");
const adapter = readFileSync(join(repoRoot(), ".github/workflows/gitjig-lifecycle-event.mjs"), "utf8");

describe("#276 identity-aware lifecycle workflow", () => {
	it("listens only to the settled producer and clearer events", () => {
		assert.match(workflow, /pull_request_review:\s*\n\s*types: \[submitted\]/);
		assert.match(workflow, /pull_request:\s*\n\s*types: \[synchronize\]/);
		assert.match(workflow, /issues:\s*\n\s*types: \[edited\]/);
		for (const retired of ["issue_comment", "dismissed", "approved", "reopened", "labeled"])
			assert.doesNotMatch(workflow, new RegExp(retired));
	});

	it("uses the handed-over engine and re-reads addressed platform subjects", () => {
		assert.ok(adapter.includes('`./${"git" + "jig"}-lifecycle.mjs`'));
		assert.ok(adapter.includes("admitCurrentAwaitingAuthor"));
		assert.match(adapter, /api\(`\/pulls\/\$\{number\}`\)/);
		assert.match(adapter, /api\(`\/issues\/\$\{number\}`\)/);
		assert.match(adapter, /repository or fork mismatch/);
		assert.match(adapter, /event\.sender\?\.node_id !== issue\.user\?\.node_id/);
	});

	it("writes record comments before lifecycle label mutations", () => {
		assert.match(adapter, /await post\([\s\S]+await addLabel\(number\)/);
		assert.match(adapter, /await post\([\s\S]+await removeLabel\(number\)/);
	});
});

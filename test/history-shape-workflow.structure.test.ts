import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const workflow = readFileSync(join(repoRoot(), ".github/workflows/history-shape.yml"), "utf8");
const predicate = readFileSync(join(repoRoot(), ".github/workflows/history-shape.mjs"), "utf8");

describe("history-shape trusted workflow", () => {
	it("runs as a read-only pull_request_target check", () => {
		assert.match(workflow, /pull_request_target:/);
		assert.match(workflow, /contents: read/);
		assert.match(workflow, /pull-requests: read/);
		assert.doesNotMatch(workflow, /(?:contents|pull-requests|checks): write/);
		assert.match(workflow, /^ {2}history-shape:/m);
	});

	it("executes complete trusted base bytes and disables checkout credentials", () => {
		assert.match(workflow, /fetch-depth: 0/);
		assert.equal(workflow.match(/persist-credentials: false/g)?.length, 2);
		assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
		assert.match(workflow, /cp trusted\/\.github\/workflows\/history-shape\.mjs "\$RUNNER_TEMP\/history-shape\.mjs"/);
		assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
		assert.match(workflow, /node "\$RUNNER_TEMP\/history-shape\.mjs"/);
	});

	it("uses the exact merge-base and topic-range commands once", () => {
		assert.equal(predicate.match(/\["merge-base", baseSha, headSha\]/g)?.length, 1);
		assert.equal(predicate.match(/\["rev-list", "--min-parents=2", `\$\{mergeBase\}\.\.\$\{headSha\}`\]/g)?.length, 1);
		assert.match(predicate, /--is-shallow-repository/);
		assert.equal(predicate.match(/api\(`pulls\/\$\{number\}`/g)?.length, 2);
		assert.match(predicate, /trusted base revision is unavailable/);
		assert.match(predicate, /checked-out head differs/);
		assert.match(predicate, /operands drifted/);
	});
});

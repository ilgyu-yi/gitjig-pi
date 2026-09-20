import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const adapter = readFileSync(new URL("../.github/workflows/landing-label-hygiene.mjs", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/landing-label-hygiene.yml", import.meta.url), "utf8");

describe("landing advisory hygiene boundaries", () => {
	it("owns exactly synchronize and base push delivery with bounded serial concurrency", () => {
		assert.match(workflow, /pull_request_target:\n\s+types: \[synchronize\]/);
		assert.match(workflow, /push:\n\s+branches: \['\*\*'\]/);
		assert.match(workflow, /cancel-in-progress: false/);
		assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
	});
	it("paginates open exact-base PRs and rereads each before deletion", () => {
		assert.match(adapter, /while \(page <= 100\)/);
		assert.match(adapter, /state=open&base=/);
		assert.match(adapter, /pulls\/\$\{summary\.number\}/);
		assert.match(adapter, /current\.base\?\.sha === event\.after/);
		assert.match(adapter, /invalidatesLandingAdvisory/);
	});
	it("removes only the advisory and verifies absence after the write", () => {
		assert.match(adapter, /encodeURIComponent\(LABEL\)/);
		assert.match(adapter, /current\.labels\.some\(\(label\) => label\.name === LABEL\)/);
		assert.doesNotMatch(adapter, /rulesets|\/merge/);
	});
});

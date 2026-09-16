import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const spec = readFileSync(new URL("../SPEC.md", import.meta.url), "utf8");

function section(start: string, end: string): string {
	const from = spec.indexOf(start);
	const to = spec.indexOf(end, from + start.length);
	assert.notEqual(from, -1, `missing section ${start}`);
	assert.notEqual(to, -1, `missing section ${end}`);
	return spec.slice(from, to);
}

const tierTwo = section("**Tier 2 — the local git-hook tier.**", "**Tier 3 — CI gates and the server-side ruleset.**");
const install = section("## 4. Substrate and install contract", "## 5. Cross-cutting contracts");
const selfContained = section("### 5.1 Self-contained artifacts", "### 5.2 Graceful degradation");
const milestone = section("## 6. Self-governance milestone", "### 6.1 Substrate posture");

test("#249 settles one final-form adopter spine before runtime derives", () => {
	for (const term of [
		"source-only",
		"instance-state",
		"handed-over",
		"carried",
		".pi/gitjig.pin.json",
		"sha256-v1",
		"installed-pin.json",
		"retire",
	]) {
		assert.match(install, new RegExp(term.replaceAll(".", "\\.")), `install contract omits ${term}`);
	}
});

test("#249 scopes committed bytes to handed-over assets and pin-verifies carried assets", () => {
	assert.match(tierTwo, /handed-over/);
	assert.match(tierTwo, /carried/);
	assert.match(install, /old and new manifests/);
	assert.match(install, /whole phase refuses before mutation/);
});

test("#249 makes excision and the milestone read through the product boundary", () => {
	assert.match(selfContained, /handed-over/);
	assert.match(selfContained, /carried/);
	assert.match(milestone, /handed-over/);
	assert.match(milestone, /carried/);
});

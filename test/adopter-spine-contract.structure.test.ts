import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const spec = readFileSync(new URL("../SPEC.md", import.meta.url), "utf8");

function section(doc: string, start: string, end: string): string {
	const from = doc.indexOf(start);
	const to = doc.indexOf(end, from + start.length);
	assert.notEqual(from, -1, `missing section ${start}`);
	assert.notEqual(to, -1, `missing section ${end}`);
	return doc.slice(from, to);
}

function assertSpine(doc: string): void {
	const tierTwo = section(
		doc,
		"**Tier 2 — the local git-hook tier.**",
		"**Tier 3 — CI gates and the server-side ruleset.**",
	);
	const install = section(doc, "## 4. Substrate and install contract", "## 5. Cross-cutting contracts");
	const selfContained = section(doc, "### 5.1 Self-contained artifacts", "### 5.2 Graceful degradation");
	const milestone = section(doc, "## 6. Self-governance milestone", "### 6.1 Substrate posture");

	assert.match(install, /`# gitjig: source-only` or `\/\/ gitjig: source-only`/);
	assert.match(install, /valid marker → \*\*source-only\*\*;/);
	assert.match(install, /\.pi\/extensions\/gitjig\.ts[^\n]+→ \*\*carried\*\*/);
	assert.match(install, /`\.github\/\*\*` and `\.githooks\/\*\*` → \*\*handed-over\*\*/);
	assert.match(install, /another `\.pi\/\*\*` → refuse until settled/);
	assert.match(install, /40-lowercase-hex immutable `revision`/);
	assert.match(install, /`class` is exactly `handed-over` or `carried`/);
	assert.match(install, /Every member and aggregate digest is exactly 64 lowercase hexadecimal characters/);
	assert.match(install, /all admitted handed-over actions plus exactly one pin and no carried member/);
	assert.match(install, /old and new manifests/);
	assert.match(install, /whole phase refuses before mutation/);
	assert.match(install, /prior-only paths admit exact-old or absent/);
	assert.match(install, /advances atomically only after every carried action/);
	assert.match(tierTwo, /handed-over[\s\S]+carried/);
	assert.match(selfContained, /handed-over[\s\S]+carried/);
	assert.match(milestone, /handed-over[\s\S]+carried/);
}

function hasSourceOnlyMarker(raw: string): boolean {
	const lines = raw.split(/\n/).map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	const index = lines[0]?.startsWith("#!") ? 1 : 0;
	return lines[index] === "# gitjig: source-only" || lines[index] === "// gitjig: source-only";
}

test("#249 pins the canonical adopter spine relationships", () => assertSpine(spec));

test("#249's contract lock reds the four independently measured weakenings", () => {
	for (const [name, mutant] of [
		[
			"unknown pi member handed over",
			spec.replace("another `.pi/**` → refuse until settled", "another `.pi/**` → handed-over"),
		],
		[
			"marker grammar widened",
			spec.replace("`# gitjig: source-only` or `// gitjig: source-only`", "a line containing source-only"),
		],
		["revision made mutable", spec.replace("40-lowercase-hex immutable `revision`", "mutable `revision`")],
		[
			"carried members enter PR",
			spec.replace(
				"all admitted handed-over actions plus exactly one pin and no carried member",
				"all handed-over and carried members",
			),
		],
	] as const) {
		assert.throws(() => assertSpine(mutant), name);
	}
});

test("#249's source-only declaration parser distinguishes legal positions", () => {
	assert.equal(hasSourceOnlyMarker("# gitjig: source-only\nname: x\n"), true);
	assert.equal(hasSourceOnlyMarker("#!/bin/sh\n# gitjig: source-only\n"), true);
	assert.equal(hasSourceOnlyMarker("// gitjig: source-only\nconst x = 1;\n"), true);
	assert.equal(hasSourceOnlyMarker("name: x\n# gitjig: source-only\n"), false);
	assert.equal(hasSourceOnlyMarker("# GITJIG: source-only\n"), false);
});

test("#249 marks every currently declared development-only substrate file at its legal head", () => {
	for (const path of [
		"../.github/workflows/source-checks.yml",
		"../.github/workflows/suite.yml",
		"../.github/workflows/check-merge-review.yml",
		"../.github/workflows/check-merge-review.mjs",
	]) {
		assert.equal(hasSourceOnlyMarker(readFileSync(new URL(path, import.meta.url), "utf8")), true, path);
	}
});

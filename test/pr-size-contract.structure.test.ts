import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

/* #408: SPEC §1.11's size bound is the pinned CodelyTV/pr-size-labeler, and the two agree. */
const SPEC = readFileSync(new URL("../SPEC.md", import.meta.url), "utf8");
const TEXT = readFileSync(new URL("../.github/workflows/pr-size.yml", import.meta.url), "utf8");
const ACTION = "CodelyTV/pr-size-labeler@19c335e7695ba922de938806dd129f0a9b992644";

function section(number: string): string {
	const lines = SPEC.split("\n");
	const start = lines.findIndex((line) => line.startsWith(`### ${number} `));
	const end = lines.findIndex((line, index) => index > start && (line.startsWith("### ") || line.startsWith("## ")));
	return start < 0 ? "" : lines.slice(start, end < 0 ? undefined : end).join("\n");
}

describe("#408 pull-request size bound", () => {
	it("runs the pinned action on pull requests to main, failing above 2,400 lines", () => {
		assert.ok(TEXT.startsWith("# gitjig: source-only\n"));
		const workflow = parse(TEXT);
		assert.deepEqual(workflow.on, {
			pull_request: { branches: ["main"], types: ["opened", "synchronize", "reopened"] },
		});
		assert.deepEqual(workflow.permissions, { contents: "read", "pull-requests": "write" });
		const steps = workflow.jobs["pr-size"].steps;
		assert.equal(steps.length, 1);
		assert.equal(steps[0].uses, ACTION);
		assert.equal(steps[0].with.l_max_size, "2401");
		assert.equal(steps[0].with.fail_if_xl, "true");
		assert.equal(steps[0].with.files_to_ignore, "test/fixtures/adopter-membership.snapshot.json");
	});

	it("states that check in SPEC §1.11, with no custom region or escape", () => {
		const text = section("1.11");
		for (const literal of [
			"This section binds this repository only: `SPEC.md` is not delivered to an adopter.",
			"runs `CodelyTV/pr-size-labeler`, pinned by full commit SHA",
			"fails above **2,400 changed lines**",
			"ignoring `test/fixtures/adopter-membership.snapshot.json`",
			"It is a **reporting** check: it is not a required context",
			"Otherwise its pull request body states why it cannot split, and review decides (§2.3).",
		])
			assert.ok(text.includes(literal), literal);
		assert.doesNotMatch(text, /TOC START|escape/i);
		assert.match(SPEC, /^\| pr-size \| .*CodelyTV\/pr-size-labeler/m);
	});
});

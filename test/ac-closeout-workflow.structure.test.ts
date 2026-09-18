import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseDocument } from "yaml";

type Workflow = {
	on?: Record<string, { types: string[] }>;
	true?: Record<string, { types: string[] }>;
	permissions: Record<string, string>;
	jobs: { evaluate: { "timeout-minutes": number; steps: { with?: Record<string, unknown>; run?: string }[] } };
};

const root = join(import.meta.dirname, "..");
const source = readFileSync(join(root, ".github/workflows/ac-closeout.yml"), "utf8");
const workflow = parseDocument(source).toJS() as Workflow;
const triggers = workflow.on ?? workflow.true ?? {};

describe("trusted ac-closeout workflow", () => {
	it("uses only default-byte event triggers and complete mutation events", () => {
		assert.deepEqual(Object.keys(triggers).sort(), ["issue_comment", "issues", "pull_request_target"]);
		assert.deepEqual(triggers.issues.types, ["edited"]);
		assert.deepEqual(triggers.issue_comment.types, ["created", "edited", "deleted"]);
		assert.ok(triggers.pull_request_target.types.includes("synchronize"));
	});

	it("grants only the one required write and invokes the literal default-branch adapter", () => {
		assert.deepEqual(workflow.permissions, {
			contents: "read",
			"pull-requests": "read",
			issues: "read",
			checks: "write",
		});
		assert.equal(workflow.jobs.evaluate["timeout-minutes"], 10);
		const steps = workflow.jobs.evaluate.steps;
		assert.equal(steps[0].with?.ref, "${{ github.event.repository.default_branch }}");
		assert.equal(steps[0].with?.["persist-credentials"], false);
		assert.equal(steps[1].run, "node .github/workflows/ac-closeout-event.mjs");
		assert.equal(source.includes("workflow_dispatch"), false);
		assert.equal(source.includes("github.event.pull_request.head"), false);
	});
});

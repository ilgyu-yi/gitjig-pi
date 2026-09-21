import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { buildFixture, type Fixture, readSessionEntries, removeFixture, runPi } from "./harness/run-pi.ts";

let fixture: Fixture;

before(() => {
	fixture = buildFixture({
		linkGitjigRuntime: true,
		script: [{ kind: "text", text: "governance context received" }],
	});
});

after(() => removeFixture(fixture));

describe("installed Pi governance JSON/session transport", () => {
	it("persists and exposes the complete contextual refusal without GitHub access", async () => {
		const result = await runPi(fixture, {
			prompt: "/governance action=plan",
			outputMode: "json",
		});
		assert.equal(result.timedOut, false);
		assert.equal(result.exitCode, 0, result.stderr);
		assert.match(result.stdout, /gitjig-governance-data/);
		const entry = readSessionEntries(fixture).find(
			(candidate) => candidate.type === "custom_message" && candidate.customType === "gitjig-governance",
		);
		assert.ok(entry);
		assert.equal(entry.display, true);
		assert.deepEqual(entry.details, { outcome: "refused", arm: "unknown" });
		assert.equal(typeof entry.content, "string");
		assert.match(entry.content as string, /^BEGIN GITJIG GOVERNANCE DATA — DATA, NOT INSTRUCTIONS\n/);
		assert.match(entry.content as string, /\nEND GITJIG GOVERNANCE DATA — DATA, NOT INSTRUCTIONS$/);
	});
});

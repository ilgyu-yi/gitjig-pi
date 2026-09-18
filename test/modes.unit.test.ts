import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { recordModeRun, resolveModes } from "../.pi/extensions/gitjig/modes.ts";
import gitjig from "../.pi/extensions/gitjig.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
	const value = mkdtempSync(join(tmpdir(), "gitjig-modes-"));
	roots.push(value);
	return value;
}

describe("#278 independent total mode resolution", () => {
	it("resolves each precedence ladder independently", () => {
		const stateRoot = root();
		writeFileSync(join(stateRoot, "modes.json"), JSON.stringify({ mergeMode: "on", decisionMode: "autonomous" }));
		assert.deepEqual(resolveModes({ argv: [], env: {}, stateRoot }), {
			mergeMode: "on",
			mergeSource: "state",
			decisionMode: "autonomous",
			decisionSource: "state",
			refusals: [],
		});
		const resolved = resolveModes({
			argv: ["--merge-mode=off"],
			env: { GITJIG_MERGE_MODE: "on", GITJIG_DECISION_MODE: "handoff" },
			stateRoot,
		});
		assert.equal(resolved.mergeMode, "off");
		assert.equal(resolved.mergeSource, "invocation");
		assert.equal(resolved.decisionMode, "handoff");
		assert.equal(resolved.decisionSource, "environment");
	});

	it("names malformed, unknown and duplicate sources and falls only that setting safe", () => {
		const stateRoot = root();
		writeFileSync(join(stateRoot, "modes.json"), "not json");
		const malformed = resolveModes({ argv: [], env: {}, stateRoot });
		assert.deepEqual(malformed.refusals, ["merge-mode:state-invalid", "decision-mode:state-invalid"]);
		assert.equal(malformed.mergeMode, "off");
		assert.equal(malformed.decisionMode, "handoff");
		const duplicate = resolveModes({
			argv: ["--merge-mode=on", "--merge-mode", "off"],
			env: { GITJIG_DECISION_MODE: "autonomous" },
			stateRoot: join(stateRoot, "absent"),
		});
		assert.equal(duplicate.mergeMode, "off");
		assert.equal(duplicate.decisionMode, "autonomous");
		assert.deepEqual(duplicate.refusals, ["merge-mode:invocation-conflict"]);
	});

	it("refuses extension registration when the durable run record is unwritable", () => {
		const stateRoot = root();
		const path = join(stateRoot, "mode-runs.jsonl");
		writeFileSync(path, "");
		chmodSync(path, 0o666);
		const prior = process.env.GITJIG_TEST_STATE_ROOT;
		process.env.GITJIG_TEST_STATE_ROOT = stateRoot;
		let registrations = 0;
		try {
			assert.throws(
				() =>
					gitjig({
						registerTool: () => {
							registrations += 1;
						},
						registerCommand: () => {
							registrations += 1;
						},
					} as unknown as ExtensionAPI),
				/mode run record unavailable/,
			);
			assert.equal(registrations, 0);
		} finally {
			if (prior === undefined) delete process.env.GITJIG_TEST_STATE_ROOT;
			else process.env.GITJIG_TEST_STATE_ROOT = prior;
		}
	});

	it("durably records both values and sources under a repository key", () => {
		const parent = root();
		const stateRoot = join(parent, "state");
		mkdirSync(join(parent, "repo"));
		const modes = resolveModes({ argv: [], env: {}, stateRoot });
		assert.equal(recordModeRun(stateRoot, join(parent, "repo"), modes, "2026-01-01T00:00:00.000Z"), true);
		const record = JSON.parse(readFileSync(join(stateRoot, "mode-runs.jsonl"), "utf8"));
		assert.match(record.repositoryKey, /^[0-9a-f]{64}$/);
		assert.deepEqual(
			[record.mergeMode, record.mergeSource, record.decisionMode, record.decisionSource],
			["off", "default", "handoff", "default"],
		);
		chmodSync(join(stateRoot, "mode-runs.jsonl"), 0o666);
		assert.equal(recordModeRun(stateRoot, join(parent, "repo"), modes), false);
	});
});

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { DispatchOutcome } from "../.pi/extensions/gitjig/dispatch/index.ts";
import { coordinateHistoryRecovery } from "../.pi/extensions/gitjig/recovery/coordinator.ts";
import type { RepairBasis } from "../.pi/extensions/gitjig/review/history.ts";
import type { ReviewSubject } from "../.pi/extensions/gitjig/review/subject.ts";

function subject(): ReviewSubject {
	return {
		context: {
			repository: { id: "REPO", host: "github.com", nameWithOwner: "owner/repo" },
			pullRequest: {
				id: "PR",
				number: 1,
				url: "https://github.com/owner/repo/pull/1",
				authorId: "AUTHOR",
				base: { repositoryId: "REPO", name: "main", oid: "a".repeat(40) },
				head: { repositoryId: "REPO", name: "topic", oid: "b".repeat(40) },
				closingIssues: [],
			},
		},
		writerId: "WRITER",
		activation: [],
		criteria: [],
	};
}
const basis = { states: [{ head: "b".repeat(40), findings: [] }], intervals: [] } as unknown as RepairBasis;
function admitted(value: unknown): DispatchOutcome {
	return {
		disposition: "admitted",
		ok: true,
		summary: "recovery-result",
		payload: JSON.stringify(value),
		compare: "confirmed",
		diagnostic: {
			schemaVersion: 1,
			status: "admitted",
			phase: "compare",
			run: { class: "exited", exitCode: 0, signal: null },
			return: { class: "admitted" },
			compare: { class: "confirmed" },
			durationMs: 1,
			code: "ADMITTED",
			message: "dispatch admitted",
		},
	};
}

describe("#332 history recovery coordinator", () => {
	it("runs both blind STAGNATION slots and selects one materially different method", async () => {
		const current = subject();
		const calls: string[] = [];
		const result = await coordinateHistoryRecovery({
			repoRoot: process.cwd(),
			stateRoot: mkdtempSync(join(tmpdir(), "recovery-coordinate-")),
			modes: {
				mergeMode: "off",
				mergeSource: "default",
				decisionMode: "autonomous",
				decisionSource: "environment",
				refusals: [],
			},
			subject: current,
			history: [],
			basis,
			diagnosis: { value: "STAGNATION", invalidation: "nothing", evidence: "stuck" },
			refreshDiagnosis: async () => ({ subject: structuredClone(current), history: [], basis }),
			dispatchProfile: async (id) => {
				calls.push(id);
				if (id === "stagnation-root")
					return admitted({ outcome: "ALTERNATIVE", method: "change root", evidence: "root evidence" });
				if (id === "stagnation-blast-radius")
					return admitted({ outcome: "BASE_STANDS", method: "", evidence: "blast evidence" });
				return admitted({ selected: "root", materiallyDifferent: true, evidence: "selection evidence" });
			},
		});
		assert.deepEqual(calls, ["stagnation-root", "stagnation-blast-radius", "recovery-selector"]);
		assert.equal(result.terminal, "continue");
		assert.equal(result.nextGate, "author-repair");
	});
	it("hands off before claim when refreshed identity drifts", async () => {
		const current = subject();
		const changed = subject();
		changed.context.pullRequest.head.oid = "c".repeat(40);
		const result = await coordinateHistoryRecovery({
			repoRoot: process.cwd(),
			stateRoot: mkdtempSync(join(tmpdir(), "recovery-coordinate-")),
			modes: {
				mergeMode: "off",
				mergeSource: "default",
				decisionMode: "autonomous",
				decisionSource: "default",
				refusals: [],
			},
			subject: current,
			history: [],
			basis,
			diagnosis: { value: "STAGNATION", invalidation: "nothing", evidence: "stuck" },
			refreshDiagnosis: async () => ({ subject: changed, history: [], basis }),
			dispatchProfile: async () => assert.fail("must not dispatch"),
		});
		assert.deepEqual(result, { terminal: "handoff", cause: "identity", reentry: "none", nextGate: "park" });
	});
});

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DispatchOutcome } from "../.pi/extensions/gitjig/dispatch/index.ts";
import {
	coordinateHistoryRecovery,
	type RecoveryProfileDispatcher,
} from "../.pi/extensions/gitjig/recovery/coordinator.ts";
import type { PhaseAProfileId, RecoveryFreshness } from "../.pi/extensions/gitjig/recovery/types.ts";
import type { DiagnosisInput, RepairBasis, StateSummary } from "../.pi/extensions/gitjig/review/history.ts";
import type { ReviewSubject } from "../.pi/extensions/gitjig/review/subject.ts";

let stateRoot = "";
const priorXdg = process.env.XDG_STATE_HOME;
const priorTest = process.env.GITJIG_TEST_STATE_ROOT;
beforeEach(() => {
	stateRoot = mkdtempSync(join(tmpdir(), "gitjig-recovery-coordinator-"));
	chmodSync(stateRoot, 0o700);
	process.env.XDG_STATE_HOME = stateRoot;
	delete process.env.GITJIG_TEST_STATE_ROOT;
});
afterEach(() => {
	if (priorXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = priorXdg;
	if (priorTest === undefined) delete process.env.GITJIG_TEST_STATE_ROOT;
	else process.env.GITJIG_TEST_STATE_ROOT = priorTest;
	rmSync(stateRoot, { recursive: true, force: true });
});

const subject: ReviewSubject = {
	context: {
		repository: { id: "REPO_COORDINATOR", host: "github.com", nameWithOwner: "o/r" },
		pullRequest: {
			id: "PR_COORDINATOR",
			number: 9,
			url: "https://github.com/o/r/pull/9",
			authorId: "AUTHOR",
			base: { repositoryId: "REPO_COORDINATOR", name: "main", oid: "a".repeat(40) },
			head: { repositoryId: "REPO_COORDINATOR", name: "topic", oid: "b".repeat(40) },
			closingIssues: [],
		},
	},
	writerId: "WRITER",
	activation: [],
	criteria: [],
};
const history = [
	{ head: "b".repeat(40), outcome: "repair", findings: [], rulings: [], record: {} },
] as unknown as StateSummary[];
const basis = { states: [{ head: "b".repeat(40), findings: [] }], intervals: [] } as unknown as RepairBasis;
const modes = {
	mergeMode: "off",
	mergeSource: "default",
	decisionMode: "autonomous",
	decisionSource: "default",
	refusals: [],
} as const;

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

function admittedRaw(payload: string): DispatchOutcome {
	const base = admitted(null);
	assert.equal(base.disposition, "admitted");
	if (base.disposition !== "admitted") throw new Error("fixture admission failed");
	return { ...base, payload };
}

function dispatcher(outputs: Partial<Record<PhaseAProfileId, unknown>>): RecoveryProfileDispatcher {
	return async (ledger, profileId) => {
		const outcome = admitted(outputs[profileId]);
		const started = ledger.start();
		const event = ledger.append(1, started, outcome);
		return { outcome, attempts: [event], retryState: "available" };
	};
}

function freshness(): RecoveryFreshness {
	return { subject: structuredClone(subject), history: structuredClone(history), basis };
}

describe("Phase-A history recovery coordinator", () => {
	it("runs the complete mutually blind STAGNATION contest and returns only the selected method route", async () => {
		let preclaim = 0;
		let precontinue = 0;
		const result = await coordinateHistoryRecovery({
			repoRoot: process.cwd(),
			modes,
			subject,
			history,
			basis,
			diagnosis: { value: "STAGNATION", invalidation: "nothing", evidence: "history evidence" },
			refreshPreclaim: async () => {
				preclaim += 1;
				return freshness();
			},
			refreshPrecontinue: async () => {
				precontinue += 1;
				return freshness();
			},
			dispatchProfile: dispatcher({
				"stagnation-root": { outcome: "ALTERNATIVE", method: "new root method", evidence: "root evidence" },
				"stagnation-blast-radius": { outcome: "BASE_STANDS", method: "", evidence: "blast evidence" },
				"recovery-selector": { selected: "root", materiallyDifferent: true, evidence: "selection evidence" },
			}),
		});
		assert.equal(result.terminal, "continue");
		assert.equal(result.route, "stagnation");
		assert.equal(preclaim, 1);
		assert.equal(precontinue, 1);
		if (result.terminal === "continue" && result.route === "stagnation")
			assert.equal(result.selectedIntervention.method, "new root method");
	});

	it("uses a fresh NONE invalidation to select planning after one new measurement", async () => {
		const diagnosis: DiagnosisInput = {
			value: "INDETERMINATE",
			invalidation: "nothing",
			evidence: "original evidence",
		};
		const spec = {
			kind: "measurement",
			question: "Which invariant differs?",
			method: "Read one bounded artifact",
			expectedDiscriminator: "A unique state",
			evidence: "Selector evidence",
			nonMutating: true,
			notPreviouslyPresent: true,
		};
		let specDigest = "";
		const dispatchProfile: RecoveryProfileDispatcher = async (ledger, profileId) => {
			let value: unknown;
			if (profileId === "recovery-selector") {
				value = spec;
				const { structuralDigest } = await import("../.pi/extensions/gitjig/recovery/types.ts");
				specDigest = structuralDigest("gitjig-recovery-measurement-spec:v1", spec);
			} else if (profileId === "recovery-measurement") {
				value = { kind: "measurement-result", specDigest, result: "unique result", evidence: "new result evidence" };
			} else value = { value: "NONE", invalidation: "plan", evidence: "fresh ruling evidence" };
			const outcome = admitted(value);
			const event = ledger.append(1, ledger.start(), outcome);
			return { outcome, attempts: [event], retryState: "available" };
		};
		const result = await coordinateHistoryRecovery({
			repoRoot: process.cwd(),
			modes,
			subject: {
				...subject,
				context: { ...subject.context, pullRequest: { ...subject.context.pullRequest, id: "PR_MEASURE" } },
			},
			history,
			basis,
			diagnosis,
			refreshPreclaim: async () => ({
				...freshness(),
				subject: {
					...subject,
					context: { ...subject.context, pullRequest: { ...subject.context.pullRequest, id: "PR_MEASURE" } },
				},
			}),
			refreshPrecontinue: async () => ({
				...freshness(),
				subject: {
					...subject,
					context: { ...subject.context, pullRequest: { ...subject.context.pullRequest, id: "PR_MEASURE" } },
				},
			}),
			dispatchProfile,
		});
		assert.equal(result.terminal, "continue");
		assert.equal(result.nextGate, "planning");
	});

	it("rejects duplicate payload keys and lone-surrogate route text before selection", async () => {
		for (const [suffix, malformed] of [
			["DUP", '{"outcome":"ALTERNATIVE","outcome":"BASE_STANDS","method":"m","evidence":"e"}'],
			["SURROGATE", '{"outcome":"ALTERNATIVE","method":"\\ud800","evidence":"e"}'],
		] as const) {
			const current = {
				...subject,
				context: { ...subject.context, pullRequest: { ...subject.context.pullRequest, id: `PR_${suffix}` } },
			};
			let selectorCalled = false;
			const result = await coordinateHistoryRecovery({
				repoRoot: process.cwd(),
				modes,
				subject: current,
				history,
				basis,
				diagnosis: { value: "STAGNATION", invalidation: "nothing", evidence: "history evidence" },
				refreshPreclaim: async () => ({ ...freshness(), subject: structuredClone(current) }),
				refreshPrecontinue: async () => ({ ...freshness(), subject: structuredClone(current) }),
				dispatchProfile: async (ledger, profileId) => {
					if (profileId === "recovery-selector") selectorCalled = true;
					const outcome =
						profileId === "stagnation-root"
							? admittedRaw(malformed)
							: admitted({ outcome: "BASE_STANDS", method: "", evidence: "bounded evidence" });
					const event = ledger.append(1, ledger.start(), outcome);
					return { outcome, attempts: [event], retryState: "available" };
				},
			});
			assert.equal(result.terminal, "handoff");
			assert.equal(selectorCalled, false);
		}
	});

	it("refuses original plan/authorization before refresh or dispatch", async () => {
		for (const invalidation of ["plan", "authorization"] as const) {
			let touched = false;
			const result = await coordinateHistoryRecovery({
				repoRoot: process.cwd(),
				modes,
				subject,
				history,
				basis,
				diagnosis: { value: "STAGNATION", invalidation, evidence: "evidence" },
				refreshPreclaim: async () => {
					touched = true;
					return freshness();
				},
				refreshPrecontinue: async () => {
					touched = true;
					return freshness();
				},
				dispatchProfile: async () => {
					touched = true;
					throw new Error("must not dispatch");
				},
			});
			assert.equal(result.terminal, "handoff");
			assert.equal(touched, false);
		}
	});
});

import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DispatchOutcome } from "../.pi/extensions/gitjig/dispatch/index.ts";
import {
	coordinateHistoryRecovery,
	hasRecoveryRetryReserve,
	makeRecoveryProfileDispatcher,
	type RecoveryProfileDispatcher,
} from "../.pi/extensions/gitjig/recovery/coordinator.ts";
import type { PhaseAProfileId, RecoveryFreshness } from "../.pi/extensions/gitjig/recovery/types.ts";
import type { DiagnosisInput, RepairBasis, StateSummary } from "../.pi/extensions/gitjig/review/history.ts";
import { createRecoveryAttemptLedger, makeDispatcher } from "../.pi/extensions/gitjig/review/orchestrate.ts";
import type { ReviewSubject } from "../.pi/extensions/gitjig/review/subject.ts";

let stateRoot = "";
const priorXdg = process.env.XDG_STATE_HOME;
const priorTest = process.env.GITJIG_TEST_STATE_ROOT;
const priorPath = process.env.PATH;
beforeEach(() => {
	stateRoot = mkdtempSync(join(tmpdir(), "gitjig-recovery-coordinator-"));
	chmodSync(stateRoot, 0o700);
	const bin = join(stateRoot, "bin");
	mkdirSync(bin);
	const pi = join(bin, "pi");
	writeFileSync(
		pi,
		[
			"#!/bin/sh",
			"cat <<'EOF'",
			"Options:",
			"  --print, -p  x",
			"  --thinking <level>  x",
			"  --no-session  x",
			"  --no-extensions, -ne  x",
			"  --no-skills, -ns  x",
			"  --no-context-files, -nc  x",
			"  --approve, -a  x",
			"  --  End option parsing;",
			"Extensions can register additional flags",
			"EOF",
		].join("\n"),
		{ mode: 0o700 },
	);
	process.env.PATH = `${bin}:${priorPath ?? ""}`;
	process.env.XDG_STATE_HOME = stateRoot;
	delete process.env.GITJIG_TEST_STATE_ROOT;
});
afterEach(() => {
	if (priorXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = priorXdg;
	if (priorTest === undefined) delete process.env.GITJIG_TEST_STATE_ROOT;
	else process.env.GITJIG_TEST_STATE_ROOT = priorTest;
	if (priorPath === undefined) delete process.env.PATH;
	else process.env.PATH = priorPath;
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

function observed(ledger: Parameters<RecoveryProfileDispatcher>[0], outcome: DispatchOutcome) {
	return makeDispatcher(
		{ callerRepoRoot: "/repo", stateRoot: "/state", delegateArgv: ["pi"], timeoutMs: 600_000 },
		async () => outcome,
		{ attemptPolicy: { ledger, beforeRetry: () => true } },
	)("brief", "b".repeat(40));
}

function dispatcher(outputs: Partial<Record<PhaseAProfileId, unknown>>): RecoveryProfileDispatcher {
	return async (ledger, profileId) => observed(ledger, admitted(outputs[profileId]));
}

function freshness(): RecoveryFreshness {
	return { subject: structuredClone(subject), history: structuredClone(history), basis };
}

describe("Phase-A history recovery coordinator", () => {
	it("returns profile-preflight before claim when executable help is unavailable", async () => {
		const saved = process.env.PATH;
		let refreshed = 0;
		try {
			process.env.PATH = stateRoot;
			const result = await coordinateHistoryRecovery({
				repoRoot: process.cwd(),
				modes,
				subject,
				history,
				basis,
				diagnosis: { value: "STAGNATION", invalidation: "nothing", evidence: "original" },
				refreshPreclaim: async () => {
					refreshed += 1;
					return freshness();
				},
				refreshPrecontinue: async () => {
					throw new Error("no claim");
				},
				dispatchProfile: async () => {
					throw new Error("no dispatch");
				},
			});
			assert.deepEqual(result, {
				terminal: "handoff",
				route: "none",
				cause: "profile-preflight",
				reentry: "nothing",
				nextGate: "park",
				recordRef: null,
			});
			assert.equal(refreshed, 0);
			assert.equal(
				readdirSync(join(stateRoot, "gitjig", "recovery")).filter((name) => name.endsWith(".json")).length,
				0,
			);
		} finally {
			process.env.PATH = saved;
		}
	});

	it("pins the missing-return retry cutoff at exactly 660,000 ms of reserve", async () => {
		assert.equal(hasRecoveryRetryReserve(599_999, 0), false);
		assert.equal(hasRecoveryRetryReserve(600_000, 0), true);
		const source = readFileSync(new URL("../.pi/extensions/gitjig/recovery/coordinator.ts", import.meta.url), "utf8");
		assert.match(source, /beforeRetry:\s*\(\) => hasRecoveryRetryReserve\(operationDeadline, performance\.now\(\)\)/);
		const dispatch = makeRecoveryProfileDispatcher({ repoRoot: process.cwd(), stateRoot });
		const result = await dispatch(
			createRecoveryAttemptLedger(performance.now()),
			"recovery-selector",
			"brief",
			"b".repeat(40),
			performance.now() + 5_000,
		);
		assert.equal(result.retryState, "available");
		assert.equal(result.attempts.length, 1);
	});

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

	it("marks the original diagnosis as classification context rather than fresh evidence", async () => {
		let freshBrief = "";
		let selectorBrief = "";
		const outputs: Partial<Record<PhaseAProfileId, unknown>> = {
			"recovery-selector": {
				kind: "measurement",
				question: "new q",
				method: "new m",
				expectedDiscriminator: "new d",
				evidence: "new spec",
				nonMutating: true,
				notPreviouslyPresent: true,
			},
			"recovery-measurement": {
				kind: "measurement-result",
				specDigest: "placeholder",
				result: "new r",
				evidence: "new result",
			},
			"recovery-diagnosis": { value: "NONE", invalidation: "nothing", evidence: "fresh ruling" },
		};
		const result = await coordinateHistoryRecovery({
			repoRoot: process.cwd(),
			modes,
			subject,
			history,
			basis,
			diagnosis: { value: "OSCILLATION", invalidation: "nothing", evidence: "original-only" },
			refreshPreclaim: async () => freshness(),
			refreshPrecontinue: async () => freshness(),
			dispatchProfile: async (ledger, profileId, semanticBrief) => {
				if (profileId === "recovery-selector") selectorBrief = semanticBrief;
				if (profileId === "recovery-diagnosis") freshBrief = semanticBrief;
				const value = structuredClone(outputs[profileId]) as Record<string, unknown>;
				if (profileId === "recovery-measurement") {
					const spec = JSON.parse(semanticBrief.match(/Input JSON: (.*)/)?.[1] ?? "{}") as { spec?: unknown };
					const { structuralDigest } = await import("../.pi/extensions/gitjig/recovery/types.ts");
					value.specDigest = structuralDigest("gitjig-recovery-measurement-spec:v1", spec.spec);
				}
				return observed(ledger, admitted(value));
			},
		});
		assert.equal(result.terminal, "continue");
		assert.doesNotMatch(selectorBrief, /original-only/);
		assert.match(freshBrief, /original diagnosis is classification context only/);
		assert.match(freshBrief, /"original":\{"evidence":"original-only"/);
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
			return observed(ledger, admitted(value));
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

	it("preserves authorization products and gate when finalization fails", async () => {
		let specDigest = "";
		const spec = {
			kind: "measurement",
			question: "fresh question",
			method: "fresh method",
			expectedDiscriminator: "fresh discriminator",
			evidence: "selector evidence",
			nonMutating: true,
			notPreviouslyPresent: true,
		};
		const result = await coordinateHistoryRecovery({
			repoRoot: process.cwd(),
			modes,
			subject,
			history,
			basis,
			diagnosis: { value: "INDETERMINATE", invalidation: "nothing", evidence: "original" },
			refreshPreclaim: async () => freshness(),
			refreshPrecontinue: async () => {
				throw new Error("authorization cannot enter precontinue");
			},
			dispatchProfile: async (ledger, profileId) => {
				let value: unknown;
				if (profileId === "recovery-selector") {
					value = spec;
					const { structuralDigest } = await import("../.pi/extensions/gitjig/recovery/types.ts");
					specDigest = structuralDigest("gitjig-recovery-measurement-spec:v1", spec);
				} else if (profileId === "recovery-measurement")
					value = { kind: "measurement-result", specDigest, result: "new result", evidence: "measurement evidence" };
				else value = { value: "INDETERMINATE", invalidation: "authorization", evidence: "fresh ruling evidence" };
				const outcome = await observed(ledger, admitted(value));
				if (profileId === "recovery-diagnosis")
					renameSync(join(stateRoot, "gitjig", "recovery"), join(stateRoot, "gitjig", "recovery-moved"));
				return outcome;
			},
		});
		assert.equal(result.terminal, "handoff");
		assert.equal(result.route, "indeterminate");
		assert.equal(result.reentry, "authorization");
		if (result.terminal !== "handoff" || result.route !== "indeterminate" || result.reentry !== "authorization")
			assert.fail("expected authorization handoff");
		assert.equal(result.cause, "recovery-failed");
		assert.equal(result.nextGate, "authorization-handoff");
		assert.equal(result.measurement.result, "new result");
		assert.equal(result.freshRuling.diagnosis.invalidation, "authorization");
	});

	it("hands off when the sole precontinue refresh drifts", async () => {
		const current = {
			...subject,
			context: { ...subject.context, pullRequest: { ...subject.context.pullRequest, id: "PR_PRECONTINUE_DRIFT" } },
		};
		const spec = {
			kind: "measurement",
			question: "drift q",
			method: "drift m",
			expectedDiscriminator: "drift d",
			evidence: "drift selector",
			nonMutating: true,
			notPreviouslyPresent: true,
		};
		let digest = "";
		let precontinue = 0;
		const result = await coordinateHistoryRecovery({
			repoRoot: process.cwd(),
			modes,
			subject: current,
			history,
			basis,
			diagnosis: { value: "OSCILLATION", invalidation: "nothing", evidence: "original" },
			refreshPreclaim: async () => ({ ...freshness(), subject: structuredClone(current) }),
			refreshPrecontinue: async () => {
				precontinue += 1;
				const drifted = structuredClone(current);
				drifted.context.pullRequest.head.oid = "c".repeat(40);
				return { ...freshness(), subject: drifted };
			},
			dispatchProfile: async (ledger, profileId) => {
				let value: unknown;
				if (profileId === "recovery-selector") {
					value = spec;
					const { structuralDigest } = await import("../.pi/extensions/gitjig/recovery/types.ts");
					digest = structuralDigest("gitjig-recovery-measurement-spec:v1", spec);
				} else if (profileId === "recovery-measurement")
					value = {
						kind: "measurement-result",
						specDigest: digest,
						result: "drift result",
						evidence: "drift measured",
					};
				else value = { value: "NONE", invalidation: "nothing", evidence: "fresh" };
				return observed(ledger, admitted(value));
			},
		});
		assert.equal(precontinue, 1);
		assert.equal(result.terminal, "handoff");
	});

	it("rejects a repeated measurement selector before executing measurement", async () => {
		const current = {
			...subject,
			context: { ...subject.context, pullRequest: { ...subject.context.pullRequest, id: "PR_REPEAT" } },
		};
		const repeatedBasis = {
			states: [{ head: "b".repeat(40), evidence: "already measured" }],
			intervals: [],
		} as unknown as RepairBasis;
		const calls: PhaseAProfileId[] = [];
		const result = await coordinateHistoryRecovery({
			repoRoot: process.cwd(),
			modes,
			subject: current,
			history,
			basis: repeatedBasis,
			diagnosis: { value: "OSCILLATION", invalidation: "nothing", evidence: "original" },
			refreshPreclaim: async () => ({
				subject: structuredClone(current),
				history: structuredClone(history),
				basis: repeatedBasis,
			}),
			refreshPrecontinue: async () => {
				throw new Error("repeated spec cannot continue");
			},
			dispatchProfile: async (ledger, profileId) => {
				calls.push(profileId);
				return observed(
					ledger,
					admitted({
						kind: "measurement",
						question: "already measured",
						method: "new method",
						expectedDiscriminator: "new discriminator",
						evidence: "new selector",
						nonMutating: true,
						notPreviouslyPresent: true,
					}),
				);
			},
		});
		assert.equal(result.terminal, "handoff");
		assert.deepEqual(calls, ["recovery-selector"]);
	});

	it("rejects a repeated measurement result before fresh diagnosis", async () => {
		const current = {
			...subject,
			context: { ...subject.context, pullRequest: { ...subject.context.pullRequest, id: "PR_REPEAT_RESULT" } },
		};
		const repeatedBasis = {
			states: [{ head: "b".repeat(40), findings: [{ ruling: { evidence: "old result" } }] }],
			intervals: [],
		} as unknown as RepairBasis;
		const spec = {
			kind: "measurement",
			question: "unique q",
			method: "unique m",
			expectedDiscriminator: "unique d",
			evidence: "unique selector",
			nonMutating: true,
			notPreviouslyPresent: true,
		};
		let digest = "";
		const calls: PhaseAProfileId[] = [];
		const result = await coordinateHistoryRecovery({
			repoRoot: process.cwd(),
			modes,
			subject: current,
			history,
			basis: repeatedBasis,
			diagnosis: { value: "INDETERMINATE", invalidation: "nothing", evidence: "original" },
			refreshPreclaim: async () => ({
				subject: structuredClone(current),
				history: structuredClone(history),
				basis: repeatedBasis,
			}),
			refreshPrecontinue: async () => {
				throw new Error("repeated result cannot continue");
			},
			dispatchProfile: async (ledger, profileId) => {
				calls.push(profileId);
				let value: unknown;
				if (profileId === "recovery-selector") {
					value = spec;
					const { structuralDigest } = await import("../.pi/extensions/gitjig/recovery/types.ts");
					digest = structuralDigest("gitjig-recovery-measurement-spec:v1", spec);
				} else
					value = {
						kind: "measurement-result",
						specDigest: digest,
						result: "old result",
						evidence: "unique measurement evidence",
					};
				return observed(ledger, admitted(value));
			},
		});
		assert.equal(result.terminal, "handoff");
		assert.deepEqual(calls, ["recovery-selector", "recovery-measurement"]);
	});

	it("enforces the route work deadline before precontinue", async () => {
		const current = {
			...subject,
			context: { ...subject.context, pullRequest: { ...subject.context.pullRequest, id: "PR_ROUTE_DEADLINE" } },
		};
		const original = performance.now;
		let clock = 0;
		let refreshes = 0;
		try {
			Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
			const result = await coordinateHistoryRecovery({
				repoRoot: process.cwd(),
				modes,
				subject: current,
				history,
				basis,
				diagnosis: { value: "STAGNATION", invalidation: "nothing", evidence: "original" },
				refreshPreclaim: async () => ({ ...freshness(), subject: structuredClone(current) }),
				refreshPrecontinue: async () => {
					refreshes += 1;
					return { ...freshness(), subject: structuredClone(current) };
				},
				dispatchProfile: async (ledger, profileId) => {
					const value =
						profileId === "stagnation-root"
							? { outcome: "ALTERNATIVE", method: "root", evidence: "root evidence" }
							: profileId === "stagnation-blast-radius"
								? { outcome: "BASE_STANDS", method: "", evidence: "blast evidence" }
								: { selected: "root", materiallyDifferent: true, evidence: "selection" };
					const result = await observed(ledger, admitted(value));
					if (profileId === "recovery-selector") clock = 3_800_000;
					return result;
				},
			});
			assert.equal(result.terminal, "handoff");
			assert.equal(result.nextGate, "park");
			assert.equal(refreshes, 0);
			const directory = join(stateRoot, "gitjig", "recovery");
			const leaves = readdirSync(directory).filter((name) => name.endsWith(".json"));
			assert.equal(leaves.length, 1);
			const durable = JSON.parse(readFileSync(join(directory, leaves[0] as string), "utf8"));
			assert.equal(durable.state, "consumed");
			assert.equal(durable.terminal, "handoff");
			assert.equal(durable.nextGate, "park");
			assert.deepEqual(durable.completeness.requiredSlots, [
				"stagnation-root",
				"stagnation-blast-radius",
				"recovery-selector",
			]);
			assert.deepEqual(durable.attempts.map((attempt: { profileId: string }) => attempt.profileId).sort(), [
				"recovery-selector",
				"stagnation-blast-radius",
				"stagnation-root",
			]);
		} finally {
			Object.defineProperty(performance, "now", { configurable: true, value: original });
		}
	});

	it("pins both sides of the route work cutoff and the post-refresh terminal cutoff to durable outcomes", async () => {
		const original = performance.now;
		try {
			for (const [index, scenario] of (
				[
					{ work: 3_779_999, terminal: false, nextGate: "author-repair", refreshes: 1 },
					{ work: 3_780_000, terminal: false, nextGate: "park", refreshes: 0 },
					{ work: 3_779_999, terminal: true, nextGate: "park", refreshes: 1 },
				] as const
			).entries()) {
				let clock = 0;
				let refreshes = 0;
				let afterRefreshReads = -1;
				Object.defineProperty(performance, "now", {
					configurable: true,
					value: () => (scenario.terminal && afterRefreshReads >= 0 && afterRefreshReads++ > 0 ? 3_840_000 : clock),
				});
				const current = {
					...subject,
					context: {
						...subject.context,
						pullRequest: { ...subject.context.pullRequest, id: `PR_ROUTE_BOUND_${String(index)}` },
					},
				};
				const result = await coordinateHistoryRecovery({
					repoRoot: process.cwd(),
					modes,
					subject: current,
					history,
					basis,
					diagnosis: { value: "STAGNATION", invalidation: "nothing", evidence: "original" },
					refreshPreclaim: async () => ({ ...freshness(), subject: structuredClone(current) }),
					refreshPrecontinue: async () => {
						refreshes += 1;
						if (scenario.terminal) afterRefreshReads = 0;
						return { ...freshness(), subject: structuredClone(current) };
					},
					dispatchProfile: async (ledger, profileId) => {
						const value =
							profileId === "stagnation-root"
								? { outcome: "ALTERNATIVE", method: "root", evidence: "root evidence" }
								: profileId === "stagnation-blast-radius"
									? { outcome: "BASE_STANDS", method: "", evidence: "blast evidence" }
									: { selected: "root", materiallyDifferent: true, evidence: "selection" };
						const outcome = await observed(ledger, admitted(value));
						if (profileId === "recovery-selector") clock = scenario.work;
						return outcome;
					},
				});
				assert.equal(result.nextGate, scenario.nextGate);
				assert.equal(result.terminal, scenario.nextGate === "park" ? "handoff" : "continue");
				assert.equal(refreshes, scenario.refreshes);
				if (scenario.terminal) assert.ok(afterRefreshReads >= 2, "terminal guard must be reached after the work check");
				const directory = join(stateRoot, "gitjig", "recovery");
				assert.ok(result.recordRef);
				const durable = JSON.parse(
					readFileSync(join(directory, `r2-${result.recordRef.repoHash}-${result.recordRef.keyHash}.json`), "utf8"),
				);
				assert.equal(durable.state, "consumed");
				assert.equal(durable.nextGate, scenario.nextGate);
				assert.equal(durable.terminal, scenario.nextGate === "park" ? "handoff" : "continue");
				assert.deepEqual(durable.completeness.requiredSlots, [
					"stagnation-root",
					"stagnation-blast-radius",
					"recovery-selector",
				]);
				assert.deepEqual(durable.completeness.admittedSlots, [
					"stagnation-root",
					"stagnation-blast-radius",
					"recovery-selector",
				]);
				assert.equal(durable.attempts.length, 3);
				assert.equal(durable.sequenceAuthority.lastSequence, 3);
				assert.deepEqual(durable.sequenceAuthority.retrySlots, []);
			}
		} finally {
			Object.defineProperty(performance, "now", { configurable: true, value: original });
		}
	});

	it("maps every fresh invalidation and non-NONE ruling to its closed re-entry gate", async () => {
		const cases = [
			{ value: "NONE", invalidation: "nothing", terminal: "continue", gate: "ordinary-flow" },
			{ value: "NONE", invalidation: "authorization", terminal: "handoff", gate: "authorization-handoff" },
			{ value: "STAGNATION", invalidation: "nothing", terminal: "handoff", gate: "park" },
			{ value: "OSCILLATION", invalidation: "plan", terminal: "handoff", gate: "planning-handoff" },
			{ value: "INDETERMINATE", invalidation: "authorization", terminal: "handoff", gate: "authorization-handoff" },
		] as const;
		for (const [index, expected] of cases.entries()) {
			const current = {
				...subject,
				context: {
					...subject.context,
					pullRequest: { ...subject.context.pullRequest, id: `PR_REENTRY_${String(index)}` },
				},
			};
			const spec = {
				kind: "measurement",
				question: `question ${String(index)}`,
				method: `method ${String(index)}`,
				expectedDiscriminator: `discriminator ${String(index)}`,
				evidence: `selector ${String(index)}`,
				nonMutating: true,
				notPreviouslyPresent: true,
			};
			let digest = "";
			const dispatchProfile: RecoveryProfileDispatcher = async (ledger, profileId) => {
				let value: unknown;
				if (profileId === "recovery-selector") {
					value = spec;
					const { structuralDigest } = await import("../.pi/extensions/gitjig/recovery/types.ts");
					digest = structuralDigest("gitjig-recovery-measurement-spec:v1", spec);
				} else if (profileId === "recovery-measurement") {
					value = {
						kind: "measurement-result",
						specDigest: digest,
						result: `result ${String(index)}`,
						evidence: `measured ${String(index)}`,
					};
				} else
					value = { value: expected.value, invalidation: expected.invalidation, evidence: `ruling ${String(index)}` };
				return observed(ledger, admitted(value));
			};
			const result = await coordinateHistoryRecovery({
				repoRoot: process.cwd(),
				modes,
				subject: current,
				history,
				basis,
				diagnosis: { value: "OSCILLATION", invalidation: "nothing", evidence: "original" },
				refreshPreclaim: async () => ({ ...freshness(), subject: structuredClone(current) }),
				refreshPrecontinue: async () => ({ ...freshness(), subject: structuredClone(current) }),
				dispatchProfile,
			});
			assert.equal(result.terminal, expected.terminal);
			assert.equal(result.nextGate, expected.gate);
		}
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
					return observed(ledger, outcome);
				},
			});
			assert.equal(result.terminal, "handoff");
			assert.equal(selectorCalled, false);
		}
	});

	it("enforces the 8 KiB string budget across the whole route", async () => {
		const current = {
			...subject,
			context: { ...subject.context, pullRequest: { ...subject.context.pullRequest, id: "PR_ROUTE_BUDGET" } },
		};
		let precontinue = 0;
		const result = await coordinateHistoryRecovery({
			repoRoot: process.cwd(),
			modes,
			subject: current,
			history,
			basis,
			diagnosis: { value: "STAGNATION", invalidation: "nothing", evidence: "evidence" },
			refreshPreclaim: async () => ({ ...freshness(), subject: structuredClone(current) }),
			refreshPrecontinue: async () => {
				precontinue += 1;
				return { ...freshness(), subject: structuredClone(current) };
			},
			dispatchProfile: dispatcher({
				"stagnation-root": { outcome: "ALTERNATIVE", method: "m", evidence: "r".repeat(4_090) },
				"stagnation-blast-radius": { outcome: "BASE_STANDS", method: "", evidence: "b".repeat(4_090) },
				"recovery-selector": { selected: "root", materiallyDifferent: true, evidence: "selection evidence" },
			}),
		});
		assert.equal(result.terminal, "handoff");
		assert.equal(precontinue, 0);
	});

	it("records a completed parallel sibling when the other dispatch throws", async () => {
		const current = {
			...subject,
			context: { ...subject.context, pullRequest: { ...subject.context.pullRequest, id: "PR_PARALLEL_PARTIAL" } },
		};
		const result = await coordinateHistoryRecovery({
			repoRoot: process.cwd(),
			modes,
			subject: current,
			history,
			basis,
			diagnosis: { value: "STAGNATION", invalidation: "nothing", evidence: "evidence" },
			refreshPreclaim: async () => ({ ...freshness(), subject: structuredClone(current) }),
			refreshPrecontinue: async () => ({ ...freshness(), subject: structuredClone(current) }),
			dispatchProfile: async (ledger, profileId) => {
				if (profileId === "stagnation-root") throw new Error("root unavailable");
				return observed(ledger, admitted({ outcome: "BASE_STANDS", method: "", evidence: "blast evidence" }));
			},
		});
		assert.equal(result.terminal, "handoff");
		const directory = join(stateRoot, "gitjig", "recovery");
		const files = readdirSync(directory).filter((name) => name.endsWith(".json"));
		assert.equal(files.length, 1);
		const durable = JSON.parse(readFileSync(join(directory, files[0] as string), "utf8"));
		assert.deepEqual(
			durable.attempts.map((attempt: { slot: string }) => attempt.slot),
			["stagnation-blast-radius"],
		);
	});

	it("rejects an unbranded dispatcher attempt slice", async () => {
		const current = {
			...subject,
			context: { ...subject.context, pullRequest: { ...subject.context.pullRequest, id: "PR_FORGED_LEDGER" } },
		};
		const result = await coordinateHistoryRecovery({
			repoRoot: process.cwd(),
			modes,
			subject: current,
			history,
			basis,
			diagnosis: { value: "STAGNATION", invalidation: "nothing", evidence: "evidence" },
			refreshPreclaim: async () => ({ ...freshness(), subject: structuredClone(current) }),
			refreshPrecontinue: async () => ({ ...freshness(), subject: structuredClone(current) }),
			dispatchProfile: async () => ({
				outcome: admitted({ outcome: "BASE_STANDS", method: "", evidence: "e" }),
				attempts: [],
				retryState: "available",
			}),
		});
		assert.equal(result.terminal, "handoff");
		assert.equal(result.cause, "recovery-failed");
	});

	it("refuses a state-domain switch during the preclaim reread", async () => {
		const replacement = mkdtempSync(join(tmpdir(), "gitjig-recovery-domain-switch-"));
		chmodSync(replacement, 0o700);
		try {
			let dispatched = false;
			const result = await coordinateHistoryRecovery({
				repoRoot: process.cwd(),
				modes,
				subject,
				history,
				basis,
				diagnosis: { value: "STAGNATION", invalidation: "nothing", evidence: "evidence" },
				refreshPreclaim: async () => {
					process.env.XDG_STATE_HOME = replacement;
					return freshness();
				},
				refreshPrecontinue: async () => freshness(),
				dispatchProfile: async () => {
					dispatched = true;
					throw new Error("must not dispatch");
				},
			});
			assert.equal(result.terminal, "handoff");
			assert.equal(result.cause, "state-domain");
			assert.equal(dispatched, false);
		} finally {
			process.env.XDG_STATE_HOME = stateRoot;
			rmSync(replacement, { recursive: true, force: true });
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

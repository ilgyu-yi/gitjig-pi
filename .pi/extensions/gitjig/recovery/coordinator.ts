/** Warning-surface roster: EXEMPT — this module returns closed results and emits no warning, throw, or operator-facing text. */
/** One-use Phase-A history recovery coordinator. */
import { randomUUID } from "node:crypto";
import { repositoryKey } from "../modes.ts";
import { admitDiagnosis, type DiagnosisInput, type RepairBasis } from "../review/history.ts";
import { recoveryBrief } from "./briefs.ts";
import { canonicalJson, contentDigest, deriveLineage, domainDigest } from "./lineage.ts";
import {
	armRecoveryProfileDeadline,
	loadProfiles,
	preflightProfiles,
	profileMaterializationDigest,
	recoveryAttemptCount,
} from "./profiles.ts";
import { claimAllowance, finalizeAllowance, type RecoveryRecord } from "./store.ts";
import type {
	FreshRuling,
	HistoryRecoveryInput,
	MeasurementSpec,
	PhaseAProfileId,
	RecoveryMeasurement,
	RecoveryResult,
	SelectedIntervention,
} from "./types.ts";

const TEXT_CAP = 4096;
const SLOT_BUDGET = 1_260_000;
const WORK_MS = 3_600_000;
const TERMINAL_MS = 3_660_000;
const OID = /^[0-9a-f]{40}$/;

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}
function text(value: unknown, empty = false): value is string {
	return (
		typeof value === "string" &&
		(empty || value.length > 0) &&
		Buffer.byteLength(value) <= TEXT_CAP &&
		value === value.normalize("NFC") &&
		![...value].some((char) => {
			const code = char.codePointAt(0) ?? 0;
			return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
		})
	);
}
function payload(outcome: Awaited<ReturnType<HistoryRecoveryInput["dispatchProfile"]>>): unknown {
	if (
		outcome.disposition !== "admitted" ||
		!outcome.ok ||
		outcome.compare !== "confirmed" ||
		outcome.summary !== "recovery-result" ||
		typeof outcome.payload !== "string" ||
		Buffer.byteLength(outcome.payload) > 16 * 1024
	)
		return undefined;
	try {
		return JSON.parse(outcome.payload);
	} catch {
		return undefined;
	}
}
function basisProjection(basis: RepairBasis): unknown {
	return { states: basis.states, intervals: basis.intervals };
}
function sameInput(
	input: HistoryRecoveryInput,
	fresh: Awaited<ReturnType<HistoryRecoveryInput["refreshDiagnosis"]>>,
): boolean {
	if (fresh === undefined) return false;
	return (
		canonicalJson(input.subject) === canonicalJson(fresh.subject) &&
		canonicalJson(input.history) === canonicalJson(fresh.history) &&
		canonicalJson(basisProjection(input.basis)) === canonicalJson(basisProjection(fresh.basis))
	);
}
function diagnosisDigest(value: DiagnosisInput): string | undefined {
	return domainDigest("gitjig-recovery-diagnosis:v1", value);
}
function priorContent(basis: RepairBasis): Set<string> {
	const values = new Set<string>();
	for (const state of basis.states)
		for (const finding of state.findings) {
			const digest = contentDigest(finding.ruling.evidence);
			if (digest !== undefined) values.add(digest);
		}
	return values;
}
function novelSpec(spec: MeasurementSpec, prior: ReadonlySet<string>): boolean {
	return [spec.question, spec.method, spec.expectedDiscriminator, spec.evidence].every((value) => {
		const digest = contentDigest(value);
		return digest !== undefined && !prior.has(digest);
	});
}
function reentryOf(value: DiagnosisInput["invalidation"]): "none" | "plan" | "authorization" {
	return value === "nothing" ? "none" : value;
}

function candidate(value: unknown, slot: "root" | "blast-radius") {
	if (
		!exact(value, ["outcome", "method", "evidence"]) ||
		!["ALTERNATIVE", "BASE_STANDS"].includes(value.outcome as string) ||
		!text(value.method, true) ||
		!text(value.evidence)
	)
		return undefined;
	if ((value.outcome === "ALTERNATIVE") !== value.method.length > 0) return undefined;
	return {
		slot,
		outcome: value.outcome as "ALTERNATIVE" | "BASE_STANDS",
		method: value.method,
		evidence: value.evidence,
	};
}
function contestSelection(value: unknown) {
	if (
		!exact(value, ["selected", "materiallyDifferent", "evidence"]) ||
		!["root", "blast-radius", "none"].includes(value.selected as string) ||
		typeof value.materiallyDifferent !== "boolean" ||
		!text(value.evidence)
	)
		return undefined;
	return value as { selected: "root" | "blast-radius" | "none"; materiallyDifferent: boolean; evidence: string };
}
function measurementSpec(value: unknown): MeasurementSpec | undefined {
	if (
		!exact(value, [
			"kind",
			"question",
			"method",
			"expectedDiscriminator",
			"evidence",
			"nonMutating",
			"notPreviouslyPresent",
		]) ||
		value.kind !== "measurement" ||
		value.nonMutating !== true ||
		value.notPreviouslyPresent !== true ||
		!text(value.question) ||
		!text(value.method) ||
		!text(value.expectedDiscriminator) ||
		!text(value.evidence)
	)
		return undefined;
	return value as MeasurementSpec;
}
function measurementResult(value: unknown, specDigest: string) {
	if (
		!exact(value, ["kind", "specDigest", "result", "evidence"]) ||
		value.kind !== "measurement-result" ||
		value.specDigest !== specDigest ||
		!text(value.result) ||
		!text(value.evidence)
	)
		return undefined;
	return value as { kind: "measurement-result"; specDigest: string; result: string; evidence: string };
}

export async function coordinateHistoryRecovery(input: HistoryRecoveryInput): Promise<RecoveryResult> {
	if (!preflightProfiles(input.stateRoot))
		return {
			terminal: "handoff",
			cause: "profile-preflight",
			reentry: reentryOf(input.diagnosis.invalidation),
			nextGate: "park",
		};
	const loaded = loadProfiles();
	const originalLineage = deriveLineage(input.subject);
	const fresh = await input.refreshDiagnosis();
	if (loaded === undefined || originalLineage === undefined || fresh === undefined || !sameInput(input, fresh))
		return {
			terminal: "handoff",
			cause: "identity",
			reentry: reentryOf(input.diagnosis.invalidation),
			nextGate: "park",
		};
	const freshLineage = deriveLineage(fresh.subject);
	if (freshLineage === undefined || freshLineage.key !== originalLineage.key)
		return {
			terminal: "handoff",
			cause: "identity",
			reentry: reentryOf(input.diagnosis.invalidation),
			nextGate: "park",
		};
	const repoKey = repositoryKey(input.repoRoot);
	const originalDigest = diagnosisDigest(input.diagnosis);
	if (originalDigest === undefined || !OID.test(input.subject.context.pullRequest.head.oid))
		return {
			terminal: "handoff",
			cause: "identity",
			reentry: reentryOf(input.diagnosis.invalidation),
			nextGate: "park",
		};
	const claimId = randomUUID();
	const now = new Date().toISOString();
	const record: RecoveryRecord = {
		schemaVersion: 1,
		repositoryId: originalLineage.repositoryId,
		repositoryKey: repoKey,
		lineageKey: originalLineage.key,
		lineageInput: originalLineage.input,
		pullRequestId: input.subject.context.pullRequest.id,
		issueIds: [...originalLineage.issueIds],
		subjectHead: input.subject.context.pullRequest.head.oid,
		subjectBase: input.subject.context.pullRequest.base.oid,
		modes: input.modes,
		profileSetVersion: 1,
		profileSetDigest: loaded.digest,
		basis: {
			kind: "history-diagnosis",
			reviewHeads: input.basis.states.map((state) => state.head),
			taxonomy: input.diagnosis.value,
			invalidation: input.diagnosis.invalidation,
			diagnosisEvidenceDigest: originalDigest,
		},
		state: "claimed",
		claimId,
		claimedAt: now,
		attempts: [],
		candidateSet: "not-applicable",
		sequenceAuthority: "authoritative",
		selectedIntervention: null,
		measurement: null,
		freshRuling: null,
		reentry: null,
		nextGate: null,
		terminal: "pending",
		terminalAt: null,
	};
	const claim = claimAllowance(input.stateRoot, repoKey, originalLineage.key, record);
	if (claim === undefined)
		return {
			terminal: "handoff",
			cause: "allowance-consumed",
			reentry: reentryOf(input.diagnosis.invalidation),
			nextGate: "park",
		};
	const priorEvidence = priorContent(input.basis);
	const started = performance.now();
	const workDeadline = started + WORK_MS;
	armRecoveryProfileDeadline(input.dispatchProfile, workDeadline);
	const ref = { repositoryKey: repoKey, lineageKey: originalLineage.key, claimId };
	let selected: SelectedIntervention | null = null;
	let measurement: RecoveryMeasurement | null = null;
	let freshRuling: FreshRuling | null = null;
	let candidateSet: RecoveryRecord["candidateSet"] = "not-applicable";
	const attempts: unknown[] = [];
	const dispatch = async (
		id: PhaseAProfileId,
		brief: ReturnType<typeof recoveryBrief>,
		semanticOutcome: "candidate" | "selection" | "measurement" | "diagnosis",
	): Promise<unknown> => {
		if (workDeadline - performance.now() < SLOT_BUDGET) return undefined;
		const digest = profileMaterializationDigest(id);
		if (digest === undefined) return undefined;
		const outcome = await input.dispatchProfile(id, brief, record.subjectHead);
		const count = recoveryAttemptCount(outcome);
		if (count === 2)
			attempts.push({
				slot: id,
				profileId: id,
				materializationDigest: digest,
				ordinal: 1,
				dispatcherClass: "refused",
				returnAdmission: "missing",
				compare: "absent",
				semanticOutcome: "none",
			});
		attempts.push({
			slot: id,
			profileId: id,
			materializationDigest: digest,
			ordinal: count,
			dispatcherClass: outcome.disposition,
			returnAdmission: outcome.disposition === "admitted" ? "valid" : "rejected",
			compare: outcome.disposition === "admitted" ? (outcome.compare ?? "absent") : "absent",
			semanticOutcome,
		});
		if (performance.now() >= workDeadline) return undefined;
		return payload(outcome);
	};
	let terminal: "continue" | "handoff" = "handoff";
	let reentry: "none" | "plan" | "authorization" = reentryOf(input.diagnosis.invalidation);
	let nextGate: RecoveryRecord["nextGate"] = "park";
	try {
		if (input.diagnosis.value === "STAGNATION") {
			const root = candidate(
				await dispatch(
					"stagnation-root",
					recoveryBrief("stagnation-root", { diagnosis: input.diagnosis, basis: input.basis }),
					"candidate",
				),
				"root",
			);
			const blast = candidate(
				await dispatch(
					"stagnation-blast-radius",
					recoveryBrief("stagnation-blast-radius", { diagnosis: input.diagnosis, basis: input.basis }),
					"candidate",
				),
				"blast-radius",
			);
			candidateSet = root && blast ? "complete" : "incomplete";
			if (root && blast) {
				const choice = contestSelection(
					await dispatch(
						"recovery-selector",
						recoveryBrief("recovery-selector", {
							diagnosis: input.diagnosis,
							basis: input.basis,
							candidates: [root, blast],
						}),
						"selection",
					),
				);
				const chosen = choice?.selected === "root" ? root : choice?.selected === "blast-radius" ? blast : undefined;
				if (choice?.materiallyDifferent && chosen?.outcome === "ALTERNATIVE") {
					const rootDigest = domainDigest("gitjig-recovery-candidate:v1", root);
					const blastDigest = domainDigest("gitjig-recovery-candidate:v1", blast);
					if (rootDigest && blastDigest) {
						selected = {
							slot: chosen.slot,
							method: chosen.method,
							candidateEvidence: chosen.evidence,
							selectionEvidence: choice.evidence,
							candidateDigests: [rootDigest, blastDigest],
						};
						if (reentry !== "authorization") {
							terminal = "continue";
							nextGate = reentry === "plan" ? "planning" : "author-repair";
						}
					}
				}
			}
		} else if (input.diagnosis.value === "OSCILLATION" || input.diagnosis.value === "INDETERMINATE") {
			const spec = measurementSpec(
				await dispatch(
					"recovery-selector",
					recoveryBrief("recovery-selector", { diagnosis: input.diagnosis, basis: input.basis }),
					"selection",
				),
			);
			const specDigest =
				spec && novelSpec(spec, priorEvidence) && domainDigest("gitjig-recovery-measurement-spec:v1", spec);
			if (spec && specDigest) {
				const measured = measurementResult(
					await dispatch(
						"recovery-measurement",
						recoveryBrief("recovery-measurement", {
							diagnosis: input.diagnosis,
							basis: input.basis,
							measurement: spec,
						}),
						"measurement",
					),
					specDigest,
				);
				if (measured) {
					const resultDigest = domainDigest("gitjig-recovery-measurement-result:v1", measured);
					const resultContent = contentDigest(measured.result);
					const evidenceDigest = contentDigest(measured.evidence);
					const specContent = new Set(
						[spec.question, spec.method, spec.expectedDiscriminator, spec.evidence]
							.map(contentDigest)
							.filter((value): value is string => value !== undefined),
					);
					if (
						resultDigest &&
						resultContent &&
						evidenceDigest &&
						!priorEvidence.has(resultContent) &&
						!priorEvidence.has(evidenceDigest) &&
						!specContent.has(resultContent) &&
						!specContent.has(evidenceDigest)
					) {
						measurement = {
							spec,
							specDigest,
							result: measured.result,
							evidence: measured.evidence,
							resultDigest,
							evidenceDigest,
						};
						const value = await dispatch(
							"recovery-diagnosis",
							recoveryBrief("recovery-diagnosis", {
								diagnosis: input.diagnosis,
								basis: input.basis,
								measurement: spec,
								result: measured,
							}),
							"diagnosis",
						);
						const admitted = admitDiagnosis({
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
								durationMs: 0,
								code: "ADMITTED",
								message: "dispatch admitted",
							},
						});
						if (admitted.available) {
							const digest = diagnosisDigest(admitted.diagnosis);
							const evidence = contentDigest(admitted.diagnosis.evidence);
							if (digest && evidence)
								freshRuling = { diagnosis: admitted.diagnosis, diagnosisDigest: digest, evidenceDigest: evidence };
							if (admitted.diagnosis.value === "NONE") {
								reentry = reentryOf(admitted.diagnosis.invalidation);
								if (reentry !== "authorization") {
									terminal = "continue";
									nextGate = reentry === "plan" ? "planning" : "ordinary-flow";
								}
							}
						}
					}
				}
			}
		}
	} catch {}
	if (reentry === "authorization") nextGate = "authorization-handoff";
	const consumed: RecoveryRecord = {
		...record,
		attempts,
		candidateSet,
		sequenceAuthority: terminal === "continue" ? "authoritative" : "consumed-failure",
		selectedIntervention: selected,
		measurement,
		freshRuling,
		reentry,
		nextGate,
		state: "consumed",
		terminal,
		terminalAt: new Date().toISOString(),
	};
	if (performance.now() > started + TERMINAL_MS || !finalizeAllowance(claim, consumed))
		return { terminal: "handoff", cause: "recovery-failed", reentry, nextGate: "park", recordRef: ref };
	if (terminal === "continue")
		return {
			terminal,
			selectedIntervention: selected,
			reentry,
			nextGate: nextGate as "author-repair" | "planning" | "ordinary-flow",
			recordRef: ref,
		};
	return {
		terminal,
		cause: reentry === "authorization" ? "authorization" : "recovery-failed",
		reentry,
		nextGate: nextGate as "park" | "authorization-handoff",
		recordRef: ref,
	};
}

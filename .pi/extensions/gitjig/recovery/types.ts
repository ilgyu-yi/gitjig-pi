/** Warning-surface roster: EXEMPT — type/data declarations emit no warning, throw, record, or operator-facing text. */
/** Closed Phase-A recovery contracts. This module emits no operator-facing text. */

import type { DispatchOutcome } from "../dispatch/index.ts";
import type { ResolvedModes } from "../modes.ts";
import type { DiagnosisInput, RepairBasis, StateSummary } from "../review/history.ts";
import type { ReviewSubject } from "../review/subject.ts";

export const PHASE_A_PROFILE_IDS = [
	"stagnation-root",
	"stagnation-blast-radius",
	"recovery-selector",
	"recovery-measurement",
	"recovery-diagnosis",
] as const;
export type PhaseAProfileId = (typeof PHASE_A_PROFILE_IDS)[number];
export type RecoveryReentry = "none" | "plan" | "authorization";
export type RecoveryNextGate = "author-repair" | "planning" | "ordinary-flow" | "park" | "authorization-handoff";

export type RecordRef = { repositoryKey: string; lineageKey: string; claimId: string };
export type SelectedIntervention = {
	slot: "root" | "blast-radius";
	method: string;
	candidateEvidence: string;
	selectionEvidence: string;
	candidateDigests: readonly [string, string];
};
export type RecoveryMeasurement = {
	spec: MeasurementSpec;
	specDigest: string;
	result: string;
	evidence: string;
	resultDigest: string;
	evidenceDigest: string;
};
export type MeasurementSpec = {
	kind: "measurement";
	question: string;
	method: string;
	expectedDiscriminator: string;
	evidence: string;
	nonMutating: true;
	notPreviouslyPresent: true;
};
export type FreshRuling = { diagnosis: DiagnosisInput; diagnosisDigest: string; evidenceDigest: string };

export type RecoveryResult =
	| {
			terminal: "continue";
			selectedIntervention: SelectedIntervention | null;
			reentry: RecoveryReentry;
			nextGate: Exclude<RecoveryNextGate, "park" | "authorization-handoff">;
			recordRef: RecordRef;
	  }
	| {
			terminal: "handoff";
			cause: "profile-preflight" | "identity" | "allowance-consumed" | "recovery-failed" | "authorization";
			reentry: RecoveryReentry;
			nextGate: "park" | "authorization-handoff";
			recordRef?: RecordRef;
	  };

export type RecoverySemanticBrief = { kind: PhaseAProfileId; text: string };
export type RecoveryProfileDispatcher = (
	profileId: PhaseAProfileId,
	brief: RecoverySemanticBrief,
	expectedHead: string,
) => Promise<DispatchOutcome>;

export type RefreshedDiagnosis = {
	subject: ReviewSubject;
	history: readonly StateSummary[];
	basis: RepairBasis;
};

export type HistoryRecoveryInput = {
	repoRoot: string;
	stateRoot: string;
	modes: ResolvedModes;
	subject: ReviewSubject;
	history: readonly StateSummary[];
	basis: RepairBasis;
	diagnosis: DiagnosisInput;
	refreshDiagnosis: () => Promise<RefreshedDiagnosis | undefined>;
	dispatchProfile: RecoveryProfileDispatcher;
};

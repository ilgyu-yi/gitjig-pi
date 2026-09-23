/** Warning-surface roster: EXEMPT — this module emits no operator-facing warning text. */
import { createHash } from "node:crypto";
import type { DispatchOutcome } from "../dispatch/index.ts";
import type { DiagnosisInput, RepairBasis, StateSummary } from "../review/history.ts";
import type { ReviewSubject } from "../review/subject.ts";

export type PhaseAProfileId =
	| "stagnation-root"
	| "stagnation-blast-radius"
	| "recovery-selector"
	| "recovery-measurement"
	| "recovery-diagnosis";
export type RecoveryRoute = "stagnation" | "oscillation" | "indeterminate";
export type RecoverySemanticBrief = string;
export type RecoveryReentry = "nothing" | "plan" | "authorization";
export type RecoveryGate =
	| "author-repair"
	| "ordinary-flow"
	| "planning"
	| "park"
	| "planning-handoff"
	| "authorization-handoff";
export type RecordRef = { repoHash: string; keyHash: string; claimId: string };

export type AttemptRecord = {
	sequence: number;
	startedOffsetMs: number;
	finishedOffsetMs: number;
	diagnostic: Omit<DispatchOutcome["diagnostic"], "message">;
	outcomeDigest: string;
	slot: PhaseAProfileId;
	profileId: PhaseAProfileId;
	profileVersion: 1;
	profileSetDigest: string;
	materializationDigest: string;
	expectedHead: string;
	admission: "retained" | "deadline-rejected" | "semantic-rejected" | "not-admitted";
	resultDigest: string | null;
};

export type Challenger = {
	slot: "root" | "blast-radius";
	outcome: "ALTERNATIVE" | "BASE_STANDS";
	method: string;
	evidence: string;
};
export type SelectorContest = {
	selected: "root" | "blast-radius" | "none";
	materiallyDifferent: boolean;
	evidence: string;
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
export type MeasurementResult = { kind: "measurement-result"; specDigest: string; result: string; evidence: string };
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
export type FreshRuling = { diagnosis: DiagnosisInput; diagnosisDigest: string; evidenceDigest: string };

export type HistoryBasisRecord = {
	kind: "history-diagnosis";
	triggeringReviewState: { head: string; historyIndex: number; stateDigest: string };
	taxonomy: "STAGNATION" | "OSCILLATION" | "INDETERMINATE";
	invalidation: "nothing";
	diagnosisDigest: string;
};

export type ClaimedRecordV3 = {
	schemaVersion: 3;
	state: "claimed";
	repoHash: string;
	keyHash: string;
	claimId: string;
	createdAt: string;
	updatedAt: string;
	profileSetDigest: string;
	subjectDigest: string;
	historyDigest: string;
	basisDigest: string;
	basis: HistoryBasisRecord;
	modes: { mergeMode: "off" | "on"; decisionMode: "autonomous"; mergeSource: string; decisionSource: string };
	route: RecoveryRoute;
	attempts: [];
	completeness: null;
	sequenceAuthority: null;
	selectedIntervention: null;
	measurement: null;
	freshRuling: null;
	reentry: "nothing";
	nextGate: null;
	terminal: null;
	cause: null;
};

type ConsumedRecordBase = Omit<
	ClaimedRecordV3,
	| "state"
	| "updatedAt"
	| "attempts"
	| "completeness"
	| "sequenceAuthority"
	| "selectedIntervention"
	| "measurement"
	| "freshRuling"
	| "reentry"
	| "nextGate"
	| "terminal"
	| "cause"
> & {
	state: "consumed";
	updatedAt: string;
	attempts: AttemptRecord[];
	completeness: { requiredSlots: PhaseAProfileId[]; admittedSlots: PhaseAProfileId[] };
	sequenceAuthority: { source: "host-attempt-order"; lastSequence: number; retrySlots: PhaseAProfileId[] };
};

export type ConsumedRecordV3 = ConsumedRecordBase &
	(
		| {
				route: "stagnation";
				selectedIntervention: SelectedIntervention;
				measurement: null;
				freshRuling: null;
				reentry: "nothing";
				nextGate: "author-repair";
				terminal: "continue";
				cause: null;
		  }
		| {
				route: "oscillation" | "indeterminate";
				selectedIntervention: null;
				measurement: RecoveryMeasurement;
				freshRuling: FreshRuling;
				reentry: "nothing" | "plan";
				nextGate: "ordinary-flow" | "planning";
				terminal: "continue";
				cause: null;
		  }
		| {
				route: "stagnation";
				selectedIntervention: SelectedIntervention | null;
				measurement: null;
				freshRuling: null;
				reentry: "nothing";
				nextGate: "park";
				terminal: "handoff";
				cause: "recovery-failed";
		  }
		| {
				route: "oscillation" | "indeterminate";
				selectedIntervention: null;
				measurement: RecoveryMeasurement | null;
				freshRuling: FreshRuling | null;
				reentry: "nothing";
				nextGate: "park";
				terminal: "handoff";
				cause: "recovery-failed";
		  }
		| {
				route: "oscillation" | "indeterminate";
				selectedIntervention: null;
				measurement: RecoveryMeasurement;
				freshRuling: FreshRuling;
				reentry: "plan";
				nextGate: "planning-handoff";
				terminal: "handoff";
				cause: "recovery-failed";
		  }
		| {
				route: "oscillation" | "indeterminate";
				selectedIntervention: null;
				measurement: RecoveryMeasurement;
				freshRuling: FreshRuling;
				reentry: "authorization";
				nextGate: "authorization-handoff";
				terminal: "handoff";
				cause: "authorization";
		  }
	);

export type RecoveryFreshness = { subject: ReviewSubject; history: readonly StateSummary[]; basis: RepairBasis };

export type RecoveryResult =
	| {
			terminal: "continue";
			route: "stagnation";
			selectedIntervention: SelectedIntervention;
			reentry: "nothing";
			nextGate: "author-repair";
			recordRef: RecordRef;
	  }
	| {
			terminal: "continue";
			route: "oscillation" | "indeterminate";
			measurement: RecoveryMeasurement;
			freshRuling: FreshRuling;
			reentry: "nothing";
			nextGate: "ordinary-flow";
			recordRef: RecordRef;
	  }
	| {
			terminal: "continue";
			route: "oscillation" | "indeterminate";
			measurement: RecoveryMeasurement;
			freshRuling: FreshRuling;
			reentry: "plan";
			nextGate: "planning";
			recordRef: RecordRef;
	  }
	| {
			terminal: "handoff";
			route: "none";
			cause: "profile-preflight" | "state-domain" | "identity" | "allowance-consumed";
			reentry: "nothing";
			nextGate: "park";
			recordRef: RecordRef | null;
	  }
	| {
			terminal: "handoff";
			route: "stagnation";
			cause: "recovery-failed";
			reentry: "nothing";
			nextGate: "park";
			recordRef: RecordRef;
	  }
	| {
			terminal: "handoff";
			route: "oscillation" | "indeterminate";
			cause: "recovery-failed";
			reentry: "nothing";
			nextGate: "park";
			recordRef: RecordRef;
	  }
	| {
			terminal: "handoff";
			route: "oscillation" | "indeterminate";
			cause: "recovery-failed";
			reentry: "plan";
			nextGate: "planning-handoff";
			recordRef: RecordRef;
	  }
	| {
			terminal: "handoff";
			route: "oscillation" | "indeterminate";
			cause: "authorization";
			reentry: "authorization";
			nextGate: "authorization-handoff";
			recordRef: RecordRef;
	  };

function compareText(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function canonicalJson(value: unknown): string {
	const seen = new Set<object>();
	const encode = (entry: unknown): string => {
		if (entry === null) return "null";
		if (typeof entry === "string") return JSON.stringify(entry);
		if (typeof entry === "boolean") return entry ? "true" : "false";
		if (typeof entry === "number") {
			if (!Number.isFinite(entry)) throw new TypeError("nonfinite canonical number");
			return JSON.stringify(entry);
		}
		if (typeof entry !== "object" || entry === undefined) throw new TypeError("unsupported canonical value");
		if (seen.has(entry)) throw new TypeError("cyclic canonical value");
		seen.add(entry);
		try {
			if (Array.isArray(entry)) return `[${entry.map(encode).join(",")}]`;
			const record = entry as Record<string, unknown>;
			const keys = Object.keys(record).sort(compareText);
			return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key])}`).join(",")}}`;
		} finally {
			seen.delete(entry);
		}
	};
	return encode(value);
}

export function structuralDigest(domain: string, value: unknown): string {
	return createHash("sha256").update(`${domain}\n`, "ascii").update(canonicalJson(value), "utf8").digest("hex");
}

export function contentDigest(value: string): string {
	return createHash("sha256")
		.update("gitjig-recovery-content:v1\n", "ascii")
		.update(value.normalize("NFC"), "utf8")
		.digest("hex");
}

export function projectRepairBasis(basis: RepairBasis): {
	states: RepairBasis["states"];
	intervals: RepairBasis["intervals"];
} {
	return { states: basis.states, intervals: basis.intervals };
}

export function subjectDigest(subject: ReviewSubject): string {
	const projected = structuredClone(subject);
	projected.context.pullRequest.closingIssues.sort((left, right) => compareText(left.id, right.id));
	(projected.activation as unknown as { issueId: string }[]).sort((left, right) =>
		compareText(left.issueId, right.issueId),
	);
	return structuralDigest("gitjig-recovery-subject:v1", projected);
}

export const historyDigest = (history: readonly StateSummary[]): string =>
	structuralDigest("gitjig-recovery-history:v1", history);
export const basisDigest = (basis: RepairBasis): string =>
	structuralDigest("gitjig-recovery-basis:v1", projectRepairBasis(basis));
export const diagnosisDigest = (diagnosis: DiagnosisInput): string =>
	structuralDigest("gitjig-recovery-diagnosis:v1", diagnosis);

/** Warning-surface roster: EXEMPT — this module emits no operator-facing warning text. */
import { randomUUID } from "node:crypto";
import type { DispatchOutcome } from "../dispatch/index.ts";
import { runDispatch } from "../dispatch/index.ts";
import type { ResolvedModes } from "../modes.ts";
import type { DiagnosisInput, RepairBasis, StateSummary } from "../review/history.ts";
import {
	admitObservedDispatch,
	createRecoveryAttemptLedger,
	type HostAttemptLedger,
	makeDispatcher,
	type ObservedDispatchOutcome,
} from "../review/orchestrate.ts";
import type { ReviewSubject } from "../review/subject.ts";
import type { SessionSurface } from "../session-surface.ts";
import {
	challengerBrief,
	contestSelectorBrief,
	freshDiagnosisBrief,
	measurementBrief,
	measurementSelectorBrief,
} from "./briefs.ts";
import { deriveAllowancePathEncoding } from "./lineage.ts";
import {
	loadRecoveryProfiles,
	materializeRecoveryProfile,
	preflightRecoveryExecutable,
	type RecoveryProfileSet,
} from "./profiles.ts";
import { resolveRecoveryStateDomain } from "./state-domain.ts";
import { claimAllowance, finalizeAllowance } from "./store.ts";
import {
	type AttemptRecord,
	basisDigest,
	type Challenger,
	type ClaimedRecordV3,
	type ConsumedRecordV3,
	canonicalJson,
	contentDigest,
	diagnosisDigest,
	type FreshRuling,
	historyDigest,
	type MeasurementResult,
	type MeasurementSpec,
	type PhaseAProfileId,
	type RecordRef,
	type RecoveryFreshness,
	type RecoveryMeasurement,
	type RecoveryResult,
	type RecoverySemanticBrief,
	type SelectedIntervention,
	type SelectorContest,
	structuralDigest,
	subjectDigest,
} from "./types.ts";

const ATTEMPT_BOUND_MS = 600_000;
const SLOT_OPERATION_MS = 1_200_000;
const SLOT_RESERVE_MS = 1_260_000;
const RETRY_REMAINING_MS = 660_000;
const ROUTE_WORK_MS = 3_780_000;
const ROUTE_TERMINAL_MS = 3_840_000;
const MAX_RETAINED_RECORD_BYTES = 192 * 1024;

type RecoveryDispatchResult = ObservedDispatchOutcome;
export type RecoveryProfileDispatcher = (
	ledger: HostAttemptLedger,
	profileId: PhaseAProfileId,
	semanticBrief: RecoverySemanticBrief,
	expectedHead: string,
	operationDeadline: number,
) => Promise<RecoveryDispatchResult>;

export type CoordinateRecoveryInput = {
	repoRoot: string;
	modes: ResolvedModes;
	subject: ReviewSubject;
	history: readonly StateSummary[];
	basis: RepairBasis;
	diagnosis: DiagnosisInput;
	refreshPreclaim: () => Promise<RecoveryFreshness | undefined>;
	refreshPrecontinue: () => Promise<RecoveryFreshness | undefined>;
	dispatchProfile: RecoveryProfileDispatcher;
};

export function hasRecoveryRetryReserve(operationDeadline: number, now: number): boolean {
	const reserveDeadline = operationDeadline + (SLOT_RESERVE_MS - SLOT_OPERATION_MS);
	return reserveDeadline - now >= RETRY_REMAINING_MS;
}

export function makeRecoveryProfileDispatcher(input: {
	repoRoot: string;
	stateRoot: string;
	surface?: SessionSurface;
}): RecoveryProfileDispatcher {
	return async (ledger, profileId, semanticBrief, expectedHead, operationDeadline) => {
		const loaded = loadRecoveryProfiles();
		const materialized = loaded === undefined ? undefined : materializeRecoveryProfile(loaded, profileId);
		if (materialized === undefined) throw new Error("recovery profile unavailable");
		const dispatch = makeDispatcher(
			{
				callerRepoRoot: input.repoRoot,
				stateRoot: input.stateRoot,
				delegateArgv: materialized.argv,
				timeoutMs: Math.min(ATTEMPT_BOUND_MS, Math.max(1, Math.floor(operationDeadline - performance.now()))),
				operationDeadline,
				surface: input.surface,
			},
			runDispatch,
			{
				attemptPolicy: {
					ledger,
					beforeRetry: () => hasRecoveryRetryReserve(operationDeadline, performance.now()),
				},
			},
		);
		return dispatch(semanticBrief, expectedHead);
	};
}

function sameFreshness(
	fresh: RecoveryFreshness,
	subject: ReviewSubject,
	history: readonly StateSummary[],
	basis: RepairBasis,
): boolean {
	return (
		subjectDigest(fresh.subject) === subjectDigest(subject) &&
		historyDigest(fresh.history) === historyDigest(history) &&
		basisDigest(fresh.basis) === basisDigest(basis)
	);
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

function routeText(value: unknown, allowEmpty = false): value is string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0) || Buffer.byteLength(value, "utf8") > 4_096)
		return false;
	if (value !== value.normalize("NFC")) return false;
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint === undefined ||
			(codePoint >= 0xd800 && codePoint <= 0xdfff) ||
			codePoint <= 0x1f ||
			(codePoint >= 0x7f && codePoint <= 0x9f)
		)
			return false;
	}
	return true;
}

function hasDuplicateJsonKeys(source: string): boolean {
	let offset = 0;
	const whitespace = () => {
		while (/\s/u.test(source[offset] ?? "")) offset += 1;
	};
	const string = (): string => {
		const start = offset;
		if (source[offset++] !== '"') throw new Error("string expected");
		while (offset < source.length) {
			if (source[offset] === "\\") {
				offset += 2;
				continue;
			}
			if (source[offset++] === '"') return JSON.parse(source.slice(start, offset));
		}
		throw new Error("unterminated string");
	};
	const value = (): boolean => {
		whitespace();
		if (source[offset] === '"') {
			string();
			return false;
		}
		if (source[offset] === "[") {
			offset += 1;
			whitespace();
			let duplicate = false;
			while (source[offset] !== "]") {
				duplicate = value() || duplicate;
				whitespace();
				if (source[offset] !== ",") break;
				offset += 1;
			}
			if (source[offset++] !== "]") throw new Error("array terminator expected");
			return duplicate;
		}
		if (source[offset] === "{") {
			offset += 1;
			whitespace();
			const keys = new Set<string>();
			let duplicate = false;
			while (source[offset] !== "}") {
				const key = string();
				if (keys.has(key)) duplicate = true;
				keys.add(key);
				whitespace();
				if (source[offset++] !== ":") throw new Error("colon expected");
				duplicate = value() || duplicate;
				whitespace();
				if (source[offset] !== ",") break;
				offset += 1;
				whitespace();
			}
			if (source[offset++] !== "}") throw new Error("object terminator expected");
			return duplicate;
		}
		const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(source.slice(offset));
		if (token === null) throw new Error("value expected");
		offset += token[0].length;
		return false;
	};
	const duplicate = value();
	whitespace();
	if (offset !== source.length) throw new Error("trailing input");
	return duplicate;
}

function payload(outcome: DispatchOutcome): unknown {
	if (
		outcome.disposition !== "admitted" ||
		outcome.ok !== true ||
		outcome.compare !== "confirmed" ||
		outcome.summary !== "recovery-result" ||
		typeof outcome.payload !== "string"
	)
		return undefined;
	try {
		if (hasDuplicateJsonKeys(outcome.payload)) return undefined;
		const decoded: unknown = JSON.parse(outcome.payload);
		return Buffer.byteLength(canonicalJson(decoded), "utf8") <= 16 * 1024 ? decoded : undefined;
	} catch {
		return undefined;
	}
}

function challenger(value: unknown, slot: "root" | "blast-radius"): Challenger | undefined {
	if (!exact(value, ["outcome", "method", "evidence"])) return undefined;
	if (value.outcome !== "ALTERNATIVE" && value.outcome !== "BASE_STANDS") return undefined;
	if (!routeText(value.evidence) || !routeText(value.method, true)) return undefined;
	if (value.outcome === "ALTERNATIVE" ? value.method.length === 0 : value.method !== "") return undefined;
	if (Buffer.byteLength(value.method, "utf8") + Buffer.byteLength(value.evidence, "utf8") > 8 * 1024) return undefined;
	return { slot, outcome: value.outcome, method: value.method, evidence: value.evidence };
}

function contest(value: unknown): SelectorContest | undefined {
	if (!exact(value, ["selected", "materiallyDifferent", "evidence"])) return undefined;
	if (!["root", "blast-radius", "none"].includes(value.selected as string)) return undefined;
	if (typeof value.materiallyDifferent !== "boolean" || !routeText(value.evidence)) return undefined;
	return value as SelectorContest;
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
		])
	)
		return undefined;
	if (value.kind !== "measurement" || value.nonMutating !== true || value.notPreviouslyPresent !== true)
		return undefined;
	let total = 0;
	for (const key of ["question", "method", "expectedDiscriminator", "evidence"]) {
		if (!routeText(value[key])) return undefined;
		total += Buffer.byteLength(value[key] as string, "utf8");
	}
	if (total > 8 * 1024) return undefined;
	return value as MeasurementSpec;
}

function measurementResult(value: unknown, specDigest: string): MeasurementResult | undefined {
	if (!exact(value, ["kind", "specDigest", "result", "evidence"])) return undefined;
	if (value.kind !== "measurement-result" || value.specDigest !== specDigest) return undefined;
	if (!routeText(value.result) || !routeText(value.evidence)) return undefined;
	if (Buffer.byteLength(value.result, "utf8") + Buffer.byteLength(value.evidence, "utf8") > 8 * 1024) return undefined;
	return value as MeasurementResult;
}

function diagnosis(value: unknown): DiagnosisInput | undefined {
	if (!exact(value, ["value", "invalidation", "evidence"])) return undefined;
	if (!["NONE", "STAGNATION", "OSCILLATION", "INDETERMINATE"].includes(value.value as string)) return undefined;
	if (!["nothing", "plan", "authorization"].includes(value.invalidation as string) || !routeText(value.evidence))
		return undefined;
	return value as DiagnosisInput;
}

function priorContent(history: readonly StateSummary[], basis: RepairBasis): Set<string> {
	const values = new Set<string>();
	for (const state of history) for (const ruling of state.rulings) values.add(contentDigest(ruling.evidence));
	for (const state of basis.states)
		for (const finding of state.findings) values.add(contentDigest(finding.ruling.evidence));
	return values;
}

function withoutMessage(diagnostic: DispatchOutcome["diagnostic"]): Omit<DispatchOutcome["diagnostic"], "message"> {
	const { message: _message, ...rest } = diagnostic;
	return rest;
}

function handoff(
	cause: Extract<RecoveryResult, { terminal: "handoff" }>["cause"],
	reentry: "nothing" | "plan" | "authorization",
	recordRef: RecordRef | null,
	route: Extract<RecoveryResult, { terminal: "handoff" }>["route"] = "none",
	products: {
		selectedIntervention: SelectedIntervention | null;
		measurement: RecoveryMeasurement | null;
		freshRuling: FreshRuling | null;
	} = { selectedIntervention: null, measurement: null, freshRuling: null },
): RecoveryResult {
	if (route === "none" || recordRef === null) {
		const preclaimCause = ["profile-preflight", "state-domain", "identity", "allowance-consumed"].includes(cause)
			? (cause as "profile-preflight" | "state-domain" | "identity" | "allowance-consumed")
			: "identity";
		return {
			terminal: "handoff",
			route: "none",
			cause: preclaimCause,
			reentry: "nothing",
			nextGate: "park",
			recordRef,
		};
	}
	if (route === "stagnation")
		return {
			terminal: "handoff",
			route,
			cause: "recovery-failed",
			selectedIntervention: products.selectedIntervention,
			reentry: "nothing",
			nextGate: "park",
			recordRef,
		};
	if (reentry === "authorization" && products.measurement !== null && products.freshRuling !== null)
		return {
			terminal: "handoff",
			route,
			cause: cause === "authorization" ? "authorization" : "recovery-failed",
			measurement: products.measurement,
			freshRuling: products.freshRuling,
			reentry,
			nextGate: "authorization-handoff",
			recordRef,
		};
	if (reentry === "plan" && products.measurement !== null && products.freshRuling !== null)
		return {
			terminal: "handoff",
			route,
			cause: "recovery-failed",
			measurement: products.measurement,
			freshRuling: products.freshRuling,
			reentry,
			nextGate: "planning-handoff",
			recordRef,
		};
	return {
		terminal: "handoff",
		route,
		cause: "recovery-failed",
		measurement: products.measurement,
		freshRuling: products.freshRuling,
		reentry: "nothing",
		nextGate: "park",
		recordRef,
	};
}

export async function coordinateHistoryRecovery(input: CoordinateRecoveryInput): Promise<RecoveryResult> {
	if (
		input.modes.decisionMode !== "autonomous" ||
		input.diagnosis.value === "NONE" ||
		input.diagnosis.invalidation !== "nothing"
	)
		return handoff("identity", input.diagnosis.invalidation, null);
	const stateDomain = resolveRecoveryStateDomain();
	if (stateDomain === undefined) return handoff("state-domain", "nothing", null);
	const loaded = loadRecoveryProfiles();
	if (loaded === undefined || !preflightRecoveryExecutable()) return handoff("profile-preflight", "nothing", null);
	if (resolveRecoveryStateDomain() !== stateDomain) return handoff("state-domain", "nothing", null);
	const fresh = await input.refreshPreclaim();
	if (fresh === undefined || !sameFreshness(fresh, input.subject, input.history, input.basis))
		return handoff("identity", "nothing", null);
	// Final synchronous every-use walk immediately precedes the exclusive claim.
	if (resolveRecoveryStateDomain() !== stateDomain) return handoff("state-domain", "nothing", null);
	const encoding = deriveAllowancePathEncoding(input.subject);
	const triggering = input.history.at(-1);
	if (encoding === undefined || triggering === undefined || !/^[0-9a-f]{40}$/.test(triggering.head))
		return handoff("identity", "nothing", null);
	const route = input.diagnosis.value.toLowerCase() as "stagnation" | "oscillation" | "indeterminate";
	const createdAt = new Date().toISOString();
	const claimed: ClaimedRecordV3 = {
		schemaVersion: 3,
		state: "claimed",
		repoHash: encoding.repoHash,
		keyHash: encoding.keyHash,
		claimId: randomUUID(),
		createdAt,
		updatedAt: createdAt,
		profileSetDigest: loaded.digest,
		subjectDigest: subjectDigest(input.subject),
		historyDigest: historyDigest(input.history),
		basisDigest: basisDigest(input.basis),
		basis: {
			kind: "history-diagnosis",
			triggeringReviewState: {
				head: triggering.head,
				historyIndex: input.history.length - 1,
				stateDigest: structuralDigest("gitjig-recovery-state:v1", triggering),
			},
			taxonomy: input.diagnosis.value,
			invalidation: "nothing",
			diagnosisDigest: diagnosisDigest(input.diagnosis),
		},
		modes: {
			mergeMode: input.modes.mergeMode,
			decisionMode: "autonomous",
			mergeSource: input.modes.mergeSource,
			decisionSource: input.modes.decisionSource,
		},
		route,
		attempts: [],
		completeness: null,
		sequenceAuthority: null,
		selectedIntervention: null,
		measurement: null,
		freshRuling: null,
		reentry: "nothing",
		nextGate: null,
		terminal: null,
		cause: null,
	};
	const claimedResult = claimAllowance({ subject: input.subject, record: claimed });
	if (claimedResult.status === "preclaim-refused") return handoff(claimedResult.cause, "nothing", null);
	if (claimedResult.status === "consumed")
		return handoff("allowance-consumed", "nothing", claimedResult.recordRef ?? null);

	const claim = claimedResult.claim;
	const recordRef = claimedResult.recordRef;
	const routeT0 = performance.now();
	const routeDeadline = routeT0 + ROUTE_WORK_MS;
	const ledger = createRecoveryAttemptLedger(routeT0);
	const attempts: AttemptRecord[] = [];
	const admittedSlots: PhaseAProfileId[] = [];
	const retrySlots: PhaseAProfileId[] = [];
	let selectedIntervention: SelectedIntervention | null = null;
	let measurement: RecoveryMeasurement | null = null;
	let freshRuling: FreshRuling | null = null;
	let reentry: "nothing" | "plan" | "authorization" = "nothing";
	let retainedRouteBytes = 0;
	const retainWithinRouteBudget = <T>(value: T | undefined, strings: readonly string[]): T | undefined => {
		if (value === undefined) return undefined;
		const bytes = strings.reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0);
		if (retainedRouteBytes + bytes > 8 * 1024) return undefined;
		retainedRouteBytes += bytes;
		return value;
	};
	const requiredSlots: PhaseAProfileId[] =
		route === "stagnation"
			? ["stagnation-root", "stagnation-blast-radius", "recovery-selector"]
			: ["recovery-selector", "recovery-measurement", "recovery-diagnosis"];

	const appendAttempts = (
		profileId: PhaseAProfileId,
		dispatched: RecoveryDispatchResult,
		resultDigest: string | null,
		retained: boolean,
	): void => {
		const materialized = materializeRecoveryProfile(loaded, profileId);
		if (materialized === undefined) return;
		for (const event of dispatched.attempts) {
			const { attempt: _attempt, ...hostEvent } = event;
			attempts.push({
				...hostEvent,
				slot: profileId,
				profileId,
				profileVersion: 1,
				profileSetDigest: loaded.digest,
				materializationDigest: materialized.digest,
				expectedHead: input.subject.context.pullRequest.head.oid,
				diagnostic: withoutMessage(event.diagnostic),
				admission:
					event === dispatched.attempts.at(-1)
						? retained
							? "retained"
							: event.diagnostic.code === "ABORTED"
								? "deadline-rejected"
								: event.diagnostic.status === "admitted"
									? "semantic-rejected"
									: "not-admitted"
						: "not-admitted",
				resultDigest: event === dispatched.attempts.at(-1) && retained ? resultDigest : null,
			});
		}
		if (dispatched.retryState === "spent" && dispatched.attempts.length === 2) retrySlots.push(profileId);
		if (retained) admittedSlots.push(profileId);
	};

	const dispatch = async (
		profileId: PhaseAProfileId,
		semanticBrief: RecoverySemanticBrief,
	): Promise<RecoveryDispatchResult | undefined> => {
		const now = performance.now();
		if (routeDeadline - now < SLOT_RESERVE_MS) return undefined;
		try {
			const observed = await input.dispatchProfile(
				ledger,
				profileId,
				semanticBrief,
				input.subject.context.pullRequest.head.oid,
				now + SLOT_OPERATION_MS,
			);
			return admitObservedDispatch(ledger, observed);
		} catch {
			return undefined;
		}
	};

	const consumedTimestamp = (): string => {
		const minimum = Date.parse(claimed.createdAt) + 1;
		return new Date(Math.max(Date.now(), minimum)).toISOString();
	};
	const consumedRecord = (
		terminal: "continue" | "handoff",
		cause: ConsumedRecordV3["cause"],
		nextGate: ConsumedRecordV3["nextGate"],
	): ConsumedRecordV3 =>
		({
			...claimed,
			state: "consumed",
			updatedAt: consumedTimestamp(),
			attempts: attempts.sort((left, right) => left.sequence - right.sequence),
			completeness: { requiredSlots, admittedSlots },
			sequenceAuthority: {
				source: "host-attempt-order",
				lastSequence: attempts.reduce((maximum, attempt) => Math.max(maximum, attempt.sequence), 0),
				retrySlots,
			},
			selectedIntervention,
			measurement,
			freshRuling,
			reentry,
			nextGate,
			terminal,
			cause,
		}) as unknown as ConsumedRecordV3;

	const overRetainedBudget = (record: ConsumedRecordV3): boolean =>
		Buffer.byteLength(canonicalJson(record), "utf8") > MAX_RETAINED_RECORD_BYTES;
	const omitRetainedOutputs = (): void => {
		for (const attempt of attempts) {
			if (attempt.admission === "retained") {
				attempt.admission = "semantic-rejected";
				attempt.resultDigest = null;
			}
		}
		admittedSlots.splice(0);
		selectedIntervention = null;
		measurement = null;
		freshRuling = null;
		reentry = "nothing";
	};
	const finalizeHandoff = (cause: "recovery-failed" | "authorization" = "recovery-failed"): RecoveryResult => {
		let gate: ConsumedRecordV3["nextGate"] =
			reentry === "plan" ? "planning-handoff" : reentry === "authorization" ? "authorization-handoff" : "park";
		let record = consumedRecord("handoff", cause, gate);
		if (overRetainedBudget(record)) {
			omitRetainedOutputs();
			cause = "recovery-failed";
			gate = "park";
			record = consumedRecord("handoff", cause, gate);
		}
		const finalized = finalizeAllowance(claim, record);
		return handoff(finalized.status === "finalized" ? cause : "recovery-failed", reentry, recordRef, route, {
			selectedIntervention,
			measurement,
			freshRuling,
		});
	};

	try {
		if (route === "stagnation") {
			const [rootRun, blastRun] = await Promise.all([
				dispatch("stagnation-root", challengerBrief("root", input.diagnosis, input.basis)),
				dispatch("stagnation-blast-radius", challengerBrief("blast-radius", input.diagnosis, input.basis)),
			]);
			const parsedRoot = rootRun === undefined ? undefined : challenger(payload(rootRun.outcome), "root");
			const root = retainWithinRouteBudget(
				parsedRoot,
				parsedRoot === undefined ? [] : [parsedRoot.method, parsedRoot.evidence],
			);
			const parsedBlast = blastRun === undefined ? undefined : challenger(payload(blastRun.outcome), "blast-radius");
			const blast = retainWithinRouteBudget(
				parsedBlast,
				parsedBlast === undefined ? [] : [parsedBlast.method, parsedBlast.evidence],
			);
			const rootDigest = root === undefined ? null : structuralDigest("gitjig-recovery-candidate:v1", root);
			const blastDigest = blast === undefined ? null : structuralDigest("gitjig-recovery-candidate:v1", blast);
			if (rootRun !== undefined) appendAttempts("stagnation-root", rootRun, rootDigest, root !== undefined);
			if (blastRun !== undefined) appendAttempts("stagnation-blast-radius", blastRun, blastDigest, blast !== undefined);
			if (
				rootRun === undefined ||
				blastRun === undefined ||
				root === undefined ||
				blast === undefined ||
				rootDigest === null ||
				blastDigest === null
			)
				return finalizeHandoff();
			const selectorRun = await dispatch("recovery-selector", contestSelectorBrief([root, blast]));
			if (selectorRun === undefined) return finalizeHandoff();
			const parsedSelection = contest(payload(selectorRun.outcome));
			const selection = retainWithinRouteBudget(
				parsedSelection,
				parsedSelection === undefined ? [] : [parsedSelection.evidence],
			);
			const selectionDigest =
				selection === undefined ? null : structuralDigest("gitjig-recovery-selection:v1", selection);
			appendAttempts("recovery-selector", selectorRun, selectionDigest, selection !== undefined);
			if (selection === undefined || selection.selected === "none" || !selection.materiallyDifferent)
				return finalizeHandoff();
			const selected = selection.selected === "root" ? root : blast;
			if (selected.outcome !== "ALTERNATIVE") return finalizeHandoff();
			selectedIntervention = {
				slot: selection.selected,
				method: selected.method,
				candidateEvidence: selected.evidence,
				selectionEvidence: selection.evidence,
				candidateDigests: [rootDigest, blastDigest],
			};
		} else {
			const selectorRun = await dispatch("recovery-selector", measurementSelectorBrief(input.diagnosis, input.basis));
			if (selectorRun === undefined) return finalizeHandoff();
			const parsedSpec = measurementSpec(payload(selectorRun.outcome));
			const spec = retainWithinRouteBudget(
				parsedSpec,
				parsedSpec === undefined
					? []
					: [parsedSpec.question, parsedSpec.method, parsedSpec.expectedDiscriminator, parsedSpec.evidence],
			);
			const prior = priorContent(input.history, input.basis);
			const specNovel =
				spec !== undefined &&
				[spec.question, spec.method, spec.expectedDiscriminator, spec.evidence].every(
					(text) => !prior.has(contentDigest(text)),
				);
			const specDigest = spec === undefined ? null : structuralDigest("gitjig-recovery-measurement-spec:v1", spec);
			appendAttempts("recovery-selector", selectorRun, specDigest, spec !== undefined && specNovel);
			if (spec === undefined || !specNovel || specDigest === null) return finalizeHandoff();
			const measurementRun = await dispatch("recovery-measurement", measurementBrief(spec));
			if (measurementRun === undefined) return finalizeHandoff();
			const parsedMeasurement = measurementResult(payload(measurementRun.outcome), specDigest);
			const measured = retainWithinRouteBudget(
				parsedMeasurement,
				parsedMeasurement === undefined ? [] : [parsedMeasurement.result, parsedMeasurement.evidence],
			);
			const specContent = new Set(
				[spec.question, spec.method, spec.expectedDiscriminator, spec.evidence].map(contentDigest),
			);
			const resultNovel =
				measured !== undefined &&
				[measured.result, measured.evidence].every((text) => {
					const digest = contentDigest(text);
					return !prior.has(digest) && !specContent.has(digest);
				});
			const measurementDigest =
				measured === undefined ? null : structuralDigest("gitjig-recovery-measurement-result:v1", measured);
			appendAttempts("recovery-measurement", measurementRun, measurementDigest, measured !== undefined && resultNovel);
			if (measured === undefined || !resultNovel || measurementDigest === null) return finalizeHandoff();
			measurement = {
				spec,
				specDigest,
				result: measured.result,
				evidence: measured.evidence,
				resultDigest: measurementDigest,
				evidenceDigest: contentDigest(measured.evidence),
			};
			const diagnosisRun = await dispatch(
				"recovery-diagnosis",
				freshDiagnosisBrief(input.diagnosis, input.basis, spec, measured),
			);
			if (diagnosisRun === undefined) return finalizeHandoff();
			const parsedDiagnosis = diagnosis(payload(diagnosisRun.outcome));
			const freshDiagnosis = retainWithinRouteBudget(
				parsedDiagnosis,
				parsedDiagnosis === undefined ? [] : [parsedDiagnosis.evidence],
			);
			const freshDigest = freshDiagnosis === undefined ? null : diagnosisDigest(freshDiagnosis);
			appendAttempts("recovery-diagnosis", diagnosisRun, freshDigest, freshDiagnosis !== undefined);
			if (freshDiagnosis === undefined || freshDigest === null) return finalizeHandoff();
			freshRuling = {
				diagnosis: freshDiagnosis,
				diagnosisDigest: freshDigest,
				evidenceDigest: contentDigest(freshDiagnosis.evidence),
			};
			reentry = freshDiagnosis.invalidation;
			if (freshDiagnosis.value !== "NONE")
				return finalizeHandoff(reentry === "authorization" ? "authorization" : "recovery-failed");
			if (reentry === "authorization") return finalizeHandoff("authorization");
		}

		const prospectiveGate =
			route === "stagnation" ? "author-repair" : reentry === "plan" ? "planning" : "ordinary-flow";
		if (overRetainedBudget(consumedRecord("continue", null, prospectiveGate))) return finalizeHandoff();
		if (performance.now() >= routeDeadline) return finalizeHandoff();
		const refreshed = await input.refreshPrecontinue();
		if (performance.now() >= routeDeadline) return finalizeHandoff();
		if (refreshed === undefined || !sameFreshness(refreshed, input.subject, input.history, input.basis))
			return finalizeHandoff();
		if (performance.now() >= routeT0 + ROUTE_TERMINAL_MS) return finalizeHandoff();
		const nextGate = prospectiveGate;
		const finalized = finalizeAllowance(claim, consumedRecord("continue", null, nextGate));
		if (finalized.status !== "finalized")
			return handoff("recovery-failed", reentry, recordRef, route, { selectedIntervention, measurement, freshRuling });
		if (route === "stagnation" && selectedIntervention !== null)
			return {
				terminal: "continue",
				route,
				selectedIntervention,
				reentry: "nothing",
				nextGate: "author-repair",
				recordRef,
			};
		if (route !== "stagnation" && measurement !== null && freshRuling !== null) {
			if (reentry === "plan")
				return { terminal: "continue", route, measurement, freshRuling, reentry, nextGate: "planning", recordRef };
			if (reentry === "nothing")
				return { terminal: "continue", route, measurement, freshRuling, reentry, nextGate: "ordinary-flow", recordRef };
		}
		return handoff("recovery-failed", reentry, recordRef, route, { selectedIntervention, measurement, freshRuling });
	} catch {
		return finalizeHandoff();
	}
}

export function recoveryInputDigest(input: {
	subject: ReviewSubject;
	history: readonly StateSummary[];
	basis: RepairBasis;
}): string {
	return structuralDigest("gitjig-recovery-input:v1", {
		subjectDigest: subjectDigest(input.subject),
		historyDigest: historyDigest(input.history),
		basisDigest: basisDigest(input.basis),
	});
}

export function recoveryProfileSetDigest(set: RecoveryProfileSet): string {
	return structuralDigest("gitjig-recovery-profiles:v1", JSON.parse(canonicalJson(set)));
}

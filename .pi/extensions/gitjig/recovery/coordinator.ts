/** Warning-surface roster: EXEMPT — this module emits no operator-facing warning text. */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { makeDiagnostic } from "../dispatch/diagnostics.ts";
import type { DispatchOutcome } from "../dispatch/index.ts";
import { runDispatch } from "../dispatch/index.ts";
import type { PiInvocation } from "../dispatch/pi-run.ts";
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
	piRecoveryBrief,
} from "./briefs.ts";
import { admitChangeKeyOperands, deriveAllowancePathEncoding } from "./lineage.ts";
import type { RecoveryPiRole } from "./pi-profile.ts";
import { loadRecoveryProfiles, materializeRecoveryProfile, preflightRecoveryExecutable } from "./profiles.ts";
import { resolveRecoveryStateDomain } from "./state-domain.ts";
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

const RECORD_LIMIT = 256 * 1024;
const FILE_MODE = 0o600;
const CLAIM_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const RECORD_KEYS = [
	"schemaVersion",
	"state",
	"repoHash",
	"keyHash",
	"changeKey",
	"claimId",
	"createdAt",
	"updatedAt",
	"profileSetDigest",
	"subjectDigest",
	"historyDigest",
	"basisDigest",
	"basis",
	"modes",
	"route",
	"attempts",
	"completeness",
	"sequenceAuthority",
	"selectedIntervention",
	"measurement",
	"freshRuling",
	"reentry",
	"nextGate",
	"terminal",
	"cause",
] as const;
const CLAIM = Symbol("allowance-claim");

type AllowanceClaim = { readonly [CLAIM]: true };
type ClaimState = {
	path: string;
	recoveryDir: string;
	claimedBytes: Buffer;
	device: number | bigint;
	inode: number | bigint;
	recordRef: RecordRef;
	immutableDigest: string;
};

type ClaimAllowanceResult =
	| { status: "claimed"; claim: AllowanceClaim; recordRef: RecordRef }
	| { status: "preclaim-refused"; cause: "state-domain" | "identity" }
	| { status: "consumed"; cause: "existing" | "create-or-write-ambiguous"; recordRef?: RecordRef };
type FinalizeAllowanceResult =
	| { status: "finalized"; recordRef: RecordRef }
	| { status: "consumed-unverified"; recordRef: RecordRef };

const DEFINITE_PRECREATE_ERRORS = new Set([
	"EACCES",
	"EPERM",
	"ENOENT",
	"ENOTDIR",
	"ELOOP",
	"EISDIR",
	"EINVAL",
	"EMFILE",
	"ENFILE",
	"ENAMETOOLONG",
	"EROFS",
	"ENOSPC",
	"EDQUOT",
]);

const spent = new WeakSet<object>();
const claimStates = new WeakMap<object, ClaimState>();

function effectiveUid(): number | undefined {
	return typeof process.geteuid === "function" ? process.geteuid() : undefined;
}

function exactKeys(value: Record<string, unknown>): boolean {
	const keys = Object.keys(value);
	return keys.length === RECORD_KEYS.length && RECORD_KEYS.every((key) => Object.hasOwn(value, key));
}

function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		keys.every((key) => Object.hasOwn(value, key)) &&
		Object.keys(value).length === keys.length
	);
}

function validDiagnostic(value: unknown): boolean {
	if (!object(value, ["schemaVersion", "status", "phase", "run", "return", "compare", "durationMs", "code"]))
		return false;
	if (
		!object(value.run, ["class", "exitCode", "signal"]) ||
		!object(value.return, ["class"]) ||
		!object(value.compare, ["class"])
	)
		return false;
	const rebuilt = makeDiagnostic({
		status: value.status as never,
		phase: value.phase as never,
		run: value.run as never,
		return: value.return as never,
		compare: value.compare as never,
		durationMs: value.durationMs as number,
		code: value.code as never,
	});
	const { message: _message, ...projection } = rebuilt;
	return canonicalJson(projection) === canonicalJson(value);
}

function validAttempts(value: unknown): value is Record<string, unknown>[] {
	if (!Array.isArray(value)) return false;
	const ids = new Set([
		"stagnation-root",
		"stagnation-blast-radius",
		"recovery-selector",
		"recovery-measurement",
		"recovery-diagnosis",
	]);
	return value.every((entry, index) => {
		if (
			!object(entry, [
				"sequence",
				"startedOffsetMs",
				"finishedOffsetMs",
				"diagnostic",
				"outcomeDigest",
				"slot",
				"profileId",
				"profileVersion",
				"profileSetDigest",
				"materializationDigest",
				"expectedHead",
				"admission",
				"resultDigest",
			])
		)
			return false;
		const integers = [entry.sequence, entry.startedOffsetMs, entry.finishedOffsetMs];
		const diagnostic = entry.diagnostic as {
			status: unknown;
			code: unknown;
			return: { class: unknown };
			compare: { class: unknown };
		};
		const admittedDiagnostic =
			diagnostic.status === "admitted" &&
			diagnostic.code === "ADMITTED" &&
			diagnostic.return.class === "admitted" &&
			diagnostic.compare.class === "confirmed";
		return (
			integers.every((number) => Number.isSafeInteger(number) && (number as number) >= 0) &&
			entry.sequence === index + 1 &&
			(entry.finishedOffsetMs as number) >= (entry.startedOffsetMs as number) &&
			ids.has(entry.profileId as string) &&
			entry.slot === entry.profileId &&
			entry.profileVersion === 1 &&
			[entry.profileSetDigest, entry.materializationDigest, entry.outcomeDigest].every(
				(digest) => typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest),
			) &&
			typeof entry.expectedHead === "string" &&
			/^[0-9a-f]{40}$/.test(entry.expectedHead) &&
			["retained", "deadline-rejected", "semantic-rejected", "not-admitted"].includes(entry.admission as string) &&
			(entry.admission === "retained"
				? admittedDiagnostic && typeof entry.resultDigest === "string" && /^[0-9a-f]{64}$/.test(entry.resultDigest)
				: entry.admission === "semantic-rejected"
					? admittedDiagnostic && entry.resultDigest === null
					: entry.admission === "deadline-rejected"
						? diagnostic.code === "ABORTED" && entry.resultDigest === null
						: !admittedDiagnostic && entry.resultDigest === null) &&
			validDiagnostic(entry.diagnostic)
		);
	});
}

function storedText(value: unknown, empty = false): value is string {
	if (typeof value !== "string" || (!empty && value.length === 0) || Buffer.byteLength(value, "utf8") > 4_096)
		return false;
	if (value.normalize("NFC") !== value) return false;
	return ![...value].some((character) => {
		const point = character.codePointAt(0) ?? 0;
		return point <= 0x1f || (point >= 0x7f && point <= 0x9f) || (point >= 0xd800 && point <= 0xdfff);
	});
}

function validSelected(value: unknown): boolean {
	return (
		object(value, ["slot", "method", "candidateEvidence", "selectionEvidence", "candidateDigests"]) &&
		["root", "blast-radius"].includes(value.slot as string) &&
		storedText(value.method) &&
		storedText(value.candidateEvidence) &&
		storedText(value.selectionEvidence) &&
		Array.isArray(value.candidateDigests) &&
		value.candidateDigests.length === 2 &&
		value.candidateDigests.every((digest) => typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)) &&
		value.candidateDigests[value.slot === "root" ? 0 : 1] ===
			structuralDigest("gitjig-recovery-candidate:v1", {
				slot: value.slot,
				outcome: "ALTERNATIVE",
				method: value.method,
				evidence: value.candidateEvidence,
			})
	);
}

function validMeasurement(value: unknown): boolean {
	if (!object(value, ["spec", "specDigest", "result", "evidence", "resultDigest", "evidenceDigest"])) return false;
	const spec = value.spec;
	return (
		object(spec, [
			"kind",
			"question",
			"method",
			"expectedDiscriminator",
			"evidence",
			"nonMutating",
			"notPreviouslyPresent",
		]) &&
		spec.kind === "measurement" &&
		spec.nonMutating === true &&
		spec.notPreviouslyPresent === true &&
		[spec.question, spec.method, spec.expectedDiscriminator, spec.evidence, value.result, value.evidence].every(
			(text) => storedText(text),
		) &&
		[value.specDigest, value.resultDigest, value.evidenceDigest].every(
			(digest) => typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest),
		) &&
		value.specDigest === structuralDigest("gitjig-recovery-measurement-spec:v1", spec) &&
		value.resultDigest ===
			structuralDigest("gitjig-recovery-measurement-result:v1", {
				kind: "measurement-result",
				specDigest: value.specDigest,
				result: value.result,
				evidence: value.evidence,
			}) &&
		value.evidenceDigest === contentDigest(value.evidence as string)
	);
}

function validFreshRuling(value: unknown): boolean {
	if (!object(value, ["diagnosis", "diagnosisDigest", "evidenceDigest"])) return false;
	return (
		object(value.diagnosis, ["value", "invalidation", "evidence"]) &&
		["NONE", "STAGNATION", "OSCILLATION", "INDETERMINATE"].includes(value.diagnosis.value as string) &&
		["nothing", "plan", "authorization"].includes(value.diagnosis.invalidation as string) &&
		storedText(value.diagnosis.evidence) &&
		[value.diagnosisDigest, value.evidenceDigest].every(
			(digest) => typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest),
		) &&
		value.diagnosisDigest === structuralDigest("gitjig-recovery-diagnosis:v1", value.diagnosis) &&
		value.evidenceDigest === contentDigest(value.diagnosis.evidence as string)
	);
}

function coreRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const hex = (entry: unknown) => typeof entry === "string" && /^[0-9a-f]{64}$/.test(entry);
	const timestamp = (entry: unknown) =>
		typeof entry === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry) &&
		!Number.isNaN(Date.parse(entry));
	const source = (entry: unknown) => {
		if (typeof entry !== "string" || entry.length === 0 || Buffer.byteLength(entry, "utf8") > 256) return false;
		if (entry !== entry.normalize("NFC")) return false;
		return ![...entry].some((character) => {
			const point = character.codePointAt(0) ?? 0;
			return point <= 0x1f || (point >= 0x7f && point <= 0x9f) || (point >= 0xd800 && point <= 0xdfff);
		});
	};
	if (
		!exactKeys(record) ||
		record.schemaVersion !== 3 ||
		(record.state !== "claimed" && record.state !== "consumed") ||
		!hex(record.repoHash) ||
		!hex(record.keyHash) ||
		!admitChangeKeyOperands(record.changeKey) ||
		!hex(record.profileSetDigest) ||
		!hex(record.subjectDigest) ||
		!hex(record.historyDigest) ||
		!hex(record.basisDigest) ||
		typeof record.claimId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.claimId) ||
		!timestamp(record.createdAt) ||
		!timestamp(record.updatedAt) ||
		!object(record.basis, ["kind", "triggeringReviewState", "taxonomy", "invalidation", "diagnosisDigest"]) ||
		record.basis.kind !== "history-diagnosis" ||
		record.basis.invalidation !== "nothing" ||
		!["STAGNATION", "OSCILLATION", "INDETERMINATE"].includes(record.basis.taxonomy as string) ||
		!hex(record.basis.diagnosisDigest) ||
		!object(record.basis.triggeringReviewState, ["head", "historyIndex", "stateDigest"]) ||
		typeof record.basis.triggeringReviewState.head !== "string" ||
		!/^[0-9a-f]{40}$/.test(record.basis.triggeringReviewState.head) ||
		!Number.isSafeInteger(record.basis.triggeringReviewState.historyIndex) ||
		(record.basis.triggeringReviewState.historyIndex as number) < 0 ||
		!hex(record.basis.triggeringReviewState.stateDigest) ||
		!object(record.modes, ["mergeMode", "decisionMode", "mergeSource", "decisionSource"]) ||
		!["off", "on"].includes(record.modes.mergeMode as string) ||
		record.modes.decisionMode !== "autonomous" ||
		!source(record.modes.mergeSource) ||
		!source(record.modes.decisionSource) ||
		!["stagnation", "oscillation", "indeterminate"].includes(record.route as string)
	)
		return false;
	const routeMatchesTaxonomy =
		record.route === "stagnation"
			? record.basis.taxonomy === "STAGNATION"
			: record.route === "oscillation"
				? record.basis.taxonomy === "OSCILLATION"
				: record.basis.taxonomy === "INDETERMINATE";
	if (!routeMatchesTaxonomy) return false;
	if (record.state === "claimed")
		return (
			record.createdAt === record.updatedAt &&
			Array.isArray(record.attempts) &&
			record.attempts.length === 0 &&
			record.completeness === null &&
			record.sequenceAuthority === null &&
			record.selectedIntervention === null &&
			record.measurement === null &&
			record.freshRuling === null &&
			record.reentry === "nothing" &&
			record.nextGate === null &&
			record.terminal === null &&
			record.cause === null
		);
	if (!timestamp(record.updatedAt) || (record.updatedAt as string) <= (record.createdAt as string)) return false;
	if (!validAttempts(record.attempts)) return false;
	const routeHead = record.attempts[0]?.expectedHead;
	if (routeHead !== undefined && record.attempts.some((attempt) => attempt.expectedHead !== routeHead)) return false;
	const required =
		record.route === "stagnation"
			? ["stagnation-root", "stagnation-blast-radius", "recovery-selector"]
			: ["recovery-selector", "recovery-measurement", "recovery-diagnosis"];
	const attemptGroups = new Map<string, Record<string, unknown>[]>();
	for (const attempt of record.attempts) {
		const group = attemptGroups.get(attempt.profileId as string) ?? [];
		group.push(attempt);
		attemptGroups.set(attempt.profileId as string, group);
	}
	if (
		[...attemptGroups].some(
			([slot, group]) =>
				!required.includes(slot) ||
				group.length > 2 ||
				group.some((attempt) => attempt.profileSetDigest !== record.profileSetDigest) ||
				group.some(
					(attempt) =>
						attempt.profileSetDigest !== group[0]?.profileSetDigest ||
						attempt.materializationDigest !== group[0]?.materializationDigest ||
						attempt.expectedHead !== group[0]?.expectedHead,
				) ||
				(group.length === 2 &&
					!((attempt: AttemptRecord) =>
						attempt.diagnostic.run.class === "exited" &&
						Number.isInteger(attempt.diagnostic.run.exitCode) &&
						attempt.diagnostic.return.class === "missing" &&
						attempt.admission === "not-admitted")(group[0] as unknown as AttemptRecord)),
		)
	)
		return false;
	const retainedDigest = (slot: string): unknown =>
		attemptGroups.get(slot)?.find((attempt) => attempt.admission === "retained")?.resultDigest;
	if (
		(record.selectedIntervention !== null && !validSelected(record.selectedIntervention)) ||
		(record.measurement !== null && !validMeasurement(record.measurement)) ||
		(record.freshRuling !== null && !validFreshRuling(record.freshRuling))
	)
		return false;
	const selected = record.selectedIntervention as SelectedIntervention | null;
	const measurement = record.measurement as RecoveryMeasurement | null;
	const freshRuling = record.freshRuling as FreshRuling | null;
	const retained = (slot: string): boolean =>
		attemptGroups.get(slot)?.some((attempt) => attempt.admission === "retained") ?? false;
	const completedBefore = (prerequisite: string, dependent: string): boolean => {
		const before = attemptGroups.get(prerequisite);
		const after = attemptGroups.get(dependent);
		if (after === undefined) return true;
		if (before === undefined) return false;
		return (
			Math.max(...before.map((attempt) => attempt.sequence as number)) <
				Math.min(...after.map((attempt) => attempt.sequence as number)) &&
			Math.max(...before.map((attempt) => attempt.finishedOffsetMs as number)) <=
				Math.min(...after.map((attempt) => attempt.startedOffsetMs as number))
		);
	};
	const orderIsCoherent =
		record.route === "stagnation"
			? !attemptGroups.has("recovery-selector") ||
				(retained("stagnation-root") &&
					retained("stagnation-blast-radius") &&
					completedBefore("stagnation-root", "recovery-selector") &&
					completedBefore("stagnation-blast-radius", "recovery-selector"))
			: (!attemptGroups.has("recovery-measurement") ||
					(retained("recovery-selector") && completedBefore("recovery-selector", "recovery-measurement"))) &&
				(!attemptGroups.has("recovery-diagnosis") ||
					(retained("recovery-measurement") && completedBefore("recovery-measurement", "recovery-diagnosis")));
	const outputsAreBound =
		record.route === "stagnation"
			? measurement === null &&
				freshRuling === null &&
				(selected === null ||
					(retainedDigest("stagnation-root") === selected.candidateDigests[0] &&
						retainedDigest("stagnation-blast-radius") === selected.candidateDigests[1] &&
						retainedDigest("recovery-selector") ===
							structuralDigest("gitjig-recovery-selection:v1", {
								selected: selected.slot,
								materiallyDifferent: true,
								evidence: selected.selectionEvidence,
							})))
			: selected === null &&
				(measurement === null ||
					(retainedDigest("recovery-selector") === measurement.specDigest &&
						retainedDigest("recovery-measurement") === measurement.resultDigest)) &&
				(freshRuling === null ||
					(measurement !== null && retainedDigest("recovery-diagnosis") === freshRuling.diagnosisDigest));
	const handoffShape =
		record.route === "stagnation"
			? record.cause === "recovery-failed" && record.reentry === "nothing" && record.nextGate === "park"
			: record.reentry === "authorization"
				? (record.cause === "authorization" || record.cause === "recovery-failed") &&
					record.nextGate === "authorization-handoff" &&
					freshRuling !== null &&
					freshRuling.diagnosis.invalidation === "authorization"
				: record.reentry === "plan"
					? record.cause === "recovery-failed" &&
						record.nextGate === "planning-handoff" &&
						freshRuling !== null &&
						freshRuling.diagnosis.invalidation === "plan"
					: record.cause === "recovery-failed" &&
						record.nextGate === "park" &&
						(freshRuling === null || freshRuling.diagnosis.invalidation === "nothing");
	const routeShape =
		orderIsCoherent &&
		outputsAreBound &&
		(record.terminal === "continue"
			? record.cause === null &&
				canonicalJson(
					required.filter((slot) => attemptGroups.get(slot)?.some((attempt) => attempt.admission === "retained")),
				) === canonicalJson(required) &&
				(record.route === "stagnation"
					? record.reentry === "nothing" &&
						record.nextGate === "author-repair" &&
						selected !== null &&
						validSelected(selected) &&
						retainedDigest("stagnation-root") === selected.candidateDigests[0] &&
						retainedDigest("stagnation-blast-radius") === selected.candidateDigests[1] &&
						retainedDigest("recovery-selector") ===
							structuralDigest("gitjig-recovery-selection:v1", {
								selected: selected.slot,
								materiallyDifferent: true,
								evidence: selected.selectionEvidence,
							}) &&
						record.measurement === null &&
						record.freshRuling === null
					: selected === null &&
						measurement !== null &&
						freshRuling !== null &&
						validMeasurement(measurement) &&
						validFreshRuling(freshRuling) &&
						(record.freshRuling as { diagnosis: { value: unknown } }).diagnosis.value === "NONE" &&
						(record.freshRuling as { diagnosis: { invalidation: unknown } }).diagnosis.invalidation ===
							record.reentry &&
						["nothing", "plan"].includes(record.reentry as string) &&
						record.nextGate === (record.reentry === "nothing" ? "ordinary-flow" : "planning") &&
						retainedDigest("recovery-selector") === measurement.specDigest &&
						retainedDigest("recovery-measurement") === measurement.resultDigest &&
						retainedDigest("recovery-diagnosis") === freshRuling.diagnosisDigest)
			: record.terminal === "handoff" && handoffShape);
	return (
		routeShape &&
		object(record.completeness, ["requiredSlots", "admittedSlots"]) &&
		Array.isArray(record.completeness.requiredSlots) &&
		Array.isArray(record.completeness.admittedSlots) &&
		canonicalJson(record.completeness.requiredSlots) === canonicalJson(required) &&
		canonicalJson(record.completeness.admittedSlots) ===
			canonicalJson(
				required.filter((slot) => attemptGroups.get(slot)?.some((attempt) => attempt.admission === "retained")),
			) &&
		object(record.sequenceAuthority, ["source", "lastSequence", "retrySlots"]) &&
		record.sequenceAuthority.source === "host-attempt-order" &&
		Number.isSafeInteger(record.sequenceAuthority.lastSequence) &&
		record.sequenceAuthority.lastSequence === record.attempts.length &&
		Array.isArray(record.sequenceAuthority.retrySlots) &&
		record.completeness.requiredSlots.every((slot) => typeof slot === "string") &&
		record.completeness.admittedSlots.every((slot) => typeof slot === "string") &&
		record.sequenceAuthority.retrySlots.every((slot) => typeof slot === "string") &&
		canonicalJson(record.sequenceAuthority.retrySlots) ===
			canonicalJson(required.filter((slot) => attemptGroups.get(slot)?.length === 2)) &&
		["nothing", "plan", "authorization"].includes(record.reentry as string) &&
		["author-repair", "ordinary-flow", "planning", "park", "planning-handoff", "authorization-handoff"].includes(
			record.nextGate as string,
		) &&
		["continue", "handoff"].includes(record.terminal as string) &&
		(record.cause === null ||
			["allowance-consumed", "recovery-failed", "authorization"].includes(record.cause as string))
	);
}

function immutableRecordDigest(record: ClaimedRecordV3 | ConsumedRecordV3): string {
	return canonicalJson({
		schemaVersion: record.schemaVersion,
		repoHash: record.repoHash,
		keyHash: record.keyHash,
		changeKey: record.changeKey,
		claimId: record.claimId,
		createdAt: record.createdAt,
		profileSetDigest: record.profileSetDigest,
		subjectDigest: record.subjectDigest,
		historyDigest: record.historyDigest,
		basisDigest: record.basisDigest,
		basis: record.basis,
		modes: record.modes,
		route: record.route,
	});
}

function recordBytes(record: ClaimedRecordV3 | ConsumedRecordV3): Buffer | undefined {
	try {
		if (!coreRecord(record)) return undefined;
		const bytes = Buffer.from(canonicalJson(record), "utf8");
		return bytes.length <= RECORD_LIMIT ? bytes : undefined;
	} catch {
		return undefined;
	}
}

function safeFileStat(path: string, fd: number): ReturnType<typeof fstatSync> | undefined {
	try {
		const before = lstatSync(path);
		const after = fstatSync(fd);
		const uid = effectiveUid();
		if (
			!before.isFile() ||
			!after.isFile() ||
			before.isSymbolicLink() ||
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			after.nlink !== 1 ||
			(after.mode & 0o7777) !== FILE_MODE ||
			(uid !== undefined && after.uid !== uid)
		)
			return undefined;
		return after;
	} catch {
		return undefined;
	}
}

function refFromBytes(bytes: Buffer, repoHash: string, keyHash: string): RecordRef | undefined {
	if (bytes.length > RECORD_LIMIT) return undefined;
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		const parsed: unknown = JSON.parse(text);
		if (!coreRecord(parsed) || canonicalJson(parsed) !== text) return undefined;
		if (parsed.repoHash !== repoHash || parsed.keyHash !== keyHash) return undefined;
		return { repoHash, keyHash, claimId: parsed.claimId as string };
	} catch {
		return undefined;
	}
}

function readBounded(fd: number): Buffer | undefined {
	const bytes = Buffer.allocUnsafe(RECORD_LIMIT + 1);
	let offset = 0;
	while (offset < bytes.length) {
		const count = readSync(fd, bytes, offset, bytes.length - offset, null);
		if (count === 0) break;
		offset += count;
	}
	return offset > RECORD_LIMIT ? undefined : bytes.subarray(0, offset);
}

function existing(path: string, repoHash: string, keyHash: string): RecordRef | undefined {
	let fd: number | undefined;
	try {
		const leaf = lstatSync(path);
		if (!leaf.isFile() || leaf.isSymbolicLink()) return undefined;
		fd = openSync(path, READ_FLAGS);
		const first = safeFileStat(path, fd);
		if (first === undefined || first.size > RECORD_LIMIT) return undefined;
		const bytes = readBounded(fd);
		const second = fstatSync(fd);
		if (bytes === undefined || first.dev !== second.dev || first.ino !== second.ino || first.size !== second.size)
			return undefined;
		return refFromBytes(bytes, repoHash, keyHash);
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined)
			try {
				closeSync(fd);
			} catch {}
	}
}

function writeComplete(fd: number, bytes: Buffer): void {
	let offset = 0;
	while (offset < bytes.length) {
		const written = writeSync(fd, bytes, offset, bytes.length - offset);
		if (written <= 0) throw new Error("allowance write made no progress");
		offset += written;
	}
}

function syncDirectory(path: string): void {
	const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function claimAllowance(input: { subject: ReviewSubject; record: ClaimedRecordV3 }): ClaimAllowanceResult {
	const encoding = deriveAllowancePathEncoding(input.subject);
	if (
		encoding === undefined ||
		input.record.repoHash !== encoding.repoHash ||
		input.record.keyHash !== encoding.keyHash ||
		canonicalJson(input.record.changeKey) !== canonicalJson(encoding.operands)
	)
		return { status: "preclaim-refused", cause: "identity" };
	const bytes = recordBytes(input.record);
	if (bytes === undefined || input.record.state !== "claimed") return { status: "preclaim-refused", cause: "identity" };
	const recoveryDir = resolveRecoveryStateDomain();
	if (recoveryDir === undefined) return { status: "preclaim-refused", cause: "state-domain" };
	const path = join(recoveryDir, encoding.leaf);
	try {
		lstatSync(path);
		const recordRef = existing(path, encoding.repoHash, encoding.keyHash);
		return { status: "consumed", cause: "existing", ...(recordRef === undefined ? {} : { recordRef }) };
	} catch (error) {
		if ((error as { code?: string }).code !== "ENOENT") return { status: "preclaim-refused", cause: "state-domain" };
	}
	let fd: number | undefined;
	let created = false;
	try {
		fd = openSync(path, CLAIM_FLAGS, FILE_MODE);
		created = true;
		const stat = safeFileStat(path, fd);
		if (stat === undefined) throw new Error("claimed leaf predicates failed");
		writeComplete(fd, bytes);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		syncDirectory(recoveryDir);
		const recordRef = { repoHash: encoding.repoHash, keyHash: encoding.keyHash, claimId: input.record.claimId };
		const claim: AllowanceClaim = Object.freeze({ [CLAIM]: true as const });
		claimStates.set(claim, {
			path,
			recoveryDir,
			claimedBytes: bytes,
			device: stat.dev,
			inode: stat.ino,
			recordRef,
			immutableDigest: immutableRecordDigest(input.record),
		});
		return { status: "claimed", claim, recordRef };
	} catch (error) {
		if (fd !== undefined)
			try {
				closeSync(fd);
			} catch {}
		if (!created && (error as { code?: string }).code === "EEXIST") {
			const recordRef = existing(path, encoding.repoHash, encoding.keyHash);
			return { status: "consumed", cause: "existing", ...(recordRef === undefined ? {} : { recordRef }) };
		}
		const code = (error as { code?: string }).code;
		if (!created && code !== undefined && DEFINITE_PRECREATE_ERRORS.has(code))
			return { status: "preclaim-refused", cause: "state-domain" };
		return {
			status: "consumed",
			cause: "create-or-write-ambiguous",
			recordRef: { repoHash: encoding.repoHash, keyHash: encoding.keyHash, claimId: input.record.claimId },
		};
	}
}

function finalizeAllowance(claim: AllowanceClaim, record: ConsumedRecordV3): FinalizeAllowanceResult {
	const state = claimStates.get(claim as object);
	const fallbackRef: RecordRef = { repoHash: record.repoHash, keyHash: record.keyHash, claimId: record.claimId };
	if (state === undefined || spent.has(claim as object) || claim[CLAIM] !== true)
		return { status: "consumed-unverified", recordRef: state?.recordRef ?? fallbackRef };
	spent.add(claim as object);
	const bytes = recordBytes(record);
	if (
		bytes === undefined ||
		record.state !== "consumed" ||
		record.repoHash !== state.recordRef.repoHash ||
		record.keyHash !== state.recordRef.keyHash ||
		record.claimId !== state.recordRef.claimId ||
		immutableRecordDigest(record) !== state.immutableDigest
	)
		return { status: "consumed-unverified", recordRef: state.recordRef };
	const resolved = resolveRecoveryStateDomain();
	if (resolved !== state.recoveryDir || dirname(state.path) !== resolved)
		return { status: "consumed-unverified", recordRef: state.recordRef };
	let readFd: number | undefined;
	try {
		readFd = openSync(state.path, READ_FLAGS);
		const stat = safeFileStat(state.path, readFd);
		if (stat === undefined || stat.dev !== state.device || stat.ino !== state.inode)
			throw new Error("claim identity drift");
		const current = readBounded(readFd);
		if (current === undefined || !current.equals(state.claimedBytes)) throw new Error("claim bytes drift");
		closeSync(readFd);
		readFd = undefined;
		const temporary = join(resolved, `.gitjig-recovery-${randomUUID()}.tmp`);
		let tempFd: number | undefined;
		let temporaryRenamed = false;
		try {
			tempFd = openSync(temporary, CLAIM_FLAGS, FILE_MODE);
			if (safeFileStat(temporary, tempFd) === undefined) throw new Error("terminal temp predicates failed");
			writeComplete(tempFd, bytes);
			fsyncSync(tempFd);
			closeSync(tempFd);
			tempFd = undefined;
			renameSync(temporary, state.path);
			temporaryRenamed = true;
			syncDirectory(resolved);
			const finalFd = openSync(state.path, READ_FLAGS);
			try {
				const finalBytes = readBounded(finalFd);
				if (safeFileStat(state.path, finalFd) === undefined || finalBytes === undefined || !finalBytes.equals(bytes))
					throw new Error("terminal predicates failed");
			} finally {
				closeSync(finalFd);
			}
			return { status: "finalized", recordRef: state.recordRef };
		} finally {
			if (tempFd !== undefined)
				try {
					closeSync(tempFd);
				} catch {}
			if (!temporaryRenamed) {
				try {
					unlinkSync(temporary);
				} catch {}
				try {
					syncDirectory(resolved);
				} catch {}
			}
		}
	} catch {
		return { status: "consumed-unverified", recordRef: state.recordRef };
	} finally {
		if (readFd !== undefined)
			try {
				closeSync(readFd);
			} catch {}
	}
}

const ATTEMPT_BOUND_MS = 600_000;
const SLOT_OPERATION_MS = 1_200_000;
const SLOT_RESERVE_MS = 1_260_000;
const RETRY_REMAINING_MS = 660_000;
const ROUTE_WORK_MS = 3_780_000;
const ROUTE_TERMINAL_MS = 3_840_000;
const MAX_RETAINED_RECORD_BYTES = 192 * 1024;

type RecoveryDispatchResult = ObservedDispatchOutcome;
export type RecoveryProfileDispatcher = ((
	ledger: HostAttemptLedger,
	profileId: PhaseAProfileId,
	semanticBrief: RecoverySemanticBrief,
	expectedHead: string,
	operationDeadline: number,
	role?: RecoveryPiRole,
	specDigest?: string,
) => Promise<RecoveryDispatchResult>) & {
	/**
	 * The transport the caller selected for this dispatcher, declared by its
	 * own producer. The coordinator reads it for one purpose: the ambient
	 * generic-executable preflight is the generic profile argv's gate, and an
	 * explicitly selected Pi dispatcher carries its own executable. An absent
	 * marker is the generic transport.
	 */
	readonly transport?: "generic" | "pi";
};

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
	/** Explicit caller-selected Pi mode. The coordinator fixes the route role. */
	pi?: Omit<PiInvocation, "role" | "specDigest">;
}): RecoveryProfileDispatcher {
	const dispatcher = async (
		ledger: HostAttemptLedger,
		profileId: PhaseAProfileId,
		semanticBrief: RecoverySemanticBrief,
		expectedHead: string,
		operationDeadline: number,
		role?: RecoveryPiRole,
		specDigest?: string,
	): Promise<RecoveryDispatchResult> => {
		if (input.pi !== undefined && role === undefined) throw Error("recovery Pi role unavailable from consumer");
		const loaded = loadRecoveryProfiles();
		const materialized = loaded === undefined ? undefined : materializeRecoveryProfile(loaded, profileId);
		if (materialized === undefined) throw new Error("recovery profile unavailable");
		const dispatch = makeDispatcher(
			{
				callerRepoRoot: input.repoRoot,
				stateRoot: input.stateRoot,
				delegateArgv: input.pi === undefined ? materialized.argv : [],
				...(input.pi === undefined || role === undefined ? {} : { pi: { ...input.pi, role, specDigest } }),
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
		return dispatch(input.pi === undefined ? semanticBrief : piRecoveryBrief(semanticBrief), expectedHead, role);
	};
	// The producer declares its own transport; the coordinator never infers it.
	return Object.assign(dispatcher, { transport: input.pi === undefined ? ("generic" as const) : ("pi" as const) });
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

/** Read-only consumer oracle for the Pi producer's accepted-set parity tests.
 * It delegates to this module's actual route parsers; no second grammar is minted. */
export function acceptsRecoveryPiPayload(
	role: "challenger" | "selector-contest" | "selector-measurement" | "measurement" | "diagnosis",
	value: unknown,
	specDigest?: string,
): boolean {
	if (role === "challenger") return challenger(value, "root") !== undefined;
	if (role === "selector-contest") return contest(value) !== undefined;
	if (role === "selector-measurement") return measurementSpec(value) !== undefined;
	if (role === "measurement") return specDigest !== undefined && measurementResult(value, specDigest) !== undefined;
	return diagnosis(value) !== undefined;
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
	// The preflight measures the ambient generic profile executable. Under an
	// explicitly selected Pi transport that executable is not the one the route
	// will run, so its absence or different help text must not hand this route
	// off; the Pi dispatcher's own parameters are refused at its own gate.
	const ambientPreflight = input.dispatchProfile.transport !== "pi";
	if (loaded === undefined || (ambientPreflight && !preflightRecoveryExecutable()))
		return handoff("profile-preflight", "nothing", null);
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
		changeKey: encoding.operands,
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
		specDigest?: string,
	): Promise<RecoveryDispatchResult | undefined> => {
		const piRole: RecoveryPiRole =
			profileId === "stagnation-root" || profileId === "stagnation-blast-radius"
				? "challenger"
				: profileId === "recovery-selector"
					? route === "stagnation"
						? "selector-contest"
						: "selector-measurement"
					: profileId === "recovery-measurement"
						? "measurement"
						: "diagnosis";
		const now = performance.now();
		if (routeDeadline - now < SLOT_RESERVE_MS) return undefined;
		try {
			const observed = await input.dispatchProfile(
				ledger,
				profileId,
				semanticBrief,
				input.subject.context.pullRequest.head.oid,
				now + SLOT_OPERATION_MS,
				piRole,
				specDigest,
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
			const measurementRun = await dispatch("recovery-measurement", measurementBrief(spec), specDigest);
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
		const refreshRemaining = routeDeadline - performance.now();
		if (refreshRemaining <= 0) return finalizeHandoff();
		let refreshTimer: ReturnType<typeof setTimeout> | undefined;
		let refreshed: RecoveryFreshness | undefined;
		try {
			const refreshDeadline = new Promise<undefined>((resolve) => {
				refreshTimer = setTimeout(() => resolve(undefined), refreshRemaining);
			});
			refreshed = await Promise.race([input.refreshPrecontinue(), refreshDeadline]);
		} finally {
			if (refreshTimer !== undefined) clearTimeout(refreshTimer);
		}
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

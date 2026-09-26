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
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { makeDiagnostic } from "../dispatch/diagnostics.ts";
import type { ReviewSubject } from "../review/subject.ts";
import { admitChangeKeyOperands, deriveAllowancePathEncoding } from "./lineage.ts";
import { resolveRecoveryStateDomain } from "./state-domain.ts";
import {
	type AttemptRecord,
	type ClaimedRecordV3,
	type ConsumedRecordV3,
	canonicalJson,
	contentDigest,
	type FreshRuling,
	type RecordRef,
	type RecoveryMeasurement,
	type SelectedIntervention,
	structuralDigest,
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

export type AllowanceClaim = { readonly [CLAIM]: true };
type ClaimState = {
	path: string;
	recoveryDir: string;
	claimedBytes: Buffer;
	device: number | bigint;
	inode: number | bigint;
	recordRef: RecordRef;
	immutableDigest: string;
};

export type ClaimAllowanceResult =
	| { status: "claimed"; claim: AllowanceClaim; recordRef: RecordRef }
	| { status: "preclaim-refused"; cause: "state-domain" | "identity" }
	| { status: "consumed"; cause: "existing" | "create-or-write-ambiguous"; recordRef?: RecordRef };
export type FinalizeAllowanceResult =
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
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
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
	if (value !== value.normalize("NFC")) return false;
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
			(after.mode & 0o777) !== FILE_MODE ||
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

export function claimAllowance(input: { subject: ReviewSubject; record: ClaimedRecordV3 }): ClaimAllowanceResult {
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

export function finalizeAllowance(claim: AllowanceClaim, record: ConsumedRecordV3): FinalizeAllowanceResult {
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
		try {
			tempFd = openSync(temporary, CLAIM_FLAGS, FILE_MODE);
			if (safeFileStat(temporary, tempFd) === undefined) throw new Error("terminal temp predicates failed");
			writeComplete(tempFd, bytes);
			fsyncSync(tempFd);
			closeSync(tempFd);
			tempFd = undefined;
			renameSync(temporary, state.path);
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

/**
 * Inert durable shape for a §1.4 diagnosis after its triggering review state.
 *
 * Warning-surface roster: EXEMPT — this module only composes and parses
 * machine data. Publication and writer attestation are separate boundaries.
 */
import { createHash } from "node:crypto";
import type { DiagnosisInput, StateSummary } from "./history.ts";
import { DIAGNOSIS_VALUES, INVALIDATIONS } from "./history.ts";
import { inertJsonStrings } from "./record.ts";
import { admitPlatformReviewContext, type PlatformReviewContext } from "./subject.ts";

export const DIAGNOSIS_RECORD_MARKER = "gitjig-diagnosis-record";

export interface DiagnosisRecord {
	subject: {
		repositoryId: string;
		pullRequestId: string;
		headOid: string;
	};
	historyHeads: string[];
	historyDigest: string;
	diagnosis: DiagnosisInput;
}

const OID = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		Object.keys(value).every((key) => keys.includes(key))
	);
}

function diagnosis(value: unknown): value is DiagnosisInput {
	return (
		object(value, ["value", "invalidation", "evidence"]) &&
		typeof value.value === "string" &&
		DIAGNOSIS_VALUES.some((entry) => entry === value.value) &&
		typeof value.invalidation === "string" &&
		INVALIDATIONS.some((entry) => entry === value.invalidation) &&
		typeof value.evidence === "string" &&
		value.evidence.length > 0
	);
}

export function admitDiagnosisRecord(value: unknown): DiagnosisRecord | undefined {
	if (!object(value, ["subject", "historyHeads", "historyDigest", "diagnosis"])) return undefined;
	if (
		!object(value.subject, ["repositoryId", "pullRequestId", "headOid"]) ||
		typeof value.subject.repositoryId !== "string" ||
		value.subject.repositoryId.length === 0 ||
		typeof value.subject.pullRequestId !== "string" ||
		value.subject.pullRequestId.length === 0 ||
		typeof value.subject.headOid !== "string" ||
		!OID.test(value.subject.headOid) ||
		!Array.isArray(value.historyHeads) ||
		value.historyHeads.length < 2 ||
		!value.historyHeads.every((head) => typeof head === "string" && OID.test(head)) ||
		new Set(value.historyHeads).size !== value.historyHeads.length ||
		value.historyHeads.at(-1) !== value.subject.headOid ||
		typeof value.historyDigest !== "string" ||
		!SHA256.test(value.historyDigest) ||
		!diagnosis(value.diagnosis)
	)
		return undefined;
	return structuredClone(value) as unknown as DiagnosisRecord;
}

/** Bind subject and the complete triggering post-state history in one record. */
export function createDiagnosisRecord(
	context: PlatformReviewContext,
	history: readonly StateSummary[],
	input: DiagnosisInput,
): DiagnosisRecord | undefined {
	const subject = admitPlatformReviewContext(context);
	if (subject === undefined) return undefined;
	return admitDiagnosisRecord({
		subject: {
			repositoryId: subject.repository.id,
			pullRequestId: subject.pullRequest.id,
			headOid: subject.pullRequest.head.oid,
		},
		historyHeads: history.map((state) => state.head),
		historyDigest: createHash("sha256").update(JSON.stringify(history)).digest("hex"),
		diagnosis: input,
	});
}

export function composeDiagnosisRecord(record: DiagnosisRecord): string {
	const admitted = admitDiagnosisRecord(record);
	if (admitted === undefined) throw new Error("diagnosis record is not admissible");
	return [
		"<!-- ",
		DIAGNOSIS_RECORD_MARKER,
		": ",
		admitted.subject.headOid,
		" -->\n\n```json\n",
		inertJsonStrings(JSON.stringify(admitted, null, "\t")),
		"\n```\n",
	].join("");
}

export function parseDiagnosisRecord(body: string): DiagnosisRecord | undefined {
	const opening = ["<!-- ", DIAGNOSIS_RECORD_MARKER, ": "].join("");
	if (!body.startsWith(opening)) return undefined;
	const markerEnd = body.indexOf(" -->\n\n```json\n");
	if (markerEnd < opening.length || !body.endsWith("\n```\n")) return undefined;
	const markerHead = body.slice(opening.length, markerEnd);
	try {
		const parsed = admitDiagnosisRecord(
			JSON.parse(body.slice(markerEnd + " -->\n\n```json\n".length, -"\n```\n".length)),
		);
		return parsed?.subject.headOid === markerHead ? parsed : undefined;
	} catch {
		return undefined;
	}
}

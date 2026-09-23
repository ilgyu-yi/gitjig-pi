/**
 * Closed return-slot admission (§4.9). lstat precedes every read so links,
 * FIFOs, devices and directories refuse without being followed or opened;
 * the whole regular file is bounded before and after reading, decoded as
 * fatal UTF-8, parsed as JSON, and checked against the exact schema. Each
 * failure retains its dispatcher-owned class and fixed message. Delegate
 * streams are never an input to this module.
 */
import { lstatSync, readFileSync, type Stats } from "node:fs";
import { DIAGNOSTIC_MESSAGES, type ReturnClass } from "./diagnostics.ts";

export const RETURN_LIMIT_BYTES = 65_536;

export const REFUSAL_CAUSES = {
	delegateAbsent: DIAGNOSTIC_MESSAGES.SPAWN_FAILED,
	boundExceeded: DIAGNOSTIC_MESSAGES.TIMED_OUT,
	aborted: DIAGNOSTIC_MESSAGES.ABORTED,
	missingReturn: DIAGNOSTIC_MESSAGES.RETURN_MISSING,
	malformedReturn: DIAGNOSTIC_MESSAGES.RETURN_SCHEMA_INVALID,
	operandNamed: DIAGNOSTIC_MESSAGES.RETURN_OPERAND_REJECTED,
} as const;

const RETURN_CAUSES = {
	missing: REFUSAL_CAUSES.missingReturn,
	"not-regular": DIAGNOSTIC_MESSAGES.RETURN_NOT_REGULAR,
	oversize: DIAGNOSTIC_MESSAGES.RETURN_OVERSIZE,
	unreadable: DIAGNOSTIC_MESSAGES.RETURN_UNREADABLE,
	"json-invalid": DIAGNOSTIC_MESSAGES.RETURN_JSON_INVALID,
	"schema-invalid": REFUSAL_CAUSES.malformedReturn,
	"operand-rejected": REFUSAL_CAUSES.operandNamed,
} as const;

type InvalidReturnClass = Exclude<ReturnClass, "not-inspected" | "admitted">;
export type ReturnAdmission =
	| { admitted: true; class: "admitted"; ok: boolean; summary: string; reviewedHead?: string; payload?: string }
	| { admitted: false; class: InvalidReturnClass; cause: string };

const SCHEMA_KEYS = new Set(["ok", "summary", "reviewedHead", "payload"]);
const refused = (classification: InvalidReturnClass): ReturnAdmission => ({
	admitted: false,
	class: classification,
	cause: RETURN_CAUSES[classification],
});

export function admitReturn(returnPath: string): ReturnAdmission {
	let stat: Stats;
	try {
		stat = lstatSync(returnPath);
	} catch {
		return refused("missing");
	}
	if (!stat.isFile()) return refused("not-regular");
	if (stat.size > RETURN_LIMIT_BYTES) return refused("oversize");
	let raw: Buffer;
	try {
		raw = readFileSync(returnPath);
	} catch {
		return refused("unreadable");
	}
	if (raw.byteLength > RETURN_LIMIT_BYTES) return refused("oversize");
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
	} catch {
		return refused("json-invalid");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return refused("schema-invalid");
	if (Object.keys(parsed).some((key) => !SCHEMA_KEYS.has(key))) return refused("schema-invalid");
	const { ok, summary, reviewedHead, payload } = parsed as Record<string, unknown>;
	if (typeof ok !== "boolean" || typeof summary !== "string") return refused("schema-invalid");
	if (reviewedHead !== undefined && typeof reviewedHead !== "string") return refused("schema-invalid");
	if (payload !== undefined && typeof payload !== "string") return refused("schema-invalid");
	return {
		admitted: true,
		class: "admitted",
		ok,
		summary,
		...(reviewedHead === undefined ? {} : { reviewedHead }),
		...(payload === undefined ? {} : { payload }),
	};
}

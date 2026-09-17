import { lstatSync, readFileSync, type Stats } from "node:fs";
import type { ReturnClass } from "./diagnostics.ts";

export const RETURN_LIMIT_BYTES = 65_536;

/** Compatibility keys remain until #266 removes the old retry consumer. */
export const REFUSAL_CAUSES = {
	delegateAbsent: "dispatch refused: the delegate could not be started; no return was inspected",
	failedRun: "dispatch refused: the delegated run reported failure; no return is admitted from a failed run",
	boundExceeded: "dispatch refused: the delegate exceeded its run bound; no return was inspected",
	aborted: "dispatch refused: the delegate run was aborted; no return was inspected",
	missingReturn: "dispatch refused: no return file was present after the delegate exited",
	malformedReturn: "dispatch refused: the return did not match the closed schema",
	operandNamed: "dispatch refused: the return named a caller-held operand",
} as const;

const RETURN_CAUSES = {
	missing: REFUSAL_CAUSES.missingReturn,
	"not-regular": "dispatch refused: the return slot was not a regular file",
	oversize: "dispatch refused: the return exceeded the 65536-byte bound",
	unreadable: "dispatch refused: the return could not be read exactly",
	"json-invalid": "dispatch refused: the return was not valid UTF-8 JSON",
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

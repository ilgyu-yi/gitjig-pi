/**
 * Closed return-slot admission (§4.9). Non-regular leaves are rejected before
 * open; a no-follow descriptor is then bounded and identity/metadata-stable
 * across the complete read. Delegate streams are never an input here.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
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
export type ReturnSnapshot = { ok: true; bytes: Buffer } | { ok: false; admission: ReturnAdmission };

const SCHEMA_KEYS = new Set(["ok", "summary", "reviewedHead", "payload"]);
const refused = (classification: InvalidReturnClass): ReturnAdmission => ({
	admitted: false,
	class: classification,
	cause: RETURN_CAUSES[classification],
});
const same = (left: Stats, right: Stats): boolean =>
	left.isFile() &&
	right.isFile() &&
	left.dev === right.dev &&
	left.ino === right.ino &&
	left.uid === right.uid &&
	(left.mode & 0o7777) === (right.mode & 0o7777) &&
	left.size === right.size;

export function readReturnSnapshot(returnPath: string): ReturnSnapshot {
	let before: Stats;
	try {
		before = lstatSync(returnPath);
	} catch {
		return { ok: false, admission: refused("missing") };
	}
	if (!before.isFile()) return { ok: false, admission: refused("not-regular") };
	if (before.size > RETURN_LIMIT_BYTES) return { ok: false, admission: refused("oversize") };
	let fd: number | undefined;
	try {
		fd = openSync(returnPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		const opened = fstatSync(fd);
		if (!same(before, opened)) return { ok: false, admission: refused("unreadable") };
		const bytes = Buffer.alloc(RETURN_LIMIT_BYTES + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(fd, bytes, offset, bytes.length - offset, null);
			if (count === 0) break;
			offset += count;
		}
		if (offset > RETURN_LIMIT_BYTES) return { ok: false, admission: refused("oversize") };
		const afterDescriptor = fstatSync(fd);
		const afterPath = lstatSync(returnPath);
		if (!same(opened, afterDescriptor) || !same(afterDescriptor, afterPath) || offset !== afterDescriptor.size)
			return { ok: false, admission: refused("unreadable") };
		return { ok: true, bytes: bytes.subarray(0, offset) };
	} catch {
		return { ok: false, admission: refused("unreadable") };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function admitReturnBytes(raw: Buffer): ReturnAdmission {
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

export function admitReturn(returnPath: string): ReturnAdmission {
	const snapshot = readReturnSnapshot(returnPath);
	return snapshot.ok ? admitReturnBytes(snapshot.bytes) : snapshot.admission;
}

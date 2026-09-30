/**
 * The sanctioned retained-trace reader (SPEC §4.9 *The sanctioned
 * retained-trace reader*, #263). It reads one completed record the landed
 * writer (`trace.ts`'s `retainTrace`) already keeps, by its identifier, and
 * returns the operator-only rendering or one of two fixed non-rendered
 * outcomes. It never lists the directory, never writes, prunes or locks,
 * and no outcome changes any dispatch, admission, comparison or workflow
 * decision.
 *
 * Warning-surface roster: EXEMPT — the rendered text reaches only the
 * `/dispatch-trace` terminal component; the notices are fixed literals.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { join } from "node:path";
import { STATE_PATH_GUARD_FLAGS, sinkRefusal } from "../audit.ts";
import {
	renderTraceSnapshot,
	TRACE_DIRECTORY,
	TRACE_LINES,
	TRACE_RENDER_CODEPOINTS,
	TRACE_RETAIN_MS,
	type TraceSnapshot,
} from "./trace.ts";

/** SPEC §4.9: the largest record the reader reads. */
export const TRACE_READ_BYTES = 256 * 1024;

/** The canonical identifier: a safe-integer millisecond count without a leading zero, a hyphen, a lowercase v4 UUID. */
const IDENTIFIER = /^(0|[1-9][0-9]*)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function canonicalTraceId(value: string): boolean {
	const match = IDENTIFIER.exec(value);
	return match !== null && Number.isSafeInteger(Number(match[1]));
}

export type TraceRead = { outcome: "rendered"; text: string } | { outcome: "missing" } | { outcome: "unavailable" };

const TERMINAL = new Set(["completed", "failed", "aborted", "timed-out", "spawn-failed"]);
const COUNTERS = [
	"stdoutBytes",
	"stderrBytes",
	"stdoutLines",
	"stderrLines",
	"truncatedLines",
	"evictedLines",
	"decodeReplacements",
] as const;

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** The closed trace-snapshot schema, with only the five terminal classes. */
function terminalSnapshot(value: unknown): TraceSnapshot | undefined {
	if (!exactKeys(value, ["lifecycle", "lines", "counters"])) return undefined;
	if (typeof value.lifecycle !== "string" || !TERMINAL.has(value.lifecycle)) return undefined;
	const { lines, counters } = value;
	if (!Array.isArray(lines) || lines.length > TRACE_LINES) return undefined;
	for (const line of lines) {
		if (!exactKeys(line, ["stream", "text", "truncated"])) return undefined;
		if (line.stream !== "stdout" && line.stream !== "stderr") return undefined;
		if (typeof line.text !== "string" || [...line.text].length > TRACE_RENDER_CODEPOINTS) return undefined;
		if (typeof line.truncated !== "boolean") return undefined;
	}
	if (!exactKeys(counters, COUNTERS)) return undefined;
	for (const key of COUNTERS) {
		const count = counters[key];
		if (!Number.isSafeInteger(count) || (count as number) < 0) return undefined;
	}
	return value as unknown as TraceSnapshot;
}

/** The writer's own directory rule: a real directory, not a symlink, with no group or other bits. */
function safeDirectory(stats: Stats): boolean {
	return stats.isDirectory() && !stats.isSymbolicLink() && (stats.mode & 0o077) === 0;
}

/** The inode a path names now, or undefined when nothing is there; any other failure throws. */
function namedAt(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

function errorCode(error: unknown): unknown {
	return error instanceof Error && "code" in error ? error.code : undefined;
}

/** Read at most `limit + 1` bytes from an open descriptor, so an oversize file is known without reading it all. */
function readBounded(fd: number, limit: number): Buffer {
	const buffer = Buffer.alloc(limit + 1);
	let length = 0;
	while (length < buffer.length) {
		const read = readSync(fd, buffer, length, buffer.length - length, null);
		if (read === 0) break;
		length += read;
	}
	return buffer.subarray(0, length);
}

/**
 * Read one retained record in SPEC §4.9's fixed order. The caller has
 * already checked the mode and the token; this re-validates the token so
 * no path is ever derived from a non-canonical value.
 */
export function readRetainedTrace(
	stateRoot: string,
	id: string,
	now: number = Date.now(),
	/**
	 * Test seams at the two interleavings the contract names: between the
	 * directory check and the open, and between the open and the sink check.
	 */
	hooks: { beforeOpen?: () => void; afterOpen?: () => void; afterSink?: () => void } = {},
): TraceRead {
	if (!canonicalTraceId(id)) return { outcome: "unavailable" };
	// Expiry is decided before any state read, even for an unpruned record.
	if (now - Number(id.slice(0, id.indexOf("-"))) > TRACE_RETAIN_MS) return { outcome: "missing" };
	const directory = join(stateRoot, TRACE_DIRECTORY);
	let checked: Stats;
	try {
		checked = lstatSync(directory);
		if (!safeDirectory(checked)) return { outcome: "unavailable" };
	} catch (error) {
		// The writer creates the directory only on its first retention.
		return errorCode(error) === "ENOENT" ? { outcome: "missing" } : { outcome: "unavailable" };
	}
	const path = join(directory, `${id}.json`);
	let fd: number;
	try {
		hooks.beforeOpen?.();
		fd = openSync(path, constants.O_RDONLY | STATE_PATH_GUARD_FLAGS);
	} catch (error) {
		return errorCode(error) === "ENOENT" ? { outcome: "missing" } : { outcome: "unavailable" };
	}
	try {
		hooks.afterOpen?.();
		// A prune that unlinked the record after the open leaves it no name; the
		// shared sink rule's one-name check then makes it unavailable (§4.9, #395).
		const stats = fstatSync(fd);
		if (sinkRefusal(stats, path) !== undefined) return { outcome: "unavailable" };
		hooks.afterSink?.();
		// O_NOFOLLOW guards only the last component. The checked directory and
		// the opened record must still be what the paths name after the open, so
		// a directory swapped for a symlink between the check and the open, which
		// the open would follow, reads unavailable. RESIDUAL, stated: a swap and a
		// restore that both complete between these reads are not observable by
		// path reads. This reader draws no sandbox line inside one account (#263
		// non-goal; SPEC §5.5's same-account boundary).
		const after = lstatSync(directory);
		if (!safeDirectory(after) || after.dev !== checked.dev || after.ino !== checked.ino)
			return { outcome: "unavailable" };
		// A path that no longer names anything is a prune that followed the sink
		// check's one-name observation, which still renders (§4.9, #395); a path
		// that names another inode is a substitution, which never does.
		const named = namedAt(path);
		if (named !== undefined && (named.dev !== stats.dev || named.ino !== stats.ino)) return { outcome: "unavailable" };
		// Bounded by bytes actually read, so a file that grows after the stat is still refused.
		const bytes = readBounded(fd, TRACE_READ_BYTES);
		if (bytes.length > TRACE_READ_BYTES) return { outcome: "unavailable" };
		const snapshot = terminalSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
		if (snapshot === undefined) return { outcome: "unavailable" };
		return { outcome: "rendered", text: renderRetainedTrace(id, snapshot) };
	} catch {
		return { outcome: "unavailable" };
	} finally {
		try {
			closeSync(fd);
		} catch {}
	}
}

/** At most 23 lines: the identifier, the landed inert rendering, and the counters in the audit wording. */
export function renderRetainedTrace(id: string, snapshot: TraceSnapshot): string {
	const c = snapshot.counters;
	const counters = `stdout-bytes=${c.stdoutBytes}; stderr-bytes=${c.stderrBytes}; stdout-lines=${c.stdoutLines}; stderr-lines=${c.stderrLines}; truncated-lines=${c.truncatedLines}; evicted-lines=${c.evictedLines}; decode-replacements=${c.decodeReplacements}`;
	return `trace ${id}\n${renderTraceSnapshot(snapshot)}\n${counters}`;
}

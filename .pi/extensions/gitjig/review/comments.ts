/** Bounded platform reader for review records posted as PR comments. */
import { spawn } from "node:child_process";
import { withoutPlatformRetargetingEnv } from "../dispatch/provision.ts";
import type { CommentLookup } from "./merge-gate.ts";
import { parseReviewRecord, REVIEW_RECORD_MARKER, type ReviewRecord } from "./record.ts";

const COMMENT_READ_TIMEOUT_MS = 10_000;
const COMMENT_READ_GRACE_MS = 2_000;
const COMMENT_READ_MAX_BYTES = 4 * 1024 * 1024;

export interface CommentReadBounds {
	timeoutMs: number;
	graceMs: number;
	maxBytes: number;
}

type CommentRead = (argv: string[], repoRoot: string) => Promise<string | undefined>;

function killGroup(child: ReturnType<typeof spawn>): void {
	if (typeof child.pid === "number") {
		try {
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {
			// Fall through when no detached process group was formed.
		}
	}
	child.kill("SIGKILL");
}

/** Hard-bound the process group and the admitted stdout population. */
export function runCommentRead(
	argv: string[],
	repoRoot: string,
	bounds: CommentReadBounds = {
		timeoutMs: COMMENT_READ_TIMEOUT_MS,
		graceMs: COMMENT_READ_GRACE_MS,
		maxBytes: COMMENT_READ_MAX_BYTES,
	},
): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		let output = "";
		let bytes = 0;
		const child = spawn("gh", argv, {
			cwd: repoRoot,
			detached: true,
			env: withoutPlatformRetargetingEnv(process.env),
			stdio: ["ignore", "pipe", "pipe"],
		});
		const settle = (value: string | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(runTimer);
			if (graceTimer !== undefined) clearTimeout(graceTimer);
			child.stdout.destroy();
			child.stderr.destroy();
			child.unref();
			resolve(value);
		};
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const terminate = (): void => {
			killGroup(child);
			graceTimer = setTimeout(() => settle(undefined), bounds.graceMs);
		};
		const runTimer = setTimeout(terminate, bounds.timeoutMs);
		child.on("error", () => settle(undefined));
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > bounds.maxBytes) {
				terminate();
				return;
			}
			output += chunk.toString("utf8");
		});
		child.stderr.resume();
		child.on("exit", (code) => {
			clearTimeout(runTimer);
			if (settled) return;
			graceTimer = setTimeout(() => settle(code === 0 ? output : undefined), bounds.graceMs);
		});
		child.on("close", (code) => settle(code === 0 ? output : undefined));
	});
}

/** Read every comment page as one JSON value; child text never enters a failure result. */
export async function fetchReviewComments(
	repoRoot: string,
	pr: number,
	read: CommentRead = runCommentRead,
): Promise<CommentLookup> {
	let output: string | undefined;
	for (let attempt = 0; attempt < 2 && output === undefined; attempt += 1) {
		try {
			output = await read(
				["api", "--paginate", "--slurp", `repos/{owner}/{repo}/issues/${String(pr)}/comments`],
				repoRoot,
			);
		} catch {
			// One bounded retry absorbs a transient platform or child failure.
		}
	}
	if (output === undefined) return { ok: false, cause: "the bounded platform comment read failed" };
	try {
		const pages: unknown = JSON.parse(output);
		if (!Array.isArray(pages) || !pages.every(Array.isArray))
			return { ok: false, cause: "the platform comment response was not a page list" };
		const bodies: string[] = [];
		for (const page of pages) {
			for (const comment of page) {
				if (typeof comment !== "object" || comment === null || typeof (comment as { body?: unknown }).body !== "string")
					return { ok: false, cause: "the platform comment response carried an unreadable body" };
				bodies.push((comment as { body: string }).body);
			}
		}
		return { ok: true, bodies };
	} catch {
		return { ok: false, cause: "the platform comment response was not JSON" };
	}
}

/** Marker claims fail closed: one malformed marked body makes history unreadable. */
export function recordsFromComments(lookup: CommentLookup): ReviewRecord[] | undefined {
	if (!lookup.ok) return undefined;
	const records: ReviewRecord[] = [];
	const opening = `<!-- ${REVIEW_RECORD_MARKER}:`;
	for (const body of lookup.bodies) {
		if (!body.startsWith(opening)) continue;
		const record = parseReviewRecord(body);
		if (record === undefined) return undefined;
		records.push(record);
	}
	return records;
}

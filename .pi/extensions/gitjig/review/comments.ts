/** Bounded platform reader for the review records posted as PR comments. */
import { execFileSync } from "node:child_process";
import { withoutPlatformRetargetingEnv } from "../dispatch/provision.ts";
import type { CommentLookup } from "./merge-gate.ts";
import { parseReviewRecord, REVIEW_RECORD_MARKER, type ReviewRecord } from "./record.ts";

const COMMENT_READ_TIMEOUT_MS = 10_000;
const COMMENT_READ_MAX_BYTES = 4 * 1024 * 1024;

type CommentReader = (
	argv: string[],
	options: { cwd: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
) => string;

const readComments: CommentReader = (argv, options) =>
	execFileSync("gh", argv, {
		...options,
		encoding: "utf8",
		env: withoutPlatformRetargetingEnv(process.env),
	});

/** Read every comment page as one JSON value; child text never enters a failure result. */
export function fetchReviewComments(repoRoot: string, pr: number, read: CommentReader = readComments): CommentLookup {
	let output: string | undefined;
	for (let attempt = 0; attempt < 2 && output === undefined; attempt += 1) {
		try {
			output = read(["api", "--paginate", "--slurp", `repos/{owner}/{repo}/issues/${String(pr)}/comments`], {
				cwd: repoRoot,
				timeout: COMMENT_READ_TIMEOUT_MS,
				maxBuffer: COMMENT_READ_MAX_BYTES,
				env: withoutPlatformRetargetingEnv(process.env),
			});
		} catch {
			// One bounded retry absorbs a transient platform or child failure.
		}
	}
	if (output === undefined) {
		return { ok: false, cause: "the bounded platform comment read failed" };
	}
	try {
		const pages: unknown = JSON.parse(output);
		if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
			return { ok: false, cause: "the platform comment response was not a page list" };
		}
		const bodies: string[] = [];
		for (const page of pages) {
			for (const comment of page) {
				if (
					typeof comment !== "object" ||
					comment === null ||
					typeof (comment as { body?: unknown }).body !== "string"
				) {
					return { ok: false, cause: "the platform comment response carried an unreadable body" };
				}
				bodies.push((comment as { body: string }).body);
			}
		}
		return { ok: true, bodies };
	} catch {
		return { ok: false, cause: "the platform comment response was not JSON" };
	}
}

/**
 * Parse the record population. Ordinary comments are ignored. A body that
 * claims the marker in canonical position but fails its parser makes the
 * population unreadable rather than silently shortening history.
 */
export function recordsFromComments(lookup: CommentLookup): ReviewRecord[] | undefined {
	if (!lookup.ok) {
		return undefined;
	}
	const records: ReviewRecord[] = [];
	const opening = `<!-- ${REVIEW_RECORD_MARKER}:`;
	for (const body of lookup.bodies) {
		if (!body.startsWith(opening)) {
			continue;
		}
		const record = parseReviewRecord(body);
		if (record === undefined) {
			return undefined;
		}
		records.push(record);
	}
	return records;
}

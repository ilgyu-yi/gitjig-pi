/** Bounded platform reader for review records posted as PR comments. */
import { runPlatformRead } from "../platform/read.ts";
import type { CommentLookup } from "./merge-gate.ts";
import { parseReviewRecord, REVIEW_RECORD_MARKER, type ReviewRecord } from "./record.ts";

type CommentRead = (argv: string[], repoRoot: string) => Promise<string | undefined>;

/** Read every comment page as one JSON value; child text never enters a failure result. */
export async function fetchReviewComments(
	repoRoot: string,
	pr: number,
	read: CommentRead = runPlatformRead,
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

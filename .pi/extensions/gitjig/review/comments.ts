/** Bounded platform reader for review records posted as PR comments. */
import { runPlatformRead } from "../platform/read.ts";
import { parseReviewRecord, REVIEW_RECORD_MARKER, type ReviewRecord } from "./record.ts";
import { admitPlatformReviewContext, type PlatformReviewContext } from "./subject.ts";

type CommentRead = (argv: string[], repoRoot: string) => Promise<string | undefined>;

export type AttestedCommentPopulation =
	| { ok: true; comments: readonly { id: number; authorId: string; body: string }[] }
	| { ok: false; cause: string };

/** Read comments from one explicit platform repository and retain provenance fields. */
export async function fetchAttestedReviewComments(
	repoRoot: string,
	context: PlatformReviewContext,
	read: CommentRead = runPlatformRead,
): Promise<AttestedCommentPopulation> {
	const subject = admitPlatformReviewContext(context);
	if (subject === undefined) return { ok: false, cause: "the platform comment subject was not admissible" };
	let output: string | undefined;
	const route = [
		"repos/",
		subject.repository.nameWithOwner,
		"/issues/",
		String(subject.pullRequest.number),
		"/comments",
	].join("");
	const argv = ["api", "--hostname", subject.repository.host, "--paginate", "--slurp", route];
	for (let attempt = 0; attempt < 2 && output === undefined; attempt += 1) {
		try {
			output = await read(argv, repoRoot);
		} catch {
			// One identical retry; stream and parse text remain excluded.
		}
	}
	if (output === undefined) return { ok: false, cause: "the bounded platform comment read failed" };
	try {
		const pages: unknown = JSON.parse(output);
		if (!Array.isArray(pages) || !pages.every(Array.isArray))
			return { ok: false, cause: "the platform comment response was not a page list" };
		const comments: { id: number; authorId: string; body: string }[] = [];
		const ids = new Set<number>();
		for (const page of pages) {
			for (const comment of page) {
				if (
					typeof comment !== "object" ||
					comment === null ||
					!Number.isSafeInteger((comment as { id?: unknown }).id) ||
					((comment as { id: number }).id as number) <= 0 ||
					ids.has((comment as { id: number }).id) ||
					typeof (comment as { body?: unknown }).body !== "string" ||
					typeof (comment as { user?: { node_id?: unknown } }).user?.node_id !== "string" ||
					(comment as { user: { node_id: string } }).user.node_id.length === 0
				)
					return { ok: false, cause: "the platform comment response carried unreadable provenance" };
				ids.add((comment as { id: number }).id);
				comments.push({
					id: (comment as { id: number }).id,
					authorId: (comment as { user: { node_id: string } }).user.node_id,
					body: (comment as { body: string }).body,
				});
			}
		}
		return { ok: true, comments };
	} catch {
		return { ok: false, cause: "the platform comment response was not JSON" };
	}
}

/** Admit marked records only from the platform-attested single-account writer. */
export function recordsFromAttestedComments(
	population: AttestedCommentPopulation,
	writerId: string,
): ReviewRecord[] | undefined {
	if (!population.ok || writerId.length === 0) return undefined;
	const records: ReviewRecord[] = [];
	const opening = `<!-- ${REVIEW_RECORD_MARKER}:`;
	for (const comment of population.comments) {
		if (comment.authorId !== writerId || !comment.body.startsWith(opening)) continue;
		const record = parseReviewRecord(comment.body);
		if (record === undefined) return undefined;
		records.push(record);
	}
	return records;
}

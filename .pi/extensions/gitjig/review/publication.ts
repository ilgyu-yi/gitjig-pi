/**
 * Inert explicit-target publication seam for review records.
 *
 * Warning-surface roster: EXEMPT — this module emits no warning or
 * operator-facing text. It does not attest the writer; activation remains
 * gated on #241's independently identified machine principal.
 */
import { type PublishResult, performPublish } from "../publish/index.ts";
import { type AttestedCommentPopulation, fetchAttestedReviewComments } from "./comments.ts";
import { admitPlatformReviewContext, type PlatformReviewContext } from "./subject.ts";

type Publish = typeof performPublish;
type FetchComments = typeof fetchAttestedReviewComments;

export interface ReviewPublicationReceipt {
	repositoryId: string;
	pullRequestId: string;
	headOid: string;
	commentId: number;
	authorId: string;
	body: string;
}

export type ReviewPublicationOutcome = { ok: true; receipt: ReviewPublicationReceipt } | { ok: false; cause: string };

/** Publish only to the PR carried by one re-admitted platform context. */
export async function publishReviewRecord(
	body: string,
	context: PlatformReviewContext,
	repoRoot: string,
	stateRoot: string,
	publish: Publish = performPublish,
): Promise<PublishResult> {
	const subject = admitPlatformReviewContext(context);
	if (subject === undefined) {
		return {
			content: [{ type: "text", text: "review publication refused: the platform subject was not admissible" }],
			details: { disposition: "refuse-subject" },
		};
	}
	return publish(
		{
			body,
			destination: { kind: "pr-comment", number: subject.pullRequest.number },
		},
		repoRoot,
		stateRoot,
		{ host: subject.repository.host, nameWithOwner: subject.repository.nameWithOwner },
	);
}

function publishedCommentId(result: PublishResult, context: PlatformReviewContext): number | undefined {
	if (result.details.disposition !== "published" || typeof result.details.url !== "string") return undefined;
	try {
		const url = new URL(result.details.url);
		const prefix = `/${context.repository.nameWithOwner}/`;
		const path = url.pathname.slice(prefix.length).split("/");
		if (
			url.protocol !== "https:" ||
			url.hostname !== context.repository.host ||
			url.port !== "" ||
			url.username !== "" ||
			url.password !== "" ||
			url.search !== "" ||
			!url.pathname.startsWith(prefix) ||
			path.length !== 2 ||
			(path[0] !== "pull" && path[0] !== "issues") ||
			path[1] !== String(context.pullRequest.number) ||
			!/^#issuecomment-[1-9]\d*$/.test(url.hash)
		)
			return undefined;
		const id = Number(url.hash.slice("#issuecomment-".length));
		return Number.isSafeInteger(id) ? id : undefined;
	} catch {
		return undefined;
	}
}

function admitReceipt(
	context: PlatformReviewContext,
	body: string,
	commentId: number,
	population: AttestedCommentPopulation,
): ReviewPublicationReceipt | undefined {
	if (!population.ok) return undefined;
	const matches = population.comments.filter((comment) => comment.id === commentId && comment.body === body);
	if (matches.length !== 1) return undefined;
	return {
		repositoryId: context.repository.id,
		pullRequestId: context.pullRequest.id,
		headOid: context.pullRequest.head.oid,
		commentId,
		authorId: matches[0].authorId,
		body: matches[0].body,
	};
}

/** A send is usable only after the exact comment is re-fetched from its bound subject. */
export async function publishAndRefetchReviewRecord(
	body: string,
	context: PlatformReviewContext,
	repoRoot: string,
	stateRoot: string,
	publish: Publish = performPublish,
	fetchComments: FetchComments = fetchAttestedReviewComments,
): Promise<ReviewPublicationOutcome> {
	const subject = admitPlatformReviewContext(context);
	if (subject === undefined) return { ok: false, cause: "the platform subject was not admissible" };
	const published = await publishReviewRecord(body, subject, repoRoot, stateRoot, publish);
	const commentId = publishedCommentId(published, subject);
	if (commentId === undefined) return { ok: false, cause: "the review publication was not confirmed" };
	const receipt = admitReceipt(subject, body, commentId, await fetchComments(repoRoot, subject));
	return receipt === undefined
		? { ok: false, cause: "the published review record did not refetch exactly" }
		: { ok: true, receipt };
}

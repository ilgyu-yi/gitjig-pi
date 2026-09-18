/**
 * Inert explicit-target publication seam for review records.
 *
 * Warning-surface roster: EXEMPT — this module emits no warning or
 * operator-facing text. It attests the platform writer without claiming
 * account-level independence; #241 assigns semantic separation to the
 * ordered agent capacities under one account.
 */
import { runPlatformRead } from "../platform/read.ts";
import { runPlatformMutation } from "../platform/write.ts";
import { type PublishResult, performPublish } from "../publish/service.ts";
import { type AttestedCommentPopulation, fetchAttestedReviewComments } from "./comments.ts";
import {
	admitPlatformReviewContext,
	admitReviewSubject,
	type PlatformReviewContext,
	type ReviewSubject,
} from "./subject.ts";

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

/** Publish the Resolver-repair lifecycle record through the same attested seam. */
export async function publishResolverRepairHandoff(
	source: ReviewSubject,
	repoRoot: string,
	stateRoot: string,
	now: () => string = () => new Date().toISOString(),
): Promise<ReviewPublicationOutcome> {
	const subject = admitReviewSubject(source);
	if (subject === undefined) return { ok: false, cause: "the platform subject was not admissible" };
	const pull = subject.context.pullRequest;
	let engine: typeof import("../../../../.github/workflows/gitjig-lifecycle.mjs");
	try {
		engine = await import("../../../../.github/workflows/gitjig-lifecycle.mjs");
	} catch {
		return { ok: false, cause: "the handed-over lifecycle engine was unavailable" };
	}
	const population = await fetchAttestedReviewComments(repoRoot, subject.context);
	if (!population.ok) return { ok: false, cause: "the current lifecycle record population was unavailable" };
	const current = engine.admitCurrentAwaitingAuthor(
		population.comments.filter((comment) => comment.authorId === subject.writerId),
		"pull",
	);
	let published: ReviewPublicationOutcome;
	if (
		current !== undefined &&
		current.record.producer === subject.writerId &&
		current.record.subjectHead === pull.head.oid &&
		current.record.baseHead === pull.base.oid
	) {
		published = {
			ok: true,
			receipt: {
				repositoryId: subject.context.repository.id,
				pullRequestId: pull.id,
				headOid: pull.head.oid,
				commentId: current.comment.id,
				authorId: subject.writerId,
				body: current.comment.body,
			},
		};
	} else {
		published = await publishAndRefetchReviewRecord(
			engine.encodeRecord(engine.RECORD_MARKERS.awaitingAuthor, {
				producer: subject.writerId,
				producerKind: "resolver-repair",
				observedAt: now(),
				subjectHead: pull.head.oid,
				baseHead: pull.base.oid,
			}),
			subject,
			repoRoot,
			stateRoot,
		);
		if (!published.ok) return published;
	}
	const repository = subject.context.repository.nameWithOwner;
	if (
		!(await runPlatformMutation(
			["issue", "edit", String(pull.number), "--repo", repository, "--add-label", "awaiting-author"],
			repoRoot,
		))
	)
		return { ok: false, cause: "the awaiting-author record was durable but its label mutation failed" };
	const labels = await runPlatformRead(
		["issue", "view", String(pull.number), "--repo", repository, "--json", "labels", "--jq", ".labels[].name"],
		repoRoot,
	);
	if (labels === undefined || !labels.split("\n").includes("awaiting-author"))
		return { ok: false, cause: "the awaiting-author label did not re-read after its record" };
	return published;
}

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
	subject: ReviewSubject,
	body: string,
	commentId: number,
	population: AttestedCommentPopulation,
): ReviewPublicationReceipt | undefined {
	if (!population.ok) return undefined;
	const matches = population.comments.filter(
		(comment) => comment.id === commentId && comment.body === body && comment.authorId === subject.writerId,
	);
	if (matches.length !== 1) return undefined;
	const context = subject.context;
	return {
		repositoryId: context.repository.id,
		pullRequestId: context.pullRequest.id,
		headOid: context.pullRequest.head.oid,
		commentId,
		authorId: matches[0].authorId,
		body: matches[0].body,
	};
}

/**
 * A send is usable only after the exact comment is re-fetched from its bound
 * subject and attributed to that subject's sealed writer.
 */
export async function publishAndRefetchReviewRecord(
	body: string,
	source: ReviewSubject,
	repoRoot: string,
	stateRoot: string,
	publish: Publish = performPublish,
	fetchComments: FetchComments = fetchAttestedReviewComments,
): Promise<ReviewPublicationOutcome> {
	const subject = admitReviewSubject(source);
	if (subject === undefined) return { ok: false, cause: "the platform subject was not admissible" };
	const context = subject.context;
	const published = await publishReviewRecord(body, context, repoRoot, stateRoot, publish);
	const commentId = publishedCommentId(published, context);
	if (commentId === undefined) return { ok: false, cause: "the review publication was not confirmed" };
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const receipt = admitReceipt(subject, body, commentId, await fetchComments(repoRoot, context));
		if (receipt !== undefined) return { ok: true, receipt };
	}
	return { ok: false, cause: "the published review record did not refetch exactly" };
}

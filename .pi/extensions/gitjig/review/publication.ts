/**
 * Inert explicit-target publication seam for review records.
 *
 * Warning-surface roster: EXEMPT — this module emits no warning or
 * operator-facing text. It attests the platform writer without claiming
 * account-level independence; #241 assigns semantic separation to the
 * ordered agent capacities under one account.
 */

import { attestAwaitingAuthorComments } from "../lifecycle-attestation.ts";
import { runPlatformRead } from "../platform/read.ts";
import { addPlatformIssueLabel } from "../platform/write.ts";
import { type PublishResult, performPublish } from "../publish/service.ts";
import { fetchAttestedReviewComments } from "./comments.ts";
import {
	admitPlatformReviewContext,
	admitReviewSubject,
	CriterionOwnerUnavailableError,
	type PlatformReviewContext,
	type ReviewSubject,
} from "./subject.ts";

type Publish = typeof performPublish;
type FetchComments = typeof fetchAttestedReviewComments;
type Read = typeof runPlatformRead;
type Delay = (ms: number) => Promise<void>;

/** SPEC §3.3's one fixed wait before the single identical receipt reread. */
export const RECEIPT_REREAD_DELAY_MS = 5_000;

const waitFor: Delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function admitPublicationSubject(
	source: ReviewSubject,
): Promise<ReviewSubject | "criterion-owner-unavailable" | undefined> {
	try {
		return await admitReviewSubject(source);
	} catch (error) {
		return error instanceof CriterionOwnerUnavailableError ? "criterion-owner-unavailable" : undefined;
	}
}

export interface ReviewPublicationReceipt {
	repositoryId: string;
	pullRequestId: string;
	headOid: string;
	commentId: number;
	authorId: string;
	body: string;
}

export type ReviewPublicationOutcome = { ok: true; receipt: ReviewPublicationReceipt } | { ok: false; cause: string };

export interface ResolverPublicationSeams {
	fetchComments: FetchComments;
	publishRecord: typeof publishAndRefetchReviewRecord;
	mutate: typeof addPlatformIssueLabel;
	read: typeof runPlatformRead;
}

/** Publish the Resolver-repair lifecycle record through the same attested seam. */
export async function publishResolverRepairHandoff(
	source: ReviewSubject,
	repoRoot: string,
	stateRoot: string,
	now: () => string = () => new Date().toISOString(),
	seams: ResolverPublicationSeams = {
		fetchComments: fetchAttestedReviewComments,
		publishRecord: publishAndRefetchReviewRecord,
		mutate: addPlatformIssueLabel,
		read: runPlatformRead,
	},
): Promise<ReviewPublicationOutcome> {
	const subject = await admitPublicationSubject(source);
	if (subject === "criterion-owner-unavailable")
		return { ok: false, cause: "the handed-over criterion owner was unavailable" };
	if (subject === undefined) return { ok: false, cause: "the platform subject was not admissible" };
	const pull = subject.context.pullRequest;
	let engine: typeof import("../../../../.github/workflows/gitjig-lifecycle.mjs");
	try {
		engine = await import("../../../../.github/workflows/gitjig-lifecycle.mjs");
	} catch {
		return { ok: false, cause: "the handed-over lifecycle engine was unavailable" };
	}
	const host = subject.context.repository.host;
	const repositoryName = subject.context.repository.nameWithOwner;
	const writerLogin = await seams.read(["api", "--hostname", host, "user", "--jq", ".login"], repoRoot);
	if (writerLogin === undefined || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(writerLogin))
		return { ok: false, cause: "the Resolver writer identity was unavailable" };
	const role = await seams.read(
		[
			"api",
			"--hostname",
			host,
			`repos/${repositoryName}/collaborators/${encodeURIComponent(writerLogin)}/permission`,
			"--jq",
			".role_name",
		],
		repoRoot,
	);
	if (
		!engine.authorizedResolver({
			actorId: subject.writerId,
			actorType: "User",
			repositoryId: subject.context.repository.id,
			addressedRepositoryId: subject.context.repository.id,
			permission: role?.toUpperCase(),
		})
	)
		return { ok: false, cause: "the Resolver writer lacked current collaborator authority" };
	const population = await seams.fetchComments(repoRoot, subject.context);
	if (!population.ok) return { ok: false, cause: "the current lifecycle record population was unavailable" };
	const trusted = await attestAwaitingAuthorComments(
		engine,
		population.comments,
		subject.context.repository.id,
		async (comment) =>
			comment.authorId === subject.writerId
				? role
				: await seams.read(
						[
							"api",
							"--hostname",
							host,
							`repos/${repositoryName}/collaborators/${encodeURIComponent(comment.authorLogin ?? "")}/permission`,
							"--jq",
							".role_name",
						],
						repoRoot,
					),
	);
	const inspected = engine.inspectAwaitingAuthorPopulation(trusted, "pull");
	if (!inspected.ok) return { ok: false, cause: "the current lifecycle record population was ambiguous" };
	const current = inspected.current?.[0];
	if (
		current !== undefined &&
		(current.record.subjectHead !== pull.head.oid || current.record.baseHead !== pull.base.oid)
	)
		return { ok: false, cause: "the current lifecycle record was stale" };
	let published: ReviewPublicationOutcome;
	if (
		current !== undefined &&
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
				authorId: current.comment.authorId,
				body: current.comment.body,
			},
		};
	} else {
		published = await seams.publishRecord(
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
	if (!(await seams.mutate(host, repositoryName, pull.number, "awaiting-author", repoRoot)))
		return { ok: false, cause: "the awaiting-author record was durable but its label mutation failed" };
	const labels = await seams.read(
		["api", "--hostname", host, `repos/${repositoryName}/issues/${pull.number}`, "--jq", ".labels[].name"],
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

type PublishedCommentLocator = { id: number; url: string };

function publishedCommentLocator(
	result: PublishResult,
	context: PlatformReviewContext,
): PublishedCommentLocator | undefined {
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
		return Number.isSafeInteger(id) ? { id, url: result.details.url } : undefined;
	} catch {
		return undefined;
	}
}

function stringField(value: unknown, key: string): string | undefined {
	return typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as Record<string, unknown>)[key] === "string"
		? ((value as Record<string, unknown>)[key] as string)
		: undefined;
}

function numberField(value: unknown, key: string): number | undefined {
	return typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Number.isSafeInteger((value as Record<string, unknown>)[key])
		? ((value as Record<string, unknown>)[key] as number)
		: undefined;
}

function admitTargetedReceipt(
	subject: ReviewSubject,
	body: string,
	locator: PublishedCommentLocator,
	output: string | undefined,
): ReviewPublicationReceipt | undefined {
	if (output === undefined) return undefined;
	let payload: unknown;
	try {
		payload = JSON.parse(output);
	} catch {
		return undefined;
	}
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
	const context = subject.context;
	const apiRoot =
		context.repository.host === "github.com" ? "https://api.github.com" : `https://${context.repository.host}/api/v3`;
	const user = (payload as { user?: unknown }).user;
	if (
		numberField(payload, "id") !== locator.id ||
		stringField(payload, "issue_url") !==
			`${apiRoot}/repos/${context.repository.nameWithOwner}/issues/${String(context.pullRequest.number)}` ||
		stringField(payload, "html_url") !== locator.url ||
		stringField(payload, "body") !== body ||
		stringField(user, "node_id") !== subject.writerId
	)
		return undefined;
	return {
		repositoryId: context.repository.id,
		pullRequestId: context.pullRequest.id,
		headOid: context.pullRequest.head.oid,
		commentId: locator.id,
		authorId: subject.writerId,
		body,
	};
}

/**
 * A send is usable only after the exact comment is re-fetched from its bound
 * subject and attributed to that subject's sealed writer. Per SPEC §3.3, only
 * a first read with no admitted output earns one fixed delay and one
 * byte-identical second read; a present response is evidence and is never
 * retried.
 */
export async function publishAndRefetchReviewRecord(
	body: string,
	source: ReviewSubject,
	repoRoot: string,
	stateRoot: string,
	publish: Publish = performPublish,
	read: Read = runPlatformRead,
	delay: Delay = waitFor,
): Promise<ReviewPublicationOutcome> {
	const subject = await admitPublicationSubject(source);
	if (subject === "criterion-owner-unavailable")
		return { ok: false, cause: "the handed-over criterion owner was unavailable" };
	if (subject === undefined) return { ok: false, cause: "the platform subject was not admissible" };
	const context = subject.context;
	const published = await publishReviewRecord(body, context, repoRoot, stateRoot, publish);
	const locator = publishedCommentLocator(published, context);
	if (locator === undefined) return { ok: false, cause: "the review publication was not confirmed" };
	const argv = [
		"api",
		"--hostname",
		context.repository.host,
		`repos/${context.repository.nameWithOwner}/issues/comments/${String(locator.id)}`,
	] as const;
	let output = await read([...argv], repoRoot);
	if (output === undefined) {
		await delay(RECEIPT_REREAD_DELAY_MS);
		output = await read([...argv], repoRoot);
	}
	const receipt = admitTargetedReceipt(subject, body, locator, output);
	return receipt === undefined
		? { ok: false, cause: "the published review record did not refetch exactly" }
		: { ok: true, receipt };
}

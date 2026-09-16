/**
 * The platform-attested ReviewSubject: repository/PR context, the
 * authenticated record writer, and the sealed closing-issue criterion
 * snapshot.
 *
 * Warning-surface roster: EXEMPT — this module returns data or undefined and
 * emits no warning, record, or operator-facing text. The attended #241
 * decision permits one platform account; role ordering, not account identity,
 * supplies semantic separation.
 *
 * SPEC §1.9's criterion manifest is the stable union of each closing issue's
 * platform-recorded activation snapshot and its criteria when this subject is
 * opened. Missing, malformed, ambiguously repeated, or wrongly attributed
 * activation evidence refuses the whole subject rather than narrowing it.
 */
import { runPlatformRead } from "../platform/read.ts";
import type { Manifest } from "./resolve.ts";

export interface PlatformRepositoryIdentity {
	id: string;
	host: string;
	nameWithOwner: string;
}

export interface PlatformRefIdentity {
	repositoryId: string;
	name: string;
	oid: string;
}

export interface PlatformIssueSnapshot {
	id: string;
	repositoryId: string;
	number: number;
	title: string;
	body: string;
}

export interface PlatformReviewContext {
	repository: PlatformRepositoryIdentity;
	pullRequest: {
		id: string;
		number: number;
		url: string;
		authorId: string;
		base: PlatformRefIdentity;
		head: PlatformRefIdentity;
		closingIssues: PlatformIssueSnapshot[];
	};
}

const FULL_OID = /^[0-9a-f]{40}$/;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PLATFORM_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		Object.keys(value).every((key) => keys.includes(key))
	);
}

function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function platformNode(value: unknown): value is Record<string, unknown> & { id: string } {
	return typeof value === "object" && value !== null && !Array.isArray(value) && text((value as { id?: unknown }).id);
}

function repository(value: unknown): value is PlatformRepositoryIdentity {
	return (
		object(value, ["id", "host", "nameWithOwner"]) &&
		text(value.id) &&
		typeof value.host === "string" &&
		PLATFORM_HOST.test(value.host) &&
		text(value.nameWithOwner) &&
		REPOSITORY_NAME.test(value.nameWithOwner)
	);
}

function exactHttpsUrl(value: unknown, host: string, pathname: string): boolean {
	if (typeof value !== "string") return false;
	try {
		const parsed = new URL(value);
		return (
			parsed.protocol === "https:" &&
			parsed.username === "" &&
			parsed.password === "" &&
			parsed.port === "" &&
			parsed.search === "" &&
			parsed.hash === "" &&
			parsed.hostname === host &&
			parsed.pathname === pathname
		);
	} catch {
		return false;
	}
}

function repositoryUrl(value: unknown, nameWithOwner: string): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const parsed = new URL(value);
		if (!PLATFORM_HOST.test(parsed.hostname) || !exactHttpsUrl(value, parsed.hostname, `/${nameWithOwner}`))
			return undefined;
		return parsed.hostname;
	} catch {
		return undefined;
	}
}

function ref(value: unknown): value is PlatformRefIdentity {
	return (
		object(value, ["repositoryId", "name", "oid"]) &&
		text(value.repositoryId) &&
		text(value.name) &&
		typeof value.oid === "string" &&
		FULL_OID.test(value.oid)
	);
}

function issue(value: unknown): value is PlatformIssueSnapshot {
	return (
		object(value, ["id", "repositoryId", "number", "title", "body"]) &&
		text(value.id) &&
		text(value.repositoryId) &&
		Number.isSafeInteger(value.number) &&
		(value.number as number) > 0 &&
		typeof value.title === "string" &&
		typeof value.body === "string"
	);
}

/** Admit one closed snapshot; no caller-authored ref or criterion enters it. */
export function admitPlatformReviewContext(value: unknown): PlatformReviewContext | undefined {
	if (!object(value, ["repository", "pullRequest"])) return undefined;
	const repositoryIdentity = value.repository;
	if (!repository(repositoryIdentity)) return undefined;
	const pull = value.pullRequest;
	if (
		!object(pull, ["id", "number", "url", "authorId", "base", "head", "closingIssues"]) ||
		!text(pull.id) ||
		!Number.isSafeInteger(pull.number) ||
		(pull.number as number) <= 0 ||
		!text(pull.url) ||
		!text(pull.authorId) ||
		!ref(pull.base) ||
		!ref(pull.head) ||
		!Array.isArray(pull.closingIssues) ||
		!pull.closingIssues.every(issue)
	)
		return undefined;
	if (
		!exactHttpsUrl(
			pull.url,
			repositoryIdentity.host,
			`/${repositoryIdentity.nameWithOwner}/pull/${String(pull.number)}`,
		) ||
		pull.base.repositoryId !== repositoryIdentity.id ||
		pull.head.repositoryId !== repositoryIdentity.id
	)
		return undefined;
	if (pull.closingIssues.some((entry) => entry.repositoryId !== repositoryIdentity.id)) return undefined;
	return structuredClone(value) as unknown as PlatformReviewContext;
}

/**
 * One review subject: the attested platform context, the authenticated
 * account that may write this change's durable records, and the criterion
 * snapshot derived from that context's closing issues at admission. The
 * three travel together so no later consumer re-derives one of them from a
 * caller-authored value (SPEC §1.9's criterion manifest, §1.4's durable
 * record the acting agent does not author).
 */
export interface ReviewSubject {
	context: PlatformReviewContext;
	writerId: string;
	activation: readonly { issueId: string; comment: PlatformCommentSnapshot }[];
	criteria: readonly string[];
}

export interface PlatformCommentSnapshot {
	id: number;
	authorId: string;
	body: string;
}

const CRITERIA_HEADING = /^#{1,6}[ \t]+acceptance criteria[ \t]*$/i;
const ANY_HEADING = /^#{1,6}[ \t]/;
const LIST_ITEM = /^(?:[-*+]|\d{1,3}[.)])[ \t]+(\S.*?)[ \t]*$/;

/**
 * The committed derivation rule: within each closing issue, the list items
 * under an "Acceptance criteria" heading, in platform order, each carried
 * with the issue it came from. A subject with no closing issue, or none
 * carrying criteria, yields the EMPTY set — §1.9's empty manifest, never
 * its absent one.
 */
export function criteriaFromClosingIssues(issues: readonly PlatformIssueSnapshot[]): string[] {
	const criteria: string[] = [];
	for (const entry of issues) {
		let inside = false;
		for (const line of entry.body.split("\n")) {
			const text = line.endsWith("\r") ? line.slice(0, -1) : line;
			if (ANY_HEADING.test(text)) {
				inside = CRITERIA_HEADING.test(text);
				continue;
			}
			if (!inside) continue;
			const item = LIST_ITEM.exec(text);
			if (item !== null) criteria.push(["#", String(entry.number), ": ", item[1]].join(""));
		}
	}
	return criteria;
}

const ACTIVATION_MARKER = "gitjig-activation-criteria";

/** Admit exactly one writer-attributed activation snapshot for one issue. */
export function activationCriteriaFromComments(
	issue: PlatformIssueSnapshot,
	writerId: string,
	comments: readonly PlatformCommentSnapshot[],
): string[] | undefined {
	const prefix = `<!-- ${ACTIVATION_MARKER}:`;
	const candidates = comments.filter((comment) => comment.authorId === writerId && comment.body.startsWith(prefix));
	if (candidates.length !== 1) return undefined;
	const marker = `<!-- ${ACTIVATION_MARKER}: ${issue.id} -->`;
	const body = candidates[0].body;
	if (!body.startsWith(`${marker}\n`) && !body.startsWith(`${marker}\r\n`)) return undefined;
	const fenced = body.slice(marker.length).trim();
	const match = /^```json\r?\n([\s\S]+)\r?\n```$/.exec(fenced);
	if (match === null) return undefined;
	try {
		const value: unknown = JSON.parse(match[1]);
		if (!object(value, ["issueId", "issueNumber", "criteria"])) return undefined;
		if (value.issueId !== issue.id || value.issueNumber !== issue.number) return undefined;
		if (!Array.isArray(value.criteria) || !value.criteria.every(text)) return undefined;
		return value.criteria.map((criterion) => `#${String(issue.number)}: ${criterion}`);
	} catch {
		return undefined;
	}
}

/** Stable activation-first union; exact duplicates retain their first position. */
export function criterionUnion(activation: readonly string[], current: readonly string[]): string[] {
	return [...new Set([...activation, ...current])];
}

/**
 * Admit one sealed subject. The criterion snapshot is not trusted as
 * supplied: it must equal the set this module derives from the same
 * context's closing issues, so a caller cannot widen or narrow the
 * criteria the adjudication will be read against.
 */
export function admitReviewSubject(value: unknown): ReviewSubject | undefined {
	if (!object(value, ["context", "writerId", "activation", "criteria"])) return undefined;
	const context = admitPlatformReviewContext(value.context);
	if (context === undefined || !text(value.writerId) || !Array.isArray(value.activation)) return undefined;
	if (!Array.isArray(value.criteria) || !value.criteria.every(text)) return undefined;
	if (value.activation.length !== context.pullRequest.closingIssues.length) return undefined;
	const activation: { issueId: string; comment: PlatformCommentSnapshot }[] = [];
	const activationCriteria: string[] = [];
	for (let index = 0; index < context.pullRequest.closingIssues.length; index += 1) {
		const issue = context.pullRequest.closingIssues[index];
		const evidence = value.activation[index];
		if (!object(evidence, ["issueId", "comment"]) || evidence.issueId !== issue.id) return undefined;
		const comment = evidence.comment;
		if (
			!object(comment, ["id", "authorId", "body"]) ||
			!Number.isSafeInteger(comment.id) ||
			(comment.id as number) <= 0 ||
			!text(comment.authorId) ||
			typeof comment.body !== "string"
		)
			return undefined;
		const snapshot = { id: comment.id as number, authorId: comment.authorId, body: comment.body };
		const criteria = activationCriteriaFromComments(issue, value.writerId, [snapshot]);
		if (criteria === undefined) return undefined;
		activation.push({ issueId: issue.id, comment: snapshot });
		activationCriteria.push(...criteria);
	}
	const derived = criterionUnion(activationCriteria, criteriaFromClosingIssues(context.pullRequest.closingIssues));
	if (JSON.stringify(value.criteria) !== JSON.stringify(derived)) return undefined;
	return { context, writerId: value.writerId, activation, criteria: derived };
}

/** §1.9's manifest projection: a sealed subject always supplies a present one. */
export function subjectCriterionManifest(subject: ReviewSubject): Manifest {
	return { state: "present", criteria: subject.criteria };
}

type PlatformRead = (argv: string[], repoRoot: string) => Promise<string | undefined>;

async function readJson(read: PlatformRead, argv: string[], repoRoot: string): Promise<unknown> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const output = await read(argv, repoRoot);
			if (output !== undefined) return JSON.parse(output) as unknown;
		} catch {
			// One identical retry; no child or parse text crosses the boundary.
		}
	}
	return undefined;
}

/**
 * Bootstrap the repository from the operator's checkout once, then address
 * the PR explicitly by the returned platform repository identity.
 */
export async function fetchPlatformReviewContext(
	repoRoot: string,
	pr: number,
	read: PlatformRead = runPlatformRead,
): Promise<PlatformReviewContext | undefined> {
	if (!Number.isSafeInteger(pr) || pr <= 0) return undefined;
	const repositoryValue = await readJson(read, ["repo", "view", "--json", "id,nameWithOwner,url"], repoRoot);
	if (
		!object(repositoryValue, ["id", "nameWithOwner", "url"]) ||
		!text(repositoryValue.id) ||
		!text(repositoryValue.nameWithOwner) ||
		!REPOSITORY_NAME.test(repositoryValue.nameWithOwner)
	)
		return undefined;
	const host = repositoryUrl(repositoryValue.url, repositoryValue.nameWithOwner);
	if (host === undefined) return undefined;
	const repositoryIdentity: PlatformRepositoryIdentity = {
		id: repositoryValue.id,
		host,
		nameWithOwner: repositoryValue.nameWithOwner,
	};
	return fetchPullContext(repoRoot, repositoryIdentity, pr, read);
}

async function fetchPullContext(
	repoRoot: string,
	repositoryIdentity: PlatformRepositoryIdentity,
	pr: number,
	read: PlatformRead,
): Promise<PlatformReviewContext | undefined> {
	const pullValue = await readJson(
		read,
		[
			"pr",
			"view",
			String(pr),
			"--repo",
			[repositoryIdentity.host, repositoryIdentity.nameWithOwner].join("/"),
			"--json",
			"id,number,url,author,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,closingIssuesReferences",
		],
		repoRoot,
	);
	if (
		!object(pullValue, [
			"id",
			"number",
			"url",
			"author",
			"baseRefName",
			"baseRefOid",
			"headRefName",
			"headRefOid",
			"headRepository",
			"closingIssuesReferences",
		]) ||
		pullValue.number !== pr ||
		!exactHttpsUrl(pullValue.url, repositoryIdentity.host, `/${repositoryIdentity.nameWithOwner}/pull/${String(pr)}`) ||
		!platformNode(pullValue.author) ||
		!platformNode(pullValue.headRepository) ||
		!Array.isArray(pullValue.closingIssuesReferences)
	)
		return undefined;
	const closingIssues = pullValue.closingIssuesReferences.map((entry) => {
		if (!object(entry, ["id", "number", "title", "body", "repository"]) || !platformNode(entry.repository))
			return undefined;
		return {
			id: entry.id,
			repositoryId: entry.repository.id,
			number: entry.number,
			title: entry.title,
			body: entry.body,
		};
	});
	if (closingIssues.some((entry) => entry === undefined)) return undefined;
	return admitPlatformReviewContext({
		repository: repositoryIdentity,
		pullRequest: {
			id: pullValue.id,
			number: pullValue.number,
			url: pullValue.url,
			authorId: pullValue.author.id,
			base: { repositoryId: repositoryIdentity.id, name: pullValue.baseRefName, oid: pullValue.baseRefOid },
			head: {
				repositoryId: pullValue.headRepository.id,
				name: pullValue.headRefName,
				oid: pullValue.headRefOid,
			},
			closingIssues,
		},
	});
}

/**
 * Read the authenticated account the platform would attribute a write to,
 * addressed at the already attested host. #241's settlement admits one such
 * account: separation is the ordered agent capacities', never the account's.
 */
async function fetchWriterIdentity(
	repoRoot: string,
	repositoryIdentity: PlatformRepositoryIdentity,
	read: PlatformRead,
): Promise<string | undefined> {
	const value = await readJson(read, ["api", "--hostname", repositoryIdentity.host, "user"], repoRoot);
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const id = (value as { node_id?: unknown }).node_id;
	return text(id) ? id : undefined;
}

async function fetchIssueComments(
	repoRoot: string,
	repository: PlatformRepositoryIdentity,
	issue: PlatformIssueSnapshot,
	read: PlatformRead,
): Promise<PlatformCommentSnapshot[] | undefined> {
	const route = `repos/${repository.nameWithOwner}/issues/${String(issue.number)}/comments`;
	const value = await readJson(read, ["api", "--hostname", repository.host, "--paginate", "--slurp", route], repoRoot);
	if (!Array.isArray(value) || !value.every(Array.isArray)) return undefined;
	const comments: PlatformCommentSnapshot[] = [];
	const ids = new Set<number>();
	for (const page of value) {
		for (const entry of page) {
			if (
				typeof entry !== "object" ||
				entry === null ||
				Array.isArray(entry) ||
				!Number.isSafeInteger((entry as { id?: unknown }).id) ||
				((entry as { id: number }).id as number) <= 0 ||
				ids.has((entry as { id: number }).id) ||
				typeof (entry as { body?: unknown }).body !== "string" ||
				typeof (entry as { user?: { node_id?: unknown } }).user?.node_id !== "string" ||
				(entry as { user: { node_id: string } }).user.node_id.length === 0
			)
				return undefined;
			const id = (entry as { id: number }).id;
			ids.add(id);
			comments.push({
				id,
				authorId: (entry as { user: { node_id: string } }).user.node_id,
				body: (entry as { body: string }).body,
			});
		}
	}
	return comments;
}

/** Compose the whole subject, including §1.9's activation/current criterion union. */
export async function fetchReviewSubject(
	repoRoot: string,
	pr: number,
	read: PlatformRead = runPlatformRead,
): Promise<ReviewSubject | undefined> {
	const context = await fetchPlatformReviewContext(repoRoot, pr, read);
	if (context === undefined) return undefined;
	const writerId = await fetchWriterIdentity(repoRoot, context.repository, read);
	if (writerId === undefined) return undefined;
	const activation: { issueId: string; comment: PlatformCommentSnapshot }[] = [];
	const activationCriteria: string[] = [];
	for (const issue of context.pullRequest.closingIssues) {
		const comments = await fetchIssueComments(repoRoot, context.repository, issue, read);
		if (comments === undefined) return undefined;
		const criteria = activationCriteriaFromComments(issue, writerId, comments);
		if (criteria === undefined) return undefined;
		const marker = `<!-- ${ACTIVATION_MARKER}:`;
		const snapshot = comments.find((comment) => comment.authorId === writerId && comment.body.startsWith(marker));
		if (snapshot === undefined) return undefined;
		activation.push({ issueId: issue.id, comment: snapshot });
		activationCriteria.push(...criteria);
	}
	return admitReviewSubject({
		context,
		writerId,
		activation,
		criteria: criterionUnion(activationCriteria, criteriaFromClosingIssues(context.pullRequest.closingIssues)),
	});
}

/** Re-fetch only through the already attested repository identity and require exact equality. */
export async function refetchPlatformReviewContext(
	repoRoot: string,
	expected: PlatformReviewContext,
	read: PlatformRead = runPlatformRead,
): Promise<PlatformReviewContext | undefined> {
	const subject = admitPlatformReviewContext(expected);
	if (subject === undefined) return undefined;
	const current = await fetchPullContext(repoRoot, subject.repository, subject.pullRequest.number, read);
	return current !== undefined && JSON.stringify(current) === JSON.stringify(subject) ? current : undefined;
}

/** Re-fetch every platform-derived component and require the sealed subject to remain exact. */
export async function refetchReviewSubject(
	repoRoot: string,
	expected: ReviewSubject,
	read: PlatformRead = runPlatformRead,
): Promise<ReviewSubject | undefined> {
	const subject = admitReviewSubject(expected);
	if (subject === undefined) return undefined;
	const current = await fetchReviewSubject(repoRoot, subject.context.pullRequest.number, read);
	return current !== undefined && JSON.stringify(current) === JSON.stringify(subject) ? current : undefined;
}

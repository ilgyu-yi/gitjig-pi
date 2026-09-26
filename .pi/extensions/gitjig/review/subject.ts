/**
 * The platform-attested ReviewSubject: repository/PR context, the
 * authenticated record writer, and the sealed closing-issue criterion
 * snapshot.
 *
 * Warning-surface roster: EXEMPT — this module returns data or undefined and
 * emits no warning, record, or operator-facing text. The operator-owned #241
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
		pull.base.repositoryId !== repositoryIdentity.id
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
	activation: readonly {
		issueId: string;
		verdict: PlatformCommentSnapshot;
		snapshot: PlatformCommentSnapshot;
	}[];
	criteria: readonly string[];
}

export type PlatformAuthorAssociation = "OWNER" | "MEMBER" | "COLLABORATOR" | "OTHER";

export interface PlatformCommentSnapshot {
	id: number;
	authorId: string;
	authorAssociation: PlatformAuthorAssociation;
	body: string;
}

type CriterionOwner = {
	criteriaFromClosingIssues(issues: readonly PlatformIssueSnapshot[]): string[];
};

export class CriterionOwnerUnavailableError extends Error {
	readonly code = "criterion-owner-unavailable";

	constructor() {
		super("criterion owner unavailable");
		this.name = "CriterionOwnerUnavailableError";
	}
}

async function loadCriterionOwner(): Promise<CriterionOwner | undefined> {
	try {
		const owner = (await import("../../../../.github/workflows/ac-closeout.mjs")) as Partial<CriterionOwner>;
		return typeof owner.criteriaFromClosingIssues === "function" ? (owner as CriterionOwner) : undefined;
	} catch {
		return undefined;
	}
}

/** §1.9's handed-over derivation; unavailable is ABSENT, never EMPTY. */
export async function criteriaFromClosingIssues(issues: readonly PlatformIssueSnapshot[]): Promise<string[]> {
	const owner = await loadCriterionOwner();
	if (owner === undefined) throw new CriterionOwnerUnavailableError();
	return owner.criteriaFromClosingIssues(issues);
}

const ACTIVATION_MARKER = "gitjig-activation-criteria";
const ACTIVATION_PASS_MARKER = "<!-- activation-verdict: pass -->";

/** Select the latest PASS and its immediately adjacent snapshot; old pairs are immutable history. */
function latestActivationPair(
	issue: PlatformIssueSnapshot,
	writerId: string,
	comments: readonly PlatformCommentSnapshot[],
): { verdict: PlatformCommentSnapshot; snapshot: PlatformCommentSnapshot; criteria: string[] } | undefined {
	const prefix = `<!-- ${ACTIVATION_MARKER}:`;
	if (comments.some((comment, index) => index > 0 && comment.id <= comments[index - 1].id)) return undefined;
	const passIndexes = comments.flatMap((comment, index) =>
		comment.body.startsWith(ACTIVATION_PASS_MARKER) ? [index] : [],
	);
	const index = passIndexes.at(-1);
	if (index === undefined) return undefined;
	const verdict = comments[index];
	const snapshot = comments[index + 1];
	if (verdict === undefined || snapshot === undefined) return undefined;
	// A later candidate snapshot without a fresh PASS makes selection ambiguous;
	// an unpaired newer PASS must never fall back to a previous activation.
	if (comments.slice(index + 2).some((comment) => comment.authorId === writerId && comment.body.startsWith(prefix)))
		return undefined;
	if (
		verdict === undefined ||
		!(["OWNER", "MEMBER", "COLLABORATOR"] as const).includes(
			verdict.authorAssociation as "OWNER" | "MEMBER" | "COLLABORATOR",
		) ||
		(verdict.body !== ACTIVATION_PASS_MARKER &&
			!verdict.body.startsWith(`${ACTIVATION_PASS_MARKER}\n`) &&
			!verdict.body.startsWith(`${ACTIVATION_PASS_MARKER}\r\n`)) ||
		verdict.id >= snapshot.id ||
		snapshot.authorId !== writerId
	)
		return undefined;
	const marker = `<!-- ${ACTIVATION_MARKER}: ${issue.id} -->`;
	const body = snapshot.body;
	if (!body.startsWith(`${marker}\n`) && !body.startsWith(`${marker}\r\n`)) return undefined;
	const fenced = body.slice(marker.length).trim();
	const match = /^```json\r?\n([\s\S]+)\r?\n```$/.exec(fenced);
	if (match === null) return undefined;
	try {
		const value: unknown = JSON.parse(match[1]);
		if (!object(value, ["issueId", "issueNumber", "criteria"])) return undefined;
		if (value.issueId !== issue.id || value.issueNumber !== issue.number) return undefined;
		if (!Array.isArray(value.criteria) || !value.criteria.every(text)) return undefined;
		return { verdict, snapshot, criteria: value.criteria.map((criterion) => `#${String(issue.number)}: ${criterion}`) };
	} catch {
		return undefined;
	}
}

/** The same admitted pair supplies both criteria and the sealed ReviewSubject. */
export function activationCriteriaFromComments(
	issue: PlatformIssueSnapshot,
	writerId: string,
	comments: readonly PlatformCommentSnapshot[],
): string[] | undefined {
	return latestActivationPair(issue, writerId, comments)?.criteria;
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
export async function admitReviewSubject(value: unknown): Promise<ReviewSubject | undefined> {
	if (!object(value, ["context", "writerId", "activation", "criteria"])) return undefined;
	const context = admitPlatformReviewContext(value.context);
	if (context === undefined || !text(value.writerId) || !Array.isArray(value.activation)) return undefined;
	if (!Array.isArray(value.criteria) || !value.criteria.every(text)) return undefined;
	if (value.activation.length !== context.pullRequest.closingIssues.length) return undefined;
	const activation: {
		issueId: string;
		verdict: PlatformCommentSnapshot;
		snapshot: PlatformCommentSnapshot;
	}[] = [];
	const activationCriteria: string[] = [];
	for (let index = 0; index < context.pullRequest.closingIssues.length; index += 1) {
		const issue = context.pullRequest.closingIssues[index];
		const evidence = value.activation[index];
		if (!object(evidence, ["issueId", "verdict", "snapshot"]) || evidence.issueId !== issue.id) return undefined;
		const admitted: PlatformCommentSnapshot[] = [];
		for (const comment of [evidence.verdict, evidence.snapshot]) {
			if (
				!object(comment, ["id", "authorId", "authorAssociation", "body"]) ||
				!Number.isSafeInteger(comment.id) ||
				(comment.id as number) <= 0 ||
				!text(comment.authorId) ||
				!["OWNER", "MEMBER", "COLLABORATOR", "OTHER"].includes(comment.authorAssociation as string) ||
				typeof comment.body !== "string"
			)
				return undefined;
			admitted.push({
				id: comment.id as number,
				authorId: comment.authorId,
				authorAssociation: comment.authorAssociation as PlatformAuthorAssociation,
				body: comment.body,
			});
		}
		const criteria = activationCriteriaFromComments(issue, value.writerId, admitted);
		if (criteria === undefined) return undefined;
		activation.push({ issueId: issue.id, verdict: admitted[0], snapshot: admitted[1] });
		activationCriteria.push(...criteria);
	}
	const currentCriteria = await criteriaFromClosingIssues(context.pullRequest.closingIssues);
	const derived = criterionUnion(activationCriteria, currentCriteria);
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

const CLOSING_ISSUES_QUERY = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){id pullRequest(number:$number){id closingIssuesReferences(first:100,after:$endCursor){nodes{id number url repository{id name owner{id}}}pageInfo{hasNextPage endCursor}}}}}`;

async function fetchClosingIssueReferences(
	repoRoot: string,
	repository: PlatformRepositoryIdentity,
	pr: number,
	pullRequestId: string,
	read: PlatformRead,
): Promise<unknown[] | undefined> {
	const [owner, name, extra] = repository.nameWithOwner.split("/");
	if (owner === undefined || name === undefined || extra !== undefined) return undefined;
	const value = await readJson(
		read,
		[
			"api",
			"--hostname",
			repository.host,
			"graphql",
			"--paginate",
			"--slurp",
			"-f",
			`query=${CLOSING_ISSUES_QUERY}`,
			"-f",
			`owner=${owner}`,
			"-f",
			`name=${name}`,
			"-F",
			`number=${String(pr)}`,
		],
		repoRoot,
	);
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const nodes: unknown[] = [];
	const seenCursors = new Set<string>();
	for (let index = 0; index < value.length; index += 1) {
		const page = value[index];
		if (!object(page, ["data"])) return undefined;
		const data = page.data;
		if (
			!object(data, ["repository"]) ||
			!object(data.repository, ["id", "pullRequest"]) ||
			data.repository.id !== repository.id
		)
			return undefined;
		const pull = data.repository.pullRequest;
		if (!object(pull, ["id", "closingIssuesReferences"]) || pull.id !== pullRequestId) return undefined;
		const connection = pull.closingIssuesReferences;
		if (!object(connection, ["nodes", "pageInfo"]) || !Array.isArray(connection.nodes)) return undefined;
		if (!object(connection.pageInfo, ["hasNextPage", "endCursor"])) return undefined;
		const hasNext = connection.pageInfo.hasNextPage;
		const cursor = connection.pageInfo.endCursor;
		if (typeof hasNext !== "boolean") return undefined;
		if (hasNext) {
			if (typeof cursor !== "string" || cursor.length === 0 || seenCursors.has(cursor) || index === value.length - 1)
				return undefined;
			seenCursors.add(cursor);
		} else {
			if (index !== value.length - 1) return undefined;
			if (cursor !== null && typeof cursor !== "string") return undefined;
		}
		nodes.push(...connection.nodes);
		if (nodes.length > 10_000) return undefined;
	}
	return nodes;
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
			"id,number,url,author,baseRefName,baseRefOid,headRefName,headRefOid,headRepository",
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
		]) ||
		pullValue.number !== pr ||
		!exactHttpsUrl(pullValue.url, repositoryIdentity.host, `/${repositoryIdentity.nameWithOwner}/pull/${String(pr)}`) ||
		!text(pullValue.id) ||
		!platformNode(pullValue.author) ||
		!platformNode(pullValue.headRepository)
	)
		return undefined;
	const closingReferences = await fetchClosingIssueReferences(repoRoot, repositoryIdentity, pr, pullValue.id, read);
	if (closingReferences === undefined) return undefined;
	const closingIssues: PlatformIssueSnapshot[] = [];
	const issueIds = new Set<string>();
	const issueNumbers = new Set<number>();
	for (const entry of closingReferences) {
		if (
			!object(entry, ["id", "number", "url", "repository"]) ||
			!text(entry.id) ||
			!Number.isSafeInteger(entry.number) ||
			(entry.number as number) <= 0 ||
			!object(entry.repository, ["id", "name", "owner"]) ||
			!text(entry.repository.id) ||
			!text(entry.repository.name) ||
			!platformNode(entry.repository.owner) ||
			entry.repository.id !== repositoryIdentity.id ||
			!exactHttpsUrl(
				entry.url,
				repositoryIdentity.host,
				`/${repositoryIdentity.nameWithOwner}/issues/${String(entry.number)}`,
			) ||
			issueIds.has(entry.id) ||
			issueNumbers.has(entry.number as number)
		)
			return undefined;
		const issueValue = await readJson(
			read,
			[
				"issue",
				"view",
				String(entry.number),
				"--repo",
				[repositoryIdentity.host, repositoryIdentity.nameWithOwner].join("/"),
				"--json",
				"id,number,url,title,body",
			],
			repoRoot,
		);
		if (
			!object(issueValue, ["id", "number", "url", "title", "body"]) ||
			issueValue.id !== entry.id ||
			issueValue.number !== entry.number ||
			issueValue.url !== entry.url ||
			typeof issueValue.title !== "string" ||
			typeof issueValue.body !== "string"
		)
			return undefined;
		issueIds.add(entry.id);
		issueNumbers.add(entry.number as number);
		closingIssues.push({
			id: entry.id,
			repositoryId: repositoryIdentity.id,
			number: entry.number as number,
			title: issueValue.title,
			body: issueValue.body,
		});
	}
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
				![
					"OWNER",
					"MEMBER",
					"COLLABORATOR",
					"NONE",
					"CONTRIBUTOR",
					"FIRST_TIMER",
					"FIRST_TIME_CONTRIBUTOR",
					"MANNEQUIN",
				].includes((entry as { author_association?: unknown }).author_association as string) ||
				typeof (entry as { user?: { node_id?: unknown } }).user?.node_id !== "string" ||
				(entry as { user: { node_id: string } }).user.node_id.length === 0
			)
				return undefined;
			const id = (entry as { id: number }).id;
			ids.add(id);
			const association = (entry as { author_association: string }).author_association;
			comments.push({
				id,
				authorId: (entry as { user: { node_id: string } }).user.node_id,
				authorAssociation: ["OWNER", "MEMBER", "COLLABORATOR"].includes(association)
					? (association as PlatformAuthorAssociation)
					: "OTHER",
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
	const activation: {
		issueId: string;
		verdict: PlatformCommentSnapshot;
		snapshot: PlatformCommentSnapshot;
	}[] = [];
	const activationCriteria: string[] = [];
	for (const issue of context.pullRequest.closingIssues) {
		const comments = await fetchIssueComments(repoRoot, context.repository, issue, read);
		if (comments === undefined) return undefined;
		const pair = latestActivationPair(issue, writerId, comments);
		if (pair === undefined) return undefined;
		activation.push({ issueId: issue.id, verdict: pair.verdict, snapshot: pair.snapshot });
		activationCriteria.push(...pair.criteria);
	}
	const currentCriteria = await criteriaFromClosingIssues(context.pullRequest.closingIssues);
	return admitReviewSubject({
		context,
		writerId,
		activation,
		criteria: criterionUnion(activationCriteria, currentCriteria),
	});
}

/** Re-fetch every platform-derived component and require the sealed subject to remain exact. */
export async function refetchReviewSubject(
	repoRoot: string,
	expected: ReviewSubject,
	read: PlatformRead = runPlatformRead,
): Promise<ReviewSubject | undefined> {
	const subject = await admitReviewSubject(expected);
	if (subject === undefined) return undefined;
	const current = await fetchReviewSubject(repoRoot, subject.context.pullRequest.number, read);
	return current !== undefined && JSON.stringify(current) === JSON.stringify(subject) ? current : undefined;
}

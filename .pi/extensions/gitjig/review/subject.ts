/**
 * Inert platform-attested half of ReviewSubject.
 *
 * Warning-surface roster: EXEMPT — this module returns data or undefined and
 * emits no warning, record, or operator-facing text. Activation remains gated
 * on #241's independent writer and criteria authorities.
 */
import { runPlatformRead } from "../platform/read.ts";

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

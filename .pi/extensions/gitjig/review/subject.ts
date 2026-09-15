/**
 * Inert platform-attested half of ReviewSubject.
 *
 * Warning-surface roster: EXEMPT — this module returns data or undefined and
 * emits no warning, record, or operator-facing text. Activation remains gated
 * on #241's independent writer and criteria authorities.
 */

export interface PlatformRepositoryIdentity {
	id: string;
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

function repository(value: unknown): value is PlatformRepositoryIdentity {
	return (
		object(value, ["id", "nameWithOwner"]) &&
		text(value.id) &&
		text(value.nameWithOwner) &&
		REPOSITORY_NAME.test(value.nameWithOwner)
	);
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
	if (pull.base.repositoryId !== repositoryIdentity.id || pull.head.repositoryId !== repositoryIdentity.id)
		return undefined;
	if (pull.closingIssues.some((entry) => entry.repositoryId !== repositoryIdentity.id)) return undefined;
	return structuredClone(value) as unknown as PlatformReviewContext;
}

/**
 * The #133/#347 operator-only lifecycle projection (SPEC §5.9). It displays
 * `awaiting-author`, `blocked` and handoff state for one Issue or PR that an
 * operator act explicitly addressed, and nothing else. It never writes,
 * clears, authorizes or blocks an act: every failure is silence.
 *
 * - Identity: the repository and subject are re-read from the platform; the
 *   operator supplies only a kind and a number. A PR key carries its head, an
 *   Issue key an explicit null head. One identity snapshot reads
 *   repository, subject, repository, and needs the two repository reads to
 *   agree. A snapshot is taken before any evidence (a cache hit is returned
 *   right after it) and again immediately after the comment read and after
 *   every permission read, so the last read before display is always a
 *   repository read; any difference is silence. Residual, stated: the
 *   projection is a point-in-time observation over non-transactional reads,
 *   so a change that completes after the last read, or a replacement and
 *   restoration that both complete between two adjacent reads, cannot be
 *   detected by any read-only sequence.
 * - Admission: the handed-over #276 engine inspects each marker population;
 *   `lifecycle-attestation.ts` decides which carrying comments are attested.
 *   Labels are never read, so no label asserts a state.
 * - Bounds: every platform read at this call site passes LIFECYCLE_READ_BOUNDS
 *   (two seconds); the shared reader's default is untouched.
 * - Cache: only a successful computation is cached, for LIFECYCLE_TTL_MS,
 *   under repository/subject/head. Failure leaves no stamp, and a negative
 *   age (the clock moved back) is a miss rather than a fresh entry.
 * - Ordering: only the latest request may render, so one subject's result
 *   never lands over another's.
 *
 * Warning-surface roster: EXEMPT — this module renders only through the
 * session surface's closed lifecycle segment and emits no warning, record,
 * or operator-facing text of its own.
 */

import {
	attestAwaitingAuthorComments,
	attestTransitionComments,
	type LifecycleComment,
} from "./lifecycle-attestation.ts";
import type { PlatformReadBounds } from "./platform/read.ts";
import { runPlatformRead } from "./platform/read.ts";
import { type PublishRepository, resolvePublishRepository } from "./publish/executor.ts";
import type { LifecycleSegment, LifecycleState, SessionSurface } from "./session-surface.ts";

type Engine = typeof import("../../../.github/workflows/gitjig-lifecycle.mjs");

/** SPEC §5.9: a two-second bound at this projection's own platform call sites. */
export const LIFECYCLE_READ_BOUNDS: PlatformReadBounds = Object.freeze({
	timeoutMs: 2_000,
	graceMs: 250,
	maxBytes: 4 * 1024 * 1024,
});

/** SPEC §5.9: a successful computation is reused for five minutes. */
export const LIFECYCLE_TTL_MS = 5 * 60 * 1_000;

export type LifecycleTarget = { kind: "issue" | "pull"; number: number };

type Computed = { segment: LifecycleSegment; freshKey?: string };

type Read = (argv: string[], repoRoot: string, bounds: PlatformReadBounds) => Promise<string | undefined>;

export interface LifecycleProjectionSeams {
	read: Read;
	now: () => number;
	repository: (repoRoot: string) => PublishRepository | undefined;
	engine: () => Promise<Engine | undefined>;
}

const OID = /^[0-9a-f]{40}$/;

async function loadEngine(): Promise<Engine | undefined> {
	try {
		return await import("../../../.github/workflows/gitjig-lifecycle.mjs");
	} catch {
		return undefined;
	}
}

const DEFAULT_SEAMS: LifecycleProjectionSeams = {
	read: runPlatformRead,
	now: Date.now,
	repository: resolvePublishRepository,
	engine: loadEngine,
};

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(output: string | undefined): unknown {
	if (output === undefined) return undefined;
	try {
		return JSON.parse(output);
	} catch {
		return undefined;
	}
}

/** The complete comment population, or undefined when any page or comment is unreadable. */
function commentPopulation(output: string | undefined): LifecycleComment[] | undefined {
	const pages = json(output);
	if (!Array.isArray(pages) || !pages.every(Array.isArray)) return undefined;
	const comments: LifecycleComment[] = [];
	const ids = new Set<number>();
	for (const page of pages as unknown[][]) {
		for (const comment of page) {
			if (!object(comment) || !Number.isSafeInteger(comment.id) || (comment.id as number) <= 0) return undefined;
			const user = comment.user;
			if (typeof comment.body !== "string" || !object(user) || typeof user.node_id !== "string") return undefined;
			if (user.node_id.length === 0 || ids.has(comment.id as number)) return undefined;
			ids.add(comment.id as number);
			comments.push({
				id: comment.id as number,
				authorId: user.node_id,
				...(typeof user.login === "string" ? { authorLogin: user.login } : {}),
				...(typeof user.type === "string" ? { authorType: user.type } : {}),
				body: comment.body,
			});
		}
	}
	return comments;
}

export class LifecycleProjection {
	private generation = 0;
	private readonly cache = new Map<string, { at: number; segment: LifecycleSegment }>();
	private readonly repoRoot: string;
	private readonly surface: SessionSurface;
	private readonly seams: LifecycleProjectionSeams;

	constructor(repoRoot: string, surface: SessionSurface, seams: LifecycleProjectionSeams = DEFAULT_SEAMS) {
		this.repoRoot = repoRoot;
		this.surface = surface;
		this.seams = seams;
	}

	/** Compute and display one explicitly addressed subject; never throws, never blocks. */
	async request(target: LifecycleTarget): Promise<"displayed" | "silent" | "superseded"> {
		if (!this.surface.visible) return "silent";
		const generation = ++this.generation;
		const epoch = this.surface.epoch;
		// The previous subject stops being shown the moment a new one is addressed.
		this.surface.setLifecycle(undefined);
		let computed: Computed | undefined;
		try {
			computed = await this.compute(target);
		} catch {
			computed = undefined;
		}
		// A newer request, or a new session attach, makes this result stale:
		// it neither renders nor reaches the cache.
		if (generation !== this.generation || epoch !== this.surface.epoch) return "superseded";
		if (computed?.freshKey !== undefined)
			this.cache.set(computed.freshKey, { at: this.seams.now(), segment: computed.segment });
		const segment = computed?.segment;
		if (segment !== undefined) this.surface.setLifecycle(segment);
		return segment === undefined ? "silent" : "displayed";
	}

	private read(argv: string[]): Promise<string | undefined> {
		return this.seams.read(argv, this.repoRoot, LIFECYCLE_READ_BOUNDS);
	}

	/** A fresh computation carries its cache key; the caller caches it only if still current. */
	private async compute(target: LifecycleTarget): Promise<Computed | undefined> {
		if ((target.kind !== "issue" && target.kind !== "pull") || !Number.isSafeInteger(target.number)) return undefined;
		if (target.number <= 0) return undefined;
		const repository = this.seams.repository(this.repoRoot);
		if (repository === undefined) return undefined;
		const { host, nameWithOwner } = repository;
		const api = (path: string, ...rest: string[]) => this.read(["api", "--hostname", host, ...rest, path]);

		// The complete identity (repository node id and, for a PR, its head) is
		// read before and again after every other read, including on a cache
		// hit. Both snapshots must be equal, so nothing read across a repository
		// replacement or a PR head change is displayed or cached.
		const repositoryNode = async (): Promise<string | undefined> => {
			const repo = json(await api(`repos/${nameWithOwner}`));
			if (!object(repo) || typeof repo.node_id !== "string" || repo.node_id.length === 0) return undefined;
			return repo.full_name === nameWithOwner ? repo.node_id : undefined;
		};
		// One snapshot reads repository, subject, repository: the subject read is
		// enclosed by two equal repository reads, since an Issue response carries
		// no repository node id of its own.
		const identity = async (): Promise<{ key: string; repositoryId: string; head: string | null } | undefined> => {
			const repositoryId = await repositoryNode();
			if (repositoryId === undefined) return undefined;
			let head: string | null = null;
			if (target.kind === "pull") {
				const pull = json(await api(`repos/${nameWithOwner}/pulls/${String(target.number)}`));
				const base = object(pull) && object(pull.base) && object(pull.base.repo) ? pull.base.repo : undefined;
				const pullHead = object(pull) && object(pull.head) ? pull.head.sha : undefined;
				if (!object(pull) || pull.number !== target.number) return undefined;
				if (base?.node_id !== repositoryId) return undefined;
				if (typeof pullHead !== "string" || !OID.test(pullHead)) return undefined;
				head = pullHead;
			} else {
				const issue = json(await api(`repos/${nameWithOwner}/issues/${String(target.number)}`));
				if (!object(issue) || issue.number !== target.number || Object.hasOwn(issue, "pull_request")) return undefined;
			}
			if ((await repositoryNode()) !== repositoryId) return undefined;
			return {
				key: JSON.stringify([host, nameWithOwner, repositoryId, target.kind, target.number, head]),
				repositoryId,
				head,
			};
		};
		const before = await identity();
		if (before === undefined) return undefined;
		const { key, repositoryId, head } = before;
		const unchanged = async (): Promise<boolean> => (await identity())?.key === key;

		const cached = this.cache.get(key);
		const age = cached === undefined ? -1 : this.seams.now() - cached.at;
		if (cached !== undefined && age >= 0 && age < LIFECYCLE_TTL_MS) return { segment: cached.segment };

		// Evidence counts only if the identity still holds right after it was read.
		const bracketed = async (path: string, ...rest: string[]): Promise<string | undefined> => {
			const value = await api(path, ...rest);
			return (await unchanged()) ? value : undefined;
		};

		const engine = await this.seams.engine();
		if (engine === undefined) return undefined;
		const comments = commentPopulation(
			await bracketed(`repos/${nameWithOwner}/issues/${String(target.number)}/comments`, "--paginate", "--slurp"),
		);
		if (comments === undefined) return undefined;

		// A role counts only for the user the platform reports for that login,
		// which must be the carrying comment's own node id and login.
		const permissions = new Map<string, Promise<string | undefined>>();
		const permissionOf = (comment: LifecycleComment): Promise<string | undefined> => {
			const login = comment.authorLogin ?? "";
			const memo = JSON.stringify([login, comment.authorId]);
			let permission = permissions.get(memo);
			if (permission === undefined) {
				permission = bracketed(`repos/${nameWithOwner}/collaborators/${encodeURIComponent(login)}/permission`).then(
					(output) => {
						const response = json(output);
						const account = object(response) && object(response.user) ? response.user : undefined;
						if (account?.node_id !== comment.authorId || account?.login !== login) return undefined;
						return object(response) && typeof response.role_name === "string" ? response.role_name : undefined;
					},
				);
				permissions.set(memo, permission);
			}
			return permission;
		};

		const awaiting = engine.inspectAwaitingAuthorPopulation(
			await attestAwaitingAuthorComments(engine, comments, repositoryId, permissionOf),
			target.kind,
		);
		const transitions = await attestTransitionComments(engine, comments, repositoryId, permissionOf);
		const blocked = engine.inspectBlockedPopulation(transitions);
		const handoff = engine.inspectHandoffPopulation(transitions);
		const populations: Array<
			[LifecycleState, { ok: boolean; current?: { record: { subjectHead: unknown; baseHead: unknown } }[] }]
		> = [
			["awaiting-author", awaiting],
			["blocked", blocked],
			["handoff", handoff],
		];
		const states: LifecycleState[] = [];
		for (const [state, population] of populations) {
			if (!population.ok) return undefined;
			if ((population.current ?? []).length > 0) states.push(state);
		}
		// Every marker and terminal is checked, current or terminalized: one for
		// another head is stale evidence, and a base head that contradicts the
		// subject kind (an Issue has none; a PR has one) is contradictory
		// evidence; either makes the whole population silent.
		const contradicts = (record: { subjectHead: unknown; baseHead: unknown } | undefined) =>
			record?.subjectHead !== head || (head === null ? record.baseHead !== null : typeof record.baseHead !== "string");
		const markers = Object.values(engine.RECORD_MARKERS);
		for (const comment of comments)
			for (const marker of markers)
				if (comment.body.startsWith(marker) && contradicts(engine.parseMarkedRecord(comment.body, marker)))
					return undefined;
		const segment: LifecycleSegment = {
			subject: target.kind,
			number: target.number,
			shortHead: head === null ? null : head.slice(0, 7),
			states,
		};
		return { segment, freshKey: key };
	}
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseLifecycleTarget, registerLifecycleCommand } from "../.pi/extensions/gitjig/commands/lifecycle.ts";
import {
	LIFECYCLE_READ_BOUNDS,
	LIFECYCLE_TTL_MS,
	LifecycleProjection,
	type LifecycleProjectionSeams,
} from "../.pi/extensions/gitjig/lifecycle-projection.ts";
import type { PlatformReadBounds } from "../.pi/extensions/gitjig/platform/read.ts";
import { SessionSurface } from "../.pi/extensions/gitjig/session-surface.ts";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const BASE = "c".repeat(40);
const NOW = "2026-09-30T00:00:00.000Z";
const BLOCKED = "<!-- lifecycle-blocked-record: v1 -->";
const BLOCKED_TERMINAL = "<!-- lifecycle-blocked-terminal: v1 -->";
const HANDOFF = "<!-- lifecycle-handoff-record: v1 -->";
const AWAITING = "<!-- lifecycle-awaiting-author-record: v1 -->";
const HANDOFF_TERMINAL = "<!-- lifecycle-handoff-terminal: v1 -->";

const marked = (marker: string, record: unknown) => `${marker}\n\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\``;
const user = (login: string) => ({ node_id: `U_${login}`, login, type: "User" });
const bot = { node_id: "BOT_actions", login: "github-actions[bot]", type: "Bot" };
const blocked = (subjectHead: string | null) => ({
	condition: "waiting",
	recovery: "unblock",
	observedAt: NOW,
	subjectHead,
	baseHead: subjectHead === null ? null : BASE,
});
const handoff = (subjectHead: string | null) => ({
	cause: "cause",
	recipient: "maintainer",
	reentry: "plan",
	observedAt: NOW,
	subjectHead,
	baseHead: subjectHead === null ? null : BASE,
});

const awaitingRecord = (producer: string, producerKind: string) => ({
	producer,
	producerKind,
	observedAt: NOW,
	subjectHead: HEAD,
	baseHead: BASE,
});
const awaitingTerminal = (clearerId: string) => ({
	recordCommentId: 1,
	clearerId,
	clearedAt: NOW,
	cause: "pull-synchronize",
	subjectHead: HEAD,
	baseHead: BASE,
});
const AWAITING_TERMINAL = "<!-- lifecycle-awaiting-author-terminal: v1 -->";
type Comment = { id: number; user: unknown; body: string };
type World = {
	repo?: unknown;
	pull?: unknown;
	issue?: unknown;
	comments?: Comment[] | "unavailable";
	/** When set, the comment read returns these pages instead of one page of `comments`. */
	pages?: Comment[][];
	permissions?: Record<string, string | undefined>;
	engine?: "unavailable" | "throws";
	/** When set, every platform read rejects instead of answering. */
	readThrows?: boolean;
	/** The locally resolved platform repository; defaults to github.com o/r. */
	location?: { host: string; nameWithOwner: string };
	/** Per-host comment populations, overriding `comments` for that host. */
	commentsByHost?: Record<string, Comment[]>;
	/** The node id the permission endpoint reports for a login; defaults to `U_<login>`. */
	permissionNodes?: Record<string, string>;
	/** The login the permission endpoint reports for a requested login; defaults to the same login. */
	permissionLogins?: Record<string, string>;
	/** Comment populations for Issues other than #7, which are otherwise empty. */
	commentsByNumber?: Record<number, Comment[]>;
	/** Runs once, immediately after the comment population is read. */
	afterComments?: () => void;
	/** Runs once, immediately after the Issue or PR subject is read. */
	afterSubject?: () => void;
	/** Runs once, immediately after a collaborator permission is read. */
	afterPermission?: () => void;
	/** Run in order, one per Issue or PR subject read. */
	subjectHooks?: Array<() => void>;
	/** Run in order, one per collaborator permission read. */
	permissionHooks?: Array<() => void>;
};

const theme = { fg: (color: string, text: string) => `[${color}]${text}` } as never;

function harness(world: World, options: { ui?: boolean; clock?: { now: number } } = {}) {
	const statuses: Array<string | undefined> = [];
	const surface = new SessionSurface();
	if (options.ui !== false)
		surface.attach({
			hasUI: true,
			ui: { setStatus: (_key: string, text?: string) => statuses.push(text), theme },
		} as never);
	const reads: Array<{ argv: string[]; bounds: PlatformReadBounds }> = [];
	const clock = options.clock ?? { now: 0 };
	const seams: LifecycleProjectionSeams = {
		repository: () => world.location ?? { host: "github.com", nameWithOwner: "o/r" },
		now: () => clock.now,
		engine: async () => {
			if (world.engine === "throws") throw new Error("engine load failure");
			return world.engine === "unavailable" ? undefined : await import("../.github/workflows/gitjig-lifecycle.mjs");
		},
		read: async (argv, _root, bounds) => {
			reads.push({ argv, bounds });
			if (world.readThrows === true) throw new Error("platform read failure");
			const location = world.location ?? { host: "github.com", nameWithOwner: "o/r" };
			const requested = argv[argv.length - 1] ?? "";
			const path = requested.startsWith(`repos/${location.nameWithOwner}`)
				? `repos/o/r${requested.slice(`repos/${location.nameWithOwner}`.length)}`
				: requested;
			if (path === "repos/o/r")
				return JSON.stringify(world.repo ?? { node_id: "R", full_name: location.nameWithOwner });
			const once = (hook: "afterComments" | "afterSubject" | "afterPermission") => {
				const run = world[hook];
				world[hook] = undefined;
				run?.();
			};
			if (path === "repos/o/r/pulls/7") {
				const subject = JSON.stringify(
					world.pull ?? { number: 7, head: { sha: HEAD }, base: { repo: { full_name: "o/r", node_id: "R" } } },
				);
				once("afterSubject");
				world.subjectHooks?.shift()?.();
				return subject;
			}
			if (path === "repos/o/r/issues/7") {
				const subject = JSON.stringify(world.issue ?? { number: 7, labels: [] });
				once("afterSubject");
				world.subjectHooks?.shift()?.();
				return subject;
			}
			if (path === "repos/o/r/issues/7/comments") {
				const population =
					world.comments === "unavailable"
						? undefined
						: JSON.stringify(world.pages ?? [world.commentsByHost?.[argv[2]] ?? world.comments ?? []]);
				once("afterComments");
				return population;
			}
			const otherIssue = /^repos\/o\/r\/issues\/([1-9][0-9]*)(\/comments)?$/.exec(path);
			if (otherIssue) {
				const number = Number(otherIssue[1]);
				return otherIssue[2] === undefined
					? JSON.stringify({ number, labels: [] })
					: JSON.stringify([world.commentsByNumber?.[number] ?? []]);
			}
			const permission = /^repos\/o\/r\/collaborators\/(.+)\/permission$/.exec(path ?? "");
			if (permission) {
				const login = decodeURIComponent(permission[1]);
				const role = (world.permissions ?? { writer: "write" })[login];
				once("afterPermission");
				world.permissionHooks?.shift()?.();
				return role === undefined
					? undefined
					: JSON.stringify({
							permission: role,
							role_name: role,
							user: {
								login: world.permissionLogins?.[login] ?? login,
								node_id: world.permissionNodes?.[login] ?? `U_${login}`,
							},
						});
			}
			throw new Error(`unexpected read ${argv.join(" ")}`);
		},
	};
	const projection = new LifecycleProjection("/repo", surface, seams);
	const lifecycle = () => {
		const last = statuses.at(-1) ?? "";
		const at = last.indexOf(" · ", last.indexOf(" · ") + 1);
		return at < 0 ? undefined : last.slice(at + 3);
	};
	return {
		projection,
		statuses,
		reads,
		clock,
		surface,
		lifecycle,
		commentReads: () => reads.filter(({ argv }) => argv.includes("--paginate")).length,
	};
}

/** Every projection call is one of three GET-only argv shapes over this subject's own routes. */
function assertReadOnly(reads: Array<{ argv: string[] }>, host = "github.com", name = "o/r"): void {
	const route = new RegExp(
		`^repos/${name.replace("/", "\\/")}(?:/pulls/7|/issues/[1-9][0-9]*(?:/comments)?|/collaborators/[^/]+/permission)?$`,
	);
	for (const { argv } of reads) {
		const path = argv.at(-1) ?? "";
		const middle = JSON.stringify(argv.slice(3, -1));
		assert.deepEqual(argv.slice(0, 3), ["api", "--hostname", host], JSON.stringify(argv));
		assert.ok(route.test(path), `unexpected route: ${JSON.stringify(argv)}`);
		assert.ok(
			[JSON.stringify([]), JSON.stringify(["--paginate", "--slurp"])].includes(middle),
			`not a read-only argv shape: ${JSON.stringify(argv)}`,
		);
	}
}

describe("#347 lifecycle projection", () => {
	it("projects a User-attested blocked Issue record with the two-second bound on every read and no label read", async () => {
		const h = harness({ comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(null)) }] });
		assert.equal(await h.projection.request({ kind: "issue", number: 7 }), "displayed");
		assert.equal(h.lifecycle(), "[warning]issue #7 blocked");
		assert.ok(h.reads.length >= 4);
		for (const { argv, bounds } of h.reads) {
			assert.deepEqual(bounds, LIFECYCLE_READ_BOUNDS);
			assert.ok(!argv.some((part) => part.includes("labels")), "labels are never read");
		}
		assertReadOnly(h.reads);
		assert.equal(LIFECYCLE_READ_BOUNDS.timeoutMs, 2_000);
		assert.equal(LIFECYCLE_TTL_MS, 300_000);
	});

	it("projects awaiting-author and handoff for the attested PR head", async () => {
		const h = harness({
			comments: [
				{
					id: 1,
					user: bot,
					body: marked(AWAITING, {
						producer: "BOT_actions",
						producerKind: "human-changes-requested",
						observedAt: NOW,
						subjectHead: HEAD,
						baseHead: BASE,
					}),
				},
				{ id: 2, user: user("writer"), body: marked(HANDOFF, handoff(HEAD)) },
				{ id: 3, user: user("writer"), body: "ordinary prose" },
			],
		});
		assert.equal(await h.projection.request({ kind: "pull", number: 7 }), "displayed");
		assert.equal(h.lifecycle(), "[warning]PR #7@aaaaaaa awaiting-author, handoff");
		assertReadOnly(h.reads);
	});

	it("accepts WRITE, MAINTAIN and ADMIN carriers for blocked and handoff records and terminals", async () => {
		for (const role of ["write", "maintain", "admin"]) {
			const h = harness({
				comments: [
					{ id: 1, user: user("carrier"), body: marked(BLOCKED, blocked(null)) },
					{ id: 2, user: user("carrier"), body: marked(HANDOFF, handoff(null)) },
					{ id: 3, user: user("carrier"), body: marked(HANDOFF, handoff(null)) },
					{ id: 5, user: user("carrier"), body: marked(BLOCKED, blocked(null)) },
					{
						id: 6,
						user: user("carrier"),
						body: marked(BLOCKED_TERMINAL, {
							recordCommentId: 5,
							transition: "blocked-clear",
							observedAt: NOW,
							subjectHead: null,
							baseHead: null,
						}),
					},
					{
						id: 4,
						user: user("carrier"),
						body: marked(HANDOFF_TERMINAL, {
							recordCommentId: 3,
							transition: "handoff-reentry",
							observedAt: NOW,
							subjectHead: null,
							baseHead: null,
						}),
					},
				],
				permissions: { carrier: role },
			});
			assert.equal(await h.projection.request({ kind: "issue", number: 7 }), "displayed", role);
			assert.equal(h.lifecycle(), "[warning]issue #7 blocked, handoff", role);
		}
	});

	it("shows an explicit empty result, and a lifecycle label alone asserts nothing", async () => {
		const h = harness({ issue: { number: 7, labels: [{ name: "blocked" }, { name: "awaiting-author" }] } });
		assert.equal(await h.projection.request({ kind: "issue", number: 7 }), "displayed");
		assert.equal(h.lifecycle(), "[dim]issue #7 no active lifecycle state");
	});

	it("is silent on every inadmissible population instead of guessing a state", async () => {
		const cases: Array<[string, World, "issue" | "pull"]> = [
			["stale PR head", { comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(OTHER)) }] }, "pull"],
			[
				"Issue record naming a base head",
				{ comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, { ...blocked(null), baseHead: BASE }) }] },
				"issue",
			],
			[
				"PR record without a base head",
				{ comments: [{ id: 1, user: user("writer"), body: marked(HANDOFF, { ...handoff(HEAD), baseHead: null }) }] },
				"pull",
			],
			[
				"Issue record naming a head",
				{ comments: [{ id: 1, user: user("writer"), body: marked(HANDOFF, handoff(HEAD)) }] },
				"issue",
			],
			[
				"Bot-carried blocked record",
				{ comments: [{ id: 1, user: bot, body: marked(BLOCKED, blocked(null)) }] },
				"issue",
			],
			[
				"Bot carrier holding WRITE",
				{
					comments: [{ id: 1, user: bot, body: marked(BLOCKED, blocked(null)) }],
					permissions: { "github-actions[bot]": "write" },
					permissionNodes: { "github-actions[bot]": bot.node_id },
				},
				"issue",
			],
			[
				"stale terminalized blocked pair",
				{
					comments: [
						{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(OTHER)) },
						{
							id: 2,
							user: user("writer"),
							body: marked(BLOCKED_TERMINAL, {
								recordCommentId: 1,
								transition: "blocked-clear",
								observedAt: NOW,
								subjectHead: OTHER,
								baseHead: BASE,
							}),
						},
					],
				},
				"pull",
			],
			[
				"awaiting-author terminal on another head",
				{
					comments: [
						{ id: 1, user: user("writer"), body: marked(AWAITING, awaitingRecord("U_writer", "resolver-repair")) },
						{
							id: 2,
							user: bot,
							body: marked(AWAITING_TERMINAL, { ...awaitingTerminal(bot.login), subjectHead: OTHER }),
						},
					],
				},
				"pull",
			],
			[
				"read-only carrier",
				{
					comments: [{ id: 1, user: user("reader"), body: marked(BLOCKED, blocked(null)) }],
					permissions: { reader: "read" },
				},
				"issue",
			],
			[
				"unreadable permission",
				{ comments: [{ id: 1, user: user("ghost"), body: marked(BLOCKED, blocked(null)) }], permissions: {} },
				"issue",
			],
			["malformed record", { comments: [{ id: 1, user: user("writer"), body: `${BLOCKED}\nbroken` }] }, "issue"],
			[
				"duplicate current records",
				{
					comments: [
						{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(null)) },
						{ id: 2, user: user("writer"), body: marked(BLOCKED, blocked(null)) },
					],
				},
				"issue",
			],
			[
				"dangling terminal",
				{
					comments: [
						{
							id: 2,
							user: user("writer"),
							body: marked(BLOCKED_TERMINAL, {
								recordCommentId: 1,
								transition: "blocked-clear",
								observedAt: NOW,
								subjectHead: null,
								baseHead: null,
							}),
						},
					],
				},
				"issue",
			],
			[
				"terminal contradicting its record's head",
				{
					comments: [
						{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(HEAD)) },
						{
							id: 2,
							user: user("writer"),
							body: marked(BLOCKED_TERMINAL, {
								recordCommentId: 1,
								transition: "blocked-clear",
								observedAt: NOW,
								subjectHead: OTHER,
								baseHead: BASE,
							}),
						},
					],
				},
				"pull",
			],
			[
				"unauthorized blocked terminal carrier",
				{
					comments: [
						{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(null)) },
						{
							id: 2,
							user: user("reader"),
							body: marked(BLOCKED_TERMINAL, {
								recordCommentId: 1,
								transition: "blocked-clear",
								observedAt: NOW,
								subjectHead: null,
								baseHead: null,
							}),
						},
					],
					permissions: { writer: "write", reader: "read" },
				},
				"issue",
			],
			[
				"unauthorized handoff record carrier",
				{
					comments: [{ id: 1, user: user("reader"), body: marked(HANDOFF, handoff(null)) }],
					permissions: { reader: "triage" },
				},
				"issue",
			],
			[
				"unauthorized handoff terminal carrier",
				{
					comments: [
						{ id: 1, user: user("writer"), body: marked(HANDOFF, handoff(null)) },
						{
							id: 2,
							user: user("reader"),
							body: marked(HANDOFF_TERMINAL, {
								recordCommentId: 1,
								transition: "handoff-reentry",
								observedAt: NOW,
								subjectHead: null,
								baseHead: null,
							}),
						},
					],
					permissions: { writer: "write", reader: "read" },
				},
				"issue",
			],
			["Issue number mismatch", { issue: { number: 8 } }, "issue"],
			[
				"PR number mismatch",
				{ pull: { number: 8, head: { sha: HEAD }, base: { repo: { full_name: "o/r", node_id: "R" } } } },
				"pull",
			],
			[
				"PR base repository identity mismatch",
				{ pull: { number: 7, head: { sha: HEAD }, base: { repo: { full_name: "o/r", node_id: "R_other" } } } },
				"pull",
			],
			[
				"repository replaced while the population was read",
				{
					comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(null)) }],
				},
				"issue",
			],
			["unavailable comments", { comments: "unavailable" }, "issue"],
			["repository identity mismatch", { repo: { node_id: "R", full_name: "x/y" } }, "issue"],
			["Issue number resolving to a PR", { issue: { number: 7, pull_request: {} } }, "issue"],
			[
				"PR from another base repository",
				{ pull: { number: 7, head: { sha: HEAD }, base: { repo: { full_name: "x/y" } } } },
				"pull",
			],
			[
				"PR without a full head",
				{ pull: { number: 7, head: { sha: "abc" }, base: { repo: { full_name: "o/r", node_id: "R" } } } },
				"pull",
			],
			["engine unavailable", { engine: "unavailable" }, "issue"],
		];
		for (const [name, world, kind] of cases) {
			if (name === "repository replaced while the population was read")
				world.afterComments = () => {
					world.repo = { node_id: "R_replacement", full_name: "o/r" };
				};
			const h = harness(world);
			assert.equal(await h.projection.request({ kind, number: 7 }), "silent", name);
			assert.equal(h.lifecycle(), undefined, name);
		}
	});

	it("reads the complete paginated comment population", async () => {
		const h = harness({
			pages: [
				[{ id: 1, user: user("writer"), body: "ordinary prose" }],
				[{ id: 2, user: user("writer"), body: marked(HANDOFF, handoff(null)) }],
			],
		});
		assert.equal(await h.projection.request({ kind: "issue", number: 7 }), "displayed");
		assert.equal(h.lifecycle(), "[warning]issue #7 handoff");
		const duplicated = harness({
			pages: [
				[{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(null)) }],
				[{ id: 1, user: user("writer"), body: "same id on a later page" }],
			],
		});
		assert.equal(await duplicated.projection.request({ kind: "issue", number: 7 }), "silent");
	});

	it("rebinds the whole identity after every read, including a cache hit", async () => {
		const pr: World = { comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(HEAD)) }] };
		pr.afterComments = () => {
			pr.pull = { number: 7, head: { sha: OTHER }, base: { repo: { full_name: "o/r", node_id: "R" } } };
		};
		const moved = harness(pr);
		assert.equal(await moved.projection.request({ kind: "pull", number: 7 }), "silent", "head moved during the read");
		pr.pull = undefined;
		assert.equal(await moved.projection.request({ kind: "pull", number: 7 }), "displayed");
		assert.equal(moved.commentReads(), 2, "the moved-head attempt left no cache stamp");

		const issue: World = { comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(null)) }] };
		const cached = harness(issue);
		assert.equal(await cached.projection.request({ kind: "issue", number: 7 }), "displayed");
		issue.afterSubject = () => {
			issue.repo = { node_id: "R_replacement", full_name: "o/r" };
		};
		assert.equal(
			await cached.projection.request({ kind: "issue", number: 7 }),
			"silent",
			"cache hit across a replacement",
		);
		assert.equal(cached.commentReads(), 1);

		const late: World = {
			comments: [{ id: 1, user: user("carrier"), body: marked(HANDOFF, handoff(null)) }],
			permissions: { carrier: "write" },
		};
		late.afterPermission = () => {
			late.repo = { node_id: "R_replacement", full_name: "o/r" };
		};
		const permission = harness(late);
		assert.equal(
			await permission.projection.request({ kind: "issue", number: 7 }),
			"silent",
			"replacement during a permission read",
		);
	});

	it("rebinds identity right after each evidence read, so an ABA replacement is silent", async () => {
		const toR2 = (world: World) => () => {
			world.repo = { node_id: "R2", full_name: "o/r" };
		};
		const toR = (world: World) => () => {
			world.repo = { node_id: "R", full_name: "o/r" };
		};
		const across: World = {
			comments: [
				{ id: 1, user: user("first"), body: marked(BLOCKED, blocked(null)) },
				{ id: 2, user: user("second"), body: marked(HANDOFF, handoff(null)) },
			],
			permissions: { first: "write", second: "write" },
		};
		across.permissionHooks = [toR2(across), toR(across)];
		const permissions = harness(across);
		assert.equal(
			await permissions.projection.request({ kind: "issue", number: 7 }),
			"silent",
			"R→R2→R across permission reads",
		);

		const aroundComments: World = {
			comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(null)) }],
		};
		aroundComments.afterComments = toR2(aroundComments);
		aroundComments.permissionHooks = [toR(aroundComments)];
		const comments = harness(aroundComments);
		assert.equal(
			await comments.projection.request({ kind: "issue", number: 7 }),
			"silent",
			"R→R2 at the comment read, back to R later",
		);
	});

	it("encloses each subject read between equal repository reads", async () => {
		for (const kind of ["issue", "pull"] as const) {
			const world: World = { comments: [] };
			world.subjectHooks = [
				() => {},
				() => {
					world.repo = { node_id: "R2", full_name: "o/r" };
				},
			];
			const h = harness(world);
			assert.equal(
				await h.projection.request({ kind, number: 7 }),
				"silent",
				`${kind}: replaced during the last subject read`,
			);
		}
	});

	it("clears a record through an authorized terminal of its own transition", async () => {
		for (const [marker, terminalMarker, transition, record] of [
			[BLOCKED, BLOCKED_TERMINAL, "blocked-clear", blocked(null)],
			[HANDOFF, HANDOFF_TERMINAL, "handoff-reentry", handoff(null)],
		] as const) {
			const h = harness({
				comments: [
					{ id: 1, user: user("writer"), body: marked(marker, record) },
					{
						id: 2,
						user: user("writer"),
						body: marked(terminalMarker, {
							recordCommentId: 1,
							transition,
							observedAt: NOW,
							subjectHead: null,
							baseHead: null,
						}),
					},
				],
			});
			assert.equal(await h.projection.request({ kind: "issue", number: 7 }), "displayed", transition);
			assert.equal(h.lifecycle(), "[dim]issue #7 no active lifecycle state", transition);
		}
	});

	it("keys the cache by platform host and repository name as well as node id", async () => {
		for (const next of [
			{ host: "ghe.example", nameWithOwner: "o/r" },
			{ host: "github.com", nameWithOwner: "o/renamed" },
		]) {
			const world: World = { comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(null)) }] };
			const h = harness(world);
			assert.equal(await h.projection.request({ kind: "issue", number: 7 }), "displayed");
			world.location = next;
			world.commentsByHost = { [next.host]: [] };
			world.comments = [];
			assert.equal(await h.projection.request({ kind: "issue", number: 7 }), "displayed", next.host);
			assert.equal(
				h.commentReads(),
				2,
				`${next.host} ${next.nameWithOwner} is a different key despite the same node id`,
			);
			assert.equal(h.lifecycle(), "[dim]issue #7 no active lifecycle state");
			assertReadOnly(h.reads.slice(-4), next.host, next.nameWithOwner);
		}
	});

	it("keys the cache by subject number within one repository", async () => {
		const h = harness({
			comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(null)) }],
			commentsByNumber: { 8: [] },
		});
		assert.equal(await h.projection.request({ kind: "issue", number: 7 }), "displayed");
		assert.equal(h.lifecycle(), "[warning]issue #7 blocked");
		assert.equal(await h.projection.request({ kind: "issue", number: 8 }), "displayed");
		assert.equal(h.commentReads(), 2, "Issue #8 is a different key from Issue #7");
		assert.equal(h.lifecycle(), "[dim]issue #8 no active lifecycle state");
		assertReadOnly(h.reads);
	});

	it("keys the cache by repository identity as well as subject and head", async () => {
		const world: World = { comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(null)) }] };
		const h = harness(world);
		await h.projection.request({ kind: "issue", number: 7 });
		world.repo = { node_id: "R_other", full_name: "o/r" };
		world.comments = [];
		assert.equal(await h.projection.request({ kind: "issue", number: 7 }), "displayed");
		assert.equal(h.commentReads(), 2, "a different repository identity is a different key");
		assert.equal(h.lifecycle(), "[dim]issue #7 no active lifecycle state");
	});

	it("caches only success for five minutes under repository/subject/head", async () => {
		const world: World = { comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(HEAD)) }] };
		const h = harness(world);
		await h.projection.request({ kind: "pull", number: 7 });
		assert.equal(h.commentReads(), 1);
		h.clock.now = LIFECYCLE_TTL_MS - 1;
		await h.projection.request({ kind: "pull", number: 7 });
		assert.equal(h.commentReads(), 1, "fresh cache is reused");
		h.clock.now = LIFECYCLE_TTL_MS;
		await h.projection.request({ kind: "pull", number: 7 });
		assert.equal(h.commentReads(), 2, "expired cache is recomputed");
		world.pull = { number: 7, head: { sha: OTHER }, base: { repo: { full_name: "o/r", node_id: "R" } } };
		assert.equal(
			await h.projection.request({ kind: "pull", number: 7 }),
			"silent",
			"new head is a new key; the old record is stale",
		);
		assert.equal(h.commentReads(), 3);

		const failing: World = { comments: "unavailable" };
		const f = harness(failing);
		assert.equal(await f.projection.request({ kind: "issue", number: 7 }), "silent");
		failing.comments = [];
		assert.equal(await f.projection.request({ kind: "issue", number: 7 }), "displayed");
		assert.equal(f.commentReads(), 2, "a failure leaves no TTL stamp");
	});

	it("treats a negative cache age as a miss", async () => {
		const world: World = { comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(HEAD)) }] };
		const h = harness(world, { clock: { now: LIFECYCLE_TTL_MS } });
		assert.equal(await h.projection.request({ kind: "pull", number: 7 }), "displayed");
		assert.equal(h.commentReads(), 1);
		h.clock.now = 0;
		world.comments = [];
		assert.equal(await h.projection.request({ kind: "pull", number: 7 }), "displayed");
		assert.equal(h.commentReads(), 2, "a clock moved back does not keep the old entry fresh");
		assert.equal(h.lifecycle(), "[dim]PR #7@aaaaaaa no active lifecycle state");
	});

	it("binds a permission to the carrying comment's own node id and login", async () => {
		const cases: Array<[string, World]> = [
			[
				"login reassigned to another node",
				{
					comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(null)) }],
					permissionNodes: { writer: "U_someone_else" },
				},
			],
			[
				"permission response for another login",
				{
					comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(null)) }],
					permissionLogins: { writer: "renamed" },
				},
			],
		];
		for (const [name, world] of cases) {
			const h = harness(world);
			assert.equal(await h.projection.request({ kind: "issue", number: 7 }), "silent", name);
		}
	});

	it("keeps #276's awaiting-author attestation rules for every carrier kind", async () => {
		const pull = { kind: "pull" as const, number: 7 };
		const cleared = harness({
			comments: [
				{ id: 1, user: bot, body: marked(AWAITING, awaitingRecord("BOT_actions", "human-changes-requested")) },
				{ id: 2, user: bot, body: marked(AWAITING_TERMINAL, awaitingTerminal("github-actions[bot]")) },
			],
		});
		assert.equal(await cleared.projection.request(pull), "displayed", "first-party bot terminal clears");
		assert.equal(cleared.lifecycle(), "[dim]PR #7@aaaaaaa no active lifecycle state");
		const resolver = harness({
			comments: [
				{ id: 1, user: user("writer"), body: marked(AWAITING, awaitingRecord("U_writer", "resolver-repair")) },
			],
		});
		assert.equal(await resolver.projection.request(pull), "displayed", "authorized Resolver producer");
		assert.equal(resolver.lifecycle(), "[warning]PR #7@aaaaaaa awaiting-author");
		for (const [name, comments] of [
			[
				"User-carried terminal",
				[
					{ id: 1, user: bot, body: marked(AWAITING, awaitingRecord("BOT_actions", "human-changes-requested")) },
					{ id: 2, user: user("writer"), body: marked(AWAITING_TERMINAL, awaitingTerminal("U_writer")) },
				],
			],
			[
				"User-carried human-review record",
				[
					{
						id: 1,
						user: user("writer"),
						body: marked(AWAITING, awaitingRecord("U_writer", "human-changes-requested")),
					},
				],
			],
			[
				"Resolver record carried by another user",
				[{ id: 1, user: user("writer"), body: marked(AWAITING, awaitingRecord("U_other", "resolver-repair")) }],
			],
			[
				"Resolver record carried by the bot",
				[{ id: 1, user: bot, body: marked(AWAITING, awaitingRecord("BOT_actions", "resolver-repair")) }],
			],
		] as const) {
			const h = harness({ comments: [...comments] as Comment[] });
			assert.equal(await h.projection.request(pull), "silent", name);
		}
	});

	it("stops showing the previous subject as soon as a new one is addressed", async () => {
		const world: World = { comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(null)) }] };
		const h = harness(world);
		await h.projection.request({ kind: "issue", number: 7 });
		assert.equal(h.lifecycle(), "[warning]issue #7 blocked");
		const inner = h.projection as unknown as { seams: LifecycleProjectionSeams };
		const read = inner.seams.read;
		let release: (() => void) | undefined;
		inner.seams.read = async (argv, root, bounds) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			inner.seams.read = read;
			return read(argv, root, bounds);
		};
		const next = h.projection.request({ kind: "pull", number: 7 });
		while (release === undefined) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(h.lifecycle(), undefined, "no stale subject while the new request is pending");
		release();
		await next;
	});

	it("drops a request that was in flight when a new session attached", async () => {
		const h = harness({ comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(null)) }] });
		const inner = h.projection as unknown as { seams: LifecycleProjectionSeams };
		const read = inner.seams.read;
		let release: (() => void) | undefined;
		inner.seams.read = async (argv, root, bounds) => {
			if (argv.includes("--paginate"))
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			return read(argv, root, bounds);
		};
		const pending = h.projection.request({ kind: "issue", number: 7 });
		while (release === undefined) await new Promise((resolve) => setImmediate(resolve));
		h.surface.attach({
			hasUI: true,
			ui: { setStatus: (_key: string, text?: string) => h.statuses.push(text), theme },
		} as never);
		const afterAttach = h.statuses.length;
		release();
		assert.equal(await pending, "superseded");
		assert.equal(h.statuses.length, afterAttach, "the prior session's result made no status call");
		assert.equal(h.lifecycle(), undefined);
	});

	it("never lets a superseded same-subject result reach the cache", async () => {
		const world: World = { comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(null)) }] };
		const h = harness(world);
		const inner = h.projection as unknown as { seams: LifecycleProjectionSeams };
		const read = inner.seams.read;
		let release: (() => void) | undefined;
		let paused = false;
		inner.seams.read = async (argv, root, bounds) => {
			const value = await read(argv, root, bounds);
			if (!paused && argv.includes("--paginate")) {
				paused = true;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return value;
		};
		const first = h.projection.request({ kind: "issue", number: 7 });
		while (release === undefined) await new Promise((resolve) => setImmediate(resolve));
		world.comments = [];
		assert.equal(await h.projection.request({ kind: "issue", number: 7 }), "displayed");
		assert.equal(h.lifecycle(), "[dim]issue #7 no active lifecycle state");
		release();
		assert.equal(await first, "superseded");
		assert.equal(await h.projection.request({ kind: "issue", number: 7 }), "displayed");
		assert.equal(h.commentReads(), 2, "the third request is a cache hit");
		assert.equal(h.lifecycle(), "[dim]issue #7 no active lifecycle state", "the cache holds the newer result");
	});

	it("never lets an earlier subject's late result land over a later request", async () => {
		const h = harness({ comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(null)) }] });
		const inner = h.projection as unknown as { seams: LifecycleProjectionSeams };
		const read = inner.seams.read;
		let release: (() => void) | undefined;
		let first = true;
		inner.seams.read = async (argv, root, bounds) => {
			if (first && argv.includes("--paginate")) {
				first = false;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return JSON.stringify([[]]);
			}
			return read(argv, root, bounds);
		};
		const slow = h.projection.request({ kind: "issue", number: 7 });
		while (release === undefined) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(await h.projection.request({ kind: "pull", number: 7 }), "silent");
		const rendered = h.statuses.length;
		release();
		assert.equal(await slow, "superseded");
		assert.equal(h.statuses.length, rendered, "the superseded result made no status call");
	});

	it("removes a displayed segment when the next addressed subject is unavailable", async () => {
		const world: World = { comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(null)) }] };
		const h = harness(world);
		await h.projection.request({ kind: "issue", number: 7 });
		assert.equal(h.lifecycle(), "[warning]issue #7 blocked");
		world.comments = "unavailable";
		h.clock.now = LIFECYCLE_TTL_MS;
		await h.projection.request({ kind: "issue", number: 7 });
		assert.equal(h.lifecycle(), undefined);
	});

	it("contains a rejected platform read or engine load as silence", async () => {
		for (const [name, world] of [
			["read", { readThrows: true, comments: [] }],
			["engine", { engine: "throws", comments: [] }],
		] as Array<[string, World]>) {
			const h = harness(world);
			const outcome = await h.projection.request({ kind: "issue", number: 7 }).catch(() => "rejected");
			assert.equal(outcome, "silent", name);
			assert.equal(h.lifecycle(), undefined, name);
		}
	});

	it("makes no read and no status call without a UI", async () => {
		const h = harness({}, { ui: false });
		assert.equal(await h.projection.request({ kind: "issue", number: 7 }), "silent");
		assert.equal(h.reads.length, 0);
		assert.equal(h.statuses.length, 0);
	});
});

describe("#347 session surface regression", () => {
	it("keeps the #131 status text unchanged without a segment and resets the segment on attach", () => {
		const statuses: Array<string | undefined> = [];
		const ui = { setStatus: (_key: string, text?: string) => statuses.push(text), theme };
		const surface = new SessionSurface();
		surface.attach({ hasUI: true, ui } as never);
		assert.equal(statuses.at(-1), "[dim]delegate idle · [dim]merge off (default)");
		surface.dispatchStarted();
		assert.equal(statuses.at(-1), "[accent]delegate active (1) · [dim]merge off (default)");
		surface.dispatchFinished("refusal");
		assert.equal(statuses.at(-1), "[warning]delegate refusal · [dim]merge off (default)");
		surface.setLifecycle({ subject: "issue", number: 9, shortHead: null, states: ["blocked"] });
		assert.equal(statuses.at(-1), "[warning]delegate refusal · [dim]merge off (default) · [warning]issue #9 blocked");
		surface.attach({ hasUI: true, ui } as never);
		assert.equal(statuses.at(-1), "[dim]delegate idle · [dim]merge off (default)");
		assert.equal(surface.visible, true);
		surface.attach({ hasUI: false, ui } as never);
		assert.equal(surface.visible, false);
	});
});

describe("#347 /lifecycle command", () => {
	it("accepts exactly one issue= or pr= subject", () => {
		assert.deepEqual(parseLifecycleTarget("issue=12"), { kind: "issue", number: 12 });
		assert.deepEqual(parseLifecycleTarget("  pr=3 "), { kind: "pull", number: 3 });
		for (const bad of [
			"",
			"issue=0",
			"pr=01",
			"issue=12 pr=3",
			"PR=3",
			"issue=1e3",
			"issue=99999999999999999",
			"branch=main",
		])
			assert.equal(parseLifecycleTarget(bad), undefined, bad);
	});

	it("registers the production command with a live default projection", async () => {
		const outside = mkdtempSync(join(tmpdir(), "gitjig-347-not-a-repository-"));
		try {
			let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
			const pi = {
				registerCommand: (_name: string, options: { handler: typeof handler }) => {
					handler = options.handler;
				},
			} as unknown as ExtensionAPI;
			const statuses: Array<string | undefined> = [];
			const ui = { setStatus: (_key: string, text?: string) => statuses.push(text), theme };
			const surface = new SessionSurface();
			surface.attach({ hasUI: true, ui } as never);
			registerLifecycleCommand(pi, outside, surface);
			assert.ok(handler);
			const notes: Array<[string, string]> = [];
			const before = statuses.length;
			await handler("issue=1", {
				hasUI: true,
				ui: { ...ui, notify: (text: string, level: string) => notes.push([text, level]) },
			});
			assert.ok(statuses.length > before, "the default projection reached the session surface");
			assert.equal(notes.at(-1)?.[1], "info", "an unresolvable repository is silent, not an error");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("refuses bad arguments, is inert without a UI, and never sends a message or session entry", async () => {
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const pi = {
			registerCommand: (name: string, options: { handler: typeof handler }) => {
				assert.equal(name, "lifecycle");
				handler = options.handler;
			},
			sendMessage: () => {
				throw new Error("the lifecycle command must not send a model-visible message");
			},
			appendEntry: () => {
				throw new Error("the lifecycle command must not append a session entry");
			},
		} as unknown as ExtensionAPI;
		const requests: unknown[] = [];
		const projection = {
			request: async (target: unknown) => {
				requests.push(target);
				return "silent" as const;
			},
		} as unknown as LifecycleProjection;
		registerLifecycleCommand(pi, "/repo", new SessionSurface(), projection);
		assert.ok(handler);
		const notes: Array<[string, string]> = [];
		const ui = { notify: (text: string, level: string) => notes.push([text, level]) };
		await handler("issue=5", { hasUI: false, ui });
		assert.deepEqual(requests, []);
		assert.deepEqual(notes, []);
		await handler("issue=5 extra", { hasUI: true, ui });
		assert.deepEqual(requests, []);
		assert.equal(notes.at(-1)?.[1], "error");
		await handler("pr=5", { hasUI: true, ui });
		assert.deepEqual(requests, [{ kind: "pull", number: 5 }]);
		assert.equal(notes.at(-1)?.[1], "info");
	});
});

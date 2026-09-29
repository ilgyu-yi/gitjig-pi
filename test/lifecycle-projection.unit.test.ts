import assert from "node:assert/strict";
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

type Comment = { id: number; user: unknown; body: string };
type World = {
	repo?: unknown;
	pull?: unknown;
	issue?: unknown;
	comments?: Comment[] | "unavailable";
	/** When set, the comment read returns these pages instead of one page of `comments`. */
	pages?: Comment[][];
	permissions?: Record<string, string | undefined>;
	engine?: "unavailable";
	/** Runs once, immediately after the comment population is read. */
	afterComments?: () => void;
	/** Runs once, immediately after the Issue or PR subject is read. */
	afterSubject?: () => void;
	/** Runs once, immediately after a collaborator permission is read. */
	afterPermission?: () => void;
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
		repository: () => ({ host: "github.com", nameWithOwner: "o/r" }),
		now: () => clock.now,
		engine: async () =>
			world.engine === "unavailable" ? undefined : await import("../.github/workflows/gitjig-lifecycle.mjs"),
		read: async (argv, _root, bounds) => {
			reads.push({ argv, bounds });
			const path = argv[argv.length - 1] === ".role_name" ? argv[argv.length - 3] : argv[argv.length - 1];
			if (path === "repos/o/r") return JSON.stringify(world.repo ?? { node_id: "R", full_name: "o/r" });
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
				return subject;
			}
			if (path === "repos/o/r/issues/7") {
				const subject = JSON.stringify(world.issue ?? { number: 7, labels: [] });
				once("afterSubject");
				return subject;
			}
			if (path === "repos/o/r/issues/7/comments") {
				const population =
					world.comments === "unavailable" ? undefined : JSON.stringify(world.pages ?? [world.comments ?? []]);
				once("afterComments");
				return population;
			}
			const permission = /^repos\/o\/r\/collaborators\/(.+)\/permission$/.exec(path ?? "");
			if (permission) {
				const role = (world.permissions ?? { writer: "write" })[decodeURIComponent(permission[1])];
				once("afterPermission");
				return role === undefined ? undefined : `${role}\n`;
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
	});

	it("accepts WRITE, MAINTAIN and ADMIN carriers for blocked and handoff records and terminals", async () => {
		for (const role of ["write", "maintain", "admin"]) {
			const h = harness({
				comments: [
					{ id: 1, user: user("carrier"), body: marked(BLOCKED, blocked(null)) },
					{ id: 2, user: user("carrier"), body: marked(HANDOFF, handoff(null)) },
					{ id: 3, user: user("carrier"), body: marked(HANDOFF, handoff(null)) },
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
		assert.equal(h.lifecycle(), "[dim]issue #7 no lifecycle record");
	});

	it("is silent on every inadmissible population instead of guessing a state", async () => {
		const cases: Array<[string, World, "issue" | "pull"]> = [
			["stale PR head", { comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(OTHER)) }] }, "pull"],
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
			assert.equal(h.lifecycle(), "[dim]issue #7 no lifecycle record", transition);
		}
	});

	it("keys the cache by repository identity as well as subject and head", async () => {
		const world: World = { comments: [{ id: 1, user: user("writer"), body: marked(BLOCKED, blocked(null)) }] };
		const h = harness(world);
		await h.projection.request({ kind: "issue", number: 7 });
		world.repo = { node_id: "R_other", full_name: "o/r" };
		world.comments = [];
		assert.equal(await h.projection.request({ kind: "issue", number: 7 }), "displayed");
		assert.equal(h.commentReads(), 2, "a different repository identity is a different key");
		assert.equal(h.lifecycle(), "[dim]issue #7 no lifecycle record");
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

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	decide,
	ESCAPE_MARKER,
	EXCLUSIONS,
	evaluate,
	governedBase,
	measure,
	parseEscape,
	regionBounds,
	regionChangedLines,
	report,
	summary,
	THRESHOLD,
} from "../.github/workflows/pr-size.mjs";

/* #408: the pr-size reporting check against SPEC §1.11. */

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OTHER = "c".repeat(40);
const MERGE_BASE = "d".repeat(40);
const TOC = { path: "SPEC.md", start: "<!-- TOC START", end: "<!-- TOC END" };
const escapeRecord = (value: Record<string, unknown>) =>
	`${ESCAPE_MARKER}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;
const record = (id: number, value: Record<string, unknown>, permission: string | undefined = "WRITE") => ({
	id,
	body: escapeRecord(value),
	permission,
});
const valid = { pr: 7, head: HEAD, measured: 3000, reason: "one migration" };
const noText = async () => null;

describe("#408 the measured quantity", () => {
	it("owns exactly §1.11's bound and exclusions", () => {
		assert.equal(THRESHOLD, 2400);
		assert.deepEqual(EXCLUSIONS.files, ["test/fixtures/adopter-membership.snapshot.json"]);
		assert.deepEqual(EXCLUSIONS.regions, [TOC]);
	});

	it("sums every listed file's additions and deletions, a binary or moved file by its platform count", async () => {
		const files = [
			{ filename: "a.ts", additions: 10, deletions: 5 },
			{ filename: "test/a.test.ts", additions: 7, deletions: 0 },
			{ filename: "moved.ts", status: "renamed", additions: 1, deletions: 1 },
			{ filename: "logo.png", status: "modified", additions: 0, deletions: 0 },
		];
		assert.equal(await measure({ files, changedFiles: 4, regionText: noText }), 24);
	});

	it("excludes the membership snapshot whole", async () => {
		const files = [
			{ filename: "a.ts", additions: 3, deletions: 0 },
			{ filename: "test/fixtures/adopter-membership.snapshot.json", additions: 400, deletions: 20 },
		];
		assert.equal(await measure({ files, changedFiles: 2, regionText: noText }), 3);
	});

	it("excludes only the SPEC table-of-contents region, by its base and head marker positions", async () => {
		const base = ["# SPEC", "<!-- TOC START -->", "| a |", "| b |", "<!-- TOC END -->", "body", "old"].join("\n");
		const head = ["# SPEC", "<!-- TOC START -->", "| a |", "| b2 |", "| c |", "<!-- TOC END -->", "body", "new"].join(
			"\n",
		);
		// -1 +1 inside (b → b2), +1 inside (c), -1 +1 outside (old → new).
		const patch = [
			"@@ -1,7 +1,8 @@",
			" # SPEC",
			" <!-- TOC START -->",
			" | a |",
			"-| b |",
			"+| b2 |",
			"+| c |",
			" <!-- TOC END -->",
			" body",
			"-old",
			"+new",
		].join("\n");
		const files = [{ filename: "SPEC.md", status: "modified", additions: 3, deletions: 2, patch }];
		const regionText = async (_path: string, side: "base" | "head") => (side === "base" ? base : head);
		assert.equal(await measure({ files, changedFiles: 1, regionText }), 2);
	});

	it("locates the region in each version separately, and counts a change to a marker line itself", async () => {
		// The base region sits two lines lower than the head one: a removed line
		// counts by where it stood in the base, an added one by the head.
		const base = ["a", "b", "<!-- TOC START -->", "| x |", "<!-- TOC END -->", "tail"].join("\n");
		const head = ["<!-- TOC START -->", "| x |", "<!-- TOC END -->", "tail"].join("\n");
		const patch = ["@@ -1,6 +1,4 @@", "-a", "-b", " <!-- TOC START -->", " | x |", " <!-- TOC END -->", " tail"].join(
			"\n",
		);
		const regionText = async (_path: string, side: "base" | "head") => (side === "base" ? base : head);
		const files = [{ filename: "SPEC.md", status: "modified", additions: 0, deletions: 2, patch }];
		assert.equal(await measure({ files, changedFiles: 1, regionText }), 2);
		const marker = [
			"@@ -1,3 +1,3 @@",
			"-<!-- TOC START -->",
			"+<!-- TOC START v2 -->",
			" | x |",
			" <!-- TOC END -->",
		].join("\n");
		const both = "<!-- TOC START -->\n| x |\n<!-- TOC END -->";
		const moved = [{ filename: "SPEC.md", status: "modified", additions: 1, deletions: 1, patch: marker }];
		assert.equal(await measure({ files: moved, changedFiles: 1, regionText: async () => both }), 2);
	});

	it("counts a change to the end marker line itself, on either side", async () => {
		const text = "<!-- TOC START -->\n| x |\n<!-- TOC END -->";
		const patch = [
			"@@ -1,3 +1,3 @@",
			" <!-- TOC START -->",
			" | x |",
			"-<!-- TOC END -->",
			"+<!-- TOC END v2 -->",
		].join("\n");
		const files = [{ filename: "SPEC.md", status: "modified", additions: 1, deletions: 1, patch }];
		assert.equal(await measure({ files, changedFiles: 1, regionText: async () => text }), 2);
	});

	it("refuses a per-file count of either kind that is not an integer", async () => {
		for (const file of [
			{ filename: "a.ts", additions: "1", deletions: 0 },
			{ filename: "a.ts", additions: 1, deletions: "0" },
		])
			await assert.rejects(measure({ files: [file], changedFiles: 1, regionText: noText }), /listing-malformed/);
	});

	it("reads the markers' inner lines, and refuses a lone or reversed marker", () => {
		assert.equal(regionBounds(null, TOC), null);
		assert.equal(regionBounds("no markers", TOC), null);
		assert.deepEqual(regionBounds("x\n<!-- TOC START -->\ny\n<!-- TOC END -->", TOC), { after: 2, before: 4 });
		for (const lone of [TOC.start, TOC.end]) assert.throws(() => regionBounds(lone, TOC), /region-malformed/);
		assert.throws(() => regionBounds("<!-- TOC END -->\n<!-- TOC START -->", TOC), /region-malformed/);
		assert.throws(
			() => regionBounds("<!-- TOC START -->\n<!-- TOC START -->\n<!-- TOC END -->", TOC),
			/region-malformed/,
		);
		assert.throws(
			() => regionBounds("<!-- TOC START -->\n<!-- TOC END -->\n<!-- TOC END -->", TOC),
			/region-malformed/,
		);
	});

	it("counts only changed lines inside the region, and refuses a patch with no hunk", () => {
		const patch = [
			"@@ -3,2 +3,2 @@",
			"-in",
			"+in",
			"@@ -10,1 +10,1 @@",
			"-out",
			"+out",
			"\\ No newline at end of file",
		].join("\n");
		assert.equal(regionChangedLines(patch, { after: 2, before: 5 }, { after: 2, before: 5 }), 2);
		assert.equal(regionChangedLines(patch, null, null), 0);
		assert.throws(() => regionChangedLines("+orphan", null, null), /diff-unavailable/);
	});

	it("fails closed on a truncated or malformed listing, or a SPEC.md change with no patch", async () => {
		const one = [{ filename: "a.ts", additions: 1, deletions: 0 }];
		await assert.rejects(measure({ files: one, changedFiles: 2, regionText: noText }), /listing-truncated/);
		await assert.rejects(
			measure({ files: [{ filename: "a.ts", additions: "1", deletions: 0 }], changedFiles: 1, regionText: noText }),
			/listing-malformed/,
		);
		await assert.rejects(
			measure({ files: [{ filename: "SPEC.md", additions: 1, deletions: 0 }], changedFiles: 1, regionText: noText }),
			/diff-unavailable/,
		);
	});
});

describe("#408 the bound and its escape", () => {
	it("passes at the bound and fails one line past it with no record", () => {
		assert.deepEqual(decide({ number: 7, head: HEAD, measured: THRESHOLD, records: [] }), {
			ok: true,
			arm: "within-bound",
		});
		assert.deepEqual(decide({ number: 7, head: HEAD, measured: THRESHOLD + 1, records: [] }), {
			ok: false,
			arm: "over-bound",
		});
	});

	it("honours one record at this head of this pull request, by a writer, naming the measured value", () => {
		for (const permission of ["WRITE", "MAINTAIN", "ADMIN"])
			assert.deepEqual(decide({ number: 7, head: HEAD, measured: 3000, records: [record(9, valid, permission)] }), {
				ok: true,
				arm: "escape-honoured",
				record: 9,
			});
	});

	it("ignores another account's marker comment, so it neither honours nor refuses a writer's record", () => {
		const broken = { id: 1, body: `${ESCAPE_MARKER}\nnot json`, permission: "READ" };
		const copied = { ...record(2, valid), permission: "READ" };
		assert.deepEqual(decide({ number: 7, head: HEAD, measured: 3000, records: [broken, copied, record(3, valid)] }), {
			ok: true,
			arm: "escape-honoured",
			record: 3,
		});
	});

	it("names the refusing arm for every other record", () => {
		const cases: Array<[string, Array<{ id: number; body: string; permission: string | undefined }>]> = [
			["escape-stale", [record(1, { ...valid, head: OTHER })]],
			["escape-other-pull", [record(1, { ...valid, pr: 8 })]],
			["escape-duplicate", [record(1, valid), record(2, valid)]],
			["escape-unauthorized", [record(1, valid, "READ")]],
			["escape-unauthorized", [{ id: 1, body: escapeRecord(valid), permission: undefined }]],
			["escape-value-mismatch", [record(1, { ...valid, measured: 2999 })]],
			["escape-malformed", [{ id: 1, body: `${ESCAPE_MARKER}\nnot json`, permission: "WRITE" }]],
			["escape-malformed", [record(1, { ...valid, extra: true })]],
		];
		for (const [arm, records] of cases)
			assert.deepEqual(decide({ number: 7, head: HEAD, measured: 3000, records }), { ok: false, arm }, arm);
	});

	it("parses exactly the four fields, fenced or bare", () => {
		assert.deepEqual(parseEscape(escapeRecord(valid)), valid);
		assert.deepEqual(parseEscape(`${ESCAPE_MARKER}\n${JSON.stringify(valid)}`), valid);
		for (const broken of [
			{ ...valid, pr: 0 },
			{ ...valid, head: "abc" },
			{ ...valid, measured: -1 },
			{ ...valid, reason: " " },
			{ pr: 7, head: HEAD, measured: 3000 },
		])
			assert.equal(parseEscape(escapeRecord(broken)), undefined, JSON.stringify(broken));
	});

	it("reports the measured value, the threshold, and the honoured record or the refusing arm", () => {
		assert.equal(
			summary(3000, { arm: "escape-honoured", record: 9 }),
			"3000 changed lines; threshold 2400; honoured escape record: comment 9",
		);
		assert.equal(
			summary(undefined, { arm: "listing-truncated" }),
			"not measured; threshold 2400; arm: listing-truncated",
		);
	});

	it("governs the default branch and maintenance lines only", () => {
		assert.equal(governedBase("main", "main"), true);
		assert.equal(governedBase("1.x-maintenance", "main"), true);
		assert.equal(governedBase("integration/409-x", "main"), false);
		// The workflow filter's `*` matches no slash, so neither does this.
		assert.equal(governedBase("team/1.x-maintenance", "main"), false);
	});
});

/** A fake platform: the pull request, its files and comments, and writer permissions. */
function platform(options: {
	files: unknown[];
	changedFiles?: number;
	comments?: Array<{ id: number; body: string; user: { login: string } }>;
	permissions?: Record<string, string>;
	base?: string;
	baseRef?: string;
	baseRepo?: Record<string, unknown>;
	permissionBody?: Record<string, unknown>;
	headAfter?: string;
	baseAfter?: string;
	headMissing?: boolean;
	commentPages?: Array<Array<{ id: number; body: string; user: { login: string } }>>;
	filePages?: unknown[];
	mergeBase?: string;
	texts?: Record<string, string>;
	posts?: unknown[];
}) {
	const reads: string[] = [];
	let pulls = 0;
	const api = async (path: string, init?: RequestInit) => {
		reads.push(path);
		if (path === "/check-runs" && init?.method === "POST") {
			options.posts?.push(JSON.parse(String(init.body ?? "null")));
			return { id: 1 };
		}
		if (path === "/pulls/7") {
			pulls += 1;
			const head = pulls > 1 && options.headAfter ? options.headAfter : HEAD;
			const base = pulls > 1 && options.baseAfter ? options.baseAfter : (options.base ?? BASE);
			return {
				head: options.headMissing ? {} : { sha: head },
				base: { sha: base, ref: options.baseRef ?? "main", repo: options.baseRepo ?? { default_branch: "main" } },
				changed_files: options.changedFiles ?? options.files.length,
			};
		}
		if (path.startsWith("/pulls/7/files")) {
			const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? "1");
			const pages = options.filePages ?? [options.files];
			return pages[page - 1] ?? [];
		}
		if (path.startsWith("/compare/")) return { merge_base_commit: { sha: options.mergeBase ?? MERGE_BASE } };
		if (path.startsWith("/issues/7/comments")) {
			const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? "1");
			const pages = options.commentPages ?? [options.comments ?? []];
			return pages[page - 1] ?? [];
		}
		const login = /^\/collaborators\/([^/]+)\/permission$/.exec(path)?.[1];
		if (login) return options.permissionBody ?? { role_name: options.permissions?.[login] ?? "read" };
		throw new Error(`unexpected read ${path}`);
	};
	const raw = async (path: string) => {
		reads.push(path);
		const ref = /[?&]ref=([0-9a-f]{40})/.exec(path)?.[1] ?? "";
		return options.texts?.[ref] ?? null;
	};
	return { api, raw, reads };
}

describe("#408 one evaluation from platform reads", () => {
	const big = [{ filename: "a.ts", additions: 3000, deletions: 0 }];

	it("measures within the bound without reading any comment", async () => {
		const fake = platform({ files: [{ filename: "a.ts", additions: 10, deletions: 2 }] });
		assert.deepEqual(await evaluate({ ...fake, number: 7 }), {
			head: HEAD,
			measured: 12,
			result: { ok: true, arm: "within-bound" },
		});
		assert.equal(fake.reads.filter((path) => path.startsWith("/issues")).length, 0);
	});

	it("honours a writer's record at this head over the bound, and refuses a reader's", async () => {
		const comments = [{ id: 5, body: escapeRecord(valid), user: { login: "writer" } }];
		const honoured = platform({ files: big, comments, permissions: { writer: "write" } });
		assert.deepEqual((await evaluate({ ...honoured, number: 7 })).result, {
			ok: true,
			arm: "escape-honoured",
			record: 5,
		});
		const refused = platform({ files: big, comments, permissions: { writer: "read" } });
		assert.deepEqual((await evaluate({ ...refused, number: 7 })).result, { ok: false, arm: "escape-unauthorized" });
	});

	it("fails closed on an unknown base, a truncated listing, or a head that moved during the read", async () => {
		assert.deepEqual((await evaluate({ ...platform({ files: big, base: "nope" }), number: 7 })).result, {
			ok: false,
			arm: "base-unknown",
		});
		assert.deepEqual((await evaluate({ ...platform({ files: big, changedFiles: 2 }), number: 7 })).result, {
			ok: false,
			arm: "listing-truncated",
		});
		assert.deepEqual(
			(
				await evaluate({
					...platform({ files: [{ filename: "a.ts", additions: 1, deletions: 0 }], headAfter: OTHER }),
					number: 7,
				})
			).result,
			{ ok: false, arm: "subject-changed" },
		);
	});

	it("fails closed on a missing head, and on a base that moved during the read", async () => {
		assert.deepEqual((await evaluate({ ...platform({ files: big, headMissing: true }), number: 7 })).result, {
			ok: false,
			arm: "head-unknown",
		});
		const small = [{ filename: "a.ts", additions: 1, deletions: 0 }];
		assert.deepEqual((await evaluate({ ...platform({ files: small, baseAfter: OTHER }), number: 7 })).result, {
			ok: false,
			arm: "subject-changed",
		});
	});

	it("reads every comment page, so a duplicate on a later page refuses", async () => {
		const filler = Array.from({ length: 100 }, (_, index) => ({
			id: 100 + index,
			body: "noise",
			user: { login: "x" },
		}));
		const first = [{ id: 5, body: escapeRecord(valid), user: { login: "writer" } }, ...filler.slice(1)];
		const second = [{ id: 6, body: escapeRecord(valid), user: { login: "writer" } }];
		const fake = platform({ files: big, commentPages: [first, second], permissions: { writer: "write" } });
		assert.deepEqual((await evaluate({ ...fake, number: 7 })).result, { ok: false, arm: "escape-duplicate" });
	});

	it("locates the base-side region in the merge base, the version the platform's patch starts from", async () => {
		// The base branch has since moved its markers; only the merge base's
		// positions decide which removed lines lie inside the region.
		const mergeBaseText = ["<!-- TOC START -->", "| x |", "<!-- TOC END -->", "old"].join("\n");
		const baseTipText = ["<!-- TOC START -->", "| x |", "| y |", "| z |", "<!-- TOC END -->"].join("\n");
		const headText = ["<!-- TOC START -->", "| x |", "<!-- TOC END -->"].join("\n");
		const patch = ["@@ -1,4 +1,3 @@", " <!-- TOC START -->", " | x |", " <!-- TOC END -->", "-old"].join("\n");
		const fake = platform({
			files: [{ filename: "SPEC.md", status: "modified", additions: 0, deletions: 1, patch }],
			texts: { [MERGE_BASE]: mergeBaseText, [BASE]: baseTipText, [HEAD]: headText },
		});
		assert.deepEqual(await evaluate({ ...fake, number: 7 }), {
			head: HEAD,
			measured: 1,
			result: { ok: true, arm: "within-bound" },
		});
		assert.ok(fake.reads.some((path) => path.endsWith(`ref=${MERGE_BASE}`)));
		assert.equal(
			fake.reads.some((path) => path.endsWith(`ref=${BASE}`)),
			false,
		);
		assert.deepEqual((await evaluate({ ...platform({ files: big, mergeBase: "x" }), number: 7 })).result, {
			ok: false,
			arm: "merge-base-unknown",
		});
	});

	it("fails closed on a listing page that is not a list", async () => {
		const full = Array.from({ length: 100 }, (_, index) => ({ filename: `f${index}.ts`, additions: 1, deletions: 0 }));
		const fake = platform({ files: full, filePages: [full, { message: "rate limited" }], changedFiles: 100 });
		assert.deepEqual((await evaluate({ ...fake, number: 7 })).result, { ok: false, arm: "listing-malformed" });
	});

	it("reads a base with no default branch as unknown, never as ungoverned", async () => {
		assert.deepEqual((await evaluate({ ...platform({ files: big, baseRepo: {} }), number: 7 })).result, {
			ok: false,
			arm: "base-unknown",
		});
	});

	it("honours a custom role with write permission, and refuses one without", async () => {
		const comments = [{ id: 5, body: escapeRecord(valid), user: { login: "writer" } }];
		const custom = platform({ files: big, comments, permissionBody: { role_name: "deployer", permission: "write" } });
		assert.deepEqual((await evaluate({ ...custom, number: 7 })).result, {
			ok: true,
			arm: "escape-honoured",
			record: 5,
		});
		const reader = platform({ files: big, comments, permissionBody: { role_name: "deployer", permission: "read" } });
		assert.deepEqual((await evaluate({ ...reader, number: 7 })).result, { ok: false, arm: "escape-unauthorized" });
	});

	it("refuses an escape whose writer's permission read names no role", async () => {
		const comments = [{ id: 5, body: escapeRecord(valid), user: { login: "writer" } }];
		const fake = platform({ files: big, comments, permissionBody: {} });
		assert.deepEqual((await evaluate({ ...fake, number: 7 })).result, { ok: false, arm: "escape-unauthorized" });
	});

	it("leaves a pull request to another base ungoverned", async () => {
		assert.deepEqual(
			(await evaluate({ ...platform({ files: big, baseRef: "integration/409-x" }), number: 7 })).result,
			{
				ok: true,
				arm: "not-governed",
			},
		);
	});
});

describe("#408 one report from an event", () => {
	it("posts success or failure by the decision, with its summary", async () => {
		const posts: unknown[] = [];
		const small = platform({ files: [{ filename: "a.ts", additions: 4, deletions: 1 }], posts });
		const event = { pull_request: { number: 7, base: { ref: "main" } }, repository: { default_branch: "main" } };
		await report({ event, ...small });
		const refused = platform({ files: [{ filename: "a.ts", additions: 3000, deletions: 0 }], posts });
		await report({ event, ...refused });
		assert.deepEqual(
			posts.map((post) => {
				const body = post as { name: string; head_sha: string; conclusion: string; output: { summary: string } };
				return [body.name, body.head_sha, body.conclusion, body.output.summary];
			}),
			[
				["pr-size", HEAD, "success", "5 changed lines; threshold 2400; arm: within-bound"],
				["pr-size", HEAD, "failure", "3000 changed lines; threshold 2400; arm: over-bound"],
			],
		);
	});

	it("posts a failure, never a pass, when evaluation throws", async () => {
		const posts: unknown[] = [];
		const fake = platform({ files: [], posts });
		const throwing = async (path: string, init?: RequestInit) => {
			if (path.startsWith("/compare/")) throw new Error("API 502");
			return fake.api(path, init);
		};
		const event = { issue: { number: 7, pull_request: {} }, repository: { default_branch: "main" } };
		await report({ event, api: throwing, raw: fake.raw });
		const [body] = posts as Array<{ conclusion: string; output: { summary: string } }>;
		assert.equal(body?.conclusion, "failure");
		assert.equal(body?.output.summary, "not measured; threshold 2400; arm: lookup-unavailable");
	});

	it("posts for a pull request event whose payload names no default branch, letting the platform read decide", async () => {
		const posts: unknown[] = [];
		const fake = platform({ files: [{ filename: "a.ts", additions: 1, deletions: 0 }], posts });
		await report({ event: { pull_request: { number: 7, base: { ref: "feature" } } }, ...fake });
		assert.equal((posts[0] as { conclusion: string } | undefined)?.conclusion, "success");
	});

	it("posts nothing for an issue comment, or for a pull request to an ungoverned base", async () => {
		const posts: unknown[] = [];
		const fake = platform({ files: [], posts, baseRef: "integration/409-x" });
		assert.equal(await report({ event: { issue: { number: 7 } }, ...fake }), undefined);
		assert.equal(
			await report({
				event: { pull_request: { number: 7, base: { ref: "feature" } }, repository: { default_branch: "main" } },
				...fake,
			}),
			undefined,
		);
		assert.equal(await report({ event: { issue: { number: 7, pull_request: {} } }, ...fake }), undefined);
		assert.deepEqual(posts, []);
	});
});

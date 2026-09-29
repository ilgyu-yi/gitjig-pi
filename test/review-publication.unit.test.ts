import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publishAndRefetchReviewRecord } from "../.pi/extensions/gitjig/review/publication.ts";
import type { ReviewSubject } from "../.pi/extensions/gitjig/review/subject.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const BODY =
	'<!-- gitjig-review-record: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb -->\n\n```json\n{"text":"한글 #381"}\n```\n';
const COMMENT_ID = 5882770576;
const COMMENT_URL = `https://github.com/owner/repo/pull/7#issuecomment-${COMMENT_ID}`;
const ISSUE_URL = "https://api.github.com/repos/owner/repo/issues/7";

function subject(): ReviewSubject {
	return {
		context: {
			repository: { id: "R", host: "github.com", nameWithOwner: "owner/repo" },
			pullRequest: {
				id: "P",
				number: 7,
				url: "https://github.com/owner/repo/pull/7",
				authorId: "AUTHOR",
				base: { repositoryId: "R", name: "main", oid: BASE },
				head: { repositoryId: "R", name: "feature", oid: HEAD },
				closingIssues: [],
			},
		},
		writerId: "WRITER",
		activation: [],
		criteria: [],
	};
}

function payload(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		id: COMMENT_ID,
		issue_url: ISSUE_URL,
		html_url: COMMENT_URL,
		body: BODY,
		user: { node_id: "WRITER", login: "writer" },
		url: `https://api.github.com/repos/owner/repo/issues/comments/${COMMENT_ID}`,
		...overrides,
	});
}

function published(url = COMMENT_URL) {
	return async () => ({
		content: [{ type: "text" as const, text: "published" }],
		details: { disposition: "published", url },
	});
}

const REFUSALS: Array<[string, string]> = [
	["malformed-json", "{"],
	["bom-prefixed", `\u{feff}${payload()}`],
	["array", "[]"],
	["wrong-id", payload({ id: COMMENT_ID + 1 })],
	["typed-id", payload({ id: String(COMMENT_ID) })],
	[
		"missing-id",
		JSON.stringify({ issue_url: ISSUE_URL, html_url: COMMENT_URL, body: BODY, user: { node_id: "WRITER" } }),
	],
	["wrong-repository", payload({ issue_url: "https://api.github.com/repos/other/repo/issues/7" })],
	["foreign-api-host", payload({ issue_url: "https://api.example.com/repos/owner/repo/issues/7" })],
	["foreign-html-host", payload({ html_url: `https://example.com/owner/repo/pull/7#issuecomment-${COMMENT_ID}` })],
	["wrong-parent", payload({ issue_url: "https://api.github.com/repos/owner/repo/issues/8" })],
	["typed-parent", payload({ issue_url: 7 })],
	["wrong-html", payload({ html_url: `https://github.com/owner/repo/pull/8#issuecomment-${COMMENT_ID}` })],
	["typed-html", payload({ html_url: COMMENT_ID })],
	["wrong-body", payload({ body: `${BODY}changed` })],
	["typed-body", payload({ body: 7 })],
	["missing-user", payload({ user: undefined })],
	["array-user", payload({ user: [] })],
	["wrong-author", payload({ user: { node_id: "OTHER" } })],
	["typed-author", payload({ user: { node_id: 7 } })],
];

type Event = "read" | "delay";

/** One publish with scripted reads; every read and delay is recorded in order. */
async function receipt(responses: Array<string | undefined>) {
	const events: Event[] = [];
	const reads: string[][] = [];
	const roots: string[] = [];
	const delays: number[] = [];
	const sent: unknown[] = [];
	let sends = 0;
	const outcome = await publishAndRefetchReviewRecord(
		BODY,
		subject(),
		"/repo",
		"/state",
		async (params) => {
			sends += 1;
			sent.push(params);
			return published()();
		},
		async (argv, root) => {
			events.push("read");
			reads.push(argv);
			roots.push(root);
			if (reads.length > responses.length) throw new Error("unscripted read");
			return responses[reads.length - 1];
		},
		async (ms) => {
			events.push("delay");
			delays.push(ms);
		},
	);
	return { outcome, events, reads, roots, delays, sends, sent };
}

const ARGV = ["api", "--hostname", "github.com", `repos/owner/repo/issues/comments/${COMMENT_ID}`];
const REFUSED = { ok: false, cause: "the published review record did not refetch exactly" };
const ADMITTED = {
	ok: true,
	receipt: {
		repositoryId: "R",
		pullRequestId: "P",
		headOid: HEAD,
		commentId: COMMENT_ID,
		authorId: "WRITER",
		body: BODY,
	},
};

describe("#381 targeted legacy review publication receipt", () => {
	it("binds one send and one targeted GET to the exact comment, writer and bytes", async () => {
		const run = await receipt([payload({ unrelated_platform_field: { retained: true } })]);
		assert.equal(run.sends, 1);
		assert.deepEqual(run.sent, [{ body: BODY, destination: { kind: "pr-comment", number: 7 } }]);
		assert.deepEqual(run.reads, [ARGV]);
		assert.deepEqual(run.roots, ["/repo"]);
		assert.deepEqual(run.delays, []);
		assert.deepEqual(run.outcome, ADMITTED);
	});

	it("rereads once, identically, after a 5,000 ms delay only when the first read is unavailable", async () => {
		const run = await receipt([undefined, payload()]);
		assert.deepEqual(run.events, ["read", "delay", "read"]);
		assert.deepEqual(run.delays, [5_000]);
		assert.deepEqual(run.reads, [ARGV, ARGV]);
		assert.deepEqual(run.roots, ["/repo", "/repo"]);
		assert.equal(run.sends, 1);
		assert.deepEqual(run.outcome, ADMITTED);
	});

	it("applies the complete exact admission independently to the second read", async () => {
		for (const [name, response] of REFUSALS) {
			const run = await receipt([undefined, response]);
			assert.deepEqual(run.outcome, REFUSED, `second read ${name}`);
			assert.deepEqual(run.events, ["read", "delay", "read"], `second read ${name}`);
			assert.equal(run.sends, 1, `second read ${name}`);
		}
	});

	it("stays unconfirmed after two unavailable reads or an unavailable then mismatched read, with no third read", async () => {
		for (const [name, responses] of [
			["two unavailable", [undefined, undefined]],
			["unavailable then wrong body", [undefined, payload({ body: `${BODY}changed` })]],
			["unavailable then malformed", [undefined, "{"]],
		] as const) {
			const run = await receipt([...responses]);
			assert.deepEqual(run.outcome, REFUSED, name);
			assert.deepEqual(run.events, ["read", "delay", "read"], name);
			assert.deepEqual(run.delays, [5_000], name);
			assert.equal(run.sends, 1, name);
		}
	});

	it("fails immediately, with no delay or retry, on every present malformed or mismatched response", async () => {
		for (const [name, response] of REFUSALS) {
			const run = await receipt([response]);
			assert.deepEqual(run.outcome, REFUSED, name);
			assert.equal(run.sends, 1, `${name}: send count`);
			assert.deepEqual(run.events, ["read"], `${name}: one read, no delay`);
		}
	});

	it("does not read after an unconfirmed or mismatched publication locator", async () => {
		for (const [name, result] of [
			[
				"unconfirmed",
				async () => ({
					content: [{ type: "text" as const, text: "unknown" }],
					details: { disposition: "outcome-unverified" },
				}),
			],
			["wrong-pr", published(`https://github.com/owner/repo/pull/8#issuecomment-${COMMENT_ID}`)],
			["wrong-host", published(`https://example.com/owner/repo/pull/7#issuecomment-${COMMENT_ID}`)],
			["wrong-repository", published(`https://github.com/other/repo/pull/7#issuecomment-${COMMENT_ID}`)],
			["query", published(`https://github.com/owner/repo/pull/7?changed=1#issuecomment-${COMMENT_ID}`)],
			["http-scheme", published(`http://github.com/owner/repo/pull/7#issuecomment-${COMMENT_ID}`)],
			["explicit-port", published(`https://github.com:8443/owner/repo/pull/7#issuecomment-${COMMENT_ID}`)],
			["username", published(`https://user@github.com/owner/repo/pull/7#issuecomment-${COMMENT_ID}`)],
			["password-only", published(`https://:secret@github.com/owner/repo/pull/7#issuecomment-${COMMENT_ID}`)],
			["extra-path", published(`https://github.com/owner/repo/pull/7/files#issuecomment-${COMMENT_ID}`)],
			["wrong-surface", published(`https://github.com/owner/repo/commits/7#issuecomment-${COMMENT_ID}`)],
			["non-comment-fragment", published("https://github.com/owner/repo/pull/7#discussion_r5")],
			["leading-zero-id", published("https://github.com/owner/repo/pull/7#issuecomment-0123")],
			["unsafe-id", published("https://github.com/owner/repo/pull/7#issuecomment-99999999999999999999")],
		] as const) {
			let reads = 0;
			const outcome = await publishAndRefetchReviewRecord(
				BODY,
				subject(),
				"/repo",
				"/state",
				result,
				async () => {
					reads += 1;
					return payload();
				},
				async () => {
					throw new Error("no delay without a confirmed locator");
				},
			);
			assert.deepEqual(outcome, { ok: false, cause: "the review publication was not confirmed" }, name);
			assert.equal(reads, 0, name);
		}
	});
});

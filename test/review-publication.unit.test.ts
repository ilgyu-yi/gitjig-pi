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

type Event = "read" | "delay";

/** One publish with scripted reads; every read and delay is recorded in order. */
async function receipt(responses: Array<string | undefined>) {
	const events: Event[] = [];
	const reads: string[][] = [];
	const delays: number[] = [];
	let sends = 0;
	const outcome = await publishAndRefetchReviewRecord(
		BODY,
		subject(),
		"/repo",
		"/state",
		async () => {
			sends += 1;
			return published()();
		},
		async (argv) => {
			events.push("read");
			reads.push(argv);
			if (reads.length > responses.length) throw new Error("unscripted read");
			return responses[reads.length - 1];
		},
		async (ms) => {
			events.push("delay");
			delays.push(ms);
		},
	);
	return { outcome, events, reads, delays, sends };
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
		assert.deepEqual(run.reads, [ARGV]);
		assert.deepEqual(run.delays, []);
		assert.deepEqual(run.outcome, ADMITTED);
	});

	it("rereads once, identically, after a 5,000 ms delay only when the first read is unavailable", async () => {
		const run = await receipt([undefined, payload()]);
		assert.deepEqual(run.events, ["read", "delay", "read"]);
		assert.deepEqual(run.delays, [5_000]);
		assert.deepEqual(run.reads, [ARGV, ARGV]);
		assert.equal(run.sends, 1);
		assert.deepEqual(run.outcome, ADMITTED);
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
		const refusals: Array<[string, string]> = [
			["malformed-json", "{"],
			["array", "[]"],
			["wrong-id", payload({ id: COMMENT_ID + 1 })],
			["typed-id", payload({ id: String(COMMENT_ID) })],
			[
				"missing-id",
				JSON.stringify({ issue_url: ISSUE_URL, html_url: COMMENT_URL, body: BODY, user: { node_id: "WRITER" } }),
			],
			["wrong-repository", payload({ issue_url: "https://api.github.com/repos/other/repo/issues/7" })],
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
		for (const [name, response] of refusals) {
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
			["query", published(`${COMMENT_URL}?changed=1`)],
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

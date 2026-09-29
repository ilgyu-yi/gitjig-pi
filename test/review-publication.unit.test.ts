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

describe("#381 targeted legacy review publication receipt", () => {
	it("binds one send and one targeted GET to the exact comment, writer and bytes", async () => {
		let sends = 0;
		const reads: string[][] = [];
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
				reads.push(argv);
				return payload({ unrelated_platform_field: { retained: true } });
			},
		);
		assert.equal(sends, 1);
		assert.deepEqual(reads, [["api", "--hostname", "github.com", `repos/owner/repo/issues/comments/${COMMENT_ID}`]]);
		assert.deepEqual(outcome, {
			ok: true,
			receipt: {
				repositoryId: "R",
				pullRequestId: "P",
				headOid: HEAD,
				commentId: COMMENT_ID,
				authorId: "WRITER",
				body: BODY,
			},
		});
	});

	it("fails closed after exactly one targeted read for every required-field refusal", async () => {
		const refusals: Array<[string, string | undefined]> = [
			["unavailable", undefined],
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
			let sends = 0;
			let reads = 0;
			const outcome = await publishAndRefetchReviewRecord(
				BODY,
				subject(),
				"/repo",
				"/state",
				async () => {
					sends += 1;
					return published()();
				},
				async () => {
					reads += 1;
					return response;
				},
			);
			assert.deepEqual(outcome, { ok: false, cause: "the published review record did not refetch exactly" }, name);
			assert.equal(sends, 1, `${name}: send count`);
			assert.equal(reads, 1, `${name}: read count`);
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
			["wrong-repository", published(`https://github.com/other/repo/pull/7#issuecomment-${COMMENT_ID}`)],
			["query", published(`${COMMENT_URL}?changed=1`)],
		] as const) {
			let reads = 0;
			const outcome = await publishAndRefetchReviewRecord(BODY, subject(), "/repo", "/state", result, async () => {
				reads += 1;
				return payload();
			});
			assert.deepEqual(outcome, { ok: false, cause: "the review publication was not confirmed" }, name);
			assert.equal(reads, 0, name);
		}
	});
});

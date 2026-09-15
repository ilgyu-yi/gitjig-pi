import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublishRepository } from "../.pi/extensions/gitjig/publish/executor.ts";
import type { PublishRequest, PublishResult } from "../.pi/extensions/gitjig/publish/index.ts";
import { publishAndRefetchReviewRecord, publishReviewRecord } from "../.pi/extensions/gitjig/review/publication.ts";
import { admitPlatformReviewContext, fetchPlatformReviewContext } from "../.pi/extensions/gitjig/review/subject.ts";

const OID = "a".repeat(40);

function snapshot(): Record<string, unknown> {
	return {
		repository: { id: "R_repo", host: "github.example", nameWithOwner: "owner/repo" },
		pullRequest: {
			id: "PR_node",
			number: 223,
			url: "https://github.example/owner/repo/pull/223",
			authorId: "U_author",
			base: { repositoryId: "R_repo", name: "main", oid: OID },
			head: { repositoryId: "R_repo", name: "feature", oid: "b".repeat(40) },
			closingIssues: [{ id: "I_node", repositoryId: "R_repo", number: 212, title: "task", body: "criteria" }],
		},
	};
}

describe("inert platform review context", () => {
	it("admits and detaches one closed same-repository snapshot", () => {
		const source = snapshot();
		const admitted = admitPlatformReviewContext(source);
		assert.ok(admitted !== undefined);
		(source.pullRequest as { number: number }).number = 1;
		assert.equal(admitted.pullRequest.number, 223);
	});

	it("refuses abbreviated object ids and cross-repository identities", () => {
		const abbreviated = snapshot();
		((abbreviated.pullRequest as Record<string, unknown>).head as { oid: string }).oid = "b".repeat(7);
		assert.equal(admitPlatformReviewContext(abbreviated), undefined);

		for (const limb of ["base", "head"] as const) {
			const foreign = snapshot();
			((foreign.pullRequest as Record<string, unknown>)[limb] as { repositoryId: string }).repositoryId = "R_other";
			assert.equal(admitPlatformReviewContext(foreign), undefined, limb);
		}
		const foreignIssue = snapshot();
		(
			(foreignIssue.pullRequest as Record<string, unknown>).closingIssues as { repositoryId: string }[]
		)[0].repositoryId = "R_other";
		assert.equal(admitPlatformReviewContext(foreignIssue), undefined);
	});

	it("refuses unknown and missing fields at both object boundaries", () => {
		for (const boundary of ["root", "pull"] as const) {
			const extra = snapshot();
			const target = boundary === "root" ? extra : (extra.pullRequest as Record<string, unknown>);
			target.untrusted = true;
			assert.equal(admitPlatformReviewContext(extra), undefined, `${boundary} extra`);
			delete target.untrusted;
			delete target[boundary === "root" ? "repository" : "authorId"];
			assert.equal(admitPlatformReviewContext(extra), undefined, `${boundary} missing`);
		}
	});

	it("bootstraps once, then addresses the PR by explicit platform repository", async () => {
		const calls: string[][] = [];
		const outputs = [
			JSON.stringify({ id: "R_repo", nameWithOwner: "owner/repo", url: "https://github.example/owner/repo" }),
			JSON.stringify({
				id: "PR_node",
				number: 223,
				url: "https://github.example/owner/repo/pull/223",
				author: { id: "U_author", login: "author" },
				baseRefName: "main",
				baseRefOid: OID,
				headRefName: "feature",
				headRefOid: "b".repeat(40),
				headRepository: { id: "R_repo", nameWithOwner: "owner/repo" },
				closingIssuesReferences: [
					{ id: "I_node", number: 212, title: "task", body: "criteria", repository: { id: "R_repo" } },
				],
			}),
		];
		const context = await fetchPlatformReviewContext("/repo", 223, async (argv) => {
			calls.push(argv);
			return outputs.shift();
		});
		assert.ok(context !== undefined);
		assert.equal(context.pullRequest.head.oid, "b".repeat(40));
		assert.deepEqual(calls[1]?.slice(0, 6), ["pr", "view", "223", "--repo", "github.example/owner/repo", "--json"]);
	});

	it("retries an unavailable bootstrap identically and never queries a PR without it", async () => {
		const calls: string[][] = [];
		const context = await fetchPlatformReviewContext("/repo", 223, async (argv) => {
			calls.push(argv);
			return undefined;
		});
		assert.equal(context, undefined);
		assert.equal(calls.length, 2);
		assert.deepEqual(calls[0], calls[1]);
		assert.equal(
			calls.every((argv) => argv[0] === "repo"),
			true,
		);
	});

	it("does not cross a mismatched bootstrap URL and refuses a retargeted PR response", async () => {
		let calls = 0;
		const badRepository = await fetchPlatformReviewContext("/repo", 223, async () => {
			calls += 1;
			return JSON.stringify({ id: "R_repo", nameWithOwner: "owner/repo", url: "https://other.example/wrong/repo" });
		});
		assert.equal(badRepository, undefined);
		assert.equal(calls, 1);

		const outputs = [
			JSON.stringify({ id: "R_repo", nameWithOwner: "owner/repo", url: "https://github.example/owner/repo" }),
			JSON.stringify({
				id: "PR_node",
				number: 224,
				url: "https://github.example/owner/repo/pull/224",
				author: { id: "U_author" },
				baseRefName: "main",
				baseRefOid: OID,
				headRefName: "feature",
				headRefOid: "b".repeat(40),
				headRepository: { id: "R_repo" },
				closingIssuesReferences: [],
			}),
		];
		assert.equal(await fetchPlatformReviewContext("/repo", 223, async () => outputs.shift()), undefined);
	});

	it("projects publication target and PR only from the re-admitted context", async () => {
		let captured: { params: PublishRequest; repository?: PublishRepository } | undefined;
		const result = await publishReviewRecord(
			"record",
			snapshot() as never,
			"/repo",
			"/state",
			async (params, _repoRoot, _stateRoot, repository): Promise<PublishResult> => {
				captured = { params, repository };
				return { content: [{ type: "text", text: "published" }], details: { disposition: "published" } };
			},
		);
		assert.equal(result.details.disposition, "published");
		assert.deepEqual(captured, {
			params: { body: "record", destination: { kind: "pr-comment", number: 223 } },
			repository: { host: "github.example", nameWithOwner: "owner/repo" },
		});

		const malformed = snapshot();
		(malformed.pullRequest as { number: number }).number = 224;
		let called = false;
		const refused = await publishReviewRecord("record", malformed as never, "/repo", "/state", async () => {
			called = true;
			throw new Error("must not publish");
		});
		assert.equal(called, false);
		assert.equal(refused.details.disposition, "refuse-subject");
	});

	it("admits a durable receipt only after exact bound-subject refetch", async () => {
		const context = snapshot() as never;
		const publish = async (): Promise<PublishResult> => ({
			content: [{ type: "text", text: "published" }],
			details: {
				disposition: "published",
				url: "https://github.example/owner/repo/pull/223#issuecomment-99",
			},
		});
		const admitted = await publishAndRefetchReviewRecord("record", context, "/repo", "/state", publish, async () => ({
			ok: true,
			comments: [{ id: 99, authorId: "U_writer", body: "record" }],
		}));
		assert.deepEqual(admitted, {
			ok: true,
			receipt: {
				repositoryId: "R_repo",
				pullRequestId: "PR_node",
				headOid: "b".repeat(40),
				commentId: 99,
				authorId: "U_writer",
				body: "record",
			},
		});

		for (const url of [
			"https://other.example/owner/repo/pull/223#issuecomment-99",
			"https://github.example/owner/repo/pull/224#issuecomment-99",
			"https://github.example/other/repo/pull/223#issuecomment-99",
			"https://github.example/owner/repo/pull/223#issuecomment-0",
		]) {
			let fetched = false;
			const refused = await publishAndRefetchReviewRecord(
				"record",
				context,
				"/repo",
				"/state",
				async () => ({
					content: [{ type: "text", text: "published" }],
					details: { disposition: "published", url },
				}),
				async () => {
					fetched = true;
					return { ok: true, comments: [] };
				},
			);
			assert.equal(refused.ok, false, url);
			assert.equal(fetched, false, url);
		}
	});

	it("refuses mismatched, absent, and ambiguous post-send comments", async () => {
		const publish = async (): Promise<PublishResult> => ({
			content: [{ type: "text", text: "published" }],
			details: { disposition: "published", url: "https://github.example/owner/repo/issues/223#issuecomment-99" },
		});
		for (const comments of [
			[],
			[{ id: 99, authorId: "U_writer", body: "different" }],
			[
				{ id: 99, authorId: "U_writer", body: "record" },
				{ id: 99, authorId: "U_writer", body: "record" },
			],
		]) {
			const outcome = await publishAndRefetchReviewRecord(
				"record",
				snapshot() as never,
				"/repo",
				"/state",
				publish,
				async () => ({ ok: true, comments }),
			);
			assert.deepEqual(outcome, { ok: false, cause: "the published review record did not refetch exactly" });
		}
	});

	it("refuses invalid repository names, hosts, URLs, and empty platform identities", () => {
		const badName = snapshot();
		(badName.repository as { nameWithOwner: string }).nameWithOwner = "ambient-only";
		assert.equal(admitPlatformReviewContext(badName), undefined);
		const badHost = snapshot();
		(badHost.repository as { host: string }).host = "-option.example";
		assert.equal(admitPlatformReviewContext(badHost), undefined);
		for (const url of [
			"http://github.example/owner/repo/pull/223",
			"https://other.example/owner/repo/pull/223",
			"https://github.example/other/repo/pull/223",
			"https://github.example/owner/repo/pull/224",
			"https://github.example/owner/repo/pull/223?wrong=1",
		]) {
			const wrongUrl = snapshot();
			(wrongUrl.pullRequest as { url: string }).url = url;
			assert.equal(admitPlatformReviewContext(wrongUrl), undefined, url);
		}
		const emptyAuthor = snapshot();
		(emptyAuthor.pullRequest as { authorId: string }).authorId = "";
		assert.equal(admitPlatformReviewContext(emptyAuthor), undefined);
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitPlatformReviewContext, fetchPlatformReviewContext } from "../.pi/extensions/gitjig/review/subject.ts";

const OID = "a".repeat(40);

function snapshot(): Record<string, unknown> {
	return {
		repository: { id: "R_repo", nameWithOwner: "owner/repo" },
		pullRequest: {
			id: "PR_node",
			number: 223,
			url: "https://github.com/owner/repo/pull/223",
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
			JSON.stringify({ id: "R_repo", nameWithOwner: "owner/repo" }),
			JSON.stringify({
				id: "PR_node",
				number: 223,
				url: "https://github.com/owner/repo/pull/223",
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
		assert.deepEqual(calls[1]?.slice(0, 6), ["pr", "view", "223", "--repo", "owner/repo", "--json"]);
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

	it("refuses an invalid repository name and empty platform identities", () => {
		const badName = snapshot();
		(badName.repository as { nameWithOwner: string }).nameWithOwner = "ambient-only";
		assert.equal(admitPlatformReviewContext(badName), undefined);
		const emptyAuthor = snapshot();
		(emptyAuthor.pullRequest as { authorId: string }).authorId = "";
		assert.equal(admitPlatformReviewContext(emptyAuthor), undefined);
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveAllowancePathEncoding } from "../.pi/extensions/gitjig/recovery/lineage.ts";
import type { ReviewSubject } from "../.pi/extensions/gitjig/review/subject.ts";

function subject(issueIds: string[], pullRequestId = "PR_A"): ReviewSubject {
	const closingIssues = issueIds.map((id, index) => ({
		id,
		repositoryId: "REPO_A",
		number: index + 1,
		title: "title",
		body: "body",
	}));
	return {
		context: {
			repository: { id: "REPO_A", host: "github.com", nameWithOwner: "o/r" },
			pullRequest: {
				id: pullRequestId,
				number: 7,
				url: "https://github.com/o/r/pull/7",
				authorId: "AUTHOR",
				base: { repositoryId: "REPO_A", name: "main", oid: "a".repeat(40) },
				head: { repositoryId: "REPO_A", name: "topic", oid: "b".repeat(40) },
				closingIssues,
			},
		},
		writerId: "WRITER",
		activation: issueIds.map((issueId, index) => ({
			issueId,
			verdict: { id: index * 2 + 1, authorId: "WRITER", authorAssociation: "OWNER", body: "pass" },
			snapshot: { id: index * 2 + 2, authorId: "WRITER", authorAssociation: "OWNER", body: "snapshot" },
		})),
		criteria: [],
	};
}

describe("Phase-A v2 allowance path encoding", () => {
	it("sorts issue ids by unsigned UTF-8 bytes and ignores PR replacement/head/modes", () => {
		const left = deriveAllowancePathEncoding(subject(["z", "ä"]));
		const replacement = subject(["ä", "z"], "PR_REPLACEMENT");
		replacement.context.pullRequest.head.oid = "c".repeat(40);
		const right = deriveAllowancePathEncoding(replacement);
		assert.ok(left && right);
		assert.equal(left.leaf.length, 137);
		assert.equal(left.leaf, right.leaf);
		assert.deepEqual(left.operands.subject, { kind: "issues", issueNodeIds: ["z", "ä"] });
	});

	it("uses the immutable PR id only for the zero-issue fallback", () => {
		const first = deriveAllowancePathEncoding(subject([], "PR_A"));
		const second = deriveAllowancePathEncoding(subject([], "PR_B"));
		assert.ok(first && second);
		assert.notEqual(first.keyHash, second.keyHash);
		assert.equal(first.repoHash, second.repoHash);
	});

	it("refuses duplicate/misaligned/non-scalar/oversize identities", () => {
		const duplicate = subject(["same", "same"]);
		assert.equal(deriveAllowancePathEncoding(duplicate), undefined);
		const misaligned = subject(["one"]);
		const firstActivation = misaligned.activation[0];
		assert.ok(firstActivation !== undefined);
		(
			misaligned.activation as {
				issueId: string;
				verdict: ReviewSubject["activation"][number]["verdict"];
				snapshot: ReviewSubject["activation"][number]["snapshot"];
			}[]
		)[0] = {
			...firstActivation,
			issueId: "other",
		};
		assert.equal(deriveAllowancePathEncoding(misaligned), undefined);
		const surrogate = subject(["\ud800"]);
		assert.equal(deriveAllowancePathEncoding(surrogate), undefined);
		const oversize = subject(["x".repeat(1_025)]);
		assert.equal(deriveAllowancePathEncoding(oversize), undefined);
	});

	it("changes only the key hash when activated issue membership changes", () => {
		const one = deriveAllowancePathEncoding(subject(["I1"]));
		const two = deriveAllowancePathEncoding(subject(["I1", "I2"]));
		assert.ok(one && two);
		assert.equal(one.repoHash, two.repoHash);
		assert.notEqual(one.keyHash, two.keyHash);
	});
});

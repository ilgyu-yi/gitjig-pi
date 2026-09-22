import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	canonicalJson,
	contentDigest,
	deriveLineage,
	domainDigest,
} from "../.pi/extensions/gitjig/recovery/lineage.ts";
import type { ReviewSubject } from "../.pi/extensions/gitjig/review/subject.ts";

function subject(issueIds: string[], pr = "PR_A"): ReviewSubject {
	return {
		context: {
			repository: { id: "REPO", host: "github.com", nameWithOwner: "owner/repo" },
			pullRequest: {
				id: pr,
				number: 1,
				url: "https://github.com/owner/repo/pull/1",
				authorId: "AUTHOR",
				base: { repositoryId: "REPO", name: "main", oid: "a".repeat(40) },
				head: { repositoryId: "REPO", name: "topic", oid: "b".repeat(40) },
				closingIssues: issueIds.map((id, index) => ({
					id,
					repositoryId: "REPO",
					number: index + 1,
					title: "x",
					body: "x",
				})),
			},
		},
		writerId: "WRITER",
		activation: issueIds.map((issueId, index) => ({
			issueId,
			verdict: { id: index * 2 + 1, authorId: "WRITER", authorAssociation: "OWNER", body: "v" },
			snapshot: { id: index * 2 + 2, authorId: "WRITER", authorAssociation: "OWNER", body: "s" },
		})),
		criteria: [],
	};
}

describe("#332 attested recovery lineage", () => {
	it("sorts immutable issue ids and reuses lineage across replacement PRs", () => {
		const first = deriveLineage(subject(["ISSUE_B", "ISSUE_A"], "PR_1"));
		const replacement = deriveLineage(subject(["ISSUE_A", "ISSUE_B"], "PR_2"));
		assert.deepEqual(first?.issueIds, ["ISSUE_A", "ISSUE_B"]);
		assert.equal(first?.key, replacement?.key);
	});
	it("uses immutable PR id only for a zero-issue lineage", () => {
		assert.notEqual(deriveLineage(subject([], "PR_1"))?.key, deriveLineage(subject([], "PR_2"))?.key);
	});
	it("refuses duplicate or activation-misaligned identities", () => {
		assert.equal(deriveLineage(subject(["ISSUE", "ISSUE"])), undefined);
		const value = subject(["ISSUE"]);
		value.activation = [];
		assert.equal(deriveLineage(value), undefined);
	});
	it("canonicalizes object keys and separates structural/content domains", () => {
		assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
		assert.notEqual(domainDigest("gitjig-recovery-diagnosis:v1", { evidence: "same" }), contentDigest("same"));
	});
});

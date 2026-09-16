import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	activationCriteriaFromComments,
	admitReviewSubject,
	criteriaFromClosingIssues,
	criterionUnion,
	fetchReviewSubject,
	type PlatformIssueSnapshot,
} from "../.pi/extensions/gitjig/review/subject.ts";

const issue: PlatformIssueSnapshot = {
	id: "ISSUE_212",
	repositoryId: "REPO_1",
	number: 212,
	title: "review round",
	body: [
		"## Acceptance criteria",
		"- retained criterion",
		"- current-only criterion",
		"",
		"## Other",
		"- not a criterion",
	].join("\n"),
};

function activationBody(criteria: string[], issueId = issue.id, issueNumber = issue.number): string {
	return [
		`<!-- gitjig-activation-criteria: ${issueId} -->`,
		"",
		"```json",
		JSON.stringify({ issueId, issueNumber, criteria }, null, 2),
		"```",
	].join("\n");
}

function comment(body: string, authorId = "WRITER", id = 1) {
	return { id, authorId, body };
}

function platformResponses(comments: unknown, currentIssue: PlatformIssueSnapshot = issue): string[] {
	return [
		JSON.stringify({ id: "REPO_1", nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" }),
		JSON.stringify({
			id: "PR_223",
			number: 223,
			url: "https://github.com/owner/repo/pull/223",
			author: { id: "AUTHOR" },
			baseRefName: "main",
			baseRefOid: "a".repeat(40),
			headRefName: "topic",
			headRefOid: "b".repeat(40),
			headRepository: { id: "REPO_1" },
			closingIssuesReferences: [
				{
					id: currentIssue.id,
					number: currentIssue.number,
					title: currentIssue.title,
					body: currentIssue.body,
					repository: { id: currentIssue.repositoryId },
				},
			],
		}),
		JSON.stringify({ node_id: "WRITER" }),
		JSON.stringify(comments),
	];
}

describe("review subject criterion union", () => {
	it("derives current criteria only from the named section", () => {
		assert.deepEqual(criteriaFromClosingIssues([issue]), ["#212: retained criterion", "#212: current-only criterion"]);
	});

	it("admits exactly one writer-attributed activation snapshot", () => {
		assert.deepEqual(
			activationCriteriaFromComments(issue, "WRITER", [
				comment("ordinary prose", "OTHER", 1),
				comment(activationBody(["activation-only criterion", "retained criterion"]), "WRITER", 2),
			]),
			["#212: activation-only criterion", "#212: retained criterion"],
		);
	});

	it("fails closed on missing, malformed, mismatched, or ambiguous activation evidence", () => {
		assert.equal(activationCriteriaFromComments(issue, "WRITER", []), undefined);
		assert.equal(
			activationCriteriaFromComments(issue, "WRITER", [comment(activationBody([], "OTHER_ISSUE"))]),
			undefined,
		);
		assert.equal(
			activationCriteriaFromComments(issue, "WRITER", [comment(`${activationBody([])} trailing`)]),
			undefined,
		);
		assert.equal(
			activationCriteriaFromComments(issue, "WRITER", [
				comment(activationBody([]), "WRITER", 1),
				comment(activationBody([]), "WRITER", 2),
			]),
			undefined,
		);
	});

	it("forms a stable activation-first exact union", () => {
		assert.deepEqual(
			criterionUnion(
				["#212: activation-only criterion", "#212: retained criterion"],
				["#212: retained criterion", "#212: current-only criterion"],
			),
			["#212: activation-only criterion", "#212: retained criterion", "#212: current-only criterion"],
		);
	});

	it("fetches the activation snapshot from the explicit issue route and seals the union", async () => {
		const responses = platformResponses([
			[
				{
					id: 91,
					body: activationBody(["activation-only criterion", "retained criterion"]),
					user: { node_id: "WRITER" },
				},
			],
		]);
		const calls: string[][] = [];
		const subject = await fetchReviewSubject("/repo", 223, async (argv) => {
			calls.push(argv);
			return responses.shift();
		});
		assert.deepEqual(subject?.criteria, [
			"#212: activation-only criterion",
			"#212: retained criterion",
			"#212: current-only criterion",
		]);
		assert.deepEqual(calls[3], [
			"api",
			"--hostname",
			"github.com",
			"--paginate",
			"--slurp",
			"repos/owner/repo/issues/212/comments",
		]);
		assert.deepEqual(admitReviewSubject(subject), subject);
		if (subject === undefined) assert.fail("subject should be admitted");
		assert.equal(admitReviewSubject({ ...subject, criteria: ["#212: current-only criterion"] }), undefined);
		assert.equal(
			admitReviewSubject({
				...subject,
				activation: [{ ...subject.activation[0], comment: { ...subject.activation[0].comment, body: "changed" } }],
			}),
			undefined,
		);
	});

	it("refuses a subject when the activation comment population is unavailable or ambiguous", async () => {
		for (const comments of [
			[],
			[
				[
					{ id: 1, body: activationBody([]), user: { node_id: "WRITER" } },
					{ id: 2, body: activationBody([]), user: { node_id: "WRITER" } },
				],
			],
		]) {
			const responses = platformResponses(comments);
			assert.equal(await fetchReviewSubject("/repo", 223, async () => responses.shift()), undefined);
		}
	});
});

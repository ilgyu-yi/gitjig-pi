import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	activationCriteriaFromComments,
	admitReviewSubject,
	criteriaFromClosingIssues,
	criterionUnion,
	fetchReviewSubject,
	type PlatformAuthorAssociation,
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

function comment(body: string, authorId = "WRITER", id = 1, authorAssociation: PlatformAuthorAssociation = "OWNER") {
	return { id, authorId, authorAssociation, body };
}

function verdict(authorId = "WRITER", id = 1) {
	return comment("<!-- activation-verdict: pass -->\n\nActivation passed.", authorId, id);
}

interface ClosingIssueLocator {
	id: string;
	number: number;
	url: string;
	repository: { id: string; name: string; owner: { id: string; login: string } };
}

interface IssueRead {
	id: string;
	number: number;
	url: string;
	title: string;
	body: string;
}

function platformComments(issueId = issue.id, issueNumber = issue.number): unknown {
	return [
		[
			{
				id: 90,
				body: "<!-- activation-verdict: pass -->\n\nActivation passed.",
				user: { node_id: "WRITER" },
				author_association: "OWNER",
			},
			{
				id: 91,
				body: activationBody([], issueId, issueNumber),
				user: { node_id: "WRITER" },
				author_association: "OWNER",
			},
		],
	];
}

function closingPages(locators: readonly ClosingIssueLocator[]): string {
	return JSON.stringify([
		{
			data: {
				repository: {
					pullRequest: {
						closingIssuesReferences: {
							nodes: locators,
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			},
		},
	]);
}

function platformResponses(
	comments: unknown,
	currentIssue: PlatformIssueSnapshot = issue,
	headRepositoryId = "REPO_1",
): string[] {
	const locator: ClosingIssueLocator = {
		id: currentIssue.id,
		number: currentIssue.number,
		url: `https://github.com/owner/repo/issues/${String(currentIssue.number)}`,
		repository: { id: currentIssue.repositoryId, name: "repo", owner: { id: "OWNER", login: "owner" } },
	};
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
			headRepository: { id: headRepositoryId },
		}),
		closingPages([locator]),
		JSON.stringify({
			id: currentIssue.id,
			number: currentIssue.number,
			url: locator.url,
			title: currentIssue.title,
			body: currentIssue.body,
		}),
		JSON.stringify({ node_id: "WRITER" }),
		JSON.stringify(comments),
	];
}

function identityResponses(locators: readonly ClosingIssueLocator[], reads: readonly IssueRead[]): string[] {
	const base = platformResponses([]);
	return [
		base[0],
		base[1],
		closingPages(structuredClone(locators)),
		...reads.map((entry) => JSON.stringify(entry)),
		base[4],
		...locators.map((entry) => JSON.stringify(platformComments(entry.id, entry.number))),
	];
}

describe("review subject criterion union", () => {
	it("derives current criteria only from the named section", async () => {
		assert.deepEqual(await criteriaFromClosingIssues([issue]), [
			"#212: retained criterion",
			"#212: current-only criterion",
		]);
	});

	it("admits exactly one writer-attributed activation snapshot", () => {
		assert.deepEqual(
			activationCriteriaFromComments(issue, "WRITER", [
				comment("ordinary prose", "OTHER", 1),
				verdict("WRITER", 2),
				comment(activationBody(["activation-only criterion", "retained criterion"]), "WRITER", 3),
			]),
			["#212: activation-only criterion", "#212: retained criterion"],
		);
	});

	it("fails closed on missing, malformed, mismatched, or ambiguous activation evidence", () => {
		assert.equal(activationCriteriaFromComments(issue, "WRITER", []), undefined);
		assert.equal(
			activationCriteriaFromComments(issue, "WRITER", [
				verdict(),
				comment(activationBody([], "OTHER_ISSUE"), "WRITER", 2),
			]),
			undefined,
		);
		assert.equal(
			activationCriteriaFromComments(issue, "WRITER", [
				verdict(),
				comment(`${activationBody([])} trailing`, "WRITER", 2),
			]),
			undefined,
		);
		assert.equal(
			activationCriteriaFromComments(issue, "WRITER", [
				verdict(),
				comment(activationBody([]), "WRITER", 2),
				comment(activationBody([]), "WRITER", 3),
			]),
			undefined,
		);
		assert.equal(
			activationCriteriaFromComments(issue, "WRITER", [
				comment("<!-- activation-verdict: pass -->", "OTHER", 1, "OTHER"),
				comment(activationBody([]), "WRITER", 2),
			]),
			undefined,
		);
		assert.equal(
			activationCriteriaFromComments(issue, "WRITER", [
				comment("<!-- activation-verdict: pass --> trailing"),
				comment(activationBody([]), "WRITER", 2),
			]),
			undefined,
		);
		assert.deepEqual(
			activationCriteriaFromComments(issue, "WRITER", [verdict("TRUSTED"), comment(activationBody([]), "WRITER", 2)]),
			[],
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
					id: 90,
					body: "<!-- activation-verdict: pass -->\n\nActivation passed.",
					user: { node_id: "WRITER" },
					author_association: "OWNER",
				},
				{
					id: 91,
					body: activationBody(["activation-only criterion", "retained criterion"]),
					user: { node_id: "WRITER" },
					author_association: "OWNER",
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
		assert.equal(calls.length, 6);
		assert.deepEqual(calls[3], [
			"issue",
			"view",
			"212",
			"--repo",
			"github.com/owner/repo",
			"--json",
			"id,number,url,title,body",
		]);
		assert.deepEqual(calls[5], [
			"api",
			"--hostname",
			"github.com",
			"--paginate",
			"--slurp",
			"repos/owner/repo/issues/212/comments",
		]);
		assert.deepEqual(await admitReviewSubject(subject), subject);
		if (subject === undefined) assert.fail("subject should be admitted");
		assert.equal(await admitReviewSubject({ ...subject, criteria: ["#212: current-only criterion"] }), undefined);
		assert.equal(
			await admitReviewSubject({
				...subject,
				activation: [{ ...subject.activation[0], snapshot: { ...subject.activation[0].snapshot, body: "changed" } }],
			}),
			undefined,
		);
	});

	it("binds the closing-issue locator id, number, and URL to the explicit issue read and its repository id to the attested repository", async (t) => {
		const issueUrl = "https://github.com/owner/repo/issues/212";
		const validLocator: ClosingIssueLocator = {
			id: issue.id,
			number: issue.number,
			url: issueUrl,
			repository: { id: issue.repositoryId, name: "repo", owner: { id: "OWNER", login: "owner" } },
		};
		const validRead: IssueRead = {
			id: issue.id,
			number: issue.number,
			url: issueUrl,
			title: issue.title,
			body: issue.body,
		};
		const fetch = async (locators: ClosingIssueLocator[], reads: IssueRead[]) => {
			const responses = identityResponses(locators, reads);
			return fetchReviewSubject("/repo", 223, async () => responses.shift());
		};

		assert.notEqual(await fetch([validLocator], [validRead]), undefined, "the bound positive control must admit");

		const cases: { name: string; locators: ClosingIssueLocator[]; reads: IssueRead[] }[] = [
			{
				name: "foreign locator repository id",
				locators: [
					{
						...validLocator,
						repository: { ...validLocator.repository, id: "FOREIGN_REPO" },
					},
				],
				reads: [validRead],
			},
			{
				name: "locator URL moved from the attested repository path",
				locators: [{ ...validLocator, url: "https://github.com/owner/repo/issues/999" }],
				reads: [{ ...validRead, url: "https://github.com/owner/repo/issues/999" }],
			},
			{
				name: "repeated locator id",
				locators: [validLocator, { ...validLocator, number: 213, url: "https://github.com/owner/repo/issues/213" }],
				reads: [validRead, { ...validRead, number: 213, url: "https://github.com/owner/repo/issues/213" }],
			},
			{
				name: "repeated locator number",
				locators: [validLocator, { ...validLocator, id: "ISSUE_213" }],
				reads: [validRead, { ...validRead, id: "ISSUE_213" }],
			},
			{
				name: "issue-read id disagreement",
				locators: [validLocator],
				reads: [{ ...validRead, id: "ISSUE_999" }],
			},
			{
				name: "issue-read number disagreement",
				locators: [validLocator],
				reads: [{ ...validRead, number: 999 }],
			},
			{
				name: "issue-read URL disagreement",
				locators: [validLocator],
				reads: [{ ...validRead, url: "https://github.com/owner/repo/issues/999" }],
			},
		];
		for (const shape of cases) {
			await t.test(shape.name, async () => {
				assert.equal(await fetch(shape.locators, shape.reads), undefined);
			});
		}
	});

	it("admits every GraphQL closing-issue page and rejects cursor loops or incomplete finality", async () => {
		const locators: ClosingIssueLocator[] = [212, 213].map((number) => ({
			id: `ISSUE_${String(number)}`,
			number,
			url: `https://github.com/owner/repo/issues/${String(number)}`,
			repository: { id: "REPO_1", name: "repo", owner: { id: "OWNER", login: "owner" } },
		}));
		const reads: IssueRead[] = locators.map(({ id, number, url }) => ({
			id,
			number,
			url,
			title: "title",
			body: issue.body,
		}));
		const pages = (loop = false, unfinished = false) =>
			JSON.stringify([
				{
					data: {
						repository: {
							pullRequest: {
								closingIssuesReferences: { nodes: [locators[0]], pageInfo: { hasNextPage: true, endCursor: "C1" } },
							},
						},
					},
				},
				{
					data: {
						repository: {
							pullRequest: {
								closingIssuesReferences: {
									nodes: [locators[1]],
									pageInfo: { hasNextPage: unfinished, endCursor: loop ? "C1" : unfinished ? "C2" : null },
								},
							},
						},
					},
				},
			]);
		const valid = identityResponses(locators, reads);
		valid[2] = pages();
		const admitted = await fetchReviewSubject("/repo", 223, async () => valid.shift());
		assert.deepEqual(
			admitted?.context.pullRequest.closingIssues.map((entry) => entry.id),
			["ISSUE_212", "ISSUE_213"],
		);
		const nonAdjacentLoop = JSON.stringify([
			...JSON.parse(pages(false, true)),
			{
				data: {
					repository: {
						pullRequest: {
							closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "C1" } },
						},
					},
				},
			},
			{
				data: {
					repository: {
						pullRequest: {
							closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
						},
					},
				},
			},
		]);
		for (const malformed of [pages(true, true), pages(false, true), nonAdjacentLoop]) {
			const responses = identityResponses(locators, reads);
			responses[2] = malformed;
			assert.equal(await fetchReviewSubject("/repo", 223, async () => responses.shift()), undefined);
		}
	});

	it("refuses non-conforming locator and explicit-read shapes", async () => {
		const locator: ClosingIssueLocator = {
			id: issue.id,
			number: issue.number,
			url: "https://github.com/owner/repo/issues/212",
			repository: { id: issue.repositoryId, name: "repo", owner: { id: "OWNER", login: "owner" } },
		};
		const read: IssueRead = {
			id: issue.id,
			number: issue.number,
			url: locator.url,
			title: issue.title,
			body: issue.body,
		};
		const editLocator = (responses: string[], edit: (node: Record<string, unknown>) => void): void => {
			const pages = JSON.parse(responses[2]) as {
				data: { repository: { pullRequest: { closingIssuesReferences: { nodes: Record<string, unknown>[] } } } };
			}[];
			edit(pages[0].data.repository.pullRequest.closingIssuesReferences.nodes[0]);
			responses[2] = JSON.stringify(pages);
		};
		const alterations: ((responses: string[]) => void)[] = [
			(responses) =>
				editLocator(responses, (node) => {
					node.extra = true;
				}),
			(responses) =>
				editLocator(responses, (node) => {
					(node.repository as Record<string, unknown>).extra = true;
				}),
			(responses) =>
				editLocator(responses, (node) => {
					(node.repository as { id: string }).id = "";
				}),
			(responses) =>
				editLocator(responses, (node) => {
					(node.repository as { name: string }).name = "";
				}),
			(responses) =>
				editLocator(responses, (node) => {
					(node.repository as { owner: unknown }).owner = {};
				}),
			(responses) => {
				const value = JSON.parse(responses[3]) as Record<string, unknown>;
				value.extra = true;
				responses[3] = JSON.stringify(value);
			},
			(responses) => {
				const value = JSON.parse(responses[3]) as Record<string, unknown>;
				value.title = 1;
				responses[3] = JSON.stringify(value);
			},
			(responses) => {
				const value = JSON.parse(responses[3]) as Record<string, unknown>;
				value.body = null;
				responses[3] = JSON.stringify(value);
			},
		];
		for (const alter of alterations) {
			const responses = identityResponses([locator], [read]);
			alter(responses);
			assert.equal(await fetchReviewSubject("/repo", 223, async () => responses.shift()), undefined);
		}
	});

	it("keeps zero closing references as a present empty criterion manifest", async () => {
		const responses = platformResponses([]);
		responses[2] = closingPages([]);
		responses.splice(3, 1);
		const subject = await fetchReviewSubject("/repo", 223, async () => responses.shift());
		assert.deepEqual(subject?.criteria, []);
		assert.deepEqual(subject?.context.pullRequest.closingIssues, []);
	});

	it("admits a fork pull request while keeping the base and closing issues on the target repository", async () => {
		const responses = platformResponses(
			[
				[
					{
						id: 90,
						body: "<!-- activation-verdict: pass -->",
						user: { node_id: "WRITER" },
						author_association: "OWNER",
					},
					{
						id: 91,
						body: activationBody(["retained criterion"]),
						user: { node_id: "WRITER" },
						author_association: "OWNER",
					},
				],
			],
			issue,
			"FORK_REPO",
		);
		const subject = await fetchReviewSubject("/repo", 223, async () => responses.shift());
		assert.equal(subject?.context.pullRequest.head.repositoryId, "FORK_REPO");
	});

	it("refuses a subject when the activation comment population is unavailable or ambiguous", async () => {
		for (const comments of [
			[],
			[
				[
					{
						id: 1,
						body: "<!-- activation-verdict: pass -->",
						user: { node_id: "WRITER" },
						author_association: "OWNER",
					},
					{ id: 2, body: activationBody([]), user: { node_id: "WRITER" }, author_association: "OWNER" },
					{ id: 3, body: activationBody([]), user: { node_id: "WRITER" }, author_association: "OWNER" },
				],
			],
		]) {
			const responses = platformResponses(comments);
			assert.equal(await fetchReviewSubject("/repo", 223, async () => responses.shift()), undefined);
		}
	});
});

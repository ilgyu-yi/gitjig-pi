import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
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

function platformResponses(
	comments: unknown,
	currentIssue: PlatformIssueSnapshot = issue,
	headRepositoryId = "REPO_1",
): string[] {
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
			closingIssuesReferences: [
				{
					id: currentIssue.id,
					number: currentIssue.number,
					url: `https://github.com/owner/repo/issues/${String(currentIssue.number)}`,
					repository: { id: currentIssue.repositoryId, name: "repo", owner: { id: "OWNER", login: "owner" } },
				},
			],
		}),
		JSON.stringify({
			id: currentIssue.id,
			number: currentIssue.number,
			url: `https://github.com/owner/repo/issues/${String(currentIssue.number)}`,
			title: currentIssue.title,
			body: currentIssue.body,
		}),
		JSON.stringify({ node_id: "WRITER" }),
		JSON.stringify(comments),
	];
}

function identityResponses(locators: readonly ClosingIssueLocator[], reads: readonly IssueRead[]): string[] {
	const base = platformResponses([]);
	const pull = JSON.parse(base[1]) as { closingIssuesReferences: ClosingIssueLocator[] };
	pull.closingIssuesReferences = [...structuredClone(locators)];
	return [
		base[0],
		JSON.stringify(pull),
		...reads.map((entry) => JSON.stringify(entry)),
		base[3],
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

	it("selects the latest intact activation pair without editing the old pair", async () => {
		const old = [verdict("WRITER", 1), comment(activationBody(["old criterion"]), "WRITER", 2)];
		const latest = [verdict("WRITER", 3), comment(activationBody(["new criterion"]), "WRITER", 4)];
		const comments = [...old, ...latest];
		const frozenOld = JSON.stringify(old);
		assert.deepEqual(activationCriteriaFromComments(issue, "WRITER", comments), ["#212: new criterion"]);
		assert.equal(JSON.stringify(old), frozenOld);
		const toWire = (entry: (typeof comments)[number]) => ({
			id: entry.id,
			body: entry.body,
			user: { node_id: entry.authorId },
			author_association: entry.authorAssociation,
		});
		const responses = platformResponses([[...comments.map(toWire)]]);
		const subject = await fetchReviewSubject("/repo", 223, async () => responses.shift());
		assert.equal(subject?.activation[0].verdict.id, 3);
		assert.equal(subject?.activation[0].snapshot.id, 4);
		assert.deepEqual(subject?.criteria, [
			"#212: new criterion",
			"#212: retained criterion",
			"#212: current-only criterion",
		]);
		assert.deepEqual(await admitReviewSubject(subject), subject);
		const changed = platformResponses([[...comments.map(toWire), toWire(verdict("WRITER", 5))]]);
		assert.equal(await fetchReviewSubject("/repo", 223, async () => changed.shift()), undefined);
	});

	it("never falls back when a newer activation tail is incomplete or ambiguous", () => {
		const old = [verdict("WRITER", 1), comment(activationBody(["old"]), "WRITER", 2)];
		for (const tail of [
			[verdict("WRITER", 3)],
			[verdict("WRITER", 3), comment(activationBody(["new"]), "OTHER", 4)],
			[verdict("WRITER", 3), comment(activationBody(["new"], "OTHER_ISSUE"), "WRITER", 4)],
			[verdict("WRITER", 3), comment(`${activationBody(["new"])} trailing`, "WRITER", 4)],
			[verdict("WRITER", 3), comment(activationBody(["new"]), "WRITER", 4), comment(activationBody([]), "WRITER", 5)],
			[verdict("WRITER", 3), comment("interposed", "OTHER", 4), comment(activationBody(["new"]), "WRITER", 5)],
			[verdict("WRITER", 3), comment(activationBody(["new"]), "WRITER", 2)],
		]) {
			assert.equal(activationCriteriaFromComments(issue, "WRITER", [...old, ...tail]), undefined);
		}
	});

	it("private-copy mutants independently red latest selection, unpaired refusal and sealed-pair use", async () => {
		const sourceRoot = fileURLToPath(new URL("../.pi/extensions/gitjig", import.meta.url));
		const sourceFile = join(sourceRoot, "review/subject.ts");
		const old = [verdict("WRITER", 1), comment(activationBody(["old"]), "WRITER", 2)];
		const latest = [verdict("WRITER", 3), comment(activationBody(["new"]), "WRITER", 4)];
		const toWire = (entry: (typeof old)[number]) => ({
			id: entry.id,
			body: entry.body,
			user: { node_id: entry.authorId },
			author_association: entry.authorAssociation,
		});
		for (const [from, to, probe] of [
			[
				"passIndexes.at(-1)",
				"passIndexes[0]",
				async (mutant: typeof import("../.pi/extensions/gitjig/review/subject.ts")) =>
					assert.deepEqual(mutant.activationCriteriaFromComments(issue, "WRITER", [...old, ...latest]), ["#212: new"]),
			],
			[
				"if (verdict === undefined || snapshot === undefined) return undefined;",
				"if (verdict === undefined) return undefined;",
				async (mutant: typeof import("../.pi/extensions/gitjig/review/subject.ts")) =>
					assert.equal(
						mutant.activationCriteriaFromComments(issue, "WRITER", [...old, verdict("WRITER", 3)]),
						undefined,
					),
			],
			[
				"snapshot: pair.snapshot",
				"snapshot: comments[1]",
				async (mutant: typeof import("../.pi/extensions/gitjig/review/subject.ts")) => {
					const responses = platformResponses([[...old, ...latest].map(toWire)]);
					const subject = await mutant.fetchReviewSubject("/repo", 223, async () => responses.shift());
					assert.equal(subject?.activation[0].snapshot.id, 4);
				},
			],
		] as const) {
			const root = mkdtempSync(join(tmpdir(), "gitjig-latest-activation-mutant-"));
			try {
				const targetRoot = join(root, ".pi/extensions/gitjig");
				cpSync(sourceRoot, targetRoot, { recursive: true });
				const ownerDir = join(root, ".github/workflows");
				mkdirSync(ownerDir, { recursive: true });
				cpSync(
					fileURLToPath(new URL("../.github/workflows/ac-closeout.mjs", import.meta.url)),
					join(ownerDir, "ac-closeout.mjs"),
				);
				const target = join(targetRoot, "review/subject.ts");
				const original = readFileSync(sourceFile, "utf8");
				assert.equal(original.split(from).length, 2, `non-unique mutant target: ${from}`);
				const url = pathToFileURL(target).href;
				// Apparatus witness: the copied, unchanged owner and criterion module must
				// pass this exact probe before a mutant's failure can count as a kill.
				await probe(await import(`${url}?baseline=${encodeURIComponent(from)}`));
				writeFileSync(target, original.replace(from, to));
				const mutant = await import(`${url}?mutant=${encodeURIComponent(from)}`);
				await assert.rejects(() => probe(mutant), `surviving mutant: ${from}`);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
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
		assert.equal(calls.length, 5);
		assert.deepEqual(calls[2], [
			"issue",
			"view",
			"212",
			"--repo",
			"github.com/owner/repo",
			"--json",
			"id,number,url,title,body",
		]);
		assert.deepEqual(calls[4], [
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
		const alterations: ((responses: string[]) => void)[] = [
			(responses) => {
				const pull = JSON.parse(responses[1]) as { closingIssuesReferences: Record<string, unknown>[] };
				pull.closingIssuesReferences[0].extra = true;
				responses[1] = JSON.stringify(pull);
			},
			(responses) => {
				const pull = JSON.parse(responses[1]) as { closingIssuesReferences: { repository: Record<string, unknown> }[] };
				pull.closingIssuesReferences[0].repository.extra = true;
				responses[1] = JSON.stringify(pull);
			},
			(responses) => {
				const pull = JSON.parse(responses[1]) as { closingIssuesReferences: { repository: { id: string } }[] };
				pull.closingIssuesReferences[0].repository.id = "";
				responses[1] = JSON.stringify(pull);
			},
			(responses) => {
				const pull = JSON.parse(responses[1]) as { closingIssuesReferences: { repository: { name: string } }[] };
				pull.closingIssuesReferences[0].repository.name = "";
				responses[1] = JSON.stringify(pull);
			},
			(responses) => {
				const pull = JSON.parse(responses[1]) as { closingIssuesReferences: { repository: { owner: unknown } }[] };
				pull.closingIssuesReferences[0].repository.owner = {};
				responses[1] = JSON.stringify(pull);
			},
			(responses) => {
				const value = JSON.parse(responses[2]) as Record<string, unknown>;
				value.extra = true;
				responses[2] = JSON.stringify(value);
			},
			(responses) => {
				const value = JSON.parse(responses[2]) as Record<string, unknown>;
				value.title = 1;
				responses[2] = JSON.stringify(value);
			},
			(responses) => {
				const value = JSON.parse(responses[2]) as Record<string, unknown>;
				value.body = null;
				responses[2] = JSON.stringify(value);
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
		const pull = JSON.parse(responses[1]) as { closingIssuesReferences: unknown[] };
		pull.closingIssuesReferences = [];
		responses[1] = JSON.stringify(pull);
		responses.splice(2, 1);
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

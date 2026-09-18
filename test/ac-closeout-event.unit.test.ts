import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AC_CLOSEOUT_MARKER } from "../.github/workflows/ac-closeout.mjs";
import {
	evaluatePull,
	readClosingIssues,
	readPaginated,
	runAcCloseoutEvent,
} from "../.github/workflows/ac-closeout-event.mjs";

const head = "a".repeat(40);
const base = "b".repeat(40);
const artifact = `${AC_CLOSEOUT_MARKER}\n${JSON.stringify({
	schemaVersion: 1,
	repositoryId: "REPO",
	issueId: "ISSUE",
	issueNumber: 282,
	pullRequestId: "PR",
	pullRequestNumber: 1,
	headSha: head,
	baseSha: base,
	writerId: "USER",
	observedAt: "2026-03-13T00:00:00Z",
	criteria: [{ identity: "#282: done", disposition: "checked" }],
})}`;

interface CheckRun {
	id: number;
	name: string;
	status: string;
	app: { slug: string };
}

function seams(runs: CheckRun[] | "unavailable" | "incomplete", changeSubject = false) {
	const writes: { path: string; body: { conclusion?: string } }[] = [];
	const creates: { head_sha?: string; external_id?: string }[] = [];
	let pullReads = 0;
	const pull = {
		number: 1,
		node_id: "PR",
		html_url: "https://github.com/o/r/pull/1",
		body: "- [x] complete",
		head: { sha: head, repo: { full_name: "o/r" } },
		base: { sha: base, repo: { full_name: "o/r", node_id: "REPO" } },
	};
	const api = async (path: string, init: RequestInit = {}) => {
		if (path === "/pulls/1") {
			pullReads += 1;
			return changeSubject && pullReads >= 3 ? { ...pull, base: { ...pull.base, sha: "c".repeat(40) } } : pull;
		}
		if (path === "/check-runs" && init.method === "POST") {
			creates.push(JSON.parse(String(init.body)) as { head_sha?: string; external_id?: string });
			return { id: 10 };
		}
		if (path === "/issues/282") return { node_id: "ISSUE", body: "## Acceptance criteria\n- [ ] done" };
		if (path.startsWith("/issues/282/comments?"))
			return [
				{
					body: artifact,
					user: { node_id: "USER" },
					created_at: "2026-03-13T00:00:00Z",
					updated_at: "2026-03-13T00:00:00Z",
				},
			];
		if (path === `/commits/${head}/check-runs?per_page=100`) {
			if (runs === "unavailable") throw new Error("unavailable");
			if (runs === "incomplete") return { total_count: 2, check_runs: [] };
			return { total_count: runs.length, check_runs: runs };
		}
		if (path.startsWith("/check-runs/") && init.method === "PATCH") {
			writes.push({ path, body: JSON.parse(String(init.body)) as { conclusion?: string } });
			return {};
		}
		throw new Error(`unexpected ${path}`);
	};
	const graphql = async () => ({
		repository: {
			pullRequest: {
				closingIssuesReferences: {
					nodes: [{ id: "ISSUE", number: 282, body: "ignored; freshly read" }],
					pageInfo: { hasNextPage: false, endCursor: null },
				},
			},
		},
	});
	return { api, graphql, writes, creates };
}

describe("ac-closeout check-run supersession", () => {
	it("reads every REST and GraphQL page and refuses malformed pagination", async () => {
		const restPages: string[] = [];
		const values = await readPaginated(async (path) => {
			restPages.push(path);
			return restPages.length === 1 ? Array.from({ length: 100 }, (_, id) => id) : [100];
		}, "/issues/282/comments");
		assert.equal(values.length, 101);
		assert.equal(restPages.length, 2);
		await assert.rejects(
			readPaginated(async () => ({}), "/issues/282/comments"),
			/population malformed/,
		);

		let graphPage = 0;
		const issues = await readClosingIssues(
			async (_query, variables) => {
				graphPage += 1;
				assert.equal(variables.cursor, graphPage === 1 ? null : "next");
				return {
					repository: {
						pullRequest: {
							closingIssuesReferences: {
								nodes: [{ id: `I${graphPage}`, number: graphPage, body: "" }],
								pageInfo: { hasNextPage: graphPage === 1, endCursor: graphPage === 1 ? "next" : null },
							},
						},
					},
				};
			},
			"o",
			"r",
			1,
		);
		assert.deepEqual(
			issues.map((issue) => issue.id),
			["I1", "I2"],
		);
		await assert.rejects(
			readClosingIssues(
				async () => ({
					repository: {
						pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } },
					},
				}),
				"o",
				"r",
				1,
			),
			/pagination unavailable/,
		);
	});

	it("refuses a fork before creating any check", async () => {
		let created = false;
		await assert.rejects(
			evaluatePull({
				api: async (path, init = {}) => {
					if (path === "/pulls/1")
						return { base: { repo: { full_name: "o/r" } }, head: { repo: { full_name: "fork/r" } } };
					if (path === "/check-runs" && init.method === "POST") created = true;
				},
				graphql: async () => ({}),
				owner: "o",
				name: "r",
				repository: "o/r",
				number: 1,
			}),
			/same-repository pull request required/,
		);
		assert.equal(created, false);
	});

	it("isolates Issue-event fan-out so one failing PR cannot suppress its siblings", async () => {
		const evaluated: number[] = [];
		await assert.rejects(
			runAcCloseoutEvent({
				event: { issue: { node_id: "ISSUE", number: 282 } },
				repository: "o/r",
				api: async (path) => {
					if (path.startsWith("/pulls?state=open"))
						return [1, 2].map((number) => ({
							number,
							base: { repo: { full_name: "o/r" } },
							head: { repo: { full_name: "o/r" } },
						}));
					throw new Error("unexpected API call");
				},
				graphql: async () => ({
					repository: {
						pullRequest: {
							closingIssuesReferences: {
								nodes: [{ id: "ISSUE", number: 282, body: "" }],
								pageInfo: { hasNextPage: false, endCursor: null },
							},
						},
					},
				}),
				evaluate: async ({ number }) => {
					evaluated.push(number);
					if (number === 1) throw new Error("first unavailable");
					return { ok: false, arm: "evidence-absent" };
				},
			}),
			/ac-closeout: one or more independent PR evaluations failed/,
		);
		assert.deepEqual(evaluated, [1, 2]);
	});

	it("abandons its verdict when a newer-created run owns the head", async () => {
		const seam = seams([{ id: 11, name: "ac-closeout", status: "in_progress", app: { slug: "github-actions" } }]);
		assert.deepEqual(
			await evaluatePull({ api: seam.api, graphql: seam.graphql, owner: "o", name: "r", repository: "o/r", number: 1 }),
			{ ok: false, arm: "superseded" },
		);
		assert.deepEqual(seam.writes, [
			{
				path: "/check-runs/10",
				body: {
					status: "completed",
					conclusion: "neutral",
					output: { title: "Superseded", summary: "A newer ac-closeout evaluation owns this head." },
				},
			},
		]);
	});

	it("concludes its own run as failed when the check population is unavailable", async () => {
		const seam = seams("unavailable");
		assert.deepEqual(
			await evaluatePull({ api: seam.api, graphql: seam.graphql, owner: "o", name: "r", repository: "o/r", number: 1 }),
			{ ok: false, arm: "lookup-unavailable" },
		);
		assert.deepEqual(
			seam.writes.map((write) => [write.path, write.body.conclusion]),
			[["/check-runs/10", "failure"]],
		);
	});

	it("concludes its own run as failed on incomplete check pagination", async () => {
		const seam = seams("incomplete");
		assert.deepEqual(
			await evaluatePull({ api: seam.api, graphql: seam.graphql, owner: "o", name: "r", repository: "o/r", number: 1 }),
			{ ok: false, arm: "lookup-unavailable" },
		);
		assert.deepEqual(
			seam.writes.map((write) => write.body.conclusion),
			["failure"],
		);
	});

	it("refuses when the subject changes before conclusion", async () => {
		const seam = seams([], true);
		assert.deepEqual(
			await evaluatePull({ api: seam.api, graphql: seam.graphql, owner: "o", name: "r", repository: "o/r", number: 1 }),
			{ ok: false, arm: "subject-changed" },
		);
		assert.deepEqual(
			seam.writes.map((write) => write.body.conclusion),
			["failure"],
		);
	});

	it("neutralizes only older open runs before publishing its exact success", async () => {
		const seam = seams([
			{ id: 9, name: "ac-closeout", status: "in_progress", app: { slug: "github-actions" } },
			{ id: 8, name: "other", status: "in_progress", app: { slug: "github-actions" } },
		]);
		assert.equal(
			(
				await evaluatePull({
					api: seam.api,
					graphql: seam.graphql,
					owner: "o",
					name: "r",
					repository: "o/r",
					number: 1,
				})
			).ok,
			true,
		);
		assert.deepEqual(
			seam.writes.map((write) => [write.path, write.body.conclusion]),
			[
				["/check-runs/9", "neutral"],
				["/check-runs/10", "success"],
			],
		);
		assert.deepEqual(
			seam.creates.map(({ head_sha, external_id }) => ({ head_sha, external_id })),
			[{ head_sha: head, external_id: `ac-closeout:PR:${head}` }],
		);
	});
});

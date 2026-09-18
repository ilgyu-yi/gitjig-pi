import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publishResolverRepairHandoff } from "../.pi/extensions/gitjig/review/publication.ts";
import type { ReviewSubject } from "../.pi/extensions/gitjig/review/subject.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const NOW = "2026-09-18T00:00:00.000Z";

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

describe("#276 Resolver repair lifecycle publication", () => {
	it("attests the population, writes the record before the label, and re-reads it", async () => {
		const calls: string[] = [];
		let body = "";
		const outcome = await publishResolverRepairHandoff(subject(), "/repo", "/state", () => NOW, {
			fetchComments: async () => ({ ok: true, comments: [] }),
			publishRecord: async (value) => {
				calls.push("record");
				body = value;
				return {
					ok: true,
					receipt: {
						repositoryId: "R",
						pullRequestId: "P",
						headOid: HEAD,
						commentId: 1,
						authorId: "WRITER",
						body: value,
					},
				};
			},
			mutate: async () => {
				calls.push("label");
				return true;
			},
			read: async (argv) =>
				argv.includes(".login") ? "writer" : argv.includes(".role_name") ? "maintain" : "awaiting-author\n",
		});
		assert.equal(outcome.ok, true);
		assert.deepEqual(calls, ["record", "label"]);
		assert.match(body, /lifecycle-awaiting-author-record/);
		assert.match(body, /"producerKind":"resolver-repair"/);
	});

	it("reuses an attested current human record instead of creating a second current producer", async () => {
		const existingBody = `<!-- lifecycle-awaiting-author-record: v1 -->\n\n\`\`\`json\n${JSON.stringify({
			producer: "REVIEWER",
			producerKind: "human-changes-requested",
			observedAt: NOW,
			subjectHead: HEAD,
			baseHead: BASE,
		})}\n\`\`\``;
		let publications = 0;
		const outcome = await publishResolverRepairHandoff(subject(), "/repo", "/state", () => NOW, {
			fetchComments: async () => ({
				ok: true,
				comments: [
					{
						id: 4,
						authorId: "BOT",
						authorLogin: "github-actions[bot]",
						authorType: "Bot",
						body: existingBody,
					},
				],
			}),
			publishRecord: async () => {
				publications += 1;
				return { ok: false, cause: "unexpected" };
			},
			mutate: async () => true,
			read: async (argv) =>
				argv.includes(".login") ? "writer" : argv.includes(".role_name") ? "maintain" : "awaiting-author\n",
		});
		assert.equal(outcome.ok, true);
		assert.equal(publications, 0);
	});

	it("preserves a durable record when label mutation fails", async () => {
		const outcome = await publishResolverRepairHandoff(subject(), "/repo", "/state", () => NOW, {
			fetchComments: async () => ({ ok: true, comments: [] }),
			publishRecord: async (body) => ({
				ok: true,
				receipt: {
					repositoryId: "R",
					pullRequestId: "P",
					headOid: HEAD,
					commentId: 1,
					authorId: "WRITER",
					body,
				},
			}),
			mutate: async () => false,
			read: async (argv) => {
				if (argv.includes(".login")) return "writer";
				if (argv.includes(".role_name")) return "maintain";
				throw new Error("must not read labels after failed mutation");
			},
		});
		assert.deepEqual(outcome, {
			ok: false,
			cause: "the awaiting-author record was durable but its label mutation failed",
		});
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	admitDiagnosisRecord,
	composeDiagnosisRecord,
	createDiagnosisRecord,
	parseDiagnosisRecord,
} from "../.pi/extensions/gitjig/review/diagnosis-record.ts";
import type { StateSummary } from "../.pi/extensions/gitjig/review/history.ts";
import type { ReviewSubject } from "../.pi/extensions/gitjig/review/subject.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const EMPTY_CRITERIA_DIGEST = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

function context(criteria: readonly string[] = []): ReviewSubject {
	return {
		context: {
			repository: { id: "R_repo", host: "github.example", nameWithOwner: "owner/repo" },
			pullRequest: {
				id: "PR_node",
				number: 12,
				url: "https://github.example/owner/repo/pull/12",
				authorId: "U_author",
				base: { repositoryId: "R_repo", name: "main", oid: A },
				head: { repositoryId: "R_repo", name: "feature", oid: B },
				closingIssues:
					criteria.length === 0
						? []
						: [
								{
									id: "I_node",
									repositoryId: "R_repo",
									number: 12,
									title: "task",
									body: ["## Acceptance criteria", ...criteria.map((entry) => `- ${entry}`)].join("\n"),
								},
							],
			},
		},
		writerId: "U_writer",
		activation:
			criteria.length === 0
				? []
				: [
						{
							issueId: "I_node",
							comment: {
								id: 1,
								authorId: "U_writer",
								body: [
									"<!-- gitjig-activation-criteria: I_node -->",
									"",
									"```json",
									JSON.stringify({ issueId: "I_node", issueNumber: 12, criteria }, null, 2),
									"```",
								].join("\n"),
							},
						},
					],
		criteria: criteria.map((entry) => `#12: ${entry}`),
	};
}

function history(): StateSummary[] {
	return [
		{ head: A, outcome: "repair", findings: ["first"], rulings: [] },
		{ head: B, outcome: "repair", findings: ["second"], rulings: [] },
	];
}

describe("durable post-state diagnosis record", () => {
	it("derives subject and complete history heads, then round-trips escaped evidence", () => {
		const record = createDiagnosisRecord(context(), history(), {
			value: "NONE",
			invalidation: "plan",
			evidence: "issue #12: @actor",
		});
		assert.ok(record !== undefined);
		assert.deepEqual(record.subject, {
			repositoryId: "R_repo",
			pullRequestId: "PR_node",
			headOid: B,
			writerId: "U_writer",
			criteriaDigest: EMPTY_CRITERIA_DIGEST,
		});
		const withCriteria = createDiagnosisRecord(context(["one criterion"]), history(), {
			value: "NONE",
			invalidation: "plan",
			evidence: "issue #12: @actor",
		});
		assert.notEqual(withCriteria?.subject.criteriaDigest, EMPTY_CRITERIA_DIGEST);
		assert.deepEqual(record.historyHeads, [A, B]);
		assert.match(record.historyDigest, /^[0-9a-f]{64}$/);
		const changed = createDiagnosisRecord(context(), [{ ...history()[0], outcome: "approved" }, history()[1]], {
			value: "NONE",
			invalidation: "plan",
			evidence: "issue #12: @actor",
		});
		assert.notEqual(changed?.historyDigest, record.historyDigest);
		const body = composeDiagnosisRecord(record);
		assert.equal(body.includes("issue #12: @actor"), false);
		assert.deepEqual(parseDiagnosisRecord(body), record);
	});

	it("refuses a history that omits, duplicates, abbreviates, or does not end at the subject head", () => {
		const base = createDiagnosisRecord(context(), history(), {
			value: "STAGNATION",
			invalidation: "nothing",
			evidence: "inspection",
		});
		assert.ok(base !== undefined);
		for (const heads of [[B], [A, A], ["abc", B], [B, A]]) {
			assert.equal(admitDiagnosisRecord({ ...base, historyHeads: heads }), undefined, heads.join(","));
		}
	});

	it("refuses open shapes, unknown diagnosis values, and marker/body disagreement", () => {
		const base = createDiagnosisRecord(context(), history(), {
			value: "OSCILLATION",
			invalidation: "authorization",
			evidence: "inspection",
		});
		assert.ok(base !== undefined);
		assert.equal(admitDiagnosisRecord({ ...base, extra: true }), undefined);
		for (const subject of [
			{ ...base.subject, writerId: "" },
			{ ...base.subject, criteriaDigest: "abc" },
			{ repositoryId: "R_repo", pullRequestId: "PR_node", headOid: B },
		]) {
			assert.equal(admitDiagnosisRecord({ ...base, subject }), undefined, JSON.stringify(subject));
		}
		assert.equal(createDiagnosisRecord({ ...context(), writerId: "" }, history(), base.diagnosis), undefined);
		assert.equal(admitDiagnosisRecord({ ...base, historyDigest: "abc" }), undefined);
		assert.equal(admitDiagnosisRecord({ ...base, diagnosis: { ...base.diagnosis, value: "OTHER" } }), undefined);
		const body = composeDiagnosisRecord(base);
		assert.equal(parseDiagnosisRecord(body.replace(`: ${B} -->`, `: ${A} -->`)), undefined);
	});
});

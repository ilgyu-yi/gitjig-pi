import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AC_CLOSEOUT_MARKER,
	admitCloseoutRecord,
	closeoutCriteria,
	criteriaFromClosingIssues,
	evaluateAcCloseout,
	parseCloseoutRecord,
	prChecklistTerminal,
} from "../.github/workflows/ac-closeout.mjs";

const head = "a".repeat(40);
const base = "b".repeat(40);
const identity = "#282: exact closeout works";
const record = {
	schemaVersion: 1,
	repositoryId: "REPO",
	issueId: "ISSUE",
	issueNumber: 282,
	pullRequestId: "PR",
	pullRequestNumber: 283,
	headSha: head,
	baseSha: base,
	writerId: "USER",
	observedAt: "2026-03-13T00:00:00.000Z",
	criteria: [{ identity, disposition: "checked" }],
};
const body = `${AC_CLOSEOUT_MARKER}\n${JSON.stringify(record)}`;
const subject = {
	repositoryId: "REPO",
	pullRequestId: "PR",
	pullRequestNumber: 283,
	headSha: head,
	baseSha: base,
	pullRequestBody: "- [x] editorial complete",
	closingIssues: [
		{
			id: "ISSUE",
			number: 282,
			body: "## Acceptance criteria\n- [ ] exact closeout works",
			comments: [{ body, authorId: "USER", createdAt: "2026-03-13T00:00:00Z", updatedAt: "2026-03-13T00:00:00Z" }],
		},
	],
};

const copy = <T>(value: T): T => structuredClone(value);

describe("handed-over ac-closeout predicate", () => {
	it("preserves the review manifest grammar while normalizing only closeout identities", () => {
		const issue = { id: "ISSUE", number: 282, body: "## Acceptance Criteria\n- [ ] exact closeout works" };
		assert.deepEqual(criteriaFromClosingIssues([issue]), ["#282: [ ] exact closeout works"]);
		assert.deepEqual(closeoutCriteria(issue), { ok: true, criteria: [identity] });
		assert.deepEqual(criteriaFromClosingIssues([]), []);
		assert.equal(closeoutCriteria({ ...issue, body: "## Acceptance criteria" }).arm, "criteria-absent");
		assert.equal(
			closeoutCriteria({ ...issue, body: "## Acceptance criteria\n- [~] N/A — no" }).arm,
			"criterion-marker-invalid",
		);
	});

	it("admits only the closed marker/schema and one-line checked or reasoned-N/A dispositions", () => {
		assert.deepEqual(parseCloseoutRecord(body), record);
		assert.equal(admitCloseoutRecord(record), true);
		assert.equal(parseCloseoutRecord(`quoted ${body}`), undefined);
		assert.equal(parseCloseoutRecord(`${body}\n${AC_CLOSEOUT_MARKER}`), undefined);
		assert.equal(admitCloseoutRecord({ ...record, extra: true }), false);
		assert.equal(admitCloseoutRecord({ ...record, criteria: [{ identity, disposition: "na", reason: "" }] }), false);
		assert.equal(
			admitCloseoutRecord({ ...record, criteria: [{ identity, disposition: "na", reason: "not applicable here" }] }),
			true,
		);
	});

	it("keeps the PR editorial checklist separate and terminal", () => {
		assert.equal(prChecklistTerminal("- [x] done\n- [~] N/A — no editorial item"), true);
		assert.equal(prChecklistTerminal("- [ ] open"), false);
		assert.equal(prChecklistTerminal("- [~] N/A — "), false);
		assert.equal(prChecklistTerminal("```md\n- [ ] example\n```\n> - [ ] quoted"), true);
		assert.equal(prChecklistTerminal("```md\n- [ ] unterminated"), false);
	});

	it("passes the exact current author-attested record", () => {
		assert.deepEqual(evaluateAcCloseout(subject), { ok: true, arm: "pass" });
	});

	it("refuses every malformed subject, Issue, criterion and record shape", () => {
		assert.equal(evaluateAcCloseout({}).arm, "subject-malformed");
		assert.equal(closeoutCriteria({ id: "ISSUE", number: 0, body: "" }).arm, "issue-malformed");
		assert.equal(
			closeoutCriteria({ id: "ISSUE", number: 282, body: "## Acceptance criteria\n- criterion without marker" }).arm,
			"criterion-marker-absent",
		);
		assert.equal(
			closeoutCriteria({ id: "ISSUE", number: 282, body: "## Acceptance criteria\n- [ ] same\n- [x] same" }).arm,
			"criteria-duplicate",
		);
		assert.equal(
			closeoutCriteria({ id: "ISSUE", number: 282, body: "## Acceptance criteria\n- [ ] valid then\u0001bad" }).arm,
			"criterion-malformed",
		);
		const malformedPopulation = copy(subject) as unknown as { closingIssues: { comments: unknown }[] };
		malformedPopulation.closingIssues[0].comments = null;
		assert.equal(evaluateAcCloseout(malformedPopulation).arm, "issue-population-malformed");
		const malformedRecord = copy(subject);
		malformedRecord.closingIssues[0].comments[0].body = `${AC_CLOSEOUT_MARKER}\n{}`;
		assert.equal(evaluateAcCloseout(malformedRecord).arm, "evidence-malformed");
	});

	for (const [name, mutate, arm] of [
		[
			"no closing Issue",
			(value: typeof subject) => {
				value.closingIssues = [];
			},
			"closing-issues-absent",
		],
		[
			"unresolved PR item",
			(value: typeof subject) => {
				value.pullRequestBody = "- [ ] open";
			},
			"pr-checklist-unresolved",
		],
		[
			"missing record",
			(value: typeof subject) => {
				value.closingIssues[0].comments = [];
			},
			"evidence-absent",
		],
		[
			"duplicate record",
			(value: typeof subject) => {
				value.closingIssues[0].comments.push(copy(value.closingIssues[0].comments[0]));
			},
			"evidence-ambiguous",
		],
		[
			"edited record",
			(value: typeof subject) => {
				value.closingIssues[0].comments[0].updatedAt = "2026-03-13T00:00:01Z";
			},
			"evidence-edited",
		],
		[
			"wrong author",
			(value: typeof subject) => {
				value.closingIssues[0].comments[0].authorId = "OTHER";
			},
			"writer-unattested",
		],
		[
			"stale head",
			(value: typeof subject) => {
				value.headSha = "c".repeat(40);
			},
			"evidence-stale-subject",
		],
		[
			"changed criterion",
			(value: typeof subject) => {
				value.closingIssues[0].body += " changed";
			},
			"evidence-stale-criteria",
		],
	] as const) {
		it(`refuses ${name}`, () => {
			const value = copy(subject);
			mutate(value);
			assert.equal(evaluateAcCloseout(value).arm, arm);
		});
	}
});

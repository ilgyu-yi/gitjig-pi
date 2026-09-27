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

	it("evaluates every closing Issue while excluding ordinary unmarked sibling comments", () => {
		const secondIdentity = "#283: second exact closeout works";
		const secondRecord = {
			...record,
			issueId: "ISSUE2",
			issueNumber: 283,
			criteria: [{ identity: secondIdentity, disposition: "checked" }],
		};
		const value = copy(subject);
		value.closingIssues[0].comments.unshift({
			body: "ordinary discussion without a closeout marker",
			authorId: "",
			createdAt: "",
			updatedAt: "",
		});
		value.closingIssues.push({
			id: "ISSUE2",
			number: 283,
			body: "## Acceptance criteria\n- [ ] second exact closeout works",
			comments: [
				{
					body: `${AC_CLOSEOUT_MARKER}\n${JSON.stringify(secondRecord)}`,
					authorId: "USER",
					createdAt: "2026-03-13T00:00:00Z",
					updatedAt: "2026-03-13T00:00:00Z",
				},
			],
		});
		assert.deepEqual(evaluateAcCloseout(value), { ok: true, arm: "pass" });
		value.closingIssues[1].comments[0].body = `${AC_CLOSEOUT_MARKER}\n{}`;
		assert.equal(evaluateAcCloseout(value).arm, "evidence-malformed");
	});

	it("selects current evidence by criterion identity while admitting a reasoned N/A disposition", () => {
		const value = copy(subject);
		value.closingIssues[0].comments[0].body = `${AC_CLOSEOUT_MARKER}\n${JSON.stringify({
			...record,
			criteria: [{ identity, disposition: "na", reason: "not applicable to this change" }],
		})}`;
		assert.deepEqual(evaluateAcCloseout(value), { ok: true, arm: "pass" });
	});

	it("requires the complete ordered criterion identity vector", () => {
		const identities = ["#282: first criterion", "#282: second criterion"];
		const exactCriteria = identities.map((criterionIdentity) => ({
			identity: criterionIdentity,
			disposition: "checked",
		}));
		const multi = copy(subject);
		multi.closingIssues[0].body = "## Acceptance criteria\n- [ ] first criterion\n- [ ] second criterion";
		const setCriteria = (criteria: typeof exactCriteria) => {
			multi.closingIssues[0].comments[0].body = `${AC_CLOSEOUT_MARKER}\n${JSON.stringify({ ...record, criteria })}`;
		};
		setCriteria(exactCriteria);
		assert.deepEqual(evaluateAcCloseout(multi), { ok: true, arm: "pass" });
		for (const criteria of [
			[exactCriteria[0]],
			[...exactCriteria, { identity: "#282: extra criterion", disposition: "checked" }],
			[exactCriteria[1], exactCriteria[0]],
			[exactCriteria[0], { identity: "#282: wrong second criterion", disposition: "checked" }],
		]) {
			setCriteria(criteria);
			assert.equal(evaluateAcCloseout(multi).arm, "evidence-stale-criteria");
		}
	});

	it("supersedes admitted immutable records from an old PR, head, base, or criterion set", () => {
		const value = copy(subject);
		for (const stale of [
			{ ...record, pullRequestId: "OLD_PR" },
			{ ...record, pullRequestNumber: 281 },
			{ ...record, headSha: "c".repeat(40) },
			{ ...record, baseSha: "d".repeat(40) },
			{ ...record, criteria: [{ identity: "#282: old criterion", disposition: "checked" }] },
		]) {
			value.closingIssues[0].comments.unshift({
				body: `${AC_CLOSEOUT_MARKER}\n${JSON.stringify(stale)}`,
				authorId: "USER",
				createdAt: "2026-03-12T00:00:00Z",
				updatedAt: "2026-03-12T00:00:00Z",
			});
		}
		assert.deepEqual(evaluateAcCloseout(value), { ok: true, arm: "pass" });
		assert.equal(value.closingIssues[0].comments.length, 6);
	});

	it("refuses an invalid historical marker even beside one exact current record", () => {
		for (const [mutate, arm] of [
			[
				(comment: (typeof subject)["closingIssues"][0]["comments"][0]) => {
					comment.body = `quoted historical marker ${AC_CLOSEOUT_MARKER}\n{}`;
				},
				"evidence-malformed",
			],
			[
				(comment: (typeof subject)["closingIssues"][0]["comments"][0]) => {
					comment.updatedAt = "2026-03-12T00:00:01Z";
				},
				"evidence-edited",
			],
			[
				(comment: (typeof subject)["closingIssues"][0]["comments"][0]) => {
					comment.authorId = "OTHER";
				},
				"writer-unattested",
			],
			[
				(comment: (typeof subject)["closingIssues"][0]["comments"][0]) => {
					comment.authorId = "";
				},
				"writer-unattested",
			],
		] as const) {
			const value = copy(subject);
			const historical = copy(value.closingIssues[0].comments[0]);
			historical.body = `${AC_CLOSEOUT_MARKER}\n${JSON.stringify({ ...record, pullRequestId: "OLD_PR" })}`;
			mutate(historical);
			value.closingIssues[0].comments.unshift(historical);
			assert.equal(evaluateAcCloseout(value).arm, arm);
		}
	});

	it("admits the complete marked population with order-independent refusal precedence", () => {
		const malformed = { ...copy(subject.closingIssues[0].comments[0]), body: `${AC_CLOSEOUT_MARKER}\n{}` };
		const edited = {
			...copy(subject.closingIssues[0].comments[0]),
			updatedAt: "2026-03-13T00:00:01Z",
		};
		for (const historical of [
			[malformed, edited],
			[edited, malformed],
		]) {
			const value = copy(subject);
			value.closingIssues[0].comments.unshift(...historical);
			assert.equal(evaluateAcCloseout(value).arm, "evidence-malformed");
		}
	});

	it("refuses missing or malformed immutability timestamps", () => {
		for (const mutate of [
			(comment: (typeof subject)["closingIssues"][0]["comments"][0]) => {
				comment.createdAt = "";
				comment.updatedAt = "";
			},
			(comment: (typeof subject)["closingIssues"][0]["comments"][0]) => {
				comment.createdAt = "not-an-instant";
				comment.updatedAt = "not-an-instant";
			},
			(comment: (typeof subject)["closingIssues"][0]["comments"][0]) => {
				comment.createdAt = "2026-02-30T00:00:00Z";
				comment.updatedAt = "2026-02-30T00:00:00Z";
			},
		]) {
			const value = copy(subject);
			mutate(value.closingIssues[0].comments[0]);
			assert.equal(evaluateAcCloseout(value).arm, "evidence-edited");
		}
	});

	it("refuses a copied repository or Issue record even when current evidence exists", () => {
		for (const stale of [
			{ ...record, repositoryId: "OTHER" },
			{ ...record, issueId: "OTHER" },
			{ ...record, issueNumber: 281 },
		]) {
			const value = copy(subject);
			value.closingIssues[0].comments.unshift({
				body: `${AC_CLOSEOUT_MARKER}\n${JSON.stringify(stale)}`,
				authorId: "USER",
				createdAt: "2026-03-12T00:00:00Z",
				updatedAt: "2026-03-12T00:00:00Z",
			});
			assert.equal(evaluateAcCloseout(value).arm, "evidence-copied");
		}
	});

	it("refuses a record whose PR id matches but numeric PR identity does not", () => {
		const value = copy(subject);
		value.closingIssues[0].comments[0].body = `${AC_CLOSEOUT_MARKER}\n${JSON.stringify({
			...record,
			pullRequestNumber: 284,
		})}`;
		assert.equal(evaluateAcCloseout(value).arm, "evidence-copied");
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
			"copied record",
			(value: typeof subject) => {
				value.pullRequestId = "OTHER_PR";
			},
			"evidence-copied",
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

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	admitAwaitingAuthorRecord,
	admitBlockedRecord,
	admitCurrentAwaitingAuthor,
	admitHandoffRecord,
	admitSingleCurrentRecord,
	authorizedMaintainer,
	authorizedPolicyApp,
	authorizedPolicyProducer,
	createEscapeRecord,
	ESCAPE_KEYS,
	eligibleApprovalCount,
	eligibleChangesRequested,
	encodeRecord,
	escapeRefusalRecord,
	handoffKey,
	ownBehalfRefusal,
	RECORD_MARKERS,
	recordThenLabelPlan,
	terminalThenUnlabelPlan,
	validateEscapeRecord,
} from "../.github/workflows/gitjig-lifecycle.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const NOW = "2026-09-18T12:00:00.000Z";
const review = (overrides = {}) => ({
	actorId: "reviewer",
	actorType: "User",
	association: "MEMBER",
	state: "APPROVED",
	headSha: HEAD,
	submittedAt: "2026-09-18T11:00:00.000Z",
	dismissed: false,
	...overrides,
});

function escapeRecord(overrides = {}) {
	return {
		schemaVersion: 1,
		repositoryId: "R",
		pullRequestId: "P",
		headSha: HEAD,
		baseRef: "main",
		baseSha: BASE,
		producerKind: "maintainer",
		producerId: "maintainer",
		producerPermission: "MAINTAIN",
		reason: "quorum unavailable",
		appliedAt: "2026-09-18T00:00:00.000Z",
		expiresAt: "2026-09-19T00:00:00.000Z",
		consumedAt: null,
		consumerRunId: null,
		outcome: null,
		...overrides,
	};
}

const context = {
	carryingCommentAuthorId: "maintainer",
	livePermission: "MAINTAIN",
	appAttested: false,
	repositoryId: "R",
	pullRequestId: "P",
	headSha: HEAD,
	baseRef: "main",
	baseSha: BASE,
	now: NOW,
	labelPresent: true,
};

describe("#276 shared actor predicates", () => {
	it("counts unique latest current-head eligible approvals", () => {
		const result = eligibleApprovalCount(
			[
				review({ submittedAt: "2026-09-18T10:00:00.000Z" }),
				review({ state: "CHANGES_REQUESTED", submittedAt: "2026-09-18T11:00:00.000Z" }),
				review({ actorId: "second", association: "OWNER" }),
			],
			"author",
			HEAD,
			1,
		);
		assert.deepEqual(result, { ok: true, arm: "quorum-satisfied", count: 1, quorum: 1 });
		assert.equal(eligibleApprovalCount([review()], "author", HEAD, 0).arm, "quorum-unmeasurable");
	});

	it("rejects stale, self, bot, unknown-association, dismissed, and comment-only review shapes", () => {
		for (const candidate of [
			review({ headSha: BASE }),
			review({ actorId: "author" }),
			review({ actorType: "Bot" }),
			review({ association: "CONTRIBUTOR" }),
			review({ dismissed: true }),
			review({ state: "COMMENTED" }),
		])
			assert.equal(eligibleApprovalCount([candidate], "author", HEAD, 1).count, 0);
	});

	it("shares eligibility with current-head changes-requested production", () => {
		assert.equal(eligibleChangesRequested(review({ state: "CHANGES_REQUESTED" }), "author", HEAD), true);
		assert.equal(
			eligibleChangesRequested(review({ state: "CHANGES_REQUESTED", actorId: "author" }), "author", HEAD),
			false,
		);
	});

	it("admits only live explicit maintainer and policy identities", () => {
		assert.equal(
			authorizedMaintainer({
				actorId: "u",
				actorType: "User",
				repositoryId: "R",
				addressedRepositoryId: "R",
				permission: "ADMIN",
			}),
			true,
		);
		assert.equal(
			authorizedMaintainer({
				actorId: "u",
				actorType: "App",
				repositoryId: "R",
				addressedRepositoryId: "R",
				permission: "ADMIN",
			}),
			false,
		);
		assert.equal(
			authorizedPolicyApp(
				{
					actorId: "a",
					actorType: "App",
					installationId: 1,
					nodeId: "N",
					repositoryId: "R",
					addressedRepositoryId: "R",
				},
				{ installationId: 1, nodeId: "N" },
			),
			true,
		);
		assert.equal(
			authorizedPolicyApp(
				{
					actorId: "a",
					actorType: "App",
					installationId: 2,
					nodeId: "N",
					repositoryId: "R",
					addressedRepositoryId: "R",
				},
				{ installationId: 1, nodeId: "N" },
			),
			false,
		);
		assert.equal(
			authorizedPolicyProducer(
				{
					actorId: "a",
					actorType: "App",
					installationId: 1,
					nodeId: "N",
					repositoryId: "R",
					addressedRepositoryId: "R",
				},
				{ installationId: 1, nodeId: "N" },
				{ complete: true, outcome: "clear", prHead: HEAD, baseHead: BASE, currentPrHead: HEAD, currentBaseHead: BASE },
			),
			true,
		);
	});

	it("refuses every own-behalf principal", () => {
		assert.equal(ownBehalfRefusal({ producerId: "x", prAuthorId: "x" }), true);
		assert.equal(ownBehalfRefusal({ producerId: "x", prAuthorId: "a", beneficiaryIds: ["x"] }), true);
		assert.equal(ownBehalfRefusal({ producerId: "x", prAuthorId: "a", controlledIdentityIds: ["x"] }), true);
	});
});

describe("#276 closed records and transition order", () => {
	it("pins issue null heads and pull full heads", () => {
		const issue = {
			producer: "resolver",
			producerKind: "resolver-repair",
			observedAt: NOW,
			subjectHead: null,
			baseHead: null,
		};
		assert.equal(admitAwaitingAuthorRecord(issue, "issue"), true);
		assert.equal(admitAwaitingAuthorRecord({ ...issue, subjectHead: HEAD }, "issue"), false);
		assert.equal(
			admitAwaitingAuthorRecord(
				{ ...issue, producerKind: "human-changes-requested", subjectHead: HEAD, baseHead: BASE },
				"pull",
			),
			true,
		);
	});

	it("keeps blocked and handoff codecs exact and handoff idempotence keyed", () => {
		assert.equal(
			admitBlockedRecord({
				condition: "dependency",
				recovery: "merge it",
				observedAt: NOW,
				subjectHead: null,
				baseHead: null,
			}),
			true,
		);
		const handoff = {
			cause: "authorization",
			recipient: "maintainer",
			reentry: "approve",
			observedAt: NOW,
			subjectHead: HEAD,
			baseHead: BASE,
		};
		assert.equal(admitHandoffRecord(handoff), true);
		assert.equal(handoffKey(handoff), handoffKey({ ...handoff, observedAt: "2026-09-18T12:01:00.000Z" }));
		assert.equal(admitHandoffRecord({ ...handoff, extra: true }), false);
	});

	it("writes records before labels and terminal records before unlabel", () => {
		assert.deepEqual(
			recordThenLabelPlan("record", "awaiting-author").map((step) => step.kind),
			["comment", "add-label"],
		);
		assert.deepEqual(
			terminalThenUnlabelPlan("terminal", "awaiting-author").map((step) => step.kind),
			["comment", "remove-label"],
		);
	});

	it("admits exactly one marker-keyed current record", () => {
		const value = { condition: "dependency", recovery: "merge it", observedAt: NOW, subjectHead: null, baseHead: null };
		const body = encodeRecord(RECORD_MARKERS.blocked, value);
		assert.ok(admitSingleCurrentRecord([{ id: 1, body }], RECORD_MARKERS.blocked, admitBlockedRecord));
		assert.equal(
			admitSingleCurrentRecord(
				[
					{ id: 1, body },
					{ id: 2, body },
				],
				RECORD_MARKERS.blocked,
				admitBlockedRecord,
			),
			undefined,
		);
	});

	it("terminalizes awaiting-author history without erasing it", () => {
		const record = encodeRecord(RECORD_MARKERS.awaitingAuthor, {
			producer: "author",
			producerKind: "resolver-repair",
			observedAt: NOW,
			subjectHead: null,
			baseHead: null,
		});
		assert.ok(admitCurrentAwaitingAuthor([{ id: 7, body: record }], "issue"));
		const terminal = encodeRecord(RECORD_MARKERS.awaitingAuthorTerminal, {
			recordCommentId: 7,
			clearedAt: NOW,
			cause: "issue-author-body-edit",
			subjectHead: null,
			baseHead: null,
		});
		assert.equal(
			admitCurrentAwaitingAuthor(
				[
					{ id: 7, body: record },
					{ id: 8, body: terminal },
				],
				"issue",
			),
			undefined,
		);
	});
});

describe("#276 escape validity", () => {
	it("admits only the exact current unconsumed record", () => {
		assert.deepEqual(Object.keys(escapeRecord()), ESCAPE_KEYS);
		assert.deepEqual(validateEscapeRecord(escapeRecord(), context), { ok: true, arm: "valid" });
	});

	it("isolates subject, label, clock, expiry, consumption, producer, and shape refusals", () => {
		const cases = [
			[escapeRecord({ extra: true }), context, "record-shape"],
			[escapeRecord({ schemaVersion: 2 }), context, "schema-version"],
			[escapeRecord({ producerKind: "unknown" }), context, "producer-kind"],
			[escapeRecord({ producerPermission: "WRITE" }), context, "producer-permission"],
			[escapeRecord({ expiresAt: "2026-09-18T23:59:59.000Z" }), context, "expiry-shape"],
			[escapeRecord(), { ...context, now: "2026-09-19T00:00:00.000Z" }, "expired"],
			[escapeRecord(), { ...context, headSha: BASE }, "subject-mismatch"],
			[escapeRecord(), { ...context, carryingCommentAuthorId: "other" }, "producer-attestation"],
			[escapeRecord(), { ...context, livePermission: "WRITE" }, "producer-attestation"],
			[escapeRecord(), { ...context, labelPresent: false }, "label-removed"],
			[escapeRecord({ consumedAt: NOW, consumerRunId: "run", outcome: "refused" }), context, "consumed"],
		];
		for (const [record, ctx, arm] of cases) assert.equal(validateEscapeRecord(record, ctx).arm, arm);
	});

	it("closes the App permission field to explicit null", () => {
		assert.equal(
			validateEscapeRecord(escapeRecord({ producerKind: "app", producerId: "app", producerPermission: null }), {
				...context,
				carryingCommentAuthorId: "app",
				livePermission: undefined,
				appAttested: true,
			}).ok,
			true,
		);
		assert.equal(
			validateEscapeRecord(escapeRecord({ producerKind: "app", producerPermission: "ADMIN" }), context).arm,
			"producer-permission",
		);
	});

	it("creates exact one-day unconsumed records and content-free refusals", () => {
		const created = createEscapeRecord({ ...escapeRecord(), expiresAt: undefined });
		assert.ok(created);
		assert.equal(created.expiresAt, "2026-09-19T00:00:00.000Z");
		assert.deepEqual(escapeRefusalRecord("label-removed", NOW), { arm: "label-removed", observedAt: NOW });
	});
});

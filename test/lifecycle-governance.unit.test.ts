import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	clearBlockedTransition,
	createBlockedTransition,
	createHandoffTransition,
	eligibleApprovalCount,
	inspectAwaitingAuthorPopulation,
	inspectBlockedPopulation,
	inspectHandoffPopulation,
	invalidatesLandingAdvisory,
	RECORD_MARKERS,
	reenterHandoffTransition,
} from "../.github/workflows/gitjig-lifecycle.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const NOW = "2026-09-28T00:00:00.000Z";
const assertRefusal = (actual: unknown, arm: string, extra: Record<string, unknown> = {}): void => {
	assert.deepEqual(actual, { ok: false, arm, ...extra });
};
const blocked = { condition: "condition", recovery: "recovery", observedAt: NOW, subjectHead: A, baseHead: B };
const handoff = {
	cause: "cause",
	recipient: "maintainer",
	reentry: "none",
	observedAt: NOW,
	subjectHead: A,
	baseHead: B,
};
const awaiting = {
	producer: "ACTOR",
	producerKind: "resolver-repair",
	observedAt: NOW,
	subjectHead: A,
	baseHead: B,
};
const comment = (id: number, marker: string, record: unknown) => ({
	id,
	attested: true,
	authorId: "ACTOR",
	body: `${marker}\n\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\``,
});

describe("settled lifecycle ownership", () => {
	it("returns complete quorum decisions", () => {
		assertRefusal(eligibleApprovalCount([], "author", A, -1), "quorum-unmeasurable");
		assert.deepEqual(eligibleApprovalCount([], "author", A, 1), {
			ok: false,
			arm: "quorum-missing",
			count: 0,
			quorum: 1,
		});
		assert.deepEqual(eligibleApprovalCount([], "author", A, 0), {
			ok: true,
			arm: "quorum-satisfied",
			count: 0,
			quorum: 0,
		});
		assert.equal(
			Object.keys(RECORD_MARKERS).some((key) => /escape|claim|landingTerminal/i.test(key)),
			false,
		);
	});
	it("returns complete population refusal and success results", () => {
		assertRefusal(inspectAwaitingAuthorPopulation(null as never, "pull"), "population-unmeasurable");
		assertRefusal(
			inspectAwaitingAuthorPopulation(
				[{ id: 1, attested: true, authorId: "ACTOR", body: `${RECORD_MARKERS.awaitingAuthor}\nmalformed` }],
				"pull",
			),
			"record-unparseable",
		);
		const current = comment(1, RECORD_MARKERS.awaitingAuthor, awaiting);
		assertRefusal(
			inspectAwaitingAuthorPopulation(
				[current, { ...comment(2, RECORD_MARKERS.awaitingAuthorTerminal, {}), authorId: "OTHER" }],
				"pull",
			),
			"terminal-unparseable",
		);
		const terminal = comment(2, RECORD_MARKERS.awaitingAuthorTerminal, {
			recordCommentId: 99,
			clearerId: "ACTOR",
			clearedAt: NOW,
			cause: "pull-synchronize",
			subjectHead: A,
			baseHead: B,
		});
		assertRefusal(inspectAwaitingAuthorPopulation([current, terminal], "pull"), "terminal-ambiguous");
		const duplicate = comment(2, RECORD_MARKERS.awaitingAuthor, awaiting);
		assertRefusal(inspectAwaitingAuthorPopulation([current, duplicate], "pull"), "record-ambiguous", {
			current: [
				{ comment: current, record: awaiting },
				{ comment: duplicate, record: awaiting },
			],
			terminals: [],
		});
		assert.deepEqual(inspectAwaitingAuthorPopulation([current], "pull"), {
			ok: true,
			current: [{ comment: current, record: awaiting }],
			terminals: [],
		});
	});

	it("returns complete blocked and handoff population refusal and success results", () => {
		for (const [inspect, marker, terminalMarker, record, transition, other] of [
			[
				inspectBlockedPopulation,
				RECORD_MARKERS.blocked,
				RECORD_MARKERS.blockedTerminal,
				blocked,
				"blocked-clear",
				"handoff-reentry",
			],
			[
				inspectHandoffPopulation,
				RECORD_MARKERS.handoff,
				RECORD_MARKERS.handoffTerminal,
				handoff,
				"handoff-reentry",
				"blocked-clear",
			],
		] as const) {
			const terminalFor = (id: number, recordCommentId: number, kind: string = transition) =>
				comment(id, terminalMarker, {
					recordCommentId,
					transition: kind,
					observedAt: NOW,
					subjectHead: A,
					baseHead: B,
				});
			const current = comment(1, marker, record);
			assertRefusal(inspect(null as never), "population-unmeasurable");
			assertRefusal(inspect([{ ...current, attested: false }]), "record-unparseable");
			assertRefusal(inspect([{ ...current, id: 1.5 }]), "record-unparseable");
			assertRefusal(inspect([comment(1, marker, { ...record, observedAt: "never" })]), "record-unparseable");
			assertRefusal(inspect([{ ...current, body: `${marker}\nmalformed` }]), "record-unparseable");
			assertRefusal(inspect([current, { ...terminalFor(2, 1), attested: false }]), "terminal-unparseable");
			assertRefusal(inspect([current, { ...terminalFor(2, 1), id: -Infinity }]), "terminal-unparseable");
			assertRefusal(inspect([current, terminalFor(2, 1, other)]), "terminal-unparseable");
			assertRefusal(inspect([current, comment(2, terminalMarker, {})]), "terminal-unparseable");
			assertRefusal(inspect([current, terminalFor(2, 99)]), "terminal-ambiguous");
			assertRefusal(inspect([current, terminalFor(1, 1)]), "terminal-ambiguous");
			assertRefusal(inspect([current, terminalFor(2, 1), terminalFor(3, 1)]), "terminal-ambiguous");
			const second = comment(2, marker, record);
			assertRefusal(inspect([current, second]), "record-ambiguous", {
				current: [
					{ comment: current, record },
					{ comment: second, record },
				],
				terminals: [],
			});
			const cleared = terminalFor(3, 1);
			assert.deepEqual(inspect([current, second, cleared]), {
				ok: true,
				current: [{ comment: second, record }],
				terminals: [{ comment: cleared, record: JSON.parse(cleared.body.split("\n")[3]) }],
			});
			assert.deepEqual(inspect([{ id: 9, attested: false, authorId: "X", body: "unrelated" }]), {
				ok: true,
				current: [],
				terminals: [],
			});
		}
	});

	it("returns complete blocked and handoff transition decisions", () => {
		assertRefusal(createBlockedTransition({}), "blocked-record");
		assert.deepEqual(createBlockedTransition(blocked), {
			ok: true,
			plan: [
				{
					kind: "comment",
					body: `${RECORD_MARKERS.blocked}\n\n\`\`\`json\n${JSON.stringify(blocked)}\n\`\`\``,
				},
				{ kind: "add-label", label: "blocked" },
			],
		});
		assertRefusal(clearBlockedTransition({ status: "Completed" }), "blocked-status");
		assertRefusal(clearBlockedTransition({ status: "Active", directiveChanged: true }), "activation-required");
		assertRefusal(clearBlockedTransition({ status: "Proposed" }), "blocked-terminal");
		const transitionInput = {
			status: "Proposed",
			directiveChanged: false,
			recordCommentId: 1,
			observedAt: NOW,
			subjectHead: A,
			baseHead: B,
		};
		assert.deepEqual(clearBlockedTransition(transitionInput), {
			ok: true,
			preservedStatus: "Proposed",
			plan: [
				{
					kind: "comment",
					body: `${RECORD_MARKERS.blockedTerminal}\n\n\`\`\`json\n${JSON.stringify({ recordCommentId: 1, transition: "blocked-clear", observedAt: NOW, subjectHead: A, baseHead: B })}\n\`\`\``,
				},
				{ kind: "remove-label", label: "blocked" },
			],
		});
		assertRefusal(createHandoffTransition({}), "handoff-record");
		assert.deepEqual(createHandoffTransition(handoff), {
			ok: true,
			key: JSON.stringify(["cause", "maintainer", "none", A, B]),
			plan: [
				{
					kind: "comment",
					body: `${RECORD_MARKERS.handoff}\n\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\``,
				},
			],
		});
		assertRefusal(reenterHandoffTransition({}), "handoff-terminal");
		assert.deepEqual(reenterHandoffTransition({ recordCommentId: 1, observedAt: NOW, subjectHead: A, baseHead: B }), {
			ok: true,
			plan: [
				{
					kind: "comment",
					body: `${RECORD_MARKERS.handoffTerminal}\n\n\`\`\`json\n${JSON.stringify({ recordCommentId: 1, transition: "handoff-reentry", observedAt: NOW, subjectHead: A, baseHead: B })}\n\`\`\``,
				},
			],
		});
	});

	it("synchronize invalidates only an observed head change", () => {
		assert.equal(
			invalidatesLandingAdvisory({ kind: "synchronize", before: A, after: B, eventRef: null, baseRef: "main" }),
			true,
		);
		assert.equal(
			invalidatesLandingAdvisory({ kind: "synchronize", before: A, after: A, eventRef: null, baseRef: "main" }),
			false,
		);
	});
	it("base push invalidates only an exact matching ref and changed live base", () => {
		assert.equal(
			invalidatesLandingAdvisory({
				kind: "base-push",
				before: A,
				after: B,
				eventRef: "refs/heads/main",
				baseRef: "main",
			}),
			true,
		);
		assert.equal(
			invalidatesLandingAdvisory({
				kind: "base-push",
				before: A,
				after: B,
				eventRef: "refs/heads/release",
				baseRef: "main",
			}),
			false,
		);
	});
});

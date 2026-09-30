/**
 * #404 — the §1.4 review-history handoff record and its re-entry in the
 * governed `/review-round` path (SPEC §1.4, settled by #402). The platform is
 * faked at the seams; the #276 engine, history projection and the real git
 * correction-interval reader run for real.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import * as engine from "../.github/workflows/gitjig-lifecycle.mjs";
import {
	driveReviewRound,
	type HistoryHandoffSeams,
	type ReviewRoundSeams,
	type ReviewRoundSpec,
	reenterReviewHistory,
} from "../.pi/extensions/gitjig/commands/review-round.ts";
import {
	type AttestedCommentPopulation,
	recordsFromAttestedComments,
} from "../.pi/extensions/gitjig/review/comments.ts";
import type { DiagnosisInput } from "../.pi/extensions/gitjig/review/history.ts";
import { legacyUnderivable, repairHistory } from "../.pi/extensions/gitjig/review/history.ts";
import { HISTORY_HANDOFF_CAUSE } from "../.pi/extensions/gitjig/review/history-handoff.ts";
import type { reviewRound } from "../.pi/extensions/gitjig/review/orchestrate.ts";
import { composeReviewRecord, type ReviewRecord } from "../.pi/extensions/gitjig/review/record.ts";
import type { ReviewSubject } from "../.pi/extensions/gitjig/review/subject.ts";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const SLOT = { lens: "runtime", surface: "the shell's runtime extensions" };
const SUITE = { lens: "suite", surface: "the test suite" };
const NOW = "2026-10-01T00:00:00.000Z";
const ADMITTED = {
	schemaVersion: 1,
	status: "admitted",
	phase: "compare",
	run: { class: "exited", exitCode: 0, signal: null },
	return: { class: "admitted" },
	compare: { class: "confirmed" },
	durationMs: 1,
	code: "ADMITTED",
	message: "dispatch admitted",
} as const;

/** A repository with a base, a first repaired head and a second repaired head. */
function repository(): { root: string; base: string; first: string; second: string } {
	const root = mkdtempSync(join(tmpdir(), "gitjig-404-"));
	dirs.push(root);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	git("init", "-q");
	git("config", "user.name", "zq");
	git("config", "user.email", "zq@example.invalid");
	git("config", "commit.gpgsign", "false");
	mkdirSync(join(root, ".pi"));
	const commit = (text: string) => {
		writeFileSync(join(root, ".pi", "seed.ts"), text);
		git("add", "-A");
		git("commit", "-qm", text.slice(0, 20));
		return git("rev-parse", "HEAD");
	};
	const base = commit("export {};\n");
	const first = commit("export const a = 1;\n");
	const second = commit("export const a = 2;\n");
	return { root, base, first, second };
}

function spec(): ReviewRoundSpec {
	return {
		pr: 212,
		fences: { outOfScope: [], forbiddenRemedies: [], deferralHomes: [], priorFindings: [] },
		changeDescription: "d",
		delegateArgv: ["x"],
	};
}

function subjectAt(base: string, head: string): ReviewSubject {
	return {
		context: {
			repository: { id: "R_repo", host: "github.example", nameWithOwner: "owner/repo" },
			pullRequest: {
				id: "PR_node",
				number: 212,
				url: "https://github.example/owner/repo/pull/212",
				authorId: "U_writer",
				base: { repositoryId: "R_repo", name: "main", oid: base },
				head: { repositoryId: "R_repo", name: "feature", oid: head },
				closingIssues: [],
			},
		},
		writerId: "U_writer",
		activation: [],
		criteria: [],
	};
}

/** A resolved repair whose raw-to-effective relation is derivable. */
function repair(head: string, finding = "the same repair remains open"): ReviewRecord {
	return {
		head,
		slots: [{ slot: SLOT, valid: true }],
		bundle: [{ finding, slot: SLOT }],
		adjudication: {
			dedupAttested: true,
			rulings: [
				{
					finding,
					provenance: [SLOT],
					validity: "CONFIRMED",
					severity: "SUBSTANTIVE",
					direction: "fail-closed",
					onCriterion: true,
					evidence: "inspection",
				},
			],
		},
		review: {
			state: "resolved",
			resolution: { outcome: "repair", dispositions: [{ finding, disposition: "repair" }] },
		},
	};
}

/** PR #376's shape: two raw findings from the suite slot, one ruling — the second finding unruled. */
function unruledRepair(head: string): ReviewRecord {
	const record = repair(head, "missing Pi no-provisional-file test");
	record.slots = [{ slot: SUITE, valid: true }];
	record.bundle = [
		{ finding: "missing Pi no-provisional-file test", slot: SUITE },
		{ finding: "untested README contract pointer", slot: SUITE },
	];
	if (record.adjudication !== null) record.adjudication.rulings[0].provenance = [SUITE];
	return record;
}

type Comment = { id: number; authorId: string; authorLogin?: string; authorType?: string; body: string };
const writer = (id: number, body: string): Comment => ({
	id,
	authorId: "U_writer",
	authorLogin: "writer",
	authorType: "User",
	body,
});
const handoffBody = (cause: string, head: string, base: string) =>
	engine.encodeRecord(engine.RECORD_MARKERS.handoff, {
		cause,
		recipient: "maintainer",
		reentry: "none",
		observedAt: NOW,
		subjectHead: head,
		baseHead: base,
	});
const terminalBody = (recordCommentId: number, head: string, base: string) =>
	engine.encodeRecord(engine.RECORD_MARKERS.handoffTerminal, {
		recordCommentId,
		transition: "handoff-reentry",
		observedAt: NOW,
		subjectHead: head,
		baseHead: base,
	});

type Harness = {
	seams: ReviewRoundSeams;
	published: string[];
	rounds: () => number;
	dispatches: () => number;
	comments: Comment[];
};

function harness(
	_root: string,
	subject: ReviewSubject,
	initial: Comment[],
	options: {
		diagnosis?: DiagnosisInput;
		role?: string;
		writerAuthorized?: boolean;
		publishFails?: boolean;
		dispatchUnavailable?: boolean;
	} = {},
): Harness {
	const comments = [...initial];
	const published: string[] = [];
	let rounds = 0;
	let dispatches = 0;
	const handoff: HistoryHandoffSeams = {
		engine: async () => engine,
		permissionOf: async () => options.role ?? "admin",
		writerAuthorized: async () => options.writerAuthorized ?? true,
		now: () => NOW,
	};
	const round: Awaited<ReturnType<typeof reviewRound>> = {
		review: { state: "approved" },
		record: repair(subject.context.pullRequest.head.oid),
		recordBody: "approved-record",
	};
	const seams: ReviewRoundSeams = {
		fetchSubject: async () => subject,
		refetchSubject: async (_root, current) => current,
		readComments: async (): Promise<AttestedCommentPopulation> => ({ ok: true, comments: [...comments] }),
		recordsFromComments: recordsFromAttestedComments,
		resolveHead: () => subject.context.pullRequest.head.oid,
		makeDispatch: () => async () => {
			dispatches += 1;
			if (options.dispatchUnavailable || options.diagnosis === undefined)
				return {
					disposition: "refused",
					cause: "unavailable",
					diagnostic: { ...ADMITTED, status: "refused" },
				} as never;
			return {
				disposition: "admitted",
				ok: true,
				summary: "",
				compare: "confirmed",
				payload: JSON.stringify(options.diagnosis),
				diagnostic: ADMITTED,
			} as never;
		},
		runRound: async () => {
			rounds += 1;
			return round;
		},
		publishRecord: async (body) => {
			if (options.publishFails) return { ok: false, cause: "publish failed" };
			published.push(body);
			const id = 1000 + comments.length;
			comments.push(writer(id, body));
			return {
				ok: true,
				receipt: {
					repositoryId: "R_repo",
					pullRequestId: "PR_node",
					headOid: subject.context.pullRequest.head.oid,
					commentId: id,
					authorId: "U_writer",
					body,
				},
			};
		},
		publishAwaitingAuthor: async () => ({ ok: false, cause: "not expected" }),
		historyHandoff: handoff,
	};
	return { seams, published, rounds: () => rounds, dispatches: () => dispatches, comments };
}

const causeOf = (body: string) =>
	(engine.parseMarkedRecord(body, engine.RECORD_MARKERS.handoff) as { cause?: string } | undefined)?.cause;
const isTerminal = (body: string) => body.startsWith(engine.RECORD_MARKERS.handoffTerminal);

const STAGNATION: DiagnosisInput = { value: "STAGNATION", invalidation: "plan", evidence: "the same method repeats" };

describe("#404 the record every history hand-off writes", () => {
	it("writes limb (a) for PR #376's unruled legacy record, with no diagnosis dispatched", async () => {
		const r = repository();
		const h = harness(r.root, subjectAt(r.base, r.second), [
			writer(1, composeReviewRecord(repair(r.first))),
			writer(2, composeReviewRecord(unruledRepair(r.second))),
		]);
		const outcome = await driveReviewRound(spec(), r.root, h.seams);
		assert.equal(outcome.disposition, "hand-off");
		assert.equal(h.published.length, 1);
		assert.equal(causeOf(h.published[0]), HISTORY_HANDOFF_CAUSE.a);
		const record = engine.parseMarkedRecord(h.published[0], engine.RECORD_MARKERS.handoff) as Record<string, unknown>;
		assert.deepEqual(
			[record.recipient, record.reentry, record.subjectHead, record.baseHead],
			["maintainer", "none", r.second, r.base],
		);
		assert.equal(h.dispatches(), 0);
		assert.equal(h.rounds(), 0);
	});

	it("writes limb (c) for an environmental projection failure, never limb (a)", async () => {
		const r = repository();
		const missing = "f".repeat(40);
		const h = harness(r.root, subjectAt(r.base, r.second), [
			writer(1, composeReviewRecord(repair(missing))),
			writer(2, composeReviewRecord(repair(r.second))),
		]);
		await driveReviewRound(spec(), r.root, h.seams);
		assert.deepEqual(h.published.map(causeOf), [HISTORY_HANDOFF_CAUSE.c]);
	});

	it("writes limb (c) when the Judge is unavailable, and limb (b) with the invalidation for a handed-off ruling", async () => {
		const r = repository();
		const history = [writer(1, composeReviewRecord(repair(r.first))), writer(2, composeReviewRecord(repair(r.second)))];
		const unavailable = harness(r.root, subjectAt(r.base, r.second), history, { dispatchUnavailable: true });
		await driveReviewRound(spec(), r.root, unavailable.seams);
		assert.deepEqual(unavailable.published.map(causeOf), [HISTORY_HANDOFF_CAUSE.c]);
		const ruled = harness(r.root, subjectAt(r.base, r.second), history, { diagnosis: STAGNATION });
		const outcome = await driveReviewRound(spec(), r.root, ruled.seams);
		assert.equal(outcome.disposition, "hand-off");
		assert.deepEqual(ruled.published.map(causeOf), [HISTORY_HANDOFF_CAUSE.b]);
		const record = engine.parseMarkedRecord(ruled.published[0], engine.RECORD_MARKERS.handoff) as { reentry: string };
		assert.equal(record.reentry, "plan");
	});

	it("writes limb (b) with the route's reentry when the autonomous route ends in its handoff terminal", async () => {
		const r = repository();
		const h = harness(
			r.root,
			subjectAt(r.base, r.second),
			[writer(1, composeReviewRecord(repair(r.first))), writer(2, composeReviewRecord(repair(r.second)))],
			{ diagnosis: { value: "STAGNATION", invalidation: "nothing", evidence: "same method" } },
		);
		h.seams.recoveryDispatch = (async () => undefined) as never;
		h.seams.coordinateRecovery = (async () => ({
			terminal: "handoff",
			route: "none",
			cause: "allowance-consumed",
			reentry: "nothing",
			nextGate: "park",
			recordRef: null,
		})) as never;
		const outcome = await driveReviewRound(spec(), r.root, h.seams, {
			mergeMode: "off",
			mergeSource: "default",
			decisionMode: "autonomous",
			decisionSource: "default",
			refusals: [],
		});
		assert.equal(outcome.disposition, "recovery");
		assert.deepEqual(h.published.map(causeOf), [HISTORY_HANDOFF_CAUSE.b]);
		const record = engine.parseMarkedRecord(h.published[0], engine.RECORD_MARKERS.handoff) as { reentry: string };
		assert.equal(record.reentry, "nothing");
	});

	it("writes nothing and hands off when the account cannot pass authorizedResolver or the write fails", async () => {
		const r = repository();
		const history = [
			writer(1, composeReviewRecord(repair(r.first))),
			writer(2, composeReviewRecord(unruledRepair(r.second))),
		];
		for (const options of [{ writerAuthorized: false }, { publishFails: true }]) {
			const h = harness(r.root, subjectAt(r.base, r.second), history, options);
			const outcome = await driveReviewRound(spec(), r.root, h.seams);
			assert.ok(
				outcome.disposition === "hand-off" && outcome.cause.includes("could not be written"),
				JSON.stringify(outcome),
			);
			assert.equal(h.published.length, 0);
		}
	});
});

describe("#404 standing records", () => {
	it("hands off citing a standing limb-(a)/(b) record or another owner's, without a new diagnosis", async () => {
		const r = repository();
		for (const cause of [HISTORY_HANDOFF_CAUSE.a, HISTORY_HANDOFF_CAUSE.b, "another-owner-stop"]) {
			const h = harness(r.root, subjectAt(r.base, r.second), [writer(5, handoffBody(cause, r.second, r.base))], {
				diagnosis: STAGNATION,
			});
			const outcome = await driveReviewRound(spec(), r.root, h.seams);
			assert.ok(outcome.disposition === "hand-off" && outcome.cause.includes("standing"), cause);
			assert.equal(h.published.length, 0, cause);
			assert.equal(h.dispatches() + h.rounds(), 0, cause);
		}
	});

	it("keeps a standing limb-(c) record and writes no second record on another unmeasured stop", async () => {
		const r = repository();
		const h = harness(
			r.root,
			subjectAt(r.base, r.second),
			[
				writer(1, composeReviewRecord(repair(r.first))),
				writer(2, composeReviewRecord(repair(r.second))),
				writer(3, handoffBody(HISTORY_HANDOFF_CAUSE.c, r.second, r.base)),
			],
			{ dispatchUnavailable: true },
		);
		const outcome = await driveReviewRound(spec(), r.root, h.seams);
		assert.equal(outcome.disposition, "hand-off");
		assert.equal(h.published.length, 0);
	});

	it("ends a standing limb-(c) record on a valid ruling, then writes the limb-(b) record", async () => {
		const r = repository();
		const h = harness(
			r.root,
			subjectAt(r.base, r.second),
			[
				writer(1, composeReviewRecord(repair(r.first))),
				writer(2, composeReviewRecord(repair(r.second))),
				writer(3, handoffBody(HISTORY_HANDOFF_CAUSE.c, r.second, r.base)),
			],
			{ diagnosis: STAGNATION },
		);
		await driveReviewRound(spec(), r.root, h.seams);
		assert.equal(h.published.length, 2);
		assert.ok(isTerminal(h.published[0]));
		assert.equal(causeOf(h.published[1]), HISTORY_HANDOFF_CAUSE.b);
	});

	it("ends a standing limb-(c) record on a continuing ruling and proceeds to the panel, without a reset", async () => {
		const r = repository();
		const h = harness(
			r.root,
			subjectAt(r.base, r.second),
			[
				writer(1, composeReviewRecord(repair(r.first))),
				writer(2, composeReviewRecord(repair(r.second))),
				writer(3, handoffBody(HISTORY_HANDOFF_CAUSE.c, r.second, r.base)),
			],
			{ diagnosis: { value: "NONE", invalidation: "nothing", evidence: "advancing" } },
		);
		await driveReviewRound(spec(), r.root, h.seams);
		assert.equal(h.published.filter(isTerminal).length, 1);
		assert.equal(h.rounds(), 1);
		// The limb-(c) terminal is not a reset: a second round still sees the trigger.
		const again = harness(r.root, subjectAt(r.base, r.second), h.comments, { dispatchUnavailable: true });
		await driveReviewRound(spec(), r.root, again.seams);
		assert.equal(again.dispatches(), 1, "the trailing run was not reset by the limb-(c) terminal");
	});

	it("refuses an unreadable, ambiguous or unattested handoff population", async () => {
		const r = repository();
		const two = [
			writer(5, handoffBody(HISTORY_HANDOFF_CAUSE.c, r.second, r.base)),
			writer(6, handoffBody(HISTORY_HANDOFF_CAUSE.c, r.first, r.base)),
		];
		for (const [name, comments, role] of [
			["ambiguous", two, "admin"],
			["unattested carrier", [writer(5, handoffBody(HISTORY_HANDOFF_CAUSE.a, r.second, r.base))], "read"],
		] as const) {
			const h = harness(r.root, subjectAt(r.base, r.second), [...comments], { role });
			const outcome = await driveReviewRound(spec(), r.root, h.seams);
			assert.ok(outcome.disposition === "hand-off" && outcome.cause.includes("population"), name);
		}
		const h = harness(r.root, subjectAt(r.base, r.second), []);
		h.seams.readComments = async () => ({ ok: false, cause: "unreadable" });
		const outcome = await driveReviewRound(spec(), r.root, h.seams);
		assert.ok(outcome.disposition === "hand-off" && outcome.cause.includes("population"));
	});
});

describe("#404 re-entry", () => {
	it("re-enters PR #376's legacy prose handoff: limb-(a) record, terminal, then a full panel with history intact", async () => {
		const r = repository();
		const history = [
			writer(1, composeReviewRecord(repair(r.first))),
			writer(2, composeReviewRecord(unruledRepair(r.second))),
		];
		const h = harness(r.root, subjectAt(r.base, r.second), history);
		const result = await reenterReviewHistory(212, r.root, h.seams);
		assert.deepEqual(result, { disposition: "re-entered", limb: "a" });
		assert.equal(causeOf(h.published[0]), HISTORY_HANDOFF_CAUSE.a);
		assert.ok(isTerminal(h.published[1]));
		const next = harness(r.root, subjectAt(r.base, r.second), h.comments, { dispatchUnavailable: true });
		const outcome = await driveReviewRound(spec(), r.root, next.seams);
		assert.equal(next.dispatches(), 0, "no diagnosis after an honored re-entry");
		assert.equal(next.rounds(), 1, "the current-head panel ran");
		assert.equal(outcome.disposition, "posted");
		// Nothing was edited or deleted: the complete history still holds both repairs.
		const records = recordsFromAttestedComments({ ok: true, comments: next.comments }, "U_writer") ?? [];
		assert.equal(repairHistory(records).filter((state) => state.outcome === "repair").length, 2);
	});

	it("re-enters a standing limb-(b) record by its terminal at the record's heads", async () => {
		const r = repository();
		const h = harness(r.root, subjectAt(r.base, r.second), [
			writer(5, handoffBody(HISTORY_HANDOFF_CAUSE.b, r.first, r.base)),
		]);
		assert.deepEqual(await reenterReviewHistory(212, r.root, h.seams), { disposition: "re-entered", limb: "b" });
		const terminal = engine.parseMarkedRecord(h.published[0], engine.RECORD_MARKERS.handoffTerminal) as Record<
			string,
			unknown
		>;
		assert.deepEqual([terminal.recordCommentId, terminal.subjectHead], [5, r.first]);
	});

	it("refuses to re-enter a limb-(c) record, a derivable history, an unauthorized account, or an unattested population", async () => {
		const r = repository();
		const derivable = [
			writer(1, composeReviewRecord(repair(r.first))),
			writer(2, composeReviewRecord(repair(r.second))),
		];
		const cases: Array<[string, Comment[], Parameters<typeof harness>[3]]> = [
			["limb (c)", [writer(5, handoffBody(HISTORY_HANDOFF_CAUSE.c, r.second, r.base))], {}],
			["derivable history, prose route", derivable, {}],
			[
				"standing limb (a) no longer refusing",
				[...derivable, writer(5, handoffBody(HISTORY_HANDOFF_CAUSE.a, r.second, r.base))],
				{},
			],
			[
				"unauthorized",
				[writer(5, handoffBody(HISTORY_HANDOFF_CAUSE.b, r.second, r.base))],
				{ writerAuthorized: false },
			],
			["unattested", [writer(5, handoffBody(HISTORY_HANDOFF_CAUSE.b, r.second, r.base))], { role: "read" }],
		];
		for (const [name, comments, options] of cases) {
			const h = harness(r.root, subjectAt(r.base, r.second), comments, options);
			const result = await reenterReviewHistory(212, r.root, h.seams);
			assert.equal(result.disposition, "refused", name);
			assert.equal(h.published.length, 0, name);
		}
	});

	it("does not honor a limb-(a) terminal whose record-local check no longer refuses", async () => {
		const r = repository();
		const h = harness(
			r.root,
			subjectAt(r.base, r.second),
			[
				writer(1, composeReviewRecord(repair(r.first))),
				writer(2, composeReviewRecord(repair(r.second))),
				writer(3, handoffBody(HISTORY_HANDOFF_CAUSE.a, r.second, r.base)),
				writer(4, terminalBody(3, r.second, r.base)),
			],
			{ dispatchUnavailable: true },
		);
		await driveReviewRound(spec(), r.root, h.seams);
		assert.equal(h.dispatches(), 1, "the false limb-(a) terminal did not reset the run");
	});

	it("classifies limb (a) only by the record-local checks", () => {
		const r = { first: "1".repeat(40), second: "2".repeat(40) };
		assert.equal(legacyUnderivable(repairHistory([repair(r.first), unruledRepair(r.second)])), true);
		assert.equal(legacyUnderivable(repairHistory([repair(r.first), repair(r.second)])), false);
	});
});

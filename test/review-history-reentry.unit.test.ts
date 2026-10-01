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
	platformHistoryHandoffSeams,
	type ReviewRoundSeams,
	type ReviewRoundSpec,
	reenterReviewHistory,
	registerReviewRoundCommand,
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

	it("keeps a standing limb-(c) record on an environmental projection failure", async () => {
		const r = repository();
		const h = harness(r.root, subjectAt(r.base, r.second), [
			writer(1, composeReviewRecord(repair("f".repeat(40)))),
			writer(2, composeReviewRecord(repair(r.second))),
			writer(3, handoffBody(HISTORY_HANDOFF_CAUSE.c, r.second, r.base)),
		]);
		const outcome = await driveReviewRound(spec(), r.root, h.seams);
		assert.ok(outcome.disposition === "hand-off" && outcome.cause.includes("standing"), JSON.stringify(outcome));
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

describe("#404 unreadable and concurrent populations", () => {
	it("records an unreadable review record as limb (c) rather than refusing the population", async () => {
		const r = repository();
		const h = harness(r.root, subjectAt(r.base, r.second), [
			writer(1, composeReviewRecord(repair(r.first))),
			writer(2, `<!-- gitjig-review-record: ${r.second} -->\n\n\`\`\`json\n{not json\n\`\`\`\n`),
		]);
		const outcome = await driveReviewRound(spec(), r.root, h.seams);
		assert.equal(outcome.disposition, "hand-off");
		assert.deepEqual(h.published.map(causeOf), [HISTORY_HANDOFF_CAUSE.c]);
	});

	it("writes no second record when another record appears while the round runs", async () => {
		const r = repository();
		const h = harness(
			r.root,
			subjectAt(r.base, r.second),
			[writer(1, composeReviewRecord(repair(r.first))), writer(2, composeReviewRecord(repair(r.second)))],
			{ diagnosis: STAGNATION },
		);
		const dispatch = h.seams.makeDispatch;
		h.seams.makeDispatch = (input) => {
			const inner = dispatch(input);
			return async (brief, head) => {
				h.comments.push(writer(50, handoffBody("another-owner-stop", r.second, r.base)));
				return inner(brief, head);
			};
		};
		const outcome = await driveReviewRound(spec(), r.root, h.seams);
		assert.ok(outcome.disposition === "hand-off" && outcome.cause.includes("standing"), JSON.stringify(outcome));
		assert.equal(h.published.length, 0);
	});

	it("writes no second limb-(c) record when one appears while the round runs", async () => {
		const r = repository();
		const h = harness(
			r.root,
			subjectAt(r.base, r.second),
			[writer(1, composeReviewRecord(repair(r.first))), writer(2, composeReviewRecord(repair(r.second)))],
			{ dispatchUnavailable: true },
		);
		const dispatch = h.seams.makeDispatch;
		h.seams.makeDispatch = (input) => {
			const inner = dispatch(input);
			return async (brief, head) => {
				h.comments.push(writer(50, handoffBody(HISTORY_HANDOFF_CAUSE.c, r.second, r.base)));
				return inner(brief, head);
			};
		};
		const outcome = await driveReviewRound(spec(), r.root, h.seams);
		assert.equal(outcome.disposition, "hand-off");
		assert.equal(h.published.length, 0);
	});
});

describe("#404 round-4 paths", () => {
	it("ends a standing limb-(c) record and then writes limb (a) when the projection refuses record-locally", async () => {
		const r = repository();
		const h = harness(r.root, subjectAt(r.base, r.second), [
			writer(1, composeReviewRecord(repair(r.first))),
			writer(2, composeReviewRecord(unruledRepair(r.second))),
			writer(3, handoffBody(HISTORY_HANDOFF_CAUSE.c, r.second, r.base)),
		]);
		const outcome = await driveReviewRound(spec(), r.root, h.seams);
		assert.equal(outcome.disposition, "hand-off");
		assert.equal(h.published.length, 2);
		assert.ok(isTerminal(h.published[0]));
		assert.equal(causeOf(h.published[1]), HISTORY_HANDOFF_CAUSE.a);
	});

	it("encodes a handed-off authorization diagnosis as reentry authorization", async () => {
		const r = repository();
		const h = harness(
			r.root,
			subjectAt(r.base, r.second),
			[writer(1, composeReviewRecord(repair(r.first))), writer(2, composeReviewRecord(repair(r.second)))],
			{ diagnosis: { value: "STAGNATION", invalidation: "authorization", evidence: "the grant no longer fits" } },
		);
		await driveReviewRound(spec(), r.root, h.seams);
		assert.deepEqual(h.published.map(causeOf), [HISTORY_HANDOFF_CAUSE.b]);
		const record = engine.parseMarkedRecord(h.published[0], engine.RECORD_MARKERS.handoff) as { reentry: string };
		assert.equal(record.reentry, "authorization");
	});

	it("re-attests the subject before each re-entry write and refuses on a moved subject", async () => {
		const r = repository();
		const legacy = [
			writer(1, composeReviewRecord(repair(r.first))),
			writer(2, composeReviewRecord(unruledRepair(r.second))),
		];
		const standing = [writer(5, handoffBody(HISTORY_HANDOFF_CAUSE.b, r.second, r.base))];
		for (const [name, comments, staleAfter] of [
			["legacy route, before the record", legacy, 0],
			["legacy route, before the terminal", legacy, 1],
			["standing record, before the terminal", standing, 0],
		] as const) {
			const h = harness(r.root, subjectAt(r.base, r.second), [...comments]);
			let refetches = 0;
			h.seams.refetchSubject = async (_root, current) => (refetches++ < staleAfter ? current : undefined);
			const result = await reenterReviewHistory(212, r.root, h.seams);
			assert.ok(result.disposition === "refused" && result.cause.includes("re-attested"), name);
			assert.equal(h.published.length, staleAfter, name);
		}
	});

	it("turns a thrown subject read or write into a refusal", async () => {
		const r = repository();
		for (const seam of ["fetchSubject", "publishRecord"] as const) {
			const h = harness(r.root, subjectAt(r.base, r.second), [
				writer(5, handoffBody(HISTORY_HANDOFF_CAUSE.b, r.second, r.base)),
			]);
			h.seams[seam] = async () => {
				throw new Error(`${seam} exploded`);
			};
			const result = await reenterReviewHistory(212, r.root, h.seams).catch((error: unknown) =>
				assert.fail(`the re-entry threw instead of refusing: ${String(error)}`),
			);
			assert.ok(result.disposition === "refused" && result.cause.includes("failed"), seam);
		}
	});

	it("re-attests the subject before the round's own handoff writes", async () => {
		const r = repository();
		const cases: Array<[string, Comment[]]> = [
			[
				"limb (a) record",
				[writer(1, composeReviewRecord(repair(r.first))), writer(2, composeReviewRecord(unruledRepair(r.second)))],
			],
			[
				"limb (c) terminal",
				[
					writer(1, composeReviewRecord(repair(r.first))),
					writer(2, composeReviewRecord(unruledRepair(r.second))),
					writer(3, handoffBody(HISTORY_HANDOFF_CAUSE.c, r.second, r.base)),
				],
			],
		];
		for (const [name, comments] of cases) {
			const h = harness(r.root, subjectAt(r.base, r.second), comments);
			// The subject moves only after the authority check that immediately
			// precedes the handoff writes, so earlier drift checks still pass.
			let atWrite = false;
			const handoff = h.seams.historyHandoff;
			assert.ok(handoff);
			h.seams.historyHandoff = {
				...handoff,
				writerAuthorized: async (subject) => {
					atWrite = true;
					return handoff.writerAuthorized(subject);
				},
			};
			h.seams.refetchSubject = async (_root, current) => (atWrite ? undefined : current);
			const outcome = await driveReviewRound(spec(), r.root, h.seams);
			assert.ok(outcome.disposition === "hand-off" && outcome.cause.includes("changed"), name);
			assert.equal(h.published.length, 0, name);
		}
	});

	it("re-reads authority before every write, so a revocation after the first write stops the second", async () => {
		const r = repository();
		const revokeAfterFirst = (h: Harness) => {
			const handoff = h.seams.historyHandoff;
			assert.ok(handoff);
			h.seams.historyHandoff = { ...handoff, writerAuthorized: async () => h.published.length === 0 };
		};
		const settle = harness(r.root, subjectAt(r.base, r.second), [
			writer(1, composeReviewRecord(repair(r.first))),
			writer(2, composeReviewRecord(unruledRepair(r.second))),
			writer(3, handoffBody(HISTORY_HANDOFF_CAUSE.c, r.second, r.base)),
		]);
		revokeAfterFirst(settle);
		const outcome = await driveReviewRound(spec(), r.root, settle.seams);
		assert.ok(
			outcome.disposition === "hand-off" && outcome.cause.includes("could not be written"),
			JSON.stringify(outcome),
		);
		assert.equal(settle.published.length, 1);
		assert.ok(isTerminal(settle.published[0]));
		const legacy = harness(r.root, subjectAt(r.base, r.second), [
			writer(1, composeReviewRecord(repair(r.first))),
			writer(2, composeReviewRecord(unruledRepair(r.second))),
		]);
		revokeAfterFirst(legacy);
		const result = await reenterReviewHistory(212, r.root, legacy.seams);
		assert.ok(result.disposition === "refused" && result.cause.includes("authorizedResolver"), JSON.stringify(result));
		assert.equal(legacy.published.length, 1);
		assert.equal(causeOf(legacy.published[0]), HISTORY_HANDOFF_CAUSE.a);
	});

	it("writes nothing when the account cannot pass authorizedResolver before ending a standing limb-(c) record", async () => {
		const r = repository();
		const h = harness(
			r.root,
			subjectAt(r.base, r.second),
			[
				writer(1, composeReviewRecord(repair(r.first))),
				writer(2, composeReviewRecord(unruledRepair(r.second))),
				writer(3, handoffBody(HISTORY_HANDOFF_CAUSE.c, r.second, r.base)),
			],
			{ writerAuthorized: false },
		);
		const outcome = await driveReviewRound(spec(), r.root, h.seams);
		assert.ok(
			outcome.disposition === "hand-off" && outcome.cause.includes("could not be written"),
			JSON.stringify(outcome),
		);
		assert.equal(h.published.length, 0);
	});

	it("re-reads the population before each re-entry write and refuses when it changed", async () => {
		const r = repository();
		const standing = harness(r.root, subjectAt(r.base, r.second), [
			writer(5, handoffBody(HISTORY_HANDOFF_CAUSE.b, r.second, r.base)),
		]);
		// A concurrent re-entry terminalizes the record after the initial read.
		const refetch = standing.seams.refetchSubject;
		standing.seams.refetchSubject = async (root, current) => {
			if (!standing.comments.some((comment) => comment.id === 60))
				standing.comments.push(writer(60, terminalBody(5, r.second, r.base)));
			return refetch(root, current);
		};
		const result = await reenterReviewHistory(212, r.root, standing.seams);
		assert.ok(result.disposition === "refused" && result.cause.includes("changed"), JSON.stringify(result));
		assert.equal(standing.published.length, 0);
		const legacy = harness(r.root, subjectAt(r.base, r.second), [
			writer(1, composeReviewRecord(repair(r.first))),
			writer(2, composeReviewRecord(unruledRepair(r.second))),
		]);
		// Another account writes the limb-(a) record after the initial read.
		legacy.seams.refetchSubject = async (_root, current) => {
			if (!legacy.comments.some((comment) => comment.id === 61))
				legacy.comments.push(writer(61, handoffBody(HISTORY_HANDOFF_CAUSE.a, r.second, r.base)));
			return current;
		};
		const second = await reenterReviewHistory(212, r.root, legacy.seams);
		assert.ok(second.disposition === "refused" && second.cause.includes("changed"), JSON.stringify(second));
		assert.equal(legacy.published.length, 0);
	});

	it("refuses when the population becomes unreadable before a re-entry write", async () => {
		const r = repository();
		const h = harness(r.root, subjectAt(r.base, r.second), [
			writer(5, handoffBody(HISTORY_HANDOFF_CAUSE.b, r.second, r.base)),
		]);
		let reads = 0;
		const read = h.seams.readComments;
		h.seams.readComments = async (root, subject) =>
			reads++ === 0 ? read(root, subject) : { ok: false, cause: "gone" };
		const result = await reenterReviewHistory(212, r.root, h.seams);
		assert.ok(
			result.disposition === "refused" && result.cause.includes("unreadable or ambiguous"),
			JSON.stringify(result),
		);
		assert.equal(h.published.length, 0);
	});

	it("refuses a pr beyond the safe-integer range before any read", async () => {
		const r = repository();
		const h = harness(r.root, subjectAt(r.base, r.second), []);
		let fetched = 0;
		h.seams.fetchSubject = async () => {
			fetched += 1;
			return undefined;
		};
		for (const pr of [Number("9999999999999999"), 2 ** 53, 0, 1.5]) {
			const result = await reenterReviewHistory(pr, r.root, h.seams);
			assert.ok(result.disposition === "refused" && result.cause.includes("safe integer"), String(pr));
		}
		assert.equal(fetched, 0);
	});

	it("writes no record when another appears between ending limb (c) and writing limb (a)", async () => {
		const r = repository();
		const h = harness(r.root, subjectAt(r.base, r.second), [
			writer(1, composeReviewRecord(repair(r.first))),
			writer(2, composeReviewRecord(unruledRepair(r.second))),
			writer(3, handoffBody(HISTORY_HANDOFF_CAUSE.c, r.second, r.base)),
		]);
		const publish = h.seams.publishRecord;
		h.seams.publishRecord = async (body, subject) => {
			const receipt = await publish(body, subject);
			if (isTerminal(body)) h.comments.push(writer(70, handoffBody("another-owner-stop", r.second, r.base)));
			return receipt;
		};
		const outcome = await driveReviewRound(spec(), r.root, h.seams);
		assert.ok(outcome.disposition === "hand-off" && outcome.cause.includes("standing"), JSON.stringify(outcome));
		assert.equal(h.published.length, 1);
		assert.ok(isTerminal(h.published[0]));
	});

	it("refuses the round's handoff write when the population becomes unreadable before it", async () => {
		const r = repository();
		const h = harness(r.root, subjectAt(r.base, r.second), [
			writer(1, composeReviewRecord(repair(r.first))),
			writer(2, composeReviewRecord(unruledRepair(r.second))),
		]);
		const handoff = h.seams.historyHandoff;
		assert.ok(handoff);
		let atWrite = false;
		h.seams.historyHandoff = {
			...handoff,
			writerAuthorized: async (subject) => {
				atWrite = true;
				return handoff.writerAuthorized(subject);
			},
		};
		const read = h.seams.readComments;
		h.seams.readComments = async (root, subject) => (atWrite ? { ok: false, cause: "gone" } : read(root, subject));
		const outcome = await driveReviewRound(spec(), r.root, h.seams);
		assert.ok(
			outcome.disposition === "hand-off" && outcome.cause.includes("unreadable or ambiguous"),
			JSON.stringify(outcome),
		);
		assert.equal(h.published.length, 0);
	});

	it("cites a standing limb-(c) record on a later unmeasured stop, before any authority read", async () => {
		const r = repository();
		const h = harness(
			r.root,
			subjectAt(r.base, r.second),
			[
				writer(1, composeReviewRecord(repair(r.first))),
				writer(2, composeReviewRecord(repair(r.second))),
				writer(3, handoffBody(HISTORY_HANDOFF_CAUSE.c, r.second, r.base)),
			],
			{ dispatchUnavailable: true, writerAuthorized: false },
		);
		const outcome = await driveReviewRound(spec(), r.root, h.seams);
		assert.ok(outcome.disposition === "hand-off" && outcome.cause.includes("standing"), JSON.stringify(outcome));
		assert.equal(h.published.length, 0);
	});

	it("hands off citing a record that appeared during the round even when the round would continue", async () => {
		const r = repository();
		const h = harness(
			r.root,
			subjectAt(r.base, r.second),
			[writer(1, composeReviewRecord(repair(r.first))), writer(2, composeReviewRecord(repair(r.second)))],
			{ diagnosis: { value: "NONE", invalidation: "nothing", evidence: "advancing" } },
		);
		const dispatch = h.seams.makeDispatch;
		h.seams.makeDispatch = (input) => {
			const inner = dispatch(input);
			return async (brief, head) => {
				if (!h.comments.some((comment) => comment.id === 90))
					h.comments.push(writer(90, handoffBody("another-owner-stop", r.second, r.base)));
				return inner(brief, head);
			};
		};
		const outcome = await driveReviewRound(spec(), r.root, h.seams);
		assert.ok(outcome.disposition === "hand-off" && outcome.cause.includes("standing"), JSON.stringify(outcome));
		assert.equal(h.rounds(), 0);
		assert.equal(h.published.length, 0);
	});

	it("writes nothing when a re-entry lands while the round diagnoses", async () => {
		const r = repository();
		const h = harness(
			r.root,
			subjectAt(r.base, r.second),
			[writer(1, composeReviewRecord(repair(r.first))), writer(2, composeReviewRecord(repair(r.second)))],
			{ diagnosis: STAGNATION },
		);
		const dispatch = h.seams.makeDispatch;
		h.seams.makeDispatch = (input) => {
			const inner = dispatch(input);
			return async (brief, head) => {
				if (!h.comments.some((comment) => comment.id === 96)) {
					h.comments.push(writer(96, handoffBody(HISTORY_HANDOFF_CAUSE.b, r.second, r.base)));
					h.comments.push(writer(97, terminalBody(96, r.second, r.base)));
				}
				return inner(brief, head);
			};
		};
		const outcome = await driveReviewRound(spec(), r.root, h.seams);
		assert.ok(outcome.disposition === "hand-off" && outcome.cause.includes("re-entry landed"), JSON.stringify(outcome));
		assert.equal(h.published.length, 0);
	});

	it("ends a limb-(c) record that appeared during the round when the round becomes determinate", async () => {
		const r = repository();
		const h = harness(
			r.root,
			subjectAt(r.base, r.second),
			[writer(1, composeReviewRecord(repair(r.first))), writer(2, composeReviewRecord(repair(r.second)))],
			{ diagnosis: STAGNATION },
		);
		const dispatch = h.seams.makeDispatch;
		h.seams.makeDispatch = (input) => {
			const inner = dispatch(input);
			return async (brief, head) => {
				if (!h.comments.some((comment) => comment.id === 80))
					h.comments.push(writer(80, handoffBody(HISTORY_HANDOFF_CAUSE.c, r.second, r.base)));
				return inner(brief, head);
			};
		};
		await driveReviewRound(spec(), r.root, h.seams);
		assert.equal(h.published.length, 2);
		assert.ok(isTerminal(h.published[0]));
		assert.equal(
			(engine.parseMarkedRecord(h.published[0], engine.RECORD_MARKERS.handoffTerminal) as { recordCommentId: number })
				.recordCommentId,
			80,
		);
		assert.equal(causeOf(h.published[1]), HISTORY_HANDOFF_CAUSE.b);
	});

	it("recomputes the legacy check on the fresh history before each limb-(a) write", async () => {
		const r = repository();
		const legacy = () => [
			writer(1, composeReviewRecord(repair(r.first))),
			writer(2, composeReviewRecord(unruledRepair(r.second))),
		];
		// A derivable approved state arrives after the initial read: the trailing run is gone.
		const resolve = (h: Harness) => {
			const refetch = h.seams.refetchSubject;
			h.seams.refetchSubject = async (root, current) => {
				if (!h.comments.some((comment) => comment.id === 95))
					h.comments.push(
						writer(95, composeReviewRecord({ ...repair(r.second), review: { state: "approved" } } as ReviewRecord)),
					);
				return refetch(root, current);
			};
		};
		const prose = harness(r.root, subjectAt(r.base, r.second), legacy());
		resolve(prose);
		const result = await reenterReviewHistory(212, r.root, prose.seams);
		assert.ok(result.disposition === "refused" && result.cause.includes("legacy check"), JSON.stringify(result));
		assert.equal(prose.published.length, 0);
		const standing = harness(r.root, subjectAt(r.base, r.second), [
			...legacy(),
			writer(3, handoffBody(HISTORY_HANDOFF_CAUSE.a, r.second, r.base)),
		]);
		resolve(standing);
		const second = await reenterReviewHistory(212, r.root, standing.seams);
		assert.ok(second.disposition === "refused" && second.cause.includes("legacy check"), JSON.stringify(second));
		assert.equal(standing.published.length, 0);
		const round = harness(r.root, subjectAt(r.base, r.second), legacy());
		const handoff = round.seams.historyHandoff;
		assert.ok(handoff);
		round.seams.historyHandoff = {
			...handoff,
			writerAuthorized: async (subject) => {
				if (!round.comments.some((comment) => comment.id === 95))
					round.comments.push(
						writer(95, composeReviewRecord({ ...repair(r.second), review: { state: "approved" } } as ReviewRecord)),
					);
				return handoff.writerAuthorized(subject);
			},
		};
		await driveReviewRound(spec(), r.root, round.seams);
		assert.deepEqual(round.published.map(causeOf), [HISTORY_HANDOFF_CAUSE.c]);
	});

	it("passes a matched sixteen-digit safe pr to the subject read exactly", async () => {
		const r = repository();
		const h = harness(r.root, subjectAt(r.base, r.second), []);
		const asked: number[] = [];
		h.seams.fetchSubject = async (_root, pr) => {
			asked.push(pr);
			return undefined;
		};
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const pi = {
			registerCommand: (_name: string, command: { handler: typeof handler }) => {
				handler = command.handler;
			},
			appendEntry: () => {},
			sendMessage: () => {},
		} as never;
		registerReviewRoundCommand(
			pi,
			r.root,
			r.root,
			{ mergeMode: "off", mergeSource: "default", decisionMode: "handoff", decisionSource: "default", refusals: [] },
			h.seams,
		);
		assert.ok(handler);
		await handler("reenter pr=1234567890123456", { waitForIdle: async () => {} });
		await handler("reenter pr=9007199254740993", { waitForIdle: async () => {} });
		assert.deepEqual(asked, [1234567890123456]);
	});

	it("reads the production login and permission as gh scalars, without the line terminator", async () => {
		const bin = mkdtempSync(join(tmpdir(), "gitjig-404-gh-"));
		dirs.push(bin);
		writeFileSync(
			join(bin, "gh"),
			'#!/bin/sh\ncase "$*" in *" user "*) printf "writer\\n" ;; *permission*) printf "admin\\n" ;; *) exit 1 ;; esac\n',
			{ mode: 0o755 },
		);
		const path = process.env.PATH;
		process.env.PATH = `${bin}:${path ?? ""}`;
		try {
			const seams = platformHistoryHandoffSeams(bin);
			const subject = subjectAt("1".repeat(40), "2".repeat(40));
			assert.equal(await seams.permissionOf(subject, "writer"), "admin");
			assert.equal(await seams.writerAuthorized(subject), true);
		} finally {
			process.env.PATH = path;
		}
	});
});

describe("#404 the registered command", () => {
	it("routes `/review-round reenter pr=<n>` to the re-entry and nothing else", async () => {
		const r = repository();
		const h = harness(r.root, subjectAt(r.base, r.second), [
			writer(1, composeReviewRecord(repair(r.first))),
			writer(2, composeReviewRecord(unruledRepair(r.second))),
		]);
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		let description = "";
		const entries: unknown[] = [];
		const pi = {
			registerCommand: (_name: string, spec: { handler: typeof handler; description: string }) => {
				handler = spec.handler;
				description = spec.description;
			},
			appendEntry: (_type: string, data: unknown) => entries.push(data),
			sendMessage: () => {},
		} as never;
		registerReviewRoundCommand(
			pi,
			r.root,
			r.root,
			{ mergeMode: "off", mergeSource: "default", decisionMode: "handoff", decisionSource: "default", refusals: [] },
			h.seams,
		);
		assert.ok(handler);
		assert.ok(
			description.includes(
				"/review-round reenter pr=<n> re-enters a standing §1.4 limb-(a)/(b) review-history handoff or a refusing limb-(a) legacy-prose history (SPEC §1.4).",
			),
			description,
		);
		await handler("reenter pr=212", { waitForIdle: async () => {} });
		assert.deepEqual(entries, [{ disposition: "re-entered", limb: "a" }]);
		assert.equal(h.rounds() + h.dispatches(), 0);
		for (const args of ["reenter pr=0", "reenter 212", "reenter pr=212 extra"]) {
			entries.length = 0;
			await handler(args, { waitForIdle: async () => {} });
			assert.equal((entries[0] as { disposition?: string }).disposition, "refused", args);
		}
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
		const outcome = await driveReviewRound(spec(), r.root, h.seams);
		// The refused terminal neither resets the run nor ends the record: the
		// round fails closed to the standing limb-(a) hand-off.
		assert.ok(outcome.disposition === "hand-off" && outcome.cause.includes("standing"), JSON.stringify(outcome));
		assert.equal(h.published.length, 0);
		assert.equal(h.dispatches() + h.rounds(), 0);
	});

	it("refuses a population where a refused limb-(a) terminal and a later record both stand", async () => {
		const r = repository();
		const h = harness(r.root, subjectAt(r.base, r.second), [
			writer(1, composeReviewRecord(repair(r.first))),
			writer(2, composeReviewRecord(repair(r.second))),
			writer(3, handoffBody(HISTORY_HANDOFF_CAUSE.a, r.second, r.base)),
			writer(4, terminalBody(3, r.second, r.base)),
			writer(5, handoffBody(HISTORY_HANDOFF_CAUSE.c, r.second, r.base)),
		]);
		const outcome = await driveReviewRound(spec(), r.root, h.seams);
		assert.ok(outcome.disposition === "hand-off" && outcome.cause.includes("population"), JSON.stringify(outcome));
		assert.equal(h.published.length, 0);
	});

	it("writes the contract's exact cause bytes", () => {
		assert.deepEqual(
			{ ...HISTORY_HANDOFF_CAUSE },
			{
				a: "review-history-legacy-underivable",
				b: "review-history-diagnosis-handoff",
				c: "review-history-unmeasured",
			},
		);
	});

	it("classifies limb (a) by each record-local check, each shape tripping only its own predicate", () => {
		const good = () => repair("2".repeat(40));
		const first = repair("1".repeat(40));
		const ruling0 = (record: ReviewRecord) => {
			const ruling = record.adjudication?.rulings[0];
			assert.ok(ruling);
			return ruling;
		};
		const dispositions = (record: ReviewRecord) => {
			assert.ok(record.review.state === "resolved");
			return record.review.resolution.dispositions;
		};
		const shapes: Array<[string, (record: ReviewRecord) => void]> = [
			["adjudication null", (record) => Object.assign(record, { adjudication: null })],
			["dedup not attested", (record) => Object.assign(record.adjudication ?? {}, { dedupAttested: false })],
			[
				"empty raw bundle",
				(record) => {
					record.bundle = [];
					if (record.adjudication !== null) record.adjudication.rulings = [];
					dispositions(record).length = 0;
				},
			],
			[
				// Implied, not a separate predicate: the extra ruling's provenance
				// exhausts the raw multiset (see unversionedRepairFindings).
				"more effective rulings than raw findings",
				(record) => {
					record.adjudication?.rulings.push({ ...ruling0(record), finding: "another" });
					dispositions(record).push({ finding: "another", disposition: "repair" });
				},
			],
			[
				"repeated ruling and disposition finding",
				(record) => {
					record.bundle.push({ finding: "raw two", slot: SLOT });
					record.adjudication?.rulings.push({ ...ruling0(record) });
					dispositions(record).push({ ...dispositions(record)[0] });
				},
			],
			[
				"disposition count differs from ruling count",
				(record) => dispositions(record).push({ finding: "extra", disposition: "repair" }),
			],
			[
				"empty provenance while another ruling carries both raw slots",
				(record) => {
					record.bundle.push({ finding: "raw two", slot: SLOT });
					ruling0(record).provenance = [SLOT, SLOT];
					record.adjudication?.rulings.push({ ...ruling0(record), finding: "another", provenance: [] });
					dispositions(record).push({ finding: "another", disposition: "repair" });
				},
			],
			["empty evidence", (record) => Object.assign(ruling0(record), { evidence: "" })],
			["CONFIRMED without severity", (record) => Object.assign(ruling0(record), { severity: undefined })],
			["CONFIRMED without direction", (record) => Object.assign(ruling0(record), { direction: undefined })],
			["CONFIRMED without AC impact", (record) => Object.assign(ruling0(record), { onCriterion: undefined })],
			["CONFIRMED NIT without remedy", (record) => Object.assign(ruling0(record), { severity: "NIT" })],
			["unknown slot beside every raw slot", (record) => Object.assign(ruling0(record), { provenance: [SLOT, SUITE] })],
			["overused raw slot", (record) => Object.assign(ruling0(record), { provenance: [SLOT, SLOT] })],
			["provenance slots not the raw multiset", (record) => Object.assign(ruling0(record), { provenance: [SUITE] })],
			["raw contribution left unconsumed", (record) => record.bundle.push({ finding: "raw two", slot: SLOT })],
			[
				"disposition at the ruling's index names another finding",
				(record) => {
					dispositions(record)[0] = { finding: "different", disposition: "repair" };
				},
			],
		];
		// Baseline: the unmodified shape is derivable, so each refusal is the shape's.
		assert.equal(legacyUnderivable(repairHistory([first, good()])), false);
		// A NIT that carries its remedy stays derivable (the remedy clause is the trigger).
		const nit = good();
		Object.assign(ruling0(nit), { severity: "NIT", remedy: "replace x with y" });
		assert.equal(legacyUnderivable(repairHistory([first, nit])), false);
		// A throw is never a classification: it fails this assertion too.
		const classify = (record: ReviewRecord): boolean | string => {
			try {
				return legacyUnderivable(repairHistory([first, record]));
			} catch (error) {
				return `threw: ${String(error)}`;
			}
		};
		for (const [name, shape] of shapes) {
			const record = good();
			shape(record);
			assert.equal(classify(record), true, name);
		}
	});

	it("classifies limb (a) only by the record-local checks", () => {
		const r = { first: "1".repeat(40), second: "2".repeat(40) };
		assert.equal(legacyUnderivable(repairHistory([repair(r.first), unruledRepair(r.second)])), true);
		assert.equal(legacyUnderivable(repairHistory([repair(r.first), repair(r.second)])), false);
	});
});

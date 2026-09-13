/**
 * §3.3's `merge-review` gate (issue #190, Directive #28) — the tier-3
 * predicate over the durable review record.
 *
 * Fixtures are composed through `record.ts`'s own `composeReviewRecord`,
 * never hand-typed JSON (issue #190 AC8): a hand-typed body measures the
 * test author's idea of the record's shape, not the record's.
 *
 * Arm method, bound by issue #190 and carried from PR #187's §1.4
 * STAGNATION ruling — whose recurrence class was arms whose titles state
 * a general property over a domain, backed by fixtures sampling one
 * point of it:
 *   1. a closed, enumerable domain is ITERATED, never sampled;
 *   2. an unbounded domain gets cardinality >= 2, needles distinct by
 *      construction;
 *   3. a structured value is asserted WHOLE — deep equality on verdicts,
 *      never a bare flag, never a bare substring probe.
 *
 * The subject-absence anchor: the modules are pulled through guarded
 * dynamic imports, so an absent module surfaces an authored message and
 * never a raw module-resolution crash, and no arm goes green on it.
 * Measured, and narrower than a per-arm claim: with the predicate module
 * absent every arm reds on its own message; with the record module
 * absent five arms are never REGISTERED, because the marker fixture is
 * built in a describe body, so what surfaces is that describe's authored
 * failure rather than five arms'.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./harness/run-pi.ts";

const REVIEW_DIR = "/.pi/extensions/gitjig/review/";

type Slot = { lens: string; surface: string };
type Ruling = {
	finding: string;
	provenance: Slot[];
	validity: "CONFIRMED" | "REFUTED" | "INDETERMINATE";
	severity?: "SUBSTANTIVE" | "NIT";
	remedy?: string;
	direction?: "fail-closed" | "live-harm";
	evidence: string;
};
type ReviewState =
	| {
			state: "incomplete";
			cause: "panel" | "adjudication-missing" | "adjudication-incomplete";
			missing?: Slot[];
			gaps?: string[];
	  }
	| { state: "approved" }
	| { state: "resolved"; resolution: { dispositions: unknown[]; outcome: "repair" | "measure-escalate" | "clear" } };
type ReviewRecord = {
	head: string;
	slots: { slot: Slot; valid: boolean; reason?: string }[];
	bundle: { finding: string; slot: Slot }[];
	adjudication: { dedupAttested: boolean; rulings: Ruling[] } | null;
	review: ReviewState;
};

type RecordModule = {
	REVIEW_RECORD_MARKER: string;
	composeReviewRecord(record: ReviewRecord): string;
	parseReviewRecord(body: string): ReviewRecord | undefined;
};
type RefusalReason =
	| "lookup-failed"
	| "no-record-at-head"
	| "record-unreadable"
	| "panel-incomplete"
	| "adjudication-missing";
type CommentLookup = { ok: true; bodies: readonly string[] } | { ok: false; cause: string };
type MergeGateVerdict = { pass: true; record: ReviewRecord } | { pass: false; reason: RefusalReason; detail: string };
type GateModule = { mergeReviewGate(lookup: CommentLookup, head: string): MergeGateVerdict };

async function load<T>(name: string): Promise<{ mod?: T; error: string }> {
	try {
		return { mod: (await import(pathToFileURL(`${repoRoot()}${REVIEW_DIR}${name}`).href)) as T, error: "" };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
const recordLoad = await load<RecordModule>("record.ts");
const gateLoad = await load<GateModule>("merge-gate.ts");

function records(): RecordModule {
	assert.ok(recordLoad.mod, `record.ts did not load — the durable review record is absent: ${recordLoad.error}`);
	return recordLoad.mod;
}
function gate(): GateModule {
	assert.ok(gateLoad.mod, `merge-gate.ts did not load — §3.3's merge-review predicate is absent: ${gateLoad.error}`);
	return gateLoad.mod;
}

// Heads are 40-character hex, and the pair is chosen so the fixture can
// SEPARATE "compares the whole head" from "compares a prefix of it".
// Two runs of a single repeated letter
// differing at position 0 cannot: a prefix comparison of any length
// still tells them apart. These share 39 characters and differ only at
// the LAST, which is the shape a hash domain actually invites.
const HEAD_BASE = `7c4e1b9a02d53f86${"e".repeat(23)}`;
const HEAD_A = `${HEAD_BASE}1`;
const HEAD_B = `${HEAD_BASE}2`;
/** A strict prefix of HEAD_A — must not match it. */
const HEAD_PREFIX = HEAD_A.slice(0, HEAD_A.length - 1);
/** A head HEAD_A is a strict prefix OF — must not match it either. */
const HEAD_EXTENDED = `${HEAD_A}0`;
const SLOT: Slot = { lens: "runtime", surface: "the shell's runtime extensions" };

/** A complete, adjudicated, findings-carrying record — the pass shape. */
function adjudicatedRecord(head: string, over: Partial<ReviewRecord> = {}): ReviewRecord {
	return {
		head,
		slots: [{ slot: SLOT, valid: true }],
		bundle: [{ finding: "zq the finding", slot: SLOT }],
		adjudication: {
			dedupAttested: true,
			rulings: [
				{
					finding: "zq the finding",
					provenance: [SLOT],
					validity: "CONFIRMED",
					severity: "NIT",
					direction: "fail-closed",
					evidence: "zq the evidence",
				},
			],
		},
		review: { state: "resolved", resolution: { dispositions: [], outcome: "clear" } },
		...over,
	};
}

/** The marker line for a head, built from the exported constant. */
const MARKER_AT = (head: string): string => `<!-- ${records().REVIEW_RECORD_MARKER}: ${head} -->`;

function body(record: ReviewRecord): string {
	return records().composeReviewRecord(record);
}

describe("§3.3 merge-review — both arms, on real record bodies (issue #190 AC2)", () => {
	it("PASSES a head carrying a complete, adjudicated record that opens its own comment", () => {
		const record = adjudicatedRecord(HEAD_A);
		assert.deepEqual(
			gate().mergeReviewGate({ ok: true, bodies: [body(record)] }, HEAD_A),
			{ pass: true, record },
			"a complete adjudicated review pinned at the head under review did not satisfy §3.3's merge-review gate — " +
				"and the verdict is asserted WHOLE, so a gate that passes while returning a different record reds too",
		);
	});

	it("REFUSES the same head with no record present at all — absence is never approval", () => {
		const verdict = gate().mergeReviewGate({ ok: true, bodies: [] }, HEAD_A);
		assert.equal(
			verdict.pass,
			false,
			"an empty comment list satisfied the merge-review gate — absence is not an approval (§3.7(c))",
		);
		assert.equal(
			verdict.pass === false ? verdict.reason : undefined,
			"no-record-at-head",
			"the refusal did not name the absent record as its reason — §3.9's postures are auditable only if the " +
				"refusals are distinguishable",
		);
	});

	it("REFUSES a record pinned to a DIFFERENT head — the binding is the head under review, not any review", () => {
		const other = adjudicatedRecord(HEAD_B);
		const verdict = gate().mergeReviewGate({ ok: true, bodies: [body(other)] }, HEAD_A);
		// The expected `detail` is NOT copied from the verdict under test
		// (that asserts a value equals itself). It is
		// asserted independently below.
		assert.equal(verdict.pass, false, "a review of a different head satisfied the gate");
		assert.deepEqual(
			verdict.pass === false ? { pass: verdict.pass, reason: verdict.reason } : { pass: true },
			{
				pass: false,
				reason: "no-record-at-head",
			},
			"a review of a different head satisfied the gate — §1.6 pins a review to the head it ran at, so a stale " +
				"record would let an unreviewed head ride in on its predecessor's approval",
		);
		assert.ok(
			verdict.pass === false && verdict.detail.includes(HEAD_A) && !verdict.detail.includes(HEAD_B),
			"the refusal names the wrong head — it must report the head UNDER REVIEW, not the head the stale record " +
				"happens to carry, or an author chases the wrong artifact",
		);
	});
});

describe("§3.7(e) predicate integrity — canonical position, demonstrated not asserted (issue #190 AC3)", () => {
	// The whole point of this describe: a marker RELAYED verbatim inside
	// another artifact carries the right head and the right bytes, and
	// must still not satisfy the gate. Every fixture below is a real,
	// parseable record body — the difference is only where it sits.
	const record = adjudicatedRecord(HEAD_A);

	it("REFUSES a valid record relayed inside another comment, at every non-zero offset tried", () => {
		const relays: [string, string][] = [
			["a quoting preamble", `Quoting the round record for context:\n\n${body(record)}`],
			["a single leading space", ` ${body(record)}`],
			["a leading newline", `\n${body(record)}`],
			["a markdown blockquote", `> ${body(record)}`],
			["a trailing relay after real prose", `## Round 2 — panel record\n\nPrior round's record:\n${body(record)}`],
			// Every shape above relays behind text whose width is not the
			// marker prefix's, so all of them are refused by the SPAN
			// comparison alone — and against those shapes alone the
			// canonical-position guard can be dropped with the whole file
			// green: weakening `body.startsWith(prefix)` to
			// `body.includes(prefix)`, leaving the span comparison at its
			// fixed offset, gives 30 pass / 0 fail. AC3 requires a mutant
			// dropping EITHER half to red.
			//
			// This shape is the one that separates them: the relaying text is
			// EXACTLY as wide as the marker prefix, so the fixed-offset span
			// lands on this record's own head and terminator. Only the
			// position guard can refuse it. The width is computed from the
			// marker rather than typed, so a change to the marker cannot
			// silently make this fixture stop being the case it names.
			[
				"a relay whose preamble is exactly the marker prefix's width",
				`${"z".repeat(`<!-- ${records().REVIEW_RECORD_MARKER}: `.length)}${HEAD_A} -->\n\n${body(record)}`,
			],
		];
		for (const [shape, relayed] of relays) {
			// The relayed body really does parse — so what refuses it is
			// position, not readability. Pin that, or the arm proves nothing.
			assert.ok(
				records().parseReviewRecord(relayed) !== undefined,
				`the ${shape} fixture is not a parseable record, so it cannot demonstrate that POSITION is what refuses it`,
			);
			const verdict = gate().mergeReviewGate({ ok: true, bodies: [relayed] }, HEAD_A);
			assert.equal(
				verdict.pass,
				false,
				`a record relayed inside another artifact (${shape}) satisfied the gate — §3.7(e) forbids an evidence ` +
					"marker relayed verbatim inside some other trusted artifact from satisfying a gate",
			);
			assert.equal(
				verdict.pass === false ? verdict.reason : undefined,
				"no-record-at-head",
				`the ${shape} relay refused for the wrong reason — a relayed record is not "present but broken", it is absent`,
			);
		}
	});

	it("distinguishes position from head, and compares the head WHOLE — each half refuses on its own", () => {
		// The cross-product plus the two precision cases, and which row
		// catches which mutant is MEASURED. A gate comparing only a PREFIX
		// of the head (head.length - 1 characters, no terminator) reds on
		// the FIRST row, "right position, wrong head" — which is why HEAD_A
		// and HEAD_B differ only at their last character. A gate omitting
		// the marker's closing delimiter (the head's own width, compared
		// against the head alone) passes the first two rows and reds on the
		// THIRD — which is why HEAD_EXTENDED extends HEAD_A. Both mutants
		// die in this arm.
		const cases: [string, string, string][] = [
			["right position, wrong head", body(adjudicatedRecord(HEAD_B)), HEAD_A],
			["wrong position, right head", `relayed:\n${body(record)}`, HEAD_A],
			["a record pinned to a head this head is a strict PREFIX of", body(adjudicatedRecord(HEAD_EXTENDED)), HEAD_A],
			["a head that is a strict prefix of the record's head", body(record), HEAD_PREFIX],
		];
		for (const [shape, commentBody, head] of cases) {
			assert.equal(
				gate().mergeReviewGate({ ok: true, bodies: [commentBody] }, head).pass,
				false,
				`${shape} satisfied the gate — the canonical-position check and the head binding are independent ` +
					"requirements (§3.7(e)), and the head must be compared WHOLE and terminated: a prefix comparison, or " +
					"one omitting the marker's closing delimiter, admits a neighbouring head's record",
			);
		}
	});

	it("selects its artifact from the records AT THE HEAD, at every thread ordering tried", () => {
		// "beside" is a claim over BOTH orderings, so a one-point fixture
		// cannot carry it. A gate that presence-checks the records at the head
		// and then parses a body chosen from the WHOLE thread passes the first
		// row and reds on the second and third.
		const real = body(record);
		const relayedOther = `Quoting a prior round:\n${body(adjudicatedRecord(HEAD_B))}`;
		const prose = "## Round 2 — panel record\n\nprose only, no record";
		const threads: [string, string[]][] = [
			["the record last", [relayedOther, real]],
			["the record first", [real, relayedOther]],
			["the record neither first nor last", [relayedOther, real, prose]],
			["a non-opening body last", [real, prose]],
		];
		for (const [shape, bodies] of threads) {
			assert.deepEqual(
				gate().mergeReviewGate({ ok: true, bodies }, HEAD_A),
				{ pass: true, record },
				`a genuine record stopped satisfying the gate when the thread was ordered "${shape}" — the gate must ` +
					"SELECT its artifact from the records at the head, not read whichever body the thread happens to end with",
			);
		}
	});
});

describe("§3.7(c) fail-closed — the closed limb set, ITERATED not sampled (issue #190 AC4)", () => {
	// The four limbs issue #190 AC4 enumerates. Iterating the whole set is
	// the point: sampling one and titling the arm "fails closed" is the
	// exact defect PR #187 parked on.
	const limbs: [string, CommentLookup, RefusalReason][] = [
		["an unreachable comment list", { ok: false, cause: "network unreachable" }, "lookup-failed"],
		["an API failure", { ok: false, cause: "HTTP 503 from the platform" }, "lookup-failed"],
		[
			"a malformed record body",
			{ ok: true, bodies: [`${MARKER_AT(HEAD_A)}\n\n\`\`\`json\n{ not json\n\`\`\`\n`] },
			"record-unreadable",
		],
		[
			"an absent record",
			{ ok: true, bodies: ["## Round 1 — panel record\n\nprose only, no record"] },
			"no-record-at-head",
		],
	];

	for (const [shape, lookup, expected] of limbs) {
		it(`refuses on ${shape}, and names it — never reads it as a pass`, () => {
			const verdict = gate().mergeReviewGate(lookup, HEAD_A);
			assert.equal(
				verdict.pass,
				false,
				`${shape} was read as an approval — §3.7(c) makes an approval gate fail closed on lookup failure, and ` +
					"§5.2 makes the unreadable case a refusal rather than a pass",
			);
			assert.equal(
				verdict.pass === false ? verdict.reason : undefined,
				expected,
				`${shape} refused under the wrong reason — AC6 owes a DISTINCT authored reason per limb, so a gate ` +
					"collapsing them into one loses the audit this posture exists for",
			);
			// `detail.length > 0` is a bare flag, which the arm method this
			// file binds itself to forbids — a constant substituted for any
			// detail survives it. Every detail must carry the head it is
			// about, which is the binding the gate exists to report, and the
			// lookup limbs must carry the platform's cause.
			assert.ok(
				verdict.pass === false && verdict.detail.includes(HEAD_A),
				`${shape} refused with a detail that does not name the head under review — a refusal an operator cannot ` +
					'act on is the "no silent skip" defect (§3.7(b)) in its quiet form',
			);
		});
	}

	it("the failed lookup's cause reaches the detail — the gate reports what the platform said", () => {
		const verdict = gate().mergeReviewGate({ ok: false, cause: "zq the platform cause" }, HEAD_A);
		assert.ok(
			verdict.pass === false && verdict.detail.includes("zq the platform cause"),
			"the platform's own cause was dropped from the refusal — an operator cannot act on a refusal that will " +
				"not say what failed",
		);
	});
});

describe("§3.3 completeness and adjudication — the record's own fields (issue #190 AC1)", () => {
	it("refuses EVERY incomplete cause, CROSSED with the record shapes an incomplete panel yields", () => {
		// Iterating the cause axis while holding every other field at one
		// point is not enough, and an INCOHERENT held point is worse: a
		// one-entry bundle WITH an adjudication, handed to an arm asserting
		// incompleteness. An incomplete panel's real record has an empty
		// bundle and a null adjudication, so against that fixture a gate
		// refusing on `incomplete` only where the bundle is non-empty
		// survives.
		const causes = ["panel", "adjudication-missing", "adjudication-incomplete"] as const;
		const contexts: [string, Partial<ReviewRecord>][] = [
			["the shape an incomplete panel actually yields", { bundle: [], adjudication: null }],
			[
				"findings gathered before the panel failed",
				{ bundle: [{ finding: "zq partial", slot: SLOT }], adjudication: null },
			],
			["a bundle and an adjudication both present", {}],
		];
		for (const cause of causes) {
			for (const [context, over] of contexts) {
				const rec = adjudicatedRecord(HEAD_A, { ...over, review: { state: "incomplete", cause } });
				const verdict = gate().mergeReviewGate({ ok: true, bodies: [body(rec)] }, HEAD_A);
				assert.deepEqual(
					verdict.pass === false ? { pass: verdict.pass, reason: verdict.reason } : { pass: true },
					{ pass: false, reason: "panel-incomplete" },
					`an incomplete review (cause ${cause}, ${context}) did not refuse as panel-incomplete — §1.7 makes an ` +
						"incomplete review no review outcome at all, and the refusal must not be contingent on any other field",
				);
				assert.ok(
					verdict.pass === false && verdict.detail.includes(cause) && verdict.detail.includes(HEAD_A),
					`the refusal for cause ${cause} (${context}) did not carry BOTH the cause and the head — an author ` +
						"cannot tell a missing slot from a missing adjudication, nor which head, from a detail that omits them",
				);
			}
		}
	});

	it("refuses a NON-EMPTY bundle with no adjudication, at every bundle cardinality tried", () => {
		// Cardinality >= 2 by construction: a one-finding fixture would let
		// an implementation keyed on `bundle.length === 1` survive.
		for (const size of [1, 2, 3]) {
			const bundle = Array.from({ length: size }, (_, i) => ({ finding: `zq finding ${i}`, slot: SLOT }));
			const record = adjudicatedRecord(HEAD_A, { bundle, adjudication: null });
			const verdict = gate().mergeReviewGate({ ok: true, bodies: [body(record)] }, HEAD_A);
			assert.equal(
				verdict.pass,
				false,
				`a bundle of ${size} finding(s) with no Judge adjudication satisfied the gate — §1.9 forbids the ` +
					"author acting on an unadjudicated bundle, and this row consumes the adjudication by name",
			);
			assert.equal(
				verdict.pass === false ? verdict.reason : undefined,
				"adjudication-missing",
				`the unadjudicated bundle of ${size} refused under the wrong reason`,
			);
			assert.ok(
				verdict.pass === false && verdict.detail.includes(`${size} finding`) && verdict.detail.includes(HEAD_A),
				`the refusal for an unadjudicated bundle of ${size} did not carry BOTH the finding count and the head — ` +
					"a constant detail reports the wrong size and is indistinguishable from a correct one",
			);
		}
	});

	it("PASSES the findings-free path — an empty bundle owes no Judge, and requiring one would block it", () => {
		// The row's own qualifier is "where the bundle was non-empty". This
		// arm is the wrong-BLOCK direction: a gate demanding an adjudication
		// unconditionally would refuse every clean review.
		const record = adjudicatedRecord(HEAD_A, { bundle: [], adjudication: null, review: { state: "approved" } });
		assert.deepEqual(
			gate().mergeReviewGate({ ok: true, bodies: [body(record)] }, HEAD_A),
			{ pass: true, record },
			"a complete panel with an empty bundle was refused for lacking a Judge — §1.7 makes the findings-free " +
				"path terminal, and §3.3's row owes adjudication only where the bundle was non-empty",
		);
	});

	it("last record wins at one head — a re-issued record supersedes the one it re-issues", () => {
		// §1.9's nit carry-forward legitimately produces two records at one
		// head. Cardinality >= 2, needles distinct by construction: the
		// superseded record is INCOMPLETE and the re-issue is complete, so a
		// first-record-wins implementation reds.
		const superseded = adjudicatedRecord(HEAD_A, { review: { state: "incomplete", cause: "panel" } });
		const reissued = adjudicatedRecord(HEAD_A);
		assert.deepEqual(
			gate().mergeReviewGate({ ok: true, bodies: [body(superseded), body(reissued)] }, HEAD_A),
			{ pass: true, record: reissued },
			"the gate did not take the LAST record at the head — §1.9's nit carry-forward re-issues the evidence " +
				"artifact at the post-fix state, and a gate reading the superseded one blocks a change its own " +
				"review cleared",
		);
	});
});

describe("§3.11 — the record's shape rule has ONE home (issue #190 AC5)", () => {
	it("the gate parses through record.ts's parser, so the parser's contract decides the gate's verdict", () => {
		// The measurable consequence of being a call site rather than a
		// second implementation: a body record.ts REFUSES must not satisfy
		// the gate. Each fixture below opens its own comment with the right
		// head — so only the parser's own shape rule can reject them, and if
		// the gate carried its own looser rule, these would pass.
		const marker = `<!-- ${records().REVIEW_RECORD_MARKER}: ${HEAD_A} -->`;
		const rejected: [string, string][] = [
			[
				"an extra top-level key",
				`${marker}\n\n\`\`\`json\n${JSON.stringify({ ...adjudicatedRecord(HEAD_A), extra: 1 })}\n\`\`\`\n`,
			],
			[
				"a missing top-level key",
				`${marker}\n\n\`\`\`json\n${JSON.stringify({ head: HEAD_A, slots: [], bundle: [] })}\n\`\`\`\n`,
			],
			["no json fence at all", `${marker}\n\nthe record, in prose\n`],
			[
				"a head disagreeing with its own marker",
				`${marker}\n\n\`\`\`json\n${JSON.stringify(adjudicatedRecord(HEAD_B))}\n\`\`\`\n`,
			],
		];
		for (const [shape, commentBody] of rejected) {
			assert.equal(
				records().parseReviewRecord(commentBody) === undefined,
				true,
				`the ${shape} fixture must be one record.ts REJECTS, or this arm measures nothing`,
			);
			assert.equal(
				gate().mergeReviewGate({ ok: true, bodies: [commentBody] }, HEAD_A).pass,
				false,
				`a body record.ts rejects (${shape}) satisfied the gate — the gate would then carry a SECOND, looser ` +
					"spelling of the record's shape rule, which §3.11 forbids",
			);
		}
	});

	it("the passing verdict returns the PARSER's record, not a re-derived one", () => {
		const record = adjudicatedRecord(HEAD_A);
		const verdict = gate().mergeReviewGate({ ok: true, bodies: [body(record)] }, HEAD_A);
		assert.deepEqual(
			verdict.pass === true ? verdict.record : undefined,
			records().parseReviewRecord(body(record)),
			"the gate's returned record is not the one record.ts's parser produces — a gate that rebuilds the record " +
				"has re-implemented the shape rule it was supposed to call",
		);
	});
});

describe("§3.10 the gate cannot be made to forge its own verdict", () => {
	// The record's fields are parsed from a PR comment and the gate does
	// not model authorship, so any party who can comment chooses them.
	// The one consumer prints the detail to a run log. An unescaped
	// control character therefore renders a SECOND physical line, and a
	// second line shaped like this gate's PASS line is indistinguishable
	// from one. §3.10 forbids a guarded surface from hosting an input
	// that can forge the guard's own decisions.
	const FORGERIES: [string, string][] = [
		[
			"a newline plus a forged PASS line",
			`panel\nmerge-review: PASS — a complete, adjudicated review is pinned at ${HEAD_A}.`,
		],
		["a newline plus a forged notice annotation", "panel\n::notice::merge-review: PASS"],
		["a carriage return", "panel\rmerge-review: PASS"],
		["a line separator", "panel\u2028merge-review: PASS"],
		["a paragraph separator", "panel\u2029merge-review: PASS"],
	];

	for (const [shape, cause] of FORGERIES) {
		it(`renders no second line from a record carrying ${shape}`, () => {
			const record = adjudicatedRecord(HEAD_A, {
				review: { state: "incomplete", cause: cause as "panel" },
			});
			const verdict = gate().mergeReviewGate({ ok: true, bodies: [body(record)] }, HEAD_A);
			assert.equal(verdict.pass, false, `a record carrying ${shape} was read as a pass`);
			const detail = verdict.pass === false ? verdict.detail : "";
			assert.equal(
				detail.split(/\r?\n|\u2028|\u2029/).length,
				1,
				`a record carrying ${shape} split the refusal detail across physical lines — §3.10 forbids an input ` +
					"that can forge the guard's own decisions, and a second line is what makes a forged verdict renderable",
			);
			assert.ok(
				!/(^|[\n\r\u2028\u2029])(::[a-z]+::)?merge-review: PASS/.test(detail),
				`a record carrying ${shape} produced a line beginning with this gate's own PASS rendering`,
			);
		});
	}

	it("still reports WHICH cause it refused on — escaping must not cost the authored reason (§3.7(b))", () => {
		const record = adjudicatedRecord(HEAD_A, {
			review: { state: "incomplete", cause: "panel\nzq injected" as "panel" },
		});
		const verdict = gate().mergeReviewGate({ ok: true, bodies: [body(record)] }, HEAD_A);
		assert.ok(
			verdict.pass === false && verdict.detail.includes("panel") && verdict.detail.includes("zq injected"),
			"escaping dropped the cause instead of neutralising it — the refusal must still name what was missing, " +
				"or the fix for a forgery becomes a silent refusal",
		);
	});
});

describe("§3.11 the head is a REF — spelling folds, syntax does not", () => {
	// §3.11: "a differently-cased or aliased spelling of the same ref is
	// the same ref". A head is a ref, so refusing a genuine record because
	// its hex arrived upper-cased is a wrong-BLOCK on an identity that
	// never changed. Both directions are pinned, so the decision is
	// recorded in the arms rather than left to whichever way the code drifts.
	const record = adjudicatedRecord(HEAD_A);

	it("ACCEPTS a record whose head is the same ref differently cased, in both directions", () => {
		const cases: [string, string, string][] = [
			["record upper-cased, query lower-cased", HEAD_A.toUpperCase(), HEAD_A],
			["record lower-cased, query upper-cased", HEAD_A, HEAD_A.toUpperCase()],
			["mixed case on both sides", HEAD_A.toUpperCase(), HEAD_A.toLowerCase()],
		];
		for (const [shape, recordHead, queryHead] of cases) {
			const rec = adjudicatedRecord(recordHead);
			assert.equal(
				gate().mergeReviewGate({ ok: true, bodies: [body(rec)] }, queryHead).pass,
				true,
				`${shape} was refused — §3.11 makes a differently-cased spelling of the same ref the SAME ref, and a ` +
					"head is a ref, so this refusal blocks an identity that never changed",
			);
		}
	});

	it("does NOT fold the marker's own syntax — that is format, not a ref", () => {
		const upperMarker = body(record).replace(MARKER_AT(HEAD_A), MARKER_AT(HEAD_A).toUpperCase());
		const verdict = gate().mergeReviewGate({ ok: true, bodies: [upperMarker] }, HEAD_A);
		assert.deepEqual(
			verdict.pass === false ? { pass: verdict.pass, reason: verdict.reason } : { pass: true },
			{ pass: false, reason: "no-record-at-head" },
			"an upper-cased MARKER was not refused AS ABSENT — the marker's bytes are this format's literal syntax, " +
				"not a ref, so a folded marker must fail to OPEN a record rather than open one the parser then " +
				"happens to reject; asserting the reason is what stops the parser from masking the gate's own fold",
		);
	});

	it("folding does not weaken the head binding — a different head still refuses at every casing", () => {
		for (const [shape, recordHead] of [
			["a different head, upper-cased", HEAD_B.toUpperCase()],
			["a strict prefix, upper-cased", HEAD_PREFIX.toUpperCase()],
			["an extending head, upper-cased", HEAD_EXTENDED.toUpperCase()],
		] as const) {
			assert.equal(
				gate().mergeReviewGate({ ok: true, bodies: [body(adjudicatedRecord(recordHead))] }, HEAD_A).pass,
				false,
				`${shape} satisfied the gate — case folding must widen the SPELLING axis only, never the identity`,
			);
		}
	});
});

describe("§1.9 the PASS path does not read the Resolver's outcome or the slots", () => {
	// Both are closed domains the PASS fixtures held at one point.
	// Iterating them records the decision — this gate passes on all three
	// outcomes — rather than leaving it unmeasured. Issue #193 asks
	// whether that decision is right; this arm pins what it currently IS,
	// so #193's change cannot land silently.
	for (const outcome of ["repair", "measure-escalate", "clear"] as const) {
		it(`passes a resolved review whose outcome is ${outcome} — pinned, and #193 owns whether it should`, () => {
			const record = adjudicatedRecord(HEAD_A, {
				review: { state: "resolved", resolution: { dispositions: [], outcome } },
			});
			assert.deepEqual(
				gate().mergeReviewGate({ ok: true, bodies: [body(record)] }, HEAD_A),
				{ pass: true, record },
				`a resolved review with outcome ${outcome} changed the gate's verdict — §3.3's row consumes ` +
					"completeness, adjudication and the head binding, and NOT the Resolver's outcome; if that is to " +
					"change it is issue #193's amendment, and it must red this arm rather than slip through",
			);
		});
	}

	it("passes regardless of a slot's own validity flag — the panel's completeness is the review state's business", () => {
		for (const valid of [true, false]) {
			const record = adjudicatedRecord(HEAD_A, {
				slots: [{ slot: SLOT, valid, reason: valid ? undefined : "zq refused" }],
			});
			assert.equal(
				gate().mergeReviewGate({ ok: true, bodies: [body(record)] }, HEAD_A).pass,
				true,
				`a slot with valid=${valid} changed the verdict — the gate reads the resolved review STATE, which ` +
					"§1.7 makes the collapse of the panel's slots, never the individual slot flags",
			);
		}
	});
});

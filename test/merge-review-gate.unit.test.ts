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
 * dynamic imports and every arm reds on its own authored message rather
 * than a module-resolution crash.
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

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
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
		assert.deepEqual(
			verdict,
			{
				pass: false,
				reason: "no-record-at-head",
				detail: verdict.pass === false ? verdict.detail : "",
			},
			"a review of a different head satisfied the gate — §1.6 pins a review to the head it ran at, so a stale " +
				"record would let an unreviewed head ride in on its predecessor's approval",
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

	it("distinguishes position from head — each half refuses on its own, so neither can carry the other", () => {
		// Cross the two halves: right position + wrong head, and wrong
		// position + right head. If only one half were implemented, one of
		// these two would pass.
		const cases: [string, string, string][] = [
			["right position, wrong head", body(adjudicatedRecord(HEAD_B)), HEAD_A],
			["wrong position, right head", `relayed:\n${body(record)}`, HEAD_A],
		];
		for (const [shape, commentBody, head] of cases) {
			assert.equal(
				gate().mergeReviewGate({ ok: true, bodies: [commentBody] }, head).pass,
				false,
				`${shape} satisfied the gate — the canonical-position check and the head binding are independent ` +
					"requirements (§3.7(e)), and an implementation carrying only one of them passes this case",
			);
		}
	});

	it("passes a real record even when a relayed copy sits beside it — the relay neither helps nor blocks", () => {
		const real = body(record);
		const relayed = `Quoting a prior round:\n${body(adjudicatedRecord(HEAD_B))}`;
		assert.deepEqual(
			gate().mergeReviewGate({ ok: true, bodies: [relayed, real] }, HEAD_A),
			{ pass: true, record },
			"a genuine record stopped satisfying the gate because an unrelated relayed record shared the thread — " +
				"the gate must select its artifact, not scan the thread",
		);
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
			{ ok: true, bodies: [`<!-- gitjig-review-record: ${HEAD_A} -->\n\n\`\`\`json\n{ not json\n\`\`\`\n`] },
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
			assert.ok(
				verdict.pass === false && verdict.detail.length > 0,
				`${shape} refused with an empty detail — a silent refusal is the "no silent skip" defect (§3.7(b))`,
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
	it("refuses EVERY incomplete cause — the cause set is iterated, not sampled", () => {
		const causes = ["panel", "adjudication-missing", "adjudication-incomplete"] as const;
		for (const cause of causes) {
			const record = adjudicatedRecord(HEAD_A, { review: { state: "incomplete", cause } });
			const verdict = gate().mergeReviewGate({ ok: true, bodies: [body(record)] }, HEAD_A);
			assert.equal(
				verdict.pass,
				false,
				`an incomplete review (cause: ${cause}) satisfied the merge-review gate — §1.7 makes an incomplete ` +
					"review no review outcome at all, so it cannot be the complete review this row requires",
			);
			assert.equal(
				verdict.pass === false ? verdict.reason : undefined,
				"panel-incomplete",
				`the incomplete cause ${cause} refused under the wrong reason`,
			);
			assert.ok(
				verdict.pass === false && verdict.detail.includes(cause),
				`the refusal did not name the incomplete cause ${cause} — the detail must distinguish WHICH ` +
					"incompleteness, or an author cannot tell a missing slot from a missing adjudication",
			);
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

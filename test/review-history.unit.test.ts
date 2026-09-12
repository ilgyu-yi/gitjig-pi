/**
 * §1.4's cross-review-repair history instruments (issue #186,
 * Directive #183) — the repair-history record assembled from the
 * durable review records, the coarse deterministic trigger, the
 * diagnosis dispatch's admission, and the deterministic consumer.
 *
 * The instruments SLEEP per §5.3 until derived; this suite is their
 * derivation's failing-first pin. The diagnosis is never dispatched
 * live here — the admission is exercised through injected outcome
 * shapes, the same discipline the Orchestrator suite keeps.
 *
 * Subject-absence anchor: the module is pulled through a guarded
 * dynamic import and every arm reds on its own authored message.
 */
import assert from "node:assert/strict";
// For the complement arm's unnameable fixture. Round 13's EF3 removed
// this file's last source read; what replaced its justification is a tag
// no production text written before the run can contain.
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
// A TYPE-ONLY import of the upstream tag union, for the witness that
// replaced the regex over resolve.ts's union body. It is erased before
// the file runs, so it adds no runtime dependency on the module being
// present — which is also its limit: an absent or renamed resolve.ts
// reds `tsc`, never this suite (R-b/R-c, disclosed at the witness).
import type { ReviewState as UpstreamReviewState } from "../.pi/extensions/gitjig/review/resolve.ts";
import { repoRoot } from "./harness/run-pi.ts";

const REVIEW_DIR = "/.pi/extensions/gitjig/review/";

type Slot = { lens: string; surface: string };
type ReviewState =
	| { state: "incomplete"; cause: string; missing?: Slot[]; gaps?: string[] }
	| { state: "approved" }
	| { state: "resolved"; resolution: { dispositions: unknown[]; outcome: "repair" | "measure-escalate" | "clear" } };
type ReviewRecord = {
	head: string;
	slots: unknown[];
	bundle: unknown[];
	adjudication: unknown;
	review: ReviewState;
};
type DispatchOutcome =
	| { disposition: "admitted"; ok: boolean; summary: string; payload?: string; compare?: "confirmed" | "invalid" }
	| { disposition: "refused"; cause: string };

type StateRuling = { finding: string; validity: string; severity?: string; evidence: string };
type StateSummary = {
	head: string;
	outcome: "repair" | "measure-escalate" | "clear" | "approved";
	findings: string[];
	rulings: StateRuling[];
};
type DiagnosisValue = "NONE" | "STAGNATION" | "OSCILLATION" | "INDETERMINATE";
type Invalidation = "nothing" | "plan" | "authorization";
type DiagnosisInput = { value: DiagnosisValue; invalidation: Invalidation; evidence: string };
type DiagnosisAdmission =
	| { available: true; diagnosis: DiagnosisInput }
	// Narrowed to match production: `admitDiagnosis` returns "hand-off" on
	// every unavailable limb, and §1.4 homes the open limb in
	// `historyAvailability`. This mirror had already drifted from the module
	// once; nothing in this file pins it against the source at this head.
	| { available: false; disposition: "hand-off"; reason: string };
type Consequence = { proceed: boolean; park: boolean; reentry: "none" | "plan" | "authorization" };

type HistoryModule = {
	// Mirrored as MUTABLE arrays on purpose. Production declares these
	// `as const`, which is a type-level word only; the identity and
	// emptiness laws below perturb the live objects and restore them, and
	// that reachability is the production module's disclosed residual
	// (R-a), not an accident this mirror invents.
	DIAGNOSIS_VALUES: string[];
	INVALIDATIONS: string[];
	repairHistory(records: ReviewRecord[]): StateSummary[];
	triggerFires(history: StateSummary[]): boolean;
	composeDiagnosisBrief(history: StateSummary[], context: { changeDescription: string }): string;
	admitDiagnosis(outcome: DispatchOutcome): DiagnosisAdmission;
	diagnosisConsequence(value: DiagnosisValue, invalidation: Invalidation): Consequence;
	historyAvailability(
		storeInstalled: boolean,
		records: ReviewRecord[] | undefined,
	):
		| { available: true; records: ReviewRecord[] }
		| { available: false; disposition: "hand-off" | "fail-open"; reason: string };
};

let history: HistoryModule | undefined;
let loadError = "";
try {
	history = (await import(pathToFileURL(`${repoRoot()}${REVIEW_DIR}history.ts`).href)) as HistoryModule;
} catch (error) {
	loadError = error instanceof Error ? error.message : String(error);
}
function mod(): HistoryModule {
	assert.ok(history, `history.ts did not load — §1.4's instruments are absent or broken: ${loadError}`);
	return history;
}

/**
 * The durable record module, pulled through the same guarded dynamic
 * import. `StateOutcome` is DERIVED from `OUTCOMES` here, and a record
 * whose outcome is outside it does not parse at all, so this module's
 * home is part of §1.4's history domain and is measured with the same
 * three laws. `composeReviewRecord` is mirrored over `unknown` so an
 * adversarial outcome is expressible without a cast.
 */
type RecordModule = {
	OUTCOMES: string[];
	composeReviewRecord(record: unknown): string;
	parseReviewRecord(body: string): ReviewRecord | undefined;
};

let recordModule: RecordModule | undefined;
let recordLoadError = "";
try {
	recordModule = (await import(pathToFileURL(`${repoRoot()}${REVIEW_DIR}record.ts`).href)) as RecordModule;
} catch (error) {
	recordLoadError = error instanceof Error ? error.message : String(error);
}
function recordMod(): RecordModule {
	assert.ok(recordModule, `record.ts did not load — the durable record is absent or broken: ${recordLoadError}`);
	return recordModule;
}

const rec = (head: string, review: ReviewState): ReviewRecord => ({
	head,
	slots: [],
	bundle: [],
	adjudication: null,
	review,
});
const repair = (head: string): ReviewRecord =>
	rec(head, { state: "resolved", resolution: { dispositions: [], outcome: "repair" } });
const clear = (head: string): ReviewRecord =>
	rec(head, { state: "resolved", resolution: { dispositions: [], outcome: "clear" } });
const measureEscalate = (head: string): ReviewRecord =>
	rec(head, { state: "resolved", resolution: { dispositions: [], outcome: "measure-escalate" } });
const approved = (head: string): ReviewRecord => rec(head, { state: "approved" });
const incomplete = (head: string): ReviewRecord => rec(head, { state: "incomplete", cause: "panel" });

const admittedPayload = (input: DiagnosisInput): DispatchOutcome => ({
	disposition: "admitted",
	ok: true,
	summary: "RESULT",
	payload: JSON.stringify(input),
	compare: "confirmed",
});

describe("§1.4 the repair history is assembled from the durable records, not authored (issue #186)", () => {
	it("one record per head becomes one review state, in order, outcome mapped from the resolution", () => {
		const h = mod();
		const out = h.repairHistory([
			repair("a".repeat(40)),
			clear("b".repeat(40)),
			measureEscalate("d".repeat(40)),
			approved("c".repeat(40)),
		]);
		assert.deepEqual(
			out.map((s) => ({ head: s.head, outcome: s.outcome })),
			[
				{ head: "a".repeat(40), outcome: "repair" },
				{ head: "b".repeat(40), outcome: "clear" },
				{ head: "d".repeat(40), outcome: "measure-escalate" },
				{ head: "c".repeat(40), outcome: "approved" },
			],
			"the history did not map each record to a head+outcome state in order — the history is the record " +
				"sequence, read not remembered",
		);
	});

	it("each state carries the record's findings and rulings — the diagnosis reads the same findings (round 1's E1)", () => {
		const h = mod();
		const head = "a".repeat(40);
		const record: ReviewRecord = {
			head,
			slots: [],
			bundle: [{ finding: "zq the recurring finding", slot: { lens: "runtime", surface: "s" } }],
			adjudication: {
				dedupAttested: true,
				rulings: [
					{
						finding: "zq the recurring finding",
						provenance: [{ lens: "runtime", surface: "s" }],
						validity: "CONFIRMED",
						severity: "SUBSTANTIVE",
						evidence: "zq the ruling's evidence",
					},
				],
			},
			review: { state: "resolved", resolution: { dispositions: [], outcome: "repair" } },
		} as unknown as ReviewRecord;
		const [state] = h.repairHistory([record]);
		assert.deepEqual(
			state.findings,
			["zq the recurring finding"],
			"the state dropped the record's bundle findings — §1.4's diagnosis reads the same findings the Judge " +
				"already ruled, undecidable from an outcome label alone",
		);
		assert.deepEqual(
			state.rulings,
			[
				{
					finding: "zq the recurring finding",
					validity: "CONFIRMED",
					severity: "SUBSTANTIVE",
					evidence: "zq the ruling's evidence",
				},
			],
			"the state dropped the record's rulings and their evidence — STAGNATION and OSCILLATION are undecidable " +
				"without them",
		);
	});

	it("the panel's slots at one head collapse into one state — a duplicated head is one state, last record wins", () => {
		const h = mod();
		// Two records at one head (a re-dispatched slot re-posts the record):
		// §1.7 says simultaneous results at one head are one decision, not N.
		const head = "a".repeat(40);
		const out = h.repairHistory([repair(head), clear(head), clear("b".repeat(40))]);
		assert.deepEqual(
			out.map((s) => s.head),
			[head, "b".repeat(40)],
			"two records at one head produced two states — a head individuates one review state (§1.4/§1.7)",
		);
		assert.equal(
			out[0].outcome,
			"clear",
			"the collapse did not take the LAST record's outcome — a re-posted head's settled record is the last, " +
				"and position and outcome must come from the same record (round 1's E4)",
		);
	});

	it("a SAME-outcome re-post still takes the last record's findings and rulings", () => {
		// The collapse's content half was pinned only through `outcome`: a
		// weakening that wrote the state only when the outcome CHANGED kept
		// the first record's bundle and no arm saw it. The flow-reachable
		// shape is a partial first post at a head, then the complete re-post
		// at the same head with the SAME outcome and a fuller bundle — which
		// is exactly what a re-dispatched slot produces.
		const head = "f".repeat(40);
		const slot = { lens: "runtime", surface: "the shell's runtime" };
		const withBundle = (findings: string[], rulings: unknown[]): ReviewRecord => ({
			head,
			slots: [],
			bundle: findings.map((finding) => ({ finding, slot })),
			adjudication: rulings.length === 0 ? null : { dedupAttested: true, rulings },
			review: { state: "resolved", resolution: { dispositions: [], outcome: "repair" } },
		});
		const partial = withBundle(["zq one"], [{ finding: "zq one", validity: "CONFIRMED", evidence: "zq e1" }]);
		const complete = withBundle(
			["zq one", "zq two"],
			[
				{ finding: "zq one", validity: "CONFIRMED", evidence: "zq e1" },
				{ finding: "zq two", validity: "REFUTED", evidence: "zq e2" },
			],
		);
		const [state] = mod().repairHistory([partial, complete]);
		assert.deepEqual(
			{ findings: state?.findings, rulings: state?.rulings.length },
			{ findings: ["zq one", "zq two"], rulings: 2 },
			"a same-outcome re-post did not take the LAST record's content — a re-dispatched slot re-posts the " +
				"completed state, and keeping the partial one feeds the Judge a truncated bundle at exactly the head " +
				"that completed (§1.4 reads the same findings the Judge already ruled)",
		);
	});

	it("EVERY unrecognized tag is no state — the complement, not one nominated point (round 9's F-A)", () => {
		// A complement cannot be enumerated, so this arm is honest only if its
		// fixture CANNOT be satisfied by a per-point special case.
		//
		// ROUND 13's EF3 removed this arm's second limb and its source read.
		// That limb extracted the assembler's per-tag tests out of history.ts's
		// TEXT and deepEqualled them against a three-member list — a declared
		// domain established by READING SOURCE TEXT, which is exactly the scope
		// §1.8 invalidated and re-planned, left standing when the rest of the
		// method was superseded. It carried that method's defect too: measured
		// at the previous head, a behaviourally INERT COMMENT inside
		// repairHistory red this arm alone, 102/1. A comment cannot change what
		// the assembler does, so that red was false.
		//
		// What the limb claimed is not lost, and it is not re-derived here: the
		// upstream tag domain is carried by the TYPE WITNESS over
		// `ReviewState["state"]` in this file's domain describe, which `tsc`
		// welds and which reds on a tag added, removed or renamed upstream in
		// any spelling. The witness reds the TYPE CHECK and not the suite —
		// disclosed there and at the assembler's own per-tag branch (R-b).
		//
		// What remains here is the BEHAVIOURAL universal, and its fixture is
		// made unnameable rather than merely unusual: one tag carries a fresh
		// UUID, so no production special case written before this run can name
		// it. The randomness is in the FIXTURE only — the assertion is the same
		// either way, and a failure reproduces from the head under test without
		// the value, since any tag outside the recognized set must take the
		// drop. The fixed spellings ride alongside it as ordinary cases.
		const h = mod();
		const [a, c] = ["a".repeat(40), "c".repeat(40)];

		const spellings = ["withdrawn", "superseded", "abandoned", "", `zq-${randomUUID()}`];
		for (const tag of spellings) {
			const b = "b".repeat(40);
			const unknown = { head: b, slots: [], bundle: [], adjudication: null, review: { state: tag } };
			const history = h.repairHistory([repair(a), unknown as unknown as ReviewRecord, repair(c)]);
			assert.deepEqual(
				history.map((state) => state.head),
				[a, c],
				`the tag ${JSON.stringify(tag)} became a review state — §1.4 says a head drawing no resolved review ` +
					"contributes no state, and admitting it mints a RESETTING state out of a tag this module does not know",
			);
			assert.equal(
				h.triggerFires(history),
				true,
				`the tag ${JSON.stringify(tag)} interposed between two repairs silenced the trigger — the wrong-allow ` +
					"direction §1.4's opening forbids",
			);
		}
	});

	it("a re-post keeps its head's FIRST position and takes its LAST content (round 2's E1, re-authored)", () => {
		const h = mod();
		const [a, b, c] = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
		// A repaired, then C cleared, then B repaired, then A re-posted.
		// POSITION comes from A's first appearance, so the sequence is a|c|b —
		// review chronology, which is the order heads were first reviewed.
		// CONTENT comes from A's last record (§1.4's collapse: one head, one
		// state, later record wins).
		//
		// This arm previously asserted the opposite — that the re-post moves A
		// to the END, giving c|b|a. That rule silences a trigger that has
		// already fired, which is the arm below; it is rejected in the module
		// at the line that implements this one.
		const out = h.repairHistory([repair(a), clear(c), repair(b), repair(a)]);
		assert.deepEqual(
			out.map((state) => state.head),
			[a, c, b],
			"a re-posted head did not keep its FIRST position — moving it to the end asserts that a head reviewed " +
				"first was reviewed last, and heads advance as the change is repaired, so first appearance IS the " +
				"chronology §1.4's sequence is counted in",
		);
		assert.equal(
			out[0]?.outcome,
			"repair",
			"the re-posted head did not take its LAST record's outcome — §1.4's collapse makes several records at one " +
				"head one state, and the later record wins",
		);
	});

	it("a re-post of an already-resolved head does NOT silence a trigger that has fired (round 7's F-R1)", () => {
		const h = mod();
		const [a, b, c] = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
		// The measured defect: under last-occurrence positioning the re-post
		// moved A to the end and the trailing repair run collapsed from two to
		// one. §1.4's opening forbids the under-fire, so BOTH directions are
		// pinned here — the trigger fires before the re-post and still fires
		// after it, for every re-post outcome the flow can produce.
		const before = h.repairHistory([approved(a), repair(b), repair(c)]);
		assert.equal(h.triggerFires(before), true, "the trailing run of two repairs did not fire the trigger");
		for (const [shape, repost] of [
			["the same approved state re-posted", approved(a)],
			["a re-post carrying a clear", clear(a)],
			["a re-post carrying a repair", repair(a)],
		] as const) {
			const after = h.repairHistory([approved(a), repair(b), repair(c), repost]);
			assert.equal(
				h.triggerFires(after),
				true,
				`${shape} at an OLDER head silenced a trigger that had already fired — a record arriving late about a ` +
					"head already reviewed is not a new review state (§1.4's collapse), and letting it take the newest " +
					"position lets a change repair indefinitely, which §1.4's opening forbids",
			);
			assert.deepEqual(
				after.map((state) => state.head),
				[a, b, c],
				`${shape} moved its head out of first-appearance order`,
			);
		}
	});

	it("a resolved measure-escalate maps as itself, and interposed it RESETS the repair run (round 4's S1)", () => {
		const h = mod();
		const [a, b, c] = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
		const mapped = h.repairHistory([measureEscalate(a)]);
		assert.equal(
			mapped[0].outcome,
			"measure-escalate",
			"a resolved measure-escalate did not map to its own outcome — §1.4 maps a resolved review to its " +
				"resolution outcome, and measure-escalate is one",
		);
		assert.equal(
			h.triggerFires(h.repairHistory([repair(a), measureEscalate(b), repair(c)])),
			false,
			"an interposed measure-escalate did not reset the consecutive-repair run — §1.4: a review resolving to " +
				"anything else does not feed the count and, being interposed, resets it",
		);
	});

	it("a later incomplete does not erase a head's already-resolved state (round 4's S1)", () => {
		const h = mod();
		const [a, b] = ["a".repeat(40), "b".repeat(40)];
		// A resolved to repair, B repaired, then A re-posts an incomplete.
		// The incomplete must not subtract A's resolved state — the two
		// repairs stay two consecutive states and the trigger fires.
		const out = h.repairHistory([repair(a), repair(b), incomplete(a)]);
		assert.deepEqual(
			out.map((s) => s.outcome),
			["repair", "repair"],
			"a later incomplete erased a head's resolved state — an incomplete contributes no state and subtracts none",
		);
		assert.equal(h.triggerFires(out), true, "the trigger under-fired after a later incomplete — the two repairs stand");
	});

	it("an incomplete review is NOT a review state — it is dropped, never a resetting state (round 3's EF1)", () => {
		const h = mod();
		const [a, b, c] = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
		const out = h.repairHistory([incomplete(a), repair(b), clear(c)]);
		assert.deepEqual(
			out.map((s) => ({ head: s.head, outcome: s.outcome })),
			[
				{ head: b, outcome: "repair" },
				{ head: c, outcome: "clear" },
			],
			"an incomplete review contributed a state — §1.4 counts resolved reviews only, and §1.7 rules an " +
				"incomplete panel no review outcome at all; it must be dropped, not mapped to a state",
		);
		// The load-bearing consequence: an interposed incomplete must not reset
		// the consecutive-repair run, or a change repairs indefinitely (§1.4).
		assert.equal(
			h.triggerFires(h.repairHistory([repair(a), incomplete(b), repair(c)])),
			true,
			"an interposed incomplete reset the consecutive-repair run — the two resolved repairs are consecutive " +
				"states and the trigger must fire; an incomplete contributes none",
		);
	});
});

describe("§1.4 the assembler carries findings and rulings whole (issue #186)", () => {
	// The domain here is not a closed union but a CARDINALITY, and round 6
	// found every fixture standing at 0 or 1 — no record anywhere carried a
	// bundle of two, and the only two-ruling fixture bypassed the assembler
	// entirely by being handed straight to the renderer. A fixture at
	// cardinality 1 cannot falsify "carries them whole": truncation to the
	// first and preservation of all are the same observation at one entry.
	//
	// So: two findings and two rulings, needles distinct by construction,
	// asserted by deep equality in ORDER. A truncation, a reversal, or a
	// silent drop each red.
	const HEAD = "e".repeat(40);
	const FINDINGS = ["zq alpha finding", "zq beta finding"];
	const RULINGS = [
		{ finding: "zq alpha finding", validity: "CONFIRMED", severity: "SUBSTANTIVE", evidence: "zq alpha evidence" },
		{ finding: "zq beta finding", validity: "REFUTED", evidence: "zq beta evidence" },
	];
	const withBundle = (): ReviewRecord => ({
		head: HEAD,
		slots: [],
		bundle: FINDINGS.map((finding) => ({ finding, slot: { lens: "runtime", surface: "the shell's runtime" } })),
		adjudication: { dedupAttested: true, rulings: RULINGS },
		review: { state: "resolved", resolution: { dispositions: [], outcome: "repair" } },
	});

	it("preserves BOTH findings, in order — truncation and reversal each red", () => {
		const [assembled] = mod().repairHistory([withBundle()]);
		assert.deepEqual(
			assembled?.findings,
			FINDINGS,
			"the assembled state's findings are not the record's bundle, in order — §1.4's diagnosis reads the SAME " +
				"findings across states, so a silently truncated or reordered set is precisely the input the ruling " +
				"turns on (AC1)",
		);
	});

	it("preserves BOTH rulings, in order, each whole — a dropped field reds", () => {
		const [assembled] = mod().repairHistory([withBundle()]);
		assert.deepEqual(
			assembled?.rulings,
			RULINGS,
			"the assembled state's rulings are not the adjudication's, in order and whole — the second ruling carries " +
				"no severity by construction, so a shape that drops an optional field or truncates to the first reds here",
		);
	});

	it("a findings-carrying record with a NULL adjudication keeps its findings and empties its rulings", () => {
		// The shape repairHistory produces by design when a panel gathered
		// findings the Judge never ruled. Round 6 showed this shape unmeasured
		// past position one; it is measured here at the assembler.
		const [assembled] = mod().repairHistory([{ ...withBundle(), adjudication: null }]);
		assert.deepEqual(
			{ findings: assembled?.findings, rulings: assembled?.rulings },
			{ findings: FINDINGS, rulings: [] },
			"a record with findings and no adjudication did not keep its findings with empty rulings — an adjudication " +
				"the Judge has not made is not a reason to lose the findings it has not ruled on",
		);
	});
});

describe("§1.4 the coarse deterministic trigger (issue #186)", () => {
	const h = () => mod();
	const heads = (n: number) => Array.from({ length: n }, (_, i) => String(i).padStart(40, "0"));
	const sm = (head: string, outcome: StateSummary["outcome"]): StateSummary => ({
		head,
		outcome,
		findings: [],
		rulings: [],
	});

	it("fires at the SECOND consecutive repair, not the first", () => {
		const [a, b] = heads(2);
		assert.equal(h().triggerFires([sm(a, "repair")]), false, "the first repair fired the trigger");
		assert.equal(
			h().triggerFires([sm(a, "repair"), sm(b, "repair")]),
			true,
			"the second consecutive repair did not fire the trigger",
		);
	});

	it("a non-repair state interposed RESETS the count", () => {
		const [a, b, c] = heads(3);
		assert.equal(
			h().triggerFires([sm(a, "repair"), sm(b, "clear"), sm(c, "repair")]),
			false,
			"an interposed clear did not reset the consecutive-repair count — the trailing run is one repair",
		);
	});

	it("the findings-free path never fires it — approved is not a repair state", () => {
		const [a, b] = heads(2);
		assert.equal(
			h().triggerFires([sm(a, "approved"), sm(b, "approved")]),
			false,
			"a run of approved states fired the repair trigger",
		);
	});

	it("three consecutive repairs still fire — the boundary is at-least-two, not exactly-two", () => {
		const [a, b, c] = heads(3);
		assert.equal(
			h().triggerFires([sm(a, "repair"), sm(b, "repair"), sm(c, "repair")]),
			true,
			"a third consecutive repair did not fire — §1.4 fires at the second and each BEYOND it",
		);
	});

	it("the empty history does not fire", () => {
		assert.equal(h().triggerFires([]), false, "an empty history fired the trigger");
	});
});

describe("§1.4 the diagnosis brief carries the findings and asks both outputs (issue #186; round 1's E1/E3)", () => {
	const state = (over: Partial<StateSummary> = {}): StateSummary => ({
		head: "a".repeat(40),
		outcome: "repair",
		findings: ["zq the recurring finding"],
		rulings: [
			{
				finding: "zq the recurring finding",
				validity: "CONFIRMED",
				severity: "SUBSTANTIVE",
				evidence: "zq the evidence",
			},
		],
		...over,
	});

	it("embeds each state's findings and rulings verbatim, labelled unverified", () => {
		const text = mod().composeDiagnosisBrief([state()], { changeDescription: "d" });
		// Round 2's S1: pin the per-state FINDINGS line with a needle only it
		// can produce — a state carrying a finding but NO rulings, so the
		// ruling line (which also renders the finding) cannot satisfy it.
		const findingsOnly = mod().composeDiagnosisBrief([state({ findings: ["zq findings-only line"], rulings: [] })], {
			changeDescription: "d",
		});
		assert.ok(
			findingsOnly.includes("zq findings-only line"),
			"a state with findings but no rulings lost its findings from the brief — the per-state findings line is " +
				"not pinned, and a findings-but-no-rulings state (adjudication null) would drop its findings",
		);
		for (const [needle, why] of [
			["zq the recurring finding", "the state's finding text — the diagnosis reads the same findings the Judge ruled"],
			["zq the evidence", "the ruling's evidence verbatim (F15's discipline carried into the history)"],
			["CONFIRMED", "the ruling's validity"],
			["UNVERIFIED", "the §1.5 form-iii label — a provisioned tree re-verifies, never trusts"],
			["effect on", "OSCILLATION's discriminator is the artifact's effect, not the labels the reviews wore"],
		] as const) {
			assert.ok(text.includes(needle), `the diagnosis brief lost ${why} (missing: ${JSON.stringify(needle)})`);
		}
	});

	it("asks for BOTH the taxonomy value and the invalidation finding, and says absence is not NONE", () => {
		const text = mod().composeDiagnosisBrief([state()], { changeDescription: "d" });
		for (const needle of ["taxonomy VALUE", "INVALIDATION finding", "absence is not NONE"]) {
			assert.ok(text.includes(needle), `the diagnosis brief no longer states ${JSON.stringify(needle)}`);
		}
	});

	it("pins the per-state header and the change description — the head/outcome sequence IS the history (round 3's EF4)", () => {
		const text = mod().composeDiagnosisBrief([state({ head: "f".repeat(40), outcome: "repair" })], {
			changeDescription: "zq the change description",
		});
		assert.ok(
			text.includes("f".repeat(40)),
			"the brief dropped the state's HEAD — the diagnosis reads the history's heads",
		);
		assert.ok(
			/resolved repair/.test(text),
			"the brief dropped the state's OUTCOME — OSCILLATION's A→B→A reading needs the ordered outcomes",
		);
		assert.ok(
			text.includes("zq the change description"),
			"the brief dropped the change description — the Judge cannot situate the history without it",
		);
		assert.ok(
			text.includes("the labels the reviews wore are not the discriminator"),
			"the brief dropped OSCILLATION's discriminator clause — §1.4 rules on the corrections' EFFECT, not the labels",
		);
	});

	// Round 5's S1: every arm above passes a ONE-state history, so the whole
	// multi-state rendering is unmeasured — slice(-1), reverse(), a constant
	// "1." ordinal, a filter to repair, and a duplicated first state all
	// survived the suite 8-for-8. §1.4's diagnosis reads the same findings
	// ACROSS states, oldest first: a brief free to carry one state, or to
	// carry them reordered, makes STAGNATION and OSCILLATION unrulable, and
	// the Judge's likely NONE routes to a further autonomous repair on a
	// history that warranted a park — a silent wrong-allow.
	const multi = (): StateSummary[] =>
		(
			[
				["b", "repair", "oldest"],
				["c", "clear", "middle"],
				["d", "repair", "newest"],
			] as const
		).map(([fill, outcome, position]) =>
			state({
				head: fill.repeat(40),
				outcome,
				// Round 6's F3/N1: the needle must be distinct BY CONSTRUCTION
				// from anything another rendered line can produce. Previously the
				// finding text was identical to the ruling's `finding` field, and
				// the ruling line renders that field — so a renderer that dropped
				// the findings line entirely still satisfied the needle from the
				// ruling line, and every findings mutant survived. These share no
				// substring: "fq" vs "zq", and different position words.
				findings: [`fq ${position}-only-in-findings`],
				rulings: [
					{
						finding: `zq ${position} finding`,
						validity: "CONFIRMED",
						severity: "SUBSTANTIVE",
						evidence: `zq ${position} evidence`,
					},
				],
			}),
		);

	/**
	 * A history whose SECOND state carries findings and no rulings — the
	 * shape `repairHistory` produces for a panel the Judge has not ruled.
	 * Round 6 showed it pinned only at position one, so a renderer emitting
	 * findings for the first state alone survived every arm.
	 */
	const findingsOnlyAtSecond = (): StateSummary[] => {
		const history = multi();
		return history.map((entry, index) => (index === 1 ? { ...entry, rulings: [] } : entry));
	};

	const headerLines = (text: string): string[] =>
		text.split("\n").filter((line) => /^ {2}\d+\. head \S+ resolved /.test(line));

	it("renders EVERY state, not only one — each state's own finding and ruling evidence appears", () => {
		const history = multi();
		const text = mod().composeDiagnosisBrief(history, { changeDescription: "d" });
		for (const position of ["oldest", "middle", "newest"]) {
			for (const needle of [`zq ${position} finding`, `zq ${position} evidence`]) {
				assert.ok(
					text.includes(needle),
					`the brief dropped the ${position} state (missing: ${JSON.stringify(needle)}) — a renderer free to ` +
						"keep only the last state, only the first, or only the repair states hands the Judge a history " +
						"STAGNATION and OSCILLATION cannot be read from",
				);
			}
		}
	});

	it("renders EVERY entry of a state's findings AND rulings lists, in order (round 7's E1)", () => {
		// Round 7: cardinality was derived for the ASSEMBLER and carried to
		// the renderer only as a per-POSITION axis, so every brief fixture
		// still held 0 or 1 findings per state and `.slice(0,1)` / `.reverse()`
		// on the rendered lists survived. Cardinality is an axis of EVERY
		// function that consumes a list, this one included.
		//
		// Needles are distinct by construction across both axes: "fq" for
		// findings, "zq" for ruling evidence, and an index per entry, so no
		// entry's needle can be satisfied by another entry or another line.
		const head = "e".repeat(40);
		const findings = ["fq finding-one", "fq finding-two", "fq finding-three"];
		const rulings = [
			{ finding: "fq finding-one", validity: "CONFIRMED", severity: "SUBSTANTIVE", evidence: "zq evidence-one" },
			{ finding: "fq finding-two", validity: "REFUTED", evidence: "zq evidence-two" },
		];
		const text = mod().composeDiagnosisBrief([{ head, outcome: "repair", findings, rulings }], {
			changeDescription: "d",
		});

		for (const finding of findings) {
			assert.ok(
				text.includes(finding),
				`the brief dropped ${JSON.stringify(finding)} — a renderer free to emit a state's FIRST finding and ` +
					"stop hands the Judge a history in which a recurrence across states is invisible, which is the " +
					"wrong-allow the assembler's own cardinality repair closed one level upstream",
			);
		}
		assert.ok(
			findings.every(
				(finding, index) => index === 0 || text.indexOf(finding) > text.indexOf(findings[index - 1] as string),
			),
			"the brief rendered a state's findings out of order — a reversed list is a different history",
		);
		for (const ruling of rulings) {
			assert.ok(
				text.includes(ruling.evidence),
				`the brief dropped the ruling evidence ${JSON.stringify(ruling.evidence)} — F15's discipline is that a ` +
					"ruling travels with the evidence it rests on",
			);
		}
		assert.ok(
			text.indexOf(rulings[1]?.evidence as string) > text.indexOf(rulings[0]?.evidence as string),
			"the brief rendered a state's rulings out of order — §1.4 reads the rulings the Judge already made, and " +
				"their order is part of what it reads",
		);
	});

	it("renders EVERY state's own findings line, at every position — needles distinct by construction", () => {
		// The falsifier for the findings line specifically: each state's
		// findings needle appears nowhere else in the render, so a renderer
		// that emits one state's findings for all, or only the first
		// state's, or only the last's, cannot satisfy this from a
		// neighbouring line.
		const history = multi();
		const text = mod().composeDiagnosisBrief(history, { changeDescription: "d" });
		for (const entry of history) {
			for (const needle of entry.findings) {
				assert.ok(
					text.includes(needle),
					`the brief lost the findings line for ${entry.head.slice(0, 1)} (missing: ${JSON.stringify(needle)}) — ` +
						"§1.4's diagnosis reads the same findings ACROSS states, so a brief carrying one state's " +
						"findings makes STAGNATION's recurrence unreadable",
				);
			}
		}
	});

	it("renders a findings-only state's findings at position TWO — the null-adjudication shape past the first", () => {
		const history = findingsOnlyAtSecond();
		const text = mod().composeDiagnosisBrief(history, { changeDescription: "d" });
		const second = history[1] as StateSummary;
		assert.ok(
			text.includes(second.findings[0] as string),
			"a state carrying findings with NO rulings lost its findings when it sat at position two — this is the " +
				"shape repairHistory produces for a panel the Judge has not ruled, and the ruling line cannot " +
				"stand in for the findings line when there are no rulings",
		);
		assert.ok(
			!text.includes(`zq ${"middle"} evidence`),
			"the fixture's second state still renders a ruling — it is supposed to carry none, so this arm would " +
				"be measuring the wrong thing",
		);
	});

	it("renders the states OLDEST FIRST — rendered position increases in history order", () => {
		const text = mod().composeDiagnosisBrief(multi(), { changeDescription: "d" });
		const at = (position: string) => text.indexOf(`zq ${position} finding`);
		assert.ok(
			at("oldest") < at("middle") && at("middle") < at("newest"),
			"the brief did not render the states oldest first — OSCILLATION is the A→B→A reading of the ORDERED " +
				"states, so a reversed or shuffled brief inverts the very sequence being ruled on",
		);
	});

	it("numbers each state with ITS OWN ordinal, paired with ITS OWN head and outcome", () => {
		const history = multi();
		const text = mod().composeDiagnosisBrief(history, { changeDescription: "d" });
		history.forEach((expected, index) => {
			assert.ok(
				text.includes(`${index + 1}. head ${expected.head} resolved ${expected.outcome}`),
				`state ${index + 1} lost its own header — ordinal, head, and outcome must ride ONE line together, or a ` +
					"constant ordinal (every state \"1.\") or a cross-paired header (one state's head, another's outcome) " +
					"renders a history the Judge cannot index",
			);
		});
	});

	it("renders exactly one header line per state — no drop, no duplication", () => {
		const history = multi();
		assert.equal(
			headerLines(mod().composeDiagnosisBrief(history, { changeDescription: "d" })).length,
			history.length,
			"the rendered header-line count is not the history length — a dropped state shortens the history the " +
				"diagnosis rules on, and a duplicated one manufactures a recurrence that never happened",
		);
	});

	it("a findings-free state renders ITS OWN (none) line rather than nothing", () => {
		const history = [state({ head: "b".repeat(40), findings: [], rulings: [] }), ...multi().slice(1)];
		const text = mod().composeDiagnosisBrief(history, { changeDescription: "d" });
		assert.ok(
			// Bound to its OWN state's header: whole-text membership let the
			// literal be misattributed to a state that DOES carry findings while
			// the findings-free state rendered nothing — which is what this arm's
			// own message forbids (round 9's F-D).
			/ {2}1\. head b{40} resolved repair\n {7}findings: \(none\)\n/.test(text),
			"a state with no findings rendered nothing at all — an absent line reads as an absent STATE, and §1.4 " +
				"counts a findings-free review as a state that resets, not as a gap in the history",
		);
	});

	it("a ruling's severity rides its line; a ruling carrying none renders without the suffix", () => {
		const text = mod().composeDiagnosisBrief(
			[
				state({
					rulings: [
						{ finding: "zq graded", validity: "CONFIRMED", severity: "SUBSTANTIVE", evidence: "zq graded evidence" },
						{ finding: "zq ungraded", validity: "REFUTED", evidence: "zq ungraded evidence" },
					],
				}),
			],
			{ changeDescription: "d" },
		);
		assert.ok(
			text.includes("CONFIRMED/SUBSTANTIVE"),
			"the ruling line dropped the SEVERITY — §1.4 weighs a recurrence by what it was graded, so a validity " +
				"token alone cannot carry the ruling",
		);
		assert.ok(
			/REFUTED on zq ungraded/.test(text),
			"a ruling carrying no severity did not render bare — the suffix is conditional, not a constant",
		);
	});
});

describe("§1.4 the diagnosis admission is fail-closed — absence is not NONE (issue #186)", () => {
	it("a valid confirmed diagnosis is available with its two outputs and evidence", () => {
		const h = mod();
		// Round 3's EF2: use a NON-identity invalidation ("plan", not the
		// default "nothing"), so a constant-"nothing" mutant that discards the
		// payload's invalidation cannot pass this deepEqual.
		const input = { value: "STAGNATION" as const, invalidation: "plan" as const, evidence: "the method repeated" };
		const admission = h.admitDiagnosis(admittedPayload(input));
		assert.ok(admission.available, "a valid diagnosis was not admitted");
		assert.deepEqual(
			admission.available ? admission.diagnosis : undefined,
			input,
			"the admitted diagnosis is not the payload's two outputs and evidence — a forged invalidation or evidence " +
				"would pass, dropping a re-entry route or fabricating the evidence",
		);
	});

	it("a refused dispatch hands off — never read as NONE", () => {
		const h = mod();
		const admission = h.admitDiagnosis({ disposition: "refused", cause: "any" });
		assert.ok(
			!admission.available && admission.disposition === "hand-off" && /blind compare/.test(admission.reason),
			"a refused diagnosis dispatch was not a hand-off with a non-empty reason — an unavailable Judge is not " +
				"NONE, and §1.4's 'neither limb is silent' reaches this closed limb too",
		);
	});

	it("an ok:false admitted return hands off — a delegate-disowned diagnosis is not a value (round 1's E3)", () => {
		const h = mod();
		const admission = h.admitDiagnosis({
			disposition: "admitted",
			ok: false,
			summary: "x",
			payload: JSON.stringify({ value: "NONE", invalidation: "nothing", evidence: "e" }),
			compare: "confirmed",
		});
		assert.ok(
			!admission.available && admission.disposition === "hand-off" && /blind compare/.test(admission.reason),
			"an ok:false diagnosis with a well-formed payload was read as a value — §1.4's present-but-cannot-measure " +
				"limb takes the delegate-disowned shape too, and it must hand off with a reason",
		);
	});

	it("an unconfirmed compare hands off", () => {
		const h = mod();
		const admission = h.admitDiagnosis({
			disposition: "admitted",
			ok: true,
			summary: "x",
			payload: JSON.stringify({ value: "NONE", invalidation: "nothing", evidence: "e" }),
			compare: "invalid",
		});
		assert.ok(
			!admission.available && admission.disposition === "hand-off" && /blind compare/.test(admission.reason),
			"a diagnosis that failed the blind compare was read anyway, or handed off silently — §1.6's compare gates " +
				"it and §1.4's hand-off is never silent",
		);
	});

	it("a malformed or out-of-set payload hands off, never defaults to a value", () => {
		const h = mod();
		for (const payload of [
			'{"value":"MAYBE","invalidation":"nothing","evidence":"e"}',
			// Round 3's EF2: an out-of-set INVALIDATION, not just an out-of-set
			// value — the invalidation set is closed too.
			'{"value":"NONE","invalidation":"maybe","evidence":"e"}',
			"not json",
			"{}",
		]) {
			const admission = h.admitDiagnosis({
				disposition: "admitted",
				ok: true,
				summary: "x",
				payload,
				compare: "confirmed",
			});
			assert.ok(
				!admission.available && admission.disposition === "hand-off",
				`a malformed diagnosis payload (${payload.slice(0, 12)}…) was admitted — the four values are closed`,
			);
		}
	});

	it("an empty evidence string is not admissible — every ruling carries its evidence (F15's discipline)", () => {
		const h = mod();
		const admission = h.admitDiagnosis(admittedPayload({ value: "OSCILLATION", invalidation: "plan", evidence: "" }));
		assert.ok(!admission.available, "a diagnosis with empty evidence was admitted");
	});

	it("an extra key in the payload hands off — the shape is closed (round 1's E4)", () => {
		const h = mod();
		const admission = h.admitDiagnosis({
			disposition: "admitted",
			ok: true,
			summary: "x",
			payload: JSON.stringify({ value: "NONE", invalidation: "nothing", evidence: "e", extra: true }),
			compare: "confirmed",
		});
		assert.ok(
			!admission.available && admission.disposition === "hand-off",
			"an extra-keyed payload was admitted — the diagnosis shape is closed, and an unknown key is a surface no " +
				"contract bounds",
		);
	});

	it("NEITHER fail limb is silent, and each names its own — both limbs, not one (round 10's audit)", () => {
		// The title quantifies over BOTH of `admitDiagnosis`'s hand-off limbs
		// and the fixture exercised one, with `reason.length > 0` standing in
		// for a structured value — the same two defects round 9's F-C found at
		// the availability limbs. Found here by auditing the corpus rather
		// than by a panel. Both limbs are iterated, and each is pinned on a
		// phrase only its own reason carries, so a swap cannot pass.
		const h = mod();
		const limbs: [string, DispatchOutcome, RegExp][] = [
			[
				"the dispatch-unavailable limb",
				{ disposition: "refused", cause: "the delegated run reported failure" },
				/blind compare/,
			],
			[
				"the malformed-payload limb",
				{ disposition: "admitted", ok: true, summary: "x", payload: "{}", compare: "confirmed" },
				/malformed/,
			],
		];
		for (const [shape, outcome, needle] of limbs) {
			const admission = h.admitDiagnosis(outcome);
			assert.ok(!admission.available && admission.disposition === "hand-off", `${shape} did not hand off`);
			assert.ok(
				!admission.available && admission.reason.length > 0,
				`${shape} carried an EMPTY reason — §1.4's "neither limb is silent" reaches the closed limb too; the ` +
					"handoff's recipient must know why it received the change",
			);
			assert.match(
				admission.available ? "" : admission.reason,
				needle,
				`${shape} carried the OTHER limb's reason — §3.11 requires two failure shapes to carry two distinct ` +
					"messages, and an interchangeable reason names a recovery that is dead at the limb that printed it",
			);
		}
	});
});

describe("§1.4 the admission's input domain, derived from DispatchOutcome (issue #186)", () => {
	// The domain is read off the dispatcher's own return type, not off a
	// finding. `disposition` is admitted|refused (2); on the admitted arm
	// `ok` is boolean (2) and `compare` is "confirmed"|"invalid"|ABSENT
	// (3 — the third is the optional's own inhabitant, and the dispatcher
	// sets compare only when an expected ref was supplied, so it is a real
	// shape and not a hypothetical). The guard admits exactly one of these
	// combinations; every other one must hand off.
	const input: DiagnosisInput = { value: "STAGNATION", invalidation: "plan", evidence: "the method repeated" };
	const COMPARES = ["confirmed", "invalid", undefined] as const;

	for (const compare of COMPARES) {
		for (const ok of [true, false]) {
			const admissible = compare === "confirmed" && ok;
			it(`admitted/ok=${ok}/compare=${String(compare)} is ${admissible ? "available" : "a hand-off"}`, () => {
				const outcome = { disposition: "admitted", ok, summary: "RESULT", payload: JSON.stringify(input), compare };
				const admission = mod().admitDiagnosis(outcome as DispatchOutcome);
				if (admissible) {
					assert.deepEqual(
						admission,
						{ available: true, diagnosis: input },
						"the one admissible combination did not yield the payload's own two outputs and evidence",
					);
					return;
				}
				assert.ok(
					!admission.available && admission.disposition === "hand-off" && /blind compare/.test(admission.reason),
					`compare=${String(compare)} with ok=${ok} was not handed off — §1.6's blind compare gates this return, ` +
						"and an UNSET compare is the shape the dispatcher produces when no expected ref was supplied, so " +
						"reading it as a value admits an unverified diagnosis; absence is never NONE (§1.4)",
				);
			});
		}
	}

	it("a refused dispatch hands off, whatever else it carries", () => {
		const admission = mod().admitDiagnosis({ disposition: "refused", cause: "the delegated run reported failure" });
		assert.ok(
			!admission.available && admission.disposition === "hand-off" && /blind compare/.test(admission.reason),
			"a refused dispatch was not handed off",
		);
	});

	// The payload's own inhabited shapes, enumerated rather than sampled.
	// A JSON `null` is the shape that matters most: the parser's key
	// extraction raises on it, and an uncaught raise on the admission path
	// is not §1.4's hand-off at all.
	const PAYLOADS: [string, string | undefined][] = [
		["absent", undefined],
		["empty", ""],
		["JSON null", "null"],
		["a JSON array", "[]"],
		["a JSON scalar", "42"],
		["a JSON string", '"NONE"'],
		["unparseable", "{ not json"],
		["an object missing a key", '{"value":"NONE"}'],
		["an object with an extra key", '{"value":"NONE","invalidation":"nothing","evidence":"e","extra":1}'],
		["an out-of-set value", '{"value":"PROGRESS","invalidation":"nothing","evidence":"e"}'],
		["an out-of-set invalidation", '{"value":"NONE","invalidation":"everything","evidence":"e"}'],
		["empty evidence", '{"value":"NONE","invalidation":"nothing","evidence":""}'],
	];

	for (const [shape, payload] of PAYLOADS) {
		it(`a payload that is ${shape} hands off rather than raising or yielding a value`, () => {
			const outcome = { disposition: "admitted", ok: true, summary: "RESULT", payload, compare: "confirmed" };
			let admission: DiagnosisAdmission;
			try {
				admission = mod().admitDiagnosis(outcome as DispatchOutcome);
			} catch (error) {
				assert.fail(
					`a payload that is ${shape} made the admission RAISE (${error instanceof Error ? error.message : String(error)}) ` +
						"— an uncaught raise on the admission path is not §1.4's hand-off, and the caller that consumes " +
						"this deterministically gets an exception where it expected a closed result",
				);
			}
			assert.ok(
				// The PAYLOAD limb's own reason, not the dispatch limb's. The
				// two were interchangeable under a bare `reason.length > 0`
				// probe, so a swapped message named a recovery that is dead at
				// the limb that printed it (§3.11: two failure shapes, two
				// distinct messages).
				!admission.available && admission.disposition === "hand-off" && /malformed/.test(admission.reason),
				`a payload that is ${shape} was admitted as a value, or handed off under the DISPATCH limb's reason ` +
					"instead of its own — absence is not NONE (§1.4), and a malformed return against the closed " +
					"shape is absence, which is a different failure shape from an unavailable dispatch",
			);
		});
	}
});

describe("§1.4 the deterministic consumer (issue #186)", () => {
	// The coverage set here is the CROSS-PRODUCT of two closed unions read
	// off history.ts's own source — DiagnosisValue x Invalidation, 4 x 3 —
	// not the pairs a reviewer happened to name. Round 6 measured 6 of the
	// 12 exercised and named 5 survivors; deriving the domain instead found
	// 6 genuine survivors plus one equivalent mutant, which is the whole
	// reason the domain is derived rather than sampled.
	//
	// The falsifier: a mutant that changes the returned Consequence at
	// exactly one cell must red. Every cell below is asserted WHOLE, so a
	// cell-local mutant cannot hide in an unasserted field.
	const VALUES = ["NONE", "STAGNATION", "OSCILLATION", "INDETERMINATE"] as const;
	const INVALIDATIONS = ["nothing", "plan", "authorization"] as const;

	/** The contract, restated independently of the implementation (§1.4). */
	const expected = (value: (typeof VALUES)[number], invalidation: (typeof INVALIDATIONS)[number]) => ({
		proceed: value === "NONE",
		park: value !== "NONE",
		reentry: invalidation === "nothing" ? "none" : invalidation,
	});

	for (const value of VALUES) {
		for (const invalidation of INVALIDATIONS) {
			it(`is total at ${value} x ${invalidation} — the cell asserted whole`, () => {
				assert.deepEqual(
					mod().diagnosisConsequence(value, invalidation),
					expected(value, invalidation),
					`the consumer's cell ${value} x ${invalidation} does not match §1.4's mapping — NONE alone admits a ` +
						"further autonomous repair, the other three hand off to §5.7's park, and the invalidation routes " +
						"the re-entry gate INDEPENDENTLY of the value (AC4: arms pin the total mapping)",
				);
			});
		}
	}

	it("this suite's own iteration domain for the consumer is exactly four values x three invalidations", () => {
		// AC4's last clause is pinned by the CONTENTS / IDENTITY / EMPTINESS arms over
		// the live homes, which red on a production widening; this arm reads no
		// production source and cannot red on one — it pins only the file-local
		// literals this describe iterates, so a silently shrunken cross-product reds.
		assert.equal(VALUES.length, 4, "the value domain this suite iterates is no longer four members");
		assert.equal(INVALIDATIONS.length, 3, "the invalidation domain this suite iterates is no longer three members");
	});
});

describe("§1.4 the two fail limbs — the 2 x 3 cell set of historyAvailability (issue #186)", () => {
	// The domain is derived from the SIGNATURE: storeInstalled is boolean
	// (2) and records is `ReviewRecord[] | undefined`, whose inhabited
	// shapes are undefined / empty / non-empty (3). Six cells. Round 6
	// named two of them (the available limb's payload, and the
	// empty-but-readable false-block); the signature names all six.
	const HEAD_A = "a".repeat(40);
	const HEAD_B = "b".repeat(40);
	const CELLS = [
		["absent store, unreadable records", false, undefined],
		["absent store, empty records", false, []],
		["absent store, readable records", false, "records"],
		["installed store, unreadable records", true, undefined],
		["installed store, empty records", true, []],
		["installed store, readable records", true, "records"],
	] as const;

	it("an empty record list is an empty history — no state is fabricated for it", () => {
		assert.deepEqual(
			mod().repairHistory([]),
			[],
			"repairHistory fabricated a state for an empty record list — a head that drew no review contributes no " +
				"state (§1.4), and an invented state feeds the trigger a history nobody reviewed",
		);
	});

	for (const [shape, storeInstalled, kind] of CELLS) {
		it(`${shape} — the cell's whole result, not just its flag`, () => {
			const h = mod();
			// Cardinality >= 2 with distinct heads by construction: a
			// pass-through that silently empties or truncates the set cannot
			// satisfy a deep equality against both records.
			const records = kind === "records" ? [repair(HEAD_A), repair(HEAD_B)] : (kind as ReviewRecord[] | undefined);
			const availability = h.historyAvailability(storeInstalled, records);

			if (!storeInstalled) {
				// §1.4's absent-substrate limb: the enforcement was never
				// installed, so it fails OPEN with a warning — and it does so
				// whatever the records argument is, since the store's absence
				// decides before the records are read.
				assert.ok(
					!availability.available &&
						availability.disposition === "fail-open" &&
						/not installed/.test(availability.reason),
					`${shape} did not fail OPEN with a reason — the acting party neither caused an uninstalled substrate ` +
						"nor can repair it from inside a block (§1.4, §5.2)",
				);
				return;
			}
			if (records === undefined) {
				// Present-but-cannot-measure: fail CLOSED, hand off.
				assert.ok(
					!availability.available &&
						availability.disposition === "hand-off" &&
						/could not be read/.test(availability.reason),
					`${shape} did not hand off — present-but-cannot-measure fails closed (§1.4)`,
				);
				return;
			}
			// Readable, empty or not: AVAILABLE, and the records come through
			// unchanged. An empty history is measurable, not unmeasurable —
			// treating it as a hand-off parks the FIRST review of every change,
			// which is the wrong-block direction §3.12 forbids as squarely as
			// the wrong-allow one.
			// Round 7's N2: the expected value must NOT be the array that was
			// passed in, or an in-place `records.reverse()` mutates the
			// expectation too and survives. Built independently here.
			assert.deepEqual(
				availability,
				{ available: true, records: kind === "records" ? [repair(HEAD_A), repair(HEAD_B)] : [] },
				`${shape} did not return the records it was handed, in order — a pass-through that silently empties the ` +
					"set yields an empty history, so the trigger never fires and a change repairs indefinitely, which is " +
					"what §1.4's opening forbids",
			);
		});
	}
});

describe("§1.7 no drop, no duplication — every list pinned by COUNT (round 8's S-F1)", () => {
	// Truncation and reversal were killed at all six list-consuming sites,
	// but only ONE list (the per-state header line) was pinned by COUNT.
	// The other direction of the same axis — a silent dedup, or a line
	// emitted twice — passed every arm. §1.7 makes the bundle transport
	// with no semantic deduplication, and §1.4 rules off the same findings
	// read across states: a dedup understates what a panel found and biases
	// the Judge toward NONE; a duplication manufactures a recurrence that
	// never happened.
	//
	// Fixtures carry a DELIBERATE duplicate, so membership cannot stand in
	// for count.
	const HEAD = "d".repeat(40);
	const SLOT = { lens: "runtime", surface: "the shell's runtime" };
	const DUP = "zq repeated finding";
	const FINDINGS = [DUP, "zq other finding", DUP];
	const RULINGS = [
		{ finding: DUP, validity: "CONFIRMED", severity: "SUBSTANTIVE", evidence: "zq confirmed evidence" },
		{ finding: DUP, validity: "REFUTED", evidence: "zq refuted evidence" },
	];
	const record = (): ReviewRecord => ({
		head: HEAD,
		slots: [],
		bundle: FINDINGS.map((finding) => ({ finding, slot: SLOT })),
		adjudication: { dedupAttested: true, rulings: RULINGS },
		review: { state: "resolved", resolution: { dispositions: [], outcome: "repair" } },
	});

	it("the ASSEMBLER keeps a repeated finding — transport, not deduplication", () => {
		const [state] = mod().repairHistory([record()]);
		assert.deepEqual(
			state?.findings,
			FINDINGS,
			"the assembler changed a bundle's entry COUNT — §1.7 makes the bundle transport with no semantic " +
				"deduplication, and a bundle that dropped a finding is a defective bundle, not a strict one",
		);
	});

	it("the ASSEMBLER keeps two rulings that share a finding text", () => {
		const [state] = mod().repairHistory([record()]);
		assert.equal(
			state?.rulings.length,
			RULINGS.length,
			"the assembler dropped a ruling sharing another's finding text — a REFUTED ruling standing beside a " +
				"CONFIRMED one on the same finding is exactly the pair the diagnosis must see",
		);
		assert.deepEqual(
			state?.rulings.map((ruling) => ruling.validity),
			["CONFIRMED", "REFUTED"],
			"the two rulings' validities did not survive in order",
		);
	});

	it("the RENDERER emits each findings line and each ruling line exactly once per entry", () => {
		const [state] = mod().repairHistory([record()]);
		const text = mod().composeDiagnosisBrief([state as StateSummary], { changeDescription: "d" });
		const lines = text.split("\n");
		const count = (predicate: (line: string) => boolean) => lines.filter(predicate).length;
		assert.equal(
			count((line) => line.includes("finding: ") && line.includes(DUP)),
			2,
			"the repeated finding was not rendered once per entry — a renderer that dedups understates what the " +
				"panel found, and one that emits each line twice manufactures a recurrence; membership cannot see " +
				"either, which is why this is a COUNT",
		);
		assert.equal(
			count((line) => line.includes("finding: ")),
			FINDINGS.length,
			"the rendered findings-line count is not the state's findings length",
		);
		assert.equal(
			count((line) => line.includes("ruling: ")),
			RULINGS.length,
			"the rendered ruling-line count is not the state's rulings length — a doubled or deduped ruling list " +
				"changes what §1.4's diagnosis reads",
		);
	});

	it("the AVAILABILITY pass-through keeps a repeated record — count, not membership", () => {
		const records = [repair(HEAD), repair(HEAD)];
		const availability = mod().historyAvailability(true, records);
		assert.equal(
			availability.available ? availability.records.length : -1,
			2,
			"the availability pass-through changed the record COUNT — it is a pass-through, and collapsing duplicates " +
				"is the assembler's job under §1.4's own rule, not this limb's",
		);
	});
});

describe("§1.4 the admission carries EVERY enforced member through the parser (round 7's F-R2)", () => {
	// TRIPWIRE (g): the coverage set is derived from the expression that
	// ENFORCES the domain, named here, not from the type declaration beside
	// it. `admitDiagnosis` enforces over two runtime `as const` arrays —
	//   export const DIAGNOSIS_VALUES = [...] as const;
	//   export const INVALIDATIONS    = [...] as const;
	// read by `isMember(DIAGNOSIS_VALUES, value)` and `isMember(INVALIDATIONS, invalidation)`.
	// Round 7 derived from `export type DiagnosisValue = ...` instead, which
	// is a DIFFERENT home for the same property (§3.11), so deleting a member
	// from either Set left 75 arms and tsc green — including deleting "NONE",
	// which refuses every advancing history's ruling and parks every change
	// forever.
	//
	// The falsifier: deleting ANY single member from either array must red.
	// That requires a POSITIVE admission per member, not merely a refusal.
	const VALUES = ["NONE", "STAGNATION", "OSCILLATION", "INDETERMINATE"] as const;
	const INVALIDATIONS = ["nothing", "plan", "authorization"] as const;

	for (const value of VALUES) {
		for (const invalidation of INVALIDATIONS) {
			it(`admits ${value} × ${invalidation} through the parser, whole`, () => {
				const input: DiagnosisInput = { value, invalidation, evidence: `zq evidence for ${value}` };
				assert.deepEqual(
					mod().admitDiagnosis(admittedPayload(input)),
					{ available: true, diagnosis: input },
					`a well-formed ruling of ${value} × ${invalidation} was not admitted with its own two outputs and ` +
						"evidence — the member is absent from the Set the parser enforces over, so a valid ruling is being " +
						"refused as malformed; for NONE that parks every change forever, inverting the one relief §1.4 grants",
				);
			});
		}
	}
});

describe("§1.4 the domains are pinned on the LIVE enforcing homes, never on their spelling (§1.8 re-plan, issue #186)", () => {
	// WHY THIS SHAPE, and what it replaces. Everything here supersedes the
	// former "drift snapshot" describe, which established each declared
	// domain by READING SOURCE TEXT — `readFileSync` over history.ts,
	// resolve.ts and record.ts, a comment strip, and two extractors. The
	// §1.4 diagnosis ruled that plan invalidated and §1.8's contest settled
	// this one in its place. The ground, in one sentence: the thing a source
	// regex reads (a `Set` literal, a union body) is not the thing that
	// enforces (a runtime object, mutable after its literal and reachable
	// through a cast), so every defect that class produced — a false red on
	// an inert comment, a false green over a member hidden behind one, a
	// decoy `Set` literal inside a string — was a defect of reading text at
	// all, not of reading it badly.
	//
	// The replacement reads no source text anywhere. Production now declares
	// ONE home per domain and DERIVES its type from it, so the three
	// properties that matter are established directly:
	//   contents      — the live home's members are the committed list;
	//   identity      — the object an arm reads IS the object the parser
	//                   consults, proven by perturbing it, for members
	//                   nobody named;
	//   emptiness     — that home is the SOLE accept site, proven by
	//                   emptying it and watching every committed member be
	//                   refused.
	// A decoy in a string literal can reach none of them, and a runtime
	// widening no probe list names is caught by identity rather than by
	// enumeration.
	//
	// RESIDUAL DISCLOSURE (R-e), stated once for the whole describe: the
	// perturbation and emptiness arms are the only state-mutating arms in
	// this file. Each restores in a `finally`, each POST-ASSERTS its restore
	// rather than trusting it, and `node --test` runs the arms of one file
	// serially with no subtest concurrency here — a parallel runner would
	// make these arms unsound, and that is a property of the runner, stated
	// so a later change to it is not silent.
	const VALUES = ["NONE", "STAGNATION", "OSCILLATION", "INDETERMINATE"] as const;
	const INVALIDATION_MEMBERS = ["nothing", "plan", "authorization"] as const;
	const OUTCOME_MEMBERS = ["repair", "measure-escalate", "clear"] as const;
	const PAYLOAD_KEYS = ["value", "invalidation", "evidence"] as const;
	/** A well-formed admitted return over ARBITRARY strings — no cast, so a non-member is expressible. */
	const ruling = (value: string, invalidation: string, evidence: string): DispatchOutcome => ({
		disposition: "admitted",
		ok: true,
		summary: "RESULT",
		payload: JSON.stringify({ value, invalidation, evidence }),
		compare: "confirmed",
	});
	const resolvedBody = (outcome: string): string =>
		recordMod().composeReviewRecord({
			head: "a".repeat(40),
			slots: [],
			bundle: [],
			adjudication: null,
			review: { state: "resolved", resolution: { dispositions: [], outcome } },
		});

	it("CONTENTS — each exported home carries exactly the committed member list", () => {
		const h = mod();
		assert.deepEqual(
			[...h.DIAGNOSIS_VALUES],
			[...VALUES],
			"history.ts's DIAGNOSIS_VALUES — the home the parser narrows over AND the home DiagnosisValue is derived " +
				"from — no longer carries §1.4's four taxonomy values. A member dropped here refuses a valid ruling " +
				"(for NONE, that parks every change forever); a member added here admits a value §1.4 does not define",
		);
		assert.deepEqual(
			[...h.INVALIDATIONS],
			[...INVALIDATION_MEMBERS],
			"history.ts's INVALIDATIONS no longer carries §1.4's three invalidation findings — the second output the " +
				"diagnosis returns, which routes the change's re-entry gate",
		);
		assert.deepEqual(
			[...recordMod().OUTCOMES],
			[...OUTCOME_MEMBERS],
			"record.ts's OUTCOMES — the home that decides whether a resolved record PARSES at all, and the home " +
				"StateOutcome is derived from — no longer carries the three resolution outcomes. A member dropped here " +
				"silently stops a legitimate record from parsing, and the history it belongs to loses a state",
		);
	});

	it("IDENTITY — a value pushed onto the LIVE DIAGNOSIS_VALUES starts being admitted, and the refusal returns on restore", () => {
		const h = mod();
		// The probe is a member of no committed list and appears in no
		// production file. Nothing can special-case it.
		const probe = "ZQ-NOT-A-TAXONOMY-VALUE";
		const outcome = ruling(probe, "nothing", "zq evidence");
		assert.equal(
			h.admitDiagnosis(outcome).available,
			false,
			"a non-member was admitted before any perturbation — the domain is not closed, and this arm's premise is gone",
		);
		try {
			h.DIAGNOSIS_VALUES.push(probe);
			assert.deepEqual(
				h.admitDiagnosis(outcome),
				{ available: true, diagnosis: { value: probe, invalidation: "nothing", evidence: "zq evidence" } },
				"pushing a member onto the exported DIAGNOSIS_VALUES did not change what admitDiagnosis admits, so the " +
					"array this arm reads is NOT the object the parser consults — a second, unreachable copy. Every " +
					"contents assertion above then certifies a home nothing enforces, which is the exact defect the " +
					"source-reading plan died of",
			);
		} finally {
			const at = h.DIAGNOSIS_VALUES.indexOf(probe);
			if (at !== -1) {
				h.DIAGNOSIS_VALUES.splice(at, 1);
			}
		}
		assert.deepEqual(
			[...h.DIAGNOSIS_VALUES],
			[...VALUES],
			"the perturbation was not restored — later arms are now unsound",
		);
		assert.equal(
			h.admitDiagnosis(outcome).available,
			false,
			"the refusal did not return after the restore — the parser is reading something the restore did not reach",
		);
	});

	it("IDENTITY — the same law for INVALIDATIONS, the second output's home", () => {
		const h = mod();
		const probe = "ZQ-NOT-AN-INVALIDATION";
		const outcome = ruling("NONE", probe, "zq evidence");
		assert.equal(
			h.admitDiagnosis(outcome).available,
			false,
			"a non-member invalidation was admitted before any perturbation",
		);
		try {
			h.INVALIDATIONS.push(probe);
			assert.deepEqual(
				h.admitDiagnosis(outcome),
				{ available: true, diagnosis: { value: "NONE", invalidation: probe, evidence: "zq evidence" } },
				"pushing onto the exported INVALIDATIONS did not change what the parser admits — the exported array is " +
					"not the enforcing object",
			);
		} finally {
			const at = h.INVALIDATIONS.indexOf(probe);
			if (at !== -1) {
				h.INVALIDATIONS.splice(at, 1);
			}
		}
		assert.deepEqual([...h.INVALIDATIONS], [...INVALIDATION_MEMBERS], "the perturbation was not restored");
		assert.equal(h.admitDiagnosis(outcome).available, false, "the refusal did not return after the restore");
	});

	it("EMPTINESS — with DIAGNOSIS_VALUES emptied, EVERY committed value is refused, so no second accept site exists", () => {
		const h = mod();
		const saved = [...h.DIAGNOSIS_VALUES];
		try {
			h.DIAGNOSIS_VALUES.length = 0;
			for (const value of VALUES) {
				assert.equal(
					h.admitDiagnosis(ruling(value, "nothing", "zq evidence")).available,
					false,
					`with the home emptied, ${value} was still admitted — some OTHER site accepts it, so the home is not ` +
						"the sole accept site and dropping a member there would not be caught by any contents assertion. " +
						"This is the mutant a probe list cannot name: a second accept site for a member the home already " +
						"carries is invisible to every positive-admission arm",
				);
			}
		} finally {
			h.DIAGNOSIS_VALUES.length = 0;
			h.DIAGNOSIS_VALUES.push(...saved);
		}
		assert.deepEqual(
			[...h.DIAGNOSIS_VALUES],
			[...VALUES],
			"the emptied home was not restored — later arms are now unsound",
		);
		for (const value of VALUES) {
			assert.equal(
				h.admitDiagnosis(ruling(value, "nothing", "zq evidence")).available,
				true,
				`${value} is no longer admitted after the restore — the restore did not reach the enforcing object`,
			);
		}
	});

	it("EMPTINESS — the same law for INVALIDATIONS", () => {
		const h = mod();
		const saved = [...h.INVALIDATIONS];
		try {
			h.INVALIDATIONS.length = 0;
			for (const invalidation of INVALIDATION_MEMBERS) {
				assert.equal(
					h.admitDiagnosis(ruling("NONE", invalidation, "zq evidence")).available,
					false,
					`with the home emptied, the invalidation ${invalidation} was still admitted — a second accept site`,
				);
			}
		} finally {
			h.INVALIDATIONS.length = 0;
			h.INVALIDATIONS.push(...saved);
		}
		assert.deepEqual([...h.INVALIDATIONS], [...INVALIDATION_MEMBERS], "the emptied home was not restored");
		for (const invalidation of INVALIDATION_MEMBERS) {
			assert.equal(
				h.admitDiagnosis(ruling("NONE", invalidation, "zq evidence")).available,
				true,
				`the invalidation ${invalidation} is no longer admitted after the restore`,
			);
		}
	});

	it("IDENTITY — record.ts's OUTCOMES is what decides a resolved record's PARSE, measured through a compose/parse round trip", () => {
		const r = recordMod();
		const probe = "zq-not-an-outcome";
		const body = resolvedBody(probe);
		assert.equal(
			r.parseReviewRecord(body),
			undefined,
			"a resolved record carrying a non-member outcome parsed before any perturbation — record.ts's outcome " +
				"domain is not closed, and StateOutcome (derived from it) would receive a value it does not declare",
		);
		try {
			r.OUTCOMES.push(probe);
			assert.notEqual(
				r.parseReviewRecord(body),
				undefined,
				"pushing onto the exported OUTCOMES did not change what parseReviewRecord accepts, so the exported " +
					"array is not the object the validator consults — the contents assertion above certifies nothing, " +
					"and neither does StateOutcome's derivation from it",
			);
		} finally {
			const at = r.OUTCOMES.indexOf(probe);
			if (at !== -1) {
				r.OUTCOMES.splice(at, 1);
			}
		}
		assert.deepEqual([...r.OUTCOMES], [...OUTCOME_MEMBERS], "the perturbation was not restored");
		assert.equal(r.parseReviewRecord(body), undefined, "the refusal did not return after the restore");
	});

	it("EMPTINESS — with record.ts's OUTCOMES emptied, EVERY committed outcome stops parsing, and the history loses its states", () => {
		const r = recordMod();
		const saved = [...r.OUTCOMES];
		try {
			r.OUTCOMES.length = 0;
			for (const outcome of OUTCOME_MEMBERS) {
				assert.equal(
					r.parseReviewRecord(resolvedBody(outcome)),
					undefined,
					`with the home emptied, a ${outcome}-resolved record still parsed — some other site accepts it, so a ` +
						"member dropped from OUTCOMES would not be caught here either",
				);
			}
		} finally {
			r.OUTCOMES.length = 0;
			r.OUTCOMES.push(...saved);
		}
		assert.deepEqual([...r.OUTCOMES], [...OUTCOME_MEMBERS], "the emptied home was not restored");
		for (const outcome of OUTCOME_MEMBERS) {
			const parsed = r.parseReviewRecord(resolvedBody(outcome));
			assert.notEqual(parsed, undefined, `a ${outcome}-resolved record no longer parses after the restore`);
			// The tie back to THIS module: what the record carries is what the
			// assembler maps to a review state, so a broken outcome domain is
			// not a record-side curiosity — it is a missing state in §1.4's
			// history and a trigger that counts wrong.
			assert.deepEqual(
				mod()
					.repairHistory([parsed as ReviewRecord])
					.map((state) => state.outcome),
				[outcome],
				`a ${outcome}-resolved record no longer reaches the assembler as its own outcome`,
			);
		}
	});

	it("the UPSTREAM review-state tags are exactly the ones the assembler recognizes (round 8's S-F2, re-authored)", () => {
		// This replaces a regex over resolve.ts's union body. The tie is now a
		// TYPE WITNESS: `Record<ReviewState["state"], true>` cannot be written
		// without naming every tag, so a tag added, removed or renamed
		// upstream makes this object ill-typed.
		//
		// RESIDUAL DISCLOSURE (R-b), stated at the witness as well as at the
		// assembler's per-tag branch: the witness reds `tsc --noEmit`, NOT
		// this suite. A fourth upstream tag leaves every arm in this file
		// green and falls to the assembler's drop branch — safe, but not a
		// mapping anyone decided. The type-check step is therefore part of
		// this guard, not an adjacent convenience. The runtime assertion
		// below carries the half a witness cannot: that the tags the witness
		// names are the three the assembler's arms exercise.
		const witness: Record<UpstreamReviewState["state"], true> = {
			incomplete: true,
			approved: true,
			resolved: true,
		};
		assert.deepEqual(
			Object.keys(witness).sort(),
			["approved", "incomplete", "resolved"],
			"resolve.ts's ReviewState tags are no longer the three this module's assembler recognizes. A new tag falls " +
				"to the assembler's drop branch and contributes no state — which is safe — but no arm here exercises " +
				"it, and the intended mapping has not been decided. Decide it and extend the assembler's explicit " +
				"per-tag tests, or the domain is covered by a drop nobody chose",
		);
	});

	it("the payload's key set is closed member by member — each key omitted, and an unknown key added, hand off", () => {
		// DIAGNOSIS_KEYS is deliberately unexported with no accessor (R-f):
		// unlike the two domains it has no second home to weld, so it is
		// pinned BEHAVIOURALLY and exactly — every committed key is load
		// bearing (omit it, the return is refused) and the shape admits
		// nothing else.
		const h = mod();
		const whole: Record<string, unknown> = { value: "NONE", invalidation: "nothing", evidence: "zq evidence" };
		const admitted = (payload: string): boolean =>
			h.admitDiagnosis({ disposition: "admitted", ok: true, summary: "x", payload, compare: "confirmed" }).available;
		assert.equal(admitted(JSON.stringify(whole)), true, "the whole payload was refused — this arm's premise is gone");
		for (const key of PAYLOAD_KEYS) {
			const missing = { ...whole };
			delete missing[key];
			assert.equal(
				admitted(JSON.stringify(missing)),
				false,
				`a payload omitting ${JSON.stringify(key)} was admitted — that key is not enforced, so a Judge that ` +
					"never returned it yields a diagnosis with a slot nobody filled",
			);
		}
		assert.equal(
			admitted(JSON.stringify({ ...whole, zqExtra: true })),
			false,
			"an unknown key was admitted — the diagnosis shape is closed, and an unknown key is a surface no contract bounds",
		);
	});

	it("the brief names every member of the LIVE domain homes and every enforced payload key (round 7's F-R3, re-keyed)", () => {
		// A producer/consumer pair with two homes: the brief TELLS the Judge
		// the shape and the values; the parser ENFORCES them. The tie is
		// re-keyed onto the live homes, so a member added to a domain without
		// being named in the brief reds here — and a Judge is never told a
		// different shape than the one admitted.
		const h = mod();
		const brief = h.composeDiagnosisBrief([{ head: "a".repeat(40), outcome: "repair", findings: [], rulings: [] }], {
			changeDescription: "d",
		});
		for (const value of h.DIAGNOSIS_VALUES) {
			assert.ok(
				brief.includes(value),
				`the brief never names the taxonomy value ${value} the parser will accept — the Judge cannot return a ` +
					"value it was never told exists",
			);
		}
		for (const invalidation of h.INVALIDATIONS) {
			assert.ok(
				brief.includes(invalidation),
				`the brief never names the invalidation finding ${invalidation} the parser will accept — the second ` +
					"output the diagnosis owes, and the one that routes re-entry",
			);
		}
		for (const key of PAYLOAD_KEYS) {
			assert.ok(
				brief.includes(key),
				`the brief never names the key ${JSON.stringify(key)} that the parser enforces — a Judge told a ` +
					"different shape than the one admitted returns malformed rulings, and every change then parks " +
					"(§3.11: one property, one home; where there are two, an arm ties them)",
			);
		}
	});
});

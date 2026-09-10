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
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
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
	outcome: "repair" | "measure-escalate" | "clear" | "approved" | "incomplete";
	findings: string[];
	rulings: StateRuling[];
};
type DiagnosisValue = "NONE" | "STAGNATION" | "OSCILLATION" | "INDETERMINATE";
type Invalidation = "nothing" | "plan" | "authorization";
type DiagnosisInput = { value: DiagnosisValue; invalidation: Invalidation; evidence: string };
type DiagnosisAdmission =
	| { available: true; diagnosis: DiagnosisInput }
	| { available: false; disposition: "hand-off" | "fail-open"; reason: string };
type Consequence = { proceed: boolean; park: boolean; reentry: "none" | "plan" | "authorization" };

type HistoryModule = {
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
		const out = h.repairHistory([repair("a".repeat(40)), clear("b".repeat(40)), approved("c".repeat(40))]);
		assert.deepEqual(
			out.map((s) => ({ head: s.head, outcome: s.outcome })),
			[
				{ head: "a".repeat(40), outcome: "repair" },
				{ head: "b".repeat(40), outcome: "clear" },
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

	it("a NON-CONTIGUOUS re-post moves the head to its latest position — the trigger does not under-fire (round 2's E1)", () => {
		const h = mod();
		const [a, b, c] = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
		// A repaired, then C cleared, then B repaired, then A re-posted as a
		// repair. Taking A's position from its FIRST occurrence freezes it at
		// index 0 (sequence a|c|b, trailing run one repair, trigger silent);
		// taking position from the LAST occurrence yields c|b|a (trailing run
		// two repairs, trigger fires) — §1.4 forbids the under-fire.
		const out = h.repairHistory([repair(a), clear(c), repair(b), repair(a)]);
		assert.deepEqual(
			out.map((s) => s.head),
			[c, b, a],
			"a re-posted head kept its first position — the sequence is misordered and position/outcome are split " +
				"across records",
		);
		assert.equal(
			h.triggerFires(out),
			true,
			"the trigger under-fired on a non-contiguous re-post — a change could then repair indefinitely (§1.4)",
		);
	});

	it("an incomplete head is a review state, distinct from repair", () => {
		const h = mod();
		const out = h.repairHistory([incomplete("a".repeat(40)), repair("b".repeat(40))]);
		assert.deepEqual(
			out.map((s) => s.outcome),
			["incomplete", "repair"],
			"an incomplete review state was dropped or mis-mapped — it is a state, distinct from repair",
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
});

describe("§1.4 the diagnosis admission is fail-closed — absence is not NONE (issue #186)", () => {
	it("a valid confirmed diagnosis is available with its two outputs and evidence", () => {
		const h = mod();
		const input = { value: "STAGNATION" as const, invalidation: "nothing" as const, evidence: "the method repeated" };
		const admission = h.admitDiagnosis(admittedPayload(input));
		assert.ok(admission.available, "a valid diagnosis was not admitted");
		// Round 2's S2: all three fields must be the payload's, not just the
		// value — a forged invalidation drops a §1.4 re-entry route.
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
			!admission.available && admission.disposition === "hand-off",
			"a refused diagnosis dispatch was not a hand-off — an unavailable Judge is not NONE (§1.4)",
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
			!admission.available && admission.disposition === "hand-off",
			"an ok:false diagnosis with a well-formed payload was read as a value — §1.4's present-but-cannot-measure " +
				"limb takes the delegate-disowned shape too, and it must hand off",
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
			!admission.available && admission.disposition === "hand-off",
			"a diagnosis that failed the blind compare was read anyway — §1.6's compare gates it",
		);
	});

	it("a malformed or out-of-set payload hands off, never defaults to a value", () => {
		const h = mod();
		for (const payload of ['{"value":"MAYBE","invalidation":"nothing","evidence":"e"}', "not json", "{}"]) {
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

	it("a hand-off carries a non-empty reason — neither fail limb is silent (round 1's E4)", () => {
		const h = mod();
		const admission = h.admitDiagnosis({
			disposition: "admitted",
			ok: true,
			summary: "x",
			payload: "{}",
			compare: "confirmed",
		});
		assert.ok(
			!admission.available && admission.reason.length > 0,
			"the malformed-return hand-off carried an empty reason — §1.4's 'neither limb is silent' reaches the " +
				"closed limb too; the handoff's recipient must know why it received the change",
		);
	});
});

describe("§1.4 the deterministic consumer (issue #186)", () => {
	it("NONE admits a further autonomous repair; the other three park", () => {
		const h = mod();
		assert.deepEqual(
			h.diagnosisConsequence("NONE", "nothing"),
			{ proceed: true, park: false, reentry: "none" },
			"NONE did not admit a further repair",
		);
		for (const value of ["STAGNATION", "OSCILLATION", "INDETERMINATE"] as const) {
			const c = h.diagnosisConsequence(value, "nothing");
			assert.ok(
				!c.proceed && c.park,
				`${value} did not hand off to a park — only NONE admits a further attempt (§1.4)`,
			);
		}
	});

	it("the invalidation finding routes the re-entry gate, independently of the value", () => {
		const h = mod();
		assert.equal(h.diagnosisConsequence("NONE", "plan").reentry, "plan", "a plan invalidation did not route to §1.8");
		assert.equal(
			h.diagnosisConsequence("STAGNATION", "authorization").reentry,
			"authorization",
			"an authorization invalidation did not route to §1.2/§2.2",
		);
		assert.equal(h.diagnosisConsequence("NONE", "nothing").reentry, "none", "nothing-invalidated routed a re-entry");
	});
});

describe("§1.4 the two fail limbs — present-but-cannot-measure vs absent substrate (issue #186)", () => {
	it("the store present but a record unreadable hands off (fail-closed)", () => {
		const h = mod();
		const availability = h.historyAvailability(true, undefined);
		assert.ok(
			!availability.available && availability.disposition === "hand-off",
			"an installed store whose records could not be read failed open — present-but-cannot-measure is fail-closed",
		);
	});

	it("the store absent in this clone fails OPEN with a warning", () => {
		const h = mod();
		const availability = h.historyAvailability(false, undefined);
		assert.ok(
			!availability.available && availability.disposition === "fail-open" && availability.reason.length > 0,
			"an uninstalled record substrate did not fail open with a warning — the acting party neither caused it " +
				"nor can repair it from inside a block (§1.4)",
		);
	});

	it("the store present and records readable is available", () => {
		const h = mod();
		const availability = h.historyAvailability(true, [repair("a".repeat(40))]);
		assert.ok(availability.available, "a readable installed store was not available");
	});
});

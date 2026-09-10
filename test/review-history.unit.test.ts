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
	outcome: "repair" | "measure-escalate" | "clear" | "approved";
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
				findings: [`zq ${position} finding`],
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
			text.includes("findings: (none)"),
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
			!admission.available && admission.disposition === "hand-off" && admission.reason.length > 0,
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
			!admission.available && admission.disposition === "hand-off" && admission.reason.length > 0,
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
			!admission.available && admission.disposition === "hand-off" && admission.reason.length > 0,
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
			!availability.available && availability.disposition === "hand-off" && availability.reason.length > 0,
			"an installed store whose records could not be read failed open, or handed off silently — " +
				"present-but-cannot-measure is fail-closed and §1.4's hand-off carries a reason (round 3's EF3)",
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

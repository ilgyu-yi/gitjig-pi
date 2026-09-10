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

type StateSummary = { head: string; outcome: "repair" | "measure-escalate" | "clear" | "approved" | "incomplete" };
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
			out,
			[
				{ head: "a".repeat(40), outcome: "repair" },
				{ head: "b".repeat(40), outcome: "clear" },
				{ head: "c".repeat(40), outcome: "approved" },
			],
			"the history did not map each record to a head+outcome state in order — the history is the record " +
				"sequence, read not remembered",
		);
	});

	it("the panel's slots at one head collapse into one state — a duplicated head is one state", () => {
		const h = mod();
		// Two records at one head (a re-dispatched slot re-posts the record):
		// §1.7 says simultaneous results at one head are one decision, not N.
		const out = h.repairHistory([repair("a".repeat(40)), repair("a".repeat(40)), clear("b".repeat(40))]);
		assert.deepEqual(
			out.map((s) => s.head),
			["a".repeat(40), "b".repeat(40)],
			"two records at one head produced two states — a head individuates one review state (§1.4/§1.7)",
		);
	});

	it("an incomplete head is a state but a no-review record contributes none", () => {
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

	it("fires at the SECOND consecutive repair, not the first", () => {
		const [a, b] = heads(2);
		assert.equal(h().triggerFires([{ head: a, outcome: "repair" }]), false, "the first repair fired the trigger");
		assert.equal(
			h().triggerFires([
				{ head: a, outcome: "repair" },
				{ head: b, outcome: "repair" },
			]),
			true,
			"the second consecutive repair did not fire the trigger",
		);
	});

	it("a non-repair state interposed RESETS the count", () => {
		const [a, b, c] = heads(3);
		assert.equal(
			h().triggerFires([
				{ head: a, outcome: "repair" },
				{ head: b, outcome: "clear" },
				{ head: c, outcome: "repair" },
			]),
			false,
			"an interposed clear did not reset the consecutive-repair count — the trailing run is one repair",
		);
	});

	it("the findings-free path never fires it — approved is not a repair state", () => {
		const [a, b] = heads(2);
		assert.equal(
			h().triggerFires([
				{ head: a, outcome: "approved" },
				{ head: b, outcome: "approved" },
			]),
			false,
			"a run of approved states fired the repair trigger",
		);
	});

	it("the empty history does not fire", () => {
		assert.equal(h().triggerFires([]), false, "an empty history fired the trigger");
	});
});

describe("§1.4 the diagnosis admission is fail-closed — absence is not NONE (issue #186)", () => {
	it("a valid confirmed diagnosis is available with its two outputs and evidence", () => {
		const h = mod();
		const admission = h.admitDiagnosis(
			admittedPayload({ value: "STAGNATION", invalidation: "nothing", evidence: "the method repeated" }),
		);
		assert.ok(admission.available && admission.diagnosis.value === "STAGNATION", "a valid diagnosis was not admitted");
	});

	it("a refused dispatch hands off — never read as NONE", () => {
		const h = mod();
		const admission = h.admitDiagnosis({ disposition: "refused", cause: "any" });
		assert.ok(
			!admission.available && admission.disposition === "hand-off",
			"a refused diagnosis dispatch was not a hand-off — an unavailable Judge is not NONE (§1.4)",
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

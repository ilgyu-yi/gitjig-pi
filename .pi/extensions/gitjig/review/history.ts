/**
 * §1.4's cross-review-repair history instruments (issue #186,
 * Directive #183) — the repair-history record, the coarse
 * deterministic trigger, the diagnosis dispatch's admission, and the
 * deterministic consumer. Read §1.4 for what each owes; the comments
 * here name the local decision, not a second copy of the clause
 * (§2.8).
 *
 * §1.4's clause sleeps on its own subject's absence (§5.3) until these
 * derive; this module is that derivation. The history's unit is
 * Execution (a)'s durable review record (record.ts): one resolved
 * review at one head is one review state, and the panel's slots at one
 * head collapse into one state (§1.7).
 *
 * DECISION — the history is ASSEMBLED from the durable records, never
 * authored. §1.4 holds the history in "a durable record the acting
 * agent does not author — since a self-kept record reproduces exactly
 * the failure it exists to prevent." `repairHistory` reads the parsed
 * records (record.ts's shape) and derives the state sequence; nothing
 * here takes a caller's running tally. That is the whole point of the
 * instrument, so it is the one property with no fallback.
 *
 * DECISION — the diagnosis is admitted fail-closed, and absence is
 * NEVER read as NONE. §1.4: "absence is not NONE, and an unreadable
 * history is never read as STAGNATION." A refused, unconfirmed, or
 * malformed diagnosis dispatch is a hand-off (the change parks exactly
 * as a non-NONE value would), never a value. The one open-direction
 * limb is the substrate's absence in a clone, which fails open with a
 * warning — a property of a clone, not of a moment.
 *
 * NOT here: the diagnosis's own semantics (that is the Judge's, and
 * this module composes its brief and admits its return, never rules);
 * the trigger's occasion (the caller derives it from the resolver
 * disposition it already reads); §1.8's plan contest and §1.2/§2.2's
 * gates the invalidation finding routes to (this module names the
 * route, the caller performs it).
 *
 * Warning-surface roster: EXEMPT — like briefs.ts, composeDiagnosisBrief
 * embeds caller-supplied content verbatim into a delegate brief (the
 * record's heads, outcomes, finding texts, and ruling evidence), never
 * a warned/thrown/printed message; escaping it would corrupt the
 * verbatim-embedding contract §1.4's diagnosis rests on, and the one
 * consumer is the dispatcher's brief slot.
 */
import type { DispatchOutcome } from "../dispatch/index.ts";
// RESIDUAL DISCLOSURE (R-c), stated where the dependency is taken: a
// type-only import of an absent or renamed module reds `tsc` with the
// compiler's own message, never an authored one. The suite stays green
// on that failure, so the type-check step is load-bearing here and is
// not a convenience — the same shape the tag witness discloses.
import type { OUTCOMES, ReviewRecord } from "./record.ts";

/**
 * One review state's outcome, mapped from a RESOLVED record's
 * ReviewState. §1.4 counts the history in resolved reviews; an
 * `incomplete` review is not a review outcome at all (§1.7) and
 * contributes no state, so it has no member here — `repairHistory`
 * drops it rather than mapping it.
 *
 * DERIVED, not re-spelled (§3.11, and the §1.8 settlement that
 * re-planned this scope): the resolution outcomes are ENFORCED by
 * record.ts's `OUTCOMES` — a record whose outcome is outside it does
 * not parse — so this type reads that one home and adds the one member
 * a resolution never supplies. "StateOutcome is the enforced outcomes
 * plus `approved`" is therefore a declaration `tsc` keeps, rather than
 * an arm that can drift from what it claims to tie.
 */
export type StateOutcome = (typeof OUTCOMES)[number] | "approved";

/** One ruling as the diagnosis reads it — §1.4's "same findings the Judge already ruled". */
export type StateRuling = { finding: string; validity: string; severity?: string; evidence: string };

/**
 * One review state: head and outcome (what the trigger reads) plus the
 * findings and rulings the diagnosis reads (§1.4 — the diagnosis reads
 * the same findings the Judge already ruled, undecidable from an
 * outcome label alone).
 */
export type StateSummary = {
	head: string;
	outcome: StateOutcome;
	findings: string[];
	rulings: StateRuling[];
};

/**
 * §1.4's four-value taxonomy and the invalidation finding — ONE home
 * each (§3.11). The runtime list is the home and the type is DERIVED
 * from it, so a member can be added or dropped in exactly one place: a
 * hand-spelled union beside a `Set` literal was two homes for one
 * property, and this change's round history is what that cost.
 * `admitDiagnosis` narrows over these very arrays, so the object an arm
 * reads is the object the parser consults.
 *
 * RESIDUAL DISCLOSURE (R-a), stated in place: `as const` is a
 * type-level word only — an importer can still `push` onto either array
 * at runtime. That reachability is deliberate and load-bearing: the
 * suite's identity-by-perturbation and emptiness laws prove these are
 * the enforcing objects by mutating them and restoring them. No
 * production site mutates either.
 */
export const DIAGNOSIS_VALUES = ["NONE", "STAGNATION", "OSCILLATION", "INDETERMINATE"] as const;
export const INVALIDATIONS = ["nothing", "plan", "authorization"] as const;
export type DiagnosisValue = (typeof DIAGNOSIS_VALUES)[number];
export type Invalidation = (typeof INVALIDATIONS)[number];
export type DiagnosisInput = { value: DiagnosisValue; invalidation: Invalidation; evidence: string };

export type DiagnosisAdmission =
	| { available: true; diagnosis: DiagnosisInput }
	| { available: false; disposition: "hand-off"; reason: string };

export type Consequence = { proceed: boolean; park: boolean; reentry: "none" | "plan" | "authorization" };

/**
 * Assemble the repair history from the durable review records, in the
 * order posted, one state per head. Two records at one head are one
 * state (§1.7's collapse); the later record wins, since a re-dispatched
 * slot re-posts the completed state. A resolved record maps to its
 * resolution's outcome and `approved` is its own state; an
 * `incomplete` record is no review state (§1.4/§1.7) and is dropped.
 */
export function repairHistory(records: readonly ReviewRecord[]): StateSummary[] {
	const byHead = new Map<string, StateSummary>();
	const order: string[] = [];
	for (const record of records) {
		// An incomplete review is not a resolved review, so it is not a
		// review state and contributes NONE to the counted history (§1.4,
		// §1.7) — dropped, never a resetting state.
		if (record.review.state === "incomplete") {
			continue;
		}
		// The outcome is decided by an EXPLICIT test per recognized tag, never
		// by a catch-all else. The tag union lives upstream in resolve.ts, so
		// tsc does not make a two-way ternary exhaustive over it: a member
		// added there falls through a catch-all onto "approved" — the one
		// outcome that RESETS §1.4's trigger — and silences a fired trigger
		// from another file. An unrecognized state is no review state at all,
		// and is dropped exactly as `incomplete` is: §1.4's own rule that a
		// head drawing no resolved review contributes no state.
		//
		// RESIDUAL DISCLOSURE (R-b), stated at the second home and not only
		// at the guard that welds it: these per-tag branches are a second
		// home for a union declared in resolve.ts. The suite ties them with a
		// type witness over `ReviewState["state"]`, and that witness reds
		// `tsc`, NOT the suite — a fourth upstream tag leaves every arm here
		// green and is caught only by the type-check step.
		let outcome: StateOutcome;
		if (record.review.state === "resolved") {
			outcome = record.review.resolution.outcome;
		} else if (record.review.state === "approved") {
			outcome = "approved";
		} else {
			continue;
		}
		const findings = record.bundle.map((entry) => entry.finding);
		const rulings: StateRuling[] =
			record.adjudication === null
				? []
				: record.adjudication.rulings.map((ruling) => {
						const summary: StateRuling = {
							finding: ruling.finding,
							validity: ruling.validity,
							evidence: ruling.evidence,
						};
						if (ruling.severity !== undefined) {
							summary.severity = ruling.severity;
						}
						return summary;
					});
		// One head is one state (§1.4's collapse): its CONTENT comes from the
		// last record at that head, and its POSITION from the head's FIRST
		// appearance. The two halves come from different records on purpose,
		// because they answer different questions — what the review at this
		// head concluded, and when this head was reviewed relative to the
		// others.
		//
		// REJECTED ALTERNATIVE, recorded where it is rejected: taking the
		// position from the LAST record too, so a re-post moves its head to
		// the end. That rule silences a trigger that has already fired. Measured: records
		// [approved(A), repair(B), repair(C)] give A|B|C with a trailing run
		// of two repairs and the trigger FIRES; appending a re-post of A's
		// own already-resolved record moves A to the end, giving B|C|A with a
		// trailing run of one approved state, and the trigger goes SILENT.
		// §1.4's opening forbids exactly that direction, and a re-dispatched
		// slot re-posting a completed record makes that an ordinary event,
		// not an exotic one.
		//
		// Positioning by first appearance does not misorder the sequence:
		// heads advance as the change is repaired, so the order heads
		// FIRST appear is review chronology, and moving a head to the end
		// because a record about it arrived late asserts that a head reviewed
		// first was reviewed last.
		if (!byHead.has(record.head)) {
			order.push(record.head);
		}
		byHead.set(record.head, { head: record.head, outcome, findings, rulings });
	}
	return order.map((head) => byHead.get(head) as StateSummary);
}

/**
 * The coarse deterministic trigger (§1.4): fires on every consecutive
 * review state resolved to `repair` after the first — the second and
 * each beyond it. A non-`repair` state resets the count, so what
 * decides the fire is the length of the TRAILING run of `repair`
 * states: two or more fires. The findings-free path never fires it —
 * an `approved` state is not `repair`. A pure function of the history.
 */
export function triggerFires(history: readonly StateSummary[]): boolean {
	let trailingRepairs = 0;
	for (let i = history.length - 1; i >= 0 && history[i].outcome === "repair"; i -= 1) {
		trailingRepairs += 1;
	}
	return trailingRepairs >= 2;
}

/**
 * The payload's closed key set. Deliberately NOT exported and given no
 * accessor (R-f): unlike the two domains above it has no second home to
 * weld — the brief that tells the Judge the shape is prose, not a member
 * list — so it is pinned behaviourally instead, by arms that post a
 * payload missing a key and a payload carrying an extra one. An export
 * here would widen the module's surface to buy a pin the behaviour
 * already carries.
 */
const DIAGNOSIS_KEYS = new Set(["value", "invalidation", "evidence"]);

/**
 * The one narrowing step for both domains: membership in the LIVE home,
 * read at call time. It is a type predicate, so a member that passes
 * leaves the parser with the narrowed type and no cast — which is the
 * point: a cast is a second accept site, and one that admits a value the
 * home never listed.
 */
function isMember<T extends string>(domain: readonly T[], value: unknown): value is T {
	if (typeof value !== "string") {
		return false;
	}
	const candidate = value;
	return domain.some((member) => member === candidate);
}

/**
 * Compose the diagnosis brief (§1.4's Judge dispatch, the actor's
 * second capacity). The history crosses as §1.5's dispatch-facts form
 * (i), derived at composition from the records. The brief asks for
 * BOTH outputs — the taxonomy value and the invalidation finding —
 * which answer different questions and never compete (§1.4).
 */
export function composeDiagnosisBrief(
	history: readonly StateSummary[],
	context: { changeDescription: string },
): string {
	const lines = history.flatMap((state, index) => {
		const header = `  ${index + 1}. head ${state.head} resolved ${state.outcome}`;
		const findings =
			state.findings.length === 0
				? ["       findings: (none)"]
				: state.findings.map((finding) => `       finding: ${finding}`);
		const rulings = state.rulings.map(
			(ruling) =>
				`       ruling: ${ruling.validity}${ruling.severity ? `/${ruling.severity}` : ""} on ${ruling.finding} — evidence: ${ruling.evidence}`,
		);
		return [header, ...findings, ...rulings];
	});
	return [
		"You are the JUDGE performing §1.4's repair-history diagnosis — the Judge's second capacity, a semantic",
		"reading of the same findings across review states. You rule and stop; the caller consumes your two",
		"outputs deterministically.",
		"",
		`CHANGE UNDER REVIEW: ${context.changeDescription}`,
		"",
		"THE REPAIR HISTORY (each state at one head, oldest first, with the findings and the rulings the Judge",
		"already made — embedded verbatim and LABELLED UNVERIFIED, §1.5 form iii; re-verify against the artifact",
		"rather than trusting the text). §1.4's diagnosis reads the SAME findings across states: STAGNATION is",
		"the same problem met by a materially equivalent repair, and OSCILLATION is the corrections' effect on",
		"the artifact — the labels the reviews wore are not the discriminator.",
		...lines,
		"",
		"Return TWO things and no third:",
		"1. the taxonomy VALUE, exactly one of NONE / STAGNATION / OSCILLATION / INDETERMINATE —",
		"   NONE: repair advanced, each attempt addressed ground the previous had not closed;",
		"   STAGNATION: the same problem met by a materially equivalent repair, still open;",
		"   OSCILLATION: two corrections causally opposed, the artifact reversed A→B→A;",
		"   INDETERMINATE: the history supports none of the three (a ruled outcome, never a default).",
		"2. the INVALIDATION finding, exactly one of nothing / plan / authorization — whether the history shows",
		"   the selected plan no longer holds, or the authorization no longer holds, or neither.",
		"",
		'Your ruling rides the return\'s "payload" slot as a JSON STRING of the closed shape',
		'{"value": <one of the four>, "invalidation": <one of the three>, "evidence": <non-empty command or citation>}.',
		"An unstated value is never inferred; absence is not NONE.",
	].join("\n");
}

/**
 * Parse the diagnosis out of the opaque payload, fail-closed. The
 * closed shape and out-of-set values refuse, since §1.4 forbids a
 * value inferred from a failure.
 */
function diagnosisFromPayload(payload: string | undefined): DiagnosisInput | undefined {
	if (typeof payload !== "string") {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}
	const keys = Object.keys(parsed);
	if (keys.length !== DIAGNOSIS_KEYS.size || !keys.every((key) => DIAGNOSIS_KEYS.has(key))) {
		return undefined;
	}
	const { value, invalidation, evidence } = parsed as { value: unknown; invalidation: unknown; evidence: unknown };
	// The narrowing IS the admission: each member reaches the returned
	// value through `isMember` over the exported home, so there is no cast
	// to write a non-member through. RESIDUAL DISCLOSURE (R-d): a future
	// edit CAN re-introduce one by spelling an explicit `as DiagnosisValue`
	// here, and nothing in this module stops it — the guarantee bought is
	// that such a second accept site must be written down and reviewed,
	// not that it is impossible. A lint rule forbidding it outright is a
	// new enforcement object and is outside this issue's subject.
	if (!isMember(DIAGNOSIS_VALUES, value)) {
		return undefined;
	}
	if (!isMember(INVALIDATIONS, invalidation)) {
		return undefined;
	}
	if (typeof evidence !== "string" || evidence.length === 0) {
		return undefined;
	}
	return { value, invalidation, evidence };
}

/**
 * Admit a diagnosis dispatch, fail-closed (§1.4/§1.6). A refused,
 * `ok:false`, unconfirmed-compare, or malformed return is a HAND-OFF —
 * the change parks exactly as a non-NONE value would — never read as
 * NONE. This is the present-but-cannot-measure limb; the caller supplies
 * the absent-substrate limb through `historyAvailability`.
 */
export function admitDiagnosis(outcome: DispatchOutcome): DiagnosisAdmission {
	if (outcome.disposition !== "admitted" || !outcome.ok || outcome.compare !== "confirmed") {
		return {
			available: false,
			disposition: "hand-off",
			reason:
				"the diagnosis dispatch is unavailable (refused, failed, or failed the blind compare) — the change " +
				"hands off; an unavailable Judge is never read as NONE (§1.4)",
		};
	}
	const diagnosis = diagnosisFromPayload(outcome.payload);
	if (diagnosis === undefined) {
		return {
			available: false,
			disposition: "hand-off",
			reason: "the diagnosis return is malformed against the closed shape — absence is not NONE (§1.4)",
		};
	}
	return { available: true, diagnosis };
}

/**
 * The deterministic consumer (§1.4). NONE admits a further autonomous
 * repair; STAGNATION, OSCILLATION and INDETERMINATE each hand the
 * change off to §5.7's park (every mode). The invalidation finding
 * routes the re-entry gate independently of the value — plan → §1.8,
 * authorization → §1.2/§2.2, nothing → no re-entry. There is no
 * workflow-effective progress value beyond NONE.
 */
export function diagnosisConsequence(value: DiagnosisValue, invalidation: Invalidation): Consequence {
	const reentry = invalidation === "plan" ? "plan" : invalidation === "authorization" ? "authorization" : "none";
	if (value === "NONE") {
		return { proceed: true, park: false, reentry };
	}
	return { proceed: false, park: true, reentry };
}

/**
 * The two fail limbs of §1.4's history dependency, keyed on the clone
 * property they turn on. `storeInstalled` is whether the durable-record
 * substrate exists in this clone; `records` is the fetched set, or
 * undefined where the fetch could not be read. An installed store whose
 * records are unreadable is present-but-cannot-measure and hands off
 * (fail-closed); an uninstalled store is absent and fails open with a
 * warning — the acting party neither caused it nor can repair it from
 * inside a block.
 */
export function historyAvailability(
	storeInstalled: boolean,
	records: ReviewRecord[] | undefined,
):
	| { available: true; records: ReviewRecord[] }
	| { available: false; disposition: "hand-off" | "fail-open"; reason: string } {
	if (!storeInstalled) {
		return {
			available: false,
			disposition: "fail-open",
			reason:
				"the repair-history substrate is not installed in this clone — the enforcement was never installed, so " +
				"the flow continues on its ordinary terms with this warning (§1.4, §5.2)",
		};
	}
	if (records === undefined) {
		return {
			available: false,
			disposition: "hand-off",
			reason:
				"the repair-history substrate is installed but its records could not be read — present-but-cannot-measure " +
				"fails closed and the change hands off (§1.4)",
		};
	}
	return { available: true, records };
}

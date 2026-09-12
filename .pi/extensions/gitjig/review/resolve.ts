/**
 * The adjudication contract and the deterministic Resolver (issue #177,
 * Directive #166) — the caller side of SPEC §1.9, above §4.9's dispatcher.
 * Read §1.9 for what the Judge owes and what the Resolver is; comments
 * here point at the clause and carry only the local decisions (§2.8).
 *
 * DECISION — three validation surfaces, three owners (§3.11).
 * `adjudicationFromPayload` rules STRUCTURE (the closed wire shape);
 * `admitAdjudication` rules §1.9 COMPLETENESS (dedup attested, every owed
 * axis ruled); the panel's `decideValidity` keeps §1.6's grammar. None
 * re-rules another's predicate.
 *
 * DECISION — the Resolver reads a manifest EMPTINESS fact, never the
 * criteria. `admitAdjudication` collapses the caller-derived manifest to
 * `manifestNonEmpty` before anything reaches `resolve`, so comparing
 * criterion semantics — the never-list's first entry — is structurally
 * unreachable rather than merely avoided: the criteria's text does not
 * exist on the Resolver's input. The absent manifest never gets that far:
 * §1.9 makes it a missing input, so admission refuses it as a gap and the
 * review is incomplete upstream of any disposition.
 *
 * DECISION — the two paths §1.9 names as closed are unrepresentable, not
 * discouraged. `resolve` accepts only the branded value `admitAdjudication`
 * mints, so raw findings cannot be disposed (they are not an adjudication)
 * and an author cannot fill the Judge's seat with a hand-built ruling set
 * without a cast a type-checked consumer must write out loud. The brand is
 * TYPE-ONLY, as the panel's are, and the suite pins its presence in this
 * source rather than a runtime effect.
 *
 * DECISION — admission is all-or-nothing. One unruled axis on one finding
 * holds the whole review: the never-list forbids disposing the rest of the
 * set around a gap, so incompleteness is ruled once, here, with the gaps
 * named for the caller to re-dispatch the Judge on — never inside the
 * Resolver, which by then cannot receive an incomplete input at all.
 *
 * NOT here, by design: the Judge's semantic acts (validity, dedup,
 * severity, direction, AC impact arrive as ruled data — this module
 * validates shape and completeness and infers none of them); §1.4's
 * history-diagnosis capacity (asleep, §5.3); and the orchestration loop
 * (fresh-panel-per-repair, nit carry-forward re-issue) — the dispositions
 * carry those semantics, the caller performs them.
 */
import type { DispatchOutcome } from "../dispatch/index.ts";
import type { PanelOutcome, Slot } from "./panel.ts";
// The resolution outcomes have ONE home and it is record.ts's `OUTCOMES`
// (§3.11; round 13's EF1). This is a TYPE-ONLY import, erased before the
// module runs, so the cycle it completes — record.ts imports this file's
// types, this file imports that one's — exists only for `tsc` and costs
// no runtime edge.
//
// RESIDUAL DISCLOSURE, stated where the dependency is taken: the home
// sits in record.ts because that is where the outcome is ENFORCED — a
// record whose outcome is outside it does not parse — while this file
// only declares the shape the Resolver produces. The direction is
// therefore enforcement-first rather than layer-first, and it is
// deliberate: a declaration deriving from its enforcer cannot drift from
// it, whereas an enforcer deriving from a declaration can.
import type { OUTCOMES } from "./record.ts";

/** §1.9's validity axis — INDETERMINATE is a ruling, not an absence. */
export type Validity = "CONFIRMED" | "REFUTED" | "INDETERMINATE";
/** §1.9's severity axis. */
export type Severity = "SUBSTANTIVE" | "NIT";
/** §1.9's harm-direction tokens — the complement of `fail-closed` is
 * `live-harm`, never `fail-open`, which names a gate posture. */
export type Direction = "fail-closed" | "live-harm";

/**
 * One effective finding as the Judge ruled it. The optional axes are owed
 * exactly when §1.9 owes them — all four on CONFIRMED, validity plus its
 * evidence otherwise — and `admitAdjudication` is where owed-but-absent
 * becomes a named gap rather than a silent default.
 */
export type Ruling = {
	finding: string;
	/** Which slots reported it — dedup merges and never discards (§1.9). */
	provenance: Slot[];
	validity: Validity;
	severity?: Severity;
	/** The exact mechanical remedy a NIT ruling carries as part of itself. */
	remedy?: string;
	direction?: Direction;
	/** The AC-impact axis: does the finding sit on a manifest criterion? */
	onCriterion?: boolean;
	/**
	 * The validity ruling's own record — the command it ran or the citation
	 * it rests on (§1.9) — owed on EVERY validity: a REFUTED finding is
	 * retained "with its refuting command" in the clause's own words. Fixed
	 * as part of the ruling, never later metadata, by the operator's ruling
	 * on the escalated question (issue #179); it is what §1.9's
	 * reconsideration clause anchors on, and nothing deterministic in this
	 * layer evaluates its content.
	 */
	evidence: string;
};

/**
 * The caller-derived criterion manifest, with §1.9's absent/empty
 * distinction carried as a state rather than an encoding convention: an
 * absent manifest is a missing input the review is incomplete on; an
 * empty one is a manifest on which nothing is deferrable.
 */
export type Manifest = { state: "absent" } | { state: "present"; criteria: readonly string[] };

/** The Judge return's parsed shape, before completeness has been ruled. */
export type AdjudicationInput = { dedupAttested: boolean; rulings: Ruling[] };

declare const adjudicated: unique symbol;

/**
 * A complete adjudication — the only value `resolve` accepts. Only
 * `admitAdjudication` mints one, which is what makes §1.9's two named
 * closed paths unrepresentable for a type-checked consumer (see header).
 * The criteria themselves are deliberately NOT on this type.
 */
export type Adjudication = {
	readonly [adjudicated]: true;
	readonly manifestNonEmpty: boolean;
	readonly rulings: readonly Ruling[];
};

export type AdmitResult = { complete: true; adjudication: Adjudication } | { complete: false; gaps: string[] };

export type Disposition = "repair" | "defer" | "remedy" | "measure-escalate" | "none";

export type Resolution = {
	dispositions: { finding: string; disposition: Disposition; remedy?: string }[];
	/**
	 * DERIVED from record.ts's `OUTCOMES`, never re-spelled here (round
	 * 13's EF1). The hand-spelled union this replaces was a second home
	 * for the domain, and it was the one that TYPED the value §1.4's
	 * assembler reads — so a member added here reached that assembler as
	 * an outcome `StateOutcome` does not declare, and a member added
	 * there was not accepted here, with no arm tying the two. Measured
	 * before the repair: widening this union by a fourth member left the
	 * history suite at 103 pass / 0 fail.
	 */
	outcome: (typeof OUTCOMES)[number];
};

export type ReviewState =
	| {
			state: "incomplete";
			cause: "panel" | "adjudication-missing" | "adjudication-incomplete";
			missing?: Slot[];
			gaps?: string[];
	  }
	| { state: "approved" }
	| { state: "resolved"; resolution: Resolution };

const VALIDITIES = new Set<unknown>(["CONFIRMED", "REFUTED", "INDETERMINATE"]);
const SEVERITIES = new Set<unknown>(["SUBSTANTIVE", "NIT"]);
const DIRECTIONS = new Set<unknown>(["fail-closed", "live-harm"]);
const TOP_KEYS = new Set(["dedupAttested", "rulings"]);
const RULING_KEYS = new Set([
	"finding",
	"provenance",
	"validity",
	"severity",
	"remedy",
	"direction",
	"onCriterion",
	"evidence",
]);
const SLOT_KEYS = new Set(["lens", "surface"]);

function isSlot(value: unknown): value is Slot {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const keys = Object.keys(value);
	if (keys.length !== SLOT_KEYS.size || !keys.every((key) => SLOT_KEYS.has(key))) {
		return false;
	}
	const slot = value as { lens: unknown; surface: unknown };
	return typeof slot.lens === "string" && typeof slot.surface === "string";
}

function isRuling(value: unknown): value is Ruling {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	if (!Object.keys(value).every((key) => RULING_KEYS.has(key))) {
		return false;
	}
	const r = value as Record<string, unknown>;
	if (typeof r.finding !== "string" || !Array.isArray(r.provenance) || !r.provenance.every(isSlot)) {
		return false;
	}
	if (typeof r.evidence !== "string") {
		return false;
	}
	if (!VALIDITIES.has(r.validity)) {
		return false;
	}
	if (r.severity !== undefined && !SEVERITIES.has(r.severity)) {
		return false;
	}
	if (r.remedy !== undefined && typeof r.remedy !== "string") {
		return false;
	}
	if (r.direction !== undefined && !DIRECTIONS.has(r.direction)) {
		return false;
	}
	return r.onCriterion === undefined || typeof r.onCriterion === "boolean";
}

/**
 * Parse a Judge return out of the opaque payload slot — the same closed
 * posture the reviewer payload takes in `join.ts`, for the same reason.
 * `undefined` is no adjudication; completeness is the next surface's.
 */
export function adjudicationFromPayload(payload: string | undefined): AdjudicationInput | undefined {
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
	if (keys.length !== TOP_KEYS.size || !keys.every((key) => TOP_KEYS.has(key))) {
		return undefined;
	}
	const { dedupAttested, rulings } = parsed as { dedupAttested: unknown; rulings: unknown };
	if (typeof dedupAttested !== "boolean" || !Array.isArray(rulings) || !rulings.every(isRuling)) {
		return undefined;
	}
	return { dedupAttested, rulings: rulings as Ruling[] };
}

/**
 * A Judge return counts only off the caller's own confirmed compare —
 * "returned invalid under the same compare the panel rides" is §1.9's
 * Judge-unavailability limb, and an unavailable Judge is an incomplete
 * review, never a ruling.
 */
export function adjudicationFromDispatch(outcome: DispatchOutcome): AdjudicationInput | undefined {
	if (outcome.disposition !== "admitted" || !outcome.ok || outcome.compare !== "confirmed") {
		return undefined;
	}
	return adjudicationFromPayload(outcome.payload);
}

/**
 * §1.9's completeness test — one test for every disposition, run once.
 * Where it fails, the named gaps are the caller's re-dispatch brief; where
 * it passes, the returned value is DETACHED from the caller's input (the
 * aliasing discipline the panel's own constructors carry) and branded.
 *
 * Token MEMBERSHIP is deliberately not ruled here: structure is the
 * parse's surface and completeness — ruled versus unruled — is this
 * one's (the header's §3.11 decision), so an out-of-set token can reach
 * this function only by casting past the exported types, which is
 * outside the typed contract — the brand's documented bound, stated so
 * the absence reads as a decision rather than an omission (§3.11).
 */
export function admitAdjudication(input: AdjudicationInput, manifest: Manifest): AdmitResult {
	const gaps: string[] = [];
	if (manifest.state === "absent") {
		gaps.push("the criterion manifest is absent — a missing input, not an empty set (§1.9)");
	}
	if (!input.dedupAttested) {
		gaps.push(
			"dedup is not attested in the Judge's return — the Resolver reads the attestation, never derives it (§1.9)",
		);
	}
	input.rulings.forEach((ruling, index) => {
		if (ruling.provenance.length === 0) {
			gaps.push(`ruling ${index}: provenance is empty — dedup merges and never discards (§1.9)`);
		}
		// Presence alone, owed on every validity like provenance — the parse
		// rules the field's type, this checks only that a ruling says what it
		// rests on, and nothing here reads what it says (issue #179's ruling:
		// admission checks presence, never evaluates).
		if (!ruling.evidence) {
			gaps.push(
				`ruling ${index}: validity evidence is empty — each ruling records the command it ran or the citation it rests on (§1.9)`,
			);
		}
		if (ruling.validity !== "CONFIRMED") {
			// REFUTED and INDETERMINATE owe validity and its evidence alone (§1.9).
			return;
		}
		if (ruling.severity === undefined) {
			gaps.push(`ruling ${index}: severity is unruled`);
		}
		if (ruling.severity === "NIT" && (typeof ruling.remedy !== "string" || ruling.remedy.length === 0)) {
			gaps.push(
				`ruling ${index}: a NIT ruling carries no exact mechanical remedy — the remedy is part of the ruling (§1.9)`,
			);
		}
		if (ruling.direction === undefined) {
			gaps.push(`ruling ${index}: harm direction is unruled — there is no silence default (§1.9)`);
		}
		if (ruling.onCriterion === undefined) {
			gaps.push(`ruling ${index}: AC impact is unruled`);
		}
	});
	if (gaps.length > 0) {
		return { complete: false, gaps };
	}
	const rulings = input.rulings.map((ruling) => ({
		...ruling,
		provenance: ruling.provenance.map((slot) => ({ lens: slot.lens, surface: slot.surface })),
	}));
	// The brand is TYPE-ONLY and never exists at runtime (the panel's own
	// documented bound): this runtime strips types, so the mint is a cast.
	return {
		complete: true,
		adjudication: {
			manifestNonEmpty: manifest.state === "present" && manifest.criteria.length > 0,
			rulings,
		} as unknown as Adjudication,
	};
}

/**
 * The Resolver (§1.9): a function, not a role. The five dispositions and
 * the fixed precedence, verbatim from the clause; nothing here reads a
 * finding's text, a remedy's content, or a criterion — see the header for
 * how the never-list is made structural rather than behavioural.
 */
export function resolve(adjudication: Adjudication): Resolution {
	const dispositions = adjudication.rulings.map((ruling) => {
		if (ruling.validity === "REFUTED") {
			return { finding: ruling.finding, disposition: "none" as const };
		}
		if (ruling.validity === "INDETERMINATE") {
			return { finding: ruling.finding, disposition: "measure-escalate" as const };
		}
		if (ruling.severity === "NIT") {
			return { finding: ruling.finding, disposition: "remedy" as const, remedy: ruling.remedy };
		}
		// Defer requires all three at once: the safe direction, off every
		// manifest criterion, and a manifest with criteria to be off — an
		// empty manifest makes nothing deferrable (§1.9's defer disposition).
		const deferrable =
			ruling.direction === "fail-closed" && ruling.onCriterion === false && adjudication.manifestNonEmpty;
		return { finding: ruling.finding, disposition: deferrable ? ("defer" as const) : ("repair" as const) };
	});
	const outcome = dispositions.some((entry) => entry.disposition === "repair")
		? ("repair" as const)
		: dispositions.some((entry) => entry.disposition === "measure-escalate")
			? ("measure-escalate" as const)
			: ("clear" as const);
	return { dispositions, outcome };
}

/**
 * The composed review outcome. The order of the gates is the contract:
 * the panel's completeness first (§1.7), the findings-free path second
 * (§1.9 — the Judge never runs, so an offered adjudication is not read),
 * and Judge availability third — a non-empty bundle with a missing or
 * incomplete adjudication is an incomplete review, never a passthrough of
 * the raw findings.
 */
export function reviewOutcome(panel: PanelOutcome, admission: AdmitResult | undefined): ReviewState {
	if (panel.outcome === "incomplete") {
		// A COPY, the array and its slot objects both: `missing` is the
		// caller's re-dispatch brief, and an aliased entry is a required slot
		// a later mutation of the caller's panel outcome can drop or redirect
		// — the post-hoc-mutation class the panel's own constructors are
		// cured of, applied at this module's one outward-facing slot list.
		return {
			state: "incomplete",
			cause: "panel",
			missing: panel.missing.map((slot) => ({ lens: slot.lens, surface: slot.surface })),
		};
	}
	if (panel.outcome === "approved") {
		return { state: "approved" };
	}
	if (admission === undefined) {
		return { state: "incomplete", cause: "adjudication-missing" };
	}
	if (!admission.complete) {
		return { state: "incomplete", cause: "adjudication-incomplete", gaps: [...admission.gaps] };
	}
	if (admission.adjudication.rulings.length === 0) {
		// Entailed arithmetic, never adjudication: dedup merges and never
		// discards (§1.9) and a bundle that dropped a finding is defective
		// (§1.7), so a non-empty bundle — which the bundle outcome is by
		// construction — yields at least one effective finding as a theorem.
		// A Judge return that rules NOTHING over real findings is the
		// emptiest shape of §1.9's returned-invalid limb, refused at the one
		// seam where both operands are in hand; this branch reads ONE length
		// — the rulings' — and no finding's text, taking the bundle's
		// non-emptiness from the panel's own construction (`panelOutcome`
		// returns approved at `bundle.length === 0`) rather than from a read
		// here. The alternative — widening admitAdjudication to take the
		// bundle so completeness stays one test — is recorded and not taken:
		// the admission deliberately never sees the bundle.
		return {
			state: "incomplete",
			cause: "adjudication-incomplete",
			gaps: [
				"the adjudication rules no effective finding over a non-empty bundle — dedup merges and never discards (§1.9)",
			],
		};
	}
	return { state: "resolved", resolution: resolve(admission.adjudication) };
}

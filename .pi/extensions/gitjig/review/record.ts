/**
 * The durable review record (issue #184, Directive #183) — §1.4's
 * record surface for one review state: machine-composed from admitted
 * returns, pinned to the reviewed head, preserving every admitted
 * Ruling's `evidence` verbatim, and parseable back so a
 * later reader — §1.4's history instruments among them — consumes a
 * recorded fact, never a remembered one.
 *
 * DECISION — the record's home is a platform comment on the PR, posted
 * through the landed egress boundary; this module composes and parses
 * the BODY and performs no egress of its own (a second egress path is
 * the parallel-path defect §5.8 names). The rejected homes are on the
 * Execution issue: a committed file advances the head it claims to
 * describe; `.git`-local state does not cross clones (§1.4 requires
 * cross-clone readability).
 *
 * DECISION — the marker is §2.2's idempotency-key shape: a content
 * marker the writer controls, carrying the pinned head, so a reader
 * selects the record for a head mechanically and a body without the
 * marker is prose, never a record. Parsing is fail-closed: a marked
 * body whose JSON does not parse, or parses to anything but the closed
 * shape, is no record — a guessed record is worse than a missing one.
 */
import type { Slot } from "./panel.ts";
import type { AdjudicationInput, ReviewState } from "./resolve.ts";

export const REVIEW_RECORD_MARKER = "gitjig-review-record";

export type SlotRecord = { slot: Slot; valid: boolean; reason?: string };

/**
 * One actor's return summary, carried VERBATIM (issue #203).
 *
 * WHY IT EXISTS. §1.9's admission burden defaults to RECORD, DO NOT
 * ADMIT, and both composed briefs tell their delegate to carry a
 * recorded-not-admitted item in the return's `summary`. A caller-mediated
 * round reads that summary and records it by hand. The orchestrator
 * dropped it: the reviewer join reads only the payload, the Judge's
 * closed shape has no slot for prose, and this record had no field for
 * it — so the RECORD half of the default was unrealizable on that path.
 *
 * WHY ONE LIST RATHER THAN A FIELD PER ACTOR. A `summary` on SlotRecord
 * plus a second field for the Judge would be two homes for one property
 * (§3.11), drifting independently. `from` discriminates, and the
 * `slot`-present-iff-`from`-is-`"slot"` agreement is enforced at the
 * parse rather than disclosed: prose attributed to the wrong actor is
 * worse than prose dropped.
 *
 * WHAT IS DELIBERATELY ABSENT — recorded as a decision, not an omission.
 * Nothing extracts "the observation part" of a summary. Deciding which
 * prose is an observation is a semantic act and §1.9 mints no second
 * adjudicator, so the WHOLE summary crosses and NOTHING READS IT. This
 * is transport, for the same reason §1.7 makes the bundle transport.
 *
 * NAMED RESIDUAL: a delegate can write false prose here, and this
 * channel neither checks it nor can. What it buys is that the prose
 * survives the round pinned to the head and to the actor that wrote it,
 * which is what a later reader — §1.4's diagnosis among them — needs in
 * order to weigh it at all.
 */
export type RoundSummary = { from: "slot" | "judge"; slot?: Slot; text: string };

export type ReviewRecord = {
	/** The full hash of the head this review state is pinned to (§1.6). */
	head: string;
	slots: SlotRecord[];
	bundle: { finding: string; slot: Slot }[];
	/** The admitted Judge input, evidence verbatim — null where no Judge ran. */
	adjudication: AdjudicationInput | null;
	review: ReviewState;
	/**
	 * The round's durable prose, one entry per admitted return that wrote
	 * one (issue #203). OPTIONAL, and that is load-bearing rather than
	 * lax: records already posted as platform comments carry the five keys
	 * above, and a required sixth would make every one of them unparseable
	 * — §1.4's history would silently lose those review states.
	 */
	summaries?: RoundSummary[];
};

const RECORD_KEYS = new Set(["head", "slots", "bundle", "adjudication", "review", "summaries"]);

const SUMMARY_KEYS = new Set(["from", "slot", "text"]);

function isRoundSummary(value: unknown): boolean {
	if (!isObject(value) || !Object.keys(value).every((key) => SUMMARY_KEYS.has(key))) {
		return false;
	}
	if (typeof value.text !== "string") {
		return false;
	}
	if (value.from === "slot") {
		return isSlot(value.slot);
	}
	// The agreement runs both ways: a judge-sourced entry carrying a slot
	// would attribute the Judge's words to a reviewer.
	return value.from === "judge" && value.slot === undefined;
}

/**
 * Compose the record body: the marker line pinning the head, then the
 * record as fenced JSON. The render is machine-emitted from the record
 * value — never typed prose — so what the reader parses is what the
 * round measured.
 */
export function composeReviewRecord(record: ReviewRecord): string {
	return (
		"<!-- " +
		REVIEW_RECORD_MARKER +
		": " +
		record.head +
		" -->\n\n```json\n" +
		JSON.stringify(record, null, "\t") +
		"\n```\n"
	);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSlot(value: unknown): boolean {
	return (
		isObject(value) &&
		Object.keys(value).length === 2 &&
		typeof value.lens === "string" &&
		typeof value.surface === "string"
	);
}

function isSlotRecord(value: unknown): boolean {
	if (!isObject(value) || !isSlot(value.slot) || typeof value.valid !== "boolean") {
		return false;
	}
	return (
		Object.keys(value).every((key) => key === "slot" || key === "valid" || key === "reason") &&
		(value.reason === undefined || typeof value.reason === "string")
	);
}

function isBundleEntry(value: unknown): boolean {
	return isObject(value) && Object.keys(value).length === 2 && typeof value.finding === "string" && isSlot(value.slot);
}

const VALIDITIES = new Set(["CONFIRMED", "REFUTED", "INDETERMINATE"]);
const SEVERITIES = new Set(["SUBSTANTIVE", "NIT"]);
const DIRECTIONS = new Set(["fail-closed", "live-harm"]);
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

function isRuling(value: unknown): boolean {
	if (!isObject(value) || !Object.keys(value).every((key) => RULING_KEYS.has(key))) {
		return false;
	}
	return (
		typeof value.finding === "string" &&
		Array.isArray(value.provenance) &&
		value.provenance.every(isSlot) &&
		VALIDITIES.has(value.validity as string) &&
		(value.severity === undefined || SEVERITIES.has(value.severity as string)) &&
		(value.remedy === undefined || typeof value.remedy === "string") &&
		(value.direction === undefined || DIRECTIONS.has(value.direction as string)) &&
		(value.onCriterion === undefined || typeof value.onCriterion === "boolean") &&
		typeof value.evidence === "string"
	);
}

function isAdjudication(value: unknown): boolean {
	return (
		isObject(value) &&
		Object.keys(value).length === 2 &&
		typeof value.dedupAttested === "boolean" &&
		Array.isArray(value.rulings) &&
		value.rulings.every(isRuling)
	);
}

/**
 * The ONE home of §1.9's five dispositions (§3.11; issue #208), and the
 * home resolve.ts's `Disposition` is DERIVED from through a type-only
 * import — so "the Resolver's dispositions are these five" is a
 * declaration rather than an arm that can drift from what it claims to
 * tie.
 *
 * Why it moved: this list enforced the runtime parse while resolve.ts
 * hand-spelled the same five members as the type the Resolver produces.
 * Two homes for one property, with nothing tying them. Measured before
 * the repair: a sixth member added at the type home was fully silent
 * across the whole corpus AND `tsc --noEmit`. That is the same shape,
 * and the same measurement, that issue #186's derivation repaired for the
 * resolution outcomes one type declaration above it.
 *
 * RESIDUAL DISCLOSURE (R-a's shape, restated here rather than
 * cross-referenced): exported so arms pin the LIVE object; the array is
 * runtime-mutable by an importer (`as const` is a type-level word only)
 * — the suite's identity and emptiness laws depend on exactly that
 * reachability, and no production site mutates it.
 *
 * RESIDUAL DISCLOSURE, and it is narrower than the outcome home's —
 * measured rather than carried over. The weld here is ONE-DIRECTIONAL:
 * a member REMOVED from this list reds `tsc` at the Resolver, which
 * produces the literal (measured: 1 type error, plus 3 suite arms), but
 * a member ADDED at the derived declaration — `(typeof
 * DISPOSITIONS)[number] | "zq-sixth"` — widens the type with nothing
 * downstream narrowing it back, so it reds neither `tsc` nor the suite.
 * The outcome domain does not have that gap only because §1.4's
 * assembler assigns into a narrower type and the compiler catches it
 * there; no consumer narrows a Disposition.
 *
 * That widening shape is closed by a TYPE WITNESS in the suite, which
 * cannot be written without naming every member — and it reds the type
 * check, not the suite. What this derivation itself buys is smaller and
 * worth stating plainly: the two homes issue #208 names are now one. That
 * is an ENUMERATION, not a closed class: measured on this tree, a THIRD
 * spelling of the same five members survives untied at
 * test/review-outcome.unit.test.ts:68, typing that suite's disposition
 * case table — appending a sixth member there reds neither `tsc --noEmit`
 * nor that suite. The spelling in test/review-orchestrator.unit.test.ts is
 * tied, by the CONTENTS arm.
 */
export const DISPOSITIONS = ["repair", "defer", "remedy", "measure-escalate", "none"] as const;

/** The one narrowing step over that home, read at call time. */
function isDisposition(value: unknown): value is (typeof DISPOSITIONS)[number] {
	return DISPOSITIONS.some((member) => member === value);
}

/**
 * The ONE home of the resolution outcomes (§3.11, §1.8 settlement on
 * the history instruments). BOTH downstream spellings are derived from
 * it through type-only imports, so each is a declaration rather than an
 * arm: history.ts's `StateOutcome` is this list plus "approved", and
 * resolve.ts's `Resolution["outcome"]` is this list exactly.
 *
 * The second one is named here because it is the load-bearing spelling.
 * A hand-spelled union at `Resolution` would carry the same three members,
 * and it is THAT spelling — not this one — that types the value §1.4's
 * assembler reads, while this list enforces only the runtime parse. Two
 * homes, no arm tying them: measured against such a union, widening it by
 * a fourth member leaves the history suite fully green. The claim
 * "the ONE home" holds only because that union derives.
 *
 * RESIDUAL DISCLOSURE (R-a): exported so arms pin the LIVE object; the
 * array is runtime-mutable by an importer (readonly is a type-level word
 * only) — the suite's identity and emptiness laws depend on exactly that
 * reachability, and no production site mutates it.
 *
 * RESIDUAL DISCLOSURE: the two derivations are welded by `tsc` and not by
 * the suite. A re-introduced hand-spelled
 * union at either site would type-check exactly as well as the
 * derivation does — nothing reds on a SECOND home, only on a divergent
 * one, and a second home that happens to agree today diverges silently
 * later. What the derivation buys is that the divergence is no longer
 * expressible without first writing the second home down.
 */
export const OUTCOMES = ["repair", "measure-escalate", "clear"] as const;

/**
 * The one narrowing step over that home, read at call time so the
 * object an arm reads is the object this validator consults.
 */
function isOutcome(value: unknown): value is (typeof OUTCOMES)[number] {
	return OUTCOMES.some((member) => member === value);
}

function isReviewState(value: unknown): boolean {
	if (!isObject(value)) {
		return false;
	}
	if (value.state === "approved") {
		return Object.keys(value).length === 1;
	}
	if (value.state === "incomplete") {
		return (
			Object.keys(value).every((key) => key === "state" || key === "cause" || key === "missing" || key === "gaps") &&
			typeof value.cause === "string" &&
			(value.missing === undefined || (Array.isArray(value.missing) && value.missing.every(isSlot))) &&
			(value.gaps === undefined || (Array.isArray(value.gaps) && value.gaps.every((gap) => typeof gap === "string")))
		);
	}
	if (value.state === "resolved") {
		if (Object.keys(value).length !== 2 || !isObject(value.resolution)) {
			return false;
		}
		const resolution = value.resolution;
		return (
			Object.keys(resolution).length === 2 &&
			isOutcome(resolution.outcome) &&
			Array.isArray(resolution.dispositions) &&
			resolution.dispositions.every(
				(entry: unknown) =>
					isObject(entry) &&
					Object.keys(entry).every((key) => key === "finding" || key === "disposition" || key === "remedy") &&
					typeof entry.finding === "string" &&
					isDisposition(entry.disposition) &&
					(entry.remedy === undefined || typeof entry.remedy === "string"),
			)
		);
	}
	return false;
}

/**
 * Parse a posted body back into the record, fail-closed: no marker, no
 * fence, unparseable JSON, an open shape at ANY depth the consumers
 * read (a shallow gate would hand carry-forward a resolution-less
 * record it crashes on), or a marker head disagreeing with the
 * record's own head (the selector and the payload must not pin two
 * different reviews) all yield `undefined`.
 */
export function parseReviewRecord(body: string): ReviewRecord | undefined {
	const marker = new RegExp(`<!-- ${REVIEW_RECORD_MARKER}: (\\S+) -->`).exec(body);
	if (marker === null) {
		return undefined;
	}
	const fenceOpen = body.indexOf("```json\n");
	if (fenceOpen === -1) {
		return undefined;
	}
	const jsonStart = fenceOpen + "```json\n".length;
	const fenceClose = body.indexOf("\n```", jsonStart);
	if (fenceClose === -1) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(body.slice(jsonStart, fenceClose));
	} catch {
		return undefined;
	}
	if (!isObject(parsed)) {
		return undefined;
	}
	const keys = Object.keys(parsed);
	// An optional key costs the exact-count test, which stated two things at
	// once: no unknown key, and no missing one. What replaces it is this
	// known-keys half ALONE, and the other half is deliberately not
	// re-added — every one of the five that predate `summaries` is already
	// refused by its own field check below when absent (`head` fails the
	// string test, `slots` and `bundle` fail `Array.isArray`, `adjudication`
	// is neither null nor an adjudication, `review` is not a review state).
	// MEASURED, because a guard nobody can red is decoration: a version of
	// this gate carrying an explicit required-key list killed no mutant —
	// deleting that list left the whole suite green, while deleting THIS
	// half reds two arms.
	if (!keys.every((key) => RECORD_KEYS.has(key))) {
		return undefined;
	}
	const candidate = parsed as unknown as ReviewRecord;
	if (typeof candidate.head !== "string" || candidate.head.length === 0 || candidate.head !== marker[1]) {
		return undefined;
	}
	if (!Array.isArray(candidate.slots) || !candidate.slots.every(isSlotRecord)) {
		return undefined;
	}
	if (!Array.isArray(candidate.bundle) || !candidate.bundle.every(isBundleEntry)) {
		return undefined;
	}
	if (candidate.adjudication !== null && !isAdjudication(candidate.adjudication)) {
		return undefined;
	}
	if (!isReviewState(candidate.review)) {
		return undefined;
	}
	// Absent is a state and an EMPTY LIST is a different one: a round in
	// which every delegate wrote an empty summary records `[]`, and a round
	// from before this key existed records nothing at all. Refusing the
	// empty list would make the second unrepresentable.
	if (candidate.summaries !== undefined) {
		if (!Array.isArray(candidate.summaries) || !candidate.summaries.every(isRoundSummary)) {
			return undefined;
		}
	}
	return candidate;
}

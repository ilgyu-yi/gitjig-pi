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

export type ReviewRecord = {
	/** The full hash of the head this review state is pinned to (§1.6). */
	head: string;
	slots: SlotRecord[];
	bundle: { finding: string; slot: Slot }[];
	/** The admitted Judge input, evidence verbatim — null where no Judge ran. */
	adjudication: AdjudicationInput | null;
	review: ReviewState;
};

const RECORD_KEYS = new Set(["head", "slots", "bundle", "adjudication", "review"]);

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

const DISPOSITIONS = new Set(["repair", "defer", "remedy", "measure-escalate", "none"]);

/**
 * The ONE home of the resolution outcomes (§3.11, §1.8 settlement on
 * the history instruments). BOTH downstream spellings are derived from
 * it through type-only imports, so each is a declaration rather than an
 * arm: history.ts's `StateOutcome` is this list plus "approved", and
 * resolve.ts's `Resolution["outcome"]` is this list exactly.
 *
 * Round 13's EF1 is why the second one is named here. `Resolution`
 * carried a hand-spelled union of the same three members, and it was
 * THAT spelling — not this one — that typed the value §1.4's assembler
 * reads, while this list enforced only the runtime parse. Two homes,
 * no arm tying them: measured before the repair, widening that union by
 * a fourth member left the history suite at 103 pass / 0 fail. The claim
 * "the ONE home" is made here only because that union now derives.
 *
 * RESIDUAL DISCLOSURE (R-a): exported so arms pin the LIVE object; the
 * array is runtime-mutable by an importer (readonly is a type-level word
 * only) — the suite's identity and emptiness laws depend on exactly that
 * reachability, and no production site mutates it.
 *
 * RESIDUAL DISCLOSURE, new with the EF1 repair: the two derivations are
 * welded by `tsc` and not by the suite. A re-introduced hand-spelled
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
					DISPOSITIONS.has(entry.disposition as string) &&
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
	if (keys.length !== RECORD_KEYS.size || !keys.every((key) => RECORD_KEYS.has(key))) {
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
	return candidate;
}

/**
 * The durable review record (issue #184, Directive #183) — §1.4's
 * record surface for one review state: machine-composed from admitted
 * returns, pinned to the reviewed head, preserving every admitted
 * Ruling's `evidence` verbatim (F15's anchor), and parseable back so a
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

/**
 * Parse a posted body back into the record, fail-closed: no marker, no
 * fence, unparseable JSON, or an open shape all yield `undefined`.
 */
export function parseReviewRecord(body: string): ReviewRecord | undefined {
	if (!body.includes(`<!-- ${REVIEW_RECORD_MARKER}: `)) {
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
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}
	const keys = Object.keys(parsed);
	if (keys.length !== RECORD_KEYS.size || !keys.every((key) => RECORD_KEYS.has(key))) {
		return undefined;
	}
	const candidate = parsed as ReviewRecord;
	if (typeof candidate.head !== "string" || candidate.head.length === 0) {
		return undefined;
	}
	if (!Array.isArray(candidate.slots) || !Array.isArray(candidate.bundle)) {
		return undefined;
	}
	if (candidate.adjudication !== null && typeof candidate.adjudication !== "object") {
		return undefined;
	}
	if (typeof candidate.review !== "object" || candidate.review === null) {
		return undefined;
	}
	return candidate;
}

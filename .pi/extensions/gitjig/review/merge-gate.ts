/**
 * §3.3's `merge-review` gate — the tier-3 predicate over the durable
 * review record (issue #190, Directive #28).
 *
 * The row's guarded act is "merging without a complete, adjudicated
 * review pinned at the merged head", and its `supplies:` slot reads
 * platform. This module is the predicate; the workflow that calls it
 * supplies the platform's comment list and the head under review, and
 * consumes the verdict deterministically.
 *
 * §3.11: the record's shape rule is `record.ts`'s and is not respelled
 * here — `parseReviewRecord` is called, never reimplemented. What this
 * module adds is the part §3.7(e) puts on the *gate* rather than on the
 * parser: the record must open its own comment (canonical position) and
 * bind to the head under review. `parseReviewRecord` matches its marker
 * anywhere in a body by design, since it reads bodies it is handed; a
 * gate that inherited that latitude would accept a marker relayed
 * verbatim inside somebody else's artifact, which is the exact wrong
 * this clause names.
 *
 * Residual, enumerated rather than left implicit (§3.11 — a gate
 * enumerates in place the bypass vectors it deliberately does not
 * model, so a residual reads as a decision rather than an oversight):
 * the predicate consumes bodies only. The platform-attested author is
 * discarded at the boundary, so a record's AUTHORSHIP is not modelled
 * here; §3.7(d) carries hand-forgery as an amortized deferral with its
 * detection surfaces retained.
 *
 * Warning-surface roster: EXEMPT — no message composed here is warned or
 * thrown; `refuse.detail` is a caller-consumed field, and its one
 * consumer prints it as an advisory notice. The exemption is NOT a
 * licence to interpolate freely, and the distinction is load-bearing:
 * every RECORD-AUTHORED operand goes through `authored()` below, because
 * the consumer renders the detail to a log and §3.10 forbids a guarded
 * surface from hosting an input that can forge its own decisions.
 * Caller-derived operands — the head under review, a finding count — are
 * embedded verbatim: the head binding is the thing the gate exists to
 * report, and it comes from the platform, not from the record.
 */
import { quoted } from "../quote.ts";
import { parseReviewRecord, REVIEW_RECORD_MARKER, type ReviewRecord } from "./record.ts";

/**
 * Why the gate refused. Closed, and each member is a distinct authored
 * reason (AC6) rather than a shared "not satisfied" — §3.9's fail-closed
 * postures are only auditable if the refusals are distinguishable.
 */
export type RefusalReason =
	| "lookup-failed"
	| "no-record-at-head"
	| "record-unreadable"
	| "panel-incomplete"
	| "adjudication-missing";

export type MergeGateVerdict =
	| { pass: true; record: ReviewRecord }
	| { pass: false; reason: RefusalReason; detail: string };

/**
 * The platform's answer for one PR's comments. A failed lookup is a
 * *value*, never a throw: §3.7(c) makes lookup failure a refusal the
 * gate reports, and a thrown error would leave the posture to whatever
 * catches it.
 */
export type CommentLookup = { ok: true; bodies: readonly string[] } | { ok: false; cause: string };

/**
 * True when the body's FIRST bytes are this record's marker for `head`.
 *
 * Canonical position is `0` — not "early", not "on its own line". A
 * relayed marker sits after the relaying text by construction, so the
 * offset is what separates an artifact from a quotation of one. The head
 * is compared here too: a record that opens its own comment but pins a
 * different head is somebody else's round, not this head's evidence.
 */
function opensRecordFor(body: string, head: string): boolean {
	// The head is compared case-INSENSITIVELY and the marker exactly.
	// §3.11's semantics rule is that a differently-cased spelling of the
	// same ref is the same ref, and a head IS a ref: refusing a genuine
	// record because its hex arrived upper-cased is a wrong-BLOCK on an
	// identity that never changed. The marker's own bytes do not fold —
	// they are this format's literal syntax, not a ref.
	const prefix = `<!-- ${REVIEW_RECORD_MARKER}: `;
	const suffix = " -->";
	if (!body.startsWith(prefix)) {
		return false;
	}
	// The compared span is the head's own width plus the terminator, so
	// neither a strict prefix of the head nor a head this one is a prefix
	// of can satisfy it.
	const span = body.slice(prefix.length, prefix.length + head.length + suffix.length);
	return span.toLowerCase() === `${head}${suffix}`.toLowerCase();
}

/**
 * Escape a record-authored operand before it reaches a rendered detail.
 *
 * The record's fields are parsed from a PR comment, and this gate
 * deliberately does not model authorship (the residual above), so any
 * party who can comment chooses them. The one consumer prints the detail
 * to a run log, and §3.10 forbids a guarded surface from hosting an
 * input that can forge the guard's own decisions: an unescaped newline
 * in a record field renders a SECOND physical line, and a second line
 * shaped like this gate's PASS line is indistinguishable from one.
 * `quoted` rewrites the controls that make a second line possible.
 */
function authored(value: string): string {
	return quoted(value);
}

/**
 * §3.3's `merge-review` predicate.
 *
 * Fail-closed throughout (§3.7(c), §5.2): every path that is not a
 * measured pass is a refusal naming what was missing. Absence is never
 * approval — the same reasoning §1.4's admission uses when it refuses to
 * read an absent diagnosis as NONE.
 */
export function mergeReviewGate(lookup: CommentLookup, head: string): MergeGateVerdict {
	if (!lookup.ok) {
		return {
			pass: false,
			reason: "lookup-failed",
			detail: `the review record for ${head} could not be looked up (${lookup.cause}) — an unreadable platform is not an approval (§3.7(c))`,
		};
	}

	const atHead = lookup.bodies.filter((body) => opensRecordFor(body, head));
	if (atHead.length === 0) {
		return {
			pass: false,
			reason: "no-record-at-head",
			detail:
				`no review record opens its own comment pinned to ${head} — a record relayed inside another artifact ` +
				"does not satisfy this gate (§3.7(e)), and an absent one is not an approval",
		};
	}

	// Last-record-wins at one head, the collapse §1.4 already uses: a
	// re-issued record (§1.9's nit carry-forward) supersedes the one it
	// re-issues, and both are legitimately present.
	const body = atHead[atHead.length - 1] as string;
	const record = parseReviewRecord(body);
	if (record === undefined) {
		return {
			pass: false,
			reason: "record-unreadable",
			detail: `a record comment pinned to ${head} did not parse as a review record — a malformed record is not an approval`,
		};
	}

	if (record.review.state === "incomplete") {
		return {
			pass: false,
			reason: "panel-incomplete",
			detail: `the review at ${head} is incomplete (${authored(record.review.cause)}) — an incomplete review is not an approval (§1.7)`,
		};
	}

	// The row's own qualifier: adjudication is owed "where the bundle was
	// non-empty". The findings-free path — a complete panel with an empty
	// bundle — ends review for that head and needs no Judge, so requiring
	// one there would block the very path §1.7 makes terminal.
	if (record.bundle.length > 0 && record.adjudication === null) {
		return {
			pass: false,
			reason: "adjudication-missing",
			detail:
				`the review at ${head} carries ${record.bundle.length} finding(s) and no Judge adjudication — ` +
				"a bundle the author acted on unadjudicated is what §1.9 forbids",
		};
	}

	return { pass: true, record };
}

/**
 * §1.9's nit carry-forward, mechanized (issue #184, Directive #183).
 * The clause's named exception admits a re-issued evidence artifact
 * only where the Resolver's outcome was `clear` and the only change
 * since the panel ran is the verbatim application of the Judge's exact
 * mechanical remedies — "a carry-forward whose delta exceeds its
 * finding draws fresh review". This module is that check, and it is
 * deliberately CONSERVATIVE and fail-closed: it admits only what it
 * can mechanically account for against the ruling text, and everything
 * else refuses to fresh review — the ordinary, always-available cost.
 *
 * DECISION — the accounting unit is the patch's changed line. A NIT
 * remedy §1.9 admits is "a verbatim replacement or a mechanical
 * derivation fully specified by the ruling itself", so a conforming
 * remedy's text CONTAINS the bytes it adds and the bytes it removes;
 * a changed line the concatenated remedy text does not contain is a
 * delta the ruling never specified. The check is sound in the refusing
 * direction and incomplete in the admitting one (a remedy phrased as a
 * derivation rather than a replacement refuses even when honest) —
 * incompleteness here costs one fresh review, never an unreviewed
 * change. Rejected alternatives are on the Execution issue: semantic
 * delta comparison is a second adjudicator; no check leaves the
 * clause's detection surface procedural.
 */
import type { ReviewRecord } from "./record.ts";

export type CarryForwardVerdict = { admissible: true } | { admissible: false; reasons: string[] };

/**
 * Is the post-fix state admissible as §1.9's carry-forward? `patch` is
 * the unified diff between the recorded head and the post-fix state.
 * Every conjunct refuses with its own reason; an empty reason list is
 * exactly the admissible case.
 */
export function carryForwardAdmissible(record: ReviewRecord, patch: string): CarryForwardVerdict {
	const reasons: string[] = [];
	if (record.review.state !== "resolved" || record.review.resolution.outcome !== "clear") {
		reasons.push("the recorded outcome is not clear — the exception is the clear outcome's alone");
	}
	if (record.adjudication === null) {
		reasons.push("the record carries no adjudication — there is no ruling text to check the delta against");
	}
	const changed = patch
		.split("\n")
		.filter(
			(line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"),
		)
		.map((line) => line.slice(1));
	if (changed.length === 0) {
		reasons.push(
			"the delta is empty — the head did not advance, so the original review stands and the exception has no subject",
		);
	}
	const remedyText = (record.adjudication?.rulings ?? [])
		.filter((ruling) => ruling.severity === "NIT" && typeof ruling.remedy === "string")
		.map((ruling) => ruling.remedy as string)
		.join("\n");
	if (remedyText.length === 0 && changed.length > 0) {
		reasons.push("no NIT remedy is recorded — a non-empty delta has nothing that specified it");
	}
	for (const line of changed) {
		// Whitespace-trimmed containment: a remedy quotes the span it
		// replaces; surrounding indentation is the file's, not the ruling's.
		const span = line.trim();
		if (span.length > 0 && !remedyText.includes(span)) {
			reasons.push("a changed line is not specified by any recorded remedy — the delta exceeds its finding");
			break;
		}
	}
	return reasons.length === 0 ? { admissible: true } : { admissible: false, reasons };
}

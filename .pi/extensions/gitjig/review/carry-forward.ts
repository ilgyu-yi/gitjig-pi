/**
 * §1.9's nit carry-forward, mechanized (issue #184, Directive #183).
 * The clause's named exception admits a re-issued evidence artifact
 * only where the Resolver's outcome was `clear` and the only change
 * since the panel ran is the verbatim application of the Judge's exact
 * mechanical remedies — "a carry-forward whose delta exceeds its
 * finding draws fresh review". This module is that check, and it is
 * deliberately CONSERVATIVE and fail-closed: everything it cannot
 * mechanically account for against the ruling text refuses to fresh
 * review — the ordinary, always-available cost.
 *
 * DECISION — the accounting is EXACT MULTISET EQUALITY, not
 * containment. Round 2 adjudicated the containment premise unsound in
 * two ways one guard cannot both fix: it carried no cardinality (one
 * ruled span admitted N copies of the applied line) and no per-ruling
 * binding (spans pooled across rulings admitted a hybrid that was
 * neither remedy). The sound predicate is that the patch's removed
 * lines, as a multiset, EQUAL the union of every applied remedy's
 * removed spans, and likewise for added lines — a carry-forward
 * applies ALL the Judge's NIT remedies and nothing else, so the whole
 * delta is exactly their union. Equality closes both: an extra copy
 * unbalances the multiset, and a hybrid's removed/added multisets
 * match no remedy union.
 *
 * DECISION — a remedy is parsed only in a CANONICAL, WHOLE-STRING
 * form. Round 2 adjudicated the prose-scanning delete form as
 * promoting a span out of a NEGATED clause ("do not remove `baz`").
 * A remedy is recognized only when its trimmed text matches one
 * canonical shape end to end — "replace `old` with `new`" or
 * "delete `old`" (with the optional "the line" the panel writes) —
 * so a compound or negated remedy matches nothing, is unparseable,
 * and refuses. §1.9 licenses this: a NIT remedy is "a verbatim
 * replacement fully specified by the ruling itself", and a canonical
 * form is exactly that specification. A remedy outside the grammar
 * costs one fresh review, never an unreviewed change.
 *
 * Enumerated residual (§3.11): a span carries no file binding — the
 * ruling's free text names no path this check can trust — so a delta
 * applying the ruled multiset in a DIFFERENT file than the flagged
 * one still admits. What bounds it: the admitted lines are still
 * exactly the multiset the Judge ruled, nothing more and nothing
 * fewer.
 */
import type { ReviewRecord } from "./record.ts";

export type CarryForwardVerdict = { admissible: true } | { admissible: false; reasons: string[] };

type RemedySpans = { removed: string[]; added: string[] };

const REPLACE_FORM = /^replace(?: the line)? `([^`]+)` with `([^`]+)`\.?$/i;
const DELETE_FORM = /^(?:delete|remove)(?: the line)? `([^`]+)`\.?$/i;

/**
 * Parse one remedy's canonical whole-string form; undefined = not in
 * the grammar, which refuses the whole carry-forward.
 */
function spansFromRemedy(remedy: string): RemedySpans | undefined {
	const trimmed = remedy.trim();
	const replace = REPLACE_FORM.exec(trimmed);
	if (replace !== null) {
		return { removed: [replace[1]], added: [replace[2]] };
	}
	const del = DELETE_FORM.exec(trimmed);
	if (del !== null) {
		return { removed: [del[1]], added: [] };
	}
	return undefined;
}

/** A trimmed-line multiset, as a count map. */
function multiset(lines: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of lines) {
		counts.set(line, (counts.get(line) ?? 0) + 1);
	}
	return counts;
}

function multisetsEqual(a: Map<string, number>, b: Map<string, number>): boolean {
	if (a.size !== b.size) {
		return false;
	}
	for (const [key, count] of a) {
		if (b.get(key) !== count) {
			return false;
		}
	}
	return true;
}

type ChangedLine = { direction: "removed" | "added"; text: string };

/**
 * The hunk-aware walk: only lines INSIDE a hunk count as delta, so a
 * file header ("--- a/x", "+++ b/x") is never confused with a content
 * line that happens to begin with "--" or "++".
 */
function changedLines(patch: string): ChangedLine[] {
	const changed: ChangedLine[] = [];
	let inHunk = false;
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git") || line.startsWith("index ")) {
			inHunk = false;
			continue;
		}
		if (line.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		if (!inHunk) {
			continue;
		}
		if (line.startsWith("\\")) {
			continue; // "\ No newline at end of file"
		}
		if (line.startsWith("+")) {
			changed.push({ direction: "added", text: line.slice(1) });
		} else if (line.startsWith("-")) {
			changed.push({ direction: "removed", text: line.slice(1) });
		}
	}
	return changed;
}

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
	const changed = changedLines(patch);
	if (changed.length === 0) {
		reasons.push(
			"the delta is empty — the head did not advance, so the original review stands and the exception has no subject",
		);
	}
	// Only a NIT ruling carries §1.9's exact mechanical remedy; a
	// SUBSTANTIVE ruling's text specifies nothing a delta may apply. A
	// whitespace-only ruled span is dropped: an empty line cannot be a
	// verbatim mechanical replacement, and admitting it would let blank
	// churn balance the multiset.
	const remedyRemoved: string[] = [];
	const remedyAdded: string[] = [];
	let unparseable = false;
	for (const ruling of record.adjudication?.rulings ?? []) {
		if (ruling.severity !== "NIT" || typeof ruling.remedy !== "string") {
			continue;
		}
		const parsed = spansFromRemedy(ruling.remedy);
		if (
			parsed === undefined ||
			parsed.removed.some((s) => s.trim().length === 0) ||
			parsed.added.some((s) => s.trim().length === 0)
		) {
			unparseable = true;
			continue;
		}
		remedyRemoved.push(...parsed.removed.map((s) => s.trim()));
		remedyAdded.push(...parsed.added.map((s) => s.trim()));
	}
	if (unparseable) {
		reasons.push(
			"a recorded NIT remedy is not in the canonical grammar — an uncheckable remedy draws fresh review rather than admitting a delta the check cannot verify",
		);
	}
	// Exact multiset equality: the whole delta is the union of every
	// applied remedy, no more and no fewer.
	if (reasons.length === 0) {
		const patchRemoved = multiset(changed.filter((l) => l.direction === "removed").map((l) => l.text.trim()));
		const patchAdded = multiset(changed.filter((l) => l.direction === "added").map((l) => l.text.trim()));
		if (!multisetsEqual(patchRemoved, multiset(remedyRemoved)) || !multisetsEqual(patchAdded, multiset(remedyAdded))) {
			reasons.push(
				"the delta's changed lines are not exactly the multiset the recorded NIT remedies specify — the delta exceeds its finding",
			);
		}
	}
	return reasons.length === 0 ? { admissible: true } : { admissible: false, reasons };
}

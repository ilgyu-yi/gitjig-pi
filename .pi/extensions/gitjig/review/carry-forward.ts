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
 * DECISION — the accounting unit is the OPERATION, a (removed, added)
 * pair, not two independent multisets. Round 2's multiset-of-lines
 * premise carried cardinality but not per-ruling PAIRING: a swapped
 * cross-ruling hybrid (-AAA/+DDD/-CCC/+BBB against replace AAA→BBB and
 * CCC→DDD) balanced a removed-multiset {AAA,CCC} and an added-multiset
 * {BBB,DDD} and admitted a delta that was neither remedy. Pairing each
 * removed line to the added line that replaced it, per hunk, and
 * comparing the OPERATION multiset to the remedy operation multiset,
 * closes the swap by construction: (AAA→DDD),(CCC→BBB) is not
 * (AAA→BBB),(CCC→DDD).
 *
 * DECISION — NO trimming, and the remedy quotes the FULL line. Round 2
 * trimmed both sides, so a re-indentation (a real change on the YAML
 * and Markdown surfaces the shell ships) applied as a "verbatim"
 * replacement. The operation compares exact line text, and the Judge
 * brief (briefs.ts) states that a NIT remedy carry-forward can apply
 * must quote the full line verbatim, leading whitespace included —
 * which is what makes the exception LIVE rather than dead: the
 * producer of the remedy is told the grammar its consumer parses.
 *
 * DECISION — a NIT ruling that carries no parseable full-line remedy
 * REFUSES the whole carry-forward, uniformly, whether the remedy is
 * missing, whitespace, or out of the canonical grammar. §1.9 rules a
 * NIT with no exact mechanical remedy an incomplete adjudication, so a
 * record carrying one is not a clean re-issue however its other
 * rulings read.
 *
 * Enumerated residual (§3.11): an operation carries no file binding —
 * the ruling's free text names no path this check can trust — so a
 * delta applying the ruled operations in a DIFFERENT file than the
 * flagged one still admits. What bounds it: the admitted operations
 * are still exactly the ones the Judge ruled, paired, nothing more.
 */
import type { ReviewRecord } from "./record.ts";

export type CarryForwardVerdict = { admissible: true } | { admissible: false; reasons: string[] };

/** A remedy's spans: the line it removes, and the line it adds (null = a deletion). */
type RemedySpans = { removed: string; added: string | null };

const REPLACE_FORM = /^replace(?: the line)? `([^`]+)` with `([^`]+)`\.?$/i;
const DELETE_FORM = /^(?:delete|remove)(?: the line)? `([^`]+)`\.?$/i;

/** Parse one remedy's canonical whole-string form; undefined = not checkable. */
function spansFromRemedy(remedy: string): RemedySpans | undefined {
	const trimmed = remedy.trim();
	const replace = REPLACE_FORM.exec(trimmed);
	if (replace !== null) {
		return { removed: replace[1], added: replace[2] };
	}
	const del = DELETE_FORM.exec(trimmed);
	if (del !== null) {
		return { removed: del[1], added: null };
	}
	return undefined;
}

/**
 * The patch's changed lines, split by direction, hunk-aware: a file
 * header ("--- a/x" / "+++ b/x") is not a content line, and a context
 * line is neither removed nor added. No pairing is attempted — a
 * unified diff does not encode it (see the header's DECISION).
 */
function changedLines(patch: string): { removed: string[]; added: string[] } {
	const removed: string[] = [];
	const added: string[] = [];
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
		if (!inHunk || line.startsWith("\\")) {
			continue;
		}
		if (line.startsWith("+")) {
			added.push(line.slice(1));
		} else if (line.startsWith("-")) {
			removed.push(line.slice(1));
		}
	}
	return { removed, added };
}

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
	for (const [k, count] of a) {
		if (b.get(k) !== count) {
			return false;
		}
	}
	return true;
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
	if (changed.removed.length === 0 && changed.added.length === 0) {
		reasons.push(
			"the delta is empty — the head did not advance, so the original review stands and the exception has no subject",
		);
	}
	// Every ruling that is not a refutation must be a NIT carrying a
	// parseable full-line remedy; anything else — a SUBSTANTIVE ruling, a
	// bare NIT, an out-of-grammar or whitespace remedy — makes the record
	// something other than a clean nit-only re-issue and refuses (§1.9).
	const remedyRemoved: string[] = [];
	const remedyAdded: string[] = [];
	for (const ruling of record.adjudication?.rulings ?? []) {
		if (ruling.validity === "REFUTED") {
			continue; // a refutation leaves nothing behind (§1.9); it is no part of the delta
		}
		if (ruling.severity !== "NIT") {
			reasons.push(
				"a ruling is not a NIT — a substantive or unresolved finding is not carried forward, it draws fresh review",
			);
			break;
		}
		const spans = typeof ruling.remedy === "string" ? spansFromRemedy(ruling.remedy) : undefined;
		if (
			spans === undefined ||
			spans.removed.trim().length === 0 ||
			(spans.added !== null && spans.added.trim().length === 0)
		) {
			reasons.push(
				"a NIT ruling carries no parseable full-line remedy — a missing, whitespace, or out-of-grammar remedy is an incomplete adjudication and draws fresh review",
			);
			break;
		}
		remedyRemoved.push(spans.removed);
		if (spans.added !== null) {
			remedyAdded.push(spans.added);
		}
	}
	if (
		reasons.length === 0 &&
		(!multisetsEqual(multiset(changed.removed), multiset(remedyRemoved)) ||
			!multisetsEqual(multiset(changed.added), multiset(remedyAdded)))
	) {
		reasons.push(
			"the delta's removed and added lines are not exactly the recorded NIT remedies' old and new lines — the delta exceeds its finding",
		);
	}
	return reasons.length === 0 ? { admissible: true } : { admissible: false, reasons };
}

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

/** One replacement: a removed line, and the line that replaced it (null = a deletion). */
type Operation = { removed: string; added: string | null };

const REPLACE_FORM = /^replace(?: the line)? `([^`]+)` with `([^`]+)`\.?$/i;
const DELETE_FORM = /^(?:delete|remove)(?: the line)? `([^`]+)`\.?$/i;

/** Parse one remedy's canonical whole-string form into an operation; undefined = not checkable. */
function operationFromRemedy(remedy: string): Operation | undefined {
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
 * Decompose the patch into operations, hunk by hunk: within a hunk git
 * emits removed lines then added lines, so the i-th removed line is
 * paired with the i-th added line; a leftover removed line is a
 * deletion (added null), and a leftover ADDED line with no removed
 * partner is an insertion, represented with removed "" so it can match
 * no replace/delete operation and forces a refusal (an insertion is
 * never a verbatim application of a replacement).
 */
function operationsFromPatch(patch: string): Operation[] {
	const operations: Operation[] = [];
	let removed: string[] = [];
	let added: string[] = [];
	let inHunk = false;
	const flush = () => {
		const span = Math.max(removed.length, added.length);
		for (let i = 0; i < span; i += 1) {
			operations.push({ removed: removed[i] ?? "", added: i < added.length ? added[i] : null });
		}
		removed = [];
		added = [];
	};
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git") || line.startsWith("index ")) {
			flush();
			inHunk = false;
			continue;
		}
		if (line.startsWith("@@")) {
			flush();
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
	flush();
	return operations;
}

/** A stable key for an operation, so two operation lists compare as multisets. */
function key(op: Operation): string {
	return JSON.stringify([op.removed, op.added]);
}

function sameMultiset(a: Operation[], b: Operation[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	const counts = new Map<string, number>();
	for (const op of a) {
		counts.set(key(op), (counts.get(key(op)) ?? 0) + 1);
	}
	for (const op of b) {
		const k = key(op);
		const count = counts.get(k);
		if (count === undefined) {
			return false;
		}
		counts.set(k, count - 1);
		if (count - 1 === 0) {
			counts.delete(k);
		}
	}
	return counts.size === 0;
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
	const patchOps = operationsFromPatch(patch);
	if (patchOps.length === 0) {
		reasons.push(
			"the delta is empty — the head did not advance, so the original review stands and the exception has no subject",
		);
	}
	// Every ruling that is not a refutation must be a NIT carrying a
	// parseable full-line remedy; anything else — a SUBSTANTIVE ruling, a
	// bare NIT, an out-of-grammar or whitespace remedy — makes the record
	// something other than a clean nit-only re-issue and refuses (§1.9).
	const remedyOps: Operation[] = [];
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
		const op = typeof ruling.remedy === "string" ? operationFromRemedy(ruling.remedy) : undefined;
		if (op === undefined || op.removed.trim().length === 0 || (op.added !== null && op.added.trim().length === 0)) {
			reasons.push(
				"a NIT ruling carries no parseable full-line remedy — a missing, whitespace, or out-of-grammar remedy is an incomplete adjudication and draws fresh review",
			);
			break;
		}
		remedyOps.push(op);
	}
	if (reasons.length === 0 && !sameMultiset(patchOps, remedyOps)) {
		reasons.push(
			"the delta's operations are not exactly the recorded NIT remedies, paired removed-to-added — the delta exceeds its finding",
		);
	}
	return reasons.length === 0 ? { admissible: true } : { admissible: false, reasons };
}

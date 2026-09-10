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
 * DECISION — a remedy is mechanically checkable only in a RECOGNIZED
 * GRAMMAR, and the grammar is directional (round 1 adjudicated the
 * undirected substring check as admitting the REVERSE application and
 * substrings of the remedy's own prose). Recognized forms, spans in
 * backticks: "replace … `old` … with … `new`" (old is removable, new
 * addable) and "delete/remove … `old`" (old removable). A remedy that
 * parses to no span refuses — a derivation-phrased remedy costs one
 * fresh review, never an unreviewed change.
 *
 * DECISION — the accounting unit is the hunk's changed line, parsed by
 * a hunk-aware walk (round 1 adjudicated the prefix test as dropping a
 * content line that itself begins with "++"). A changed line is
 * accounted only when its trimmed text is CONTAINED IN a span of the
 * matching direction — the remedy quotes what it replaces, so a line
 * the ruling fully specified is inside a ruled span; an in-line
 * partial replacement therefore refuses, taken deliberately as the
 * conservative cost. A whitespace-only changed line refuses: an empty
 * span is a substring of everything, so nothing can specify it.
 *
 * Enumerated residual (§3.11): a span carries no file binding — the
 * ruling's free text names no path this check can trust — so a delta
 * applying an identical ruled span in a DIFFERENT file than the
 * flagged one still admits. What bounds it: the admitted line is still
 * exactly text the Judge ruled, nothing else.
 */
import type { ReviewRecord } from "./record.ts";

export type CarryForwardVerdict = { admissible: true } | { admissible: false; reasons: string[] };

type RemedySpans = { removable: string[]; addable: string[] };

/** Parse the recognized remedy grammar; undefined = not checkable. */
function spansFromRemedy(remedy: string): RemedySpans | undefined {
	const removable: string[] = [];
	const addable: string[] = [];
	const replaceForm = /replace[^`]*`([^`]+)`[^`]*?with[^`]*?`([^`]+)`/gi;
	for (let match = replaceForm.exec(remedy); match !== null; match = replaceForm.exec(remedy)) {
		removable.push(match[1]);
		addable.push(match[2]);
	}
	const deleteForm = /(?:delete|remove)[^`]*?`([^`]+)`/gi;
	for (let match = deleteForm.exec(remedy); match !== null; match = deleteForm.exec(remedy)) {
		removable.push(match[1]);
	}
	if (removable.length === 0 && addable.length === 0) {
		return undefined;
	}
	return { removable, addable };
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
	// SUBSTANTIVE ruling's text specifies nothing a delta may apply.
	const spans: RemedySpans = { removable: [], addable: [] };
	let unparseable = false;
	for (const ruling of record.adjudication?.rulings ?? []) {
		if (ruling.severity !== "NIT" || typeof ruling.remedy !== "string") {
			continue;
		}
		const parsed = spansFromRemedy(ruling.remedy);
		if (parsed === undefined) {
			unparseable = true;
			continue;
		}
		spans.removable.push(...parsed.removable);
		spans.addable.push(...parsed.addable);
	}
	if (spans.removable.length === 0 && spans.addable.length === 0 && changed.length > 0) {
		reasons.push(
			unparseable
				? "a recorded remedy parses to no span in the recognized grammar — an uncheckable remedy draws fresh review"
				: "no NIT remedy is recorded — a non-empty delta has nothing that specified it",
		);
	}
	for (const line of changed) {
		const span = line.text.trim();
		if (span.length === 0) {
			reasons.push(
				"a whitespace-only changed line cannot be specified by any remedy — an empty span is a substring of everything",
			);
			break;
		}
		const corpus = line.direction === "removed" ? spans.removable : spans.addable;
		if (!corpus.some((ruled) => ruled.includes(span))) {
			reasons.push("a changed line is not specified by any recorded remedy — the delta exceeds its finding");
			break;
		}
	}
	return reasons.length === 0 ? { admissible: true } : { admissible: false, reasons };
}

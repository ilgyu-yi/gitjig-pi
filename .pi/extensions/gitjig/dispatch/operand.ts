/* The single ruled held-operand scan, owned here so that every consumer of the
 * rule imports this one predicate rather than restating it (SPEC §3.11).
 * `dispatch/index.ts` re-exports both names for its existing consumers.
 *
 * Warning-surface roster: EXEMPT — this module returns one boolean and composes
 * no text at all, so no warning or operator-facing string can originate here.
 */

/**
 * The shortest run the CONTAINMENT branch will act on (issue #104). Below
 * this length a match is overwhelmingly a coincidence rather than a
 * disclosure: a 40-character hash offers 37 overlapping 4-character
 * windows, so an unrelated 4-character run collides at roughly 37/16^4.
 * Measured against this predicate over a seeded corpus of 200,000 trials:
 * 92 refusals at the old bound of 4, zero at 6, with every one of those 92
 * a whole verdict discarded for a coincidence — terminal, on a fixed cause,
 * with nothing the delegate could have done differently.
 *
 * The bound costs the containment branch genuine 4- and 5-character
 * slices, and that is the trade taken deliberately (§3.6's false-block
 * cost, named where the gate is stated). What it costs in DETECTION is
 * bounded but not nil, and the boundary is git's own abbreviation floor:
 * `core.abbrev` defaults to `auto`, which never abbreviates below 7, so
 * an ordinary accidental spelling — the head written whole, or through a
 * default `--short` — still contains the held 7-prefix and is caught by
 * the PREFIX branch regardless of this bound, and 6 stays inside
 * containment. But git's MINIMUM abbreviation is 4, not 7: a clone
 * configured `core.abbrev=4` or `=5`, or a delegate running
 * `git rev-parse --short=4`, produces a genuine 4- or 5-character
 * spelling of the head that satisfies neither branch now and did satisfy
 * containment before. That is the enumerated cost of this bound (§3.11),
 * and it is a configured-abbreviation case rather than the stock one.
 *
 * What crosses in that case is a RESOLVABLE NAME, not a harmless
 * remainder, and the residual is stated that way rather than minimized:
 * git emits a short spelling only where it is unambiguous in the
 * repository it came from — it lengthens the output instead of printing an
 * ambiguous one — so such a token expands straight back to the held
 * operand through `rev-parse` for whoever holds that repository. Measured
 * in this repository: 39 of the last 40 heads abbreviate to 4 characters,
 * one lengthens to 5 — git's uniqueness expansion, visible — and the
 * 4-character token round-trips to the full hash. No commit count is given
 * here on purpose: it would be stale by the next commit, and this one was,
 * while the ratio beside it re-derives at any head. So this is §1.6's echo
 * exposure narrowed, never eliminated.
 *
 * The trade rests on what it actually rests on: the coincidence it
 * replaces was measured and terminal, while the disclosure it admits needs
 * both a shortened `core.abbrev` and possession of the repository to
 * resolve. A deliberate leaker was never bounded here at all — runs of 3
 * are below the match width entirely and ride §4.9's injectable-context
 * residual. So the bound narrows accident detection to git's stock
 * abbreviation range and leaves the adversary's reach where it was.
 */
export const MIN_CONTAINED_RUN = 6;

/**
 * The single ruled scan contract: hex runs in `text` match
 * `/[0-9a-fA-F]{4,}/g`, each run is lowercased, and a run names the held
 * operand iff the held hash contains the run AND the run is at least
 * `MIN_CONTAINED_RUN` long, OR the run contains the held 7-prefix at any
 * length. Anything else — unrelated hashes, UUID fragments, a short run
 * that merely collides — is left alone: the scan pins the held operand,
 * not hex at large (an over-blocking scan makes every hash-adjacent
 * summary undeliverable, and a refusal here discards the whole return).
 */
export function namesHeldOperand(text: string, heldHash: string): boolean {
	const runs = text.match(/[0-9a-fA-F]{4,}/g) ?? [];
	const prefix = heldHash.slice(0, 7);
	return runs.some((run) => {
		const lowered = run.toLowerCase();
		return (lowered.length >= MIN_CONTAINED_RUN && heldHash.includes(lowered)) || lowered.includes(prefix);
	});
}

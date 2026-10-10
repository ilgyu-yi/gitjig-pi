/**
 * Structural settlement evidence for issue #236. Runtime projection and
 * composition remain issue #238's scope; this suite pins only the landed
 * contract, its bounded transition, and the non-executable source pointer.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const ROOT = repoRoot();
const SPEC = readFileSync(join(ROOT, "SPEC.md"), "utf8");
const HISTORY_SOURCE = readFileSync(join(ROOT, ".pi/extensions/gitjig/review/history.ts"), "utf8");
const CALLER_SOURCE = readFileSync(join(ROOT, ".pi/extensions/gitjig/commands/review-round.ts"), "utf8");

function section(source: string, start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	assert.ok(from >= 0 && to > from, `missing bounded section ${start}`);
	return source.slice(from, to);
}

const CROSS_REVIEW = section(SPEC, "### 1.4 Cross-review repair", "### 1.5 Delegated work");
const JUDGE = section(SPEC, "### 1.9 Finding judgment", "## 2. Artifact hierarchy and lifecycle");

function settlementHolds(crossReview: string, judge: string): boolean {
	return (
		crossReview.includes("repair history** of one change is the complete durable record") &&
		crossReview.includes(
			"every review state, effective finding, ruling, disposition, governed carry-forward fact, and correction between states remains retained whether or not diagnosis may consume it",
		) &&
		crossReview.includes("**repair-basis projection**") &&
		crossReview.includes(
			"exactly the current trailing consecutive run of review states whose Resolver outcome is `repair`",
		) &&
		crossReview.includes("beginning after the latest non-`repair` reset and never reconnecting states across one") &&
		crossReview.includes(
			"only effective findings whose joined ruling is `CONFIRMED`, severity is `SUBSTANTIVE`, and deterministic disposition is `repair`",
		) &&
		crossReview.includes("N projected states carry exactly N−1 complete author-authored correction intervals") &&
		crossReview.includes("between adjacent states in that run, oldest first") &&
		crossReview.includes("exact unique reviewed-head endpoints of one state and the immediately following state") &&
		crossReview.includes("terminal state remains intentionally unmatched") &&
		crossReview.includes(
			"the marker stays in the trailing run until an honored limb-(b) terminal starts a new one, so every diagnosis of that run interrupts",
		) &&
		crossReview.includes(
			"under `autonomous` the first such stop claims the lineage's single recovery allowance, whose only return to ordinary flow — a fresh NONE — a run containing a marker cannot reach, so the allowance is spent and the change hands off as limb (b)",
		) &&
		crossReview.includes("NONE needs every correction in the run, so a run containing a marker is never NONE") &&
		crossReview.includes(
			"it is STAGNATION or OSCILLATION only where those states and linear intervals establish that value, and INDETERMINATE otherwise",
		) &&
		crossReview.includes(
			"A pair is *linear* when it is ancestral and no commit in its range, reachable from the later head but not from the earlier head, has more than one parent",
		) &&
		crossReview.includes(
			"because a rewrite leaves no tree delta between the heads that is the author's alone and a merge can carry the base's changes into one",
		) &&
		crossReview.includes("and counts among the N−1 intervals") &&
		crossReview.includes("and computes a tree delta for an ancestral one") &&
		crossReview.includes(
			"a walk that reaches the earlier head decides the pair ancestral, a walk that completes without reaching it decides the pair non-ancestral, and a walk that does not complete withholds the projection and never decides either",
		) &&
		crossReview.includes(
			"a correction across a rewrite or a merge, such as a rebase onto an advancing base, is not measured",
		) &&
		crossReview.includes(
			"a value whose required evidence lies in the unmeasured correction is INDETERMINATE, and other values may be ruled only from the run's states, a marker's endpoint states included, and its linear intervals",
		) &&
		crossReview.includes(
			"Because INDETERMINATE over-stops, a rewrite or a merge in a pair's range can cost an over-stop after a diagnosis has run, never an under-stop",
		) &&
		crossReview.includes(
			"This interval definition activates only with its implementing derivation, never from a contract-only PR alone (§5.3)",
		) &&
		crossReview.includes("Each interval is decided by an ancestry walk from its later head") &&
		crossReview.includes("a walk that reaches the earlier head decides the pair ancestral") &&
		crossReview.includes("a walk that completes without reaching it decides the pair non-ancestral") &&
		crossReview.includes("a walk that does not complete withholds the projection and never decides either") &&
		crossReview.includes("A linear pair's interval is the tree delta between the two heads") &&
		crossReview.includes(
			"Every other pair's interval — a non-ancestral pair, or an ancestral pair whose range contains a merge commit — is a **rewrite marker** that names the two heads and carries no delta",
		) &&
		crossReview.includes("A rewrite marker is a complete interval, not missing delta data") &&
		crossReview.includes("The marker is evidence for no value: it cannot support NONE, STAGNATION or OSCILLATION") &&
		crossReview.includes("a value whose required evidence lies in the unmeasured correction is INDETERMINATE") &&
		crossReview.includes(
			"other values may be ruled only from the run's states, a marker's endpoint states included, and its linear intervals",
		) &&
		crossReview.includes(
			"a rewrite or a merge in a pair's range can cost an over-stop after a diagnosis has run, never an under-stop",
		) &&
		crossReview.includes("This interval definition activates only with its implementing derivation") &&
		crossReview.includes("until then the installed reader withholds the projection for a non-ancestral pair") &&
		crossReview.includes("— of which a rewrite marker is none —") &&
		crossReview.includes("Several included findings in one state share that whole interval") &&
		crossReview.includes("caller never slices edits or attributes an edit to a finding") &&
		crossReview.includes("NIT/remedy, refuted/`none`, `defer`, `measure-escalate`, and Nit carry-forward") &&
		crossReview.includes("Missing, duplicate, reordered, noncontiguous, cardinality-misaligned, or ambiguous") &&
		crossReview.includes("withholds diagnosis rather than narrowing or guessing") &&
		crossReview.includes("supplies the repair-basis projection") &&
		judge.includes("reads that section's repair-basis projection") &&
		judge.includes("neither an author repair method nor a side of OSCILLATION")
	);
}

describe("issue #236 repair-basis settlement", () => {
	it("separates complete retention from the exact fail-closed diagnosis projection", () => {
		assert.equal(settlementHolds(CROSS_REVIEW, JUDGE), true);
	});

	it("kills one meaning-changing mutant for every projection component", () => {
		const mutants = [
			[CROSS_REVIEW.replace("complete durable record", "diagnosis operand"), JUDGE],
			[CROSS_REVIEW.replace("every review state", "every repair review state"), JUDGE],
			[CROSS_REVIEW.replace("current trailing consecutive run", "all ordered repair states"), JUDGE],
			[CROSS_REVIEW.replace("never reconnecting states across one", "omitting reset states"), JUDGE],
			[
				CROSS_REVIEW.replace(
					"`CONFIRMED`, severity is `SUBSTANTIVE`, and deterministic disposition is `repair`",
					"`CONFIRMED`",
				),
				JUDGE,
			],
			[CROSS_REVIEW.replace("N−1", "N"), JUDGE],
			[CROSS_REVIEW.replace("between adjacent states in that run, oldest first", "in any order"), JUDGE],
			[
				CROSS_REVIEW.replace(
					"exact unique reviewed-head endpoints of one state and the immediately following state",
					"available endpoints",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"terminal state remains intentionally unmatched",
					"terminal state receives an empty interval",
				),
				JUDGE,
			],
			[CROSS_REVIEW.replace("share that whole interval", "receive per-finding slices"), JUDGE],
			[CROSS_REVIEW.replace("a marker's endpoint states included", "a marker's endpoint states excluded"), JUDGE],
			[
				CROSS_REVIEW.replace(
					"those states and linear intervals establish that value",
					"linear intervals alone establish that value",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"the marker stays in the trailing run until an honored limb-(b) terminal starts a new one",
					"the marker leaves the trailing run at the next round",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"so every diagnosis of that run interrupts",
					"so only the first diagnosis of that run interrupts",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"the first such stop claims the lineage's single recovery allowance",
					"the first such stop claims no recovery allowance",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"a run containing a marker cannot reach, so the allowance is spent",
					"a run containing a marker can reach, so the allowance is spent",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"so the allowance is spent and the change hands off as limb (b)",
					"so the allowance is kept and the change continues",
				),
				JUDGE,
			],
			[CROSS_REVIEW.replace("a rewrite or a merge in a pair's range can cost", "a rewrite can cost"), JUDGE],
			[CROSS_REVIEW.replace("NONE needs every correction in the run", "NONE needs the corrections it can see"), JUDGE],
			[CROSS_REVIEW.replace("a run containing a marker is never NONE", "a run containing a marker may be NONE"), JUDGE],
			[
				CROSS_REVIEW.replace(
					"only where those states and linear intervals establish that value",
					"where any interval suggests that value",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"establish that value, and INDETERMINATE otherwise",
					"establish that value, and NONE otherwise",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"a rewrite leaves no tree delta between the heads that is the author's alone",
					"a rewrite leaves the author's tree delta intact",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"when it is ancestral and no commit in its range",
					"when it is ancestral or no commit in its range",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"reachable from the later head but not from the earlier head, has more",
					"reachable from the later head, has more",
				),
				JUDGE,
			],
			[CROSS_REVIEW.replace("has more than one parent", "has more than two parents"), JUDGE],
			[
				CROSS_REVIEW.replace(
					"a non-ancestral pair, or an ancestral pair whose range contains a merge commit —",
					"a non-ancestral pair —",
				),
				JUDGE,
			],
			[CROSS_REVIEW.replace("a correction across a rewrite or a merge,", "a correction across a rewrite,"), JUDGE],
			[
				CROSS_REVIEW.replace(
					"because a rewrite leaves no tree delta between the heads that is the author's alone and a merge can carry the base's changes into one",
					"because a merge carries only the author's changes",
				),
				JUDGE,
			],
			[CROSS_REVIEW.replace("and counts among the N−1 intervals", "and counts among no intervals"), JUDGE],
			[
				CROSS_REVIEW.replace(
					"and computes a tree delta for an ancestral one",
					"and computes a rewrite marker for an ancestral one",
				),
				JUDGE,
			],
			[CROSS_REVIEW.replace("and its linear intervals", "and its ancestral intervals"), JUDGE],
			[
				CROSS_REVIEW.replace(
					"never from a contract-only PR alone (§5.3); until then the installed reader",
					"or from a contract-only PR (§5.3); until then the installed reader",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"such as a rebase onto an advancing base, is not measured",
					"such as a rebase onto an advancing base, is measured",
				),
				JUDGE,
			],
			[CROSS_REVIEW.replace("Because INDETERMINATE over-stops", "Although INDETERMINATE may continue"), JUDGE],
			[CROSS_REVIEW.replace("an ancestry walk from its later head", "an ancestry walk from its earlier head"), JUDGE],
			[
				CROSS_REVIEW.replace(
					"Each interval is decided by an ancestry walk",
					"Each interval is assumed ancestral, or decided by an ancestry walk",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"a walk that reaches the earlier head decides the pair ancestral",
					"a walk decides the pair ancestral",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"a walk that completes without reaching it decides the pair non-ancestral",
					"a walk that fails decides the pair non-ancestral",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"a walk that does not complete withholds the projection and never decides either",
					"a walk that does not complete decides the pair non-ancestral",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"A linear pair's interval is the tree delta between the two heads",
					"A linear pair's interval is a rewrite marker",
				),
				JUDGE,
			],
			[CROSS_REVIEW.replace("names the two heads and carries no delta", "carries the tree delta"), JUDGE],
			[
				CROSS_REVIEW.replace(
					"A rewrite marker is a complete interval, not missing delta data",
					"A rewrite marker is missing delta data",
				),
				JUDGE,
			],
			[CROSS_REVIEW.replace("it cannot support NONE, STAGNATION or OSCILLATION", "it cannot support NONE"), JUDGE],
			[
				CROSS_REVIEW.replace(
					"a value whose required evidence lies in the unmeasured correction is INDETERMINATE",
					"a value whose required evidence lies in the unmeasured correction is STAGNATION",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"other values may be ruled only from the run's states, a marker's endpoint states included, and its linear intervals",
					"other values may be ruled from the marker",
				),
				JUDGE,
			],
			[CROSS_REVIEW.replace("never an under-stop", "or an under-stop"), JUDGE],
			[CROSS_REVIEW.replace("activates only with its implementing derivation", "activates at once"), JUDGE],
			[
				CROSS_REVIEW.replace(
					"until then the installed reader withholds the projection for a non-ancestral pair",
					"until then nothing changes",
				),
				JUDGE,
			],
			[CROSS_REVIEW.replace("— of which a rewrite marker is none —", "— a rewrite marker included —"), JUDGE],
			[
				CROSS_REVIEW.replace("never slices edits or attributes an edit to a finding", "attributes edits by proximity"),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"NIT/remedy, refuted/`none`, `defer`, `measure-escalate`, and Nit carry-forward",
					"NIT/remedy",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"Missing, duplicate, reordered, noncontiguous, cardinality-misaligned, or ambiguous",
					"Missing",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace("withholds diagnosis rather than narrowing or guessing", "uses the available subset"),
				JUDGE,
			],
			[CROSS_REVIEW.replace("supplies the repair-basis projection", "supplies the history record"), JUDGE],
			[CROSS_REVIEW, JUDGE.replace("reads that section's repair-basis projection", "reads the same findings again")],
		] as const;
		for (const [index, [crossReview, judge]] of mutants.entries())
			assert.equal(settlementHolds(crossReview, judge), false, `mutant ${index} survived`);
	});

	it("allows diagnosis only after #238's repair basis is fully admitted", () => {
		assert.doesNotMatch(HISTORY_SOURCE, /same findings across review states|diagnosis reads the SAME findings/);
		assert.doesNotMatch(CALLER_SOURCE, /REPAIR_BASIS_PENDING/);
		const derive = CALLER_SOURCE.indexOf("await deriveRepairBasis(repoRoot, history)");
		const guard = CALLER_SOURCE.indexOf("if (basis === undefined)");
		const compose = CALLER_SOURCE.indexOf("composeDiagnosisBrief(basis,");
		assert.ok(derive >= 0 && guard > derive && compose > guard);
		assert.match(
			CALLER_SOURCE.slice(guard, compose),
			// #404: the same hand-off, now recorded in its §1.4 limb through stopAs.
			/return stopAs\(legacyUnderivable\(history\) \? "a" : "c", "none", \{\s*disposition: "hand-off",\s*cause: HANDOFF_DIAGNOSIS,\s*reentry: "none",\s*\}\);/,
		);
	});
});

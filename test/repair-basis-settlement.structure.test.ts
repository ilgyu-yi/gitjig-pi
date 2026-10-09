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
		crossReview.includes("Ancestry is decided only by a walk from the later head that completes") &&
		crossReview.includes("never falls to the branch-scoped delta") &&
		crossReview.includes("as pinned once by the round that derives the projection, the same for every pair in it") &&
		crossReview.includes("it is the **branch-scoped delta**: the tree delta from the earlier head to the later one") &&
		crossReview.includes("a missing object, an absent or ambiguous merge-base") &&
		crossReview.includes("a path that both the author and the base changed carries the base's change as well") &&
		crossReview.includes("A rename appears as a deletion and an addition") &&
		crossReview.includes("never understates it — a stated residual") &&
		crossReview.includes("This interval definition activates only with its implementing derivation") &&
		crossReview.includes(
			"When the earlier endpoint is an ancestor of the later one, the interval is the tree delta between them",
		) &&
		crossReview.includes(
			"restricted to the paths that either head changes relative to its own merge-base with one base head",
		) &&
		crossReview.includes(
			"A path changed only by the base between the two merge-bases is not the author's correction and is excluded",
		) &&
		crossReview.includes("can overstate the correction but never understates it") &&
		crossReview.includes("a read failure, a timeout or a cap — withholds the projection as below") &&
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
			[CROSS_REVIEW.replace("never falls to the branch-scoped delta", "falls to the branch-scoped delta"), JUDGE],
			[
				CROSS_REVIEW.replace(
					"Ancestry is decided only by a walk from the later head that completes",
					"Ancestry is decided by any walk",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"as pinned once by the round that derives the projection, the same for every pair in it",
					"as recorded on each review state",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"a path that both the author and the base changed carries",
					"a path that only the base changed carries",
				),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace("the interval is the tree delta between them", "the interval is the branch-scoped delta"),
				JUDGE,
			],
			[
				CROSS_REVIEW.replace(
					"it is the **branch-scoped delta**: the tree delta from the earlier head to the later one",
					"it is withheld",
				),
				JUDGE,
			],
			[CROSS_REVIEW.replace("a missing object, an absent or ambiguous merge-base", "a missing object"), JUDGE],
			[CROSS_REVIEW.replace("carries the base's change as well", "is excluded as well"), JUDGE],
			[CROSS_REVIEW.replace("A rename appears as a deletion and an addition", "A rename is ignored"), JUDGE],
			[CROSS_REVIEW.replace("never understates it — a stated residual", "never understates it"), JUDGE],
			[CROSS_REVIEW.replace("activates only with its implementing derivation", "activates at once"), JUDGE],
			[
				CROSS_REVIEW.replace(
					"restricted to the paths that either head changes",
					"covering every path the two heads differ on, as",
				),
				JUDGE,
			],
			[CROSS_REVIEW.replace("is not the author's correction and is excluded", "is included"), JUDGE],
			[CROSS_REVIEW.replace("never understates it", "may understate it"), JUDGE],
			[
				CROSS_REVIEW.replace(
					"relative to its own merge-base with one base head",
					"relative to the later head's merge-base",
				),
				JUDGE,
			],
			[CROSS_REVIEW.replace("a cap — withholds the projection as below", "a cap — is skipped"), JUDGE],
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

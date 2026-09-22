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
		crossReview.includes("**repair-basis projection**") &&
		crossReview.includes(
			"only effective findings whose joined ruling is `CONFIRMED`, severity is `SUBSTANTIVE`, and deterministic disposition is `repair`",
		) &&
		crossReview.includes("N projected states carry exactly N−1 complete author-authored correction intervals") &&
		crossReview.includes("terminal state remains intentionally unmatched") &&
		crossReview.includes("Several included findings in one state share that whole interval") &&
		crossReview.includes("caller never slices edits or attributes an edit to a finding") &&
		crossReview.includes("NIT/remedy, refuted/`none`, `defer`, `measure-escalate`, and Nit carry-forward") &&
		crossReview.includes("Missing, duplicate, reordered, noncontiguous, cardinality-misaligned, or ambiguous") &&
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
			[
				CROSS_REVIEW.replace(
					"`CONFIRMED`, severity is `SUBSTANTIVE`, and deterministic disposition is `repair`",
					"`CONFIRMED`",
				),
				JUDGE,
			],
			[CROSS_REVIEW.replace("N−1", "N"), JUDGE],
			[
				CROSS_REVIEW.replace(
					"terminal state remains intentionally unmatched",
					"terminal state receives an empty interval",
				),
				JUDGE,
			],
			[CROSS_REVIEW.replace("share that whole interval", "receive per-finding slices"), JUDGE],
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
			[CROSS_REVIEW, JUDGE.replace("reads that section's repair-basis projection", "reads the same findings again")],
		] as const;
		for (const [crossReview, judge] of mutants) assert.equal(settlementHolds(crossReview, judge), false);
	});

	it("marks only non-executable comments while preserving the exact #238 migration input", () => {
		assert.match(HISTORY_SOURCE, /superseded complete-record diagnosis brief/);
		assert.match(HISTORY_SOURCE, /#238's exclusive owner/);
		assert.match(HISTORY_SOURCE, /operation is prohibited by #236's bounded/);
		assert.equal(HISTORY_SOURCE.match(/same findings across review states/g)?.length, 1);
		assert.equal(HISTORY_SOURCE.match(/diagnosis reads the SAME findings across states/g)?.length, 1);
		assert.match(CALLER_SOURCE, /composeDiagnosisBrief\(history,/);
	});
});

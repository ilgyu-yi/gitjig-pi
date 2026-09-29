import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const spec = readFileSync(new URL("../SPEC.md", import.meta.url), "utf8");

const HEADING = "*Legacy review-record receipt availability.*";

/**
 * The settled paragraph, byte for byte. Pinning the whole paragraph is what
 * catches an appended, prefixed or rewritten sentence that keeps every named
 * obligation below as a substring while contradicting it.
 */
const PARAGRAPH =
	"*Legacy review-record receipt availability.* This paragraph governs only the review-round legacy call site above; the machine-record arm's one-GET/no-retry rule below and the lifecycle legacy call site are unchanged. One review record has exactly one publishing send. A confirmed strict locator supplies one positive comment ID and the immutable verification operands: host, repository, parent PR number, expected comment HTML locator, sealed writer and exact body. The verifier performs one authenticated targeted GET for that comment ID. If and only if the bounded platform reader returns `undefined` — no admitted output because the read was unavailable, nonzero, timed out, exceeded its byte bound or contained invalid UTF-8 — the verifier invokes its injected delay once for exactly **5,000 ms**, then performs one second targeted GET with every operand and route byte-identical. A present response, including malformed JSON or any identity/body mismatch, is observed evidence and fails immediately without delay or retry. Either read succeeds only by independently passing the complete exact receipt admission. An unavailable or non-admitted second read leaves publication unconfirmed. There is no zero-delay retry, third read, changed route or operand, collection fallback, second send, body edit, locator substitution, inferred or retroactive success, or review-history mutation. This settlement grants no runtime authority: #381 remains the implementation owner, its current body must be revised and independently reactivated to depend on this merged contract before deriving the delayed read, and PR #382 remains blocked meanwhile. No merge of this paragraph clears or reclassifies any historical publication receipt or §1.4 handoff.";

/** Named obligations, so a failure points at the meaning that moved. */
const obligations = [
	"governs only the review-round legacy call site above",
	"machine-record arm's one-GET/no-retry rule below and the lifecycle legacy call site are unchanged",
	"exactly one publishing send",
	"one authenticated targeted GET for that comment ID",
	"If and only if the bounded platform reader returns `undefined`",
	"no admitted output because the read was unavailable, nonzero, timed out, exceeded its byte bound or contained invalid UTF-8",
	"exactly **5,000 ms**",
	"then performs one second targeted GET with every operand and route byte-identical",
	"A present response, including malformed JSON or any identity/body mismatch, is observed evidence and fails immediately without delay or retry",
	"independently passing the complete exact receipt admission",
	"An unavailable or non-admitted second read leaves publication unconfirmed",
	"There is no zero-delay retry, third read, changed route or operand, collection fallback, second send, body edit, locator substitution, inferred or retroactive success, or review-history mutation",
	"This settlement grants no runtime authority: #381 remains the implementation owner",
	"its current body must be revised and independently reactivated to depend on this merged contract before deriving the delayed read",
	"PR #382 remains blocked meanwhile",
	"No merge of this paragraph clears or reclassifies any historical publication receipt or §1.4 handoff",
] as const;

// Outside the owned paragraph, no SPEC line may name a review receipt or
// review-round record in retry vocabulary. Residual, stated exactly: a line is
// rejected only when it carries BOTH a topic term and a retry term, so a
// contradicting sentence that lacks either set, or is split across lines,
// is not detected by this scan.
const RECEIPT_TOPIC = /receipt|refetch|review-round|review[- ]record/i;
const RETRY_TERMS = /retry|re-?read|second (?:targeted )?GET|third read|fall ?back|resend|delay/i;

/**
 * The one settled SPEC line outside the paragraph that matches both sets: the
 * machine-record implementation-evidence roster. It grants no permission; it
 * is pinned byte for byte so an inserted permission there still fails.
 */
const SETTLED_EXCEPTIONS = [
	"The derived implementation proves both/neither/unknown arms; descriptor/prototype/getter/symbol/container/alias attacks; key order, number and marker boundaries; all escapes plus exact wire-body and both raw and decoded semantic secret/actionable-reference views with content-free diagnostics; both body bounds and body/title counts; exact stdout framing/overflow; every pre/post-spawn terminal arm with and without a locator; successful exact reread for all six destinations plus every identity/type/parent/body/value/title mismatch; one-send, valid-locator-one-GET, invalid-locator-zero-GET and no-retry mutants; and byte-identical review-round and lifecycle awaiting-author legacy records. This amendment grants no governance-application authority: #314 remains blocked until that separate implementation lands and is independently verified. Clearing that blocker starts a wholly fresh UUID, plan record, persisted-TUI presentation, human confirmation and administration window; no failed chain operand is reused.",
] as const;

function section33(text: string): string {
	const start = text.indexOf("### 3.3 Gate classes");
	const end = text.indexOf("\n### 3.4 ", start + 1);
	return start < 0 || end < 0 ? "" : text.slice(start, end);
}

function contractHolds(text: string): boolean {
	const lines = text.split("\n");
	const owned = lines.filter((line) => line.startsWith(HEADING));
	if (owned.length !== 1 || owned[0] !== PARAGRAPH) return false;
	if (!section33(text).split("\n").includes(PARAGRAPH)) return false;
	if (!obligations.every((clause) => owned[0].includes(clause))) return false;
	return lines.every(
		(line) =>
			line === PARAGRAPH ||
			(SETTLED_EXCEPTIONS as readonly string[]).includes(line) ||
			!(RECEIPT_TOPIC.test(line) && RETRY_TERMS.test(line)),
	);
}

function mutate(from: string, to: string): string {
	assert.equal(spec.split(from).length, 2, `unique mutant source: ${from}`);
	return spec.replace(from, to);
}

describe("#383 legacy review receipt retry contract", () => {
	it("pins the exact §3.3 paragraph and each named obligation once", () => {
		assert.equal(contractHolds(spec), true);
		for (const clause of obligations) assert.equal(PARAGRAPH.split(clause).length, 2, clause);
	});

	it("baseline-first: kills in-paragraph reversals, contradictions and deletions", () => {
		assert.ok(contractHolds(spec));
		const mutants: Array<[string, string, string]> = [
			["zero delay", "exactly **5,000 ms**", "exactly **0 ms**"],
			[
				"zero delay made operative while the 5,000 ms text survives",
				"invokes its injected delay once for exactly **5,000 ms**, then performs",
				"performs immediately (the obsolete exactly **5,000 ms** delay is not applied) and then performs",
			],
			[
				"retry on mismatch",
				"If and only if the bounded platform reader returns `undefined`",
				"If the bounded platform reader returns `undefined` or a mismatched response",
			],
			["operand drift", "every operand and route byte-identical", "the route or operands may be refreshed"],
			["third read", "There is no zero-delay retry, third read", "A third read is allowed after the delayed retry"],
			["resend", "exactly one publishing send", "one initial publishing send and one resend"],
			[
				"appended collection fallback",
				"or review-history mutation.",
				"or review-history mutation. After the first targeted GET the verifier may fall back to the comment collection.",
			],
			[
				"appended third-read allowance",
				"or review-history mutation.",
				"or review-history mutation. Despite that rule, a third read is permitted after another unavailable result.",
			],
			[
				"prefixed runtime authority",
				"This settlement grants no runtime authority",
				"Runtime authority is granted here; the opposite retained sentence is nonbinding: This settlement grants no runtime authority",
			],
			[
				"dropped unavailable-result mapping",
				" — no admitted output because the read was unavailable, nonzero, timed out, exceeded its byte bound or contained invalid UTF-8 —",
				"",
			],
			[
				"dropped second targeted GET",
				"then performs one second targeted GET with every operand and route byte-identical",
				"then with every operand and route byte-identical",
			],
		];
		for (const [name, from, to] of mutants) assert.equal(contractHolds(mutate(from, to)), false, `survived: ${name}`);
		for (const clause of obligations) {
			assert.equal(contractHolds(mutate(clause, "[deleted #383 obligation]")), false, `survived deletion: ${clause}`);
		}
	});

	it("baseline-first: kills duplicated, relocated and out-of-paragraph permissions naming both term sets", () => {
		assert.ok(contractHolds(spec));
		const altered = PARAGRAPH.replace("exactly **5,000 ms**", "exactly **0 ms**");
		assert.equal(
			contractHolds(mutate(PARAGRAPH, `${PARAGRAPH}\n\n${altered}`)),
			false,
			"survived: duplicate paragraph",
		);
		const relocated = mutate(`${PARAGRAPH}\n\n`, "").replace(
			"### 1.7 The reviewer panel\n",
			`### 1.7 The reviewer panel\n\n${PARAGRAPH}\n`,
		);
		assert.equal(relocated.split(PARAGRAPH).length, 2, "relocation mutant keeps exactly one copy");
		assert.equal(contractHolds(relocated), false, "survived: relocation out of §3.3");
		assert.equal(
			contractHolds(mutate(PARAGRAPH, `${PARAGRAPH}\n\n*Note.* A review-record receipt may retry on a mismatch.`)),
			false,
			"survived: §3.3 note permitting retry",
		);
		assert.equal(
			contractHolds(
				mutate(
					"### 1.7 The reviewer panel\n",
					"### 1.7 The reviewer panel\n\nThe review-round receipt may fall back to the comment collection.\n",
				),
			),
			false,
			"survived: out-of-section fallback permission",
		);
		assert.equal(
			contractHolds(
				mutate(
					"### 1.7 The reviewer panel\n",
					"### 1.7 The reviewer panel\n\nReview-round records may perform a third read after the second GET fails.\n",
				),
			),
			false,
			"survived: review-round third read without receipt vocabulary",
		);
		assert.equal(
			contractHolds(mutate(SETTLED_EXCEPTIONS[0], `${SETTLED_EXCEPTIONS[0]} A review-round receipt may resend once.`)),
			false,
			"survived: permission appended to the settled exception line",
		);
	});
});

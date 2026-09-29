import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const spec = readFileSync(new URL("../SPEC.md", import.meta.url), "utf8");

function section33(source: string): string {
	const start = source.indexOf("### 3.3 Gate classes");
	const end = source.indexOf("\n### 3.4 ", start + 1);
	return start < 0 || end < 0 ? "" : source.slice(start, end);
}

const obligations = [
	"governs only the review-round legacy call site above",
	"machine-record arm's one-GET/no-retry rule below and the lifecycle legacy call site are unchanged",
	"exactly one publishing send",
	"one authenticated targeted GET for that comment ID",
	"If and only if the bounded platform reader returns `undefined`",
	"exactly **5,000 ms**",
	"every operand and route byte-identical",
	"A present response, including malformed JSON or any identity/body mismatch, is observed evidence and fails immediately without delay or retry",
	"independently passing the complete exact receipt admission",
	"There is no zero-delay retry, third read, changed route or operand, collection fallback, second send, body edit, locator substitution, inferred or retroactive success, or review-history mutation",
] as const;

function contractHolds(source: string): boolean {
	const owned = section33(source);
	return obligations.every((clause) => owned.includes(clause));
}

describe("#383 legacy review receipt retry contract", () => {
	it("pins the one-send, undefined-only, delayed identical-read bound in §3.3", () => {
		assert.equal(contractHolds(spec), true);
		for (const clause of obligations) assert.equal(section33(spec).split(clause).length, 2, clause);
	});

	it("baseline-first reversals kill every forbidden retry and publication shape", () => {
		assert.ok(contractHolds(spec));
		const mutants = [
			["exactly **5,000 ms**", "exactly **0 ms**"],
			[
				"If and only if the bounded platform reader returns `undefined`",
				"If the bounded platform reader returns `undefined` or a mismatched response",
			],
			["every operand and route byte-identical", "the route or operands may be refreshed"],
			["There is no zero-delay retry, third read", "A third read is allowed after the delayed retry"],
			["exactly one publishing send", "one initial publishing send and one resend"],
		] as const;
		for (const [from, to] of mutants) {
			assert.equal(spec.split(from).length, 2, `unique mutant source: ${from}`);
			assert.equal(contractHolds(spec.replace(from, to)), false, `survived reversal: ${from}`);
		}
		for (const clause of obligations) {
			assert.equal(
				contractHolds(spec.replace(clause, "[deleted #383 obligation]")),
				false,
				`survived deletion: ${clause}`,
			);
		}
	});
});

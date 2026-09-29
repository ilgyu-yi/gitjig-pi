import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const spec = readFileSync(new URL("../SPEC.md", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

/** Contract-only evidence: no runtime exports or changed Judge results are claimed. */
const owned = [
	"even two equal strings from one slot get separate ordinals",
	"never edited or continued",
	"whole original indexed bundle",
	"the same sealed reviewed head",
	"Both semantic calls use the same consumer-owned Judge profile, delegate argv, immutable expected-ref and deadline/options",
	"no third semantic dispatch is allowed",
	"A missing/invalid first return is not an admitted-incomplete result",
	"partition every caller-assigned bundle ordinal",
	"the **multiset** of the referenced raw slots",
	"The caller checks total coverage and provenance, not semantic equivalence",
	"dispositions carry `rulingIndex`",
	"text equality alone is insufficient when wordings repeat",
	"ordered bounded `judgeAttempts` for at most two semantic calls",
	"The existing unversioned parser and bytes remain valid historical input",
	"An indexed version-2 review that never reaches a fully admitted Judge partition",
	"Previously published unversioned review records retain their original bytes and recorded outcomes",
	"Separately authorized current-head re-entry is still required for PR #376",
] as const;

function contractHolds(source: string, pointer: string): boolean {
	return (
		owned.every((clause) => source.includes(clause)) &&
		pointer.includes("**future** indexed-bundle completeness") &&
		pointer.includes("contract-only settlement does not claim that the current `/review-round` implements")
	);
}

describe("#379 prospective Judge completeness settlement", () => {
	it("pins complete raw-to-effective and Resolver joins without claiming runtime exists", () => {
		assert.equal(contractHolds(spec, readme), true);
		for (const clause of owned) assert.equal(spec.split(clause).length, 2, `unique owned clause: ${clause}`);
	});

	it("baseline-first reversals kill each named contract clause and the adopter pointer", () => {
		assert.ok(contractHolds(spec, readme));
		for (const clause of owned) {
			const mutant = spec.replace(clause, `[deleted #379 obligation]`);
			assert.equal(contractHolds(mutant, readme), false, `survived removal: ${clause}`);
		}
		for (const clause of [
			"**future** indexed-bundle completeness",
			"contract-only settlement does not claim that the current `/review-round` implements",
		]) {
			assert.equal(readme.split(clause).length, 2);
			assert.equal(contractHolds(spec, readme.replace(clause, "[deleted]")), false);
		}
	});
});

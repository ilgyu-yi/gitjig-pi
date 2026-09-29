import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const spec = readFileSync(new URL("../SPEC.md", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

function section(source: string, number: string): string {
	const heading = `### ${number} `;
	const start = source.indexOf(heading);
	if (start < 0) return "";
	const end = source.indexOf("\n### ", start + heading.length);
	return source.slice(start, end < 0 ? undefined : end);
}

/** Every obligation belongs to its owning clause, not an arbitrary substring elsewhere. */
const owned = {
	"1.4": [
		"An indexed version-2 review that never reaches a fully admitted Judge partition",
		"Previously published unversioned review records retain their original bytes and recorded outcomes",
		"Separately authorized current-head re-entry is still required for PR #376",
	],
	"1.7": [
		"`rawOrdinal`, its zero-based position in the original ordered bundle",
		"even two equal strings from one slot get separate ordinals",
		"the caller must make exactly one fresh, bounded same-round semantic Judge dispatch",
		"never edited or continued",
		"whole original indexed bundle",
		"the same sealed reviewed head",
		"Both semantic calls use the same consumer-owned Judge profile, delegate argv, immutable expected-ref and deadline/options",
		"no third semantic dispatch is allowed",
		"A missing/invalid first return is not an admitted-incomplete result",
	],
	"1.9": [
		"partition every caller-assigned bundle ordinal",
		"the **multiset** of the referenced raw slots",
		"The caller checks total coverage and provenance, not semantic equivalence",
		"dispositions carry `rulingIndex`",
		"text equality alone is insufficient when wordings repeat",
		"ordered bounded `judgeAttempts` for at most two semantic calls",
		"The existing unversioned parser and bytes remain valid historical input",
	],
} as const;
const pointer = [
	"**future** indexed-bundle completeness",
	"contract-only settlement does not claim that the current `/review-round` implements",
] as const;

function contractHolds(source: string, prose: string): boolean {
	return (
		Object.entries(owned).every(([number, clauses]) =>
			clauses.every((clause) => section(source, number).includes(clause)),
		) && pointer.every((clause) => prose.includes(clause))
	);
}

describe("#379 prospective Judge completeness settlement", () => {
	it("pins each obligation in its owning clause without claiming runtime exists", () => {
		assert.equal(contractHolds(spec, readme), true);
		for (const [number, clauses] of Object.entries(owned)) {
			for (const clause of clauses) {
				assert.equal(section(spec, number).split(clause).length, 2, `unique §${number} clause: ${clause}`);
			}
		}
	});

	it("baseline-first reversals kill deletions, relocation and three semantic mutants", () => {
		assert.ok(contractHolds(spec, readme));
		for (const [number, clauses] of Object.entries(owned)) {
			for (const clause of clauses) {
				const mutant = spec.replace(clause, `[deleted #379 obligation]`);
				assert.equal(contractHolds(mutant, readme), false, `survived §${number} removal: ${clause}`);
			}
		}
		const semanticMutants = [
			["the caller must make exactly one", "the caller may make exactly one"],
			[
				"even two equal strings from one slot get separate ordinals",
				"even two equal strings from one slot may share an ordinal",
			],
			[
				"`rawOrdinal`, its zero-based position in the original ordered bundle",
				"`rawOrdinal`, an optional identity for selected findings",
			],
		] as const;
		for (const [original, reversal] of semanticMutants) {
			assert.equal(contractHolds(spec.replace(original, reversal), readme), false, `survived reversal: ${original}`);
			const relocated = spec
				.replace(original, reversal)
				.replace("### 1.8 Plan contest", `### 1.8 Plan contest\n${original}`);
			assert.equal(contractHolds(relocated, readme), false, `survived relocation: ${original}`);
		}
		for (const clause of pointer) {
			assert.equal(readme.split(clause).length, 2);
			assert.equal(contractHolds(spec, readme.replace(clause, "[deleted]")), false);
		}
	});
});

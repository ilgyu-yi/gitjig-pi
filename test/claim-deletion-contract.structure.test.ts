import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/*
 * #440: a claim beyond its evidence is withdrawn by the Judge's ruling
 * (SPEC §1.9), and shipped operator-facing prose is held to §2.4. Each clause
 * is pinned by its own literal and owned by one mutant below.
 */
const SPEC = readFileSync(new URL("../SPEC.md", import.meta.url), "utf8");

function section(text: string, number: string): string {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => line.startsWith(`### ${number} `));
	if (start < 0) return "";
	const end = lines.findIndex((line, index) => index > start && (line.startsWith("### ") || line.startsWith("## ")));
	return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

const CLAUSES: ReadonlyArray<readonly [string, string]> = [
	["1.9", "save the one withdrawal the claim-beyond-evidence rule below admits"],
	[
		"1.9",
		"asserts more than its evidence (§2.4) shows and no SPEC section, acceptance criterion or declared interface requires the stated behaviour",
	],
	["1.9", "the flagged prose is never itself that declared interface"],
	["1.9", "the finding is a behaviour defect: the behaviour is repaired, and deletion is never its repair"],
	[
		"1.9",
		"deleting whole claims, and only where the Judge rules that the remaining text, read in context, asserts nothing the original did not",
	],
	[
		"1.9",
		"A qualifier, a negation, a scope limiter, or a claim that excepts, limits or conditions another claim is never withdrawn this way",
	],
	["1.9", "where the Judge cannot rule that check, the finding is SUBSTANTIVE"],
	["1.9", "A withdrawal satisfies condition (c)."],
	[
		"1.9",
		"the Judge rules the finding **NIT** with that deletion as its exact mechanical remedy unless it cites the acceptance criterion or the passage of the artifact's own contract that owes the claim",
	],
	["1.9", "with no citation, the deletion is ruled"],
	["1.9", "The Resolver disposes it as remedy and Nit carry-forward applies unchanged"],
	["1.9", "a deletion so ruled is a ruling, not a designed repair"],
	["1.9", "Where the Judge cites one, the finding is SUBSTANTIVE and its ruling records the citation"],
	[
		"1.9",
		"the author's repair narrows the claim to what the evidence shows or revises the cited criterion through activation (§2.2)",
	],
	["1.9", "widening the claim to cover the counterexample is never its repair"],
	[
		"1.9",
		"is ruled by the Judge on all four axes at the next review; where confirmed it is SUBSTANTIVE, and the deletion default above does not reach it",
	],
	["1.9", "The rule narrows no panel's coverage (§1.7)."],
	[
		"2.4",
		"Shipped operator-facing prose — help text, rendered messages, changelog fragments, and source comments that state behaviour — carries its claims as evidence or does not make them",
	],
];

function holds(spec: string): boolean {
	return CLAUSES.every(([number, literal]) => section(spec, number).split(literal).length === 2);
}

describe("#440 claim-beyond-evidence contract", () => {
	it("pins every clause once, in its own section", () => {
		for (const [number, literal] of CLAUSES)
			assert.equal(section(SPEC, number).split(literal).length, 2, `§${number}: ${literal}`);
	});

	it("kills one weakening of every clause", () => {
		const mutants: ReadonlyArray<readonly [string, string]> = [
			["save the one withdrawal the claim-beyond-evidence rule below admits", "save any change a remedy makes"],
			[
				"and no SPEC section, acceptance criterion or declared interface requires",
				"whatever any SPEC section, acceptance criterion or declared interface requires",
			],
			[
				"the flagged prose is never itself that declared interface",
				"the flagged prose may itself be that declared interface",
			],
			[
				"the behaviour is repaired, and deletion is never its repair",
				"the behaviour is repaired, or its description deleted",
			],
			["deleting whole claims, and only where", "deleting any span, and only where"],
			["read in context, asserts nothing the original did not", "read alone, asserts nothing the original did not"],
			[
				"or conditions another claim is never withdrawn this way",
				"or conditions another claim may be withdrawn this way",
			],
			[
				"where the Judge cannot rule that check, the finding is SUBSTANTIVE",
				"where the Judge cannot rule that check, the finding is NIT",
			],
			["A withdrawal satisfies condition (c).", "A withdrawal satisfies condition (a)."],
			[
				"the Judge rules the finding **NIT** with that deletion",
				"the Judge may rule the finding **NIT** with that deletion",
			],
			["with no citation, the deletion is ruled", "with no citation, the Judge chooses"],
			["Nit carry-forward applies unchanged", "Nit carry-forward does not apply"],
			["a deletion so ruled is a ruling, not a designed repair", "a deletion so ruled is a designed repair"],
			["the finding is SUBSTANTIVE and its ruling records the citation", "the finding is SUBSTANTIVE"],
			["narrows the claim to what the evidence shows or revises", "widens the claim or revises"],
			[
				"widening the claim to cover the counterexample is never its repair",
				"widening the claim to cover the counterexample is its repair",
			],
			["ruled by the Judge on all four axes at the next review", "ruled by the panel at the next review"],
			["and the deletion default above does not reach it", "and the deletion default above reaches it"],
			["The rule narrows no panel's coverage (§1.7).", "The rule narrows the panel's coverage (§1.7)."],
			["carries its claims as evidence or does not make them", "may carry its claims without evidence"],
		];
		for (const [index, [from, to]] of mutants.entries()) {
			assert.equal(SPEC.split(from).length, 2, `mutant ${index} anchor is stale`);
			assert.equal(holds(SPEC.replace(from, () => to)), false, `mutant ${index} survived`);
		}
	});
});

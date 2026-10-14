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
	["1.2", "trivial exactly where §1.9's exact-mechanical-remedy rule holds — points"],
	["1.9", "**Claim beyond evidence.** A confirmed finding is a **claim-beyond-evidence** finding where the artifact"],
	["1.9", "Where one of them does require it, the finding is a behaviour defect"],
	["1.9", "A claim-beyond-evidence finding admits **withdrawal**"],
	["1.9", "Where one holds, the Judge rules the finding"],
	["1.9", "A repair that answers such a finding by asserting more than its new evidence shows"],
	[
		"1.9",
		"asserts more than its evidence (§2.4) shows and no SPEC section, acceptance criterion or declared interface requires the stated behaviour",
	],
	["1.9", "the flagged prose never counts as any of these owners, nor as what owes the claim below"],
	[
		"1.9",
		"the finding is a behaviour defect — the owed behaviour, or its evidence, is missing — repaired by supplying what is missing, and deletion is never its repair",
	],
	[
		"1.9",
		"deleting whole claims within the flagged span, so condition (b) holds, and only where the Judge rules that the remaining text, read in context with every other withdrawal the same review rules applied, asserts nothing the original did not",
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
		"where it is repaired, narrowing the claim to what the evidence shows or revising the cited criterion through activation (§2.2) is among the repairs open to it",
	],
	["1.9", "widening the claim to cover the counterexample is never its repair"],
	[
		"1.9",
		"once a finding at the next review reports it, is ruled by the Judge on all four axes; where confirmed it is SUBSTANTIVE, and the deletion default above does not reach it",
	],
	["1.9", "The rule narrows no panel's coverage (§1.7)."],
	[
		"2.4",
		"\n- Shipped operator-facing prose — help text, rendered messages, changelog fragments, and source comments that state behaviour — carries its claims as evidence or does not make them.\n",
	],
];

function failing(spec: string): number[] {
	return CLAUSES.flatMap(([number, literal], index) =>
		section(spec, number).split(literal).length === 2 ? [] : [index],
	);
}

describe("#440 claim-beyond-evidence contract", () => {
	it("pins every clause once, in its own section", () => {
		for (const [number, literal] of CLAUSES)
			assert.equal(section(SPEC, number).split(literal).length, 2, `§${number}: ${literal}`);
	});

	it("kills one weakening of every clause", () => {
		const mutants: ReadonlyArray<readonly [string, string]> = [
			["save the one withdrawal the claim-beyond-evidence rule below admits", "save any change a remedy makes"],
			[", nor as what owes the claim below", ""],
			[
				"exact-mechanical-remedy rule holds — points",
				"exact-mechanical-remedy rule holds: every commitment extensionally unchanged — points",
			],
			["once a finding at the next review reports it,", "whether or not any finding reports it,"],
			["Where one of them does require it", "Where one of them may require it"],
			["unless it cites the acceptance criterion or the passage", "unless it cites any passage"],
			["**Claim beyond evidence.** A confirmed finding is", "**Claim beyond evidence.** Any finding is"],
			[
				"Where one of them does require it, the finding is a behaviour defect",
				"Where one of them does require it, the finding is still a claim",
			],
			["A claim-beyond-evidence finding admits **withdrawal**", "A claim-beyond-evidence finding admits **rewording**"],
			["Where one holds, the Judge rules the finding", "Whether or not one holds, the Judge rules the finding"],
			[
				"A repair that answers such a finding by asserting more",
				"A repair that answers such a finding by asserting less",
			],
			[
				"and no SPEC section, acceptance criterion or declared interface requires",
				"whatever any SPEC section, acceptance criterion or declared interface requires",
			],
			[
				"the flagged prose never counts as any of these owners",
				"the flagged prose never counts as a declared interface",
			],
			[
				"repaired by supplying what is missing, and deletion is never its repair",
				"repaired by supplying what is missing, or by deleting its description",
			],
			["deleting whole claims within the flagged span, so condition (b) holds,", "deleting whole claims anywhere,"],
			["read in context with every other withdrawal the same review rules applied", "read in context"],
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
			["narrowing the claim to what the evidence shows or revising", "widening the claim or revising"],
			[
				"widening the claim to cover the counterexample is never its repair",
				"widening the claim to cover the counterexample is its repair",
			],
			["is ruled by the Judge on all four axes; where", "is ruled by the panel; where"],
			["and the deletion default above does not reach it", "and the deletion default above reaches it"],
			["The rule narrows no panel's coverage (§1.7).", "The rule narrows the panel's coverage (§1.7)."],
			["carries its claims as evidence or does not make them", "may carry its claims without evidence"],
			[
				"carries its claims as evidence or does not make them.\n",
				"carries its claims as evidence or does not make them, where it can.\n",
			],
		];
		const owned = new Set<number>();
		for (const [index, [from, to]] of mutants.entries()) {
			assert.equal(SPEC.split(from).length, 2, `mutant ${index} anchor is stale`);
			const reds = failing(SPEC.replace(from, () => to));
			assert.notEqual(reds.length, 0, `mutant ${index} survived`);
			if (reds.length === 1) owned.add(reds[0] as number);
		}
		// Ownership: every clause is the only one some mutant reds, so no clause
		// rides on another's literal.
		for (const [index, [number, literal]] of CLAUSES.entries())
			assert.ok(owned.has(index), `§${number} clause ${index} owns no mutant: ${literal}`);
	});
});

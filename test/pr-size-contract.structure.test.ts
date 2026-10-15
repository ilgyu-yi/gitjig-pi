import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/*
 * #408: SPEC §1.11 settles one pull-request size bound, its measured basis, the
 * disposition of an over-bound change, the reporting check and its escape; §1.1
 * points at it and §3.3 carries its row. Each clause is pinned by its own literal
 * and owned by one mutant below.
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
	[
		"1.11",
		"The class has one sanctioned escape on §3.8's escape architecture, which is this class's explicit total-coverage disposition.",
	],
	[
		"1.11",
		"a pull-request comment under the `gitjig-pr-size-escape: v1` marker whose JSON names the pull request number, its head commit, the measured value and a reason",
	],
	["1.11", "It is observable: the check output names the honoured record."],
	["1.11", ", and the check output names the refusing arm"],
	[
		"1.11",
		"Its measured basis is the 60 pull requests merged into `main` from #295 through #445, as of 2026-10-15T15:00Z",
	],
	["1.11", "Published review records (`gitjig-review-record`) exist on 40 of them"],
	["1.11", "at that window's p90, rounded up to the next hundred"],
	["1.11", "It is subject-bound, and its freshness bound is that head"],
	["1.1", "- **Change size.** A pull request to the default branch stays within §1.11's size bound"],
	[
		"1.11",
		"additions plus deletions in the diff from its merge base to its head, over every path, tests included, deletions weighing as additions",
	],
	["1.11", "a **region** of `SPEC.md` written by `.github/workflows/build_toc.sh` between its start and end markers"],
	["1.11", "changed lines inside the region do not count, and lines outside it in the same file do"],
	["1.11", "`test/fixtures/adopter-membership.snapshot.json`, a **file** written by `renderMembershipSnapshot`"],
	["1.11", "The check reads these exclusions from one owner, and adding one is a change to this section."],
	["1.11", "The bound is **2,400 changed lines**."],
	["1.11", "median 417, p75 1,257, p90 2,365, max 7,256"],
	["1.11", "the median is 0 under 300 changed lines, 2 from 300 to 1,100, and 0 above 1,100"],
	["1.11", "its link to review cost is **unmeasured**"],
	["1.11", "each part self-standing and none exposing partially usable behaviour before its last part"],
	["1.11", "fails above the threshold absent an honoured escape"],
	[
		"1.11",
		"It fails closed on input it cannot measure: an unavailable or truncated diff listing, or an unknown base (§3.9).",
	],
	[
		"1.11",
		"it is not a required context in the shipped default, and making it one is a separately authorized governance apply (§3.8)",
	],
	["1.11", "written by an account the platform reports holding write permission on the repository"],
	["1.11", "it exempts that one head of that one pull request from the bound and touches no other check"],
	["1.11", "It is default-off: with no record, the bound applies."],
	["1.11", "it is honoured only for the same pull request at the head it names, so any later push leaves it stale"],
	["1.11", "an unknown, missing, duplicate, stale or malformed field leaves it unhonoured"],
	["1.11", "A label is not the record (§2.2)."],
	["1.11", "Its first empirical firing transfers to the first pull request after it lands (§3.12, §5.3)."],
	[
		"3.3",
		"| pr-size | a pull request too large for one review to hold, past §1.11's bound | `home:` tier 3 (`pr-size`, a reporting check",
	],
];

function failing(spec: string): number[] {
	return CLAUSES.flatMap(([number, literal], index) => {
		const body = section(spec, number);
		const at = body.indexOf(literal);
		return at >= 0 && at === body.lastIndexOf(literal) ? [] : [index];
	});
}

describe("#408 pull-request size contract", () => {
	it("pins every clause once, in its own section", () => {
		assert.deepEqual(failing(SPEC), []);
	});

	it("kills one weakening of every clause", () => {
		const mutants: ReadonlyArray<readonly [string, string]> = [
			["which is this class's explicit total-coverage disposition", "which is one of several escapes"],
			[
				"under the `gitjig-pr-size-escape: v1` marker whose JSON names the pull request number, its head commit, the measured value and a reason",
				"under the `gitjig-size-ok` marker whose JSON names a reason",
			],
			["It is observable: the check output names the honoured record.", "It is silent."],
			[", and the check output names the refusing arm. A label", ". A label"],
			["from #295 through #445, as of 2026-10-15T15:00Z", "from #1 through #445, as of 2025-01-01"],
			["exist on 40 of them", "exist on 4 of them"],
			["rounded up to the next hundred", "rounded down"],
			["its freshness bound is that head", "its freshness bound is a day"],
			["stays within §1.11's size bound", "stays near §1.11's size bound"],
			["over every path, tests included", "over every path, tests excluded"],
			["between its start and end markers", "anywhere in the file"],
			["and lines outside it in the same file do", "and nor do lines outside it in the same file"],
			["a **file** written by `renderMembershipSnapshot`", "a **file** written by hand"],
			["and adding one is a change to this section.", "and the check may add one."],
			["The bound is **2,400 changed lines**.", "The bound is **24,000 changed lines**."],
			["p90 2,365, max 7,256", "p90 23,650, max 7,256"],
			["2 from 300 to 1,100, and 0 above 1,100", "2 from 300 to 1,100, and 9 above 1,100"],
			["its link to review cost is **unmeasured**", "its link to review cost is **measured**"],
			[
				"none exposing partially usable behaviour before its last part",
				"some exposing partially usable behaviour early",
			],
			["fails above the threshold absent an honoured escape", "warns above the threshold absent an honoured escape"],
			["It fails closed on input it cannot measure", "It passes on input it cannot measure"],
			["making it one is a separately authorized governance apply (§3.8)", "making it one is part of this change"],
			["holding write permission on the repository", "holding any account on the platform"],
			["and touches no other check", "and any other check it names"],
			["with no record, the bound applies.", "with no record, the bound is advisory."],
			["at the head it names, so any later push leaves it stale", "at any head, so a later push keeps it"],
			["stale or malformed field leaves it unhonoured", "stale or malformed field is ignored"],
			["A label is not the record (§2.2).", "A label is also a record (§2.2)."],
			["transfers to the first pull request after it lands", "needs no pull request after it lands"],
			[
				"| pr-size | a pull request too large for one review to hold",
				"| pr-size | a pull request too large for anyone",
			],
		];
		const owned = new Set<number>();
		for (const [index, [from, to]] of mutants.entries()) {
			const at = SPEC.indexOf(from);
			assert.ok(at >= 0 && at === SPEC.lastIndexOf(from), `mutant ${index} anchor is stale or ambiguous`);
			const reds = failing(SPEC.replace(from, () => to));
			assert.notEqual(reds.length, 0, `mutant ${index} survived`);
			if (reds.length === 1) owned.add(reds[0] as number);
		}
		for (const [index, [number, literal]] of CLAUSES.entries())
			assert.ok(owned.has(index), `§${number} clause ${index} owns no mutant: ${literal}`);
	});
});

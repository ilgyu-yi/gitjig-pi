import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const spec = readFileSync(new URL("../SPEC.md", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

/*
 * What this guard checks, defined positively. Text is split on LF; a section
 * runs from its heading line up to (not including) the next `### ` or `## `
 * heading, joined with LF.
 * SPEC:
 *   - each OWNED paragraph occurs exactly once, byte-identical, in its section,
 *     and each OBLIGATION occurs in exactly one OWNED paragraph (diagnostics);
 *   - each of §§1.4, 1.7 and 1.9 hashes to its SECTION_SHA256. Any edit,
 *     insertion, deletion, move or reordering inside those sections fails, so
 *     a future change there must update these digests deliberately and be
 *     re-reviewed;
 *   - outside those sections, the document-order sequence of lines matching
 *     COINED equals SETTLED_COINED ([section, SHA-256]).
 * README:
 *   - the section headed README_SECTION_HEADING occurs once, hashes to
 *     README_SECTION_SHA256 and contains README_POINTER exactly once;
 *   - README_POINTER occurs exactly once in README;
 *   - the document-order sequence of lines matching README_TOPIC or COINED
 *     equals SETTLED_README, and COINED matches only README_POINTER.
 * Residual: the guard fails exactly when one of the checks above is false, so
 * every change that leaves all of them true is undetected. The examples below
 * illustrate both directions; they are not an exhaustive characterization.
 *   Undetected, for example: new or replacement wording outside §§1.4/1.7/1.9
 *   and outside the pinned README section that matches no COINED pattern
 *   (SPEC or README) and no README_TOPIC pattern (README), however
 *   contradictory, including a matching README line replaced by such wording
 *   while its exact original text is reinserted elsewhere without changing
 *   the matching lines' document order; and any wording, spelling, separator,
 *   homoglyph or abbreviation the finite patterns do not match.
 *   Detected although the edited line itself matches no pattern, for example:
 *   section membership and extent are derived from heading lines, so
 *   renumbering a SPEC heading changes the recorded section of a settled
 *   coined line, and changing a README heading's level changes the pinned
 *   README section's extent.
 * The "documents its residual in both directions" test pins these examples.
 */

/** The four settled paragraphs, byte for byte, each with its owning section. */
const OWNED = [
	{
		section: "1.4",
		text: "**Prospective incomplete adjudication and legacy history (§1.7, §1.9).** An indexed version-2 review that never reaches a fully admitted Judge partition and exact Resolver join is incomplete: it contributes no review state and cannot reset or add to this section's repair count. Previously published unversioned review records retain their original bytes and recorded outcomes; they are not retroactively reclassified by the new producer. Where an old resolved repair lacks a derivable raw-to-effective relation, the repair-basis projection remains unavailable and hands off — it never guesses a relation, edits history, or grants a new current-head panel. The §1.7/§1.9 version-2 enforcement and this prospective history consequence activate only with their implementing derivation, never from a contract-only PR alone (§5.3). Separately authorized current-head re-entry is still required for PR #376's already-published record.",
	},
	{
		section: "1.7",
		text: "**Mechanical aggregation.** The panel's output is the **bundle**: the concatenation of the raw findings returned by every valid slot, constructed by the caller. No vote, no threshold, no semantic deduplication, no severity, no filtering, no reordering that loses provenance — the bundle is transport, and a bundle that dropped a finding is a defective bundle, not a strict one. Every semantic operation over the findings is the Judge's (§1.9). **For new version-2 reviews**, the caller attaches `rawOrdinal`, its zero-based position in the original ordered bundle, to every raw occurrence — even two equal strings from one slot get separate ordinals. The caller carries the exact indexed bundle into both the Judge brief and retained review record; neither the Judge nor a later reader can assign or renumber it. The rule is prospective and does not rewrite existing unversioned records.",
	},
	{
		section: "1.7",
		text: "**One bounded completeness re-request.** After the first independent Judge dispatch returns a compare-confirmed, preliminarily admitted but *incomplete* adjudication of a nonempty identified bundle — in particular a well-formed subset of rulings omitting one or more raw occurrences — the caller must make exactly one fresh, bounded same-round semantic Judge dispatch. The previous delegate has ended; it is never edited or continued. The re-request includes the **whole original indexed bundle**, the same sealed reviewed head, caller-derived criterion manifest and source facts, and the caller's deterministic completeness gaps — never only the unruled findings or a changed author brief. Both semantic calls use the same consumer-owned Judge profile, delegate argv, immutable expected-ref and deadline/options; only the second semantic brief adds the deterministic gaps and whole-bundle re-request instruction. Each dispatch retains its separate one numeric-exit/missing-return transport retry above; that retry does not replenish the one semantic re-request, and no third semantic dispatch is allowed. No new §1.4 recovery allowance is claimed. A missing/invalid first **return or ruling envelope** (as distinct from a valid envelope missing an occurrence) is not an admitted-incomplete result and does not activate this semantic request; no manifest, invalid compare, an unavailable actor, or an incomplete/unavailable second return leaves the review INCOMPLETE, with no Resolver consequence. Preserve bounded observed evidence of both semantic calls even where neither yields a terminal review.",
	},
	{
		section: "1.9",
		text: "**Preterminal admission and indexed record.** For version-2 review records, the Judge return's every effective ruling supplies a nonempty ascending `rawOrdinals` array. A preliminary ruling-envelope check accepts only well-formed rulings with required axes, nonempty ascending arrays of in-range original ordinals, and no duplicates within or across rulings. A valid envelope whose union omits one or more original ordinals is **admitted-incomplete only for §1.7's bounded whole-bundle re-request**, not admitted as a resolved review; absent arrays, repeated, unknown, noninteger, or out-of-order identities instead invalidate the envelope and trigger no semantic re-request. For terminal admission the arrays must exactly and disjointly partition every caller-assigned bundle ordinal; any remaining missing ordinal, gap, invalid envelope, or absent owed axis fails admission before a Resolver call or a resolved record. A ruling's slot `provenance` equals the **multiset** of the referenced raw slots; a slot name or a matching count cannot substitute for occurrence identity. Rephrasing never changes a raw ordinal; the Judge alone may group several raw ordinals as semantically one effective finding, with original texts/grouping retained for audit. The caller checks total coverage and provenance, not semantic equivalence; a Judge that falsely attests equivalence remains an honest residual on the retained evidence, never a caller-implemented second Judge. A complete admitted ruling keeps §1.9's owed axes. Resolver dispositions carry `rulingIndex` (the zero-based effective-ruling index) and must exactly match the indexed ruling's text and deterministic disposition; text equality alone is insufficient when wordings repeat. The caller admits this exact join before publishing a version-2 `resolved` record. A separately admitted record shape under the same existing marker has `schemaVersion:2`, indexed raw bundle, indexed Judge rulings and Resolver dispositions, and ordered bounded `judgeAttempts` for at most two semantic calls (observed run/return/compare class, result digest and admitted payload if present); its `resolved` state requires the complete partition and Resolver join, while `incomplete` has no Resolver outcome. Attempts are retained even on an incomplete terminal; publication failure, missing/unreadable attempt evidence, or ambiguous relation fails closed. The existing unversioned parser and bytes remain valid historical input without fabricated indexes or migration. This rule activates when its version-2 producer and consumer derive; until then §1.9's existing completeness and no-partial-Resolver obligations remain fully in force.",
	},
] as const;

/** The three sections holding the contract, each pinned whole by SHA-256. */
const SECTION_SHA256: ReadonlyArray<readonly [string, string]> = [
	["1.4", "422512ad84515d58e42b4da6219ade9719d8660078fc7e254c64500d11ef030c"],
	["1.7", "76327e76eb2141d4a7e2504725416479785cc98fddfdde6cb9fbafb206406aec"],
	["1.9", "989f91156c41b631b5453ddb1f3b301ad6dd1d3719e0eadaa4280fe032f553cb"],
];

/** The adopter pointer, byte for byte: a present-tense claim now that #378's runtime has landed (#398). */
const README_POINTER =
	"The command appends one structured `gitjig-review-round` entry and displays one terminal line. `refused` means the input was rejected before a round; `hand-off` means subject, history, dispatch, publication, or required re-entry could not safely complete and names the re-entry target; `posted` means the durable review record was confirmed, including an incomplete record when a required return was unavailable; `recovery` reports the bounded recovery route's terminal, next gate, and route, and a content-free record reference where one exists, not an approval or landing decision. The terminal line reports the disposition and, when present, the review state and diagnosis. `/review-round` applies SPEC §§1.7 and 1.9's indexed-bundle completeness and one bounded full-bundle Judge re-request before a resolved review, writing version-2 records; historical unversioned records stay readable, §1.4 keeps ambiguous legacy history fail-closed, and no existing handoff is released.";
const README_SECTION_HEADING = "## Driving a review round";
// #422 re-pinned this section when the round's transport became selectable, so
// the section that documents driving a round documents the choice; only the
// generic-dispatch sentence changed. #424 re-pins it again for the operator
// sentence that replaced "arrives with its own command in a later change", which
// now joins the line-level table below because it names the review record.
const README_SECTION_SHA256 = "b139e53d2893f997e450486e6240bf9a7cb29335add67a42cf3906547cbbc9ab";

/** Named obligations, so a failure points at the meaning that moved; each lives in exactly one owned paragraph. */
const OBLIGATIONS = [
	"An indexed version-2 review that never reaches a fully admitted Judge partition",
	"Previously published unversioned review records retain their original bytes and recorded outcomes",
	"Separately authorized current-head re-entry is still required for PR #376",
	"`rawOrdinal`, its zero-based position in the original ordered bundle",
	"even two equal strings from one slot get separate ordinals",
	"the caller must make exactly one fresh, bounded same-round semantic Judge dispatch",
	"in particular a well-formed subset of rulings omitting one or more raw occurrences",
	"never edited or continued",
	"whole original indexed bundle",
	"the same sealed reviewed head",
	"Both semantic calls use the same consumer-owned Judge profile, delegate argv, immutable expected-ref and deadline/options",
	"Each dispatch retains its separate one numeric-exit/missing-return transport retry above; that retry does not replenish the one semantic re-request",
	"no third semantic dispatch is allowed",
	"A missing/invalid first **return or ruling envelope** (as distinct from a valid envelope missing an occurrence) is not an admitted-incomplete result",
	"A preliminary ruling-envelope check accepts only well-formed rulings with required axes",
	"whose union omits one or more original ordinals is **admitted-incomplete only for §1.7's bounded whole-bundle re-request**",
	"absent arrays, repeated, unknown, noninteger, or out-of-order identities instead invalidate the envelope",
	"exactly and disjointly partition every caller-assigned bundle ordinal",
	"slot `provenance` equals the **multiset** of the referenced raw slots",
	"The caller checks total coverage and provenance, not semantic equivalence",
	"dispositions carry `rulingIndex`",
	"must exactly match the indexed ruling's text and deterministic disposition",
	"text equality alone is insufficient when wordings repeat",
	"ordered bounded `judgeAttempts` for at most two semantic calls",
	"Attempts are retained even on an incomplete terminal; publication failure, missing/unreadable attempt evidence, or ambiguous relation fails closed",
	"The existing unversioned parser and bytes remain valid historical input",
] as const;

const SEP = "[\\s_\\-\\u2010-\\u2015]?";
const COINED = new RegExp(
	[
		`raw${SEP}ordinals?`,
		`ruling${SEP}index`,
		`judge${SEP}attempts`,
		`schema${SEP}version\\s*:?\\s*2`,
		`version${SEP}2\\b`,
		`re${SEP}request`,
		`semantic${SEP}(?:re${SEP}request|dispatch|call)`,
		`admitted${SEP}incomplete`,
		`ruling${SEP}envelope`,
	].join("|"),
	"i",
);
const PINNED_SECTIONS = new Set(SECTION_SHA256.map(([section]) => section));
/** Document-order [section, SHA-256, locator prefix] of settled SPEC lines outside the pinned sections matching COINED. */
const SETTLED_COINED: ReadonlyArray<readonly [string, string, string]> = [
	[
		"5.5",
		"89f07d393e8527377a43cba330ad434da46dbc02a8c47d488e06de94529157d4",
		"The final allowance leaf is an effective",
	],
];
const README_TOPIC =
	/\bJudge\b|\bResolver\b|\bbundle\b|review[- ]round|review record|adjudicat|re-?request|completeness|\bretry|full-bundle|\bindexed/i;
/** Document-order [SHA-256, locator prefix] of README lines matching README_TOPIC or COINED, pointer included. */
const SETTLED_README: ReadonlyArray<readonly [string, string]> = [
	["ee995c8797a0f64c4334bd21e2a55b518bb29008d2381f52a6c29a42f24d17f5", "## Driving a review round"],
	["55e4c158e0bab28f9ed46a411bdf9388e1043a205fc1acce0ea188045846e523", "Run the composed panel, Judge, Resolver,"],
	["46fa2b872c272e19a0ca2a9b4fd09953989b605559661361c95f0a8b5a3db6f1", "/review-round review-round.json"],
	["0eb97762ca1a13f5603394a462a082a20fa4ae53b3f0b14a6a0a0b23ae08b7b4", '    "priorFindings": [{"label": "F1", "t'],
	["e9f9ac87382ab133a5f519240737fc75f82d21ce384a0bd04bd9cbdbfe34ab77", '  "changeDescription": "Add the review-r'],
	["592dc3233b2c0c545afc665e27891c129de15599b5fb441c758b6e6b83edb88b", "This example is for generic argv dispatc"],
	// #424: the transport paragraph now names the review record /delegate never reaches.
	["576cc5700692e488fd3ffac8ebac78bfaa35f3fa43879aca929270a193e476cf", "Exactly one transport is selected per sp"],
	["ec1c53c7996c1db28e319ae2e1fb75fc8f730d7ec5d13104873759023e29a9b1", "The command appends one structured `gitj"],
	["06d8faf183324bd6936fea16fd02f30889fe525c0f79f300049cd9216b89cc59", "Use ordinary `body` publication for pros"],
	["4619fc4f7cff0f89053cd2c3e4c7bdbe54b2822c1bb0ba74cd8728fc22710f19", "Tier 1 always tries ordinary landing fir"],
	["662de89b6062fc7aa669989a92db2854e10179502d8e2e918a322ad75c6a71e0", "A current operator may instead direct Ti"],
];

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

function sectionOf(lines: readonly string[]): string[] {
	let current = "";
	return lines.map((line) => {
		const heading = /^### (\d+\.\d+) /.exec(line);
		if (heading) current = heading[1];
		else if (line.startsWith("## ")) current = "";
		return current;
	});
}

function sectionText(lines: readonly string[], start: number): string {
	const end = lines.findIndex((line, index) => index > start && (line.startsWith("### ") || line.startsWith("## ")));
	return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

function violations(text: string, prose: string): string[] {
	const found: string[] = [];
	const lines = text.split("\n");
	const sections = sectionOf(lines);
	for (const entry of OWNED) {
		const at = lines.flatMap((line, index) => (line === entry.text ? [index] : []));
		if (at.length !== 1) found.push(`owned paragraph count ${at.length}: ${entry.text.slice(0, 48)}`);
		else if (sections[at[0]] !== entry.section) found.push(`owned paragraph outside §${entry.section}`);
	}
	for (const clause of OBLIGATIONS) {
		if (OWNED.filter((entry) => entry.text.includes(clause)).length !== 1)
			found.push(`obligation not owned once: ${clause}`);
	}
	for (const [section, hash] of SECTION_SHA256) {
		const starts = lines.flatMap((line, index) => (line.startsWith(`### ${section} `) ? [index] : []));
		if (starts.length !== 1) found.push(`§${section} heading count ${starts.length}`);
		else if (digest(sectionText(lines, starts[0])) !== hash) found.push(`§${section} changed`);
	}
	const coinedSeen = lines.flatMap((line, index) =>
		!PINNED_SECTIONS.has(sections[index]) && COINED.test(line) ? [`${sections[index]}:${digest(line)}`] : [],
	);
	if (JSON.stringify(coinedSeen) !== JSON.stringify(SETTLED_COINED.map(([section, hash]) => `${section}:${hash}`)))
		found.push("coined-term lines outside the pinned sections differ from the settled sequence");
	const proseLines = prose.split("\n");
	if (proseLines.filter((line) => line === README_POINTER).length !== 1)
		found.push("README pointer changed or duplicated");
	if (proseLines.some((line) => line !== README_POINTER && COINED.test(line)))
		found.push("coined term elsewhere in README");
	const readmeSeen = proseLines.filter((line) => README_TOPIC.test(line) || COINED.test(line)).map(digest);
	if (JSON.stringify(readmeSeen) !== JSON.stringify(SETTLED_README.map(([hash]) => hash)))
		found.push("README topical lines differ from the settled sequence");
	const start = proseLines.indexOf(README_SECTION_HEADING);
	if (start < 0 || proseLines.lastIndexOf(README_SECTION_HEADING) !== start)
		found.push("README pointer section heading missing or duplicated");
	else {
		const end = proseLines.findIndex((line, index) => index > start && line.startsWith("## "));
		const sectionLines = proseLines.slice(start, end < 0 ? undefined : end);
		if (digest(sectionLines.join("\n")) !== README_SECTION_SHA256) found.push("README pointer section changed");
		if (sectionLines.filter((line) => line === README_POINTER).length !== 1)
			found.push("README pointer outside its pinned section");
	}
	return found;
}

function mutate(from: string, to: string): string {
	assert.equal(spec.split(from).length, 2, `unique mutant source: ${from.slice(0, 60)}`);
	return spec.replace(from, to);
}

function lineStarting(prefix: string): string {
	const hits = spec.split("\n").filter((line) => line.startsWith(prefix));
	assert.equal(hits.length, 1, `unique line: ${prefix}`);
	return hits[0];
}

describe("#379 prospective Judge completeness settlement", () => {
	it("pins the owned paragraphs, the three contract sections, the README pointer and every obligation", () => {
		assert.deepEqual(violations(spec, readme), []);
	});

	it("baseline-first: kills deletion of each obligation and eight named meaning reversals", () => {
		assert.deepEqual(violations(spec, readme), []);
		for (const clause of OBLIGATIONS) {
			assert.notDeepEqual(
				violations(mutate(clause, "[deleted #379 obligation]"), readme),
				[],
				`survived deletion: ${clause}`,
			);
		}
		const reversals: Array<[string, string]> = [
			[
				"exactly and disjointly partition every caller-assigned bundle ordinal",
				"approximately cover original ordinals with overlaps allowed",
			],
			[
				"slot `provenance` equals the **multiset** of the referenced raw slots",
				"slot `provenance` merely names the **multiset** of slots",
			],
			[
				"must exactly match the indexed ruling's text and deterministic disposition",
				"need not match the indexed ruling's text or deterministic disposition",
			],
			["the caller must make exactly one", "the caller may make exactly one"],
			[
				"even two equal strings from one slot get separate ordinals",
				"even two equal strings from one slot may share an ordinal",
			],
			[
				"`rawOrdinal`, its zero-based position in the original ordered bundle",
				"`rawOrdinal`, an optional identity for selected findings",
			],
			["no third semantic dispatch is allowed", "a third semantic dispatch is allowed"],
			["never edited or continued", "edited or continued when convenient"],
		];
		for (const [from, to] of reversals)
			assert.notDeepEqual(violations(mutate(from, to), readme), [], `survived reversal: ${from}`);
	});

	it("baseline-first: kills in-paragraph contradictions, duplication and relocation", () => {
		const bounded = OWNED[2].text;
		const preterminal = OWNED[3].text;
		const cases: Array<[string, string]> = [
			[
				"appended third dispatch",
				mutate(
					bounded,
					`${bounded} Despite that bound, a third semantic dispatch is permitted when the second is incomplete.`,
				),
			],
			["prefixed override", mutate(preterminal, `Nothing below binds the Resolver. ${preterminal}`)],
			[
				"duplicate altered paragraph",
				mutate(bounded, `${bounded}\n\n${bounded.replace("must make exactly one", "may make exactly one")}`),
			],
			[
				"relocation to §1.8",
				mutate(`${bounded}\n\n`, "").replace("### 1.8 Plan contest\n", `### 1.8 Plan contest\n\n${bounded}\n`),
			],
		];
		for (const [name, text] of cases) assert.notDeepEqual(violations(text, readme), [], `survived: ${name}`);
	});

	it("baseline-first: kills any change inside the pinned sections, including unpatterned wording and moves", () => {
		const author = lineStarting("**The author's non-role.**");
		const durable = lineStarting("**Reconsideration.**");
		const repeated = lineStarting("Repeated repair at a review gate");
		const planning = lineStarting("**The planning boundary.**");
		const swap = (a: string, b: string): string => spec.replace(a, "\u0000A").replace(b, a).replace("\u0000A", b);
		const cases: Array<[string, string]> = [
			[
				"unpatterned replacement in §1.9",
				mutate(
					author,
					"**The author's role.** The artifact author performs every initial validity, deduplication, severity, direction, and impact decision.",
				),
			],
			[
				"replacement plus relocation within §1.9",
				mutate(author, "**The author's role.** The artifact author performs every initial ruling.").replace(
					`${durable}\n`,
					`${durable}\n\n${author}\n`,
				),
			],
			["pinned line moved across an unscanned paragraph", swap(author, durable)],
			["§1.4 paragraphs swapped", swap(repeated, planning)],
			[
				"topic+permission line in §1.9",
				mutate(
					"### 1.9 Finding judgment\n",
					"### 1.9 Finding judgment\n\nThe Resolver may dispose the ruled subset when some findings are unruled.\n",
				),
			],
			[
				"unpatterned line in §1.7",
				mutate(
					"### 1.7 The reviewer panel\n",
					"### 1.7 The reviewer panel\n\nReviewers need not report every finding.\n",
				),
			],
			["whitespace-only edit in §1.4", mutate(`${repeated}\n`, `${repeated} \n`)],
		];
		for (const [name, text] of cases) {
			assert.notEqual(text, spec, `${name}: mutant must change the text`);
			assert.notDeepEqual(violations(text, readme), [], `survived: ${name}`);
		}
	});

	it("baseline-first: kills coined vocabulary outside the pinned sections in any separator spelling", () => {
		const cases: Array<[string, string]> = [
			[
				"coined term in §1.8",
				mutate("### 1.8 Plan contest\n", "### 1.8 Plan contest\n\nA rawOrdinal may be reused across rulings.\n"),
			],
			[
				"coined term in §3.3",
				mutate("### 3.3 Gate classes\n", "### 3.3 Gate classes\n\nThe semantic re-request is optional.\n"),
			],
			...[
				"ruling-envelope",
				"ruling_index",
				"re_request",
				"re request",
				"re\u2011request",
				"semanticcall",
				"rulingenvelope",
				"admittedincomplete",
			].map((term): [string, string] => [
				`${term} in §1.8`,
				mutate("### 1.8 Plan contest\n", `### 1.8 Plan contest\n\nA ${term} may omit raw findings.\n`),
			]),
		];
		for (const [name, text] of cases) assert.notDeepEqual(violations(text, readme), [], `survived: ${name}`);
		for (const [, hash, prefix] of SETTLED_COINED) {
			const line = spec.split("\n").find((candidate) => digest(candidate) === hash);
			assert.ok(line, `settled coined line present: ${prefix}`);
			assert.notDeepEqual(violations(`${spec}\n${line}\n`, readme), [], "survived: settled coined line duplicated");
			assert.notDeepEqual(violations(mutate(`${line}\n`, ""), readme), [], "survived: settled coined line deleted");
		}
	});

	it("baseline-first: kills README pointer drift, relocation and contradiction", () => {
		assert.equal(readme.split(`${README_POINTER}\n`).length, 2, "pointer line is unique and LF-terminated");
		const cases = [
			`${readme}\nThe current command implements the full-bundle Judge retry.\n`,
			readme.replace(
				"## Driving a review round\n",
				"## Driving a review round\n\nThe Resolver already rejects partial Judge rulings.\n",
			),
			readme.replace(
				"`/review-round` applies SPEC",
				"SPEC §§1.7 and 1.9 settle the **future**; `/review-round` does not yet apply SPEC",
			),
			readme.replace("and no existing handoff is released", "and every existing handoff is released"),
			readme.replace(README_POINTER, `${README_POINTER} The runtime now implements the re-request.`),
			readme.replace(README_POINTER, `${README_POINTER}\n\nThe rawOrdinal partition is live.`),
			`${readme.replace(`${README_POINTER}\n`, "")}\n${README_POINTER}\n`,
			readme.replace(`${README_POINTER}\n`, "").replace("```json\n", `\`\`\`json\n${README_POINTER}\n`),
			readme.replace("```json\n", "```json\n\n"),
			`${readme}\nA re_request or re request may be skipped.\n`,
		];
		for (const prose of cases) {
			assert.notEqual(prose, readme, "README mutant must change the text");
			assert.notDeepEqual(violations(spec, prose), [], "survived README drift");
		}
	});

	it("documents its residual in both directions", () => {
		const detected: Array<[string, string, string]> = [
			["renumbered SPEC heading", mutate("### 5.5 State boundary\n", "### 5.4 State boundary\n"), readme],
			["demoted README heading", spec, readme.replace("## Pre-authoring brief\n", "### Pre-authoring brief\n")],
		];
		for (const [name, text, prose] of detected) {
			assert.notEqual(`${text}${prose}`, `${spec}${readme}`, `${name}: mutant must change the text`);
			assert.notDeepEqual(violations(text, prose), [], `documented detection missing: ${name}`);
		}
		const topical = readme.split("\n").find((line) => line.startsWith("Use ordinary `body` publication"));
		assert.ok(topical, "README topical example line present");
		const replaced = readme
			.replace(`${topical}\n`, "Ordinary prose publication is now fully automatic.\n")
			.replace("## Recovery state location\n", `## Recovery state location\n\n${topical}\n`);
		assert.notEqual(replaced, readme, "residual example must change the text");
		assert.deepEqual(
			violations(spec, replaced),
			[],
			"documented undetected README example is now detected; update the residual comment",
		);
		const unrelated = mutate("### 3.3 Gate classes\n", "### 3.3 Gate classes\n\nAn unrelated clarifying sentence.\n");
		assert.deepEqual(
			violations(unrelated, readme),
			[],
			"documented undetected SPEC example is now detected; update the residual comment",
		);
	});
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const spec = readFileSync(new URL("../SPEC.md", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

/**
 * The four settled paragraphs, byte for byte, each with its owning section.
 * Pinning whole paragraphs is what catches an appended, prefixed or
 * rewritten sentence that keeps every named obligation below as a substring
 * while contradicting it (the defect class of PR #380's first three reviews).
 */
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

/** The adopter pointer, byte for byte: it must stay a future-tense, contract-only claim. */
const README_POINTER =
	"The command appends one structured `gitjig-review-round` entry and displays one terminal line. `refused` means the input was rejected before a round; `hand-off` means subject, history, dispatch, publication, or required re-entry could not safely complete and names the re-entry target; `posted` means the durable review record was confirmed, including an incomplete record when a required return was unavailable; `recovery` reports the bounded recovery route's terminal, next gate, and route, and a content-free record reference where one exists, not an approval or landing decision. The terminal line reports the disposition and, when present, the review state and diagnosis. SPEC §§1.7 and 1.9 settle the **future** indexed-bundle completeness and one bounded full-bundle Judge re-request before a resolved review; §1.4 keeps ambiguous legacy history fail-closed. This contract-only settlement does not claim that the current `/review-round` implements the new re-request or releases any existing handoff.";

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

/*
 * Two scans guard against contradicting permissions OUTSIDE the owned text.
 * (1) Vocabulary this contract coins may appear in SPEC only inside the owned
 *     paragraphs, apart from the settled lines pinned below.
 * (2) Inside §§1.4/1.7/1.9, a line carrying both a Judge/Resolver/bundle topic
 *     term and a permission term must be a settled line pinned below.
 * For each scan, the complete document-order sequence of matching lines must
 * EQUAL its pinned list of [section, SHA-256]. So each settled line must stay
 * present, byte-identical, unique, in its section and in its order; editing,
 * deleting, duplicating, moving or reordering one fails and forces a
 * deliberate re-review, as does adding any new matching line.
 * Residual, stated exactly: a new or replacement line inside §§1.4/1.7/1.9
 * that avoids every coined term and lacks the topic set or the permission set
 * (while every pinned line stays in place); any contradiction outside
 * §§1.4/1.7/1.9 that avoids every coined term; a contradiction split across
 * lines; and reordering of lines that match neither scan, are not detected.
 */
const COINED =
	/rawOrdinals?|rulingIndex|judgeAttempts|schemaVersion:2|version-2|re-request|semantic (?:re-?request|dispatch|call)|admitted-incomplete|ruling envelope/i;
const TOPIC = /\bJudge\b|\bruling|\bResolver\b|\bbundle\b|review record|adjudicat/i;
const PERMISSION = /\bmay\b|\boptional|need not|\bpermitted\b|\ballowed\b|\bcontinu|\binfer|\bpartial|\bskip|\bomit/i;
const SCANNED_SECTIONS = new Set(["1.4", "1.7", "1.9"]);
/** Document-order [section, SHA-256, locator prefix] of every settled line matching scan (1). */
const SETTLED_COINED: ReadonlyArray<readonly [string, string, string]> = [
	[
		"5.5",
		"89f07d393e8527377a43cba330ad434da46dbc02a8c47d488e06de94529157d4",
		"The final allowance leaf is an effective",
	],
];
/** Document-order [section, SHA-256, locator prefix] of every settled line matching scan (2). */
const SETTLED_SCAN: ReadonlyArray<readonly [string, string, string]> = [
	[
		"1.4",
		"ad5750e9df5f9c904704dbc0d366b8a2dbe3c5fcc5f4be805836014201f4a389",
		"Repeated repair at a review gate must ca",
	],
	[
		"1.4",
		"c45ef51f81d0bfffe47a4707d1043477697024b6e85be0b3c4b998617548ce59",
		"**A count triggers inspection, never esc",
	],
	[
		"1.4",
		"f9c296fcc680b7037d3c525968adbc13c5732cad846648ef5a9c21c889d3785c",
		"**The diagnosis.** Inspecting the repair",
	],
	[
		"1.4",
		"2945ed7bee0dc031056a8a72aff660706f1f752682ce4522c514d5971575500d",
		"The closed recovery record carries the d",
	],
	[
		"1.4",
		"b024d49c311c52021b88c0447e17e5f88c055f8ab26b0cbfcaec3ef52a04bf82",
		"The history-diagnosis route is bounded b",
	],
	[
		"1.4",
		"ec171c706d987c40c6d42dc7edd106db996590ea469e29ca517a2cf3a940101a",
		"**The planning boundary.** **Which gate*",
	],
	[
		"1.7",
		"c4bff12c10a2e1a8308d8fc28c21b15aaf44d4f742335963047cd8540d9d3030",
		"Majority vote is the **rejected design**",
	],
	[
		"1.7",
		"96f9603dd92c4a181a2421e208b1854d598831aa554e500f34e278edab9eba8a",
		"**Routing coverage.** Every reviewable c",
	],
	[
		"1.9",
		"b00d11ef4392630fed9dbfaca8b6cfc13f93dde013405dd9bdd87c250b2c54e4",
		"- **Severity** — **SUBSTANTIVE** or **NI",
	],
	[
		"1.9",
		"d97ac468756aa98077df66456007a02771713d41ea8059de00e318f24de8c166",
		"**The author's non-role.** The author of",
	],
	[
		"1.9",
		"61c8148bd34deaf640af3ba9f6cc66c0cd9490c55162fa8872e68415727dfdc9",
		"**Reconsideration.** A Judge ruling is d",
	],
	[
		"1.9",
		"f31918fdfbb5f0d665c9811f9a2223b3591ea5e515773203065378803ec8049d",
		"- **measure-escalate** — INDETERMINATE o",
	],
	[
		"1.9",
		"2cf1afcd1a2ce16a366b068e5e28b8e038dad36abc23837bf248dcc3b0999bb5",
		"**The never-list.** The Resolver never c",
	],
	[
		"1.9",
		"7a72a77216558f29b3ee55093e6d95e7120cfb956650e46df3ab69d0b494d6c2",
		"**The Judge dispatch.** The instrument i",
	],
	[
		"1.9",
		"a399470e8d57141ab2f7874aed7858f356db453259b7a7a35135588712dd60c4",
		"The norm is **procedural today**, enforc",
	],
];

const digest = (line: string): string => createHash("sha256").update(line).digest("hex");

function sectionOf(lines: readonly string[]): string[] {
	let current = "";
	return lines.map((line) => {
		const heading = /^### (\d+\.\d+) /.exec(line);
		if (heading) current = heading[1];
		else if (line.startsWith("## ")) current = "";
		return current;
	});
}

function violations(text: string, prose: string): string[] {
	const found: string[] = [];
	const lines = text.split("\n");
	const sections = sectionOf(lines);
	const owned = new Set<string>(OWNED.map((entry) => entry.text));
	for (const entry of OWNED) {
		const at = lines.flatMap((line, index) => (line === entry.text ? [index] : []));
		if (at.length !== 1) found.push(`owned paragraph count ${at.length}: ${entry.text.slice(0, 48)}`);
		else if (sections[at[0]] !== entry.section) found.push(`owned paragraph outside §${entry.section}`);
	}
	for (const clause of OBLIGATIONS) {
		if (OWNED.filter((entry) => entry.text.includes(clause)).length !== 1)
			found.push(`obligation not owned once: ${clause}`);
	}
	const coinedSeen: string[] = [];
	const scanSeen: string[] = [];
	lines.forEach((line, index) => {
		if (owned.has(line)) return;
		if (COINED.test(line)) coinedSeen.push(`${sections[index]}:${digest(line)}`);
		if (SCANNED_SECTIONS.has(sections[index]) && TOPIC.test(line) && PERMISSION.test(line))
			scanSeen.push(`${sections[index]}:${digest(line)}`);
	});
	const expected = (rows: typeof SETTLED_SCAN) => rows.map(([section, hash]) => `${section}:${hash}`);
	if (JSON.stringify(coinedSeen) !== JSON.stringify(expected(SETTLED_COINED)))
		found.push("coined-term lines differ from the pinned settled sequence");
	if (JSON.stringify(scanSeen) !== JSON.stringify(expected(SETTLED_SCAN)))
		found.push("topic+permission lines differ from the pinned settled sequence");
	const proseLines = prose.split("\n");
	if (proseLines.filter((line) => line === README_POINTER).length !== 1)
		found.push("README pointer changed or duplicated");
	if (proseLines.some((line) => line !== README_POINTER && COINED.test(line)))
		found.push("coined term elsewhere in README");
	return found;
}

function mutate(from: string, to: string): string {
	assert.equal(spec.split(from).length, 2, `unique mutant source: ${from.slice(0, 60)}`);
	return spec.replace(from, to);
}

describe("#379 prospective Judge completeness settlement", () => {
	it("pins the four owned paragraphs, the README pointer and every named obligation", () => {
		assert.deepEqual(violations(spec, readme), []);
	});

	it("baseline-first: kills deletion and meaning reversal of each obligation", () => {
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

	it("baseline-first: kills out-of-paragraph permissions caught by either scan", () => {
		const cases: Array<[string, string]> = [
			[
				"coined term in §1.8",
				mutate("### 1.8 Plan contest\n", "### 1.8 Plan contest\n\nA rawOrdinal may be reused across rulings.\n"),
			],
			[
				"coined term in §3.3",
				mutate("### 3.3 Gate classes\n", "### 3.3 Gate classes\n\nThe semantic re-request is optional.\n"),
			],
			[
				"topic+permission in §1.9",
				mutate(
					"### 1.9 Finding judgment\n",
					"### 1.9 Finding judgment\n\nThe Resolver may dispose the ruled subset when some findings are unruled.\n",
				),
			],
			[
				"topic+permission in §1.7",
				mutate(
					"### 1.7 The reviewer panel\n",
					"### 1.7 The reviewer panel\n\nThe Judge may skip raw findings it considers duplicates.\n",
				),
			],
		];
		for (const [name, text] of cases) assert.notDeepEqual(violations(text, readme), [], `survived: ${name}`);
	});

	it("baseline-first: kills replacement, deletion, duplication, relocation and reordering of settled lines", () => {
		const settled = (row: readonly [string, string, string]): string => {
			const hits = spec.split("\n").filter((line) => digest(line) === row[1]);
			assert.equal(hits.length, 1, `settled line present once: ${row[2]}`);
			return hits[0];
		};
		const author = settled(
			SETTLED_SCAN.find((row) => row[2].startsWith("**The author's non-role.**")) ?? SETTLED_SCAN[0],
		);
		const first14 = settled(SETTLED_SCAN[0]);
		const last14 = settled([...SETTLED_SCAN].reverse().find((row) => row[0] === "1.4") ?? SETTLED_SCAN[0]);
		const coined = settled(SETTLED_COINED[0]);
		const swapped = spec.replace(first14, "\u0000A").replace(last14, first14).replace("\u0000A", last14);
		const cases: Array<[string, string]> = [
			[
				"permission-evading reversal",
				mutate(
					author,
					"**The author's new role.** The author performs the initial adjudication and controls each ruling.",
				),
			],
			["settled line appended to", mutate(author, `${author} The Judge may omit findings.`)],
			["settled line deleted", mutate(`${author}\n`, "")],
			["settled §1.4 paragraphs swapped", swapped],
			["settled coined line duplicated", `${spec}\n${coined}\n`],
			[
				"settled coined line moved into §1.9",
				mutate(`${coined}\n`, "").replace("### 1.9 Finding judgment\n", `### 1.9 Finding judgment\n\n${coined}\n`),
			],
		];
		assert.notEqual(swapped, spec, "swap mutant must change the text");
		for (const [name, text] of cases) assert.notDeepEqual(violations(text, readme), [], `survived: ${name}`);
	});

	it("baseline-first: kills README pointer drift", () => {
		const cases = [
			readme.replace("**future** indexed-bundle completeness", "current indexed-bundle completeness"),
			readme.replace(README_POINTER, `${README_POINTER} The runtime now implements the re-request.`),
			readme.replace(README_POINTER, `${README_POINTER}\n\nThe rawOrdinal partition is live.`),
		];
		for (const prose of cases) assert.notDeepEqual(violations(spec, prose), [], "survived README drift");
	});
});

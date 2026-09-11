/**
 * Brief composition for the composed review round (issue #184,
 * Directive #183) — the caller side of §1.5's dispatch-facts rule
 * applied to §1.7's panel and §1.9's Judge. A brief is a composed
 * document, not a warning surface: everything it embeds is either
 * derived at composition time from the caller's own inputs (form i),
 * or explicitly labelled unverified (form iii) — the bundle and the
 * prior findings, which a provisioned delegate cannot reach any other
 * way, and the provisioned-tree ledger, whose facts were measured in
 * prior rounds rather than derived at composition.
 *
 * DECISION — briefs are composed from caller inputs, never hand-typed
 * per round. What the composition owes is the costs already paid in
 * real rounds (the dispatch-hygiene ledger): the return-slot path in
 * the brief's own words, the CLOSED return schema, the no-hex rule,
 * self-enforced deadlines inside the run bound, out-of-scope and
 * forbidden-remedy fences, deferral homes by number, prior findings
 * labelled UNVERIFIED with the per-finding re-verification demand,
 * the permission for a clean review to be clean, and the
 * provisioned-tree facts (issue #197): no node_modules, no local main
 * ref, private scratch, the archive and git-state bans, and the
 * serial re-run rule. Each is a sentence a real dispatch was once
 * refused or degraded for lacking.
 *
 * DECISION — the reviewer's structured result rides the return's
 * `payload` slot as the closed `{token, findings}` JSON join.ts parses;
 * the Judge's rides the same slot as the closed
 * `{dedupAttested, rulings}` shape resolve.ts parses. The brief states
 * the exact shape rather than pointing at a file the delegate cannot
 * resolve meaning from.
 *
 * NOT here: dispatch mechanics (argv, bounds, provision) — §4.9's, and
 * the round driver's to wire; and any semantic instruction that would
 * make the reviewer adjudicate (§1.7's result grammar is discovery
 * only).
 *
 * Warning-surface roster: EXEMPT — this module composes delegate briefs,
 * whose whole purpose is to embed caller-supplied content (fences, prior
 * findings, the bundle) verbatim into a document; nothing composed here
 * is warned, thrown, or printed by this process — the one consumer is
 * the dispatcher's brief slot, and escaping the content would corrupt
 * the verbatim-embedding contract the round's arms pin.
 */

import type { BundleEntry, Slot } from "./panel.ts";
import type { Manifest } from "./resolve.ts";

/** The self-enforced deadlines a brief states, in seconds from T0. */
export type BriefTiming = { firstReturnSeconds: number; finalReturnSeconds: number };

/**
 * The defaults every real round has run under: a first complete return
 * well inside the run bound, and a hard stop-and-write before it.
 */
export const DEFAULT_TIMING: BriefTiming = { firstReturnSeconds: 900, finalReturnSeconds: 1400 };

/** The caller's fences — what a slot may not raise or propose. */
export type ReviewFences = {
	outOfScope: readonly string[];
	forbiddenRemedies: readonly string[];
	/** Existing deferral homes by number — named so slots do not re-raise them. */
	deferralHomes: readonly string[];
	/** Prior adjudicated findings, embedded labelled UNVERIFIED (§1.5 form iii). */
	priorFindings: readonly { label: string; text: string }[];
};

export type BriefContext = { changeDescription: string };

const PROVISIONED_TREE_FACTS = [
	"YOUR PROVISIONED TREE — facts entering unverified (§1.5 form iii), each learned from a round that",
	"went wrong first; confirm one cheaply where it gates your work:",
	"- It has NO node_modules and no local `main` ref. Run `npm ci` FIRST, before any check: a bare",
	"  `npx biome` on an uninstalled tree resolves a DIFFERENT package and exits 0 — a green that means",
	"  nothing. With no `main` ref, compare against the branch's parent commit, never a ref you lack.",
	"- Scratch space is a private `mktemp -d`, never a bare /tmp path: parallel delegates SHARE /tmp —",
	"  treat any /tmp file you did not create as hostile.",
	"- Never `git archive` a copy (it lacks .git and fails arms by itself); never mutate git state in",
	"  any copy you make.",
	"- Re-run serially before believing a mutant kill or reporting a suite failure — the suite is not",
	"  all-green under parallel load (#119).",
].join("\n");

const RETURN_CONTRACT = [
	"RETURN: write JSON to ../return.json — your cwd is the provisioned tree and the return slot is the",
	"PARENT directory's return.json. The schema is CLOSED:",
	'{"ok": boolean, "summary": string, "reviewedHead": string, "payload": string} — an unknown key',
	"discards the whole return. reviewedHead carries the full hex of `git rev-parse HEAD` and is the ONLY",
	"place a commit hash may appear: NO hex run of 6 or more characters anywhere else in the return —",
	"refer to commits by position labels, never by hash.",
].join("\n");

function deadlines(timing: BriefTiming): string {
	return (
		"DEADLINES (self-enforced): have a first complete ../return.json written by T0+" +
		String(timing.firstReturnSeconds) +
		" seconds; at T0+" +
		String(timing.finalReturnSeconds) +
		" seconds STOP whatever you are doing and write your final ../return.json. A late return is refused unread."
	);
}

function fenceBlock(fences: ReviewFences): string {
	const lines: string[] = [];
	if (fences.outOfScope.length > 0) {
		lines.push(`OUT OF SCOPE — do not raise findings about: ${fences.outOfScope.join("; ")}.`);
	}
	if (fences.forbiddenRemedies.length > 0) {
		lines.push(`FORBIDDEN REMEDIES — never propose: ${fences.forbiddenRemedies.join("; ")}.`);
	}
	if (fences.deferralHomes.length > 0) {
		lines.push(`KNOWN DEFERRALS, filed and adjudicated — do not re-raise: ${fences.deferralHomes.join(", ")}.`);
	}
	return lines.join("\n");
}

function priorFindingsBlock(fences: ReviewFences): string {
	if (fences.priorFindings.length === 0) {
		return "";
	}
	const items = fences.priorFindings.map((prior) => `${prior.label}: ${prior.text}`);
	return [
		"PRIOR FINDINGS — embedded LABELLED UNVERIFIED (§1.5's third form; a provisioned tree cannot reach",
		"the platform record). Re-verify EACH individually with your own commands and state one line per",
		'finding: "<label>: REPAIRED / PARTIALLY-REPAIRED / NOT-REPAIRED / INTRODUCED-A-DEFECT".',
		...items,
	].join("\n");
}

/**
 * One reviewer slot's brief. Discovery only: the composed text carries
 * §1.7's two-token result grammar and nothing that would let the
 * reviewer adjudicate, direct the workflow, or select its own lens.
 */
export function composeReviewerBrief(
	slot: Slot,
	context: BriefContext,
	fences: ReviewFences,
	timing: BriefTiming = DEFAULT_TIMING,
): string {
	return [
		"You are one reviewer slot of a mutually blind review panel.",
		`Your slot: lens ${JSON.stringify(slot.lens)}, surface ${JSON.stringify(slot.surface)}.`,
		"Review ONLY that surface's part of the change under review; other surfaces have their own slots.",
		"",
		`CHANGE UNDER REVIEW: ${context.changeDescription}`,
		"",
		"RESULT GRAMMAR (§1.7): you report what you discovered and nothing about what should follow it.",
		"Exactly two tokens exist: APPROVED — you discovered no finding — and FINDINGS — you discovered at",
		"least one, carried as raw findings. You do not rule validity, severity, cost direction, or",
		"workflow consequence; every consequence derives downstream. A clean review is allowed to be clean —",
		"do not manufacture findings.",
		"",
		'Your structured result rides the return\'s "payload" slot as a JSON STRING of the closed shape',
		'{"token": "APPROVED" | "FINDINGS", "findings": string[]} — findings empty exactly when the token',
		"is APPROVED. Each finding states what you observed, where, and the command whose output shows it.",
		"",
		fenceBlock(fences),
		priorFindingsBlock(fences),
		"",
		PROVISIONED_TREE_FACTS,
		"",
		RETURN_CONTRACT,
		"",
		deadlines(timing),
	].join("\n");
}

/**
 * The Judge's brief: the bundle verbatim (labelled unverified), the
 * caller-derived criterion manifest, the four axes, the evidence
 * obligation, the NIT discipline, and the defer conjunction. The
 * subject line is the round driver's dispatch key and part of this
 * module's contract.
 */
export function composeJudgeBrief(
	bundle: readonly BundleEntry[],
	manifest: Manifest,
	context: BriefContext,
	fences: ReviewFences,
	timing: BriefTiming = DEFAULT_TIMING,
): string {
	const findings = bundle.map(
		(entry, index) =>
			"Finding " +
			String(index + 1) +
			" (slot lens " +
			JSON.stringify(entry.slot.lens) +
			", surface " +
			JSON.stringify(entry.slot.surface) +
			"): " +
			entry.finding,
	);
	const manifestBlock =
		manifest.state === "absent"
			? // An absent manifest never reaches a dispatched Judge: the round
				// driver stops on the missing input (§1.9). Composed anyway so the
				// function is total, and stated as the incompleteness it is.
				"CRITERION MANIFEST: ABSENT — a missing input; the review is incomplete and no adjudication can rule AC impact."
			: manifest.criteria.length === 0
				? [
						"CRITERION MANIFEST (caller-derived): EMPTY — an empty manifest is a manifest (§1.9): rule every",
						"finding to sit on no criterion, attest what was checked, and note that nothing is deferrable on it.",
					].join("\n")
				: ["CRITERION MANIFEST (caller-derived; the set your AC-impact axis reads):", ...manifest.criteria].join("\n");
	return [
		"You are the JUDGE of a review panel (SPEC §1.9). You rule and stop: for a substantive finding the",
		"Judge designs no substantive repair.",
		"",
		`CHANGE UNDER REVIEW: ${context.changeDescription}`,
		"",
		"THE BUNDLE — embedded verbatim, LABELLED UNVERIFIED (§1.5's third form): re-verify every claim with",
		"your own commands; never rule on a slot's say-so.",
		...findings,
		"",
		manifestBlock,
		"",
		"YOUR OBLIGATIONS, all owed (§1.9):",
		"1. DEDUP over the whole bundle — semantically-one raw findings merge into one effective finding with",
		"   EVERY raw finding's provenance preserved; attest the dedup was performed.",
		"2. Rule each effective finding on FOUR axes and no others: Validity (CONFIRMED / REFUTED /",
		"   INDETERMINATE); Severity (SUBSTANTIVE or NIT — a NIT requires an exact mechanical remedy stated",
		"   as part of the ruling: verbatim, local to the flagged span, leaving every commitment",
		"   extensionally unchanged, no design choice left with the receiver); Harm direction on every",
		"   CONFIRMED finding (fail-closed / live-harm — no silence default); AC impact against the manifest",
		"   as a whole.",
		"   NIT REMEDY GRAMMAR: for a NIT's remedy to be mechanically carried forward without a fresh panel",
		"   (§1.9's nit carry-forward), phrase it in one canonical whole-string form and nothing else —",
		'   "replace `<old line>` with `<new line>`" or "delete `<old line>`" — quoting the FULL line',
		"   verbatim, leading whitespace included. A remedy outside this grammar is still a valid ruling, but",
		"   its carry-forward costs a fresh review rather than being applied mechanically.",
		"3. Every ruling carries a required NON-EMPTY evidence field — the exact command you ran and what it",
		"   output, or the citation you rest on. An adjudication without evidence is inadmissible.",
		"4. Before suggesting any finding is deferrable, run the FULL defer conjunction: CONFIRMED and",
		"   SUBSTANTIVE and recorded fail-closed and sitting on NO manifest criterion and manifest non-empty",
		"   and not against the change's own contract.",
		"",
		fenceBlock(fences),
		"",
		PROVISIONED_TREE_FACTS,
		"",
		'Your adjudication rides the return\'s "payload" slot as a JSON STRING of the closed shape',
		'{"dedupAttested": boolean, "rulings": [{"finding": string, "provenance": [{"lens": string,',
		'"surface": string}], "validity": "CONFIRMED" | "REFUTED" | "INDETERMINATE", "severity"?:',
		'"SUBSTANTIVE" | "NIT", "remedy"?: string, "direction"?: "fail-closed" | "live-harm",',
		'"onCriterion"?: boolean, "evidence": string}]} — the optional axes owed exactly when §1.9 owes',
		"them: all four on a CONFIRMED finding, validity plus evidence otherwise.",
		"",
		RETURN_CONTRACT,
		"",
		deadlines(timing),
	].join("\n");
}

/**
 * The review Orchestrator (issue #184, Directive #183) — one composed
 * round of SPEC §1.7/§1.9's pipeline, brief composition, the durable
 * review record, and §1.9's nit carry-forward admissibility check.
 *
 * Every arm kills a specific wrong implementation, named in the arm's
 * own message. The dispatcher is never run here (issue #184 AC6): the
 * round driver takes an injected dispatch function and the arms feed it
 * the outcome shapes §4.9's dispatcher can actually produce, so what is
 * measured is the composition — derivation, blindness to order, the
 * fast path, admission, resolution, the record — not reviewer conduct.
 *
 * The subject-absence anchor: the modules are pulled through guarded
 * dynamic imports and every arm reds on its own authored message rather
 * than a module-resolution crash (the dispatch-module shape).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./harness/run-pi.ts";

const REVIEW_DIR = "/.pi/extensions/gitjig/review/";

type Slot = { lens: string; surface: string };
type BundleEntry = { finding: string; slot: Slot };
type DispatchOutcome =
	| { disposition: "admitted"; ok: boolean; summary: string; payload?: string; compare?: "confirmed" | "invalid" }
	| { disposition: "refused"; cause: string };
type Manifest = { state: "absent" } | { state: "present"; criteria: readonly string[] };
type Ruling = {
	finding: string;
	provenance: Slot[];
	validity: "CONFIRMED" | "REFUTED" | "INDETERMINATE";
	severity?: "SUBSTANTIVE" | "NIT";
	remedy?: string;
	direction?: "fail-closed" | "live-harm";
	onCriterion?: boolean;
	evidence: string;
};
type AdjudicationInput = { dedupAttested: boolean; rulings: Ruling[] };
type ReviewState =
	| { state: "incomplete"; cause: string; missing?: Slot[]; gaps?: string[] }
	| { state: "approved" }
	| {
			state: "resolved";
			resolution: {
				dispositions: { finding: string; disposition: string; remedy?: string }[];
				outcome: string;
			};
	  };
type ReviewRecord = {
	head: string;
	slots: { slot: Slot; valid: boolean; reason?: string }[];
	bundle: BundleEntry[];
	adjudication: AdjudicationInput | null;
	review: ReviewState;
};
type Fences = {
	outOfScope: readonly string[];
	forbiddenRemedies: readonly string[];
	deferralHomes: readonly string[];
	priorFindings: readonly { label: string; text: string }[];
};
type RoundResult = { record: ReviewRecord; recordBody: string; review: ReviewState };

type BriefsModule = {
	DEFAULT_TIMING: { firstReturnSeconds: number; finalReturnSeconds: number };
	composeReviewerBrief(
		slot: Slot,
		context: { changeDescription: string },
		fences: Fences,
		timing?: { firstReturnSeconds: number; finalReturnSeconds: number },
	): string;
	composeJudgeBrief(
		bundle: readonly BundleEntry[],
		manifest: Manifest,
		context: { changeDescription: string },
		fences: Fences,
		timing?: { firstReturnSeconds: number; finalReturnSeconds: number },
	): string;
};
type RecordModule = {
	REVIEW_RECORD_MARKER: string;
	composeReviewRecord(record: ReviewRecord): string;
	parseReviewRecord(body: string): ReviewRecord | undefined;
};
type CarryModule = {
	carryForwardAdmissible(
		record: ReviewRecord,
		patch: string,
	): { admissible: true } | { admissible: false; reasons: string[] };
};
type RunDispatchOptions = {
	callerRepoRoot: string;
	stateRoot: string;
	brief: string;
	delegateArgv: string[];
	expectedRef?: string;
	timeoutMs?: number;
};
type OrchestrateModule = {
	makeDispatcher(
		options: Omit<RunDispatchOptions, "brief" | "expectedRef">,
		run?: (options: RunDispatchOptions) => Promise<DispatchOutcome>,
	): (brief: string, expectedHead: string) => Promise<DispatchOutcome>;
	reviewRound(options: {
		repoRoot: string;
		baseRef: string;
		headRef: string;
		manifest: Manifest;
		fences: Fences;
		changeDescription: string;
		dispatch: (brief: string, expectedHead: string) => Promise<DispatchOutcome>;
	}): Promise<RoundResult>;
};

async function load<T>(name: string): Promise<{ mod?: T; error: string }> {
	try {
		return { mod: (await import(pathToFileURL(`${repoRoot()}${REVIEW_DIR}${name}`).href)) as T, error: "" };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
const briefsLoad = await load<BriefsModule>("briefs.ts");
const recordLoad = await load<RecordModule>("record.ts");
const carryLoad = await load<CarryModule>("carry-forward.ts");
const orchestrateLoad = await load<OrchestrateModule>("orchestrate.ts");

function briefs(): BriefsModule {
	assert.ok(briefsLoad.mod, `briefs.ts did not load — the brief composition is absent or broken: ${briefsLoad.error}`);
	return briefsLoad.mod;
}
function records(): RecordModule {
	assert.ok(
		recordLoad.mod,
		`record.ts did not load — the durable review record is absent or broken: ${recordLoad.error}`,
	);
	return recordLoad.mod;
}
function carry(): CarryModule {
	assert.ok(
		carryLoad.mod,
		`carry-forward.ts did not load — the nit carry-forward check is absent or broken: ${carryLoad.error}`,
	);
	return carryLoad.mod;
}
function orchestrate(): OrchestrateModule {
	assert.ok(
		orchestrateLoad.mod,
		`orchestrate.ts did not load — the round driver is absent or broken: ${orchestrateLoad.error}`,
	);
	return orchestrateLoad.mod;
}

const scratchDirs: string[] = [];
after(() => {
	for (const dir of scratchDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * A throwaway repository whose changed paths route under the COMMITTED
 * policy — the derivation the round driver rides is the real one, so the
 * fixture's paths are chosen to select real rows.
 */
function fixtureRepo(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "gitjig-orch-repo-"));
	scratchDirs.push(dir);
	const git = (...argv: string[]) => execFileSync("git", argv, { cwd: dir, encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@example.invalid");
	git("config", "user.name", "t");
	git("config", "commit.gpgsign", "false");
	writeFileSync(join(dir, "seed.txt"), "seed\n");
	git("add", "-A");
	git("commit", "-qm", "seed");
	for (const [name, body] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), body);
	}
	git("add", "-A");
	git("commit", "-qm", "change");
	return dir;
}

const FENCES: Fences = {
	outOfScope: ["the dispatcher's own internals"],
	forbiddenRemedies: ["a catch-all policy row"],
	deferralHomes: ["#171", "#174"],
	priorFindings: [{ label: "PRIOR-F1", text: "a prior finding text" }],
};

const approvedPayload = JSON.stringify({ token: "APPROVED", findings: [] });
const findingsPayload = (...findings: string[]) => JSON.stringify({ token: "FINDINGS", findings });
const admitted = (payload: string): DispatchOutcome => ({
	disposition: "admitted",
	ok: true,
	summary: "RESULT",
	payload,
	compare: "confirmed",
});
const judgePayload = (rulings: Ruling[]): string => JSON.stringify({ dedupAttested: true, rulings });

/** A dispatch fake that answers reviewer briefs and judge briefs apart. */
function fakeDispatch(
	perSlot: (brief: string) => DispatchOutcome,
	judge?: (brief: string) => DispatchOutcome,
): {
	dispatch: (brief: string, expectedHead: string) => Promise<DispatchOutcome>;
	briefs: string[];
	judgeBriefs: string[];
	pins: string[];
} {
	const seen: string[] = [];
	const judgeSeen: string[] = [];
	const pins: string[] = [];
	return {
		briefs: seen,
		judgeBriefs: judgeSeen,
		pins,
		dispatch: (brief: string, expectedHead: string) => {
			pins.push(expectedHead);
			// The judge brief is recognized by its own composed subject —
			// the arms below pin that subject's presence.
			if (brief.includes("You are the JUDGE")) {
				judgeSeen.push(brief);
				if (judge === undefined) {
					throw new Error("the Judge was dispatched where the arms forbid it");
				}
				return Promise.resolve(judge(brief));
			}
			seen.push(brief);
			return Promise.resolve(perSlot(brief));
		},
	};
}

describe("§1.7/§1.9 brief composition is code, not hand-authoring (issue #184)", () => {
	it("the reviewer brief carries the slot, the closed return contract, and the caller's fences", () => {
		const b = briefs();
		const slot = { lens: "runtime", surface: "the shell's runtime extensions" };
		const text = b.composeReviewerBrief(slot, { changeDescription: "a change description" }, FENCES);
		for (const [needle, why] of [
			["runtime", "the slot's lens — a reviewer must know the lens it is graded on"],
			["the shell's runtime extensions", "the slot's surface"],
			["../return.json", "the return slot path — a dispatch was once refused purely for its absence"],
			['"token"', "the payload's closed reviewer shape"],
			["APPROVED", "the result grammar's first token"],
			["FINDINGS", "the result grammar's second token"],
			[
				"NO hex run of 6 or more characters",
				"the no-hex PROHIBITION itself — round 1's EF8: the bare needle `hex` was satisfied by the unrelated " +
					"reviewedHead sentence, so the prohibition could vanish while the arm stayed green",
			],
			[
				"You do not rule validity, severity, cost direction, or",
				"§1.7's discovery-only restriction — round 2's EF-F: the APPROVED/FINDINGS needles are satisfied by " +
					"the payload-shape line, so the restriction sentence could be deleted whole while the arm stayed green",
			],
			["reviewedHead", "the one home the head hash is allowed"],
			["a change description", "the caller's change description"],
			["the dispatcher's own internals", "the caller's out-of-scope fence"],
			["a catch-all policy row", "the caller's forbidden-remedy fence"],
			["#171", "the deferral homes, by number"],
			["do not re-raise", "the deferral fence's operative instruction"],
			["PRIOR-F1", "the prior finding's label"],
			["UNVERIFIED", "prior findings cross labelled unverified (§1.5's third form)"],
			["REPAIRED / PARTIALLY-REPAIRED / NOT-REPAIRED / INTRODUCED-A-DEFECT", "the per-finding re-verification demand"],
			["clean review is allowed to be clean", "the manufactured-findings fence"],
		] as const) {
			assert.ok(text.includes(needle), `the reviewer brief lost ${why} (missing: ${JSON.stringify(needle)})`);
		}
	});

	it("the brief's deadlines are the timing's, not hardcoded prose", () => {
		const b = briefs();
		const slot = { lens: "suite", surface: "the test suite" };
		const custom = b.composeReviewerBrief(slot, { changeDescription: "x" }, FENCES, {
			firstReturnSeconds: 111,
			finalReturnSeconds: 222,
		});
		assert.ok(
			custom.includes("111") && custom.includes("222"),
			"a caller-supplied timing did not reach the brief — the deadline is composed, not pasted",
		);
		const defaulted = b.composeReviewerBrief(slot, { changeDescription: "x" }, FENCES);
		assert.ok(
			defaulted.includes(String(b.DEFAULT_TIMING.firstReturnSeconds)) &&
				defaulted.includes(String(b.DEFAULT_TIMING.finalReturnSeconds)),
			"the default timing is not the exported DEFAULT_TIMING — two spellings of one deadline drift",
		);
	});

	it("the judge brief embeds every bundle finding verbatim with its provenance, and the manifest's criteria", () => {
		const b = briefs();
		const bundle: BundleEntry[] = [
			{ finding: "zq finding one", slot: { lens: "runtime", surface: "s1" } },
			{ finding: "zq finding two", slot: { lens: "suite", surface: "s2" } },
		];
		const manifest: Manifest = { state: "present", criteria: ["AC1: the first criterion", "AC2: the second"] };
		const text = b.composeJudgeBrief(bundle, manifest, { changeDescription: "the change" }, FENCES);
		for (const entry of bundle) {
			assert.ok(
				text.includes(entry.finding),
				"a bundle finding did not cross into the judge brief verbatim — the Judge adjudicates what it never saw",
			);
			assert.ok(
				text.includes(entry.slot.lens),
				"a finding's provenance lens is missing — dedup preserves which slots reported it",
			);
			assert.ok(
				text.includes(entry.slot.surface),
				"a finding's provenance surface is missing — slot identity is the lens+surface PAIR, and an " +
					"under-provenanced bundle reaches the Judge (round 1's EF10)",
			);
		}
		for (const criterion of manifest.criteria) {
			assert.ok(
				text.includes(criterion),
				"a manifest criterion did not cross — the AC-impact axis is unreachable without it",
			);
		}
		for (const [needle, why] of [
			["You are the JUDGE", "the role subject the round driver keys the judge dispatch on"],
			["UNVERIFIED", "the bundle crosses labelled unverified (§1.5 form iii)"],
			["dedupAttested", "the closed judge payload shape"],
			["evidence", "F15's required non-empty evidence field"],
			["CONFIRMED", "the validity axis"],
			["fail-closed", "the harm-direction axis's first token"],
			["live-harm", "the harm-direction axis's second token"],
			["exact mechanical remedy", "the NIT discipline"],
			["designs no substantive repair", "the Judge's stop rule"],
			[
				"NIT REMEDY GRAMMAR",
				"the canonical remedy grammar carry-forward parses — round 3's EF2: unstated, the exception is live " +
					"only by coincidence of phrasing, an unstated contract between the brief and carry-forward.ts",
			],
			[
				"replace `<old line>` with `<new line>`",
				"the exact canonical replace form the Judge must quote for a nit to carry forward",
			],
			[
				"delete `<old line>`",
				"the delete limb of the canonical grammar — round 4's EF5: unstated, the delete-form half is " +
					"removable on the producer face with the suite green",
			],
			[
				"leading whitespace included",
				"the FULL-line requirement — round 4's EF4: without it the brief instructs a grammar the consumer " +
					"refuses for every indented line (it compares exact line text, no trim)",
			],
			["NO hex run of 6 or more characters", "the no-hex PROHIBITION itself (round 1's EF8)"],
		] as const) {
			assert.ok(text.includes(needle), `the judge brief lost ${why} (missing: ${JSON.stringify(needle)})`);
		}
	});

	/**
	 * Extract ONE composed block and return it whole, for comparison by
	 * EQUALITY rather than by substring (issue #204's EF-2).
	 *
	 * The briefs join their blocks with a blank line, so a block is a
	 * maximal run of lines between blank lines. `includes` cannot see an
	 * addition at the END of a block — the expected literal stays a
	 * substring — and that blind spot is what let a retained second home
	 * of the exculpatory rule survive the ADMISSION arm's substring pin, verbatim OR reworded.
	 * Equality over the extracted block sees both, because it sees the
	 * block's end.
	 *
	 * The extraction refuses what it cannot read rather than reading past
	 * it: exactly one block must open with the given line, or the arm reds
	 * on its own message instead of silently comparing the wrong text.
	 */
	const composedBlock = (document: string, opening: string): string => {
		const blocks = document.split("\n\n").filter((block) => block.startsWith(opening));
		assert.equal(
			blocks.length,
			1,
			`the composed document does not carry exactly one block opening with ${JSON.stringify(opening)} (found ` +
				`${String(blocks.length)}). Zero means the block was dropped or renamed; more than one means the same ` +
				"rule has a second home in this very document, which is the drift the equality pin below exists to catch",
		);
		return blocks[0] as string;
	};

	it("the judge brief carries the admission burden ahead of dedup (issue #196)", () => {
		// Round 1's EF-2: every substring needle over this block survived inverting
		// the very proposition it pinned ('does not establish' -> 'does establish',
		// 'absent' -> 'present', the symmetry burden, the §3.12 limiter) with the
		// suite green. The materially different method: the WHOLE block is pinned
		// as one expected literal, so any intra-block deletion, inversion, or edit
		// reds at once. The literal below is the pin; drifting it is the point.
		const expectedAdmission = [
			"ADMISSION — decided before dedup, because it decides what enters the bundle as an effective",
			"finding at all. A harness or evidence observation is admitted only where you establish one of:",
			"A — actual artifact defect: given state X the artifact produces Y where a settled contract",
			"  requires Z. A state trace suffices; no test is required. Look here FIRST.",
			"B — the check does not establish what its POSITION in the corpus makes it claim. Name",
			"  the claim / the evidence / what it actually observes / why that cannot establish it.",
			"C — explicit contract-required evidence is absent, with the AUTHORITY CITED — an acceptance",
			"  criterion saying 'arms pin ...' is such an authority; so is §3.12's scoped obligation, which",
			"  reaches a guard whose pinning a settled contract requires and no other guard.",
			"Otherwise: RECORD, DO NOT ADMIT. State each recorded-not-admitted observation in your return's",
			"summary with the ground it failed; it enters no ruling and no payload key. The ground is §1.9's",
			'own sentence — "Deliberate absences are recorded as decisions, not omissions" — so no new',
			"disposition exists or is needed. DEMOTE BEFORE DEDUP: an observation already admitted as an",
			"effective finding has no exit but REFUTED, so the ordering is the whole of the token.",
			// The three SYMMETRY lines that closed this block moved OUT of it
			// (issue #204) and into the shared exculpatory block pinned below.
			// They are not deleted — they are re-homed, because the rule binds
			// the reviewer as well and this block reaches only the Judge.
			//
			// Their absence is part of the pin, and round 1's EF-1 is that the
			// previous wording of this sentence claimed a coverage this arm did
			// not have: the assertion was `includes`, so a production that kept
			// the old lines here AND gained the shared block left this literal a
			// substring and the arm GREEN. Measured at that head: that mutant
			// red exactly one arm in the file, and it was not this one.
			//
			// The assertion below is now EQUALITY over the extracted block, so
			// the claim is true as written: a retention here — verbatim or
			// reworded — lengthens the block and reds this arm.
		].join("\n");
		const b = briefs();
		const text = b.composeJudgeBrief(
			[{ finding: "f", slot: { lens: "runtime", surface: "s" } }],
			{ state: "present", criteria: ["AC1"] },
			{ changeDescription: "x" },
			FENCES,
		);
		assert.equal(
			composedBlock(text, "ADMISSION —"),
			expectedAdmission,
			"the judge brief's ADMISSION block is not the expected literal — some clause inside it was deleted, " +
				"inverted, edited, or APPENDED TO; every ground, the record-do-not-admit default with its summary " +
				"channel and §1.9 ground, and the demote-before-dedup ordering are pinned as one whole, END INCLUDED " +
				"(#196 round 1's EF-2: substring needles survived polarity inversion; #204 round 1's EF-1: a substring " +
				"pin over this block could not see a second home of the exculpatory rule appended to it)",
		);
		assert.ok(
			text.indexOf("ADMISSION") < text.indexOf("1. DEDUP"),
			"the admission burden must compose BEFORE the dedup obligation — demote-before-dedup is an ordering, and " +
				"a burden stated after dedup arrives after the decision it governs",
		);
	});

	it("the reviewer brief separates observations from findings without narrowing the search (issue #196)", () => {
		// Whole-block pin, same ground and method as the judge arm above.
		const expectedObservation = [
			"OBSERVATIONS vs FINDINGS: search exactly as aggressively as you otherwise would — this",
			"discipline narrows NOTHING about what you look for. It shapes only the return: an observation",
			"that establishes no actual artifact defect, no failure of a claim its check's position makes,",
			"and no absence of contract-required evidence is reported as an OBSERVATION: carry it in the",
			"return's summary, distinctly labelled OBSERVATION — never as a payload key (the closed shape",
			"discards an unknown key) and never pressed into finding grammar.",
		].join("\n");
		const b = briefs();
		const text = b.composeReviewerBrief({ lens: "runtime", surface: "s" }, { changeDescription: "x" }, FENCES);
		assert.ok(
			text.includes(expectedObservation),
			"the reviewer brief's OBSERVATIONS block is not the expected literal — the not-narrowed half, " +
				"the groundless condition's polarity, the summary channel, or the never-finding-grammar " +
				"prohibition was deleted, inverted, or edited (round 1's EF-2)",
		);
	});

	// ISSUE #204 — the exculpatory-claim burden reaches BOTH briefs.
	//
	// The rule was settled in #195/#196 and composed into the Judge's brief
	// alone, as three lines closing the ADMISSION block. Measured on main
	// (`724cea4`) over the COMPOSED documents, not the source: the reviewer
	// brief contained none of "exculpatory", "SYMMETRY", or "enumeration
	// establishes an enumeration".
	//
	// The party that MAKES a class-closure claim is the reviewer; the Judge
	// only consumes one. The incident the rule came from was a panel's claim
	// — nine hiding shapes killed, closure reported, a tenth shape alive —
	// and the unearned closure then reached §1.4's diagnosis as evidence that
	// ground had been closed, which is the NONE direction: the one value that
	// admits another autonomous repair attempt. So the brief that never
	// carried the rule is the brief whose reader the rule is about.
	//
	// ONE HOME (§3.11), and this pair of arms IS the tie: the expected
	// literal is declared ONCE here and asserted against BOTH composed
	// documents. A production that restated the rule per brief in two
	// wordings reds one of the two arms; a production that drifted the
	// shared constant reds both. No third mechanism is needed for the tie,
	// and none is minted.
	const EXPECTED_EXCULPATORY = [
		"EXCULPATORY CLAIMS — a claim that a defect class is CLOSED carries a finding's own burden.",
		"An enumeration establishes an enumeration, never a class: nine hiding shapes killed is evidence",
		"about nine shapes and is silent about a tenth. Never assert a closure your evidence does not",
		"establish. State it AS a claim with its enumeration attached — what you covered, how, and what",
		"that leaves open — in your return's summary, distinctly labelled. The PROHIBITION is the",
		"load-bearing half and needs no channel: what you may not do is report a class closed. This binds",
		"the claim you make and the claim you are handed — an unearned closure reaches the repair-history",
		"diagnosis (§1.4) as evidence that ground was closed, and NONE is the value that admits another",
		"repair attempt.",
	].join("\n");

	it("the REVIEWER brief carries the exculpatory-claim burden (issue #204)", () => {
		const b = briefs();
		const text = b.composeReviewerBrief({ lens: "runtime", surface: "s" }, { changeDescription: "x" }, FENCES);
		assert.equal(
			composedBlock(text, "EXCULPATORY CLAIMS"),
			EXPECTED_EXCULPATORY,
			"the reviewer brief does not carry the exculpatory-claim block as the expected literal, END INCLUDED. " +
				"The reviewer is the party that MAKES class-closure claims, and a burden told only to the Judge " +
				"arrives after the claim is already asserted as settled — the measured incident is a panel reporting " +
				"a class closed on nine killed shapes with a tenth alive, which then fed §1.4's diagnosis in the NONE " +
				"direction. Equality, not substring: a line APPENDED to this block can weaken the rule while leaving " +
				"every substring pin green (round 1's non-admitted observation (i), closed here rather than left)",
		);
	});

	it("the JUDGE brief carries the SAME exculpatory block, byte for byte — one home, not two wordings (issue #204)", () => {
		const b = briefs();
		const text = b.composeJudgeBrief(
			[{ finding: "f", slot: { lens: "runtime", surface: "s" } }],
			{ state: "present", criteria: ["AC1"] },
			{ changeDescription: "x" },
			FENCES,
		);
		assert.equal(
			composedBlock(text, "EXCULPATORY CLAIMS"),
			EXPECTED_EXCULPATORY,
			"the judge brief does not carry the exculpatory-claim block as the expected literal, END INCLUDED. The " +
				"consumer side of the rule is not optional — the Judge weighs a claim it is handed — and this literal " +
				"is declared once in this file and asserted against both documents, so a per-brief restatement reds " +
				"exactly here",
		);
	});

	it("the exculpatory burden composes with the claim discipline it belongs to, ahead of the mechanics (issue #204)", () => {
		const b = briefs();
		const reviewer = b.composeReviewerBrief({ lens: "runtime", surface: "s" }, { changeDescription: "x" }, FENCES);
		assert.ok(
			reviewer.indexOf("OBSERVATIONS vs FINDINGS") < reviewer.indexOf("EXCULPATORY CLAIMS"),
			"the reviewer's positive-claim discipline and its negative-claim burden are two halves of one rule and " +
				"compose together — the exculpatory block arrived before the observation block, which splits them",
		);
		assert.ok(
			reviewer.indexOf("EXCULPATORY CLAIMS") < reviewer.indexOf("RETURN:"),
			"the reviewer's exculpatory burden composed after the return mechanics — a claim discipline stated " +
				"below the transport contract reads as an afterthought to it",
		);
		const judge = b.composeJudgeBrief(
			[{ finding: "f", slot: { lens: "runtime", surface: "s" } }],
			{ state: "present", criteria: ["AC1"] },
			{ changeDescription: "x" },
			FENCES,
		);
		assert.ok(
			judge.indexOf("ADMISSION") < judge.indexOf("EXCULPATORY CLAIMS"),
			"the judge's exculpatory block composed before the admission burden — the exculpatory rule is what " +
				"admission does with a NEGATIVE claim, so it follows the grounds it is the counterpart of",
		);
		assert.ok(
			judge.indexOf("EXCULPATORY CLAIMS") < judge.indexOf("1. DEDUP"),
			"the judge's exculpatory burden composed after the dedup obligation — like admission, it governs what " +
				"enters the bundle at all, and a burden stated after dedup arrives after the decision it governs",
		);
	});

	it("the exculpatory rule appears EXACTLY ONCE per brief — the re-home is a move, not a copy (issue #204)", () => {
		// WHAT THIS ARM COVERS, re-scoped by round 1's EF-2 — the previous
		// wording claimed it CLOSED the two-homes residual, and that claim was
		// false in a way the arm itself could not see. Its needles are two
		// exact sentences, so a second home stating the same rule in DIFFERENT
		// WORDS contains neither needle, the count stays at one, and the whole
		// file stayed green. Measured at that head: a reworded retention in
		// ADMISSION_BURDEN gave 55/55 pass.
		//
		// The two-homes shape is now carried by the EQUALITY pins above, which
		// see a block's end and therefore see a retention of either wording.
		// What is left for this arm is the case equality cannot reach: a
		// repetition somewhere ELSE in the composed document — a third block,
		// or the same rule restated inside a block this file does not pin.
		//
		// STATED OPEN, not closed: a REWORDED restatement in a block no arm
		// pins is caught by neither mechanism. Equality sees only the blocks
		// named here; a count sees only these two sentences. That is an
		// enumeration of two mechanisms, not a class closure, and no arm in
		// this file should be cited for one.
		const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
		const b = briefs();
		const documents = [
			["reviewer", b.composeReviewerBrief({ lens: "runtime", surface: "s" }, { changeDescription: "x" }, FENCES)],
			[
				"judge",
				b.composeJudgeBrief(
					[{ finding: "f", slot: { lens: "runtime", surface: "s" } }],
					{ state: "present", criteria: ["AC1"] },
					{ changeDescription: "x" },
					FENCES,
				),
			],
		] as const;
		for (const [name, text] of documents) {
			assert.equal(
				occurrences(text, "An enumeration establishes an enumeration"),
				1,
				`the ${name} brief states the enumeration sentence a number of times other than once. Twice means the ` +
					"rule was COPIED into the shared block while its old home was left standing — two homes for one " +
					"property, which drift independently and which no whole-block `includes` pin can see, since a " +
					"trailing addition leaves every such pin green",
			);
			assert.equal(
				occurrences(text, "EXCULPATORY CLAIMS"),
				1,
				`the ${name} brief opens the exculpatory block a number of times other than once`,
			);
		}
	});

	it("the reviewer's claim disciplines add NO payload key — the closed shape is still {token, findings} (issue #204)", () => {
		// The burden's recording half rides the summary channel the observation
		// discipline already names, so it adds no new dependency CLASS on the
		// orchestrator-path gap filed as #203 — and its prohibition half needs
		// no channel at all. What must not have happened is a widening of the
		// closed payload to carry it.
		const b = briefs();
		const text = b.composeReviewerBrief({ lens: "runtime", surface: "s" }, { changeDescription: "x" }, FENCES);
		assert.ok(
			text.includes('{"token": "APPROVED" | "FINDINGS", "findings": string[]}'),
			"the reviewer's closed payload shape changed while adding a claim discipline — the burden rides the " +
				"return's summary, and join.ts discards a return carrying an unknown key",
		);
	});

	it("an empty manifest crosses as an empty manifest, never as absent", () => {
		const b = briefs();
		const text = b.composeJudgeBrief(
			[{ finding: "f", slot: { lens: "runtime", surface: "s" } }],
			{ state: "present", criteria: [] },
			{ changeDescription: "x" },
			FENCES,
		);
		assert.ok(
			/empty/i.test(text) && text.includes("nothing is deferrable"),
			"an empty manifest did not cross as §1.9's empty state — the Judge cannot distinguish it from a missing input",
		);
	});
});

describe("§1.7/§1.9 the composed round (issue #184)", () => {
	it("a findings-free complete round is APPROVED and the Judge is never dispatched", async () => {
		const o = orchestrate();
		const repo = fixtureRepo({ ".pi/x.ts": "x\n", "test/y.test.ts": "y\n" });
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
		const fake = fakeDispatch(() => admitted(approvedPayload));
		const result = await o.reviewRound({
			repoRoot: repo,
			baseRef: "HEAD~1",
			headRef: "HEAD",
			manifest: { state: "present", criteria: ["AC1"] },
			fences: FENCES,
			changeDescription: "zq the round's own change description",
			dispatch: fake.dispatch,
		});
		assert.equal(result.review.state, "approved", "a complete findings-free panel did not end the review APPROVED");
		assert.equal(fake.judgeBriefs.length, 0, "the Judge ran on an empty bundle — §1.9's fast path is gone");
		assert.equal(
			fake.briefs.length,
			2,
			"the derived slot set was not dispatched one brief per slot — the fixture routes runtime and suite",
		);
		// Round 1's EF11: the round arms never inspected composed CONTENT, so
		// wiring substitutions (empty description, empty fences) survived.
		for (const brief of fake.briefs) {
			assert.ok(
				brief.includes("zq the round's own change description"),
				"a dispatched reviewer brief lost the caller's change description — the round composed with an " +
					"operand the caller never supplied",
			);
			assert.ok(
				brief.includes("the dispatcher's own internals"),
				"a dispatched reviewer brief lost the caller's fences — a slot dispatched unfenced re-litigates " +
					"what the caller already closed",
			);
		}
		// Round 1's EF7: every dispatch of the round is pinned to the round's
		// own resolved head.
		assert.deepEqual(
			fake.pins,
			[head, head],
			"a dispatch was pinned to something other than the round's resolved head — a mutable ref advancing " +
				"mid-round would hand each dispatch a different held hash with every compare confirming",
		);
	});

	it("an ABSENT manifest stops the round before any Judge dispatch — a missing input, not an adjudication", async () => {
		const o = orchestrate();
		const repo = fixtureRepo({ ".pi/x.ts": "x\n" });
		const fake = fakeDispatch(() => admitted(findingsPayload("f")));
		const result = await o.reviewRound({
			repoRoot: repo,
			baseRef: "HEAD~1",
			headRef: "HEAD",
			manifest: { state: "absent" },
			fences: FENCES,
			changeDescription: "d",
			dispatch: fake.dispatch,
		});
		assert.equal(
			fake.judgeBriefs.length,
			0,
			"the Judge was dispatched under an absent manifest — round 1's EF4: a delegate run to rule what the " +
				"caller already knows cannot complete",
		);
		assert.equal(result.review.state, "incomplete", "an absent manifest did not leave the review incomplete");
	});

	it("makeDispatcher forwards the round's resolved head as the dispatch pin (round 2's EF-A)", async () => {
		const o = orchestrate();
		const seen: RunDispatchOptions[] = [];
		const spy = (options: RunDispatchOptions): Promise<DispatchOutcome> => {
			seen.push(options);
			return Promise.resolve(admitted(approvedPayload));
		};
		const dispatch = o.makeDispatcher({ callerRepoRoot: "/r", stateRoot: "/s", delegateArgv: ["x"] }, spy);
		await dispatch("the brief text", "the-resolved-head");
		assert.equal(seen.length, 1, "makeDispatcher did not call the dispatcher exactly once");
		assert.equal(
			seen[0].expectedRef,
			"the-resolved-head",
			"makeDispatcher did not forward its expectedHead as the dispatcher's expectedRef — the per-dispatch " +
				"pin is discarded and a mutable ref would be re-resolved per dispatch (round 1's EF7)",
		);
		assert.equal(seen[0].brief, "the brief text", "makeDispatcher did not forward the brief");
	});

	it("the round hands the ADMISSION the caller's manifest — a deferrable ruling defers only on the real one", async () => {
		const o = orchestrate();
		const repo = fixtureRepo({ ".pi/x.ts": "x\n" });
		const finding = "zq deferrable finding";
		const ruling: Ruling = {
			finding,
			provenance: [{ lens: "runtime", surface: "the shell's runtime extensions" }],
			validity: "CONFIRMED",
			severity: "SUBSTANTIVE",
			direction: "fail-closed",
			onCriterion: false,
			evidence: "e",
		};
		const fake = fakeDispatch(
			() => admitted(findingsPayload(finding)),
			() => admitted(judgePayload([ruling])),
		);
		const result = await o.reviewRound({
			repoRoot: repo,
			baseRef: "HEAD~1",
			headRef: "HEAD",
			manifest: { state: "present", criteria: ["a real criterion"] },
			fences: FENCES,
			changeDescription: "d",
			dispatch: fake.dispatch,
		});
		assert.ok(
			result.review.state === "resolved" &&
				result.review.resolution.outcome === "clear" &&
				result.review.resolution.dispositions[0].disposition === "defer",
			"a CONFIRMED+SUBSTANTIVE+fail-closed+off-criterion ruling under a NON-EMPTY manifest did not defer — " +
				"round 1's EF11: an admission run against a substituted empty manifest turns defer into repair, and " +
				"no arm could see it",
		);
	});

	it("a finding draws the Judge with the bundle embedded, and a valid adjudication resolves", async () => {
		const o = orchestrate();
		const repo = fixtureRepo({ ".pi/x.ts": "x\n" });
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
		const finding = "zq the dispatched finding";
		const ruling: Ruling = {
			finding,
			provenance: [{ lens: "runtime", surface: "the shell's runtime extensions" }],
			validity: "REFUTED",
			evidence: "zq the refuting command and its output",
		};
		const fake = fakeDispatch(
			() => admitted(findingsPayload(finding)),
			() => admitted(judgePayload([ruling])),
		);
		const result = await o.reviewRound({
			repoRoot: repo,
			baseRef: "HEAD~1",
			headRef: "HEAD",
			manifest: { state: "present", criteria: ["AC1"] },
			fences: FENCES,
			changeDescription: "d",
			dispatch: fake.dispatch,
		});
		assert.equal(fake.judgeBriefs.length, 1, "a non-empty bundle did not dispatch the Judge exactly once");
		assert.ok(
			fake.judgeBriefs[0].includes(finding),
			"the finding did not cross into the judge brief — the Judge adjudicated a bundle it never saw",
		);
		assert.ok(
			fake.judgeBriefs[0].includes("AC1"),
			"the caller's manifest did not cross into the judge brief — round 1's EF11: a substituted manifest " +
				"survived because no round arm read the composed content",
		);
		// Round 2's EF-A/S1: the Judge dispatch is pinned to the round's own
		// resolved head, exactly as the reviewer dispatches are — not to a
		// mutable ref the dispatcher would re-resolve.
		assert.ok(
			fake.pins.length === 2 && fake.pins.every((pin) => pin === head),
			"a dispatch (reviewer or Judge) was pinned to something other than the round's one resolved head — " +
				"the Judge adjudicating a head other than the panel's breaks the one-head guarantee silently",
		);
		assert.equal(result.review.state, "resolved", "an admitted adjudication did not resolve");
		assert.ok(
			result.review.state === "resolved" && result.review.resolution.outcome === "clear",
			"a REFUTED-only set did not resolve clear — refutation leaves nothing behind (§1.9)",
		);
		assert.deepEqual(
			result.record.bundle,
			[{ finding, slot: { lens: "runtime", surface: "the shell's runtime extensions" } }],
			"the record's bundle is not the panel's — what the history reader consumes must be what was discovered",
		);
		assert.ok(
			result.recordBody.includes("zq the refuting command and its output"),
			"the admitted Ruling's evidence did not reach the record VERBATIM — F15's anchor is the record",
		);
	});

	it("a refused Judge on a non-empty bundle is an incomplete review, never a state the flow passes", async () => {
		const o = orchestrate();
		const repo = fixtureRepo({ ".pi/x.ts": "x\n" });
		const fake = fakeDispatch(
			() => admitted(findingsPayload("f")),
			() => ({ disposition: "refused", cause: "any" }),
		);
		const result = await o.reviewRound({
			repoRoot: repo,
			baseRef: "HEAD~1",
			headRef: "HEAD",
			manifest: { state: "present", criteria: [] },
			fences: FENCES,
			changeDescription: "d",
			dispatch: fake.dispatch,
		});
		assert.equal(result.review.state, "incomplete", "findings with no valid Judge adjudication passed as complete");
	});

	it("an incomplete panel never reaches the Judge", async () => {
		const o = orchestrate();
		const repo = fixtureRepo({ ".pi/x.ts": "x\n", "test/y.test.ts": "y\n" });
		let first = true;
		const fake = fakeDispatch(() => {
			if (first) {
				first = false;
				return admitted(findingsPayload("f"));
			}
			return { disposition: "refused", cause: "any" };
		});
		const result = await o.reviewRound({
			repoRoot: repo,
			baseRef: "HEAD~1",
			headRef: "HEAD",
			manifest: { state: "present", criteria: [] },
			fences: FENCES,
			changeDescription: "d",
			dispatch: fake.dispatch,
		});
		assert.equal(result.review.state, "incomplete", "a panel with a missing slot did not report incomplete");
		assert.equal(
			fake.judgeBriefs.length,
			0,
			"the Judge was dispatched under an incomplete panel — completeness precedes adjudication (§1.7)",
		);
		// Round 1's EF6: §1.7 builds the bundle from every VALID slot, not
		// from complete panels — the durable record must not understate what
		// was discovered.
		assert.deepEqual(
			result.record.bundle.map((entry) => entry.finding),
			["f"],
			"the record of an incomplete panel dropped a valid slot's finding — a later reader cannot tell it " +
				"from the findings-free shape",
		);
		// Round 2's EF-D: the invalid slot's disposition and reason are
		// recorded as the round measured them, not as a constant.
		const invalid = result.record.slots.find((entry) => !entry.valid);
		assert.ok(
			invalid !== undefined && invalid.reason === "malformed return",
			"the record did not carry the invalid slot's valid:false disposition and its reason — a mis-report of " +
				"a refused slot as valid, or a dropped reason, is a false recorded fact the history reader consumes",
		);
	});

	it("the recorded reason is the MEASURED cause, not a constant — a distinct cause records distinctly (round 3's EF-D)", async () => {
		const o = orchestrate();
		const repo = fixtureRepo({ ".pi/x.ts": "x\n" });
		// A slot whose blind compare did not confirm — a different §1.6 cause
		// from the malformed-return one the sibling arm records, so a constant
		// reason cannot satisfy both arms at once.
		const fake = fakeDispatch(() => ({
			disposition: "admitted",
			ok: true,
			summary: "RESULT",
			payload: approvedPayload,
			compare: "invalid",
		}));
		const result = await o.reviewRound({
			repoRoot: repo,
			baseRef: "HEAD~1",
			headRef: "HEAD",
			manifest: { state: "present", criteria: [] },
			fences: FENCES,
			changeDescription: "d",
			dispatch: fake.dispatch,
		});
		const invalid = result.record.slots.find((entry) => !entry.valid);
		assert.ok(
			invalid !== undefined && invalid.reason === "blind compare not confirmed",
			"a blind-compare failure was not recorded with its own reason — a constant reason string would record " +
				"every invalid cause as the same, and the history reader cannot tell a stale head from malformed output",
		);
	});

	it("a routing refusal propagates upstream of any dispatch — no panel state, zero briefs", async () => {
		const o = orchestrate();
		const repo = fixtureRepo({ "zz-unowned.md": "x\n" });
		const fake = fakeDispatch(() => admitted(approvedPayload));
		await assert.rejects(
			o.reviewRound({
				repoRoot: repo,
				baseRef: "HEAD~1",
				headRef: "HEAD",
				manifest: { state: "present", criteria: [] },
				fences: FENCES,
				changeDescription: "d",
				dispatch: fake.dispatch,
			}),
			(error: unknown) =>
				error instanceof Error &&
				"limb" in (error as object) &&
				(error as unknown as { limb: string }).limb === "routing-failure",
			"an unclaimed constituent did not refuse as §1.7's routing failure upstream of the panel",
		);
		assert.equal(fake.briefs.length, 0, "a routing failure dispatched reviewer slots — the refusal is pre-review");
	});

	it("the record pins the head's full hash and survives its own round-trip", async () => {
		const o = orchestrate();
		const r = records();
		const repo = fixtureRepo({ ".pi/x.ts": "x\n" });
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
		const fake = fakeDispatch(() => admitted(approvedPayload));
		const result = await o.reviewRound({
			repoRoot: repo,
			baseRef: "HEAD~1",
			headRef: "HEAD",
			manifest: { state: "present", criteria: [] },
			fences: FENCES,
			changeDescription: "d",
			dispatch: fake.dispatch,
		});
		assert.equal(
			result.record.head,
			head,
			"the record's head is not the reviewed head's full hash — the pin is §1.6's",
		);
		// Round 1's EF12: the round-trip alone is a tautology over whatever
		// the round chose to record — the slots are asserted independently.
		assert.deepEqual(
			result.record.slots,
			[{ slot: { lens: "runtime", surface: "the shell's runtime extensions" }, valid: true }],
			"the record's slot dispositions are not the round's measured ones — an always-empty slots field " +
				"round-trips losslessly and records nothing",
		);
		const parsed = r.parseReviewRecord(result.recordBody);
		assert.ok(parsed, "the composed record body did not parse back — the machine reader cannot consume the record");
		assert.deepEqual(
			parsed,
			result.record,
			"the record round-trip lost content — what Execution (b)'s history instruments read is not what was written",
		);
	});

	it("the head pin is scrubbed of the ambient repo-locating env — a bystander GIT_DIR cannot redirect it (round 7)", async () => {
		const o = orchestrate();
		// The pin resolves via `git rev-parse` under withoutRepoLocatingGitEnv;
		// without the scrub an ambient GIT_DIR beats cwd and the record would
		// pin a repository the caller never named (§1.6, §4.7). A second real
		// repo is the bystander the ambient variable would redirect to.
		const repo = fixtureRepo({ ".pi/x.ts": "x\n" });
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
		const bystander = fixtureRepo({ ".pi/y.ts": "y\n" });
		const bystanderHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: bystander, encoding: "utf8" }).trim();
		assert.notEqual(head, bystanderHead, "the two fixture repos share a head — the bystander cannot show a redirect");
		const savedGitDir = process.env.GIT_DIR;
		process.env.GIT_DIR = join(bystander, ".git");
		try {
			const fake = fakeDispatch(() => admitted(approvedPayload));
			const result = await o.reviewRound({
				repoRoot: repo,
				baseRef: "HEAD~1",
				headRef: "HEAD",
				manifest: { state: "present", criteria: [] },
				fences: FENCES,
				changeDescription: "d",
				dispatch: fake.dispatch,
			});
			assert.equal(
				result.record.head,
				head,
				"the record pinned a head other than the reviewed repo's — an ambient GIT_DIR redirected the pin, so " +
					"the env scrub on reviewRound's rev-parse is not doing its job (a bystander repository's commit " +
					"would key the record and every dispatch)",
			);
		} finally {
			if (savedGitDir === undefined) {
				delete process.env.GIT_DIR;
			} else {
				process.env.GIT_DIR = savedGitDir;
			}
		}
	});
});

describe("the durable review record (issue #184; §1.4, F15)", () => {
	const sample: ReviewRecord = {
		head: "0000000000000000000000000000000000000000",
		slots: [{ slot: { lens: "runtime", surface: "s" }, valid: true }],
		bundle: [{ finding: "zq bundled finding", slot: { lens: "runtime", surface: "s" } }],
		adjudication: {
			dedupAttested: true,
			rulings: [
				{
					finding: "zq bundled finding",
					provenance: [{ lens: "runtime", surface: "s" }],
					validity: "CONFIRMED",
					severity: "NIT",
					remedy: "replace `a` with `b`",
					direction: "fail-closed",
					onCriterion: false,
					evidence: "zq evidence text preserved verbatim",
				},
			],
		},
		review: {
			state: "resolved",
			resolution: {
				dispositions: [{ finding: "zq bundled finding", disposition: "remedy", remedy: "replace `a` with `b`" }],
				outcome: "clear",
			},
		},
	};

	it("the composed body opens with the content marker carrying the head", () => {
		const r = records();
		const body = r.composeReviewRecord(sample);
		assert.ok(
			body.startsWith(`<!-- ${r.REVIEW_RECORD_MARKER}: ${sample.head} -->`),
			"the record body does not open with the marker+head — §2.2's idempotency key is a content marker the " +
				"writer controls, and the head is what pins the record to its review state",
		);
	});

	it("evidence crosses verbatim and the round-trip is lossless", () => {
		const r = records();
		const body = r.composeReviewRecord(sample);
		assert.ok(body.includes("zq evidence text preserved verbatim"), "the Ruling's evidence is not in the body (F15)");
		assert.deepEqual(r.parseReviewRecord(body), sample, "parse(compose(record)) is not the record — the record lies");
	});

	it("a body without the marker parses to nothing — prose is never read as a record", () => {
		const r = records();
		assert.equal(
			r.parseReviewRecord("## an ordinary review comment\nwith prose\n"),
			undefined,
			"an unmarked body parsed as a record — any comment could then impersonate the machine record",
		);
		// Round 1's EF9: the prose fixture above also lacks a fence, so the
		// fence guard alone answered it and the marker check was deletable.
		const fencedUnmarked = r.composeReviewRecord(sample).replace(/<!--[^\n]*-->\n/, "");
		assert.equal(
			r.parseReviewRecord(fencedUnmarked),
			undefined,
			"a fenced but UNMARKED body parsed as a record — the marker is the selector, and without it any " +
				"JSON-bearing comment impersonates the machine record",
		);
	});

	it("a marker head disagreeing with the record's own head parses to nothing (round 1's EF5)", () => {
		const r = records();
		const body = r
			.composeReviewRecord(sample)
			.replace(`${sample.head} -->`, "9999999999999999999999999999999999999999 -->");
		assert.equal(
			r.parseReviewRecord(body),
			undefined,
			"a body whose selector names one head and whose payload pins another parsed anyway — a reader " +
				"selecting by the marker consumes a record for a different review state",
		);
	});

	it("the shape gate is deep — what a consumer reads is what the parse vouched for (round 1's EF3)", () => {
		const r = records();
		const tamper = (edit: (parsed: Record<string, unknown>) => void): string => {
			const body = r.composeReviewRecord(sample);
			const open = body.indexOf("```json\n") + "```json\n".length;
			const close = body.indexOf("\n```", open);
			const parsed = JSON.parse(body.slice(open, close)) as Record<string, unknown>;
			edit(parsed);
			return body.slice(0, open) + JSON.stringify(parsed, null, "\t") + body.slice(close);
		};
		const cases: [string, string][] = [
			[
				"a resolved review without its resolution",
				tamper((parsed) => {
					parsed.review = { state: "resolved" };
				}),
			],
			[
				"an extra top-level key",
				tamper((parsed) => {
					parsed.zz = true;
				}),
			],
			[
				"an adjudication that is a truthy non-object",
				tamper((parsed) => {
					parsed.adjudication = "attested";
				}),
			],
			[
				"a ruling with an empty-object provenance entry",
				tamper((parsed) => {
					((parsed.adjudication as { rulings: { provenance: unknown[] }[] }).rulings[0].provenance as unknown[])[0] =
						{};
				}),
			],
			[
				"a review state outside the three-state set",
				tamper((parsed) => {
					parsed.review = { state: "vibes" };
				}),
			],
		];
		for (const [what, body] of cases) {
			assert.equal(
				r.parseReviewRecord(body),
				undefined,
				`a marked body carrying ${JSON.stringify(what)} parsed — the consumer then reads a shape the gate ` +
					"never vouched for and crashes or misreads instead of refusing",
			);
		}
	});

	it("a marked body whose JSON is tampered into malformation parses to nothing, never to a guess", () => {
		const r = records();
		const body = r.composeReviewRecord(sample).replace('"resolved"', '"resolved'); // break the JSON
		assert.equal(
			r.parseReviewRecord(body),
			undefined,
			"a malformed record parsed anyway — a guessed record is worse than a missing one (fail-closed)",
		);
	});
});

describe("§1.9 nit carry-forward — delta equals remedy, fail-closed (issue #184)", () => {
	const clearRecord = (remedy: string): ReviewRecord => ({
		head: "1111111111111111111111111111111111111111",
		slots: [{ slot: { lens: "runtime", surface: "s" }, valid: true }],
		bundle: [{ finding: "f", slot: { lens: "runtime", surface: "s" } }],
		adjudication: {
			dedupAttested: true,
			rulings: [
				{
					finding: "f",
					provenance: [{ lens: "runtime", surface: "s" }],
					validity: "CONFIRMED",
					severity: "NIT",
					remedy,
					direction: "fail-closed",
					onCriterion: false,
					evidence: "e",
				},
			],
		},
		review: {
			state: "resolved",
			resolution: { dispositions: [{ finding: "f", disposition: "remedy", remedy }], outcome: "clear" },
		},
	});
	const patch = (...lines: string[]) => `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n${lines.join("\n")}\n`;

	it("a delta that is exactly the remedy's verbatim application is admissible", () => {
		const c = carry();
		const record = clearRecord("replace the line `const a = 1;` with `const a = 2;`");
		const verdict = c.carryForwardAdmissible(record, patch("-const a = 1;", "+const a = 2;"));
		assert.ok(verdict.admissible, "the exact verbatim application was refused — the named exception never admits");
	});

	it("a delta with a hunk no remedy accounts for refuses — exceeding the finding draws fresh review", () => {
		const c = carry();
		const record = clearRecord("replace the line `const a = 1;` with `const a = 2;`");
		const verdict = c.carryForwardAdmissible(
			record,
			patch("-const a = 1;", "+const a = 2;", "+const smuggled = true;"),
		);
		assert.ok(
			!verdict.admissible,
			"an unaccounted added line was admitted — the carry-forward's whole justification " +
				"is that the delta is mechanically re-checkable against the ruling text",
		);
	});

	it("a non-clear outcome admits nothing, whatever the delta", () => {
		const c = carry();
		const record = clearRecord("replace the line `const a = 1;` with `const a = 2;`");
		(record.review as { state: string; resolution: { outcome: string } }).resolution.outcome = "repair";
		const verdict = c.carryForwardAdmissible(record, patch("-const a = 1;", "+const a = 2;"));
		assert.ok(!verdict.admissible, "a repair outcome carried forward — the exception is the clear outcome's alone");
	});

	it("an empty delta admits nothing — with no change there is nothing to carry", () => {
		const c = carry();
		const verdict = c.carryForwardAdmissible(clearRecord("replace `a` with `b`"), "");
		assert.ok(
			!verdict.admissible,
			"an empty delta was admitted — the head did not advance, so the original review " +
				"stands on its own and the exception has no subject",
		);
	});

	it("a record with no adjudication admits nothing", () => {
		const c = carry();
		const record = clearRecord("replace `a` with `b`");
		record.adjudication = null;
		const verdict = c.carryForwardAdmissible(record, patch("-a", "+b"));
		assert.ok(
			!verdict.admissible,
			"a record with no adjudication carried forward — there is no ruling text to " +
				"check the delta against, and the check must fail closed",
		);
	});

	it("the REVERSE application refuses — the remedy grammar is directional (round 1's EF1)", () => {
		const c = carry();
		const record = clearRecord("replace the line `const a = 1;` with `const a = 2;`");
		const verdict = c.carryForwardAdmissible(record, patch("-const a = 2;", "+const a = 1;"));
		assert.ok(
			!verdict.admissible,
			"undoing the fix was admitted — an undirected substring check reads both spans as interchangeable, " +
				"and the exception then carries the artifact BACK past the review that demanded the fix",
		);
	});

	it("a substring of the remedy's PROSE does not account — only backticked spans rule (round 1's EF1)", () => {
		const c = carry();
		const record = clearRecord("replace the line `const a = 1;` with `const a = 2;`");
		const verdict = c.carryForwardAdmissible(record, patch("-const a = 1;", "+const a = 2;", "+with"));
		assert.ok(
			!verdict.admissible,
			"a line that is a substring of the remedy's connective prose was admitted — the ruling's spans, not " +
				"its sentence, are what specified the delta",
		);
	});

	it("a whitespace-only changed line refuses — nothing can specify the empty span (round 1's EF1)", () => {
		const c = carry();
		const record = clearRecord("replace the line `const a = 1;` with `const a = 2;`");
		const verdict = c.carryForwardAdmissible(record, patch("-const a = 1;", "+const a = 2;", "+", "+\t"));
		assert.ok(
			!verdict.admissible,
			"blank-line churn rode the exception — an empty span is a substring of everything, so a guard that " +
				"skips it admits a delta no ruling specified",
		);
	});

	it("a content line beginning ++ is still delta — the walk is hunk-aware, not prefix-fooled (round 1's EF1)", () => {
		const c = carry();
		const record = clearRecord("replace the line `const a = 1;` with `const a = 2;`");
		const verdict = c.carryForwardAdmissible(record, patch("-const a = 1;", "+const a = 2;", "+++smuggled"));
		assert.ok(
			!verdict.admissible,
			"an added line whose own content begins with ++ was dropped from the changed set — a prefix-only " +
				"header test reads it as a file header and the smuggled line rides the exception",
		);
	});

	it("a SUBSTANTIVE ruling's remedy text accounts for nothing (round 1's EF2)", () => {
		const c = carry();
		const record = clearRecord("replace the line `const a = 1;` with `const a = 2;`");
		const rulings = (record.adjudication as AdjudicationInput).rulings;
		rulings[0].severity = "SUBSTANTIVE";
		const verdict = c.carryForwardAdmissible(record, patch("-const a = 1;", "+const a = 2;"));
		assert.ok(
			!verdict.admissible,
			"a substantive ruling's text specified a delta — only a NIT carries §1.9's exact mechanical remedy, " +
				"and a substantive repair always draws fresh review",
		);
	});

	it("a re-indentation is a real change, not a verbatim application — the full line is the span (round 3's EF1)", () => {
		const c = carry();
		// Round 2 trimmed both sides, so a re-indent rode the exception. The
		// remedy now quotes the FULL line (leading whitespace included), so a
		// remedy without indentation is not satisfied by a delta that adds it.
		const spanOnly = clearRecord("replace the line `const a = 1;` with `const a = 2;`");
		assert.ok(
			!c.carryForwardAdmissible(spanOnly, patch("-\tconst a = 1;", "+\tconst a = 2;")).admissible,
			"a re-indented application of a span-only remedy was admitted — changed indentation is a real change " +
				"to the YAML and Markdown surfaces the shell ships, not a verbatim replacement",
		);
		// A full-line remedy that DOES quote the indentation, applied
		// verbatim, is the admissible case — the exception stays live.
		const fullLine = clearRecord("replace the line `\tconst a = 1;` with `\tconst a = 2;`");
		assert.ok(
			c.carryForwardAdmissible(fullLine, patch("-\tconst a = 1;", "+\tconst a = 2;")).admissible,
			"a full-line remedy quoting its indentation, applied verbatim, was refused — the exception must stay " +
				"live for the case it exists for",
		);
	});

	it("the arrangement residual is enumerated — a set-equal delta admits; unruled content never does (round 4)", () => {
		const c = carry();
		const record = clearRecord("replace the line `AAA` with `BBB`");
		(record.adjudication as AdjudicationInput).rulings.push({
			finding: "g",
			provenance: [{ lens: "runtime", surface: "s" }],
			validity: "CONFIRMED",
			severity: "NIT",
			remedy: "replace the line `CCC` with `DDD`",
			direction: "fail-closed",
			onCriterion: false,
			evidence: "e",
		});
		// A unified diff does not encode which removed line a given added
		// line replaced, so the swap and the strict application are
		// byte-identical diffs. The enumerated ARRANGEMENT residual
		// (carry-forward.ts header) admits the set-equal swap — bounded
		// because its post-image is composed ENTIRELY of Judge-ruled `new`
		// lines, only re-arranged; no unruled content enters, and an
		// intersecting old/new set (an inversion) refuses separately.
		assert.ok(
			c.carryForwardAdmissible(record, patch("-AAA", "+DDD", "-CCC", "+BBB")).admissible,
			"the set-equal swap did not admit — the enumerated arrangement residual is the documented disposition",
		);
		assert.ok(
			c.carryForwardAdmissible(record, patch("-AAA", "+BBB", "-CCC", "+DDD")).admissible,
			"the two remedies applied verbatim were refused — the exception never admits",
		);
		// The invariant that bounds the residual: an UNRULED added line —
		// content no remedy's `new` names — is never admitted.
		assert.ok(
			!c.carryForwardAdmissible(record, patch("-AAA", "+BBB", "-CCC", "+ZZZ")).admissible,
			"an added line no remedy specifies (ZZZ) was admitted — the multiset equality is what keeps unruled " +
				"content out, and it must hold even while arrangement is a residual",
		);
	});

	it("an inversion refuses — when a remedy's old is another's new, arrangement is load-bearing (round 5's EF2)", () => {
		const c = carry();
		// Two remedies whose old/new sets INTERSECT: `debug: false` is one's
		// new and the other's old. A byte-multiset-equal delta could invert
		// each ruling (flip the flag the opposite way per file), which a
		// unified diff cannot pin — so the intersecting case refuses outright.
		const record = clearRecord("replace the line `  debug: true` with `  debug: false`");
		(record.adjudication as AdjudicationInput).rulings.push({
			finding: "g",
			provenance: [{ lens: "runtime", surface: "s" }],
			validity: "CONFIRMED",
			severity: "NIT",
			remedy: "replace the line `  debug: false` with `  debug: true`",
			direction: "fail-closed",
			onCriterion: false,
			evidence: "e",
		});
		assert.ok(
			!c.carryForwardAdmissible(record, patch("-  debug: true", "+  debug: false", "-  debug: false", "+  debug: true"))
				.admissible,
			"an intersecting old/new set (an inversion is representable) admitted — the check must refuse where " +
				"arrangement can negate a ruling and the diff cannot distinguish it from a verbatim application",
		);
	});

	it("a whitespace-only ruled span refuses — an empty span is no verbatim replacement (round 3's EF3)", () => {
		const c = carry();
		const record = clearRecord("replace the line ` ` with `x`");
		assert.ok(
			!c.carryForwardAdmissible(record, patch("- ", "+x")).admissible,
			"a remedy whose old span is whitespace was applied — a blank line is not an exact mechanical span, and " +
				"admitting it lets blank churn balance the operation set",
		);
		// Round 5's EF3: the NEW-span whitespace guard, not just the old side.
		const blankNew = clearRecord("replace the line `AAA` with ` `");
		assert.ok(
			!c.carryForwardAdmissible(blankNew, patch("-AAA", "+ ")).admissible,
			"a remedy whose NEW span is whitespace was applied — replacing a line with a blank line is not an exact " +
				"mechanical span either, and the added-side guard must refuse it",
		);
	});

	it("the canonical grammar is case-insensitive and space-tolerant — both live, so both are pinned (round 5's EF3)", () => {
		const c = carry();
		// REPLACE_FORM's /i flag and the remedy.trim() are live affordances an
		// ordinary Judge phrasing reaches; an arm pins them so a later edit
		// removing either turns liveness into a silent false-refuse.
		const capitalized = clearRecord("Replace the line `AAA` with `BBB`");
		assert.ok(
			c.carryForwardAdmissible(capitalized, patch("-AAA", "+BBB")).admissible,
			"a capitalized 'Replace' was refused — REPLACE_FORM's case-insensitivity is live and an ordinary Judge " +
				"sentence starts with a capital",
		);
		const padded = clearRecord("  replace the line `AAA` with `BBB`  ");
		assert.ok(
			c.carryForwardAdmissible(padded, patch("-AAA", "+BBB")).admissible,
			"a remedy with surrounding whitespace was refused — remedy.trim() is live and a stored ruling may carry " +
				"incidental padding",
		);
	});

	it("a NIT ruling with a missing remedy refuses the whole carry-forward (round 3's EF4)", () => {
		const c = carry();
		const record = clearRecord("replace the line `AAA` with `BBB`");
		(record.adjudication as AdjudicationInput).rulings.push({
			finding: "g",
			provenance: [{ lens: "runtime", surface: "s" }],
			validity: "CONFIRMED",
			severity: "NIT",
			evidence: "e",
		});
		assert.ok(
			!c.carryForwardAdmissible(record, patch("-AAA", "+BBB")).admissible,
			"a record with a bare NIT (no remedy) carried forward — §1.9 rules a remedy-less NIT an incomplete " +
				"adjudication, so the record is not a clean nit-only re-issue and must refuse",
		);
	});

	it("a REFUTED ruling is no part of the delta — it neither contributes an operation nor blocks (round 3's EF4)", () => {
		const c = carry();
		const record = clearRecord("replace the line `AAA` with `BBB`");
		(record.adjudication as AdjudicationInput).rulings.push({
			finding: "g",
			provenance: [{ lens: "runtime", surface: "s" }],
			validity: "REFUTED",
			evidence: "the refuting command",
		});
		assert.ok(
			c.carryForwardAdmissible(record, patch("-AAA", "+BBB")).admissible,
			"a refuted ruling beside a verbatim-applied NIT blocked the carry-forward — a refutation leaves " +
				"nothing behind (§1.9) and is no part of the delta",
		);
	});

	it("a remedy outside the recognized grammar refuses — even when the delta is a substring of its prose (round 2's EF-E)", () => {
		const c = carry();
		// The changed lines ARE substrings of the remedy prose, so a check
		// that fell open by treating the raw prose as the ruled corpus would
		// admit this — the canonical-grammar refusal must not.
		const record = clearRecord("reword `old wording` to `new wording` somehow");
		const verdict = c.carryForwardAdmissible(record, patch("-old wording", "+new wording"));
		assert.ok(
			!verdict.admissible,
			"a non-canonical remedy admitted a delta drawn from its own prose — a derivation-phrased remedy is " +
				"exactly what the check cannot verify, and the conservative cost is one fresh review",
		);
		// Round 3's EF3: an unanchored REPLACE_FORM would parse a negated
		// "do not replace `a` with `b`" and reopen EF-C; this pins the anchor.
		const negated = clearRecord("do not replace `a` with `b`");
		assert.ok(
			!c.carryForwardAdmissible(negated, patch("-a", "+b")).admissible,
			"a negated 'do not replace `a` with `b`' parsed as a replace operation — REPLACE_FORM's whole-string " +
				"anchor is what keeps a negated clause out of the grammar",
		);
	});

	it("one ruled span does not license repeated application — the multiset carries cardinality (round 2's EF-B)", () => {
		const c = carry();
		const record = clearRecord("replace the line `const a = 1;` with `const a = 2;`");
		const verdict = c.carryForwardAdmissible(
			record,
			patch("-const a = 1;", "+const a = 2;", "+const a = 2;", "+const a = 2;"),
		);
		assert.ok(
			!verdict.admissible,
			"three applications of a one-line remedy were admitted — a containment check with no cardinality lets " +
				"one ruled span license an unbounded delta the ruling never specified",
		);
	});

	it("remedies are per-ruling, not pooled — a hybrid of two remedies is neither (round 2's EF-B)", () => {
		const c = carry();
		const record = clearRecord("replace the line `AAA` with `BBB`");
		const rulings = (record.adjudication as AdjudicationInput).rulings;
		rulings.push({
			finding: "g",
			provenance: [{ lens: "runtime", surface: "s" }],
			validity: "CONFIRMED",
			severity: "NIT",
			remedy: "replace the line `CCC` with `DDD`",
			direction: "fail-closed",
			onCriterion: false,
			evidence: "e",
		});
		const hybrid = c.carryForwardAdmissible(record, patch("-AAA", "+DDD"));
		assert.ok(
			!hybrid.admissible,
			"a hybrid delta (-AAA/+DDD) that is neither recorded remedy was admitted — pooling spans across rulings " +
				"loses the per-ruling binding, so the delta matched a union no single ruling specified",
		);
		// Applying BOTH remedies fully is the admissible case, so the arm
		// pins the refusal to the hybrid, not to two-ruling records at large.
		const both = c.carryForwardAdmissible(record, patch("-AAA", "+BBB", "-CCC", "+DDD"));
		assert.ok(both.admissible, "applying both recorded remedies verbatim was refused — the exception never admits");
	});

	it("a negated or compound remedy is not canonical — the span it says to KEEP cannot be removed (round 2's EF-C)", () => {
		const c = carry();
		const record = clearRecord("replace `foo` with `bar`; do not remove `baz`");
		const verdict = c.carryForwardAdmissible(record, patch("-baz"));
		assert.ok(
			!verdict.admissible,
			"a compound remedy carrying a negated 'do not remove `baz`' promoted `baz` into the removable set — a " +
				"prose scan reads the verb inside a clause that forbade the very removal, so the delta removed the " +
				"span the ruling told the author to keep",
		);
	});

	it("a delete-form remedy applied verbatim admits; an unruled removal does not (round 4's EF5)", () => {
		const c = carry();
		const record = clearRecord("delete the line `const dead = true;`");
		assert.ok(
			c.carryForwardAdmissible(record, patch("-const dead = true;")).admissible,
			"a verbatim delete-form application was refused — the delete limb of the canonical grammar must admit " +
				"its own verbatim application",
		);
		assert.ok(
			!c.carryForwardAdmissible(record, patch("-const other = 1;")).admissible,
			"a removal of a line the delete remedy does not name was admitted — the removed multiset must equal " +
				"the ruled `old` set",
		);
		// Round 6's EF-S2: the delete limb's case-insensitivity and its
		// `remove` alternative are live affordances a Judge reaches; pin both.
		assert.ok(
			c.carryForwardAdmissible(clearRecord("Delete the line `const dead = true;`"), patch("-const dead = true;"))
				.admissible,
			"a capitalized 'Delete' was refused — DELETE_FORM's /i is live and an ordinary Judge sentence capitalizes",
		);
		assert.ok(
			c.carryForwardAdmissible(clearRecord("remove the line `const dead = true;`"), patch("-const dead = true;"))
				.admissible,
			"a 'remove'-phrased delete remedy was refused — the `remove` alternative is a live limb of the grammar",
		);
	});

	it("a compound remedy with an extra span is not canonical — the backtick span class is exact (round 6's EF-R2)", () => {
		const c = carry();
		// `[^`]+` (not `.+`) is what keeps a span from swallowing a second
		// "with `...`" clause. A greedy class would parse this compound
		// remedy as old="AAA` with `BBB", new="ZZZ" and admit a delta.
		const record = clearRecord("replace the line `AAA` with `BBB` with `ZZZ`");
		assert.ok(
			!c.carryForwardAdmissible(record, patch("-AAA` with `BBB", "+ZZZ")).admissible,
			"a compound remedy carrying a second `with` span parsed and admitted — the span class must be " +
				"backtick-exclusive so a non-canonical remedy refuses uniformly",
		);
	});

	it("the canonical replace form's optional parts are live — both phrasings admit (round 6's EF-S3)", () => {
		const c = carry();
		assert.ok(
			c.carryForwardAdmissible(clearRecord("replace `AAA` with `BBB`"), patch("-AAA", "+BBB")).admissible,
			"the bare 'replace `x` with `y`' (no 'the line') was refused — the (?: the line)? group is optional and " +
				"an ordinary Judge omits it",
		);
		assert.ok(
			c.carryForwardAdmissible(clearRecord("replace the line `AAA` with `BBB`."), patch("-AAA", "+BBB")).admissible,
			"a trailing period was refused — the trailing `\\.?` is live and a Judge may end the sentence with one",
		);
	});

	it("the check runs on real `git diff` output, not only hand-built patches (round 4's EF2)", () => {
		const c = carry();
		// A real repository, a real one-line replacement, a real `git diff` —
		// the shape round 4's EF1 lived in and the hand-built patch() helper
		// cannot express (interior context, real hunk headers).
		const repo = fixtureRepo({ "f.txt": "alpha\nbeta\ngamma\n" });
		writeFileSync(join(repo, "f.txt"), "alpha\nBETA\ngamma\n");
		const realDiff = execFileSync("git", ["-C", repo, "diff", "--", "f.txt"], { encoding: "utf8" });
		const record = clearRecord("replace the line `beta` with `BETA`");
		assert.ok(
			c.carryForwardAdmissible(record, realDiff).admissible,
			"a real one-line git-diff verbatim application was refused — the check must run on the diff shape git " +
				"actually emits (interior context, real hunk header), not only the single-hunk patch() helper",
		);
		writeFileSync(join(repo, "f.txt"), "alpha\nBETA\nGAMMA\n");
		const exceeding = execFileSync("git", ["-C", repo, "diff", "--", "f.txt"], { encoding: "utf8" });
		assert.ok(
			!c.carryForwardAdmissible(record, exceeding).admissible,
			"a real git-diff whose delta exceeds the one recorded remedy (a second line changed) was admitted — " +
				"the multiset equality must catch the excess in real output too",
		);
	});

	it("a real MULTI-FILE git diff admits a verbatim two-remedy application — file headers are not content (round 6's EF-R3)", () => {
		const c = carry();
		// The `inHunk = false` reset on each diff-header line is what keeps
		// the SECOND file's ---/+++ headers out of the content multisets; a
		// single-file diff cannot exercise it, so this uses two files.
		const repo = fixtureRepo({ "one.txt": "AAA\n", "two.txt": "CCC\n" });
		writeFileSync(join(repo, "one.txt"), "BBB\n");
		writeFileSync(join(repo, "two.txt"), "DDD\n");
		const realDiff = execFileSync("git", ["-C", repo, "diff", "--", "one.txt", "two.txt"], { encoding: "utf8" });
		const record = clearRecord("replace the line `AAA` with `BBB`");
		(record.adjudication as AdjudicationInput).rulings.push({
			finding: "g",
			provenance: [{ lens: "runtime", surface: "s" }],
			validity: "CONFIRMED",
			severity: "NIT",
			remedy: "replace the line `CCC` with `DDD`",
			direction: "fail-closed",
			onCriterion: false,
			evidence: "e",
		});
		assert.ok(
			c.carryForwardAdmissible(record, realDiff).admissible,
			"a verbatim two-file application was refused — the second file's diff headers were read as content " +
				"because the per-entry hunk reset is unpinned",
		);
	});

	it("an all-REFUTED clear record against an empty delta refuses on the empty-delta conjunct (round 4's EF2)", () => {
		const c = carry();
		const record = clearRecord("replace `a` with `b`");
		// Make the sole ruling REFUTED: no remedy operations remain, so only
		// the empty-delta conjunct stands between this and a vacuous admit.
		const rulings = (record.adjudication as AdjudicationInput).rulings;
		rulings[0] = {
			finding: "f",
			provenance: [{ lens: "runtime", surface: "s" }],
			validity: "REFUTED",
			evidence: "the refuting command",
		};
		assert.ok(
			!c.carryForwardAdmissible(record, "").admissible,
			"an all-REFUTED clear record with an empty delta admitted — the empty-delta refusal is the only guard " +
				"here (no remedy operations exist), and it must hold",
		);
	});
});

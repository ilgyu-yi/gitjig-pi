/**
 * The review outcome half (issue #177, Directive #166) — the behavioural
 * boundaries SPEC §1.9 fixes for the bundle → Judge → Resolver pipeline,
 * plus the DispatchOutcome → SlotResult join §1.6/§1.7 fix for the panel's
 * one producer (issue #173's checklist, subsumed by #177).
 *
 * Every arm exists to kill a named wrong implementation, stated in the
 * arm's own message. The subject modules may not exist on the tree, so
 * they are pulled through guarded dynamic imports and every arm reds on
 * its own authored message rather than a module-resolution crash — the
 * same subject-absence anchor the panel suite uses, for the same reason.
 *
 * NOT measured here, so a reader does not over-read it: the Judge's own
 * conduct (a dispatched semantic actor — this file pins what the CALLER
 * admits of its return, never how it rules); §1.4's history-diagnosis
 * capacity (asleep, §5.3); and the dispatcher's own arms, which live in
 * `dispatch-module` and which issue #177 must leave untouched.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./harness/run-pi.ts";

const REVIEW_DIR = "/.pi/extensions/gitjig/review/";
const DISPATCH_DIR = "/.pi/extensions/gitjig/dispatch/";

// ---------------------------------------------------------------------------
// Mirror types. The modules brand their own; the suite mirrors shapes and
// casts, exactly as the panel suite does — a dynamic import cannot see the
// brands, and that boundary is itself pinned by the brand-presence arm below.
// ---------------------------------------------------------------------------

type Slot = { lens: string; surface: string };
type Compare = "confirmed" | "invalid" | "absent";
type ReviewerReturn = { token: "APPROVED" | "FINDINGS"; findings: string[] } | { failure: "timeout" | "malformed" };
type SlotResult = { slot: Slot; compare: Compare; returned: ReviewerReturn };
type PanelOutcome =
	| { outcome: "incomplete"; missing: Slot[] }
	| { outcome: "approved" }
	| { outcome: "bundle"; bundle: { finding: string; slot: Slot }[] };
type DispatchOutcome =
	| { disposition: "admitted"; ok: boolean; summary: string; payload?: string; compare?: "confirmed" | "invalid" }
	| { disposition: "refused"; cause: string };

type Validity = "CONFIRMED" | "REFUTED" | "INDETERMINATE";
type Direction = "fail-closed" | "live-harm";
type Ruling = {
	finding: string;
	provenance: Slot[];
	validity: Validity;
	severity?: "SUBSTANTIVE" | "NIT";
	remedy?: string;
	direction?: Direction;
	onCriterion?: boolean;
	evidence?: string;
};
type Manifest = { state: "absent" } | { state: "present"; criteria: readonly string[] };
type AdjudicationInput = { dedupAttested: boolean; rulings: Ruling[] };
type Disposition = "repair" | "defer" | "remedy" | "measure-escalate" | "none";
type Resolution = {
	dispositions: { finding: string; disposition: Disposition; remedy?: string }[];
	outcome: "repair" | "measure-escalate" | "clear";
};
type AdmitResult = { complete: true; adjudication: unknown } | { complete: false; gaps: string[] };
type ReviewState =
	| {
			state: "incomplete";
			cause: "panel" | "adjudication-missing" | "adjudication-incomplete";
			missing?: Slot[];
			gaps?: string[];
	  }
	| { state: "approved" }
	| { state: "resolved"; resolution: Resolution };

type PanelModule = {
	receive(slot: Slot, compare: Compare, returned: ReviewerReturn): SlotResult;
	decideValidity(result: SlotResult, slot: Slot): { valid: boolean; reason?: string };
	panelOutcome(results: SlotResult[], required: Slot[]): PanelOutcome;
};
type JoinModule = {
	reviewerReturnFromPayload(payload: string | undefined): ReviewerReturn;
	slotResultFromDispatch(slot: Slot, outcome: DispatchOutcome): SlotResult;
	dispatchSlot(
		slot: Slot,
		options: {
			callerRepoRoot: string;
			stateRoot: string;
			brief: string;
			delegateArgv: string[];
			expectedRef?: string;
			timeoutMs?: number;
		},
	): Promise<SlotResult>;
};
type ResolveModule = {
	adjudicationFromPayload(payload: string | undefined): AdjudicationInput | undefined;
	adjudicationFromDispatch(outcome: DispatchOutcome): AdjudicationInput | undefined;
	admitAdjudication(input: AdjudicationInput, manifest: Manifest): AdmitResult;
	resolve(adjudication: unknown): Resolution;
	reviewOutcome(panel: PanelOutcome, admission: AdmitResult | undefined): ReviewState;
};
type AdmitModule = { REFUSAL_CAUSES: Record<string, string> };

async function tryImport<T>(path: string): Promise<{ module?: T; error: string }> {
	try {
		return { module: (await import(pathToFileURL(path).href)) as T, error: "" };
	} catch (error) {
		return { module: undefined, error: error instanceof Error ? error.message : String(error) };
	}
}

const panelImport = await tryImport<PanelModule>(`${repoRoot()}${REVIEW_DIR}panel.ts`);
const joinImport = await tryImport<JoinModule>(`${repoRoot()}${REVIEW_DIR}join.ts`);
const resolveImport = await tryImport<ResolveModule>(`${repoRoot()}${REVIEW_DIR}resolve.ts`);
const admitImport = await tryImport<AdmitModule>(`${repoRoot()}${DISPATCH_DIR}admit.ts`);

function panel(): PanelModule {
	assert.ok(panelImport.module, `the landed panel module failed to import: ${panelImport.error}`);
	return panelImport.module;
}
function joins(): JoinModule {
	assert.ok(
		joinImport.module,
		`the dispatch→slot join does not exist at ${REVIEW_DIR}join.ts — issue #173 measured that the widened ` +
			`payload channel has no reader and §1.6's absent compare no home, and issue #177 owes the join. ` +
			`Import reported: ${joinImport.error}`,
	);
	return joinImport.module;
}
function resolves(): ResolveModule {
	assert.ok(
		resolveImport.module,
		`the adjudication/Resolver module does not exist at ${REVIEW_DIR}resolve.ts — SPEC §1.9 says "the Judge ` +
			`and Resolver instruments derive later per §1.2's macro-phase clause", and issue #177 is that ` +
			`derivation. Import reported: ${resolveImport.error}`,
	);
	return resolveImport.module;
}
function refusalCauses(): Record<string, string> {
	assert.ok(admitImport.module, `the dispatcher's admit module failed to import: ${admitImport.error}`);
	return admitImport.module.REFUSAL_CAUSES;
}

// ---------------------------------------------------------------------------
// Scratch registry (the panel suite's shape: leak-free by construction).
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];
after(() => {
	for (const dir of scratchDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});
function scratchDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	scratchDirs.push(dir);
	return dir;
}

const GIT_FLAGS = ["-c", "user.name=zq", "-c", "user.email=zq@zq.zq", "-c", "commit.gpgsign=false"];
function mintCallerRepo(files: Record<string, string>): string {
	const repo = scratchDir("gitjig-join-caller-");
	execFileSync("git", ["init", "-q", "-b", "main", repo], { encoding: "utf8" });
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(repo, name), content);
	}
	execFileSync("git", ["-C", repo, ...GIT_FLAGS, "add", "."], { encoding: "utf8" });
	execFileSync("git", ["-C", repo, ...GIT_FLAGS, "commit", "-q", "-m", "zq join fixture"], { encoding: "utf8" });
	return repo;
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const SLOT: Slot = { lens: "runtime", surface: ".pi/" };
const OTHER_SLOT: Slot = { lens: "suite", surface: "test/" };

const FINDINGS_PAYLOAD = JSON.stringify({ token: "FINDINGS", findings: ["zq join finding"] });
const APPROVED_PAYLOAD = JSON.stringify({ token: "APPROVED", findings: [] });

const admitted = (over: Partial<Extract<DispatchOutcome, { disposition: "admitted" }>> = {}): DispatchOutcome => ({
	disposition: "admitted",
	ok: true,
	summary: "zq summary",
	payload: FINDINGS_PAYLOAD,
	compare: "confirmed",
	...over,
});

const ruling = (over: Partial<Ruling> = {}): Ruling => ({
	finding: "zq effective finding",
	provenance: [SLOT],
	validity: "CONFIRMED",
	severity: "SUBSTANTIVE",
	direction: "live-harm",
	onCriterion: true,
	...over,
});

const MANIFEST: Manifest = { state: "present", criteria: ["zq criterion one", "zq criterion two"] };
const EMPTY_MANIFEST: Manifest = { state: "present", criteria: [] };

function completeAdjudication(rulings: Ruling[], manifest: Manifest = MANIFEST): unknown {
	const r = resolves();
	const admission = r.admitAdjudication({ dedupAttested: true, rulings }, manifest);
	assert.ok(admission.complete, `fixture adjudication unexpectedly incomplete: ${JSON.stringify(admission)}`);
	return admission.adjudication;
}

function bundleOutcome(): PanelOutcome {
	const p = panel();
	return p.panelOutcome([p.receive(SLOT, "confirmed", { token: "FINDINGS", findings: ["zq raw finding"] })], [SLOT]);
}

// ---------------------------------------------------------------------------
// The join: DispatchOutcome → SlotResult (§1.6, §1.7; issue #173).
// ---------------------------------------------------------------------------

describe("§1.6/§1.7 the dispatch→slot join — the widened channel's reviewer-side reader (issues #177, #173)", () => {
	it("the three compare states map distinctly, and only `confirmed` is valid — the absent case has a home", () => {
		const j = joins();
		const p = panel();
		for (const [wire, mapped] of [
			["confirmed", "confirmed"],
			["invalid", "invalid"],
			[undefined, "absent"],
		] as [("confirmed" | "invalid") | undefined, Compare][]) {
			const result = j.slotResultFromDispatch(SLOT, admitted({ compare: wire }));
			assert.equal(
				result.compare,
				mapped,
				`a DispatchOutcome compare of ${String(wire)} did not map to ${mapped} — §1.6 rules a mismatched, ` +
					"ABSENT, or unconfirmable head invalid, and a mapping that collapses absent into invalid (or " +
					"either into confirmed) loses the state §1.6 names",
			);
			const verdict = p.decideValidity(result, SLOT);
			assert.equal(
				verdict.valid,
				mapped === "confirmed",
				`a ${mapped} compare was ruled ${verdict.valid ? "valid" : "invalid"} — only the caller's own ` +
					"confirmed compare admits a result (§1.6)",
			);
		}
	});

	it("a valid FINDINGS payload crosses whole: the join records the slot the CALLER dispatched and the reviewer's findings", () => {
		const j = joins();
		const p = panel();
		const result = j.slotResultFromDispatch(SLOT, admitted());
		assert.deepEqual(result.slot, SLOT, "the join recorded a slot other than the one the caller dispatched");
		assert.deepEqual(
			result.returned,
			{ token: "FINDINGS", findings: ["zq join finding"] },
			"the reviewer's structured result did not survive the payload crossing intact",
		);
		const outcome = p.panelOutcome([result], [SLOT]);
		assert.equal(outcome.outcome, "bundle", "a valid joined FINDINGS result did not reach the panel's outcome");
	});

	it("a valid APPROVED payload joins to a result the panel reads as satisfied", () => {
		const j = joins();
		const p = panel();
		const result = j.slotResultFromDispatch(SLOT, admitted({ payload: APPROVED_PAYLOAD }));
		assert.equal(
			p.panelOutcome([result], [SLOT]).outcome,
			"approved",
			"a joined APPROVED result did not satisfy its slot on the findings-free path",
		);
	});

	it("every malformed payload shape maps to the malformed cause — never a throw, never a silent approve", () => {
		const j = joins();
		const p = panel();
		const shapes: [string, string | undefined][] = [
			["a missing payload on an admitted return", undefined],
			["non-JSON bytes", "zq not json"],
			["a JSON scalar", JSON.stringify(7)],
			["a JSON null", "null"],
			["an unknown key", JSON.stringify({ token: "APPROVED", findings: [], zqExtra: 1 })],
			["a token outside the two-token set", JSON.stringify({ token: "MAYBE", findings: [] })],
			["findings that are not an array", JSON.stringify({ token: "FINDINGS", findings: "zq" })],
			["a non-string finding element", JSON.stringify({ token: "FINDINGS", findings: [7] })],
			["a missing findings key", JSON.stringify({ token: "APPROVED" })],
		];
		for (const [shape, payload] of shapes) {
			const result = j.slotResultFromDispatch(SLOT, admitted({ payload }));
			assert.deepEqual(
				result.returned,
				{ failure: "malformed" },
				`${shape} did not map to the malformed cause — §1.7 names malformed/unparseable output as its own ` +
					"invalidity cause, and a join that throws (or admits the shape) loses the cause the caller " +
					"decides re-dispatch on",
			);
			assert.equal(
				p.decideValidity(result, SLOT).reason,
				"malformed return",
				`${shape} did not reach decideValidity as the malformed cause`,
			);
		}
	});

	it("a token/findings contradiction passes the parse and is ruled by decideValidity's own grammar branch (§3.11)", () => {
		const j = joins();
		const p = panel();
		// One contract, one validation surface: the grammar contradiction is
		// §1.6's and decideValidity is its one spelling. A parse that re-rules
		// it is a second predicate, and it collapses two of §1.7's
		// distinguishable causes into one.
		const contradictory = j.slotResultFromDispatch(
			SLOT,
			admitted({ payload: JSON.stringify({ token: "APPROVED", findings: ["zq smuggled"] }) }),
		);
		assert.deepEqual(
			contradictory.returned,
			{ token: "APPROVED", findings: ["zq smuggled"] },
			"a well-formed contradictory payload was re-ruled at the parse — the grammar contradiction is " +
				"decideValidity's one branch, and a second spelling here is the §3.11 divergence engine",
		);
		assert.equal(
			p.decideValidity(contradictory, SLOT).reason,
			"APPROVED carrying findings contradicts its own token",
			"the contradiction did not reach the grammar branch that owns it",
		);
	});

	it("a delegate-reported failed run (ok:false) is malformed — a failed run vouches for nothing", () => {
		const j = joins();
		const result = j.slotResultFromDispatch(SLOT, admitted({ ok: false }));
		assert.deepEqual(
			result.returned,
			{ failure: "malformed" },
			"an ok:false return joined as a reviewer result — the delegate's own failure claim means the payload " +
				"has no valid producer, and reading it anyway acts on output its author disowned",
		);
	});

	it("refusals map totally: the bound-exceeded class is the timeout cause, every other cause is malformed", () => {
		const j = joins();
		const p = panel();
		const causes = refusalCauses();
		assert.ok(Object.keys(causes).length >= 6, "the dispatcher's exported refusal-cause set shrank unexpectedly");
		for (const [name, cause] of Object.entries(causes)) {
			const result = j.slotResultFromDispatch(SLOT, { disposition: "refused", cause });
			const expected = name === "boundExceeded" ? "timeout" : "malformed";
			assert.deepEqual(
				result.returned,
				{ failure: expected },
				`the refusal cause ${name} did not map to ${expected} — §1.7 names timed-out as its own cause, and ` +
					"the mapping is enumerated over the dispatcher's exported causes so a new cause cannot land unmapped",
			);
			assert.equal(result.compare, "absent", `a refused dispatch (${name}) recorded a compare it never ran`);
			assert.equal(p.decideValidity(result, SLOT).valid, false, `a refused dispatch (${name}) was ruled valid`);
		}
		// Total over causes the enumeration does not know: a novel cause is
		// still no result, mapped to malformed rather than thrown on.
		const novel = j.slotResultFromDispatch(SLOT, { disposition: "refused", cause: "zq some future cause" });
		assert.deepEqual(novel.returned, { failure: "malformed" }, "an unenumerated refusal cause escaped the mapping");
	});

	it("the success path is measured through runDispatch: a stub delegate's payload joins to a valid SlotResult (#173)", async () => {
		const j = joins();
		const p = panel();
		// The reviewer result crosses as committed tree content (the dispatch
		// suite's own discipline), with the provisioned HEAD substituted in by
		// the delegate so the blind compare confirms.
		const template = JSON.stringify({
			ok: true,
			summary: "zq slot review done",
			reviewedHead: "@HEAD@",
			payload: FINDINGS_PAYLOAD,
		});
		const repo = mintCallerRepo({ "zq-return-template.json": template });
		const result = await j.dispatchSlot(SLOT, {
			callerRepoRoot: repo,
			stateRoot: scratchDir("gitjig-join-state-"),
			brief: "zq join brief: write the templated return",
			delegateArgv: ["sh", "-c", 'sed "s/@HEAD@/$(git rev-parse HEAD)/" zq-return-template.json > ../return.json'],
			expectedRef: "main",
		});
		assert.equal(result.compare, "confirmed", "the live blind compare did not confirm through the join");
		assert.equal(p.decideValidity(result, SLOT).valid, true, "the joined live result was not valid");
		const outcome = p.panelOutcome([result], [SLOT]);
		assert.deepEqual(
			"bundle" in outcome ? outcome.bundle : [],
			[{ finding: "zq join finding", slot: SLOT }],
			"the delegate's finding did not come out the far side of runDispatch → join → panel — the widened " +
				"channel's success path is the join's own arm, not the widening's",
		);
	});

	it("a delegate that outlives its bound joins to the timeout cause, through the real dispatcher", async () => {
		const j = joins();
		const p = panel();
		const repo = mintCallerRepo({ "zq-seed.txt": "zq\n" });
		const result = await j.dispatchSlot(SLOT, {
			callerRepoRoot: repo,
			stateRoot: scratchDir("gitjig-join-state-"),
			brief: "zq join brief: outlive the bound",
			delegateArgv: ["sh", "-c", "sleep 5"],
			expectedRef: "main",
			timeoutMs: 300,
		});
		assert.deepEqual(
			result.returned,
			{ failure: "timeout" },
			"a bound-exceeded dispatch did not join to §1.7's timed-out cause",
		);
		assert.equal(p.decideValidity(result, SLOT).reason, "timed out", "the timeout cause did not reach decideValidity");
	});
});

// ---------------------------------------------------------------------------
// The adjudication contract (§1.9: the Judge's return, as the caller admits it).
// ---------------------------------------------------------------------------

describe("§1.9 the adjudication contract — what the caller admits of a Judge return (issue #177)", () => {
	it("an absent criterion manifest is a missing input, not an empty set — the adjudication is incomplete", () => {
		const r = resolves();
		const admission = r.admitAdjudication({ dedupAttested: true, rulings: [ruling()] }, { state: "absent" });
		assert.equal(
			admission.complete,
			false,
			"an adjudication with no criterion manifest was admitted — §1.9 makes absent and empty distinct states, " +
				"and an absent manifest is the missing input the review is incomplete on, never adjudicated without",
		);
		assert.ok(
			!admission.complete && admission.gaps.some((gap) => /^the criterion manifest is absent/.test(gap)),
			"the absent-manifest gap is not named in the admission's own gaps — the matcher anchors the authored " +
				"sentence, because a single loose word is satisfied by an omnibus message naming no axis at all",
		);
	});

	it("unattested dedup is an incomplete adjudication — the Resolver reads the attestation, never derives it", () => {
		const r = resolves();
		const admission = r.admitAdjudication({ dedupAttested: false, rulings: [ruling()] }, MANIFEST);
		assert.equal(admission.complete, false, "an adjudication without attested dedup was admitted (§1.9)");
		assert.ok(
			!admission.complete && admission.gaps.some((gap) => /^dedup is not attested/.test(gap)),
			"the unattested-dedup gap is not named in its authored words",
		);
	});

	it("an effective finding with empty provenance is incomplete — dedup merges and never discards", () => {
		const r = resolves();
		const admission = r.admitAdjudication(
			{
				dedupAttested: true,
				rulings: [
					ruling({ provenance: [] }),
					{ finding: "zq refuted with no provenance", provenance: [], validity: "REFUTED" },
				],
			},
			MANIFEST,
		);
		assert.equal(
			admission.complete,
			false,
			"an effective finding carrying no raw provenance was admitted — provenance is what lets a later reader " +
				"tell one reviewer's finding from four reviewers' agreement without the merge having been a vote",
		);
		assert.ok(
			!admission.complete && admission.gaps.some((gap) => /^ruling 0: provenance is empty/.test(gap)),
			"the empty-provenance gap is not named in its authored words",
		);
		assert.ok(
			!admission.complete && admission.gaps.some((gap) => /^ruling 1: provenance is empty/.test(gap)),
			"the REFUTED ruling's empty provenance was not named — dedup is owed on the whole bundle, whatever the " +
				"rulings that follow (§1.9), so an implementation that returns on the non-CONFIRMED validity before " +
				"measuring provenance admits a merge that discarded what it merged",
		);
	});

	it("a NIT without an exact mechanical remedy leaves the severity axis unruled — incomplete, never disposed", () => {
		const r = resolves();
		for (const bad of [ruling({ severity: "NIT", remedy: undefined }), ruling({ severity: "NIT", remedy: "" })]) {
			const admission = r.admitAdjudication({ dedupAttested: true, rulings: [bad] }, MANIFEST);
			assert.equal(
				admission.complete,
				false,
				"a bare NIT token with no remedy was admitted — §1.9 makes the remedy part of the ruling, not a note " +
					"beside it, and a NIT without one leaves the axis unruled",
			);
			assert.ok(
				!admission.complete &&
					admission.gaps.some((gap) => /^ruling 0: a NIT ruling carries no exact mechanical remedy/.test(gap)),
				"the NIT gap is not named in its authored words",
			);
		}
	});

	it("a CONFIRMED finding with no direction ruling is incomplete — there is no silence default", () => {
		const r = resolves();
		const admission = r.admitAdjudication(
			{ dedupAttested: true, rulings: [ruling({ direction: undefined })] },
			MANIFEST,
		);
		assert.equal(
			admission.complete,
			false,
			"a confirmed finding with an unstated harm direction was admitted — §1.9: an unstated direction is a " +
				"missing ruling, not a value, and it is never filled in by whoever reads the record next",
		);
		assert.ok(
			!admission.complete && admission.gaps.some((gap) => /^ruling 0: harm direction is unruled/.test(gap)),
			"the unruled-direction gap is not named in its authored words",
		);
	});

	it("a CONFIRMED finding missing severity or AC impact is incomplete — all four axes are owed", () => {
		const r = resolves();
		for (const [axis, bad, pattern] of [
			["severity", ruling({ severity: undefined }), /^ruling 0: severity is unruled/],
			["AC impact", ruling({ onCriterion: undefined }), /^ruling 0: AC impact is unruled/],
		] as [string, Ruling, RegExp][]) {
			const admission = r.admitAdjudication({ dedupAttested: true, rulings: [bad] }, MANIFEST);
			assert.equal(admission.complete, false, `a confirmed finding with ${axis} unruled was admitted`);
			assert.ok(!admission.complete && admission.gaps.some((gap) => pattern.test(gap)), `the ${axis} gap is not named`);
		}
	});

	it("REFUTED and INDETERMINATE owe validity alone — a ruling without the other axes is complete", () => {
		const r = resolves();
		const admission = r.admitAdjudication(
			{
				dedupAttested: true,
				rulings: [
					{ finding: "zq refuted", provenance: [SLOT], validity: "REFUTED" },
					{ finding: "zq undecided", provenance: [OTHER_SLOT], validity: "INDETERMINATE" },
				],
			},
			MANIFEST,
		);
		assert.equal(
			admission.complete,
			true,
			"a REFUTED or INDETERMINATE ruling was held to axes §1.9 does not owe on it — completeness is all four " +
				"axes on a CONFIRMED finding and validity alone otherwise",
		);
	});

	it("the Judge payload parse admits only the closed shape — anything else is no adjudication", () => {
		const r = resolves();
		// deepEqual against the authored input, never a truthy check: a parse
		// that EMPTIES the ruling set or FORGES the dedup attestation is
		// truthy, and the attestation is §1.9's one readable completeness
		// fact — the fixture carries `false` so a forging parse cannot hide
		// behind the common case.
		const authored = { dedupAttested: false, rulings: [ruling()] };
		assert.deepEqual(
			r.adjudicationFromPayload(JSON.stringify(authored)),
			authored,
			"the parse did not return the authored input intact — a parse that rewrites the rulings or the dedup " +
				"attestation forges the facts §1.9 makes the Resolver read",
		);
		for (const [shape, payload] of [
			["a missing payload", undefined],
			["non-JSON bytes", "zq not json"],
			["a JSON null", "null"],
			["a non-boolean dedupAttested", JSON.stringify({ dedupAttested: "no", rulings: [] })],
			["a non-set severity", JSON.stringify({ dedupAttested: true, rulings: [{ ...ruling(), severity: "MEDIUM" }] })],
			["a non-string remedy", JSON.stringify({ dedupAttested: true, rulings: [{ ...ruling(), remedy: 7 }] })],
			[
				"a non-boolean onCriterion",
				JSON.stringify({ dedupAttested: true, rulings: [{ ...ruling(), onCriterion: "yes" }] }),
			],
			[
				"a non-object provenance element",
				JSON.stringify({ dedupAttested: true, rulings: [{ ...ruling(), provenance: [7] }] }),
			],
			[
				"a provenance element with a non-string lens",
				JSON.stringify({ dedupAttested: true, rulings: [{ ...ruling(), provenance: [{ lens: 1, surface: "s" }] }] }),
			],
			[
				"an extra key on a provenance element",
				JSON.stringify({ dedupAttested: true, rulings: [{ ...ruling(), provenance: [{ ...SLOT, zqExtra: 1 }] }] }),
			],
			["an unknown top-level key", JSON.stringify({ dedupAttested: true, rulings: [], zqExtra: 1 })],
			["an unknown ruling key", JSON.stringify({ dedupAttested: true, rulings: [{ ...ruling(), zqExtra: 1 }] })],
			[
				"a validity outside the three-token set",
				JSON.stringify({ dedupAttested: true, rulings: [{ ...ruling(), validity: "MAYBE" }] }),
			],
			[
				"a direction outside the two-token set",
				JSON.stringify({ dedupAttested: true, rulings: [{ ...ruling(), direction: "fail-open" }] }),
			],
			[
				"a non-array provenance",
				JSON.stringify({ dedupAttested: true, rulings: [{ ...ruling(), provenance: "runtime" }] }),
			],
		] as [string, string | undefined][]) {
			assert.equal(
				r.adjudicationFromPayload(payload),
				undefined,
				`${shape} parsed as an adjudication — the review layer's payload contract is closed for the same ` +
					"reason admit.ts's schema is: a minimum-match admits a surface no contract bounds",
			);
		}
	});

	it("the wire path carries the attestation end to end — an unattested payload parses and is refused at admission", () => {
		const r = resolves();
		// The direct-call arms above feed admitAdjudication literals; this one
		// walks payload → parse → admission, so a parse that forges the
		// attestation cannot pass while the direct arms stay green.
		const parsed = r.adjudicationFromPayload(JSON.stringify({ dedupAttested: false, rulings: [ruling()] }));
		assert.ok(parsed, "the well-formed unattested payload did not parse");
		const admission = r.admitAdjudication(parsed as AdjudicationInput, MANIFEST);
		assert.equal(
			admission.complete,
			false,
			"an unattested dedup crossed the wire into a complete admission — the attestation is a recorded fact " +
				"the Resolver reads, and the wire must carry it faithfully end to end",
		);
		assert.ok(
			!admission.complete && admission.gaps.some((gap) => /^dedup is not attested/.test(gap)),
			"the wire-carried unattested dedup is not named in its authored words",
		);
	});

	it("the admitted adjudication is detached — post-admission mutation of the caller's input reaches nothing", () => {
		const r = resolves();
		const input = { dedupAttested: true, rulings: [ruling({ direction: "fail-closed", onCriterion: false })] };
		const admission = r.admitAdjudication(input, MANIFEST);
		assert.ok(admission.complete, "fixture admission unexpectedly incomplete");
		const before = r.resolve(admission.adjudication);
		// The exploit class the panel's constructors are cured of: rewrite
		// the ruling the caller still holds, empty its provenance, and push a
		// forged ruling — none of it may reach the branded snapshot.
		const held = input.rulings[0] as Ruling;
		held.validity = "REFUTED";
		held.provenance.length = 0;
		input.rulings.push(ruling({ finding: "zq forged after admission" }));
		assert.deepEqual(
			r.resolve(admission.adjudication),
			before,
			"a post-admission mutation of the caller's rulings array, a ruling object, or a provenance array reached " +
				"the branded adjudication — the brand certifies a snapshot the completeness test never ruled on",
		);
		assert.equal(before.dispositions.length, 1, "the forged ruling entered the disposition set");
		// The Resolver never reads provenance, so the resolve() comparison
		// above cannot see a provenance-only alias — assert the snapshot
		// directly: it is §1.9's load-bearing record of which slots reported
		// the finding, and an aliased array is one the caller just emptied.
		assert.deepEqual(
			(admission.adjudication as unknown as { rulings: Ruling[] }).rulings[0]?.provenance,
			[SLOT],
			"emptying the caller's provenance array reached the branded adjudication — the provenance the Judge " +
				"attested dedup on is rewritable after admission",
		);
	});

	it("a Judge return is admitted only off a confirmed compare — the Judge rides §1.6 like any reviewer", () => {
		const r = resolves();
		const judgePayload = JSON.stringify({ dedupAttested: true, rulings: [ruling()] });
		assert.ok(
			r.adjudicationFromDispatch(admitted({ payload: judgePayload })),
			"a confirmed, well-formed Judge return did not admit",
		);
		for (const [shape, outcome] of [
			["a failed compare", admitted({ payload: judgePayload, compare: "invalid" })],
			["an absent compare", admitted({ payload: judgePayload, compare: undefined })],
			["a refused dispatch", { disposition: "refused", cause: "zq cause" } as DispatchOutcome],
			["an ok:false return", admitted({ payload: judgePayload, ok: false })],
			["a junk payload", admitted({ payload: "zq junk" })],
		] as [string, DispatchOutcome][]) {
			assert.equal(
				r.adjudicationFromDispatch(outcome),
				undefined,
				`${shape} yielded an adjudication — §1.9 names 'returned invalid under the same compare the panel ` +
					"rides' as Judge unavailability, and an unavailable Judge is an incomplete review, never a ruling",
			);
		}
	});
});

// ---------------------------------------------------------------------------
// The Resolver (§1.9: function, not a role).
// ---------------------------------------------------------------------------

describe("§1.9 validity evidence rides the ruling — the operator's F15 ruling (issue #179)", () => {
	// The ruling, fixed by the operator on PR #178's escalation: evidence is
	// part of the Judge ruling itself, owed on EVERY validity — §1.9's own
	// words retain a REFUTED finding "with its refuting command" and record
	// each validity ruling "with the command it ran or the citation it
	// rests on". Admission checks presence and shape only; nothing
	// deterministic evaluates the content; the field rides the snapshot
	// verbatim as the reconsideration anchor.
	const evidenced = (over: Partial<Ruling> = {}): Ruling => ({
		finding: "zq evidenced finding",
		provenance: [SLOT],
		validity: "CONFIRMED",
		severity: "SUBSTANTIVE",
		direction: "live-harm",
		onCriterion: true,
		evidence: "zq evidence: node --test ran red, then green",
		...over,
	});

	it("the closed wire shape REQUIRES evidence — a ruling without it, or with a non-string one, is no adjudication", () => {
		const r = resolves();
		const good = { dedupAttested: true, rulings: [evidenced()] };
		assert.deepEqual(
			r.adjudicationFromPayload(JSON.stringify(good)),
			good,
			"an evidence-bearing payload did not parse intact — the wire shape must carry the field the ruling " +
				"makes part of the ruling itself",
		);
		const { evidence: _dropped, ...bare } = evidenced();
		for (const [shape, rulings] of [
			["a ruling with no evidence key", [bare]],
			["a ruling with a non-string evidence", [evidenced({ evidence: 7 as never })]],
		] as [string, unknown[]][]) {
			assert.equal(
				r.adjudicationFromPayload(JSON.stringify({ dedupAttested: true, rulings })),
				undefined,
				`${shape} parsed as an adjudication — evidence is a required key of the closed shape, and a ruling ` +
					"that cannot say what it rests on is not a ruling this layer admits",
			);
		}
	});

	it("empty evidence is an incomplete adjudication on EVERY validity — a REFUTED retention owes its refuting command too", () => {
		const r = resolves();
		for (const validity of ["CONFIRMED", "REFUTED", "INDETERMINATE"] as Validity[]) {
			const one =
				validity === "CONFIRMED"
					? evidenced({ evidence: "" })
					: ({ finding: "zq bare", provenance: [SLOT], validity, evidence: "" } as Ruling);
			const admission = r.admitAdjudication({ dedupAttested: true, rulings: [one] }, MANIFEST);
			assert.equal(
				admission.complete,
				false,
				`a ${validity} ruling with empty evidence was admitted — §1.9 records each validity ruling with the ` +
					"command it ran or the citation it rests on, and there is no validity whose ruling owes none",
			);
			assert.ok(
				!admission.complete && admission.gaps.some((gap) => /^ruling 0: validity evidence is empty/.test(gap)),
				`the ${validity} empty-evidence gap is not named in its authored words`,
			);
		}
	});

	it("the Resolver never reads the evidence — two adjudications differing only in its text resolve identically", () => {
		const r = resolves();
		const admit = (evidence: string) =>
			r.admitAdjudication(
				{ dedupAttested: true, rulings: [evidenced({ direction: "fail-closed", onCriterion: false, evidence })] },
				MANIFEST,
			);
		const one = admit("zq: grep returned zero hits");
		const other = admit("zq: an entirely different command trail");
		assert.ok(one.complete && other.complete, "the evidence-bearing fixtures should admit");
		assert.deepEqual(
			one.complete && r.resolve(one.adjudication),
			other.complete && r.resolve(other.adjudication),
			"the Resolver's answer moved with the evidence TEXT — evaluating evidence is a semantic act, and the " +
				"ruling assigns it to no deterministic component",
		);
	});

	it("the admitted evidence rides the branded snapshot verbatim — the reconsideration anchor survives the copy", () => {
		const r = resolves();
		const anchor = "zq\tanchor — bytes intact";
		const input = { dedupAttested: true, rulings: [evidenced({ evidence: anchor })] };
		const admission = r.admitAdjudication(input, MANIFEST);
		assert.ok(admission.complete, "the fixture admission should be complete");
		(input.rulings[0] as Ruling).evidence = "zq rewritten after admission";
		assert.equal(
			(admission.adjudication as unknown as { rulings: Ruling[] }).rulings[0]?.evidence,
			anchor,
			"the evidence did not survive the detachment copy verbatim — it is §1.9 reconsideration's anchor, and " +
				"an aliased or dropped field hands the anchor to whoever still holds the caller's object",
		);
	});
});

describe("§1.9 the Resolver — five dispositions, fixed precedence, no semantic act (issue #177)", () => {
	it("each validity/severity/direction/manifest cell takes exactly its §1.9 disposition", () => {
		const r = resolves();
		const cases: [string, Ruling, Manifest, Disposition][] = [
			[
				"REFUTED",
				ruling({ validity: "REFUTED", severity: undefined, direction: undefined, onCriterion: undefined }),
				MANIFEST,
				"none",
			],
			[
				"INDETERMINATE",
				ruling({ validity: "INDETERMINATE", severity: undefined, direction: undefined, onCriterion: undefined }),
				MANIFEST,
				"measure-escalate",
			],
			[
				"confirmed NIT",
				ruling({ severity: "NIT", remedy: "zq exact remedy", direction: "fail-closed", onCriterion: false }),
				MANIFEST,
				"remedy",
			],
			[
				"confirmed substantive live-harm off-criterion",
				ruling({ direction: "live-harm", onCriterion: false }),
				MANIFEST,
				"repair",
			],
			[
				"confirmed substantive fail-closed ON a criterion",
				ruling({ direction: "fail-closed", onCriterion: true }),
				MANIFEST,
				"repair",
			],
			[
				"confirmed substantive fail-closed off-criterion",
				ruling({ direction: "fail-closed", onCriterion: false }),
				MANIFEST,
				"defer",
			],
			[
				"the same finding under an EMPTY manifest",
				ruling({ direction: "fail-closed", onCriterion: false }),
				EMPTY_MANIFEST,
				"repair",
			],
		];
		for (const [name, one, manifest, expected] of cases) {
			const resolution = r.resolve(completeAdjudication([one], manifest));
			assert.equal(
				resolution.dispositions[0]?.disposition,
				expected,
				`${name} did not dispose to ${expected} — the five dispositions are §1.9's own cells: defer requires ` +
					"fail-closed AND off-manifest AND a non-empty manifest (nothing is deferrable against an empty " +
					"one), live-harm never defers, and a finding against the change's own contract never defers",
			);
		}
	});

	it("an all-REFUTED set resolves clear — no independent blocking verdict survives refutation", () => {
		const r = resolves();
		const resolution = r.resolve(
			completeAdjudication([
				ruling({
					finding: "zq r1",
					validity: "REFUTED",
					severity: undefined,
					direction: undefined,
					onCriterion: undefined,
				}),
				ruling({
					finding: "zq r2",
					validity: "REFUTED",
					severity: undefined,
					direction: undefined,
					onCriterion: undefined,
				}),
			]),
		);
		assert.equal(
			resolution.outcome,
			"clear",
			"all-refuted findings did not resolve clear — §1.6 gives no reviewer result a gate of its own, so " +
				"refutation leaves nothing behind; the old design's surviving blocking verdict is the retired defect",
		);
		assert.ok(
			resolution.dispositions.every((d) => d.disposition === "none"),
			"a refuted finding took a disposition other than none",
		);
	});

	it("the outcome precedence is fixed and total: repair, else measure-escalate, else clear", () => {
		const r = resolves();
		const repairR = ruling({ finding: "zq repair", direction: "live-harm" });
		const indet = ruling({
			finding: "zq indet",
			validity: "INDETERMINATE",
			severity: undefined,
			direction: undefined,
			onCriterion: undefined,
		});
		const deferR = ruling({ finding: "zq defer", direction: "fail-closed", onCriterion: false });
		const nit = ruling({
			finding: "zq nit",
			severity: "NIT",
			remedy: "zq remedy",
			direction: "fail-closed",
			onCriterion: false,
		});
		const refuted = ruling({
			finding: "zq refuted",
			validity: "REFUTED",
			severity: undefined,
			direction: undefined,
			onCriterion: undefined,
		});
		for (const [name, set, expected] of [
			["repair beats everything", [repairR, indet, deferR, nit, refuted], "repair"],
			["measure-escalate beats the rest", [indet, deferR, nit, refuted], "measure-escalate"],
			["deferrals + remedies + refutations are clear", [deferR, nit, refuted], "clear"],
		] as [string, Ruling[], Resolution["outcome"]][]) {
			assert.equal(
				r.resolve(completeAdjudication(set)).outcome,
				expected,
				`${name} — the fixed precedence (repair > measure-escalate > clear) gives a mixed set exactly one answer`,
			);
		}
	});

	it("an INDETERMINATE finding can become neither an approval nor an author repair", () => {
		const r = resolves();
		const resolution = r.resolve(
			completeAdjudication([
				ruling({
					finding: "zq undecided",
					validity: "INDETERMINATE",
					severity: undefined,
					direction: undefined,
					onCriterion: undefined,
				}),
			]),
		);
		assert.equal(
			resolution.dispositions[0]?.disposition,
			"measure-escalate",
			"INDETERMINATE did not route to measurement/escalation",
		);
		assert.notEqual(
			resolution.outcome,
			"clear",
			"an INDETERMINATE finding dissolved into a clear outcome by someone's silence",
		);
	});

	it("validity precedes severity — a non-CONFIRMED ruling carrying NIT axes still leaves nothing behind", () => {
		const r = resolves();
		// ADMISSIBLE input, not a contrivance: §1.9 owes validity alone on a
		// REFUTED or INDETERMINATE ruling and forbids no extra axis, so a
		// ruling carrying NIT + remedy beside a non-CONFIRMED validity passes
		// admission — and a disposition that reads severity first hands the
		// author work off a false positive ("REFUTED … leaves nothing
		// behind" inverted).
		const resolution = r.resolve(
			completeAdjudication([
				ruling({
					finding: "zq refuted with nit axes",
					validity: "REFUTED",
					severity: "NIT",
					remedy: "zq remedy",
					direction: undefined,
					onCriterion: undefined,
				}),
				ruling({
					finding: "zq undecided with nit axes",
					validity: "INDETERMINATE",
					severity: "NIT",
					remedy: "zq remedy",
					direction: undefined,
					onCriterion: undefined,
				}),
			]),
		);
		assert.deepEqual(
			resolution.dispositions.map((entry) => entry.disposition),
			["none", "measure-escalate"],
			"a non-CONFIRMED ruling carrying NIT axes was disposed by its severity — §1.9's dispositions key on " +
				"validity FIRST, and a hoisted severity branch applies a remedy nothing confirmed",
		);
		assert.equal(resolution.outcome, "measure-escalate", "the outcome followed the hoisted branch");
	});

	it("the Resolver is deterministic and order-independent for a fixed adjudicated input", () => {
		const r = resolves();
		const set = [
			ruling({ finding: "zq a", direction: "fail-closed", onCriterion: false }),
			ruling({ finding: "zq b", severity: "NIT", remedy: "zq remedy b", direction: "fail-closed", onCriterion: false }),
			ruling({
				finding: "zq c",
				validity: "REFUTED",
				severity: undefined,
				direction: undefined,
				onCriterion: undefined,
			}),
		];
		const once = r.resolve(completeAdjudication(set));
		const twice = r.resolve(completeAdjudication(set));
		assert.deepEqual(
			once,
			twice,
			"two runs over one adjudicated input diverged — the Resolver is a function, not a role",
		);
		const permuted = r.resolve(completeAdjudication([...set].reverse()));
		assert.equal(permuted.outcome, once.outcome, "the outcome depends on the order findings arrive in");
		const byFinding = (res: Resolution) => new Map(res.dispositions.map((d) => [d.finding, d.disposition]));
		assert.deepEqual(
			byFinding(permuted),
			byFinding(once),
			"a finding's disposition depends on its position in the set",
		);
	});

	it("the never-list, fed inputs where a semantic act would change the answer", () => {
		const r = resolves();
		// No dedup: two findings with byte-identical text stay two dispositions.
		const twin = r.resolve(
			completeAdjudication([
				ruling({ finding: "zq same text", provenance: [SLOT] }),
				ruling({ finding: "zq same text", provenance: [OTHER_SLOT] }),
			]),
		);
		assert.equal(twin.dispositions.length, 2, "the Resolver merged identical finding text — dedup is the Judge's act");
		// No remedy synthesis or evaluation: the remedy rides verbatim, and
		// only on the remedy disposition.
		const remedied = r.resolve(
			completeAdjudication([
				ruling({
					severity: "NIT",
					remedy: "zq\texact remedy — bytes intact",
					direction: "fail-closed",
					onCriterion: false,
				}),
			]),
		);
		assert.equal(
			remedied.dispositions[0]?.remedy,
			"zq\texact remedy — bytes intact",
			"the Judge's exact remedy did not ride verbatim — a Resolver that rewrites it is inventing one",
		);
		const repaired = r.resolve(completeAdjudication([ruling({ direction: "live-harm" })]));
		assert.equal(repaired.dispositions[0]?.remedy, undefined, "a repair disposition carries a remedy nothing ruled");
		// No criterion-semantics comparison: two manifests with different
		// criteria TEXT (both non-empty) resolve identically — the Resolver
		// reads the Judge's onCriterion ruling, never the criteria themselves.
		const one = r.resolve(
			completeAdjudication([ruling({ direction: "fail-closed", onCriterion: false })], {
				state: "present",
				criteria: ["zq alpha"],
			}),
		);
		const other = r.resolve(
			completeAdjudication([ruling({ direction: "fail-closed", onCriterion: false })], {
				state: "present",
				criteria: ["zq entirely different wording"],
			}),
		);
		assert.deepEqual(
			one,
			other,
			"the Resolver's answer changed with criterion TEXT — comparing criterion semantics is the Judge's act",
		);
	});
});

// ---------------------------------------------------------------------------
// The composition: Judge availability is review completeness (§1.9).
// ---------------------------------------------------------------------------

describe("§1.9 the composed review outcome — Judge availability is review completeness (issue #177)", () => {
	it("a findings-free complete panel is approved and the Judge path is not taken", () => {
		const r = resolves();
		const p = panel();
		const approved = p.panelOutcome([p.receive(SLOT, "confirmed", { token: "APPROVED", findings: [] })], [SLOT]);
		assert.deepEqual(
			r.reviewOutcome(approved, undefined),
			{ state: "approved" },
			"a findings-free complete panel did not yield approved with no adjudication — §1.9's findings-free " +
				"path never runs the Judge, and requiring an adjudication here would run it",
		);
	});

	it("an approved panel stays approved whatever adjudication is offered — the Judge path is never taken", () => {
		const r = resolves();
		const p = panel();
		const approved = p.panelOutcome([p.receive(SLOT, "confirmed", { token: "APPROVED", findings: [] })], [SLOT]);
		const admission = r.admitAdjudication({ dedupAttested: true, rulings: [ruling()] }, MANIFEST);
		assert.ok(admission.complete, "the fixture admission should be complete");
		assert.deepEqual(
			r.reviewOutcome(approved, admission),
			{ state: "approved" },
			"an approved panel was read past on the strength of an offered adjudication — §1.9's findings-free path " +
				"never runs the Judge, so a gate narrowed to the no-adjudication case falls through to the Resolver " +
				"and answers a findings-free head with dispositions over findings the panel never bundled",
		);
	});

	it("an incomplete panel stays incomplete whatever adjudication is offered — the panel gate comes first", () => {
		const r = resolves();
		const p = panel();
		const incomplete = p.panelOutcome([], [SLOT]);
		const admission = r.admitAdjudication({ dedupAttested: true, rulings: [ruling()] }, MANIFEST);
		const state = r.reviewOutcome(incomplete, admission);
		assert.equal(
			state.state,
			"incomplete",
			"an incomplete panel was read past on the strength of an adjudication — an adjudication of findings " +
				"from an incomplete search adjudicates a bundle §1.7 never issued",
		);
		assert.equal(
			state.state === "incomplete" && state.cause,
			"panel",
			"the incompleteness is not attributed to the panel",
		);
		assert.deepEqual(
			state.state === "incomplete" ? state.missing : [],
			[SLOT],
			"the incomplete state does not carry the missing slots — `missing` is the caller's re-dispatch brief, " +
				"and a state without it stops a review no caller can restart",
		);
		// The brief must be DETACHED from the caller's panel outcome: an
		// aliased entry is a required slot a later mutation can drop or
		// redirect, after the state was computed.
		if (incomplete.outcome === "incomplete") {
			(incomplete.missing[0] as Slot).lens = "zq rewritten";
			incomplete.missing.push({ lens: "zq forged", surface: "zq" });
		}
		assert.deepEqual(
			state.state === "incomplete" ? state.missing : [],
			[SLOT],
			"a post-hoc mutation of the caller's panel outcome rewrote the re-dispatch brief — the missing list " +
				"must be fixed when the state is computed, not aliased to whatever the caller's object says later",
		);
	});

	it("a non-empty bundle with no adjudication is an incomplete review — never the raw-findings path", () => {
		const r = resolves();
		const state = r.reviewOutcome(bundleOutcome(), undefined);
		assert.deepEqual(
			state,
			{ state: "incomplete", cause: "adjudication-missing" },
			"findings without a Judge became a review outcome — §1.9 names proceeding on raw findings as a closed " +
				"path, and this layer fails closed on its own evidence",
		);
	});

	it("a non-empty bundle with an incomplete adjudication is incomplete, carrying the gaps — never disposed around", () => {
		const r = resolves();
		const admission = r.admitAdjudication(
			{ dedupAttested: true, rulings: [ruling(), ruling({ finding: "zq gapped", direction: undefined })] },
			MANIFEST,
		);
		assert.equal(admission.complete, false, "the fixture admission should be incomplete");
		const state = r.reviewOutcome(bundleOutcome(), admission);
		assert.equal(
			state.state,
			"incomplete",
			"an incomplete adjudication was resolved anyway — the never-list forbids disposing the rest of the set " +
				"around a gap, so ONE unruled axis on ONE finding holds the whole review",
		);
		assert.ok(
			state.state === "incomplete" && state.gaps?.some((gap) => /^ruling 1: harm direction is unruled/.test(gap)),
			"the incomplete state does not carry the named gap the caller re-dispatches the Judge on — anchored to " +
				"the authored axis-and-index sentence, since a bare length check accepts a wrong-axis message",
		);
		// The gaps are DETACHED from the admission: a later rewrite of the
		// admission's array must not reach the state the caller already holds.
		if (!admission.complete) {
			admission.gaps.length = 0;
			admission.gaps.push("zq rewritten after the state was computed");
		}
		assert.ok(
			state.state === "incomplete" && state.gaps?.some((gap) => /^ruling 1: harm direction is unruled/.test(gap)),
			"a post-hoc rewrite of the admission's gaps reached the state — the re-dispatch brief must be fixed " +
				"when the state is computed",
		);
	});

	it("an adjudication that rules NOTHING over a non-empty bundle is incomplete — the emptiest invalid return", () => {
		const r = resolves();
		// Entailed arithmetic at the seam: dedup merges and never discards
		// (§1.9) and a bundle that dropped a finding is defective (§1.7), so
		// N ≥ 1 raw findings yield ≥ 1 effective finding as a theorem — a
		// complete-looking admission with zero rulings adjudicated nothing.
		const admission = r.admitAdjudication({ dedupAttested: true, rulings: [] }, MANIFEST);
		assert.ok(admission.complete, "an empty ruling set should pass admission — the seam owns this check");
		const state = r.reviewOutcome(bundleOutcome(), admission);
		assert.equal(
			state.state,
			"incomplete",
			"a Judge return with zero rulings over a non-empty bundle resolved — two real findings adjudicated by " +
				"nothing let the change proceed, at the layer §1.9 says fails closed on its own evidence",
		);
		assert.ok(
			state.state === "incomplete" &&
				state.gaps?.some((gap) => /^the adjudication rules no effective finding/.test(gap)),
			"the empty-adjudication refusal is not named in its authored words",
		);
	});

	it("a complete adjudication over a non-empty bundle resolves — the one path to an adjudicated outcome", () => {
		const r = resolves();
		const admission = r.admitAdjudication(
			{ dedupAttested: true, rulings: [ruling({ direction: "live-harm" })] },
			MANIFEST,
		);
		const state = r.reviewOutcome(bundleOutcome(), admission);
		assert.equal(state.state, "resolved", "a complete adjudication did not resolve");
		assert.equal(
			state.state === "resolved" && state.resolution.outcome,
			"repair",
			"the resolved outcome is not the Resolver's",
		);
	});

	it("the module's source carries the adjudication brand — author-authored input is a type-checked act, and the closed paths are documented", () => {
		// The brand is type-only (the panel's own documented bound), so what
		// this suite pins mechanically is the source that declares it: only
		// admitAdjudication mints a value resolve() accepts, which is what
		// makes the two §1.9 closed paths — raw findings as an outcome, and
		// an author filling the Judge's seat — unrepresentable for a
		// type-checked consumer rather than merely discouraged.
		const source = readSource();
		for (const declaration of ["unique symbol", "readonly ["]) {
			assert.ok(
				source.includes(declaration),
				`resolve.ts no longer carries its adjudication brand (\`${declaration}\`) — removing it makes an ` +
					"author-constructed adjudication indistinguishable from an admitted one for every consumer",
			);
		}
	});
});

function readSource(): string {
	try {
		return readFileSync(`${repoRoot()}${REVIEW_DIR}resolve.ts`, "utf8");
	} catch {
		return "";
	}
}

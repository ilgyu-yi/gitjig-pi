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
type OrchestrateModule = {
	reviewRound(options: {
		repoRoot: string;
		baseRef: string;
		headRef: string;
		manifest: Manifest;
		fences: Fences;
		changeDescription: string;
		dispatch: (brief: string) => Promise<DispatchOutcome>;
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
): { dispatch: (brief: string) => Promise<DispatchOutcome>; briefs: string[]; judgeBriefs: string[] } {
	const seen: string[] = [];
	const judgeSeen: string[] = [];
	return {
		briefs: seen,
		judgeBriefs: judgeSeen,
		dispatch: (brief: string) => {
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
			["hex", "the no-hex rule — two returns were refused whole for a hash in a summary"],
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
			["hex", "the no-hex rule"],
		] as const) {
			assert.ok(text.includes(needle), `the judge brief lost ${why} (missing: ${JSON.stringify(needle)})`);
		}
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
		const fake = fakeDispatch(() => admitted(approvedPayload));
		const result = await o.reviewRound({
			repoRoot: repo,
			baseRef: "HEAD~1",
			headRef: "HEAD",
			manifest: { state: "present", criteria: ["AC1"] },
			fences: FENCES,
			changeDescription: "d",
			dispatch: fake.dispatch,
		});
		assert.equal(result.review.state, "approved", "a complete findings-free panel did not end the review APPROVED");
		assert.equal(fake.judgeBriefs.length, 0, "the Judge ran on an empty bundle — §1.9's fast path is gone");
		assert.equal(
			fake.briefs.length,
			2,
			"the derived slot set was not dispatched one brief per slot — the fixture routes runtime and suite",
		);
	});

	it("a finding draws the Judge with the bundle embedded, and a valid adjudication resolves", async () => {
		const o = orchestrate();
		const repo = fixtureRepo({ ".pi/x.ts": "x\n" });
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
		assert.equal(result.review.state, "resolved", "an admitted adjudication did not resolve");
		assert.ok(
			result.review.state === "resolved" && result.review.resolution.outcome === "clear",
			"a REFUTED-only set did not resolve clear — refutation leaves nothing behind (§1.9)",
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
		const parsed = r.parseReviewRecord(result.recordBody);
		assert.ok(parsed, "the composed record body did not parse back — the machine reader cannot consume the record");
		assert.deepEqual(
			parsed,
			result.record,
			"the record round-trip lost content — what Execution (b)'s history instruments read is not what was written",
		);
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
});

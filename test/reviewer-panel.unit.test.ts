/**
 * The reviewer panel orchestrator (issue #169, Directive #166) — the
 * behavioural boundaries SPEC §1.6 and §1.7 fix.
 *
 * Every arm here was written to kill a specific wrong implementation,
 * and the wrong implementations are named in the arm's own message so a
 * later reader can re-run the mutation rather than trust this header.
 * The set was not chosen by reading the module: a reviewer panel ran 24
 * single-edit mutants against an earlier version of it and reported
 * which survived, and the survivors are what most of the arms below
 * exist for — a quorum reintroduced at the panel's terminal output, a
 * content filter over finding text, a dropped validity gate, a policy
 * read replaced by a literal, `startsWith` for `includes`, and the whole
 * of the policy's own validation.
 *
 * The two properties worth stating because an arm alone does not show
 * them: findings are never read as TEXT anywhere in the module, so the
 * filter arm uses fixture strings a plausible filter would actually
 * match; and the outcome is a function of the result SET, so the
 * order-independence arms feed the same results in two orders and
 * demand one answer.
 *
 * The subject-absence anchor. The orchestrator may not exist on the
 * tree, so the modules are pulled through one guarded dynamic import
 * and every arm reds on its own authored message rather than on a
 * module-resolution crash — the `dispatch-module` shape, for the same
 * reason: a static import of a missing module aborts the file and
 * erases every authored message in it.
 *
 * NOT measured here, so a reader does not over-read it: the Judge and
 * the Resolver, which are a later Execution and whose absence is what
 * the findings-free arm pins; the CONTENT of the lens policy, which
 * §1.7 puts outside its own contract; and the dispatcher's own arms,
 * which live in `dispatch-module`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./harness/run-pi.ts";

const REVIEW_DIR = "/.pi/extensions/gitjig/review/";

type Slot = { lens: string; surface: string };
type ReviewerReturn = { token: "APPROVED" | "FINDINGS"; findings: string[] } | { failure: "timeout" | "malformed" };
type SlotResult = { slot: Slot; compare: "confirmed" | "invalid"; returned: ReviewerReturn };
type Policy = { version: number; rows: { lens: string; surface: string; prefixes: string[] }[] };

type PanelModule = {
	loadPolicy(): Policy;
	validatePolicy(policy: Policy): Policy;
	deriveRequiredSlots(changedPaths: string[], policy: Policy): Slot[];
	changedPathsFromRepo(baseRef: string, headRef: string, repoRoot: string): string[];
	receive(slot: Slot, compare: "confirmed" | "invalid", returned: ReviewerReturn): SlotResult;
	decideValidity(result: SlotResult, slot: Slot): { valid: boolean; reason?: string };
	buildBundle(results: SlotResult[], required: Slot[]): { finding: string; lens: string }[];
	panelOutcome(
		results: SlotResult[],
		required: Slot[],
	):
		| { outcome: "unrouted" }
		| { outcome: "incomplete"; missing: string[] }
		| { outcome: "approved" }
		| { outcome: "bundle"; bundle: { finding: string; lens: string }[] };
};

let panel: PanelModule | undefined;
let loadError = "";
try {
	panel = (await import(pathToFileURL(`${repoRoot()}${REVIEW_DIR}panel.ts`).href)) as PanelModule;
} catch (error) {
	loadError = error instanceof Error ? error.message : String(error);
}

function orchestrator(): PanelModule {
	assert.ok(
		panel,
		`the reviewer panel orchestrator does not exist at ${REVIEW_DIR}panel.ts — SPEC §1.7 leaves "slot derivation ` +
			`and bundle construction as the half still deriving", and issue #169 is the derivation. Import reported: ` +
			`${loadError}`,
	);
	return panel;
}

const LENS_A: Slot = { lens: "spec-contract", surface: "SPEC.md" };
const LENS_B: Slot = { lens: "runtime", surface: ".pi/" };
const LENS_C: Slot = { lens: "third", surface: "test/" };

const ok = (p: PanelModule, slot: Slot) => p.receive(slot, "confirmed", { token: "APPROVED", findings: [] });
const found = (p: PanelModule, slot: Slot, ...items: string[]) =>
	p.receive(slot, "confirmed", { token: "FINDINGS", findings: items });

describe("§1.7 the panel is a search, not a vote (issue #169)", () => {
	it("one valid finding survives any number of empty co-reviews — at the OUTCOME, not just in the bundle", () => {
		const p = orchestrator();
		const required = [LENS_A, LENS_B, LENS_C];
		const results = [found(p, LENS_A, "the lone finding"), ok(p, LENS_B), ok(p, LENS_C)];
		const outcome = p.panelOutcome(results, required);
		assert.equal(
			outcome.outcome,
			"bundle",
			"a lone finding among two empty co-reviews did not reach the panel's OUTCOME — a quorum or a threshold " +
				"reintroduced here is invisible to any arm that only reads buildBundle, and §1.7 records the vote as " +
				"the rejected design precisely because it discards a true minority finding",
		);
		assert.deepEqual(
			"bundle" in outcome ? outcome.bundle : [],
			[{ finding: "the lone finding", lens: "spec-contract" }],
			"the outcome's bundle is not the lone finding — a truncating or filtering panelOutcome passes every arm " +
				"that never asserts the bundle branch's contents",
		);
	});

	it("the outcome's bundle carries EVERY finding — a truncation at the terminal output is caught", () => {
		const p = orchestrator();
		// Two slots, three findings. An arm whose expected bundle holds one
		// entry cannot tell a faithful panel from one that ships the first.
		const outcome = p.panelOutcome([found(p, LENS_A, "first", "second"), found(p, LENS_B, "third")], [LENS_A, LENS_B]);
		assert.deepEqual(
			"bundle" in outcome ? outcome.bundle : [],
			[
				{ finding: "first", lens: "spec-contract" },
				{ finding: "second", lens: "spec-contract" },
				{ finding: "third", lens: "runtime" },
			],
			"the outcome's bundle is not every valid slot's findings in policy order — §1.7 makes the bundle transport, " +
				"and a panel that truncates or reorders at its terminal output loses findings the Judge never sees",
		);
	});

	it("the bundle does not read a finding's TEXT — a plausible severity filter is caught", () => {
		const p = orchestrator();
		// Strings a real content filter would match: the mutation that
		// survived an earlier suite dropped anything matching /nit|typo|style/.
		const required = [LENS_A, LENS_B];
		const results = [found(p, LENS_A, "nit: a typo in the header"), found(p, LENS_B, "style: rename this")];
		const bundle = p.buildBundle(results, required);
		assert.equal(
			bundle.length,
			2,
			"a finding was dropped on the strength of its own text — inferring severity from what a finding SAYS is " +
				"the Judge's act (§1.9), and a caller that does it is the second semantic decision-maker §1.7 forbids",
		);
	});

	it("identical finding text from two slots yields two entries — dedup is the Judge's, not the bundle's", () => {
		const p = orchestrator();
		const bundle = p.buildBundle(
			[found(p, LENS_A, "same text", "other"), found(p, LENS_B, "same text")],
			[LENS_A, LENS_B],
		);
		assert.equal(
			bundle.length,
			3,
			"the bundle collapsed two slots' identical text — §1.9's Judge merges duplicates and needs both to " +
				"preserve every raw finding's provenance, which it cannot do if the bundle merged them first",
		);
	});

	it("every finding carries its originating lens", () => {
		const p = orchestrator();
		const bundle = p.buildBundle([found(p, LENS_A, "x"), found(p, LENS_B, "y")], [LENS_A, LENS_B]);
		assert.deepEqual(
			bundle.map((e) => e.lens).sort(),
			["runtime", "spec-contract"],
			"a finding reached the bundle without its originating lens, or under a constant one",
		);
	});

	it("a finding from a slot that was never required does not enter the bundle", () => {
		const p = orchestrator();
		const bundle = p.buildBundle([found(p, LENS_B, "unrequired lens")], [LENS_A]);
		assert.deepEqual(
			bundle,
			[],
			"a result for a slot the panel never required contributed to the bundle — the panel's output is its " +
				"required slots' findings, and anything else is a result no routing decision asked for",
		);
	});

	it("an invalid result contributes nothing to the bundle", () => {
		const p = orchestrator();
		const stale = p.receive(LENS_A, "invalid", { token: "FINDINGS", findings: ["from a failed compare"] });
		assert.deepEqual(
			p.buildBundle([stale], [LENS_A]),
			[],
			"findings from a slot that failed the blind compare reached the bundle — buildBundle must run the same " +
				"validity gate the completeness check does, or an unverified reviewer's work reaches the Judge",
		);
	});
});

describe("§1.7 completeness, re-dispatch, and the unrouted case (issue #169)", () => {
	it("one missing slot is incomplete, not a pass", () => {
		const p = orchestrator();
		const outcome = p.panelOutcome([ok(p, LENS_A)], [LENS_A, LENS_B]);
		assert.equal(outcome.outcome, "incomplete", "a panel missing a required slot was read as an outcome");
		assert.deepEqual("missing" in outcome ? outcome.missing : [], ["runtime"]);
	});

	it("a re-dispatched valid result satisfies its slot whichever order it arrives in", () => {
		const p = orchestrator();
		const stale = p.receive(LENS_A, "invalid", { token: "APPROVED", findings: [] });
		const fresh = found(p, LENS_A, "found after re-dispatch");
		const forward = p.panelOutcome([stale, fresh], [LENS_A]);
		const reverse = p.panelOutcome([fresh, stale], [LENS_A]);
		assert.deepEqual(
			forward,
			reverse,
			"the outcome depends on the ORDER results are supplied in — §1.7 lets the caller re-dispatch a missing " +
				"slot, so a first-match-wins panel either blocks a slot that did return or lets a stale result mask " +
				"a fresh one",
		);
		assert.equal(forward.outcome, "bundle", "the re-dispatched finding did not reach the outcome");
	});

	it("a stale empty result cannot mask a fresh finding on the same slot", () => {
		const p = orchestrator();
		const staleEmpty = ok(p, LENS_A);
		const freshFinding = found(p, LENS_A, "the finding the stale result would hide");
		for (const order of [
			[staleEmpty, freshFinding],
			[freshFinding, staleEmpty],
		]) {
			const outcome = p.panelOutcome(order, [LENS_A]);
			assert.equal(
				outcome.outcome,
				"bundle",
				"an empty result masked a real finding on the same slot — Review APPROVED would issue at a head " +
					"where a valid reviewer returned a finding",
			);
		}
	});

	it("a complete findings-free panel is APPROVED, with no bundle for a Judge to run on", () => {
		const p = orchestrator();
		const outcome = p.panelOutcome([ok(p, LENS_A), ok(p, LENS_B)], [LENS_A, LENS_B]);
		assert.equal(outcome.outcome, "approved", "a complete panel that discovered nothing did not yield APPROVED");
		assert.ok(!("bundle" in outcome), "the findings-free path produced a bundle — the Judge must have no input");
	});

	it("a change no lens routes is UNROUTED, never APPROVED — zero reviewers is not a clean review", () => {
		const p = orchestrator();
		const outcome = p.panelOutcome([], []);
		assert.equal(
			outcome.outcome,
			"unrouted",
			"an empty required set yielded a review outcome — Review APPROVED ends review for a head (§1.9), and " +
				"handing that to a change no reviewer examined is an approval nobody produced",
		);
	});
});

describe("§1.6/§1.7 an invalid slot is a missing result, never a verdict (issue #169)", () => {
	const causes: [string, (p: PanelModule) => SlotResult, string][] = [
		["timed out", (p) => p.receive(LENS_A, "confirmed", { failure: "timeout" }), "timed out"],
		["returned malformed output", (p) => p.receive(LENS_A, "confirmed", { failure: "malformed" }), "malformed return"],
		[
			"failed the blind compare",
			(p) => p.receive(LENS_A, "invalid", { token: "APPROVED", findings: [] }),
			"blind compare not confirmed",
		],
		[
			"reviewed the wrong surface",
			(p) =>
				p.receive({ lens: "spec-contract", surface: "test/" }, "confirmed", {
					token: "APPROVED",
					findings: [],
				}),
			"reviewed a surface other than the one the slot required",
		],
		[
			"returned APPROVED carrying findings",
			(p) =>
				p.receive(LENS_A, "confirmed", {
					token: "APPROVED",
					findings: ["contradicts its own token"],
				}),
			"APPROVED carrying findings contradicts its own token",
		],
		[
			"returned FINDINGS carrying none",
			(p) => p.receive(LENS_A, "confirmed", { token: "FINDINGS", findings: [] }),
			"FINDINGS carrying none contradicts its own token",
		],
	];

	for (const [cause, make, expectedReason] of causes) {
		it(`a slot that ${cause} is no result — never an approve`, () => {
			const p = orchestrator();
			const result = make(p);
			const verdict = p.decideValidity(result, LENS_A);
			assert.equal(
				verdict.valid,
				false,
				`a slot that ${cause} was counted valid — §1.6 makes validity the CALLER's fact and §1.7 makes an ` +
					"invalid slot no result at all: never an approve, never a reject, never an abstention some " +
					"denominator absorbs",
			);
			// The reason is asserted, not just the verdict: several causes reach
			// `false` through a fallthrough that reports the wrong one, and a
			// cause the module cannot name is a cause it does not really rule.
			assert.equal(
				verdict.reason,
				expectedReason,
				`a slot that ${cause} was ruled invalid for the wrong reason — §1.7 enumerates its causes, and a ` +
					"module that collapses them cannot report which one fired to the caller deciding whether to " +
					"re-dispatch",
			);
			assert.equal(
				p.panelOutcome([result, ok(p, LENS_B)], [LENS_A, LENS_B]).outcome,
				"incomplete",
				`a panel carrying a slot that ${cause} was read as an outcome`,
			);
		});
	}
});

describe("§1.6 validity is the caller's fact — a reviewer cannot vouch for itself (issue #169)", () => {
	it("the slot a result answers is the one the CALLER dispatched, not one the return names", () => {
		const p = orchestrator();
		// The delegate would like to answer LENS_B; the caller dispatched
		// LENS_A, and `receive` takes the caller's slot as its own argument.
		const result = p.receive(LENS_A, "confirmed", { token: "APPROVED", findings: [] });
		assert.deepEqual(
			result.slot,
			LENS_A,
			"the recorded slot is not the one the caller dispatched — if a delegate can name the slot it answered, " +
				"§1.7's wrong-surface cause compares the delegate's claim against itself and a delegate can satisfy " +
				"a slot it never reviewed",
		);
		assert.equal(
			p.decideValidity(result, LENS_B).valid,
			false,
			"a result recorded against one slot was ruled valid for another",
		);
	});

	it("mutating the slot a caller passed in does not reach the recorded result", () => {
		const p = orchestrator();
		const dispatched = { ...LENS_A };
		const result = p.receive(dispatched, "confirmed", { token: "APPROVED", findings: [] });
		dispatched.surface = "somewhere else";
		assert.equal(
			result.slot.surface,
			"SPEC.md",
			"the recorded slot aliases the caller's object — a later mutation would rewrite what the panel believes " +
				"it dispatched, after the fact",
		);
	});
});

describe("§1.7 required slots derive from a committed, caller-owned policy (issue #169)", () => {
	it("the committed file is what loadPolicy reads — and it takes no path to read anything else", () => {
		const p = orchestrator();
		const policy = p.loadPolicy();
		assert.ok(policy && Array.isArray(policy.rows) && policy.rows.length > 0, "no committed lens policy resolved");
		assert.equal(
			p.loadPolicy.length,
			0,
			"loadPolicy accepts an argument — a path parameter makes the committed surface a DEFAULT rather than a " +
				"constraint, and routing could then derive from an untracked file outside the repository, which is " +
				"the audit property §1.7 makes contractual",
		);
		// Bind the loaded structure to the committed bytes, so replacing the
		// read with a literal cannot pass.
		const onDisk = JSON.parse(readFileSync(`${repoRoot()}${REVIEW_DIR}lens-policy.json`, "utf8")) as Policy;
		assert.deepEqual(
			policy.rows,
			onDisk.rows,
			"the policy loadPolicy returned is not the committed file's rows — a hardcoded table would route " +
				"identically while diverging silently from the surface a reviewer diffs",
		);
	});

	it("a policy that routes nothing, or whose rows cannot route, is refused at load", () => {
		const p = orchestrator();
		// Each of these is a guard an earlier suite left unmeasured, so each
		// is exercised directly against deriveRequiredSlots' own validator
		// through loadPolicy's contract: the module must not accept them.
		for (const [why, rows] of [
			["no rows at all", []],
			["a row with no prefixes", [{ lens: "a", surface: "s", prefixes: [] }]],
			["a row with an empty prefix", [{ lens: "a", surface: "s", prefixes: [""] }]],
			["a row with no lens name", [{ lens: "", surface: "s", prefixes: ["x/"] }]],
			[
				"two rows sharing one lens",
				[
					{ lens: "a", surface: "s1", prefixes: ["x/"] },
					{ lens: "a", surface: "s2", prefixes: ["y/"] },
				],
			],
		] as [string, Policy["rows"]][]) {
			assert.throws(
				() => p.validatePolicy({ version: 1, rows }),
				`a policy with ${why} was accepted — each of these breaks a guarantee §1.7 states: a policy that ` +
					"routes nothing derives an empty required set, an empty prefix matches every string, and two " +
					"rows sharing a lens make a slot no caller can pair a dispatch to",
			);
		}
		// The committed surface passes its own validator — the predicate has
		// one implementation (§3.11) and this is the same one loadPolicy runs.
		assert.ok(p.validatePolicy(p.loadPolicy()), "the committed policy does not satisfy its own validator");
	});

	it("derivation is a function of the change surface, ordered by the policy and never by the input", () => {
		const p = orchestrator();
		const policy = p.loadPolicy();
		assert.deepEqual(
			p.deriveRequiredSlots(["SPEC.md", ".pi/x.ts"], policy),
			p.deriveRequiredSlots([".pi/x.ts", "SPEC.md"], policy),
			"two orderings of one change surface derived two different-looking sets — a routing decision that " +
				"depends on input order is not reproducible, and §1.7 makes auditability the point of the surface",
		);
		assert.deepEqual(
			p.deriveRequiredSlots([".pi/a.ts", ".pi/b.ts"], policy).map((s) => s.lens),
			["runtime"],
			"two paths matching one lens derived that lens twice — a duplicated required slot cannot be satisfied " +
				"coherently and double-counts its findings",
		);
	});

	it("two unrelated change surfaces derive different sets — the table is actually consulted", () => {
		const p = orchestrator();
		const policy = p.loadPolicy();
		assert.notDeepEqual(
			p
				.deriveRequiredSlots(["SPEC.md"], policy)
				.map((s) => s.lens)
				.sort(),
			p
				.deriveRequiredSlots([".pi/extensions/gitjig/dispatch/index.ts"], policy)
				.map((s) => s.lens)
				.sort(),
			"two unrelated surfaces derived the same lens set — a constant answer is not a derivation",
		);
	});

	it("matching is path-segment aware — a near-miss name routes nothing", () => {
		const p = orchestrator();
		const policy = p.loadPolicy();
		assert.deepEqual(
			p.deriveRequiredSlots(["SPEC.md.bak"], policy),
			[],
			"a path that merely BEGINS with a policy prefix selected that lens — `SPEC.md.bak` is not `SPEC.md`, " +
				"and a bare prefix test routes a change by a name it resembles",
		);
		assert.deepEqual(
			p.deriveRequiredSlots(["README.md", "package.json"], policy),
			[],
			"a change the policy routes nowhere derived a lens anyway",
		);
	});

	it("nothing a delegate says can add or remove a required slot", () => {
		const p = orchestrator();
		const policy = p.loadPolicy();
		assert.deepEqual(
			p.deriveRequiredSlots(["SPEC.md", "lens=runtime", "runtime", ".pi"], policy).map((s) => s.lens),
			p.deriveRequiredSlots(["SPEC.md"], policy).map((s) => s.lens),
			"a lens claim riding in the input selected a slot — §1.7: no reviewer selects the lens it will be graded " +
				"on and no model selects one at dispatch time",
		);
	});

	it("the authoritative read exists and reads the repository, not an argument", () => {
		const p = orchestrator();
		assert.equal(
			typeof p.changedPathsFromRepo,
			"function",
			'there is no authoritative changed-path read — §1.7 requires routing inputs be "read from the change ' +
				"itself rather than from anyone's summary of it\", and a caller-supplied array cannot satisfy that " +
				"however honestly it was assembled",
		);
		const paths = p.changedPathsFromRepo("HEAD", "HEAD", repoRoot());
		assert.deepEqual(paths, [], "a ref compared against itself reported changed paths");
	});
});

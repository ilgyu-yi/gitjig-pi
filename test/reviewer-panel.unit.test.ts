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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./harness/run-pi.ts";

const REVIEW_DIR = "/.pi/extensions/gitjig/review/";

type Slot = { lens: string; surface: string };
type ReviewerReturn = { token: "APPROVED" | "FINDINGS"; findings: string[] } | { failure: "timeout" | "malformed" };
type Compare = "confirmed" | "invalid" | "absent";
/** The module brands this; the suite mirrors its shape and casts at `receive`. */
type SlotResult = { slot: Slot; compare: Compare; returned: ReviewerReturn };
type ChangedPaths = readonly string[];
type Policy = { rows: { lens: string; surface: string; prefixes: string[] }[] };

type PanelModule = {
	RoutingRefusal: new (
		limb: "routing-failure" | "empty-surface",
		unclaimed: readonly string[],
	) => Error & { limb: string; unclaimed: readonly string[] };
	loadPolicy(): Policy;
	validatePolicy(policy: Policy): Policy;
	deriveRequiredSlots(changedPaths: ChangedPaths, policy: Policy): Slot[];
	changedPathsFromRepo(baseRef: string, headRef: string, repoRoot: string): ChangedPaths;
	receive(slot: Slot, compare: Compare, returned: ReviewerReturn): SlotResult;
	decideValidity(result: SlotResult, slot: Slot): { valid: boolean; reason?: string };
	buildBundle(results: SlotResult[], required: Slot[]): { finding: string; slot: Slot }[];
	panelOutcome(
		results: SlotResult[],
		required: Slot[],
	):
		| { outcome: "incomplete"; missing: Slot[] }
		| { outcome: "approved" }
		| { outcome: "bundle"; bundle: { finding: string; slot: Slot }[] };
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
		`the reviewer panel orchestrator does not exist at ${REVIEW_DIR}panel.ts — SPEC §1.7 lands "slot derivation ` +
			`and bundle construction" at that path, and issue #169 is the derivation. Import reported: ` +
			`${loadError}`,
	);
	return panel;
}

/**
 * The named seam for hand-built path sets. `deriveRequiredSlots` takes a
 * BRANDED changed-path set that only `changedPathsFromRepo` mints, so a
 * type-checked consumer deriving from a literal has to say so out loud —
 * through this helper, whose name is the point. Honest bounds, stated:
 * the brand binds the type checker's consumers, not the runtime (the
 * symbol does not exist there), and this suite's own mirror types are
 * unbranded by construction (a dynamic import cannot see them), so what
 * the suite pins is the brand's presence in the module's source and the
 * seam's use in its own.
 */
const paths = (literal: string[]): ChangedPaths => literal as unknown as ChangedPaths;

/**
 * Run a derivation the arm expects §1.7's coverage rule to refuse, and
 * hand back the refusal's own facts. Failing here rather than returning
 * undefined keeps every consuming arm's message about ITS mutation, not
 * about a missing throw it never asserted.
 */
function refusal(act: () => unknown): { limb: string; unclaimed: readonly string[]; message: string } {
	try {
		act();
	} catch (error) {
		const refused = error as Error & { limb?: unknown; unclaimed?: unknown };
		assert.ok(
			typeof refused.limb === "string" && Array.isArray(refused.unclaimed),
			"the routing refusal does not carry its limb and its unclaimed set — a downstream caller cannot map " +
				"a routing failure to its one remedy (a reviewed policy amendment) without them",
		);
		return { limb: refused.limb, unclaimed: refused.unclaimed as readonly string[], message: refused.message };
	}
	assert.fail("the derivation returned instead of refusing — §1.7's coverage refusal is not live at this input");
}

/**
 * Every scratch directory this file mints, removed once when the file's
 * tests finish — without the registry each run leaks one directory per
 * fixture into TMPDIR, measured in the hundreds on a working tree. The
 * two probes whose cleanup is load-bearing MID-test (the ambient env dir
 * and the dash-ref side-effect dir) keep their own `finally` blocks.
 */
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

/**
 * A throwaway repository. With `baseOnly` the history DIVERGES: the base
 * ref gets a commit the head does not carry, which is the only shape in
 * which `A..B` and `A...B` differ — on a linear history the two ranges
 * are the same set, so a two-dot implementation is indistinguishable
 * from a three-dot one and an arm over a linear fixture cannot tell them
 * apart.
 */
function fixtureRepo(files: Record<string, string>, baseOnly?: Record<string, string>): string {
	const dir = scratchDir("gitjig-panel-repo-");
	const git = (...argv: string[]) => execFileSync("git", argv, { cwd: dir, encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@example.invalid");
	git("config", "user.name", "t");
	// The ambient environment may sign commits; a fixture repository must
	// not depend on the operator having a key.
	git("config", "commit.gpgsign", "false");
	git("config", "tag.gpgsign", "false");
	writeFileSync(join(dir, "seed.txt"), "seed\n");
	git("add", "-A");
	git("commit", "-qm", "seed");
	if (baseOnly !== undefined) {
		git("checkout", "-q", "-b", "base-line");
		for (const [name, body] of Object.entries(baseOnly)) {
			mkdirSync(dirname(join(dir, name)), { recursive: true });
			writeFileSync(join(dir, name), body);
		}
		git("add", "-A");
		git("commit", "-qm", "base-only");
		git("checkout", "-q", "-");
	}
	for (const [name, body] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), body);
	}
	git("add", "-A");
	git("commit", "-qm", "change");
	return dir;
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
			[{ finding: "the lone finding", slot: LENS_A }],
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
				{ finding: "first", slot: LENS_A },
				{ finding: "second", slot: LENS_A },
				{ finding: "third", slot: LENS_B },
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

	it("an incomplete panel's `missing` is fixed at construction — mutating the caller's slot array changes nothing", () => {
		const p = orchestrator();
		const required: Slot[] = [
			{ lens: "runtime", surface: ".pi/" },
			{ lens: "suite", surface: "test/" },
		];
		const first = required[0] as Slot;
		// One slot answered, one not: the outcome is incomplete and `missing`
		// names the unanswered one. That entry must be a copy, not the
		// caller's live object, or a later mutation rewrites which slot the
		// caller re-dispatches.
		const outcome = p.panelOutcome([found(p, required[1] as Slot, "f")], required);
		assert.equal(outcome.outcome, "incomplete");
		first.lens = "forged";
		first.surface = "forged";
		assert.deepEqual(
			"missing" in outcome ? outcome.missing : [],
			[{ lens: "runtime", surface: ".pi/" }],
			"mutating the caller's required[] after panelOutcome rewrote which slot `missing` reports — the caller " +
				"re-dispatches from that list, so it must be fixed when the outcome is computed",
		);
	});

	it("the bundle's provenance is fixed at construction — mutating the caller's slot array later changes nothing", () => {
		const p = orchestrator();
		const required: Slot[] = [{ lens: "runtime", surface: ".pi/" }];
		const first = required[0] as Slot;
		const bundle = p.buildBundle([found(p, first, "f1")], required);
		first.lens = "spec-contract";
		first.surface = "forged";
		assert.deepEqual(
			bundle,
			[{ finding: "f1", slot: { lens: "runtime", surface: ".pi/" } }],
			"mutating the caller's required[] after buildBundle rewrote the provenance of an entry already in the " +
				"bundle — the artifact the Judge reads must be fixed when it is constructed, not aliased to whatever " +
				"the caller's array says later",
		);
	});

	it("every finding carries its originating lens", () => {
		const p = orchestrator();
		const bundle = p.buildBundle([found(p, LENS_A, "x"), found(p, LENS_B, "y")], [LENS_A, LENS_B]);
		assert.deepEqual(
			bundle.map((e) => e.slot).sort((a, b) => a.lens.localeCompare(b.lens)),
			[LENS_B, LENS_A],
			"a finding reached the bundle without its originating slot, or under a constant one — the WHOLE slot rides, " +
				"because this module's identity rule is the lens+surface pair and half of it cannot tell two slots apart",
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
		assert.deepEqual("missing" in outcome ? outcome.missing : [], [LENS_B]);
	});

	it("the bundle is ordered by the POLICY, not by the order results arrive in", () => {
		const p = orchestrator();
		// Results supplied in the REVERSE of the required order: an
		// implementation that iterates results outermost yields B then A.
		const outcome = p.panelOutcome([found(p, LENS_B, "from B"), found(p, LENS_A, "from A")], [LENS_A, LENS_B]);
		assert.deepEqual(
			("bundle" in outcome ? outcome.bundle : []).map((e) => e.finding),
			["from A", "from B"],
			"the bundle followed the order results were supplied in — the artifact the Judge reads must be " +
				"reproducible from the same result set however the caller collected it",
		);
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

	it("an empty required set refuses — the vacuous APPROVED is retired with #172's derivation", () => {
		const p = orchestrator();
		// §1.7's routing-coverage clause is derived as of issue #172: no
		// APPROVED derives from an empty required-review surface, and under
		// full coverage a non-empty change surface derives at least one slot
		// — so an empty set HERE means the change surface was empty (refused
		// at the derivation seam) or the derivation was bypassed, and either
		// way the answer is a refusal, never an approval no reviewer
		// produced.
		assert.throws(
			() => p.panelOutcome([], []),
			(error: unknown) => error instanceof Error && /required slot set is empty/.test(error.message),
			"an empty required set produced a panel outcome — the vacuous APPROVED this arm once pinned as §0.3 " +
				"spec-ahead lag is retired by issue #172's derivation, and an approval no reviewer produced must not " +
				"derive from an empty required-review surface",
		);
	});
});

describe("§1.7 routing coverage — the refusal is live (issue #172)", () => {
	it("an unclaimed constituent is a routing failure naming exactly the unowned paths", () => {
		const p = orchestrator();
		const refused = refusal(() => p.deriveRequiredSlots(paths([".pi/x.ts", "zz-unowned.md"]), p.loadPolicy()));
		assert.equal(
			refused.limb,
			"routing-failure",
			"an unowned constituent did not surface as the routing-failure limb — the two limbs are distinct states " +
				"and only this one owes a policy amendment",
		);
		assert.deepEqual(
			refused.unclaimed,
			["zz-unowned.md"],
			"the refusal did not name exactly the unowned constituents — a claimed path in the list misdirects the " +
				"policy amendment, and a missing unowned one hides what must be claimed",
		);
		assert.ok(
			refused.message.includes("zz-unowned.md"),
			"the refusal's own text does not name the unowned constituent — §1.7's remedy is an amendment to the " +
				"committed policy, and an operator reading the refusal must see what to claim",
		);
	});

	it("the empty change surface refuses distinctly — not a routing failure, no amendment owed", () => {
		const p = orchestrator();
		const refused = refusal(() => p.deriveRequiredSlots(paths([]), p.loadPolicy()));
		assert.equal(
			refused.limb,
			"empty-surface",
			"an empty change surface refused as a routing failure — §1.7: there is nothing to route, a row cannot " +
				"claim a constituent that does not exist, and no policy amendment is owed on it",
		);
		assert.deepEqual(
			refused.unclaimed,
			[],
			"the empty-surface refusal named unclaimed constituents — an empty surface has none, and naming any " +
				"conflates the two limbs the clause keeps distinct",
		);
	});

	it("the refusal is upstream of review — a thrown typed refusal, never a panel state", () => {
		const p = orchestrator();
		try {
			p.deriveRequiredSlots(paths(["zz-unowned.md"]), p.loadPolicy());
			assert.fail("a routing failure derived a slot set — the refusal must sit upstream of review");
		} catch (error) {
			assert.ok(
				error instanceof p.RoutingRefusal,
				"the refusal is not the module's own typed refusal — a downstream caller cannot distinguish a " +
					"routing failure from an ordinary crash, and §1.7 gives the two different consequences",
			);
			assert.ok(
				!("outcome" in (error as object)),
				"the refusal carries a panel-outcome shape — a routing failure is a refusal upstream of review, " +
					"never a review state, and it must not be readable as one",
			);
		}
	});

	it("full coverage of a non-empty surface derives a non-empty required set", () => {
		const p = orchestrator();
		const derived = p.deriveRequiredSlots(paths([".pi/x.ts"]), p.loadPolicy());
		assert.ok(
			derived.length > 0,
			"a fully claimed non-empty surface derived no slot — §1.7: full coverage of a non-empty change surface " +
				"derives a non-empty required slot set",
		);
	});

	it("the committed policy claims every top-level constituent of this repository — membership drift fails loudly", () => {
		const p = orchestrator();
		// Parsed structurally (mode, type, hash \t name), never through git's
		// localized prose. A tree entry is probed through a representative
		// child, since the change surface carries file paths.
		const entries = execFileSync("git", ["ls-tree", "HEAD"], { cwd: repoRoot(), encoding: "utf8" })
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => {
				const [meta, name] = line.split("\t");
				return { name, isTree: meta.split(" ")[1] === "tree" };
			});
		assert.ok(entries.length > 0, "the toplevel read returned nothing — the probe itself is broken");
		const probes = entries.map((entry) => (entry.isTree ? `${entry.name}/probe` : entry.name));
		const derived = p.deriveRequiredSlots(paths(probes), p.loadPolicy());
		assert.ok(
			derived.length > 0,
			"the whole-tree probe derived nothing — the committed policy no longer routes this repository",
		);
	});

	it("no catch-all row hides an omission — a name outside every claimed surface refuses", () => {
		const p = orchestrator();
		const refused = refusal(() => p.deriveRequiredSlots(paths(["zz-no-such-surface"]), p.loadPolicy()));
		assert.equal(
			refused.limb,
			"routing-failure",
			"a name outside every claimed surface routed anyway — a catch-all row discharges coverage as " +
				"decoration, and §1.7 records it as the rejected design",
		);
	});

	it("the docs and toolchain rows claim their own constituents, through their own lens alone", () => {
		const p = orchestrator();
		const policy = p.loadPolicy();
		assert.deepEqual(
			p.deriveRequiredSlots(paths(["README.md", "changelog_unreleased/added/1.md"]), policy).map((s) => s.lens),
			["docs"],
			"the adopter-facing prose constituents did not route to the docs lens alone — either they are unclaimed " +
				"or a broader row swallows them",
		);
		assert.deepEqual(
			p
				.deriveRequiredSlots(
					paths(["package.json", "package-lock.json", "tsconfig.json", "biome.jsonc", ".gitignore"]),
					policy,
				)
				.map((s) => s.lens),
			["toolchain"],
			"the toolchain constituents did not route to the toolchain lens alone — either one is unclaimed or a " +
				"broader row swallows them",
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
			// Two causes at once, pinning their ORDER: a failure return reports
			// the failure, never the compare — without a fixture that carries
			// both, which cause the module names first is unmeasured and the
			// table's own fallthrough rationale is unenforced on this pair.
			"timed out AND failed the blind compare",
			(p) => p.receive(LENS_A, "invalid", { failure: "timeout" }),
			"timed out",
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

	it("slot identity is the PAIR: same surface with a different lens is still the wrong slot", () => {
		const p = orchestrator();
		// Every other fixture pair differs in BOTH fields, so an identity
		// check that ignored the lens would pass them all.
		const sameSurface: Slot = { lens: "enforcement", surface: "SPEC.md" };
		const result = p.receive(sameSurface, "confirmed", { token: "APPROVED", findings: [] });
		assert.equal(
			p.decideValidity(result, LENS_A).valid,
			false,
			"a result recorded against a different LENS over the same surface was ruled valid — identity is the " +
				"lens+surface pair, and an identity that reads only the surface half lets one dispatched reviewer " +
				"satisfy every lens that happens to share its surface",
		);
	});

	it("a token outside the two-token grammar is invalid, with the grammar named as the reason", () => {
		const p = orchestrator();
		const outside = p.receive(LENS_A, "confirmed", { token: "MAYBE", findings: [] } as unknown as ReviewerReturn);
		const verdict = p.decideValidity(outside, LENS_A);
		assert.equal(verdict.valid, false, "a third token was ruled valid — §1.6's set is exactly two");
		assert.equal(
			verdict.reason,
			"token outside the two-token grammar",
			"the third token was refused for some other reason — the grammar guard is the one §1.6 licenses, and a " +
				"fallthrough that happens to refuse cannot say why",
		);
	});

	it("mutating a FAILURE return after receive does not reach the recorded result", () => {
		const p = orchestrator();
		const failure = { failure: "timeout" } as ReviewerReturn;
		const result = p.receive(LENS_A, "confirmed", failure);
		(failure as { failure: string }).failure = "malformed";
		assert.equal(
			p.decideValidity(result, LENS_A).reason,
			"timed out",
			"the recorded failure kind changed after receipt — the failure branch of receive's copy is as " +
				"load-bearing as the token branch, since the reason a slot went invalid is part of what the caller " +
				"decides re-dispatch on",
		);
	});

	it("a slot claim smuggled into the return is ignored — receive reads only its own argument", () => {
		const p = orchestrator();
		// A delegate-shaped return carrying a slot it would like to answer.
		const smuggled = { token: "APPROVED", findings: [], slot: LENS_B } as unknown as ReviewerReturn;
		const result = p.receive(LENS_A, "confirmed", smuggled);
		assert.deepEqual(
			result.slot,
			LENS_A,
			"a slot named inside the return decided which slot the result answered — that is the self-selected " +
				"specialist §1.7 forbids, and it makes the wrong-surface cause compare a delegate's claim to itself",
		);
	});

	it("mutating the RETURN a caller passed in does not reach the recorded result", () => {
		const p = orchestrator();
		const findings = ["the real finding"];
		const result = p.receive(LENS_A, "confirmed", { token: "FINDINGS", findings });
		findings.length = 0;
		findings.push("rewritten after the fact");
		assert.deepEqual(
			p.buildBundle([result], [LENS_A]).map((e) => e.finding),
			["the real finding"],
			"the recorded result aliases the caller's return — `readonly` is shallow, so whoever still holds the " +
				"parsed object can rewrite what the panel reports, and emptying the array flips the result's own " +
				"validity, after the caller recorded it",
		);
	});

	it("an absent blind compare is invalid — §1.6's third state has a representation here", () => {
		const p = orchestrator();
		const result = p.receive(LENS_A, "absent", { token: "APPROVED", findings: [] });
		assert.equal(
			p.decideValidity(result, LENS_A).valid,
			false,
			"a result whose head could not be confirmed at all was ruled valid — the dispatcher can report three " +
				"compare states and §1.6 rules all three invalid but `confirmed`; a two-state field cannot carry the " +
				"one it does not name",
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
	it("loadPolicy reads the committed file and nothing a caller names", () => {
		const p = orchestrator();
		// The rejected loader shape was `loadPolicy(path = POLICY_PATH)`,
		// whose arity is 0 — so an arity assertion cannot see it. This one
		// can: a loader that honoured an argument would read the decoy.
		const decoy = join(scratchDir("gitjig-decoy-"), "lens-policy.json");
		writeFileSync(decoy, JSON.stringify({ rows: [{ lens: "decoy", surface: "s", prefixes: ["x/"] }] }));
		const loaded = (p.loadPolicy as (path?: string) => Policy)(decoy);
		assert.ok(
			!loaded.rows.some((row) => row.lens === "decoy"),
			"loadPolicy honoured a path a caller supplied — a path parameter makes the committed surface a DEFAULT " +
				"rather than a constraint, and routing could then derive from an untracked file outside the " +
				"repository, which is the audit property §1.7 makes contractual",
		);
	});

	it("loadPolicy runs the validator, and it is the same one the suite exercises", () => {
		const p = orchestrator();
		assert.throws(() => p.validatePolicy({ rows: [] }), "the exported predicate accepted a policy that routes nothing");
		// The binding: a loader that skipped the predicate would pass every
		// arm that only checks the predicate and the committed file apart.
		assert.equal(
			p.loadPolicy.toString().includes("validatePolicy"),
			true,
			"loadPolicy does not call validatePolicy — the module's §3.11 claim is that the predicate has one " +
				"implementation AND one owner, and a loader that parses without validating leaves the owner unwired",
		);
	});

	it("the committed file is what loadPolicy returns — a hardcoded table cannot pass", () => {
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
		// Each guard is exercised on BOTH its halves — the well-typed-but-
		// empty value and the wrong-TYPE value — because every input reaches
		// the predicate from JSON.parse of a file, so a fixture set of only
		// well-typed shapes leaves the typeof/Array.isArray halves unmeasured
		// and a raw TypeError can wear an authored refusal's green. Each row
		// carries a matcher on the module's own words for the same reason: a
		// bare-message assert.throws accepts ANY error, including the crash
		// the guard exists to replace.
		for (const [why, rows, refusal] of [
			["no rows at all", [], /no rows/],
			["rows that are not an array", {} as never, /no rows/],
			["a row with no prefixes", [{ lens: "a", surface: "s", prefixes: [] }], /declares no prefix/],
			[
				"a row whose prefixes are not an array",
				[{ lens: "a", surface: "s", prefixes: "x/" } as never],
				/declares no prefix/,
			],
			["a row with an empty prefix", [{ lens: "a", surface: "s", prefixes: [""] }], /empty prefix/],
			["a row with a non-string prefix", [{ lens: "a", surface: "s", prefixes: [7] } as never], /empty prefix/],
			["a row with no lens name", [{ lens: "", surface: "s", prefixes: ["x/"] }], /no lens name/],
			["a row with a non-string lens", [{ lens: 7, surface: "s", prefixes: ["x/"] } as never], /no lens name/],
			[
				"two rows sharing one lens",
				[
					{ lens: "a", surface: "s1", prefixes: ["x/"] },
					{ lens: "a", surface: "s2", prefixes: ["y/"] },
				],
				/appears twice/,
			],
		] as [string, Policy["rows"], RegExp][]) {
			assert.throws(
				() => p.validatePolicy({ rows }),
				refusal,
				`a policy with ${why} was accepted, or refused in words this repository did not author — each of ` +
					"these breaks a guarantee §1.7 states: a policy that routes nothing derives an empty required " +
					"set, an empty prefix matches every string, and two rows sharing a lens make a slot no caller can " +
					"pair a dispatch to",
			);
		}
		// The committed surface passes its own validator — the predicate has
		// one implementation (§3.11) and this is the same one loadPolicy runs.
		assert.ok(p.validatePolicy(p.loadPolicy()), "the committed policy does not satisfy its own validator");
	});

	it("a row's surface is validated and carried — a slot's identity is the pair, so half of it is not enough", () => {
		const p = orchestrator();
		// All three invalid shapes — absent, empty-string, wrong-type — with a
		// matcher on the module's own words: fixtures that only omit the field
		// leave the typeof and length halves of the guard unmeasured, and a
		// matcher-less throws accepts the raw TypeError the guard replaces.
		for (const row of [
			{ lens: "a", prefixes: ["x/"] } as never,
			{ lens: "a", surface: "", prefixes: ["x/"] },
			{ lens: "a", surface: 7, prefixes: ["x/"] } as never,
		]) {
			assert.throws(
				() => p.validatePolicy({ rows: [row] }),
				/declares no surface/,
				"a row without a usable surface was accepted, or refused in unauthored words — two such rows produce " +
					"slots that compare equal on a field neither carries, which is the same unpairable slot the " +
					"lens-uniqueness check exists to prevent",
			);
		}
		// Two rows, two DIFFERENT surfaces, one derivation: a constant surface
		// equal to either row's cannot satisfy both, which is what a
		// single-row single-string assertion could not catch.
		const twoRow = p.validatePolicy({
			rows: [
				{ lens: "one", surface: "surface one", prefixes: ["a/"] },
				{ lens: "two", surface: "surface two", prefixes: ["b/"] },
			],
		});
		assert.deepEqual(
			p.deriveRequiredSlots(paths(["a/x", "b/y"]), twoRow),
			[
				{ lens: "one", surface: "surface one" },
				{ lens: "two", surface: "surface two" },
			],
			"a derived slot's surface did not come from the policy row it was derived from — a constant surface " +
				"makes the wrong-surface invalidity cause unreachable for every row",
		);
	});

	it("validatePolicy returns a detached policy — a post-validation push to the caller's rows does not route", () => {
		const p = orchestrator();
		const input = { rows: [{ lens: "a", surface: "s", prefixes: ["a/"] }] };
		const validated = p.validatePolicy(input);
		// The row this pushes would be REFUSED by the validator (empty lens,
		// empty prefixes); if the branded value aliased the caller's array it
		// would now route on rows nothing validated.
		input.rows.push({ lens: "", surface: "", prefixes: [] });
		assert.equal(
			validated.rows.length,
			1,
			"a row pushed to the caller's input after validation reached the branded policy — validatePolicy must " +
				"return a fresh object, or the brand certifies a snapshot the predicate never ruled on (the aliasing " +
				"class receive and buildBundle were cured of, at the table boundary)",
		);
		// The detach must be DEEP: a shallow copy shares the row and prefix
		// objects, so mutating either after validation rewrites what the brand
		// certifies — the reproduced exploit routed an empty-lens slot the
		// validator refuses, through a post-validation write to the caller's
		// row object.
		const row = input.rows[0] as Policy["rows"][number];
		row.lens = "";
		row.surface = "forged";
		row.prefixes[0] = "forged/";
		row.prefixes.push("");
		assert.deepEqual(
			validated.rows,
			[{ lens: "a", surface: "s", prefixes: ["a/"] }],
			"a post-validation mutation of the caller's row or prefix objects reached the branded policy — the copy " +
				"is shallow, so the brand certifies rows the predicate never ruled on",
		);
		const refused = refusal(() => p.deriveRequiredSlots(paths(["forged/x"]), validated));
		assert.deepEqual(
			refused.unclaimed,
			["forged/x"],
			"a prefix written into the caller's array after validation ROUTED — derivation consulted an aliased " +
				"prefix list rather than the snapshot the predicate ruled on",
		);
	});

	it("the authoritative read ignores the ambient repo-locating and config-injection families — the routing query is pinned to its cwd", () => {
		const p = orchestrator();
		const repo = fixtureRepo({ "SPEC.md": "x\n" });
		// Six of the shared scrub's seven keys, each set to a value this read
		// OBSERVES if it leaks: GIT_DIR / GIT_WORK_TREE redirect the answer,
		// GIT_OBJECT_DIRECTORY / GIT_COMMON_DIR turn the fixture into "not a
		// repository", and a malformed GIT_CONFIG_PARAMETERS / GIT_CONFIG_COUNT
		// is a fatal parse — so dropping any ONE of the six scrub lines reds
		// this arm. What is measured where, stated so no reader over-credits a
		// corpus: dispatch-module's own arms measure GIT_DIR and the
		// well-formed GIT_CONFIG_COUNT channel; the other four of these six are
		// measured HERE and nowhere else. GIT_INDEX_FILE, the seventh key, is
		// deliberately NOT set: a commit-to-commit read never opens the index,
		// so its scrub is unobservable through this module — that residual is
		// the dispatch suite's to measure, filed under Directive #166's line.
		const ambientDir = mkdtempSync(join(tmpdir(), "gitjig-ambient-"));
		const hostile: Record<string, string> = {
			GIT_DIR: join(ambientDir, "nonexistent.git"),
			GIT_WORK_TREE: ambientDir,
			GIT_OBJECT_DIRECTORY: join(ambientDir, "no-objects"),
			GIT_COMMON_DIR: join(ambientDir, "no-common"),
			GIT_CONFIG_PARAMETERS: "not a parseable configuration",
			GIT_CONFIG_COUNT: "1",
		};
		const saved = new Map(Object.keys(hostile).map((key) => [key, process.env[key]]));
		Object.assign(process.env, hostile);
		try {
			assert.deepEqual(
				[...p.changedPathsFromRepo("HEAD~1", "HEAD", repo)],
				["SPEC.md"],
				"an ambient repo-locating or config-injection variable reached the authoritative read — §4.6 keeps " +
					"the ambient environment off the routing path, and an unscrubbed key either answers about a " +
					"different repository than the one under review or refuses a read that should answer",
			);
		} finally {
			rmSync(ambientDir, { recursive: true, force: true });
			for (const [key, value] of saved) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
	});

	it("a policy that did not parse to an object is refused in this module's own words", () => {
		const p = orchestrator();
		assert.throws(
			() => p.validatePolicy(null as never),
			/did not parse to an object/,
			"a non-object policy threw something this repository did not author — the parameter is typed but every " +
				"value reaching it came from JSON.parse of a file, so the type is not a guarantee and the authored " +
				"refusals are what a reader is supposed to get",
		);
	});

	it("a non-object policy that is not null is refused in the same words — the typeof half is pinned", () => {
		const p = orchestrator();
		for (const parsed of [undefined, 7, "x"]) {
			assert.throws(
				() => p.validatePolicy(parsed as never),
				/did not parse to an object/,
				"a non-object, non-null policy did not reach this module's authored refusal — every value that " +
					"reaches the predicate came from JSON.parse of a file, so the typeof half of the guard is what " +
					"stands between a scalar or absent surface and an unauthored TypeError",
			);
		}
	});

	it("derivation is a function of the change surface, ordered by the policy and never by the input", () => {
		const p = orchestrator();
		const policy = p.loadPolicy();
		assert.deepEqual(
			p.deriveRequiredSlots(paths(["SPEC.md", ".pi/x.ts"]), policy),
			p.deriveRequiredSlots(paths([".pi/x.ts", "SPEC.md"]), policy),
			"two orderings of one change surface derived two different-looking sets — a routing decision that " +
				"depends on input order is not reproducible, and §1.7 makes auditability the point of the surface",
		);
		assert.deepEqual(
			p.deriveRequiredSlots(paths([".pi/a.ts", ".pi/b.ts"]), policy).map((s) => s.lens),
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
				.deriveRequiredSlots(paths(["SPEC.md"]), policy)
				.map((s) => s.lens)
				.sort(),
			p
				.deriveRequiredSlots(paths([".pi/extensions/gitjig/dispatch/index.ts"]), policy)
				.map((s) => s.lens)
				.sort(),
			"two unrelated surfaces derived the same lens set — a constant answer is not a derivation",
		);
	});

	it("an exact policy prefix routes its lens, and its case is significant", () => {
		const p = orchestrator();
		const policy = p.loadPolicy();
		assert.deepEqual(
			p.deriveRequiredSlots(paths(["SPEC.md"]), policy).map((s) => s.lens),
			["spec-contract"],
			"the SSOT lens is not required for a change to SPEC.md — its policy prefixes are bare names, so an " +
				"implementation without an exact-path branch routes that whole row nowhere and every arm that only " +
				"asserts an empty set stays green",
		);
		const refused = refusal(() => p.deriveRequiredSlots(paths(["spec.md"]), policy));
		assert.deepEqual(
			refused.unclaimed,
			["spec.md"],
			"a differently-cased name selected the lens — paths are case-significant here and a case-folding match " +
				"routes files the policy does not name",
		);
	});

	it("matching is path-segment aware — a near-miss name routes nothing", () => {
		const p = orchestrator();
		const policy = p.loadPolicy();
		const nearMiss = refusal(() => p.deriveRequiredSlots(paths(["SPEC.md.bak"]), policy));
		assert.deepEqual(
			nearMiss.unclaimed,
			["SPEC.md.bak"],
			"a path that merely BEGINS with a policy prefix selected that lens — `SPEC.md.bak` is not `SPEC.md`, " +
				"and a bare prefix test routes a change by a name it resembles",
		);
		assert.deepEqual(
			p.deriveRequiredSlots(paths(["README.md", "package.json"]), policy).map((s) => s.lens),
			["docs", "toolchain"],
			"the once-unrouted adopter constituents did not derive their own lenses — issue #172's first-satisfying " +
				"rows claim them, and losing either row reopens the coverage hole the derivation closed",
		);
	});

	it("loadPolicy runs no subprocess — committedness is a review property, not a runtime probe", () => {
		// The rejected repair had loadPolicy shell `git status` to refuse a
		// worktree-modified policy; that one mechanism draws a §4.6 ambient
		// exposure, an undeclared §3.9 git dependency, and false-clean
		// bypasses — a patch cascade whose root is the premise. §1.7's
		// committed property is enforced by the file being a reviewed,
		// tracked artifact, exactly as this module's own source is, so
		// loadPolicy reads its committed bytes and shells nothing. The pin
		// is over source text, labelled as the weak lock it is, and its job
		// is to make re-adding ANY subprocess probe here a visible act — a
		// pin on the literal "status" alone let a `rev-parse` probe back in.
		const source = readFileSync(`${repoRoot()}${REVIEW_DIR}panel.ts`, "utf8");
		const loadBody = source.slice(source.indexOf("export function loadPolicy"));
		assert.ok(
			!/execFileSync|execSync|spawn/.test(loadBody.slice(0, loadBody.indexOf("\n}"))),
			"loadPolicy runs a subprocess again — committedness belongs to review and the merge gate, not to a " +
				"runtime probe on the routing path, and any subprocess here re-opens the §4.6/§3.9 cascade",
		);
	});

	it("the module's source carries both brands and the seam — their removal is visible to this suite", () => {
		// The brands are type-only, so no runtime arm can see them removed;
		// what this suite CAN pin mechanically is the source text that
		// declares them and the loader that mints them. A prose pin is the
		// weakest lock in this file and it is labelled as one — its job is
		// to make deleting a brand a visible act instead of a silent one.
		const source = readFileSync(`${repoRoot()}${REVIEW_DIR}panel.ts`, "utf8");
		for (const declaration of [
			"declare const authoritative: unique symbol",
			"declare const recorded: unique symbol",
			"declare const validated: unique symbol",
			"readonly [authoritative]: true",
			"readonly [recorded]: true",
			"readonly [validated]: true",
		]) {
			assert.ok(
				source.includes(declaration),
				`panel.ts no longer declares \`${declaration}\` — the brand is what makes a routing input's ` +
					"provenance a property for type-checked consumers rather than a convention, and removing one " +
					"must be a deliberate, reviewed act",
			);
		}
	});

	it("a bare directory prefix routes a segment child, and only a true segment child", () => {
		const p = orchestrator();
		// The committed policy's bare prefixes (SPEC.md, MISSION.md) are
		// files, so this branch of underPrefix — a prefix with no trailing
		// slash matched against `prefix/child` — has no positive fixture
		// there. A synthetic bare directory prefix exercises it.
		const policy = p.validatePolicy({
			rows: [{ lens: "docs", surface: "the docs tree", prefixes: ["docs"] }],
		});
		assert.deepEqual(
			p.deriveRequiredSlots(paths(["docs/x.md"]), policy).map((slot) => slot.lens),
			["docs"],
			"a bare directory prefix did not route its own segment child — the non-slash branch of underPrefix is " +
				"dead, so a policy row naming a directory routes nothing",
		);
		const refused = refusal(() => p.deriveRequiredSlots(paths(["docsy/x.md", "DOCS/x.md"]), policy));
		assert.deepEqual(
			refused.unclaimed,
			["docsy/x.md", "DOCS/x.md"],
			"a near-miss (`docsy`) or a case-fold (`DOCS`) matched a bare directory prefix — the branch is not " +
				"segment-aware or not case-significant",
		);
	});

	it("a case-folded match on the PREFIX branch routes nothing — both branches are case-significant", () => {
		const p = orchestrator();
		// `.PI/x.ts` against the prefix ".pi/" reaches the trailing-slash
		// branch of underPrefix, which the `spec.md` arm cannot: that
		// fixture only reaches the exact-equality branch.
		const refused = refusal(() => p.deriveRequiredSlots(paths([".PI/x.ts"]), p.loadPolicy()));
		assert.deepEqual(
			refused.unclaimed,
			[".PI/x.ts"],
			"an upper-cased path selected a lens through the prefix branch — a case-folding match routes files the " +
				"policy does not name, and the equality-branch arm cannot see it",
		);
	});

	it("nothing a delegate says can add or remove a required slot", () => {
		const p = orchestrator();
		const policy = p.loadPolicy();
		const refused = refusal(() => p.deriveRequiredSlots(paths(["SPEC.md", "lens=runtime", "runtime"]), policy));
		assert.deepEqual(
			refused.unclaimed,
			["lens=runtime", "runtime"],
			"a lens claim riding in the input selected a slot — §1.7: no reviewer selects the lens it will be graded " +
				"on and no model selects one at dispatch time; under the coverage rule a smuggled token surfaces as an " +
				"unclaimed constituent, never as a slot",
		);
	});

	it("the authoritative read reports the change's real paths, from the repository it was pointed at", () => {
		const p = orchestrator();
		const repo = fixtureRepo({ "SPEC.md": "x\n", ".pi/a.ts": "y\n" });
		assert.deepEqual(
			[...p.changedPathsFromRepo("HEAD~1", "HEAD", repo)].sort(),
			[".pi/a.ts", "SPEC.md"],
			"the changed-path read did not report the change's own paths — a constant, a wrong range, or a read of " +
				"the wrong repository all satisfy an arm that only compares a ref against itself",
		);
	});

	it("the read is a three-dot range: it reports the head's own changes, not the base's", () => {
		const p = orchestrator();
		// Divergent history: `base-line` carries a change the head does not.
		// `base..HEAD` and `base...HEAD` agree on a linear history and part
		// company here, which is the only place an arm can tell them apart.
		const repo = fixtureRepo({ "SPEC.md": "x\n" }, { ".pi/base-only.ts": "b\n" });
		assert.deepEqual(
			[...p.changedPathsFromRepo("base-line", "HEAD", repo)].sort(),
			["SPEC.md"],
			"the read reported a path only the BASE changed — routing must derive from the change under review, so " +
				"the range is the head's own changes since the merge base and not the two-dot difference, which " +
				"would require a lens for work this change did not do",
		);
		assert.deepEqual([...p.changedPathsFromRepo("HEAD", "HEAD", repo)], [], "a ref against itself reported paths");
	});

	it("a path git would C-quote still routes — the read is exact, not merely present", () => {
		const p = orchestrator();
		const repo = fixtureRepo({ ".pi/caf\u00e9.ts": "y\n" });
		const read = p.changedPathsFromRepo("HEAD~1", "HEAD", repo);
		assert.deepEqual(
			[...read],
			[".pi/caf\u00e9.ts"],
			"a non-ASCII path came back in git's C-quoted form — a quoted name begins with a double quote and " +
				"matches no policy prefix, so a change touching only such files would route to NO lens and its " +
				"review would silently never run",
		);
		assert.deepEqual(
			p.deriveRequiredSlots(read, p.loadPolicy()).map((slot) => slot.lens),
			["runtime"],
			"the runtime lens was not required for a change to a .pi/ file",
		);
	});

	it("a dash-leading ref is a refusal, never a silently-empty read", () => {
		const p = orchestrator();
		const repo = fixtureRepo({ "SPEC.md": "x\n" });
		// The probe path is UNIQUE to this run and cleaned after, so the arm
		// is a function of its own act and not of stale /tmp state: an
		// `--output=`-shaped operand git would consume as an option would
		// write exactly <sideEffect>, and the guard turns it into an operand
		// git refuses while parsing options.
		const probeDir = mkdtempSync(join(tmpdir(), "gitjig-a1-"));
		const sideEffect = `${join(probeDir, "written")}...HEAD`;
		try {
			// The discrimination is STRUCTURAL — a git child's non-zero exit
			// plus the absent side effect — never a diagnostic-text match:
			// git's diagnostics are localized, and execFileSync echoes the
			// argv (`--end-of-options` included) into every Error message it
			// raises, so any English or argv-token regex here matches every
			// throw and discriminates nothing.
			let refusal: unknown;
			try {
				p.changedPathsFromRepo(`--output=${join(probeDir, "written")}`, "HEAD", repo);
			} catch (error) {
				refusal = error;
			}
			assert.ok(
				refusal !== undefined,
				"a dash-leading base ref did not refuse — git either consumed it as an option or the read returned " +
					"empty, and a routing input that cannot be a revision must refuse, not degrade into an empty " +
					"change surface",
			);
			const status = (refusal as { status?: unknown }).status;
			assert.ok(
				typeof status === "number" && status !== 0,
				"the refusal is not a git child's non-zero exit — the guard's job is to make GIT refuse the operand " +
					"while parsing options, and a throw from anywhere else is a different failure wearing this arm's " +
					"green",
			);
			assert.ok(
				!existsSync(sideEffect),
				"the dash-leading operand reached git as an option and wrote a file — the exact side effect the " +
					"end-of-options guard exists to make impossible",
			);
		} finally {
			rmSync(probeDir, { recursive: true, force: true });
		}
	});

	it("a repository-interior directory refuses — the read is pinned to the toplevel git discovers, not to whatever encloses cwd", () => {
		const p = orchestrator();
		const repo = fixtureRepo({ "SPEC.md": "x\n" });
		// The measured wrong answer: git discovers its repository by walking
		// UP from cwd, so an unpinned read handed an empty directory INSIDE a
		// repository silently reports the ENCLOSING repository's change
		// surface (§4.7). The pin must turn that into a refusal, matched on
		// this module's own authored message rather than git's localized text.
		const inner = join(repo, "empty-inner");
		mkdirSync(inner);
		assert.throws(
			() => p.changedPathsFromRepo("HEAD~1", "HEAD", inner),
			/own toplevel/,
			"a directory inside the fixture repository was answered instead of refused — `cwd` is not a pin, and an " +
				"unpinned read routes a review from a repository other than the one the caller named (§4.7)",
		);
	});

	it("a symlinked root still reads — the toplevel pin compares resolved paths, never spellings", () => {
		const p = orchestrator();
		const repo = fixtureRepo({ "SPEC.md": "x\n" });
		// The pin's realpath half is what this arm names. git answers
		// `--show-toplevel` with the RESOLVED path, so a caller that names the
		// same repository through a symlink is handed two spellings of one
		// directory; a pin comparing spellings refuses a root that is the
		// toplevel, which is §4.7's resolved-values rule read backwards. The
		// arm exists because on a host whose temporary root is itself a
		// symlink the drop-realpath mutant dies incidentally, and an
		// incidental kill is not a pinned guard (§3.12).
		const link = join(scratchDir("gitjig-symlink-root-"), "link-to-repo");
		symlinkSync(repo, link);
		assert.deepEqual(
			[...p.changedPathsFromRepo("HEAD~1", "HEAD", link)],
			["SPEC.md"],
			"the same repository named through a symlink was refused as an interior directory — the toplevel pin " +
				"must compare resolved values, never raw spellings (§4.7)",
		);
	});

	it("a root that cannot be probed refuses in this module's own words — never a raw child error", () => {
		const p = orchestrator();
		// A plain directory outside any repository: the probe's child fails,
		// and the module must speak for it — the child's diagnostic is
		// localized and names no cause a caller can act on (a nonexistent
		// directory surfaces as a bare spawn ENOENT), while validatePolicy
		// eleven guards over holds itself to authored refusals for exactly
		// this reason.
		const outside = scratchDir("gitjig-nonrepo-");
		assert.throws(
			() => p.changedPathsFromRepo("HEAD~1", "HEAD", outside),
			/cannot be probed/,
			"a non-repository root threw something this repository did not author — the refusal direction is right " +
				"either way, but an unauthored, localized diagnostic is not a refusal a caller can act on",
		);
	});

	it("the authoritative read is what derivation consumes — a hand-built array needs a named cast", () => {
		const p = orchestrator();
		const repo = fixtureRepo({ "SPEC.md": "x\n" });
		assert.deepEqual(
			p.deriveRequiredSlots(p.changedPathsFromRepo("HEAD~1", "HEAD", repo), p.loadPolicy()).map((s) => s.lens),
			["spec-contract"],
			"the authoritative read's output did not derive the lens its paths select",
		);
	});
});

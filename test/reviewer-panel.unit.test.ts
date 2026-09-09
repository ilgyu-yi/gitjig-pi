/**
 * The reviewer panel orchestrator (issue #169, Directive #166) — the
 * behavioural boundaries SPEC §1.6 and §1.7 fix, one arm per boundary.
 *
 * What this suite is for. §1.7's panel is a SEARCH, not a vote, and the
 * properties that follow from that are the ones a wrong implementation
 * quietly loses: a lone finding survives its empty co-reviews, the bundle
 * is transport and never a filter, an invalid slot is NO RESULT rather
 * than a quiet abstention, and routing is derived from the change itself
 * against a committed table rather than from anything a delegate says.
 * Each arm below kills one of those losses.
 *
 * The subject-absence anchor. The orchestrator does not exist on the
 * pre-change tree, so every arm here reds on its own authored message
 * rather than on a module-resolution crash: the modules are pulled
 * through one guarded dynamic import, and the first arm states the
 * absence in terms. That is the same shape `dispatch-module` uses and
 * for the same reason — a top-level static import of a missing module
 * aborts the file and erases every authored message in it.
 *
 * What this suite does NOT measure, so a reader does not over-read it:
 * the Judge and the Resolver, which are a later Execution under #166 and
 * whose absence is exactly what the findings-free arm pins; the CONTENT
 * of the lens policy, which §1.7 puts outside its own contract; and the
 * dispatcher's own arms, which live in `dispatch-module` and must stay
 * green untouched (#166's non-goal — review policy lives ABOVE the
 * dispatcher, never in it).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./harness/run-pi.ts";

const REVIEW_DIR = "/.pi/extensions/gitjig/review/";

type Slot = { lens: string; surface: string };
type SlotResult =
	| { slot: Slot; token: "APPROVED" | "FINDINGS"; findings: string[]; compare: "confirmed" | "invalid" }
	| { slot: Slot; malformed: true };

type PanelModule = {
	deriveRequiredSlots(changedPaths: string[], policy: unknown): Slot[];
	loadPolicy(path?: string): unknown;
	decideValidity(result: SlotResult, slot: Slot): { valid: boolean; reason?: string };
	buildBundle(results: SlotResult[], required: Slot[]): { finding: string; lens: string }[];
	panelOutcome(
		results: SlotResult[],
		required: Slot[],
	):
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

/** Every arm's guard: red on the authored absence, never on a stack trace. */
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

function approved(slot: Slot): SlotResult {
	return { slot, token: "APPROVED", findings: [], compare: "confirmed" };
}
function findings(slot: Slot, ...items: string[]): SlotResult {
	return { slot, token: "FINDINGS", findings: items, compare: "confirmed" };
}

describe("§1.7 the reviewer panel — search diversification, not a vote (issue #169)", () => {
	it("one valid finding survives any number of empty co-reviews", () => {
		const p = orchestrator();
		const required = [LENS_A, LENS_B, { lens: "third", surface: "test/" }];
		const results = [findings(LENS_A, "the lone finding"), approved(LENS_B), approved(required[2] as Slot)];
		const bundle = p.buildBundle(results, required);
		assert.equal(
			bundle.length,
			1,
			"a finding held by one slot did not survive two empty co-reviews — the panel is behaving like a vote, " +
				"which §1.7 records as the rejected design precisely because it discards a true minority finding",
		);
		assert.equal(bundle[0]?.finding, "the lone finding");
	});

	it("aggregation is mechanical: nothing is dropped, filtered, or deduplicated", () => {
		const p = orchestrator();
		const required = [LENS_A, LENS_B];
		// The SAME finding text from two slots: a semantic dedup would
		// collapse these, and dedup is the Judge's act, never the bundle's.
		const results = [findings(LENS_A, "same text", "other"), findings(LENS_B, "same text")];
		const bundle = p.buildBundle(results, required);
		assert.equal(
			bundle.length,
			3,
			'the bundle lost a finding — §1.7 makes it transport ("a bundle that dropped a finding is a defective ' +
				"bundle, not a strict one\"), and semantic deduplication is §1.9's Judge act, not the caller's",
		);
	});

	it("every finding's originating slot stays recoverable — provenance is not lost in transport", () => {
		const p = orchestrator();
		const bundle = p.buildBundle([findings(LENS_A, "x"), findings(LENS_B, "y")], [LENS_A, LENS_B]);
		assert.deepEqual(
			bundle.map((entry) => entry.lens).sort(),
			["runtime", "spec-contract"],
			"a finding reached the bundle without its originating lens — §1.9's dedup must preserve \"every raw " +
				"finding's provenance\", which it cannot do if the bundle never carried it",
		);
	});

	it("a findings-free complete panel is APPROVED, and yields no bundle for a Judge to run on", () => {
		const p = orchestrator();
		const outcome = p.panelOutcome([approved(LENS_A), approved(LENS_B)], [LENS_A, LENS_B]);
		assert.equal(
			outcome.outcome,
			"approved",
			"a complete panel that discovered nothing did not yield Review APPROVED — §1.9's findings-free path " +
				"ends review for that head and the Judge never runs",
		);
		assert.ok(
			!("bundle" in outcome),
			"the findings-free path produced a bundle — there is nothing to adjudicate, so the Judge must have no input",
		);
	});

	it("panel completeness is all-required-slots-valid: one missing slot is incomplete, not a pass", () => {
		const p = orchestrator();
		const outcome = p.panelOutcome([approved(LENS_A)], [LENS_A, LENS_B]);
		assert.equal(
			outcome.outcome,
			"incomplete",
			'a panel missing a required slot was read as an outcome — §1.7: "An incomplete panel is ... not a ' +
				'review outcome at all", and it stops the flow rather than passing it',
		);
	});
});

describe("§1.6/§1.7 an invalid slot is a missing result, never a verdict (issue #169)", () => {
	const causes: [string, SlotResult][] = [
		["failed blind compare", { slot: LENS_A, token: "APPROVED", findings: [], compare: "invalid" }],
		["malformed return", { slot: LENS_A, malformed: true }],
		[
			"reviewed the wrong surface",
			{ slot: { lens: "spec-contract", surface: "test/" }, token: "APPROVED", findings: [], compare: "confirmed" },
		],
	];

	for (const [cause, result] of causes) {
		it(`a slot that ${cause} is no result — never an approve`, () => {
			const p = orchestrator();
			const verdict = p.decideValidity(result, LENS_A);
			assert.equal(
				verdict.valid,
				false,
				`a slot that ${cause} was counted valid — §1.6 makes validity the CALLER's fact and §1.7 makes an ` +
					"invalid slot no result at all: never an approve, never a reject, never an abstention some " +
					"denominator absorbs",
			);
			const outcome = p.panelOutcome([result, approved(LENS_B)], [LENS_A, LENS_B]);
			assert.equal(
				outcome.outcome,
				"incomplete",
				`a panel carrying a slot that ${cause} was read as an outcome — an invalid slot leaves the panel ` +
					"incomplete, which passes no gate",
			);
		});
	}

	it("a reviewer cannot vouch for its own validity: a self-asserted pass still fails the caller's compare", () => {
		const p = orchestrator();
		// The delegate says APPROVED and claims the head; the CALLER's
		// compare is what decides, and it says invalid.
		const selfAsserted: SlotResult = { slot: LENS_A, token: "APPROVED", findings: [], compare: "invalid" };
		assert.equal(
			p.decideValidity(selfAsserted, LENS_A).valid,
			false,
			"a reviewer's own claim was allowed to establish its validity — §1.6: validity is \"decided by the caller " +
				'and never reported by the reviewer, which cannot attest to its own integrity"',
		);
	});
});

describe("§1.7 required slots derive from a committed, caller-owned policy surface (issue #169)", () => {
	it("the policy is a committed repository artifact this suite can read and diff", () => {
		const p = orchestrator();
		const policy = p.loadPolicy();
		assert.ok(
			policy && typeof policy === "object",
			"no committed lens policy resolved — §1.7 requires the surface be COMMITTED, so that a routing " +
				"decision is auditable after the fact rather than reconstructed from a run",
		);
	});

	it("slot derivation is a function of the change surface: same paths, same slots, every time", () => {
		const p = orchestrator();
		const policy = p.loadPolicy();
		const first = p.deriveRequiredSlots(["SPEC.md"], policy);
		const second = p.deriveRequiredSlots(["SPEC.md"], policy);
		assert.deepEqual(
			first,
			second,
			'slot derivation was not a function of its inputs — §1.7 reads routing from "authoritative facts about ' +
				'the change under review", which is what makes a routing decision reproducible and auditable',
		);
		assert.ok(
			first.length > 0,
			"a SPEC.md change derived no required lens at all — the committed policy carries no row a real change " +
				"surface matches, so routing is decorative",
		);
	});

	it("a different change surface derives a different required set — the table is actually consulted", () => {
		const p = orchestrator();
		const policy = p.loadPolicy();
		const specSlots = p.deriveRequiredSlots(["SPEC.md"], policy).map((s) => s.lens);
		const runtimeSlots = p.deriveRequiredSlots([".pi/extensions/gitjig/dispatch/index.ts"], policy).map((s) => s.lens);
		assert.notDeepEqual(
			specSlots.sort(),
			runtimeSlots.sort(),
			"two unrelated change surfaces derived the same required lens set — the policy table is not being " +
				"consulted, and a constant answer is not a derivation",
		);
	});

	it("nothing a delegate says can add or remove a required slot", () => {
		const p = orchestrator();
		const policy = p.loadPolicy();
		const honest = p.deriveRequiredSlots(["SPEC.md"], policy);
		// A delegate-shaped claim smuggled into the path set: it must not
		// select a lens, because §1.7 forbids a self-selected specialist.
		const smuggled = p.deriveRequiredSlots(["SPEC.md", "lens=runtime"], policy);
		assert.deepEqual(
			smuggled.map((s) => s.lens).sort(),
			honest.map((s) => s.lens).sort(),
			"a lens claim riding in the input selected a slot — §1.7: no reviewer selects the lens it will be graded " +
				"on and no model selects one at dispatch time, because a self-selected specialist re-imports the " +
				"omission bias §1.8 names",
		);
	});
});

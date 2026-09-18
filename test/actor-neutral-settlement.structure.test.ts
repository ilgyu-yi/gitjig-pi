import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const root = repoRoot();
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const spec = read("SPEC.md");

function section(heading: string, nextHeading: string): string {
	const start = spec.indexOf(heading);
	const end = spec.indexOf(nextHeading, start + heading.length);
	assert.ok(start >= 0 && end > start, `missing section bounds: ${heading} -> ${nextHeading}`);
	return spec.slice(start, end);
}

function requires(subject: string, tokens: readonly string[]): void {
	for (const token of tokens) assert.ok(subject.includes(token), `missing contract token: ${token}`);
}

const lifecycle = section("### 2.2 Lifecycle states", "### 2.3 PR-as-living-doc");
const tiers = section("### 3.2 The three tiers", "### 3.3 Gate classes");
const gates = section("### 3.3 Gate classes", "### 3.4 Agent-agnosticism of the tiers");
const calibration = section("### 3.6 Enforcement-face selection", "### 3.7 Approval-gate completeness");
const escapeSection = section("### 3.8 Escape architecture", "### 3.9 Fail policy");
const design = section("### 3.11 Gate design", "### 3.12 Gate verification");
const modes = section("### 5.6 Operating modes", "### 5.7 Run conduct");
const conduct = section("### 5.7 Run conduct", "### 5.8 Context lifecycle");

function actorContract(source: string): void {
	requires(source, [
		"platform actor type `User`",
		"`OWNER`, `MEMBER`, or `COLLABORATOR`",
		"actor id differs from the pull request author id",
		"`Bot`, App, an absent or unknown actor type or association, author self-review, dismissed, pending, comment-only, and stale-head reviews do not count",
		"positive integer configured only by the `human-approval` ruleset",
		"code carries no second quorum default",
		"`MAINTAIN` or `ADMIN`",
		"explicitly addressed repository permission endpoint",
		"own-behalf rule",
		"attested installation and node identity appear in committed policy",
	]);
}

function modeContract(source: string): void {
	requires(source, [
		"`merge-mode: off | on`",
		"`decision-mode: handoff | autonomous`",
		"`--merge-mode`",
		"`GITJIG_MERGE_MODE`",
		"`mergeMode`",
		"default `off`",
		"Unknown, conflicting, or unreadable",
		"falls to `off`",
		"`--decision-mode`",
		"`GITJIG_DECISION_MODE`",
		"`decisionMode`",
		"default `handoff`",
		"ordinary landing first",
		"only when quorum alone blocks",
		"Decision mode grants no landing authority",
	]);
}

describe("#273 actor-neutral landing settlement", () => {
	it("closes the canonical actor predicates and the one quorum owner", () => actorContract(escapeSection));

	it("pins independent merge and decision settings with fail-safe resolution", () => modeContract(modes));

	it("settles ordinary and discretionary landing without turning intent into approval", () => {
		requires(escapeSection, [
			"Ordinary landing requires",
			"current eligible-human quorum",
			"all core governance",
			"Discretionary landing requires",
			"`merge:bypass-permitted`",
			"PR-only intent",
			"never approval, readiness, evidence, capability, a check, or a command",
			"exactly 24 hours",
			"consumes and removes",
			"on success or refusal",
			"quorum alone",
		]);
	});

	it("makes core governance doorless and the human quorum the sole Tier-3 door", () => {
		requires(escapeSection, [
			"core governance is doorless",
			"only Tier-3 door",
			"human quorum",
			"changelog, ssot-home, toc-freshness, source-style, type-check, suite, ac-closeout",
			"protected-branch landing, force-push, required contexts including never-reported contexts, review-thread resolution, merge method, head and base freshness, and history",
		]);
		assert.ok(tiers.includes("Before the split-ruleset phase activates, the quorum escape is disabled"));
	});

	it("makes unauthorized landing the wrong-allow class and closes calibration inputs", () => {
		requires(calibration, [
			"unauthorized landing",
			"core governance plus either current eligible-human quorum or one valid consumed escape",
			"non-pass verdicts, blocked transitions, handoff records, and escapes",
			"delay when quorum alone is unavailable",
		]);
	});

	it("settles lifecycle records, transitions, and the Resolver-only repair count", () => {
		requires(lifecycle, [
			"`awaiting-author` is an Issue/PR handoff",
			"Resolver `repair`",
			"eligible-human PR `CHANGES_REQUESTED`",
			"Human review never contributes to §1.4's Resolver-repair count",
			"PR synchronization to any new head clears",
			"only an Issue body edit by that Issue's author clears",
			"`blocked`",
			"`{condition,recovery,observedAt,subjectHead,baseHead}`",
			"Clearing a blocker never activates proposed work",
			"`{cause,recipient,reentry,observedAt,subjectHead,baseHead}`",
		]);
	});

	it("authorizes merged state rather than equating it with panel review", () => {
		requires(design, [
			"merged state is authorized landing state",
			"current eligible-human quorum plus all core facts",
			"consumed escape record plus all core facts",
		]);
	});

	it("keeps the phase-1 boundary explicit", () => {
		requires(conduct, ["Phase 2 owns", "transition writers and clearers"]);
		requires(gates, ["Phase 2", "Phase 3", "Phase 4"]);
		assert.ok(spec.includes("Phase 5"));
	});

	it("removes every retired merge-review runtime, workflow, posture, and pending claim", () => {
		for (const path of [
			".github/workflows/check-merge-review.yml",
			".github/workflows/check-merge-review.mjs",
			".pi/extensions/gitjig/review/merge-gate.ts",
			"test/merge-review-gate.unit.test.ts",
			"test/merge-review-workflow.structure.test.ts",
			"changelog_unreleased/added/190.md",
			"changelog_unreleased/fixed/194.md",
		]) {
			assert.equal(existsSync(join(root, path)), false, `retired path survives: ${path}`);
		}
		assert.ok(!read(".pi/extensions/gitjig/postures.ts").includes("merge-review-record-lookup"));
		assert.ok(!read(".pi/extensions/gitjig/commands/ship.ts").includes("verdict-head"));
	});

	it("removes the contradictory any-actor clearer and old mode/park release claims", () => {
		for (const path of [
			".github/workflows/auto-clear-awaiting-author.yml",
			"changelog_unreleased/added/15.md",
			"changelog_unreleased/changed/143.md",
		]) {
			assert.equal(existsSync(join(root, path)), false, `retired path survives: ${path}`);
		}
	});

	it("keeps mission and adopter-facing prose actor-neutral", () => {
		for (const path of ["MISSION.md", "README.md"]) {
			const body = read(path);
			assert.ok(body.includes("authorized landing"), `${path} lacks authorized-landing wording`);
			assert.ok(body.includes("human"), `${path} omits human operation`);
			for (const retired of ["review-gated merge", "attended", "unattended", "merge-review"]) {
				assert.ok(!body.includes(retired), `${path} retains ${retired}`);
			}
		}
	});
});

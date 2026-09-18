import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

function markdownFilesUnder(relative: string): string[] {
	return readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) => {
		const path = join(relative, entry.name);
		if (entry.isDirectory()) return markdownFilesUnder(path);
		return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
	});
}

const retiredVocabulary = [
	/\bexecution[- ]mode\b/iu,
	/\battended\b/iu,
	/\bunattended\b/iu,
	/\bpark(?:ed|ing|s)?\b/iu,
	/merge-or-park/iu,
	/merge-review/iu,
	/review-gated/iu,
	/status:blocked/iu,
] as const;

function assertRetiredVocabularyAbsent(documents: ReadonlyMap<string, string>): void {
	for (const [path, body] of documents) {
		for (const pattern of retiredVocabulary) {
			assert.ok(!pattern.test(body), `retired actor/mode vocabulary survives in ${path}: ${pattern.source}`);
		}
	}
}

const migrationDocuments = new Map(
	["SPEC.md", "MISSION.md", "README.md", ...markdownFilesUnder("changelog_unreleased")].map((path) => [
		path,
		read(path),
	]),
);

const lifecycle = section("### 2.2 Lifecycle states", "### 2.3 PR-as-living-doc");
const tiers = section("### 3.2 The three tiers", "### 3.3 Gate classes");
const gates = section("### 3.3 Gate classes", "### 3.4 Agent-agnosticism of the tiers");
const calibration = section("### 3.6 Enforcement-face selection", "### 3.7 Approval-gate completeness");
const approvals = section("### 3.7 Approval-gate completeness", "### 3.8 Escape architecture");
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
			"Worked application — the egress boundary",
			"reuses the commit-time secret gate's pattern source",
			"neutralizes relayed mentions and actionable references",
		]);
	});

	it("pins the restored ref identity and approval cross-reference targets", () => {
		requires(gates, [
			"`protected-branch` ref-identity semantics",
			"one derived identity P",
			"Stage 1 reads the local pointer",
			"Stage 2, only where stage 1 fails",
			"Byte-equal to P",
			"ASCII-case-fold-equal to P but byte-unequal",
			"identity established as **not P**",
			"P underivable",
		]);
		requires(approvals, [
			"(a) **Attribution, subject binding, and freshness**",
			"(b) **No silent skip**",
			"(c) **Fail-closed lookup**",
			"(d) **Evidence provenance**",
			"Nit carry-forward",
			"(e) **Predicate integrity**",
		]);
		requires(escapeSection, [
			"Total-coverage rule",
			"Core governance takes the deliberate doorless disposition",
			"Refusal-record rule",
			"exactly one content-free terminal record naming the refusing arm",
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
			"explicit **completion review**",
			"required evidence artifact is the platform comment",
			"binds the current Directive body",
			"Completion review is per-success-signal evidence sufficiency",
			"archived as a write-once record",
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

	it("removes the contradictory any-actor clearer and superseded release claim", () => {
		for (const path of [".github/workflows/auto-clear-awaiting-author.yml", "changelog_unreleased/changed/143.md"]) {
			assert.equal(existsSync(join(root, path)), false, `retired path survives: ${path}`);
		}
	});

	it("guards retired actor and mode vocabulary across every migrated durable document", () => {
		assertRetiredVocabularyAbsent(migrationDocuments);
		for (const [inserted, expected] of [
			["An unattended run hands off at this boundary.", /\\bunattended\\b/],
			["A run parks at this boundary.", /\\bpark\(\?:ed\|ing\|s\)\?\\b/],
		] as const) {
			const mutated = new Map(migrationDocuments);
			mutated.set(
				"SPEC.md",
				spec.replace("### 3.7 Approval-gate completeness", `${inserted}\n\n### 3.7 Approval-gate completeness`),
			);
			assert.notEqual(mutated.get("SPEC.md"), spec, "full-SPEC retired-vocabulary mutant anchor did not match");
			assert.throws(
				() => assertRetiredVocabularyAbsent(mutated),
				(error: unknown) =>
					error instanceof Error &&
					/retired actor\/mode vocabulary survives in SPEC\.md/.test(error.message) &&
					expected.test(error.message),
			);
		}
	});

	it("keeps the surviving release claims while migrating retired ones", () => {
		const modesFragment = read("changelog_unreleased/added/15.md");
		requires(modesFragment, ["merge and decision operating modes", "clean/soft/hard", "handoff", "§3.8"]);
		const findingFragment = read("changelog_unreleased/added/60.md");
		requires(findingFragment, ["the Judge assigns", "Directive completion", "ready transition", "§3.7(d)"]);
		assert.ok(!findingFragment.includes("merge head-pin"));
		const commandFragment = read("changelog_unreleased/added/91.md");
		requires(commandFragment, ["`ac-closeout`", "platform-held AC state", "landing decision"]);
		assert.ok(!commandFragment.includes("merge-boundary"));
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

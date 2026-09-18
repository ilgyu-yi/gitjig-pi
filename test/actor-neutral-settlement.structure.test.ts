import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const root = repoRoot();
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const spec = read("SPEC.md");

function sectionIn(source: string, heading: string, nextHeading: string): string {
	const start = source.indexOf(heading);
	const end = source.indexOf(nextHeading, start + heading.length);
	assert.ok(start >= 0 && end > start, `missing section bounds: ${heading} -> ${nextHeading}`);
	return source.slice(start, end);
}

function section(heading: string, nextHeading: string): string {
	return sectionIn(spec, heading, nextHeading);
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

const migratedSourcePaths = [
	".github/workflows/issues-to-project-mirror.yml",
	".pi/extensions/gitjig/commands/review-round.ts",
	".pi/extensions/gitjig/commands/ship.ts",
	".pi/extensions/gitjig/dispatch/index.ts",
	".pi/extensions/gitjig/postures.ts",
	".pi/extensions/gitjig/review/history.ts",
	".pi/extensions/gitjig/review/subject.ts",
	".pi/extensions/gitjig/session-surface.ts",
] as const;

const changelogDocuments = new Map(markdownFilesUnder("changelog_unreleased").map((path) => [path, read(path)]));

const migrationSurfaces = new Map(
	["SPEC.md", "MISSION.md", "README.md", ...changelogDocuments.keys(), ...migratedSourcePaths].map((path) => [
		path,
		read(path),
	]),
);

const supersededChangelogClaims = [
	["finder-owned §1.4 severity", /SPEC §1\.4's finding-severity clause/u],
	["finder-owned harm direction", /the finder records each finding's cost direction/u],
	["retired ladder accounting", /enters no ladder or backstop count/u],
	["retired fixed-denominator quorum", /the high-asymmetry fixed-denominator quorum \(§1\.7\)/u],
	["retired Judge substitution", /author-as-judge/u],
] as const;

function assertCurrentChangelogClaims(documents: ReadonlyMap<string, string>): void {
	for (const [path, body] of documents) {
		for (const [claim, pattern] of supersededChangelogClaims) {
			assert.ok(!pattern.test(body), `superseded changelog claim survives in ${path}: ${claim}`);
		}
	}
}

function assertRepairContract(source: string): void {
	requires(sectionIn(source, "### 0.3 Reading and amendment conventions", "## 1. Work norms"), [
		"*spec-behind* (code lags a settled section",
	]);
	requires(sectionIn(source, "### 2.2 Lifecycle states", "### 2.3 PR-as-living-doc"), [
		"exactly `<!-- activation-verdict: pass -->` or `<!-- activation-verdict: reject -->`",
		"The first is the only passing token",
	]);
	requires(sectionIn(source, "### 2.6 SSOT change-reach protocol", "### 2.7 Canonical naming"), [
		"The `change-reach` class is deliberately doorless",
		"correct or widen the cumulative trailers or the surviving artifact",
	]);
	requires(sectionIn(source, "### 3.2 The three tiers", "### 3.3 Gate classes"), [
		"protected-branch landing and deletion protection",
		"merge-commit-only method, non-fast-forward history, deletion protection, and review-thread resolution",
	]);
	requires(sectionIn(source, "### 3.3 Gate classes", "### 3.4 Agent-agnosticism of the tiers"), [
		"A misplaced row is a reversible document defect",
		"separately recorded §3.11 backstop obligation",
	]);
	requires(sectionIn(source, "### 3.4 Agent-agnosticism of the tiers", "### 3.5 Gate conduct"), [
		"No enforced norm depends on a specific agent or model",
		'MISSION § "Success looks like > Agent-agnosticism"',
		"pi-independent repository floor",
	]);
	requires(sectionIn(source, "### 3.7 Approval-gate completeness", "### 3.8 Escape architecture"), [
		"The `approval-evidence` class is deliberately doorless",
		"produce fresh canonical evidence",
	]);
	requires(sectionIn(source, "### 3.8 Escape architecture", "### 3.9 Fail policy"), [
		"protected-branch landing and deletion protection",
		"`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` family",
		"Each channel was measured on a fresh armed clone",
		"outside **§5.9's disarm bar**",
		"work tree selected on the command line or through `core.worktree` keeps the separate §3.2 disposition",
	]);
}

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
			"protected-branch landing and deletion protection, force-push, required contexts including never-reported contexts, review-thread resolution, merge method, head and base freshness, and history",
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

	it("guards retired actor and mode vocabulary across every migrated durable settlement surface", () => {
		assertRetiredVocabularyAbsent(migrationSurfaces);
		for (const { path, anchor, inserted, expected } of [
			{
				path: "SPEC.md",
				anchor: "### 3.7 Approval-gate completeness",
				inserted: "An unattended run hands off at this boundary.",
				expected: /retired actor\/mode vocabulary survives in SPEC\.md: \\bunattended\\b/,
			},
			{
				path: ".pi/extensions/gitjig/session-surface.ts",
				anchor: " * The minimal persistent session projection (§5.9).",
				inserted: " * An unattended run parks at this boundary.",
				expected:
					/retired actor\/mode vocabulary survives in \.pi\/extensions\/gitjig\/session-surface\.ts: \\bunattended\\b/,
			},
			{
				path: ".github/workflows/issues-to-project-mirror.yml",
				anchor: "# One-direction sync: Issue events → Project Item fields.",
				inserted: "# A review-gated run uses the retired carrier here.",
				expected:
					/retired actor\/mode vocabulary survives in \.github\/workflows\/issues-to-project-mirror\.yml: review-gated/,
			},
		] as const) {
			const original = migrationSurfaces.get(path);
			if (original === undefined) assert.fail(`missing retired-vocabulary mutant subject: ${path}`);
			assert.ok(original.includes(anchor), `retired-vocabulary mutant anchor did not match: ${path}`);
			const mutated = new Map(migrationSurfaces);
			mutated.set(path, original.replace(anchor, `${inserted}\n${anchor}`));
			assert.throws(
				() => assertRetiredVocabularyAbsent(mutated),
				(error: unknown) => error instanceof Error && expected.test(error.message),
				`retired-vocabulary mutant reached the wrong guard: ${path}`,
			);
		}
	});

	it("pins the repaired contract as coherent sections and attributes each mutant to its missing member", () => {
		assertRepairContract(spec);
		for (const { anchor, replacement, expected } of [
			{
				anchor: "*spec-behind* (code lags a settled section",
				replacement: "*spec-ahead* (code lags a settled section",
				expected: "*spec-behind* (code lags a settled section",
			},
			{
				anchor: "exactly `<!-- activation-verdict: pass -->` or `<!-- activation-verdict: reject -->`",
				replacement: "exactly `ACTIVATE` or `REJECT`",
				expected: "exactly `<!-- activation-verdict: pass -->` or `<!-- activation-verdict: reject -->`",
			},
			{
				anchor: "The `change-reach` class is deliberately doorless",
				replacement: "The `change-reach` class is procedural",
				expected: "The `change-reach` class is deliberately doorless",
			},
			{
				anchor: "protected-branch landing and deletion protection",
				replacement: "protected-branch landing",
				expected: "protected-branch landing and deletion protection",
			},
			{
				anchor: "A misplaced row is a reversible document defect",
				replacement: "A misplaced row does not trigger hardening",
				expected: "A misplaced row is a reversible document defect",
			},
			{
				anchor: "No enforced norm depends on a specific agent or model",
				replacement: "Tier placement does not depend on a specific agent or model",
				expected: "No enforced norm depends on a specific agent or model",
			},
			{
				anchor: "pi-independent repository floor",
				replacement: "Pi-independent repository floor",
				expected: "pi-independent repository floor",
			},
			{
				anchor: "The `approval-evidence` class is deliberately doorless",
				replacement: "The `approval-evidence` class remains procedural",
				expected: "The `approval-evidence` class is deliberately doorless",
			},
			{
				anchor: "Each channel was measured on a fresh armed clone",
				replacement: "Each channel is an equivalent fold",
				expected: "Each channel was measured on a fresh armed clone",
			},
		] as const) {
			const mutated = spec.replace(anchor, replacement);
			assert.notEqual(mutated, spec, `repair-contract mutant anchor did not match: ${anchor}`);
			assert.throws(
				() => assertRepairContract(mutated),
				(error: unknown) => error instanceof Error && error.message === `missing contract token: ${expected}`,
				`repair-contract mutant reached the wrong guard: ${anchor}`,
			);
		}
	});

	it("audits the full unreleased changelog corpus for superseded settlement claims", () => {
		assertCurrentChangelogClaims(changelogDocuments);
		for (const { path, inserted, expected } of [
			{
				path: "changelog_unreleased/changed/142.md",
				inserted: "SPEC §1.4's finding-severity clause",
				expected: "finder-owned §1.4 severity",
			},
			{
				path: "changelog_unreleased/added/13.md",
				inserted: "the high-asymmetry fixed-denominator quorum (§1.7)",
				expected: "retired fixed-denominator quorum",
			},
			{
				path: "changelog_unreleased/changed/144.md",
				inserted: "author-as-judge",
				expected: "retired Judge substitution",
			},
		] as const) {
			const original = changelogDocuments.get(path);
			assert.ok(original, `missing changelog mutant subject: ${path}`);
			const mutated = new Map(changelogDocuments);
			mutated.set(path, `${original.trimEnd()} ${inserted}\n`);
			assert.throws(
				() => assertCurrentChangelogClaims(mutated),
				(error: unknown) =>
					error instanceof Error && error.message === `superseded changelog claim survives in ${path}: ${expected}`,
				`changelog mutant reached the wrong guard: ${path}`,
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
		requires(read("changelog_unreleased/changed/142.md"), [
			"SPEC §1.9",
			"Judge explicitly rules",
			"deterministic Resolver",
		]);
		requires(read("changelog_unreleased/added/13.md"), [
			"reviewer panel as search diversification",
			"routing coverage",
		]);
		requires(read("changelog_unreleased/changed/144.md"), ["independent Judge", "no author substitution"]);
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

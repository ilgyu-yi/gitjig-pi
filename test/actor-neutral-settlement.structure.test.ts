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
	".github/workflows/gitjig-lifecycle.mjs",
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
	requires(sectionIn(source, "### 1.4 Cross-review repair", "### 1.5 Delegated work"), [
		"only a fresh NONE returns to ordinary flow under the unchanged resolved merge-mode ceiling",
	]);
	requires(sectionIn(source, "### 1.6 Review integrity", "### 1.7 The reviewer panel"), [
		"empty-change completion `v1 pass`/`v1 reject` pair is one such two-token grammar, not a third semantic result",
	]);
	requires(sectionIn(source, "### 2.2 Lifecycle states", "### 2.3 PR-as-living-doc"), [
		"issues are the SSOT and any project-board mirror is derived, never authoritative",
		"**Proposed** (`status:proposed`, auto-stamped at filing)",
		"exactly `<!-- activation-verdict: pass -->` or `<!-- activation-verdict: reject -->`",
		"The first is the only passing token",
		"confirms a pre-satisfying citation where one is claimed",
		"confirms the reach-derived settlement mode and records the adjudicated reach in the verdict",
		"closes as `completed` only through the flow",
		"**empty-change completion review**",
		"exactly `<!-- empty-change-completion-verdict: v1 pass -->` or `<!-- empty-change-completion-verdict: v1 reject -->`",
		"Reject leaves the Issue open",
		"never a PR substitute",
		"platform-attested as OWNER, MEMBER, or COLLABORATOR with freshly measured MAINTAIN or ADMIN permission",
		"session independence remains a procedural obligation, never a trusted boolean",
		"activationCriteriaFromComments",
		"carried derivation is absent and the route refuses `evidence-absent`",
		"closeoutCriteria",
		"<!-- empty-change-completion-terminal: v1 -->",
		"<!-- empty-change-upward-reflection: v1 -->",
		"`{schemaVersion,repositoryId,issueId,issueNumber,issueType,observedState,parentDirectiveId,activationVerdictCommentId,activationCriteriaCommentId,activatedBodyHash,currentBodyHash,bodyUpdatedAt,emptyChangeBasis,governedRepositoryObservation,criteria,reviewerId,reviewerAssociation,reviewerPermission,reviewProvenanceCommentId,observedAt}`",
		"`{schemaVersion,repositoryId,issueId,issueNumber,verdictCommentId,bodyHash,closedAt,state,stateReason,writerId}`",
		"`{schemaVersion,repositoryId,childIssueId,parentDirectiveId,verdictCommentId,terminalCommentId,writerId,observedAt}`",
		"resolve_parent_directive.sh",
		"exactly one type label from `task`, `bug`, or `execution`",
		"The order is pass record → exact re-read → close as COMPLETED",
		"drift requires a new review, never record repair",
		"its emptiness is never by itself a no-parent derivation",
		"non-empty, duplicate-free ordered exact equality",
		"`subject-ineligible`",
		"`evidence-absent`",
		"`evidence-ambiguous`",
		"`evidence-edited`",
		"`evidence-copied`",
		"`evidence-stale-subject`",
		"`evidence-stale-criteria`",
		"`writer-unattested`",
		"`reviewer-untrusted`",
		"`surface-nonempty`",
		"`criterion-unresolved`",
		"`close-before-record`",
		"`terminal-mismatch`",
		"`reflection-mismatch`",
		"`not planned` is the disposition otherwise",
		"**Upward closure.** The hierarchy closes upward",
		"completeness floor that fires regardless of who performed the terminal act",
		"idempotency key the writer controls",
	]);
	requires(sectionIn(source, "### 2.6 SSOT change-reach protocol", "### 2.7 Canonical naming"), [
		"The `change-reach` class is deliberately doorless",
		"correct or widen the cumulative trailers or the surviving artifact",
	]);
	requires(sectionIn(source, "### 3.2 The three tiers", "### 3.3 Gate classes"), [
		"one native `repository-governance` ruleset",
		"broad administrator bypass",
		"does not require `ac-closeout`",
	]);
	requires(sectionIn(source, "### 3.3 Gate classes", "### 3.4 Human-value precedence and agent-agnostic tiers"), [
		"A misplaced row is a reversible document defect",
		"separately recorded §3.11 backstop obligation",
		"activation, Directive completion, empty-change completion, or ready transition firing without its required evidence artifact",
	]);
	requires(sectionIn(source, "### 3.4 Human-value precedence and agent-agnostic tiers", "### 3.5 Gate conduct"), [
		"No enforced norm depends on a specific agent or model",
		"Human-value filter",
		"§4.8 records the optional Tier-1 operator surface",
	]);
	requires(
		sectionIn(
			source,
			"### 3.7 Approval-gate completeness",
			"### 3.8 Landing authority, administration, and configurable governance",
		),
		[
			"empty-change completion",
			"Empty-change author-equality additionally owes §2.2's fresh isolated compare-confirmed provenance",
			"The `approval-evidence` class is deliberately doorless for all four reversible acts",
			"produce fresh canonical evidence",
		],
	);
	requires(
		sectionIn(source, "### 3.8 Landing authority, administration, and configurable governance", "### 3.9 Fail policy"),
		[
			"`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` family",
			"Each channel was measured on a fresh armed clone",
			"outside **§5.9's disarm bar**",
			"work tree selected on the command line or through `core.worktree` keeps the separate §3.2 disposition",
		],
	);
}

const gates = section("### 3.3 Gate classes", "### 3.4 Human-value precedence and agent-agnostic tiers");
const escapeSection = section(
	"### 3.8 Landing authority, administration, and configurable governance",
	"### 3.9 Fail policy",
);

function assertUnchangedSettlementContracts(source: string): void {
	requires(sectionIn(source, "### 2.2 Lifecycle states", "### 2.3 PR-as-living-doc"), [
		"`awaiting-author` is an Issue/PR handoff",
		"Resolver `repair`",
		"eligible-human PR `CHANGES_REQUESTED`",
		"Human review never contributes to §1.4's Resolver-repair count",
		"PR synchronization to any new head clears",
		"only an Issue body edit by that Issue's author clears",
		"`{condition,recovery,observedAt,subjectHead,baseHead}`",
		"Clearing a blocker never activates proposed work",
		"explicit **completion review**",
		"binds the current Directive body",
		"Completion review is per-success-signal evidence sufficiency",
	]);
	requires(sectionIn(source, "### 3.3 Gate classes", "### 3.4 Human-value precedence and agent-agnostic tiers"), [
		"`protected-branch` ref-identity semantics",
		"one derived identity P",
		"Stage 1 reads the local pointer",
		"Stage 2, only where stage 1 fails",
		"Byte-equal to P",
		"ASCII-case-fold-equal to P but byte-unequal",
		"identity established as **not P**",
		"P underivable",
	]);
	requires(sectionIn(source, "### 3.6 Enforcement-face selection", "### 3.7 Approval-gate completeness"), [
		"Worked application — the egress boundary",
		"reuses the commit-time secret gate's pattern source",
		"neutralizes relayed mentions and actionable references",
	]);
	requires(sectionIn(source, "### 3.7 Approval-gate completeness", "### 3.8 Landing authority"), [
		"(a) **Attribution, subject binding, and freshness**",
		"(b) **No silent skip**",
		"(c) **Fail-closed lookup**",
		"(d) **Evidence provenance**",
		"Nit carry-forward",
		"(e) **Predicate integrity**",
		"produce fresh canonical evidence",
	]);
}

describe("#301 maintainer-terminal settlement with retained #273 locks", () => {
	it("retains unchanged lifecycle, ref-identity, egress, and approval contracts with killed mutants", () => {
		assertUnchangedSettlementContracts(spec);
		for (const token of [
			"`awaiting-author` is an Issue/PR handoff",
			"Human review never contributes to §1.4's Resolver-repair count",
			"Clearing a blocker never activates proposed work",
			"Completion review is per-success-signal evidence sufficiency",
			"`protected-branch` ref-identity semantics",
			"Stage 1 reads the local pointer",
			"ASCII-case-fold-equal to P but byte-unequal",
			"P underivable",
			"Worked application — the egress boundary",
			"reuses the commit-time secret gate's pattern source",
			"neutralizes relayed mentions and actionable references",
			"(a) **Attribution, subject binding, and freshness**",
			"(b) **No silent skip**",
			"(c) **Fail-closed lookup**",
			"(d) **Evidence provenance**",
			"(e) **Predicate integrity**",
		]) {
			const mutant = spec.replace(token, "MUTATED-UNCHANGED-CONTRACT");
			assert.notEqual(mutant, spec, `unchanged mutant anchor missing: ${token}`);
			assert.throws(() => assertUnchangedSettlementContracts(mutant), `surviving unchanged mutant: ${token}`);
		}
	});

	it("pins human value before placement and calibration", () => {
		requires(read("MISSION.md"), ["**Human operability**", "Tier 2 and Tier 3 are independently useful"]);
		requires(section("### 3.4 Human-value precedence and agent-agnostic tiers", "### 3.5 Gate conduct"), [
			"Human-value filter",
			"Deciding-information placement",
			"Cost calibration",
			"§4.8",
		]);
	});

	it("pins label-only and operator-directed landing without retiring general escape doctrine", () => {
		requires(escapeSection, [
			"Escape architecture",
			"Total-coverage rule",
			"Refusal-record rule",
			"writer-supplied advisory",
			"waives **exactly one predicate",
			"no TTL, escape record, claim, consumption",
			"gitjig-operator-directed-merge: v1",
			"audit-publication-ambiguous",
			"one attempt",
		]);
		for (const retired of [
			"A valid escape record is",
			"A policy producer is either",
			"atomically claims one valid record",
		])
			assert.ok(!escapeSection.includes(retired), `retired landing authority survives: ${retired}`);
	});

	it("pins one configurable repository profile and history shape", () => {
		requires(gates, ["| repository-governance |", "| history-shape |"]);
		requires(escapeSection, [
			".github/workflows/history-shape.mjs",
			"git rev-list --min-parents=2 M..<head-sha>",
			"GitHub `required_linear_history` is false",
			"native-required `ac-closeout`: false",
			".github/gitjig-governance.json",
			".github/workflows/gitjig-governance.mjs",
			".github/bin/gitjig-governance.mjs",
			"--confirm-plan-hash <hash>",
		]);
	});

	it("pins bounded supersession and no live mutation", () => {
		requires(escapeSection, [
			"superseded-dormant migration inputs only",
			"No live ruleset or repository-setting mutation",
			"| 1R | new reconciliation Execution under #261 |",
			"hard prerequisite of Phase 7",
		]);
		requires(read("docs/adr/0001-maintainer-terminal-governance.md"), [
			"Supersedes",
			"Rejected alternatives",
			"Residual risks",
		]);
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
				anchor: "only a fresh NONE returns to ordinary flow under the unchanged resolved merge-mode ceiling",
				replacement: "only a fresh NONE returns to ordinary flow under an execution ceiling",
				expected: "only a fresh NONE returns to ordinary flow under the unchanged resolved merge-mode ceiling",
			},
			{
				anchor: "issues are the SSOT and any project-board mirror is derived, never authoritative",
				replacement: "issues and the project-board mirror are co-authoritative",
				expected: "issues are the SSOT and any project-board mirror is derived, never authoritative",
			},
			{
				anchor: "**Proposed** (`status:proposed`, auto-stamped at filing)",
				replacement: "**Proposed** (auto-stamped at filing)",
				expected: "**Proposed** (`status:proposed`, auto-stamped at filing)",
			},
			{
				anchor: "exactly `<!-- activation-verdict: pass -->` or `<!-- activation-verdict: reject -->`",
				replacement: "exactly `ACTIVATE` or `REJECT`",
				expected: "exactly `<!-- activation-verdict: pass -->` or `<!-- activation-verdict: reject -->`",
			},
			{
				anchor: "confirms the reach-derived settlement mode and records the adjudicated reach in the verdict",
				replacement: "confirms the reach-derived settlement mode",
				expected: "confirms the reach-derived settlement mode and records the adjudicated reach in the verdict",
			},
			{
				anchor: "`not planned` is the disposition otherwise",
				replacement: "any other close disposition is accepted",
				expected: "`not planned` is the disposition otherwise",
			},
			{
				anchor:
					"exactly `<!-- empty-change-completion-verdict: v1 pass -->` or `<!-- empty-change-completion-verdict: v1 reject -->`",
				replacement:
					"exactly `<!-- empty-change-completion-verdict: v1 pass -->` or `<!-- empty-change-completion-verdict: reject -->`",
				expected:
					"exactly `<!-- empty-change-completion-verdict: v1 pass -->` or `<!-- empty-change-completion-verdict: v1 reject -->`",
			},
			{
				anchor: "The order is pass record → exact re-read → close as COMPLETED",
				replacement: "The order is close as COMPLETED → pass record",
				expected: "The order is pass record → exact re-read → close as COMPLETED",
			},
			{
				anchor: "its emptiness is never by itself a no-parent derivation",
				replacement: "an empty result is always a no-parent derivation",
				expected: "its emptiness is never by itself a no-parent derivation",
			},
			{
				anchor:
					"platform-attested as OWNER, MEMBER, or COLLABORATOR with freshly measured MAINTAIN or ADMIN permission",
				replacement: "identified by any commenting account",
				expected:
					"platform-attested as OWNER, MEMBER, or COLLABORATOR with freshly measured MAINTAIN or ADMIN permission",
			},
			{
				anchor: "non-empty, duplicate-free ordered exact equality",
				replacement: "ordered equality",
				expected: "non-empty, duplicate-free ordered exact equality",
			},
			{
				anchor: ", and `reflection-mismatch`:",
				replacement: ":",
				expected: "`reflection-mismatch`",
			},
			{
				anchor:
					"empty-change completion `v1 pass`/`v1 reject` pair is one such two-token grammar, not a third semantic result",
				replacement: "empty-change completion is a third completion result token",
				expected:
					"empty-change completion `v1 pass`/`v1 reject` pair is one such two-token grammar, not a third semantic result",
			},
			{
				anchor:
					"activation, Directive completion, empty-change completion, or ready transition firing without its required evidence artifact",
				replacement:
					"activation, Directive completion, or ready transition firing without its required evidence artifact",
				expected:
					"activation, Directive completion, empty-change completion, or ready transition firing without its required evidence artifact",
			},
			{
				anchor: "`<!-- empty-change-completion-terminal: v1 -->`",
				replacement: "`<!-- empty-change-completion-terminal -->`",
				expected: "<!-- empty-change-completion-terminal: v1 -->",
			},
			{
				anchor: "`surface-nonempty`",
				replacement: "`surface-empty`",
				expected: "`surface-nonempty`",
			},
			{
				anchor: "**Upward closure.** The hierarchy closes upward",
				replacement: "**Closure.** The hierarchy may be synchronized upward",
				expected: "**Upward closure.** The hierarchy closes upward",
			},
			{
				anchor: "The `change-reach` class is deliberately doorless",
				replacement: "The `change-reach` class is procedural",
				expected: "The `change-reach` class is deliberately doorless",
			},
			{
				anchor: "one native `repository-governance` ruleset",
				replacement: "two native governance rulesets",
				expected: "one native `repository-governance` ruleset",
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
				anchor: "§4.8 records the optional Tier-1 operator surface",
				replacement: "the operator surface is unspecified",
				expected: "§4.8 records the optional Tier-1 operator surface",
			},
			{
				anchor: "Empty-change author-equality additionally owes §2.2's fresh isolated compare-confirmed provenance",
				replacement: "Empty-change author-equality needs no independent provenance",
				expected: "Empty-change author-equality additionally owes §2.2's fresh isolated compare-confirmed provenance",
			},
			{
				anchor: "The `approval-evidence` class is deliberately doorless for all four reversible acts",
				replacement: "The `approval-evidence` class is deliberately doorless for all three reversible acts",
				expected: "The `approval-evidence` class is deliberately doorless for all four reversible acts",
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
			assert.ok(body.includes("landing"), `${path} lacks landing wording`);
			assert.ok(body.includes("human"), `${path} omits human operation`);
			for (const retired of ["review-gated merge", "attended", "unattended", "merge-review"]) {
				assert.ok(!body.includes(retired), `${path} retains ${retired}`);
			}
		}
	});
});

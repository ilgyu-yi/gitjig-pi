import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mission = readFileSync("MISSION.md", "utf8");
const spec = readFileSync("SPEC.md", "utf8");
const readme = readFileSync("README.md", "utf8");
const adr = readFileSync("docs/adr/0001-maintainer-terminal-governance.md", "utf8");

function hasAll(text: string, values: string[]): void {
	for (const value of values) assert.ok(text.includes(value), `missing contract member: ${value}`);
}

function section(text: string, start: string, end: string): string {
	const a = text.indexOf(start);
	const b = text.indexOf(end, a + start.length);
	assert.ok(a >= 0 && b > a, `missing section ${start} -> ${end}`);
	return text.slice(a, b);
}

test("MISSION makes human operability and independent lower tiers a success condition", () => {
	hasAll(mission, [
		"**Human operability**",
		"humans can develop, review, merge, administer, install, and audit without Pi",
		"Tier 2 and Tier 3 are independently useful and desirable human disciplines",
		"single-maintainer development",
		"malicious repository administrator",
	]);
});

test("human-value placement precedes gate cost calibration", () => {
	const placement = section(spec, "### 3.4 Human-value precedence", "### 3.5 Gate conduct");
	hasAll(placement, ["Human-value filter", "Deciding-information placement", "Cost calibration"]);
	assert.ok(spec.indexOf("Human-value filter") < spec.indexOf("### 3.6 Enforcement-face selection"));
});

test("landing contract is maintainer-terminal and label-only by default", () => {
	const landing = section(spec, "### 3.8 Landing authority", "### 3.9 Fail policy");
	hasAll(landing, [
		"writer-supplied advisory",
		"waives **exactly one predicate: the currently configured native approving-review quorum**",
		"no TTL, escape record, claim, consumption",
		"head SHA changes",
		"live base SHA changes",
		"gitjig-operator-directed-merge: v1",
		"audit-publication-ambiguous",
		"merge-outcome-unknown",
		"one attempt",
	]);
	for (const retired of [
		"A valid escape record is",
		"A policy producer is either",
		"The guarded landing consumer atomically claims",
	])
		assert.ok(!landing.includes(retired), `retired authority survived: ${retired}`);
});

test("Tier 3 and history shape are one configurable human profile", () => {
	hasAll(spec, [
		"| repository-governance |",
		"| history-shape |",
		".github/workflows/history-shape.mjs",
		"git rev-list --min-parents=2 M..<head-sha>",
		"GitHub `required_linear_history` is false",
		"native-required `ac-closeout`: false",
	]);
});

test("all installer surfaces share target-owned config and explicit apply", () => {
	hasAll(spec, [
		".github/gitjig-governance.json",
		"**target-owned-instance**",
		".github/workflows/gitjig-governance.mjs",
		".github/bin/gitjig-governance.mjs",
		".pi/extensions/gitjig/commands/governance.ts",
		"Changing it never mutates server state",
		"--confirm-plan-hash <hash>",
		"complete-read → validate config → exact plan/hash → confirmation",
	]);
});

test("settlement forbids mutation and records supersession and ordered migration", () => {
	hasAll(spec, [
		"No live ruleset or repository-setting mutation is authorized by this settlement",
		"superseded-dormant migration inputs only",
		"| 1R | new reconciliation Execution under #261 |",
		"Phases 2–7 cannot derive or start until Phase 1R passes",
	]);
	hasAll(adr, ["Supersedes", "#261 and #293", "must not be authorized or executed"]);
	hasAll(readme, [
		"Direct human administration",
		"default labeled Tier-1 path waives only missing native approval",
		"config changes never mutate server state",
	]);
});

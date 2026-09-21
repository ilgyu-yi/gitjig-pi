import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const root = repoRoot();
const pi = readFileSync(join(root, ".pi/extensions/gitjig/commands/governance.ts"), "utf8");
const cli = readFileSync(join(root, ".github/bin/gitjig-governance.mjs"), "utf8");
const platform = readFileSync(join(root, ".github/workflows/gitjig-governance-platform.mjs"), "utf8");
const service = readFileSync(join(root, ".github/workflows/gitjig-governance-service.mjs"), "utf8");

describe("Phase-5 governance surface ownership", () => {
	it("Pi imports the shared service and carries no policy/planner/write implementation", () => {
		assert.match(pi, /gitjig-governance-service\.mjs/);
		assert.match(pi, /createGovernanceService/);
		assert.doesNotMatch(pi, /requiredApprovingReviews|rulesetEnforcement|writeOperation|PATCH|PUT/);
	});

	it("the standalone CLI exposes exactly the four settled subcommands", () => {
		assert.equal(cli.match(/\["configure", "plan", "apply", "audit"\]/g)?.length, 1);
		for (const command of ["configure", "plan", "audit"]) assert.match(cli, new RegExp(`command === "${command}"`));
		assert.doesNotMatch(cli, /command === "(?:install|bootstrap|source-split)"/);
	});

	it("binds full-state migration without a rival surface predicate", () => {
		assert.match(platform, /beforeHead/);
		assert.match(platform, /afterHead/);
		assert.match(platform, /canonicalJson\(current\) !== canonicalJson\(expected\)/);
		assert.match(platform, /compare-read-unavailable/);
		assert.match(platform, /payload-refused/);
		assert.match(service, /transitionMeasuredGovernance/);
		assert.match(service, /!equal\(current\.measured, expected\)/);
		assert.match(service, /!equal\(finalMeasured, expected\)/);
	});

	it("no workflow or startup path invokes apply automatically", () => {
		for (const name of readdirSync(join(root, ".github/workflows"))) {
			if (!/\.ya?ml$/.test(name)) continue;
			const source = readFileSync(join(root, ".github/workflows", name), "utf8");
			assert.doesNotMatch(source, /gitjig-governance[^\n]*(?:apply|configure)/, name);
		}
		const entry = readFileSync(join(root, ".pi/extensions/gitjig.ts"), "utf8");
		assert.doesNotMatch(entry, /runGovernanceCli|\.apply\(/);
	});
});

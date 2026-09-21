import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(new URL("../.github/workflows/gitjig-governance.mjs", import.meta.url), "utf8");

describe("Phase-4 pure engine boundary", () => {
	it("has no platform, filesystem, process, prompt, clock, random or mutation seam", () => {
		assert.doesNotMatch(source, /node:(?:fs|child_process|http|https|readline)/);
		assert.doesNotMatch(source, /\b(?:fetch|process|Date|Math\.random|prompt)\b/);
		assert.doesNotMatch(source, /\b(?:PATCH|POST|PUT|DELETE)\b/);
		assert.match(source, /node:crypto/);
	});

	it("owns every parser, planner and auditor operation in one handed-over module", () => {
		for (const name of [
			"parseGovernanceConfig",
			"validateGovernanceConfig",
			"parseMeasuredGovernance",
			"planGovernance",
			"auditGovernance",
			"transitionMeasuredGovernance",
			"ruleTypesForCapabilities",
		])
			assert.match(source, new RegExp(`export function ${name}\\b`));
		assert.match(source, /authorized: false/);
	});

	it("kills representative classification, ordering and hash-basis mutants", () => {
		for (const forbidden of [
			'if (selection.mode === "unmanaged") continue;',
			'const after = selection.mode === "disabled" ? disabledValue(name) : selection.value;',
			'configDigest: createHash("sha256").update(canonicalJson(parsedConfig)).digest("hex")',
			"measured: parsedMeasured",
			"operations,",
			"defaultBranchSha",
			'kind: "ruleset-identity"',
			"ruleTypesForCapabilities(measured.capabilities)",
			"transitionMeasuredGovernance",
			"identity.compliant &&",
		])
			assert.match(source, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	});
});

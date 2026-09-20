import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	auditGovernance,
	CAPABILITIES,
	GovernanceRefusal,
	parseGovernanceConfig,
	parseMeasuredGovernance,
	planGovernance,
	validateGovernanceConfig,
} from "../.github/workflows/gitjig-governance.mjs";

const config = parseGovernanceConfig(
	readFileSync(new URL("../.github/gitjig-governance.json", import.meta.url), "utf8"),
);
const repository = structuredClone(config.repository);

function desiredValue(name: string): unknown {
	const selection = config.capabilities[name];
	if (selection.mode === "selected") return structuredClone(selection.value);
	if (name === "rulesetEnforcement") return "disabled";
	if (name === "administratorBypass") return [];
	if (name === "requiredApprovingReviews") return 0;
	if (["allowedMergeMethods", "requiredReviewers", "requiredStatusChecks"].includes(name)) return [];
	return false;
}
function measured() {
	const capabilities = Object.fromEntries(CAPABILITIES.map((name) => [name, desiredValue(name)]));
	capabilities.extraApprovalForUnattributedChanges = true;
	return {
		schemaVersion: 1,
		repository: structuredClone(repository),
		rulesets: [
			{
				id: 1,
				name: config.ruleset.name,
				target: "branch",
				sourceType: "Repository",
				source: repository.nameWithOwner,
				include: ["~DEFAULT_BRANCH"],
				exclude: [],
				ruleTypes: ["pull_request", "required_status_checks", "deletion", "non_fast_forward"],
			},
		],
		capabilities,
	};
}
function custom(...unmanaged: string[]) {
	const value = structuredClone(config);
	for (const name of unmanaged) value.capabilities[name] = { mode: "unmanaged" };
	return value;
}
function reordered(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reordered);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.reverse()
				.map(([key, entry]) => [key, reordered(entry)]),
		);
	return value;
}

describe("Phase-4 target governance config", () => {
	it("encodes the exact selectable default and every capability once", () => {
		assert.deepEqual(Object.keys(config.capabilities), [...CAPABILITIES]);
		assert.equal(config.capabilities.requiredApprovingReviews.value, 1);
		assert.equal(config.capabilities.extraApprovalForUnattributedChanges.mode, "unmanaged");
		assert.equal(config.capabilities.requiredLinearHistory.mode, "disabled");
		assert.deepEqual(
			config.capabilities.requiredStatusChecks.value.map((entry: { context: string }) => entry.context),
			["fragment-gate", "history-shape", "source-style", "ssot-home", "suite", "toc-freshness", "type-check"],
		);
		assert.equal(config.capabilities.administratorBypass.value[0].bypassMode, "always");
	});

	it("supports distinct human-owned custom profiles without Pi", () => {
		const minimal = custom("requiredApprovingReviews", "dismissStaleReviews", "reviewThreadResolution");
		const checksOnly = custom("administratorBypass", "deletionProtection", "nonFastForwardProtection");
		assert.doesNotThrow(() => parseGovernanceConfig(minimal));
		assert.doesNotThrow(() => parseGovernanceConfig(checksOnly));
		assert.notDeepEqual(minimal, checksOnly);
	});

	it("refuses unknown, omitted, contradictory and unsupported positive config", () => {
		const unknown = structuredClone(config) as Record<string, unknown>;
		unknown.surprise = true;
		assert.throws(() => parseGovernanceConfig(unknown), /config-schema/);
		const omitted = structuredClone(config);
		delete omitted.capabilities.mergeCommits;
		assert.throws(() => parseGovernanceConfig(omitted), /config-capability-population/);
		const positive = structuredClone(config);
		positive.capabilities.codeOwnerReview = { mode: "selected", value: true };
		assert.throws(() => parseGovernanceConfig(positive), /unsupported-positive-option/);
		const contradictory = structuredClone(config);
		contradictory.capabilities.mergeCommits = { mode: "selected", value: false };
		assert.throws(() => parseGovernanceConfig(contradictory), /contradictory-selection/);
		assert.throws(
			() => parseGovernanceConfig('{"schemaVersion":1,"schemaVersion":1}'),
			(error: unknown) => error instanceof GovernanceRefusal && error.arm === "config-duplicate-key",
		);
	});

	it("binds the exact addressed repository", () => {
		const validated = validateGovernanceConfig(config, repository);
		assert.deepEqual(validated, config);
		assert.equal(Object.isFrozen(validated.capabilities.requiredStatusChecks.value), true);
		assert.throws(
			() => validateGovernanceConfig(config, { ...repository, defaultBranch: "trunk" }),
			/repository-mismatch/,
		);
	});
});

describe("pure governance planner and auditor", () => {
	it("produces an explicit unauthorized empty plan while preserving unmanaged live state", () => {
		const live = measured();
		const plan = planGovernance(config, live);
		assert.deepEqual(plan.operations, []);
		assert.equal(plan.authorized, false);
		assert.match(plan.planHash, /^[0-9a-f]{64}$/);
		const audit = auditGovernance(config, live);
		assert.equal(audit.compliant, true);
		assert.deepEqual(
			audit.capabilities.find((entry) => entry.capability === "extraApprovalForUnattributedChanges"),
			{
				capability: "extraApprovalForUnattributedChanges",
				classification: "unmanaged",
				observed: true,
			},
		);
	});

	it("plans selected and disabled drift only, in canonical capability order", () => {
		const live = measured();
		live.capabilities.requiredApprovingReviews = 0;
		live.capabilities.requiredReviewers = [{ actorId: 17, actorType: "Team" }];
		live.capabilities.requiredLinearHistory = true;
		live.rulesets[0].ruleTypes.push("required_linear_history");
		live.capabilities.extraApprovalForUnattributedChanges = false;
		const plan = planGovernance(config, live);
		assert.deepEqual(
			plan.operations.map((operation) => operation.capability),
			["requiredApprovingReviews", "requiredReviewers", "requiredLinearHistory"],
		);
		assert.equal(auditGovernance(config, live).compliant, false);
	});

	it("is byte-deterministic and binds config, repository and complete live basis", () => {
		const live = measured();
		const first = planGovernance(config, live);
		const reorderedArrays = structuredClone(live);
		reorderedArrays.rulesets[0].ruleTypes.reverse();
		(reorderedArrays.capabilities.requiredStatusChecks as unknown[]).reverse();
		assert.equal(planGovernance(reordered(config), reordered(live)).planHash, first.planHash);
		assert.equal(planGovernance(config, reorderedArrays).planHash, first.planHash);
		assert.equal(planGovernance(config, live).planHash, first.planHash);
		assert.equal(JSON.stringify(planGovernance(config, live)), JSON.stringify(first));
		const drift = measured();
		drift.capabilities.extraApprovalForUnattributedChanges = false;
		assert.notEqual(planGovernance(config, drift).planHash, first.planHash);
		const changed = structuredClone(config);
		changed.capabilities.mergeCommits = { mode: "unmanaged" };
		assert.notEqual(planGovernance(changed, live).planHash, first.planHash);
	});

	it("refuses incomplete, duplicate, inherited, unknown and integration-mismatched populations", () => {
		const zero = measured();
		zero.rulesets = [];
		assert.throws(() => parseMeasuredGovernance(zero), /measured-ruleset-population/);
		const multiple = measured();
		multiple.rulesets.push(structuredClone(multiple.rulesets[0]));
		assert.throws(() => parseMeasuredGovernance(multiple), /measured-ruleset-population/);
		const inherited = measured();
		inherited.rulesets[0].sourceType = "Organization";
		assert.throws(() => parseMeasuredGovernance(inherited), /measured-ruleset/);
		const duplicate = measured();
		duplicate.rulesets[0].ruleTypes.push("deletion");
		assert.throws(() => parseMeasuredGovernance(duplicate), /measured-ruleset/);
		const unknown = measured();
		unknown.rulesets[0].ruleTypes.push("mystery");
		assert.throws(() => parseMeasuredGovernance(unknown), /measured-ruleset/);
		const integration = measured();
		(integration.capabilities.requiredStatusChecks as Array<{ integrationId: number }>)[0].integrationId = 99;
		assert.equal(auditGovernance(config, integration).compliant, false);
		const inconsistent = measured();
		inconsistent.rulesets[0].ruleTypes = inconsistent.rulesets[0].ruleTypes.filter((type) => type !== "deletion");
		assert.throws(() => parseMeasuredGovernance(inconsistent), /measured-rule-parameter-mismatch/);
	});

	it("refuses ruleset and repository basis drift instead of retargeting", () => {
		const wrongName = measured();
		wrongName.rulesets[0].name = "other";
		assert.throws(() => planGovernance(config, wrongName), /measured-ruleset-mismatch/);
		const wrongRepository = measured();
		wrongRepository.repository.id = "foreign";
		assert.throws(() => auditGovernance(config, wrongRepository), /measured-repository-mismatch/);
	});
});

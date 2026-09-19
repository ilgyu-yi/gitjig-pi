import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";

const repository = join(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "landing-topology-mutants-"));
after(() => rmSync(root, { recursive: true, force: true }));

function kill(name: string, path: string, from: string, to: string): void {
	const box = mkdtempSync(join(root, `${name}-`));
	cpSync(repository, box, {
		recursive: true,
		filter: (source) => !new Set([".git", "node_modules", ".gitjig"]).has(basename(source)),
	});
	symlinkSync(join(repository, "node_modules"), join(box, "node_modules"), "dir");
	const target = join(box, path);
	const source = readFileSync(target, "utf8");
	assert.equal(source.split(from).length, 2, `${name}: mutation target must be unique`);
	writeFileSync(target, source.replace(from, to));
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const result = spawnSync(
		process.execPath,
		["--test", "test/landing-topology.unit.test.ts", "test/topology-authorization.unit.test.ts"],
		{
			cwd: box,
			encoding: "utf8",
			timeout: 20_000,
			env,
		},
	);
	assert.notEqual(result.status, 0, `${name}: mutant survived\n${result.stdout}\n${result.stderr}`);
}

describe("#284 isolated topology guard mutants", () => {
	it("kills topology schema, core, quorum and integration mutants", () => {
		kill("sub-millisecond", ".github/workflows/landing-topology.mjs", "\\.\\d{1,3}", "\\.\\d{1,4}");
		kill(
			"canonical-field-order",
			".github/workflows/landing-topology.mjs",
			"schemaVersion: record.schemaVersion,",
			"...record,",
		);
		kill(
			"core-bypass",
			".github/workflows/landing-topology.mjs",
			"detail.bypass_actors.length !== 0",
			"detail.bypass_actors.length < 0",
		);
		kill(
			"context-integration",
			".github/workflows/landing-topology.mjs",
			"entry.integration_id === actionsIntegrationId",
			"entry.integration_id !== actionsIntegrationId",
		);
		kill(
			"human-role",
			".github/workflows/landing-topology.mjs",
			"detail.bypass_actors[0].actor_id !== 5",
			"detail.bypass_actors[0].actor_id === 5",
		);
		kill(
			"core-target",
			".github/workflows/landing-topology.mjs",
			'detail.name !== "core-governance" ||\n\t\tdetail.target !== "branch"',
			'detail.name !== "core-governance" ||\n\t\tdetail.target === "branch"',
		);
		kill(
			"core-approving-count",
			".github/workflows/landing-topology.mjs",
			"parameters.required_approving_review_count !== 0",
			"parameters.required_approving_review_count === 0",
		);
		kill(
			"core-thread-resolution",
			".github/workflows/landing-topology.mjs",
			"parameters.required_review_thread_resolution !== true",
			"parameters.required_review_thread_resolution === true",
		);
	});

	it("kills planner authority and bootstrap own-behalf/replay mutants", () => {
		kill(
			"artifact-whole-hash",
			".pi/extensions/gitjig/landing/topology-plan.ts",
			"return digest(plan);",
			"return digest({ schemaVersion: plan.schemaVersion });",
		);
		kill(
			"operator-admin",
			".pi/extensions/gitjig/landing/topology-plan.ts",
			'snapshot.actorRole.toLowerCase() !== "admin"',
			'snapshot.actorRole.toLowerCase() === "admin"',
		);
		kill(
			"own-behalf",
			".pi/extensions/gitjig/landing/bootstrap.ts",
			"input.engine.ownBehalfRefusal({",
			"!input.engine.ownBehalfRefusal({",
		);
		kill(
			"carrier-absence",
			".pi/extensions/gitjig/landing/bootstrap.ts",
			'input.defaultBranchTopology !== "absent"',
			'input.defaultBranchTopology === "absent"',
		);
		kill(
			"merge-setting",
			".pi/extensions/gitjig/landing/bootstrap.ts",
			"input.repositorySettings.allow_merge_commit !== true",
			"input.repositorySettings.allow_merge_commit === true",
		);
		kill(
			"squash-setting",
			".pi/extensions/gitjig/landing/bootstrap.ts",
			"input.repositorySettings.allow_squash_merge !== false",
			"input.repositorySettings.allow_squash_merge === false",
		);
		kill(
			"rebase-setting",
			".pi/extensions/gitjig/landing/bootstrap.ts",
			"input.repositorySettings.allow_rebase_merge !== false",
			"input.repositorySettings.allow_rebase_merge === false",
		);
		kill(
			"authorization-stage",
			".pi/extensions/gitjig/landing/bootstrap.ts",
			'authorization.stage !== "carrier-bootstrap"',
			'authorization.stage === "carrier-bootstrap"',
		);
		kill(
			"plan-hash-binding",
			".pi/extensions/gitjig/landing/bootstrap.ts",
			"authorization.planHash !== artifactHash",
			"authorization.planHash === artifactHash",
		);
		kill(
			"authorization-expiry",
			".pi/extensions/gitjig/landing/bootstrap.ts",
			"Date.parse(expiresAt) <= Date.parse(now)",
			"Date.parse(expiresAt) < Date.parse(now)",
		);
		kill(
			"authorization-edited",
			".pi/extensions/gitjig/landing/topology-authorization.ts",
			"comment.created_at !== comment.updated_at",
			"comment.created_at === comment.updated_at",
		);
		kill(
			"authorization-actor",
			".pi/extensions/gitjig/landing/topology-authorization.ts",
			"author.node_id !== viewer.node_id",
			"author.node_id === viewer.node_id",
		);
		kill(
			"authorization-permission",
			".pi/extensions/gitjig/landing/topology-authorization.ts",
			'permission?.role_name !== "admin"',
			'permission?.role_name === "admin"',
		);
		kill(
			"pair-replay",
			".pi/extensions/gitjig/landing/bootstrap.ts",
			"input.consumedPairKeys.includes(pairKey)",
			"!input.consumedPairKeys.includes(pairKey)",
		);
	});
});

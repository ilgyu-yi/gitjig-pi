import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { configureGovernance, readGovernancePlan } from "../.github/bin/gitjig-governance.mjs";
import {
	CAPABILITIES,
	GovernanceRefusal,
	parseGovernanceConfig,
	planGovernance,
} from "../.github/workflows/gitjig-governance.mjs";
import { createGovernancePlatform } from "../.github/workflows/gitjig-governance-platform.mjs";
import {
	admitConfirmation,
	confirmationPresentation,
	createGovernanceService,
} from "../.github/workflows/gitjig-governance-service.mjs";
import { governanceRefusalArm } from "../.pi/extensions/gitjig/commands/governance.ts";

const bytes = readFileSync(new URL("../.github/gitjig-governance.json", import.meta.url));
const config = parseGovernanceConfig(bytes);
function desired(name: string): unknown {
	const entry = config.capabilities[name];
	if (entry.mode === "selected") return structuredClone(entry.value);
	if (name === "rulesetEnforcement") return "disabled";
	if (["administratorBypass", "allowedMergeMethods", "requiredReviewers", "requiredStatusChecks"].includes(name))
		return [];
	if (name === "requiredApprovingReviews") return 0;
	return false;
}
function measured() {
	return {
		schemaVersion: 1,
		repository: structuredClone(config.repository),
		rulesets: [
			{
				id: 7,
				name: config.ruleset.name,
				target: "branch",
				sourceType: "Repository",
				source: config.repository.nameWithOwner,
				include: ["~DEFAULT_BRANCH"],
				exclude: [],
				ruleTypes: ["pull_request", "required_status_checks", "deletion", "non_fast_forward"],
			},
		],
		capabilities: Object.fromEntries(CAPABILITIES.map((name) => [name, desired(name)])),
	};
}

describe("shared governance apply service", () => {
	it("preserves closed engine, service, and platform refusal arms on the Pi surface", () => {
		assert.equal(governanceRefusalArm(new GovernanceRefusal("config-schema")), "config-schema");
		assert.equal(governanceRefusalArm(new Error("governance service refused: plan-stale")), "plan-stale");
		assert.equal(governanceRefusalArm(new Error("untrusted detail")), "unknown");
	});

	it("separately admits exact interactive, non-interactive, and Pi confirmation language", () => {
		const plan = planGovernance(config, measured());
		const presentation = confirmationPresentation(config.repository.nameWithOwner, plan);
		for (const kind of ["interactive", "pi"] as const) {
			assert.equal(
				admitConfirmation(kind, presentation.confirmation, config.repository.nameWithOwner, plan, kind).kind,
				kind,
			);
			assert.throws(() => admitConfirmation(kind, "yes", config.repository.nameWithOwner, plan, kind));
		}
		assert.equal(
			admitConfirmation("non-interactive", plan.planHash, config.repository.nameWithOwner, plan, "headless").kind,
			"non-interactive",
		);
		assert.throws(() =>
			admitConfirmation(
				"non-interactive",
				presentation.confirmation,
				config.repository.nameWithOwner,
				plan,
				"headless",
			),
		);
	});

	it("binds confirmation and performs compare/write/post-read/final audit", async () => {
		const live = measured();
		live.capabilities.requiredApprovingReviews = 0;
		let writes = 0;
		const plan = planGovernance(config, live);
		const service = createGovernanceService();
		const result = await service.apply(
			{
				config,
				plan,
				confirmation: {
					kind: "non-interactive",
					repository: config.repository.nameWithOwner,
					planHash: plan.planHash,
					invocationId: "one",
				},
			},
			{
				readMeasured: async () => structuredClone(live),
				writeOperation: async (operation: unknown) => {
					writes++;
					const admitted = operation as { capability: string; after: unknown };
					live.capabilities[admitted.capability] = structuredClone(admitted.after);
					return "acknowledged";
				},
			},
		);
		assert.equal(result.outcome, "applied");
		assert.equal(writes, 1);
		await assert.rejects(
			service.apply(
				{
					config,
					plan,
					confirmation: {
						kind: "non-interactive",
						repository: config.repository.nameWithOwner,
						planHash: plan.planHash,
						invocationId: "one",
					},
				},
				{ readMeasured: async () => live, writeOperation: async () => "acknowledged" },
			),
			/confirmation-replayed/,
		);
	});

	it("keeps plan and audit GET-only", async () => {
		let writes = 0;
		const effects = {
			readMeasured: async () => measured(),
			writeOperation: async () => {
				writes++;
				return "acknowledged" as const;
			},
		};
		const service = createGovernanceService();
		await service.plan(config, effects);
		await service.audit(config, effects);
		assert.equal(writes, 0);
	});

	it("refuses a stale supplied basis before a write", async () => {
		const old = measured();
		old.capabilities.requiredApprovingReviews = 0;
		const plan = planGovernance(config, old);
		let writes = 0;
		await assert.rejects(
			createGovernanceService().apply(
				{
					config,
					plan,
					confirmation: {
						kind: "interactive",
						repository: config.repository.nameWithOwner,
						planHash: plan.planHash,
						invocationId: "stale",
					},
				},
				{
					readMeasured: async () => measured(),
					writeOperation: async () => {
						writes++;
						return "acknowledged";
					},
				},
			),
			/plan-stale/,
		);
		assert.equal(writes, 0);
	});

	it("stops an unknown write once with exact remaining evidence and no rollback", async () => {
		const live = measured();
		live.capabilities.requiredApprovingReviews = 0;
		const plan = planGovernance(config, live);
		let writes = 0;
		const result = await createGovernanceService().apply(
			{
				config,
				plan,
				confirmation: {
					kind: "pi",
					repository: config.repository.nameWithOwner,
					planHash: plan.planHash,
					invocationId: "attempt",
				},
			},
			{
				readMeasured: async () => live,
				writeOperation: async () => {
					writes++;
					return "unknown";
				},
			},
		);
		assert.deepEqual(
			{ outcome: result.outcome, arm: result.arm, writes },
			{ outcome: "stopped", arm: "write-unknown", writes: 1 },
		);
		assert.deepEqual(result.completed, []);
		assert.deepEqual(result.remaining, plan.operations);
	});

	it("gates success on a distinct final reread and shared audit", async () => {
		const live = measured();
		live.capabilities.requiredApprovingReviews = 0;
		const plan = planGovernance(config, live);
		let reads = 0;
		const result = await createGovernanceService().apply(
			{
				config,
				plan,
				confirmation: {
					kind: "interactive",
					repository: config.repository.nameWithOwner,
					planHash: plan.planHash,
					invocationId: "final-audit",
				},
			},
			{
				readMeasured: async () => {
					reads++;
					const snapshot = structuredClone(live);
					if (reads === 4) snapshot.capabilities.requiredApprovingReviews = 0;
					return snapshot;
				},
				writeOperation: async (operation: unknown) => {
					const admitted = operation as { capability: string; after: unknown };
					live.capabilities[admitted.capability] = structuredClone(admitted.after);
					return "acknowledged";
				},
			},
		);
		assert.equal(result.arm, "final-audit");
		assert.equal(result.completed.length, 1);
	});
});

describe("local configure and complete platform reads", () => {
	it("non-interactive configure reads no prompt and emits exactly one closed stdout result", () => {
		const root = mkdtempSync(join(tmpdir(), "governance-cli-"));
		mkdirSync(join(root, ".github"));
		const target = join(root, ".github", "gitjig-governance.json");
		const candidate = join(root, "candidate.json");
		writeFileSync(target, bytes);
		writeFileSync(candidate, bytes);
		const hash = createHash("sha256").update(bytes).digest("hex");
		const cli = new URL("../.github/bin/gitjig-governance.mjs", import.meta.url);
		const result = spawnSync(
			process.execPath,
			[
				cli.pathname,
				"configure",
				"--config",
				target,
				"--candidate",
				candidate,
				"--non-interactive",
				"--confirm-config-hash",
				hash,
				"--confirm-prior-config-hash",
				hash,
			],
			{
				encoding: "utf8",
				env: { ...process.env, GOVERNANCE_REPOSITORY_ROOT: root },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim().split("\n").length, 1);
		assert.equal(JSON.parse(result.stdout).ok, true);
	});

	it("refuses a FIFO plan operand without waiting for a writer", () => {
		const root = mkdtempSync(join(tmpdir(), "governance-fifo-"));
		const fifo = join(root, "plan.fifo");
		assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
		const started = Date.now();
		assert.throws(() => readGovernancePlan(fifo), /plan-input/);
		assert.ok(Date.now() - started < 1_000);
	});

	it("atomically replaces only the fixed valid config and preserves prior bytes on refusal", () => {
		const root = mkdtempSync(join(tmpdir(), "governance-configure-"));
		mkdirSync(join(root, ".github"));
		const target = join(root, ".github", "gitjig-governance.json");
		writeFileSync(target, bytes);
		const candidate = join(root, "candidate.json");
		writeFileSync(candidate, bytes);
		const hash = createHash("sha256").update(bytes).digest("hex");
		assert.equal(configureGovernance(root, target, candidate, hash, hash).outcome, "configured");
		const before = readFileSync(target);
		assert.throws(() => configureGovernance(root, target, candidate, "wrong", hash), /config-confirmation/);
		assert.throws(() => configureGovernance(root, target, candidate, hash, "stale-prior"), /config-confirmation/);
		assert.deepEqual(readFileSync(target), before);
		const other = join(root, "other.json");
		writeFileSync(other, bytes);
		assert.throws(() => configureGovernance(root, other, candidate, hash, hash), /config-path/);
		const linked = mkdtempSync(join(tmpdir(), "governance-linked-"));
		mkdirSync(join(linked, "real"));
		symlinkSync(join(linked, "real"), join(linked, ".github"));
		assert.throws(() =>
			configureGovernance(linked, join(linked, ".github", "gitjig-governance.json"), candidate, hash, hash),
		);
	});

	it("preserves unbound check integration identity", async () => {
		const calls: string[] = [];
		const request = async (method: string, path: string) => {
			calls.push(`${method} ${path}`);
			if (path === `repos/${config.repository.nameWithOwner}`)
				return {
					node_id: config.repository.id,
					full_name: config.repository.nameWithOwner,
					default_branch: config.repository.defaultBranch,
					allow_merge_commit: true,
					allow_squash_merge: false,
					allow_rebase_merge: false,
				};
			if (path.endsWith("per_page=100&page=1"))
				return [{ id: 7, name: config.ruleset.name, source_type: "Repository" }];
			if (path.endsWith("/rulesets/7"))
				return {
					id: 7,
					name: config.ruleset.name,
					target: "branch",
					source_type: "Repository",
					source: config.repository.nameWithOwner,
					enforcement: "active",
					bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
					conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
					rules: [
						{
							type: "pull_request",
							parameters: {
								allowed_merge_methods: ["merge"],
								required_approving_review_count: 1,
								dismiss_stale_reviews_on_push: true,
								required_reviewers: [],
								require_code_owner_review: false,
								require_last_push_approval: false,
								required_review_thread_resolution: true,
								require_extra_approval_for_unattributed_changes: true,
							},
						},
						{
							type: "required_status_checks",
							parameters: {
								strict_required_status_checks_policy: true,
								do_not_enforce_on_create: false,
								required_status_checks: [{ context: "suite" }],
							},
						},
						{ type: "deletion" },
						{ type: "non_fast_forward" },
					],
				};
			throw new Error(`unexpected ${path}`);
		};
		const live = await createGovernancePlatform(config, request).readMeasured();
		assert.equal(live.capabilities.requiredStatusChecks[0].integrationId, null);
		assert.equal(calls.filter((call) => call.includes("per_page=100")).length, 1);
	});

	it("reads through the pagination terminal before refusing an unsupported ruleset population", async () => {
		const calls: string[] = [];
		const request = async (_method: string, path: string) => {
			calls.push(path);
			if (path === `repos/${config.repository.nameWithOwner}`)
				return {
					node_id: config.repository.id,
					full_name: config.repository.nameWithOwner,
					default_branch: config.repository.defaultBranch,
					allow_merge_commit: true,
					allow_squash_merge: false,
					allow_rebase_merge: false,
				};
			if (path.endsWith("page=1"))
				return Array.from({ length: 100 }, (_, index) => ({
					id: index + 1,
					name: `other-${index}`,
					source_type: "Repository",
				}));
			if (path.endsWith("page=2")) return [];
			throw new Error("unexpected-request");
		};
		await assert.rejects(createGovernancePlatform(config, request).readMeasured(), /ruleset-population/);
		assert.equal(calls.filter((path) => path.includes("per_page=100")).length, 2);
	});
});

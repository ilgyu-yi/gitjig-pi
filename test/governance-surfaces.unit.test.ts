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
		schemaVersion: 2,
		repository: { ...structuredClone(config.repository), defaultBranchSha: "a".repeat(40) },
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
					return { outcome: "acknowledged" as const };
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
				{ readMeasured: async () => live, writeOperation: async () => ({ outcome: "acknowledged" as const }) },
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
				return { outcome: "acknowledged" as const };
			},
		};
		const service = createGovernanceService();
		await service.plan(config, effects);
		await service.audit(config, effects);
		assert.equal(writes, 0);
	});

	it("refuses saved v1 plans before a write", async () => {
		const plan = planGovernance(config, measured());
		plan.schemaVersion = 1;
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
						invocationId: "old-plan",
					},
				},
				{
					readMeasured: async () => measured(),
					writeOperation: async () => {
						writes++;
						return { outcome: "acknowledged" as const };
					},
				},
			),
			/plan-schema/,
		);
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
						return { outcome: "acknowledged" as const };
					},
				},
			),
			/plan-stale/,
		);
		assert.equal(writes, 0);
	});

	it("stops full-basis unmanaged drift before the next write", async () => {
		const live = measured();
		live.capabilities.requiredApprovingReviews = 0;
		const plan = planGovernance(config, live);
		let reads = 0;
		let writes = 0;
		const result = await createGovernanceService().apply(
			{
				config,
				plan,
				confirmation: {
					kind: "pi",
					repository: config.repository.nameWithOwner,
					planHash: plan.planHash,
					invocationId: "unmanaged-drift",
				},
			},
			{
				readMeasured: async () => {
					reads++;
					const snapshot = structuredClone(live);
					if (reads > 1) snapshot.capabilities.extraApprovalForUnattributedChanges = true;
					return snapshot;
				},
				writeOperation: async () => {
					writes++;
					return { outcome: "acknowledged" as const };
				},
			},
		);
		assert.deepEqual({ arm: result.arm, writes }, { arm: "operand-drift", writes: 0 });
	});

	it("preserves proven executor pre-write refusal evidence", async () => {
		const live = measured();
		live.capabilities.requiredApprovingReviews = 0;
		const plan = planGovernance(config, live);
		const result = await createGovernanceService().apply(
			{
				config,
				plan,
				confirmation: {
					kind: "pi",
					repository: config.repository.nameWithOwner,
					planHash: plan.planHash,
					invocationId: "pre-write-refusal",
				},
			},
			{
				readMeasured: async () => structuredClone(live),
				writeOperation: async () => ({
					outcome: "refused" as const,
					arm: "compare-read-unavailable",
					current: null,
				}),
			},
		);
		assert.deepEqual(
			{ outcome: result.outcome, arm: result.arm, current: result.current },
			{ outcome: "stopped", arm: "compare-read-unavailable", current: null },
		);
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
					return { outcome: "unknown" as const };
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

	it("gates success on exact distinct final-state equality before shared audit", async () => {
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
					return { outcome: "acknowledged" as const };
				},
			},
		);
		assert.equal(result.arm, "final-state-drift");
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

	it("admits current-name drift and preserves unbound check integration identity", async () => {
		const calls: string[] = [];
		const liveName = "ghjig-tier3";
		const request = async (method: string, path: string) => {
			calls.push(`${method} ${path}`);
			if (path.includes("/git/ref/heads/"))
				return {
					ref: `refs/heads/${config.repository.defaultBranch}`,
					object: { type: "commit", sha: "b".repeat(40) },
				};
			if (path === `repos/${config.repository.nameWithOwner}`)
				return {
					node_id: config.repository.id,
					full_name: config.repository.nameWithOwner,
					default_branch: config.repository.defaultBranch,
					allow_merge_commit: true,
					allow_squash_merge: false,
					allow_rebase_merge: false,
				};
			if (path.endsWith("per_page=100&page=1")) return [{ id: 7, name: liveName, source_type: "Repository" }];
			if (path.endsWith("/rulesets/7"))
				return {
					id: 7,
					name: liveName,
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
		assert.equal(live.rulesets[0].name, liveName);
		assert.equal(live.capabilities.requiredStatusChecks[0].integrationId, null);
		assert.equal(calls.filter((call) => call.includes("per_page=100")).length, 1);
	});

	it("writes an explicit identity operation with a complete unmanaged-preserving payload", async () => {
		const liveName = "ghjig-tier3";
		type PutBody = {
			name: string;
			rules: Array<{
				type: string;
				parameters?: Record<string, unknown>;
			}>;
		};
		let put: { path: string; body: PutBody } | undefined;
		const detail = () => ({
			id: 7,
			name: liveName,
			target: "branch",
			source_type: "Repository",
			source: config.repository.nameWithOwner,
			enforcement: "active",
			bypass_actors: [],
			conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
			rules: [
				{
					type: "pull_request",
					parameters: {
						allowed_merge_methods: ["merge"],
						required_approving_review_count: 0,
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
		});
		const request = async (method: string, path: string, body?: unknown) => {
			if (path.includes("/git/ref/heads/"))
				return {
					ref: `refs/heads/${config.repository.defaultBranch}`,
					object: { type: "commit", sha: "c".repeat(40) },
				};
			if (path === `repos/${config.repository.nameWithOwner}`)
				return {
					node_id: config.repository.id,
					full_name: config.repository.nameWithOwner,
					default_branch: config.repository.defaultBranch,
					allow_merge_commit: true,
					allow_squash_merge: false,
					allow_rebase_merge: false,
				};
			if (path.endsWith("per_page=100&page=1")) return [{ id: 7, name: liveName, source_type: "Repository" }];
			if (method === "GET" && path.endsWith("/rulesets/7")) return detail();
			if (method === "PUT" && path.endsWith("/rulesets/7")) {
				put = { path, body: body as PutBody };
				return { id: 7 };
			}
			throw new Error(`unexpected ${method} ${path}`);
		};
		const platform = createGovernancePlatform(config, request);
		const live = await platform.readMeasured();
		const operation = planGovernance(config, live).operations[0];
		assert.equal(operation.kind, "ruleset-identity");
		assert.deepEqual(await platform.writeOperation(operation, live), { outcome: "acknowledged" });
		assert.deepEqual(put?.body, {
			name: config.ruleset.name,
			target: "branch",
			enforcement: "active",
			bypass_actors: [],
			conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
			rules: [
				{
					type: "pull_request",
					parameters: {
						allowed_merge_methods: ["merge"],
						required_approving_review_count: 0,
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
		});

		put = undefined;
		const stale = structuredClone(live);
		stale.repository.defaultBranchSha = "d".repeat(40);
		assert.deepEqual(await platform.writeOperation(operation, stale), {
			outcome: "refused",
			arm: "operand-drift",
			current: live,
		});
		assert.equal(put, undefined);
		const malformedOperation = { ...operation, surprise: true };
		assert.deepEqual(await platform.writeOperation(malformedOperation, live), {
			outcome: "refused",
			arm: "payload-refused",
			current: live,
		});
		assert.equal(put, undefined);
	});

	it("maps an executor GET failure to proven pre-write refusal, not unknown", async () => {
		const platform = createGovernancePlatform(config, async () => {
			throw new Error("offline");
		});
		const result = await platform.writeOperation(
			{ capability: "mergeCommits", before: true, after: false },
			measured(),
		);
		assert.deepEqual(result, { outcome: "refused", arm: "compare-read-unavailable", current: null });
	});

	it("refuses malformed/unequal head brackets and full pagination at the exact cap", async () => {
		const malformedHead = createGovernancePlatform(config, async (_method: string, path: string) => {
			if (path.includes("/git/ref/heads/"))
				return { ref: `refs/heads/${config.repository.defaultBranch}`, object: { sha: "d".repeat(40) } };
			throw new Error("must stop at malformed head");
		});
		await assert.rejects(malformedHead.readMeasured(), /default-head-shape/);
		assert.deepEqual(
			await malformedHead.writeOperation({ capability: "mergeCommits", before: true, after: false }, measured()),
			{ outcome: "refused", arm: "compare-read-invalid", current: null },
		);

		let heads = 0;
		const driftRequest = async (_method: string, path: string) => {
			if (path.includes("/git/ref/heads/")) {
				heads++;
				return {
					ref: `refs/heads/${config.repository.defaultBranch}`,
					object: { type: "commit", sha: (heads === 1 ? "d" : "e").repeat(40) },
				};
			}
			if (path === `repos/${config.repository.nameWithOwner}`)
				return {
					node_id: config.repository.id,
					full_name: config.repository.nameWithOwner,
					default_branch: config.repository.defaultBranch,
					allow_merge_commit: true,
					allow_squash_merge: false,
					allow_rebase_merge: false,
				};
			if (path.includes("per_page=100")) return [{ id: 7, name: config.ruleset.name, source_type: "Repository" }];
			if (path.endsWith("/rulesets/7"))
				return {
					id: 7,
					name: config.ruleset.name,
					target: "branch",
					source_type: "Repository",
					source: config.repository.nameWithOwner,
					enforcement: "active",
					bypass_actors: [],
					conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
					rules: [],
				};
			throw new Error(`unexpected ${path}`);
		};
		await assert.rejects(createGovernancePlatform(config, driftRequest).readMeasured(), /default-head-drift/);

		let pages = 0;
		const capRequest = async (_method: string, path: string) => {
			if (path.includes("/git/ref/heads/"))
				return {
					ref: `refs/heads/${config.repository.defaultBranch}`,
					object: { type: "commit", sha: "f".repeat(40) },
				};
			if (path === `repos/${config.repository.nameWithOwner}`)
				return {
					node_id: config.repository.id,
					full_name: config.repository.nameWithOwner,
					default_branch: config.repository.defaultBranch,
					allow_merge_commit: true,
					allow_squash_merge: false,
					allow_rebase_merge: false,
				};
			if (path.includes("per_page=100")) {
				pages++;
				return Array.from({ length: 100 }, (_, index) => ({
					id: pages * 100 + index,
					name: `rule-${pages}-${index}`,
					source_type: "Repository",
				}));
			}
			throw new Error(`unexpected ${path}`);
		};
		await assert.rejects(createGovernancePlatform(config, capRequest).readMeasured(), /pagination-bound/);
		assert.equal(pages, 100);
	});

	it("refuses zero, inherited, duplicate, mismatched, and foreign ruleset populations", async () => {
		const repository = {
			node_id: config.repository.id,
			full_name: config.repository.nameWithOwner,
			default_branch: config.repository.defaultBranch,
			allow_merge_commit: true,
			allow_squash_merge: false,
			allow_rebase_merge: false,
		};
		const baseDetail = {
			id: 7,
			name: "live",
			target: "branch",
			source_type: "Repository",
			source: config.repository.nameWithOwner,
			enforcement: "active",
			bypass_actors: [],
			conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
			rules: [],
		};
		const platformFor = (summaries: unknown[], detail: unknown = baseDetail) =>
			createGovernancePlatform(config, async (_method: string, path: string) => {
				if (path.includes("/git/ref/heads/"))
					return {
						ref: `refs/heads/${config.repository.defaultBranch}`,
						object: { type: "commit", sha: "1".repeat(40) },
					};
				if (path === `repos/${config.repository.nameWithOwner}`) return repository;
				if (path.includes("per_page=100")) return summaries;
				if (path.endsWith("/rulesets/7")) return detail;
				throw new Error(`unexpected ${path}`);
			});
		await assert.rejects(platformFor([]).readMeasured(), /ruleset-population/);
		await assert.rejects(
			platformFor([{ id: 7, name: "live", source_type: "Organization" }]).readMeasured(),
			/ruleset-inherited/,
		);
		await assert.rejects(
			platformFor([
				{ id: 7, name: "live", source_type: "Repository" },
				{ id: 7, name: "other", source_type: "Repository" },
			]).readMeasured(),
			/ruleset-duplicate/,
		);
		await assert.rejects(
			platformFor([
				{ id: 7, name: "live", source_type: "Repository" },
				{ id: 8, name: "live", source_type: "Repository" },
			]).readMeasured(),
			/ruleset-duplicate/,
		);
		await assert.rejects(
			platformFor([{ id: 7, name: "live", source_type: "Repository" }], {
				...baseDetail,
				name: "other",
			}).readMeasured(),
			/ruleset-detail-identity/,
		);
		await assert.rejects(
			platformFor([{ id: 7, name: "live", source_type: "Repository" }], {
				...baseDetail,
				source: "foreign/repository",
			}).readMeasured(),
			/ruleset-source/,
		);
	});

	it("reads through the pagination terminal before refusing an unsupported ruleset population", async () => {
		const calls: string[] = [];
		const request = async (_method: string, path: string) => {
			calls.push(path);
			if (path.includes("/git/ref/heads/"))
				return {
					ref: `refs/heads/${config.repository.defaultBranch}`,
					object: { type: "commit", sha: "b".repeat(40) },
				};
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

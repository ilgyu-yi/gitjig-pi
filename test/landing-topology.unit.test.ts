/* biome-ignore-all lint/suspicious/noExplicitAny: mutable negative fixtures intentionally traverse platform JSON */
/* biome-ignore-all lint/suspicious/noAssignInExpressions: compact mutation callbacks make the negative matrix auditable */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	attestLandingTopology,
	auditCoreRuleset,
	auditHumanApprovalRuleset,
	canonicalInstant,
	encodeLandingTopology,
	parseLandingTopology,
} from "../.github/workflows/landing-topology.mjs";
import { examineBootstrap, topologyPairKey } from "../.pi/extensions/gitjig/landing/bootstrap.ts";
import { CORE_GUARDS } from "../.pi/extensions/gitjig/landing/service.ts";
import {
	attestTopologyPlan,
	desiredCoreRuleset,
	desiredHumanApprovalRuleset,
	loadTopologyPlanningSnapshot,
	planSplitTopology,
	topologyPlanArtifactHash,
} from "../.pi/extensions/gitjig/landing/topology-plan.ts";

const updated = "2026-09-09T10:52:11.922Z";
const actionsId = 15368;
const arm = (result: object): unknown => ("arm" in result ? result.arm : undefined);
const core = {
	id: 10,
	...desiredCoreRuleset(actionsId),
	source_type: "Repository",
	source: "o/r",
	updated_at: updated,
};
const human = {
	id: 11,
	...desiredHumanApprovalRuleset(),
	source_type: "Repository",
	source: "o/r",
	updated_at: updated,
};
const topology = {
	schemaVersion: 1,
	phase: 4,
	repositoryId: "R",
	coreRulesetId: 10,
	humanApprovalRulesetId: 11,
	coreRulesetUpdatedAt: "2026-09-09T19:52:11.922+09:00",
	humanApprovalRulesetUpdatedAt: updated,
	activatedAt: "2026-09-09T10:52:12Z",
};

describe("Phase-4 topology owner and read-only plan", () => {
	it("canonicalizes equivalent millisecond instants and rejects sub-millisecond or stale activation", () => {
		assert.equal(canonicalInstant("2026-09-09T19:52:11.922+09:00"), updated);
		assert.equal(canonicalInstant("2026-09-09T10:52:11.9221Z"), undefined);
		assert.equal(
			arm(parseLandingTopology({ ...topology, activatedAt: "2026-09-09T10:52:11Z" })),
			"topology-activation-stale",
		);
		assert.equal(arm(parseLandingTopology({ ...topology, extra: true })), "topology-schema");
		const reordered = Object.fromEntries(Object.entries(topology).reverse());
		assert.equal(encodeLandingTopology(reordered), encodeLandingTopology(topology));
	});

	it("audits exact doorless core and quorum-only human shapes", () => {
		assert.deepEqual(auditCoreRuleset(core, actionsId), { ok: true });
		assert.deepEqual(auditHumanApprovalRuleset(human), { ok: true });
		const coreMutations: Array<(value: any) => void> = [
			(value) => (value.name = "other"),
			(value) => (value.target = "tag"),
			(value) => (value.source_type = "Organization"),
			(value) => (value.enforcement = "evaluate"),
			(value) => value.bypass_actors.push({}),
			(value) => (value.conditions.ref_name.include = ["refs/heads/main"]),
			(value) => (value.conditions.ref_name.exclude = ["refs/heads/x"]),
			(value) => (value.updated_at = "2026-09-09T10:52:29.1234Z"),
			(value) => value.rules.pop(),
			(value) => (value.rules[0].parameters.required_approving_review_count = 1),
			(value) => (value.rules[0].parameters.dismiss_stale_reviews_on_push = false),
			(value) => value.rules[0].parameters.required_reviewers.push({}),
			(value) => (value.rules[0].parameters.require_code_owner_review = true),
			(value) => (value.rules[0].parameters.require_last_push_approval = true),
			(value) => (value.rules[0].parameters.required_review_thread_resolution = false),
			(value) => (value.rules[0].parameters.require_extra_approval_for_unattributed_changes = true),
			(value) => (value.rules[0].parameters.allowed_merge_methods = ["squash"]),
			(value) => (value.rules[1].parameters.strict_required_status_checks_policy = false),
			(value) => (value.rules[1].parameters.do_not_enforce_on_create = true),
			(value) => (value.rules[1].parameters.required_status_checks[0].integration_id = actionsId + 1),
		];
		for (const mutate of coreMutations) {
			const value = structuredClone(core);
			mutate(value);
			assert.equal(auditCoreRuleset(value, actionsId).ok, false);
		}
		const humanMutations: Array<(value: any) => void> = [
			(value) => (value.bypass_actors[0].actor_id = 4),
			(value) => (value.bypass_actors[0].actor_type = "Integration"),
			(value) => (value.bypass_actors[0].bypass_mode = "always"),
			(value) => (value.rules[0].parameters.required_approving_review_count = 0),
			(value) => (value.rules[0].parameters.required_review_thread_resolution = true),
			(value) => (value.rules[0].parameters.allowed_merge_methods = ["merge"]),
		];
		for (const mutate of humanMutations) {
			const value = structuredClone(human);
			mutate(value);
			assert.equal(auditHumanApprovalRuleset(value).ok, false);
		}
		assert.deepEqual(
			attestLandingTopology(topology, { repositoryId: "R", core, human, actionsIntegrationId: actionsId }).ok,
			true,
		);
	});

	it("produces an unauthorized, data-only, window-ordered plan with exact rollback", () => {
		const current = { ...core, id: 20, name: "ghjig-tier3" };
		const result = planSplitTopology({
			repositoryId: "R",
			repositoryName: "o/r",
			defaultBranch: "main",
			actorId: "U",
			actorRole: "admin",
			actionsIntegrationId: actionsId,
			repositorySettings: { allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true },
			rulesets: [current],
			complete: true,
			bypassSemantics: "assumption-unverified",
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.plan.authorized, false);
		assert.deepEqual(
			result.plan.steps.map((step) => [step.order, step.method, step.path]),
			[
				[1, "PATCH", "/repos/o/r/rulesets/20"],
				[2, "POST", "/repos/o/r/rulesets"],
				[3, "PATCH", "/repos/o/r"],
			],
		);
		assert.match(result.plan.correlationId, /^[0-9a-f]{64}$/);
		assert.match(result.plan.artifactHash, /^[0-9a-f]{64}$/);
		const { artifactHash, ...artifact } = result.plan;
		for (const key of Object.keys(artifact) as Array<keyof typeof artifact>) {
			const changed = structuredClone(artifact) as Record<string, unknown>;
			changed[key] = key === "steps" ? [] : `${String(changed[key])}-changed`;
			assert.notEqual(topologyPlanArtifactHash(changed as never), artifactHash, `hash must bind ${key}`);
		}
		assert.equal(topologyPlanArtifactHash(artifact), artifactHash);
		assert.equal(result.plan.stage, "source-split");
		assert.equal(attestTopologyPlan(result.plan), true);
		assert.equal(attestTopologyPlan({ ...result.plan, beforeDigest: "0".repeat(64) }), false);
		assert.equal(result.plan.rollback.length, 3);
		assert.equal(result.plan.rollback[1].method, "DELETE");
		assert.equal(planSplitTopology({ ...result.plan, complete: false } as never).ok, false);
		const snapshot = {
			repositoryId: "R",
			repositoryName: "o/r",
			defaultBranch: "main",
			actorId: "U",
			actorRole: "admin",
			actionsIntegrationId: actionsId,
			repositorySettings: { allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true },
			rulesets: [current],
			complete: true,
			bypassSemantics: "assumption-unverified" as const,
		};
		assert.equal(planSplitTopology({ ...snapshot, actorRole: "write" }).ok, false);
		assert.equal(planSplitTopology({ ...snapshot, rulesets: [{ ...current, unknown: true }] }).ok, false);
		assert.equal(planSplitTopology({ ...snapshot, rulesets: [current, { ...current, id: 21 }] }).ok, false);
		assert.equal(planSplitTopology({ ...snapshot, rulesets: [{ ...current, source_type: "Organization" }] }).ok, false);
		assert.equal(planSplitTopology({ ...snapshot, rulesets: [{ ...current, enforcement: "evaluate" }] }).ok, false);
		const partial = planSplitTopology({ ...snapshot, rulesets: [core, human, { ...current, id: 22 }] });
		assert.equal(partial.ok, true);
		if (partial.ok) {
			assert.equal(partial.plan.steps[1].method, "PATCH");
			assert.equal(partial.plan.steps.at(-1)?.method, "DELETE");
			assert.equal(partial.plan.rollback[0].method, "POST");
		}
		const literal: any = structuredClone(current);
		literal.id = 23;
		literal.conditions.ref_name.include = ["refs/heads/main"];
		const literalPlan = planSplitTopology({ ...snapshot, rulesets: [core, human, literal] });
		assert.equal(literalPlan.ok, true);
		if (literalPlan.ok) assert.equal(literalPlan.plan.steps.at(-1)?.path, "/repos/o/r/rulesets/23");
		literal.conditions.ref_name.include = ["refs/heads/[main]"];
		assert.equal(planSplitTopology({ ...snapshot, rulesets: [literal] }).ok, false);
	});

	it("loads planning facts through GET-only complete reads", async () => {
		const calls: string[][] = [];
		const read = async (argv: string[]) => {
			calls.push(argv);
			const endpoint = argv.at(-1) ?? "";
			if (endpoint === "repos/o/r")
				return JSON.stringify({
					node_id: "R",
					default_branch: "main",
					allow_merge_commit: true,
					allow_squash_merge: true,
					allow_rebase_merge: true,
				});
			if (endpoint === "user") return JSON.stringify({ node_id: "U", login: "operator" });
			if (endpoint === "apps/github-actions") return JSON.stringify({ id: actionsId });
			if (endpoint.includes("rulesets?")) return JSON.stringify([[{ id: 20 }]]);
			if (endpoint === "repos/o/r/rulesets/20") return JSON.stringify(core);
			if (endpoint.includes("collaborators/operator/permission")) return JSON.stringify({ role_name: "admin" });
			return undefined;
		};
		const loaded = await loadTopologyPlanningSnapshot("github.com", "o/r", "/repo", read);
		assert.equal(loaded?.complete, true);
		assert.equal(
			calls.every((argv) => !argv.some((part) => new Set(["POST", "PATCH", "PUT", "DELETE"]).has(part))),
			true,
		);
		assert.ok(calls.some((argv) => argv.includes("--paginate") && argv.includes("--slurp")));
	});
});

describe("one-shot bootstrap admission", () => {
	const candidateBytes = encodeLandingTopology(topology) ?? "";
	const live = { repositoryId: "R", core, human, actionsIntegrationId: actionsId };
	const topologyEngine = { attestLandingTopology, canonicalInstant, encodeLandingTopology };
	const pairKey = topologyPairKey(live, topologyEngine) ?? "";
	const planningSnapshot = {
		repositoryId: "R",
		repositoryName: "o/r",
		defaultBranch: "main",
		actorId: "ADMIN",
		actorRole: "admin",
		actionsIntegrationId: actionsId,
		repositorySettings: { allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false },
		rulesets: [core, human],
		complete: true,
		bypassSemantics: "verified" as const,
	};
	const planned = planSplitTopology(planningSnapshot);
	if (!planned.ok) throw new Error(planned.arm);
	assert.equal(planned.plan.stage, "carrier-bootstrap");
	const sourceSnapshot = {
		...planningSnapshot,
		repositorySettings: { allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true },
		rulesets: [{ ...core, name: "legacy-landing" }],
	};
	const sourcePlanned = planSplitTopology(sourceSnapshot);
	if (!sourcePlanned.ok) throw new Error(sourcePlanned.arm);
	assert.equal(sourcePlanned.plan.stage, "source-split");
	assert.notEqual(sourcePlanned.plan.artifactHash, planned.plan.artifactHash);
	assert.notEqual(sourcePlanned.plan.correlationId, planned.plan.correlationId);
	const allCore = Object.fromEntries(CORE_GUARDS.map((guard) => [guard, true])) as Record<
		(typeof CORE_GUARDS)[number],
		boolean
	>;
	const base = {
		snapshot: {
			repositoryId: "R",
			pullRequestId: "PR",
			headSha: "a".repeat(40),
			baseSha: "b".repeat(40),
			baseRef: "main",
			prAuthorId: "AUTHOR",
			core: allCore,
			quorum: { measurable: true, required: 1, approvals: 0 },
			standingChangesRequested: false,
			topologyActive: false,
			escape: { commentId: 1, replayKey: "r", record: {}, context: {}, alreadyClaimed: false },
		},
		consumerId: "CONSUMER",
		now: "2026-09-09T10:53:00Z",
		engine: { ownBehalfRefusal: () => false },
		topologyEngine,
		defaultBranchTopology: "absent" as const,
		candidatePaths: [".github/landing-topology.json"],
		candidateTopology: topology,
		candidateBytes,
		live,
		repositorySettings: { allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false },
		planningSnapshot,
		planArtifact: planned.plan,
		authorization: {
			schemaVersion: 1 as const,
			recordId: "issuecomment-1",
			repositoryId: "R",
			stage: "carrier-bootstrap" as const,
			planHash: planned.plan.artifactHash,
			pairKey,
			actorId: "ADMIN",
			actorPermission: "admin" as const,
			correlationId: planned.plan.correlationId,
			issuedAt: "2026-09-09T10:52:30Z",
			expiresAt: "2026-09-09T11:52:30Z",
		},
		escapeProducerId: "PRODUCER",
		beneficiaryIds: [],
		controlledIdentityIds: [],
		consumedPairKeys: [],
	};

	it("admits only exact topology bytes with measured unmet quorum and fresh pair authority", () => {
		assert.deepEqual(examineBootstrap(base as never), { ok: true, pairKey });
		assert.equal(
			arm(examineBootstrap({ ...base, defaultBranchTopology: "active" } as never)),
			"bootstrap-carrier-not-absent",
		);
		assert.equal(
			arm(examineBootstrap({ ...base, defaultBranchTopology: "invalid" } as never)),
			"bootstrap-carrier-not-absent",
		);
		assert.equal(arm(examineBootstrap({ ...base, candidatePaths: ["SPEC.md"] } as never)), "bootstrap-constituents");
		for (const key of ["allow_merge_commit", "allow_squash_merge", "allow_rebase_merge"] as const) {
			assert.equal(
				arm(
					examineBootstrap({
						...base,
						repositorySettings: { ...base.repositorySettings, [key]: !base.repositorySettings[key] },
					} as never),
				),
				"bootstrap-repository-settings",
			);
		}
		assert.equal(
			arm(examineBootstrap({ ...base, candidateBytes: `${candidateBytes} ` } as never)),
			"bootstrap-topology-bytes",
		);
		for (const authorization of [
			{ ...base.authorization, actorPermission: "write" },
			{ ...base.authorization, planHash: "c".repeat(64) },
			{ ...base.authorization, actorId: "OTHER" },
			{ ...base.authorization, pairKey: "d".repeat(64) },
			{ ...base.authorization, correlationId: "e".repeat(64) },
			{ ...base.authorization, expiresAt: base.now },
			{ ...base.authorization, issuedAt: "2026-09-09T10:54:00Z" },
		])
			assert.equal(arm(examineBootstrap({ ...base, authorization } as never)), "bootstrap-authorization");
		assert.equal(
			arm(
				examineBootstrap({
					...base,
					planArtifact: { ...base.planArtifact, desiredDigest: "f".repeat(64) },
				} as never),
			),
			"bootstrap-authorization",
		);
		assert.equal(
			arm(
				examineBootstrap({
					...base,
					planningSnapshot: sourceSnapshot,
					planArtifact: sourcePlanned.plan,
					authorization: {
						...base.authorization,
						stage: "source-split",
						planHash: sourcePlanned.plan.artifactHash,
						correlationId: sourcePlanned.plan.correlationId,
						pairKey: "d".repeat(64),
					},
				} as never),
			),
			"bootstrap-plan-stale",
		);
		assert.equal(arm(examineBootstrap({ ...base, consumedPairKeys: [pairKey] } as never)), "bootstrap-pair-consumed");
		assert.equal(
			arm(examineBootstrap({ ...base, engine: { ownBehalfRefusal: () => true } } as never)),
			"bootstrap-own-behalf",
		);
		assert.equal(
			arm(
				examineBootstrap({
					...base,
					snapshot: { ...base.snapshot, quorum: { measurable: false, required: 1, approvals: 0 } },
				} as never),
			),
			"bootstrap-quorum-not-measured-unmet",
		);
	});
});

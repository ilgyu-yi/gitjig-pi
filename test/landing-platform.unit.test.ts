import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as engine from "../.github/workflows/gitjig-lifecycle.mjs";
import {
	activeRulesetApplies,
	landingPermission,
	loadPlatformLanding,
	newestCheckConclusions,
	normalizeReviewActorType,
	platformLandingEffects,
	selectCurrentConsumption,
} from "../.pi/extensions/gitjig/landing/platform.ts";
import { gitBlobOid } from "../.pi/extensions/gitjig/landing/provenance.ts";

const repoRoot = join(import.meta.dirname, "..");

describe("#278 platform snapshot normalization", () => {
	it("selects only the newest-created check and refuses malformed or tied populations", () => {
		assert.deepEqual(
			newestCheckConclusions([
				{ id: 2, name: "ac-closeout", status: "completed", conclusion: "failure" },
				{ id: 1, name: "ac-closeout", status: "completed", conclusion: "success" },
			]),
			new Map([["ac-closeout", { status: "completed", conclusion: "failure" }]]),
		);
		assert.equal(
			newestCheckConclusions([
				{ id: 2, name: "ac-closeout", status: "completed", conclusion: "failure" },
				{ id: 2, name: "ac-closeout", status: "completed", conclusion: "success" },
			]),
			undefined,
		);
		assert.equal(
			newestCheckConclusions([
				{ id: 3, name: "suite", status: "completed", conclusion: "success" },
				{ id: 2, name: "old", status: "completed", conclusion: "success" },
				{ id: 2, name: "older-duplicate", status: "completed", conclusion: "success" },
			]),
			undefined,
		);
		assert.equal(newestCheckConclusions([{ name: "ac-closeout", status: "completed" }]), undefined);
	});

	it("never upgrades absent or unknown actor types to User", () => {
		assert.equal(normalizeReviewActorType("User"), "User");
		assert.equal(normalizeReviewActorType("Bot"), "Bot");
		for (const value of [undefined, null, "Organization", "Mannequin", "user", 1])
			assert.equal(normalizeReviewActorType(value), "Unknown");
	});

	it("reads the collaborator endpoint role_name rather than a nonexistent permission field", () => {
		assert.equal(landingPermission({ role_name: "admin", user_permission: "read" }), "ADMIN");
		assert.equal(landingPermission({ role_name: "maintain" }), "MAINTAIN");
		for (const value of [{ role_name: "write" }, { user_permission: "admin" }, {}, null])
			assert.equal(landingPermission(value), undefined);
	});

	it("binds claim and terminal populations to one escape and exact heads", () => {
		const head = "a".repeat(40);
		const base = "b".repeat(40);
		const claim = (escapeCommentId: number, replayKey: string, claimHead = head) =>
			engine.createLandingClaim({
				escapeCommentId,
				replayKey,
				consumerRunId: `run-${escapeCommentId}`,
				consumerId: "U_one",
				repositoryId: "R_one",
				pullRequestId: "PR_one",
				headSha: claimHead,
				baseSha: base,
				claimedAt: "2026-01-01T00:00:00Z",
			});
		const terminal = engine.createLandingTerminalPlan({
			escapeCommentId: 3,
			claimCommentId: 8,
			consumerRunId: "old-run",
			writerId: "U_one",
			consumedAt: "2026-01-01T00:00:00Z",
			outcome: "refused",
			headSha: "c".repeat(40),
			baseSha: base,
		});
		assert.equal(terminal.ok, true);
		const terminalBody = terminal.ok && terminal.plan ? terminal.plan[0]?.body : "";
		const comments = [
			{ id: 7, authorId: "U_one", body: engine.encodeRecord(engine.RECORD_MARKERS.landingClaim, claim(4, "current")) },
			{ id: 6, authorId: "U_one", body: engine.encodeRecord(engine.RECORD_MARKERS.landingClaim, claim(3, "stale")) },
			{ id: 5, authorId: "U_one", body: terminalBody },
		];
		const selected = selectCurrentConsumption(
			comments,
			{ commentId: 4, replayKey: "current" },
			head,
			base,
			["U_one"],
			engine,
		);
		assert.deepEqual(
			selected.claims.map(({ commentId }) => commentId),
			[7],
		);
		assert.equal(selected.terminalPresent, false);
		assert.deepEqual(
			selectCurrentConsumption(comments, { commentId: 4, replayKey: "current" }, head, base, [], engine).claims,
			[],
		);
	});

	it("requires an active ruleset condition to include and not exclude the exact base", () => {
		const detail = (include: unknown[], exclude: unknown[] = []) => ({
			target: "branch",
			conditions: { ref_name: { include, exclude } },
		});
		assert.equal(activeRulesetApplies(detail(["~DEFAULT_BRANCH"]), "main", "main"), true);
		assert.equal(activeRulesetApplies(detail(["refs/heads/main"]), "main", "main"), true);
		assert.equal(activeRulesetApplies(detail(["~ALL"]), "main", "main"), true);
		assert.equal(activeRulesetApplies(detail(["refs/heads/m*"]), "main", "main"), true);
		assert.equal(activeRulesetApplies(detail(["refs/heads/**"]), "main", "main"), true);
		assert.equal(activeRulesetApplies(detail(["refs/heads/other"]), "main", "main"), false);
		assert.equal(activeRulesetApplies(detail(["~DEFAULT_BRANCH"]), "release", "main"), false);
		assert.equal(activeRulesetApplies(detail(["~DEFAULT_BRANCH"], ["refs/heads/main"]), "main", "main"), false);
		assert.equal(activeRulesetApplies(detail(["~DEFAULT_BRANCH"], ["refs/heads/m*"]), "main", "main"), false);
		for (const undecidable of ["refs/heads/[a-z]*", "refs/heads/{main,dev}", "refs/heads/m\\ain"])
			assert.equal(activeRulesetApplies(detail(["~DEFAULT_BRANCH"], [undecidable]), "main", "main"), false);
		assert.equal(
			activeRulesetApplies({ target: "tag", conditions: detail(["~DEFAULT_BRANCH"]).conditions }, "main", "main"),
			false,
		);
	});

	it("loads a complete clamped snapshot through the bounded platform seam", async () => {
		const head = "a".repeat(40);
		const base = "b".repeat(40);
		const engineBytes = readFileSync(join(repoRoot, ".github/workflows/gitjig-lifecycle.mjs"));
		const policyBytes = readFileSync(join(repoRoot, ".github/workflows/landing-policy.mjs"));
		const carrier = readFileSync(join(repoRoot, ".github/landing-policy.json"));
		const escapeRecord = engine.createEscapeRecord({
			repositoryId: "R_repo",
			pullRequestId: "PR_one",
			headSha: head,
			baseRef: "main",
			baseSha: base,
			producerKind: "maintainer",
			producerId: "U_maintainer",
			producerPermission: "MAINTAIN",
			reason: "bounded exception",
			appliedAt: "2025-12-31T12:00:00Z",
		});
		const revoke = {
			recordCommentId: 41,
			transition: "escape-revoke",
			observedAt: "2026-01-01T00:00:00Z",
			subjectHead: head,
			baseHead: base,
		};
		const response = (argv: string[]): unknown => {
			if (argv[3] === "user") return { node_id: "U_consumer", login: "consumer" };
			if (argv[3] === "graphql")
				return {
					data: {
						repository: {
							pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } },
						},
					},
				};
			const endpoint = argv.find((part) => part.startsWith("repos/o/r")) ?? "";
			if (endpoint === "repos/o/r")
				return {
					node_id: "R_repo",
					default_branch: "main",
					allow_merge_commit: true,
					allow_squash_merge: false,
					allow_rebase_merge: false,
				};
			if (endpoint.endsWith("pulls/7"))
				return {
					node_id: "PR_one",
					state: "open",
					draft: false,
					mergeable: true,
					mergeable_state: "blocked",
					head: { sha: head },
					base: { sha: base, ref: "main" },
					user: { node_id: "U_author" },
					labels: [{ name: "merge:bypass-permitted" }],
				};
			if (endpoint.includes("/reviews?") || endpoint.includes("rulesets?")) return [];
			if (endpoint.includes("/comments?"))
				return [
					{
						id: 41,
						body: engine.encodeRecord(engine.RECORD_MARKERS.escape, escapeRecord),
						user: { node_id: "U_maintainer", login: "maintainer" },
					},
					{
						id: 42,
						body: engine.encodeRecord(engine.RECORD_MARKERS.escapeTerminal, revoke),
						user: { node_id: "U_maintainer", login: "maintainer" },
					},
				];
			if (endpoint.includes("collaborators/maintainer/permission")) return { role_name: "maintain" };
			if (endpoint.includes("check-runs")) return { total_count: 0, check_runs: [] };
			if (endpoint.includes("branches/main")) return { commit: { sha: base } };
			if (endpoint.includes("contents/.github/workflows/gitjig-lifecycle.mjs")) return { sha: gitBlobOid(engineBytes) };
			if (endpoint.includes("contents/.github/workflows/landing-policy.mjs")) return { sha: gitBlobOid(policyBytes) };
			if (endpoint.includes("contents/.github/landing-policy.json"))
				return { encoding: "base64", content: carrier.toString("base64") };
			if (endpoint.includes("contents/.github/landing-topology.json")) return null;
			return null;
		};
		const loaded = await loadPlatformLanding("github.com", "o/r", 7, repoRoot, "2026-01-01T00:00:00Z", async (argv) =>
			JSON.stringify(response(argv)),
		);
		assert.equal(loaded.arm, "loaded");
		assert.equal(loaded.consumerId, "U_consumer");
		assert.equal(loaded.snapshot?.quorum.measurable, false);
		assert.equal(loaded.snapshot?.topologyActive, false);
		assert.equal(loaded.snapshot?.core.baseFresh, true);
		assert.equal(loaded.snapshot?.escape, undefined);
	});

	it("executes comment, label, merge and parent verification through an injected platform seam", async () => {
		const head = "a".repeat(40);
		const base = "b".repeat(40);
		const calls: string[][] = [];
		const runner = async (argv: string[]) => {
			calls.push(argv);
			if (argv.includes("POST")) return JSON.stringify({ id: 19 });
			if (argv.includes("DELETE")) return "";
			if (argv.includes("PUT")) return JSON.stringify({ merged: true });
			const endpoint = argv.find((part) => part.startsWith("repos/o/r")) ?? "";
			if (endpoint.endsWith("pulls/7")) return JSON.stringify({ merged: true, merge_commit_sha: "c".repeat(40) });
			if (endpoint.endsWith(`commits/${"c".repeat(40)}`))
				return JSON.stringify({ parents: [{ sha: base }, { sha: head }] });
			if (endpoint.includes("comments?")) return "[]";
			return undefined;
		};
		const effects = platformLandingEffects(
			"github.com",
			"o/r",
			7,
			repoRoot,
			engine.RECORD_MARKERS.landingClaim,
			runner,
			runner,
		);
		assert.equal(await effects.comment("record"), 19);
		assert.equal(await effects.removeLabel("merge:bypass-permitted"), true);
		assert.equal(await effects.merge(head), "accepted");
		assert.equal(await effects.verifyMerge(head, base), "landed");
		assert.equal(calls.filter((argv) => argv.includes("PUT")).length, 1);
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as engine from "../.github/workflows/gitjig-lifecycle.mjs";
import {
	activeRulesetApplies,
	landingPermission,
	normalizeReviewActorType,
	selectCurrentConsumption,
} from "../.pi/extensions/gitjig/landing/platform.ts";

describe("#278 platform snapshot normalization", () => {
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
		assert.equal(activeRulesetApplies(detail(["refs/heads/other"]), "main", "main"), false);
		assert.equal(activeRulesetApplies(detail(["~DEFAULT_BRANCH"]), "release", "main"), false);
		assert.equal(activeRulesetApplies(detail(["~DEFAULT_BRANCH"], ["refs/heads/main"]), "main", "main"), false);
		assert.equal(
			activeRulesetApplies({ target: "tag", conditions: detail(["~DEFAULT_BRANCH"]).conditions }, "main", "main"),
			false,
		);
	});
});

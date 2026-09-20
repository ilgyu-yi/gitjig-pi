import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	executeLanding,
	type LandingEffects,
	type LandingSnapshot,
	observedBlockers,
	operatorAuditComment,
	operatorConfirmation,
} from "../.pi/extensions/gitjig/landing/service.ts";

const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
function snapshot(change: Partial<LandingSnapshot> = {}): LandingSnapshot {
	return {
		repositoryId: "R",
		pullRequestId: "P",
		pullRequestNumber: 7,
		operatorId: "U",
		headSha: SHA,
		baseRef: "main",
		baseSha: BASE,
		labels: [],
		reviewHeadSha: SHA,
		reviewComplete: true,
		judgeComplete: true,
		resolver: "clear",
		acCloseout: true,
		requiredApprovals: 1,
		approvals: 1,
		requiredChecks: "pass",
		threadsResolved: true,
		fresh: true,
		mergeMethodAllowed: true,
		forcePushProtected: true,
		deletionProtected: true,
		mergeability: "mergeable",
		open: true,
		nonDraft: true,
		predicateOwnership: "single",
		...change,
	};
}
function effects(current: LandingSnapshot, log: string[] = []): LandingEffects {
	let comment = "";
	return {
		merge: async (route) => {
			log.push(`merge:${route}`);
			return "merged";
		},
		applyLabel: async () => {
			log.push("label");
			return "applied";
		},
		comment: async (body) => {
			comment = body;
			log.push("comment");
			return "published";
		},
		readComments: async () => [comment],
		reread: async () => current,
	};
}

describe("ordinary-first Tier-1 landing", () => {
	it("lands ordinary with complete current-head review and zero quorum", async () => {
		const log: string[] = [];
		const current = snapshot({ requiredApprovals: 0, approvals: 0 });
		const result = await executeLanding({ mode: "on", snapshot: current }, effects(current, log));
		assert.deepEqual(result, { outcome: "merged", route: "ordinary" });
		assert.deepEqual(log, ["merge:ordinary"]);
	});
	it("refuses before effects when ownership is ambiguous", async () => {
		const log: string[] = [];
		const current = snapshot({ predicateOwnership: "multiple" });
		assert.equal((await executeLanding({ mode: "on", snapshot: current }, effects(current, log))).outcome, "refused");
		assert.deepEqual(log, []);
	});
	it("enumerates every observed blocker", () => {
		const blockers = observedBlockers(
			snapshot({
				reviewComplete: false,
				judgeComplete: false,
				resolver: "blocked",
				acCloseout: false,
				requiredApprovals: 2,
				approvals: 0,
				requiredChecks: "pending",
				threadsResolved: false,
				fresh: false,
				mergeMethodAllowed: false,
				forcePushProtected: false,
				deletionProtected: false,
				mergeability: "unknown",
			}),
		);
		assert.equal(blockers.length, 12);
	});
});

describe("approval-only advisory", () => {
	it("tries ordinary, applies label, rereads, then tries the waiver", async () => {
		const current = snapshot({ approvals: 0 });
		const log: string[] = [];
		const seam = effects(current, log);
		seam.merge = async (route) => {
			log.push(`merge:${route}`);
			return route === "ordinary" ? "blocked" : "merged";
		};
		assert.deepEqual(await executeLanding({ mode: "on", snapshot: current }, seam), {
			outcome: "merged",
			route: "approval-waiver",
		});
		assert.deepEqual(log, ["merge:ordinary", "label", "merge:approval-waiver"]);
	});
	it("manual label has identical semantics and unknown ordinary outcome stops", async () => {
		const current = snapshot({ approvals: 0, labels: ["merge:bypass-permitted"] });
		const log: string[] = [];
		const seam = effects(current, log);
		seam.merge = async () => "unknown";
		assert.deepEqual(await executeLanding({ mode: "on", snapshot: current }, seam), {
			outcome: "refused",
			arm: "merge-outcome-unknown",
		});
		assert.deepEqual(log, []);
	});
});

describe("operator-directed one attempt", () => {
	it("presents blockers before effects", async () => {
		const current = snapshot({ acCloseout: false });
		const result = await executeLanding({ mode: "on", snapshot: current }, effects(current));
		assert.equal(result.outcome, "presented");
		if (result.outcome === "presented") assert.deepEqual(result.blockers, ["ac-closeout"]);
	});
	it("requires exact scope and confirmation, then label/comment/reread/one merge", async () => {
		const current = snapshot({ acCloseout: false, resolver: "missing" });
		const blockers = observedBlockers(current);
		const log: string[] = [];
		const seam = effects(current, log);
		const result = await executeLanding(
			{
				mode: "on",
				snapshot: current,
				instruction: {
					scope: "all-observed",
					attempt: "attempt_123",
					confirmation: `${operatorConfirmation(current, blockers)} attempt attempt_123`,
				},
			},
			seam,
		);
		assert.deepEqual(result, { outcome: "merged", route: "operator-directed" });
		assert.deepEqual(log, ["label", "comment", "merge:operator-directed"]);
		assert.match(operatorAuditComment(current, blockers), /gitjig-operator-directed-merge: v1/);
	});
	it("publication ambiguity stops before merge", async () => {
		const current = snapshot({ acCloseout: false });
		const blockers = observedBlockers(current);
		const log: string[] = [];
		const seam = effects(current, log);
		seam.readComments = async () => [];
		const result = await executeLanding(
			{
				mode: "on",
				snapshot: current,
				instruction: {
					scope: blockers,
					attempt: "attempt_123",
					confirmation: `${operatorConfirmation(current, blockers)} attempt attempt_123`,
				},
			},
			seam,
		);
		assert.deepEqual(result, { outcome: "refused", arm: "audit-ambiguity", blockers });
		assert.ok(!log.some((item) => item.startsWith("merge")));
	});
	it("operand drift stops and each retry necessarily republishes", async () => {
		const current = snapshot({ acCloseout: false });
		const blockers = observedBlockers(current);
		const log: string[] = [];
		const seam = effects(current, log);
		seam.reread = async () => snapshot({ acCloseout: false, headSha: "c".repeat(40) });
		const result = await executeLanding(
			{
				mode: "on",
				snapshot: current,
				instruction: {
					scope: "all-observed",
					attempt: "attempt_123",
					confirmation: `${operatorConfirmation(current, blockers)} attempt attempt_123`,
				},
			},
			seam,
		);
		assert.equal(result.outcome, "refused");
		assert.deepEqual(log, ["label", "comment"]);
	});
});

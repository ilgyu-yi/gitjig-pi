import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	executeLanding,
	type LandingEffects,
	type LandingSnapshot,
	type OperatorInstruction,
	observedBlockers,
	operatorAuditComment,
	operatorConfirmation,
} from "../.pi/extensions/gitjig/landing/service.ts";

const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
const NOW = "2026-01-02T03:04:05.000Z";
const ATTEMPT = "123e4567-e89b-42d3-a456-426614174000";
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
function effects(initial: LandingSnapshot, log: string[] = []): LandingEffects {
	let comment = "";
	let current = initial;
	return {
		merge: async (route) => {
			log.push(`merge:${route}`);
			return "merged";
		},
		applyLabel: async () => {
			log.push("label");
			current = { ...current, labels: ["merge:bypass-permitted"] };
			return "applied";
		},
		comment: async (body) => {
			comment = body;
			log.push("comment");
			return "published";
		},
		readComments: async () => [{ id: 10, authorId: "U", body: comment }],
		reread: async () => current,
	};
}
function directed(current: LandingSnapshot, scope: OperatorInstruction["scope"] = "all-observed"): OperatorInstruction {
	const blockers = observedBlockers(current);
	return {
		scope,
		attemptId: ATTEMPT,
		operatorInstructionObservedAt: NOW,
		confirmation: operatorConfirmation(current, blockers, ATTEMPT, NOW),
	};
}

describe("ordinary-first Tier-1 landing", () => {
	it("lands ordinary with complete current-head review and zero quorum", async () => {
		const log: string[] = [];
		const current = snapshot({ requiredApprovals: 0, approvals: 0 });
		assert.deepEqual(await executeLanding({ mode: "on", snapshot: current, now: NOW }, effects(current, log)), {
			outcome: "merged",
			route: "ordinary",
		});
		assert.deepEqual(log, ["merge:ordinary"]);
	});
	it("refuses before effects when ownership is ambiguous", async () => {
		const log: string[] = [];
		const current = snapshot({ predicateOwnership: "multiple" });
		assert.deepEqual(await executeLanding({ mode: "on", snapshot: current, now: NOW }, effects(current, log)), {
			outcome: "refused",
			arm: "blocker-population-incomplete",
		});
		assert.deepEqual(log, []);
	});
	it("enumerates every blocker as an exact class/detail object", () => {
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
		assert.ok(blockers.every((item) => item.class.length > 0 && item.detail.length > 0));
	});
});

describe("approval-only advisory", () => {
	it("tries ordinary, applies and rereads the label, then tries the waiver", async () => {
		const current = snapshot({ approvals: 0 });
		const log: string[] = [];
		const seam = effects(current, log);
		seam.merge = async (route) => {
			log.push(`merge:${route}`);
			return route === "ordinary" ? "blocked" : "merged";
		};
		assert.deepEqual(await executeLanding({ mode: "on", snapshot: current, now: NOW }, seam), {
			outcome: "merged",
			route: "approval-waiver",
		});
		assert.deepEqual(log, ["merge:ordinary", "label", "merge:approval-waiver"]);
	});
	it("refuses when a claimed label application is absent on reread", async () => {
		const current = snapshot({ approvals: 0 });
		const seam = effects(current);
		seam.merge = async () => "blocked";
		seam.reread = async () => current;
		assert.deepEqual(await executeLanding({ mode: "on", snapshot: current, now: NOW }, seam), {
			outcome: "refused",
			arm: "label-apply-failed",
		});
	});
	it("manual label has identical semantics and unknown ordinary outcome stops", async () => {
		const current = snapshot({ approvals: 0, labels: ["merge:bypass-permitted"] });
		const seam = effects(current);
		seam.merge = async () => "unknown";
		assert.deepEqual(await executeLanding({ mode: "on", snapshot: current, now: NOW }, seam), {
			outcome: "refused",
			arm: "merge-outcome-unknown",
		});
	});
});

describe("operator-directed one attempt", () => {
	it("presents the complete blocker population before effects", async () => {
		const current = snapshot({ acCloseout: false });
		const result = await executeLanding({ mode: "on", snapshot: current, now: NOW }, effects(current));
		assert.equal(result.outcome, "presented");
		if (result.outcome === "presented") assert.equal(result.blockers[0]?.class, "ac-closeout");
	});
	it("requires exact scope/confirmation, label, exact comment, two rereads and one merge", async () => {
		const current = snapshot({ acCloseout: false, resolver: "missing" });
		const blockers = observedBlockers(current);
		const log: string[] = [];
		const seam = effects(current, log);
		const instruction = directed(current);
		assert.deepEqual(await executeLanding({ mode: "on", snapshot: current, now: NOW, instruction }, seam), {
			outcome: "merged",
			route: "operator-directed",
		});
		assert.deepEqual(log, ["label", "comment", "merge:operator-directed"]);
		const body = operatorAuditComment(current, blockers, instruction, NOW);
		assert.match(body, /gitjig-operator-directed-merge: v1/);
		assert.deepEqual(Object.keys(JSON.parse(/```json\n([^\n]+)\n```/.exec(body)?.[1] ?? "{}")), [
			"schemaVersion",
			"repositoryId",
			"pullRequestId",
			"pullRequestNumber",
			"headSha",
			"baseRef",
			"baseSha",
			"instructionScope",
			"observedBlockers",
			"operatorInstructionObservedAt",
			"writerId",
			"attemptId",
			"observedAt",
		]);
	});
	it("publication or author ambiguity stops before merge", async () => {
		const current = snapshot({ acCloseout: false });
		const blockers = observedBlockers(current);
		const seam = effects(current);
		seam.readComments = async () => [
			{ id: 9, authorId: "foreign", body: operatorAuditComment(current, blockers, directed(current), NOW) },
		];
		assert.deepEqual(
			await executeLanding({ mode: "on", snapshot: current, now: NOW, instruction: directed(current) }, seam),
			{ outcome: "refused", arm: "audit-population-ambiguous", blockers },
		);
	});
	it("operand drift stops and retry needs a different UUID/comment", async () => {
		const current = snapshot({ acCloseout: false, labels: ["merge:bypass-permitted"] });
		const seam = effects(current);
		let reads = 0;
		seam.reread = async () =>
			++reads === 1
				? current
				: snapshot({ acCloseout: false, labels: ["merge:bypass-permitted"], headSha: "c".repeat(40) });
		assert.deepEqual(
			await executeLanding({ mode: "on", snapshot: current, now: NOW, instruction: directed(current) }, seam),
			{ outcome: "refused", arm: "operand-drift", blockers: observedBlockers(current) },
		);
		assert.notEqual(
			operatorAuditComment(current, observedBlockers(current), directed(current), NOW),
			operatorAuditComment(
				current,
				observedBlockers(current),
				{ ...directed(current), attemptId: "123e4567-e89b-42d3-a456-426614174001" },
				NOW,
			),
		);
	});
});

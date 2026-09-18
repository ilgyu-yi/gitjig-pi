import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as engine from "../.github/workflows/gitjig-lifecycle.mjs";
import {
	CORE_GUARDS,
	decideLanding,
	executeGuardedLanding,
	type LandingEffects,
	type LandingSnapshot,
} from "../.pi/extensions/gitjig/landing/service.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const core = () => Object.fromEntries(CORE_GUARDS.map((guard) => [guard, true])) as LandingSnapshot["core"];
function snapshot(overrides: Partial<LandingSnapshot> = {}): LandingSnapshot {
	return {
		repositoryId: "R_repo",
		pullRequestId: "PR_one",
		headSha: HEAD,
		baseSha: BASE,
		baseRef: "main",
		prAuthorId: "U_author",
		core: core(),
		quorum: { measurable: true, required: 1, approvals: 1 },
		standingChangesRequested: false,
		topologyActive: false,
		...overrides,
	};
}
function arm(decision: ReturnType<typeof decideLanding>): string | undefined {
	return decision.kind === "land" ? undefined : decision.arm;
}
function effects(overrides: Partial<LandingEffects> = {}): LandingEffects & { operations: string[] } {
	const operations: string[] = [];
	return {
		operations,
		comment: async (body) => {
			operations.push(`comment:${body.split("\n")[0]}`);
			return 10;
		},
		removeLabel: async (label) => {
			operations.push(`remove:${label}`);
			return true;
		},
		readClaims: async () => ({ comments: [], authorizedConsumerIds: ["U_consumer"] }),
		rereadHeads: async () => ({ headSha: HEAD, baseSha: BASE }),
		merge: async () => "accepted",
		verifyMerge: async () => "landed",
		...overrides,
	};
}

describe("#278 ordinary-first guarded landing", () => {
	it("stops at ready when mode is off and lands ordinary quorum before escape", () => {
		assert.deepEqual(decideLanding("off", snapshot()), { kind: "ready", arm: "merge-mode-off" });
		assert.deepEqual(decideLanding("on", snapshot()), { kind: "land", route: "ordinary" });
	});

	it("isolates every exhaustive core guard", () => {
		for (const guard of CORE_GUARDS) {
			const facts = core();
			(facts as Record<string, boolean>)[guard] = false;
			assert.deepEqual(decideLanding("on", snapshot({ core: facts })), {
				kind: "refused",
				arm: `core-${guard}`,
			});
		}
	});

	it("distinguishes unmeasurable quorum, standing objection and the Phase-4 clamp", () => {
		assert.equal(
			arm(decideLanding("on", snapshot({ quorum: { measurable: false, required: 0, approvals: 0 } }))),
			"quorum-unmeasurable",
		);
		for (const approvals of [0, 1])
			assert.equal(
				arm(
					decideLanding(
						"on",
						snapshot({ quorum: { measurable: true, required: 1, approvals }, standingChangesRequested: true }),
					),
				),
				"standing-changes-requested",
			);
		assert.equal(
			arm(decideLanding("on", snapshot({ quorum: { measurable: true, required: 1, approvals: 0 } }))),
			"topology-disabled",
		);
	});

	it("re-reads exact head and base immediately before merge", async () => {
		let merged = false;
		const result = await executeGuardedLanding(
			{ mode: "on", snapshot: snapshot(), consumerId: "U_consumer", now: "2026-01-01T00:00:00Z", engine },
			effects({
				rereadHeads: async () => ({ headSha: HEAD, baseSha: "c".repeat(40) }),
				merge: async () => {
					merged = true;
					return "accepted";
				},
			}),
		);
		assert.equal(result.arm, "head-base-changed");
		assert.equal(merged, false);
	});

	it("never retries or invents a terminal outcome when merge verification is unknown", async () => {
		let attempts = 0;
		const result = await executeGuardedLanding(
			{ mode: "on", snapshot: snapshot(), consumerId: "U_consumer", now: "2026-01-01T00:00:00Z", engine },
			effects({
				merge: async () => {
					attempts += 1;
					return "unknown";
				},
				verifyMerge: async () => "unknown",
			}),
		);
		assert.equal(result.outcome, "unverified-outcome");
		assert.equal(attempts, 1);
	});
});

describe("#278 append-only escape claim", () => {
	it("claims once, verifies one merge, terminalizes, then removes the label", async () => {
		let claimBody = "";
		let merges = 0;
		const operations: string[] = [];
		const escapeSnapshot = snapshot({
			quorum: { measurable: true, required: 1, approvals: 0 },
			topologyActive: true,
			escape: {
				commentId: 4,
				replayKey: "escape:4",
				record: {},
				context: {},
				alreadyClaimed: false,
			},
		});
		const result = await executeGuardedLanding(
			{
				mode: "on",
				snapshot: escapeSnapshot,
				consumerId: "U_consumer",
				consumerRunId: "run-one",
				now: "2026-01-01T00:00:00Z",
				engine: { ...engine, examineEscapeTransition: () => ({ ok: true, arm: "valid" }) },
			},
			{
				comment: async (body) => {
					operations.push(`comment:${body.split("\n")[0]}`);
					if (body.startsWith(engine.RECORD_MARKERS.landingClaim)) claimBody = body;
					return body.startsWith(engine.RECORD_MARKERS.landingClaim) ? 9 : 10;
				},
				removeLabel: async (label) => {
					operations.push(`remove:${label}`);
					return true;
				},
				readClaims: async () => ({
					comments: [{ id: 9, authorId: "U_consumer", body: claimBody }],
					authorizedConsumerIds: ["U_consumer"],
				}),
				rereadHeads: async () => ({ headSha: HEAD, baseSha: BASE }),
				merge: async () => {
					merges += 1;
					return "accepted";
				},
				verifyMerge: async () => "landed",
			},
		);
		assert.equal(result.outcome, "landed");
		assert.equal(merges, 1);
		assert.deepEqual(operations.slice(-2), [
			`comment:${engine.RECORD_MARKERS.landingTerminal}`,
			"remove:merge:bypass-permitted",
		]);
	});

	it("never removes the label when the terminal comment write fails", async () => {
		let removed = false;
		const result = await executeGuardedLanding(
			{
				mode: "on",
				snapshot: snapshot({
					quorum: { measurable: true, required: 1, approvals: 0 },
					topologyActive: true,
					escape: {
						commentId: 4,
						replayKey: "escape:4",
						record: {},
						context: {},
						alreadyClaimed: true,
						claim: { commentId: 9, consumerRunId: "crashed-run" },
					},
				}),
				consumerId: "U_consumer",
				now: "2026-01-01T00:00:00Z",
				engine,
			},
			effects({
				comment: async () => 0,
				removeLabel: async () => {
					removed = true;
					return true;
				},
				verifyMerge: async () => "not-landed",
			}),
		);
		assert.equal(result.arm, "reconciliation-terminal-write");
		assert.equal(removed, false);
	});

	it("reconciles a crash-after-claim without issuing a second merge", async () => {
		let merges = 0;
		const result = await executeGuardedLanding(
			{
				mode: "on",
				snapshot: snapshot({
					quorum: { measurable: true, required: 1, approvals: 0 },
					topologyActive: true,
					escape: {
						commentId: 4,
						replayKey: "escape:4",
						record: {},
						context: {},
						alreadyClaimed: true,
						claim: { commentId: 9, consumerRunId: "crashed-run" },
					},
				}),
				consumerId: "U_consumer",
				now: "2026-01-01T00:00:00Z",
				engine,
			},
			effects({
				merge: async () => {
					merges += 1;
					return "accepted";
				},
				verifyMerge: async () => "not-landed",
			}),
		);
		assert.equal(result.arm, "reconciled-refused");
		assert.equal(result.consumerRunId, "crashed-run");
		assert.equal(merges, 0);
	});

	it("chooses the lowest authorized author-attested platform comment id", () => {
		const base = {
			escapeCommentId: 4,
			replayKey: "escape:4",
			consumerId: "U_consumer",
			repositoryId: "R_repo",
			pullRequestId: "PR_one",
			headSha: HEAD,
			baseSha: BASE,
			claimedAt: "2026-01-01T00:00:00Z",
		};
		const later = engine.createLandingClaim({ ...base, consumerRunId: "run-later" });
		const earlier = engine.createLandingClaim({ ...base, consumerRunId: "run-earlier" });
		const other = engine.createLandingClaim({
			...base,
			consumerId: "U_other",
			consumerRunId: "run-other",
		});
		const comments = [
			{ id: 12, authorId: "U_consumer", body: engine.encodeRecord(engine.RECORD_MARKERS.landingClaim, later) },
			{ id: 9, authorId: "U_consumer", body: engine.encodeRecord(engine.RECORD_MARKERS.landingClaim, earlier) },
			{ id: 8, authorId: "U_other", body: engine.encodeRecord(engine.RECORD_MARKERS.landingClaim, other) },
			{ id: 1, authorId: "U_forged", body: engine.encodeRecord(engine.RECORD_MARKERS.landingClaim, earlier) },
		];
		assert.equal(engine.landingClaimWinner(comments, "escape:4", ["U_consumer", "U_other"])?.id, 8);
	});

	it("writes terminal before removing the bypass label", async () => {
		const plan = engine.createLandingTerminalPlan({
			escapeCommentId: 4,
			claimCommentId: 9,
			consumerRunId: "run-one",
			consumedAt: "2026-01-01T00:00:00Z",
			outcome: "refused",
			headSha: HEAD,
			baseSha: BASE,
		});
		assert.equal(plan.ok, true);
		if (plan.ok && plan.plan)
			assert.deepEqual(
				plan.plan.map((operation) => operation.kind),
				["comment", "remove-label"],
			);
	});
});

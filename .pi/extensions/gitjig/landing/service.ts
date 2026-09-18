/** Warning-surface roster: EXEMPT — pure decisions return fixed arm tokens and never render actor operands. */
import { randomUUID } from "node:crypto";
import type { MergeMode } from "../modes.ts";

export const CORE_GUARDS = [
	"changelog",
	"ssotHome",
	"tocFreshness",
	"sourceStyle",
	"typeCheck",
	"suite",
	"acCloseout",
	"protectedBranch",
	"deletionProtection",
	"forcePushProtection",
	"requiredContexts",
	"threadsResolved",
	"mergeMethod",
	"headFresh",
	"baseFresh",
	"history",
	"open",
	"nonDraft",
	"mergeable",
	"upToDate",
] as const;
export type CoreGuard = (typeof CORE_GUARDS)[number];
export type CoreFacts = Readonly<Record<CoreGuard, boolean>>;

export interface LandingSnapshot {
	repositoryId: string;
	pullRequestId: string;
	headSha: string;
	baseSha: string;
	baseRef: string;
	prAuthorId: string;
	core: CoreFacts;
	quorum: { measurable: boolean; required: number; approvals: number };
	standingChangesRequested: boolean;
	topologyActive: boolean;
	escape?: {
		commentId: number;
		replayKey: string;
		record: unknown;
		context: unknown;
		alreadyClaimed: boolean;
		claim?: { commentId: number; consumerRunId: string };
		terminalPresent?: boolean;
	};
}

export type LandingDecision =
	| { kind: "ready"; arm: "merge-mode-off" }
	| { kind: "refused"; arm: string }
	| { kind: "land"; route: "ordinary" | "escape" };

export interface LifecycleEngine {
	RECORD_MARKERS: Readonly<Record<string, string>>;
	encodeRecord(marker: string, value: unknown): string;
	escapeRefusalRecord(arm: string, observedAt: string): unknown;
	parseMarkedRecord(body: unknown, marker: string): unknown;
	validateEscapeRecord(record: unknown, context: unknown): { ok: boolean; arm: string };
	admitLandingClaim(value: unknown): boolean;
	admitLandingTerminal(value: unknown): boolean;
	examineEscapeTransition(
		record: unknown,
		context: unknown,
		observedAt: string,
	): { ok: boolean; arm: string; plan?: readonly { kind: string; body?: string }[] };
	createLandingClaim(input: unknown): unknown;
	landingClaimWinner(
		comments: unknown[],
		replayKey: string,
		authorizedConsumerIds: string[],
	): { id: number; claim: { consumerRunId: string } } | undefined;
	eligibleApprovalCount?(
		reviews: unknown[],
		prAuthorId: string,
		headSha: string,
		quorum: number,
	): { ok: boolean; count?: number };
	eligibleChangesRequested?(review: unknown, prAuthorId: string, headSha: string): boolean;
	createLandingTerminalPlan(input: unknown): {
		ok: boolean;
		arm?: string;
		plan?: readonly { kind: string; body?: string; label?: string }[];
	};
}

export function decideLanding(mode: MergeMode, snapshot: LandingSnapshot): LandingDecision {
	if (mode === "off") return { kind: "ready", arm: "merge-mode-off" };
	for (const guard of CORE_GUARDS) if (!snapshot.core[guard]) return { kind: "refused", arm: `core-${guard}` };
	const { quorum } = snapshot;
	if (!quorum.measurable || !Number.isSafeInteger(quorum.required) || quorum.required <= 0)
		return { kind: "refused", arm: "quorum-unmeasurable" };
	if (quorum.approvals >= quorum.required) return { kind: "land", route: "ordinary" };
	if (snapshot.standingChangesRequested) return { kind: "refused", arm: "standing-changes-requested" };
	if (!snapshot.topologyActive) return { kind: "refused", arm: "topology-disabled" };
	if (snapshot.escape === undefined) return { kind: "refused", arm: "escape-absent" };
	if (snapshot.escape.alreadyClaimed) return { kind: "refused", arm: "escape-consumed" };
	return { kind: "land", route: "escape" };
}

export interface LandingEffects {
	comment(body: string): Promise<number>;
	removeLabel(label: string): Promise<boolean>;
	readClaims(): Promise<{ comments: unknown[]; authorizedConsumerIds: string[] } | undefined>;
	rereadHeads(): Promise<{ headSha: string; baseSha: string } | undefined>;
	merge(expectedHeadSha: string): Promise<"accepted" | "rejected" | "unknown">;
	verifyMerge(headSha: string, baseSha: string): Promise<"landed" | "not-landed" | "unknown">;
}

export interface LandingExecutionInput {
	mode: MergeMode;
	snapshot: LandingSnapshot;
	consumerId: string;
	consumerRunId?: string;
	now: string;
	engine: LifecycleEngine;
}

export interface LandingExecutionResult {
	outcome: "ready" | "landed" | "refused" | "unverified-outcome";
	arm: string;
	consumerRunId?: string;
}

async function writeEscapeTerminal(
	input: LandingExecutionInput,
	effects: LandingEffects,
	claimCommentId: number | null,
	outcome: "landed" | "refused",
	arm?: string,
): Promise<boolean> {
	const escapeState = input.snapshot.escape;
	if (!escapeState) return false;
	if (arm) {
		const refusal = input.engine.escapeRefusalRecord(arm, input.now);
		const refusalId = await effects.comment(
			input.engine.encodeRecord(input.engine.RECORD_MARKERS.escapeRefusal, refusal),
		);
		if (!Number.isSafeInteger(refusalId) || refusalId <= 0) return false;
	}
	const terminal = input.engine.createLandingTerminalPlan({
		escapeCommentId: escapeState.commentId,
		claimCommentId,
		consumerRunId: input.consumerRunId,
		consumedAt: input.now,
		outcome,
		headSha: input.snapshot.headSha,
		baseSha: input.snapshot.baseSha,
	});
	if (!terminal.ok || terminal.plan === undefined) return false;
	for (const operation of terminal.plan) {
		if (operation.kind === "comment" && typeof operation.body === "string") {
			const commentId = await effects.comment(operation.body);
			if (!Number.isSafeInteger(commentId) || commentId <= 0) return false;
		} else if (operation.kind === "remove-label" && typeof operation.label === "string") {
			if (!(await effects.removeLabel(operation.label))) return false;
		} else return false;
	}
	return true;
}

export async function executeGuardedLanding(
	input: LandingExecutionInput,
	effects: LandingEffects,
): Promise<LandingExecutionResult> {
	const consumerRunId = input.consumerRunId ?? randomUUID();
	const executionInput = { ...input, consumerRunId };
	const pendingClaim = input.snapshot.escape?.claim;
	if (input.mode === "on" && pendingClaim && !input.snapshot.escape?.terminalPresent) {
		const verified = await effects.verifyMerge(input.snapshot.headSha, input.snapshot.baseSha);
		if (verified === "unknown")
			return { outcome: "unverified-outcome", arm: "reconciliation-unverified", consumerRunId };
		const reconciliationInput = { ...input, consumerRunId: pendingClaim.consumerRunId };
		const outcome = verified === "landed" ? "landed" : "refused";
		const recorded = await writeEscapeTerminal(
			reconciliationInput,
			effects,
			pendingClaim.commentId,
			outcome,
			outcome === "refused" ? "claimed-run-not-landed" : undefined,
		);
		return {
			outcome,
			arm: recorded ? `reconciled-${outcome}` : "reconciliation-terminal-write",
			consumerRunId: pendingClaim.consumerRunId,
		};
	}
	const decision = decideLanding(input.mode, input.snapshot);
	if (decision.kind === "ready") return { outcome: "ready", arm: decision.arm };
	if (decision.kind === "refused") return { outcome: "refused", arm: decision.arm };

	let claimCommentId: number | undefined;
	if (decision.route === "escape") {
		const escapeState = input.snapshot.escape;
		if (!escapeState) return { outcome: "refused", arm: "escape-absent", consumerRunId };
		const examination = input.engine.examineEscapeTransition(escapeState.record, escapeState.context, input.now);
		if (!examination.ok) {
			const refusalOperation = examination.plan?.[0];
			if (refusalOperation?.kind !== "comment" || typeof refusalOperation.body !== "string")
				return { outcome: "refused", arm: "escape-refusal-plan", consumerRunId };
			const refusalId = await effects.comment(refusalOperation.body);
			if (Number.isSafeInteger(refusalId) && refusalId > 0)
				await writeEscapeTerminal(executionInput, effects, null, "refused");
			return { outcome: "refused", arm: examination.arm, consumerRunId };
		}
		const claim = input.engine.createLandingClaim({
			escapeCommentId: escapeState.commentId,
			replayKey: escapeState.replayKey,
			consumerRunId,
			consumerId: input.consumerId,
			repositoryId: input.snapshot.repositoryId,
			pullRequestId: input.snapshot.pullRequestId,
			headSha: input.snapshot.headSha,
			baseSha: input.snapshot.baseSha,
			claimedAt: input.now,
		});
		if (claim === undefined) {
			await writeEscapeTerminal(executionInput, effects, null, "refused", "claim-invalid");
			return { outcome: "refused", arm: "claim-invalid", consumerRunId };
		}
		claimCommentId = await effects.comment(input.engine.encodeRecord(input.engine.RECORD_MARKERS.landingClaim, claim));
		if (!Number.isSafeInteger(claimCommentId) || claimCommentId <= 0)
			return { outcome: "refused", arm: "claim-write", consumerRunId };
		const population = await effects.readClaims();
		const winner = population
			? input.engine.landingClaimWinner(population.comments, escapeState.replayKey, population.authorizedConsumerIds)
			: undefined;
		if (winner?.id !== claimCommentId || winner.claim.consumerRunId !== consumerRunId) {
			const refusal = input.engine.escapeRefusalRecord("concurrent-claim", input.now);
			await effects.comment(input.engine.encodeRecord(input.engine.RECORD_MARKERS.escapeRefusal, refusal));
			return { outcome: "refused", arm: "concurrent-claim", consumerRunId };
		}
	}

	const heads = await effects.rereadHeads();
	if (heads?.headSha !== input.snapshot.headSha || heads.baseSha !== input.snapshot.baseSha) {
		if (claimCommentId !== undefined)
			await writeEscapeTerminal(executionInput, effects, claimCommentId, "refused", "head-base-changed");
		return { outcome: "refused", arm: "head-base-changed", consumerRunId };
	}
	const attempted = await effects.merge(input.snapshot.headSha);
	if (attempted === "rejected") {
		if (claimCommentId !== undefined)
			await writeEscapeTerminal(executionInput, effects, claimCommentId, "refused", "merge-rejected");
		return { outcome: "refused", arm: "merge-rejected", consumerRunId };
	}
	const verified = await effects.verifyMerge(input.snapshot.headSha, input.snapshot.baseSha);
	if (verified === "unknown") return { outcome: "unverified-outcome", arm: "merge-unverified", consumerRunId };
	if (verified === "not-landed") {
		if (claimCommentId !== undefined)
			await writeEscapeTerminal(executionInput, effects, claimCommentId, "refused", "merge-not-landed");
		return { outcome: "refused", arm: "merge-not-landed", consumerRunId };
	}
	if (claimCommentId !== undefined) {
		const recorded = await writeEscapeTerminal(executionInput, effects, claimCommentId, "landed");
		return {
			outcome: "landed",
			arm: recorded ? decision.route : "landed-terminal-write",
			consumerRunId,
		};
	}
	return { outcome: "landed", arm: decision.route, consumerRunId };
}

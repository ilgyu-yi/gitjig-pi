/** Warning-surface roster: EXEMPT — pure decisions return closed outcome and blocker tokens. */
import type { MergeMode } from "../modes.ts";

export const BYPASS_LABEL = "merge:bypass-permitted";
export const OPERATOR_AUDIT_MARKER = "<!-- gitjig-operator-directed-merge: v1 -->";

export type Blocker =
	| "review-missing"
	| "judge-missing"
	| "resolver-not-clear"
	| "native-approval"
	| "ac-closeout"
	| "required-checks"
	| "threads"
	| "freshness"
	| "merge-method"
	| "force-push-protection"
	| "deletion-protection"
	| "pr-closed"
	| "draft"
	| "merge-conflict"
	| "mergeability-unknown";

export interface LandingSnapshot {
	repositoryId: string;
	pullRequestId: string;
	pullRequestNumber: number;
	operatorId: string;
	headSha: string;
	baseRef: string;
	baseSha: string;
	labels: readonly string[];
	reviewHeadSha?: string;
	reviewComplete: boolean;
	judgeComplete: boolean;
	resolver: "clear" | "blocked" | "missing";
	acCloseout: boolean;
	requiredApprovals: number;
	approvals: number;
	requiredChecks: "pass" | "fail" | "pending" | "unknown";
	threadsResolved: boolean;
	fresh: boolean;
	mergeMethodAllowed: boolean;
	forcePushProtected: boolean;
	deletionProtected: boolean;
	mergeability: "mergeable" | "conflicting" | "unknown";
	open: boolean;
	nonDraft: boolean;
	predicateOwnership: "single" | "unknown" | "multiple" | "inherited-ambiguous";
}

export interface OperatorInstruction {
	scope: "all-observed" | readonly Blocker[];
	attempt: string;
	confirmation: string;
}

export type LandingResult =
	| { outcome: "merged"; route: "ordinary" | "approval-waiver" | "operator-directed" }
	| { outcome: "presented"; blockers: readonly Blocker[]; confirmation: string }
	| { outcome: "refused"; arm: string; blockers?: readonly Blocker[] };

export interface LandingEffects {
	merge(
		route: "ordinary" | "approval-waiver" | "operator-directed",
		expectedHead: string,
	): Promise<"merged" | "blocked" | "unknown">;
	applyLabel(label: string): Promise<"applied" | "present" | "failed" | "unknown">;
	comment(body: string): Promise<"published" | "failed" | "unknown">;
	readComments(): Promise<readonly string[] | undefined>;
	reread(): Promise<LandingSnapshot | undefined>;
}

function uniq<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

export function observedBlockers(snapshot: LandingSnapshot): Blocker[] {
	const result: Blocker[] = [];
	if (!snapshot.reviewComplete || snapshot.reviewHeadSha !== snapshot.headSha) result.push("review-missing");
	if (!snapshot.judgeComplete) result.push("judge-missing");
	if (snapshot.resolver !== "clear") result.push("resolver-not-clear");
	if (snapshot.requiredApprovals > 0 && snapshot.approvals < snapshot.requiredApprovals) result.push("native-approval");
	if (!snapshot.acCloseout) result.push("ac-closeout");
	if (snapshot.requiredChecks !== "pass") result.push("required-checks");
	if (!snapshot.threadsResolved) result.push("threads");
	if (!snapshot.fresh) result.push("freshness");
	if (!snapshot.mergeMethodAllowed) result.push("merge-method");
	if (!snapshot.forcePushProtected) result.push("force-push-protection");
	if (!snapshot.deletionProtected) result.push("deletion-protection");
	if (!snapshot.open) result.push("pr-closed");
	if (!snapshot.nonDraft) result.push("draft");
	if (snapshot.mergeability === "conflicting") result.push("merge-conflict");
	if (snapshot.mergeability === "unknown") result.push("mergeability-unknown");
	return result;
}

export function operatorConfirmation(snapshot: LandingSnapshot, blockers: readonly Blocker[]): string {
	return `land ${snapshot.repositoryId}#${snapshot.pullRequestNumber} ${snapshot.headSha} onto ${snapshot.baseRef}@${snapshot.baseSha} despite ${[...blockers].sort().join(",")}`;
}

export function operatorAuditComment(
	snapshot: LandingSnapshot,
	blockers: readonly Blocker[],
	confirmation = operatorConfirmation(snapshot, blockers),
): string {
	return `${OPERATOR_AUDIT_MARKER}\n\n\`\`\`json\n${JSON.stringify({
		schemaVersion: 1,
		repositoryId: snapshot.repositoryId,
		pullRequestId: snapshot.pullRequestId,
		pullRequestNumber: snapshot.pullRequestNumber,
		operatorId: snapshot.operatorId,
		headSha: snapshot.headSha,
		baseRef: snapshot.baseRef,
		baseSha: snapshot.baseSha,
		blockers: [...blockers].sort(),
		confirmation,
	})}\n\`\`\``;
}

function sameOperands(a: LandingSnapshot, b: LandingSnapshot): boolean {
	return (
		a.repositoryId === b.repositoryId &&
		a.pullRequestId === b.pullRequestId &&
		a.operatorId === b.operatorId &&
		a.headSha === b.headSha &&
		a.baseRef === b.baseRef &&
		a.baseSha === b.baseSha
	);
}

export async function executeLanding(
	input: { mode: MergeMode; snapshot: LandingSnapshot; instruction?: OperatorInstruction },
	effects: LandingEffects,
): Promise<LandingResult> {
	if (input.mode !== "on") return { outcome: "refused", arm: "merge-mode-off" };
	const snapshot = input.snapshot;
	if (snapshot.predicateOwnership !== "single") return { outcome: "refused", arm: "predicate-ownership" };
	if (!Number.isInteger(snapshot.requiredApprovals) || snapshot.requiredApprovals < 0)
		return { outcome: "refused", arm: "predicate-population" };
	const blockers = observedBlockers(snapshot);

	if (blockers.length === 0) {
		const result = await effects.merge("ordinary", snapshot.headSha);
		return result === "merged"
			? { outcome: "merged", route: "ordinary" }
			: { outcome: "refused", arm: result === "unknown" ? "merge-outcome-unknown" : "ordinary-refused" };
	}

	const approvalOnly = blockers.length === 1 && blockers[0] === "native-approval";
	if (approvalOnly && !input.instruction) {
		// The ordinary endpoint is intentionally tried before advisory-label application.
		const ordinary = await effects.merge("ordinary", snapshot.headSha);
		if (ordinary === "merged") return { outcome: "merged", route: "ordinary" };
		if (ordinary === "unknown") return { outcome: "refused", arm: "merge-outcome-unknown" };
		const label = snapshot.labels.includes(BYPASS_LABEL) ? "present" : await effects.applyLabel(BYPASS_LABEL);
		if (label === "failed" || label === "unknown") return { outcome: "refused", arm: "label-apply" };
		const current = await effects.reread();
		if (!current || !sameOperands(snapshot, current)) return { outcome: "refused", arm: "operand-drift" };
		const currentBlockers = observedBlockers(current);
		if (currentBlockers.length !== 1 || currentBlockers[0] !== "native-approval")
			return { outcome: "refused", arm: "predicate-drift", blockers: currentBlockers };
		const result = await effects.merge("approval-waiver", current.headSha);
		return result === "merged"
			? { outcome: "merged", route: "approval-waiver" }
			: { outcome: "refused", arm: result === "unknown" ? "merge-outcome-unknown" : "policy-refusal" };
	}

	const instruction = input.instruction;
	const confirmation = operatorConfirmation(snapshot, blockers);
	if (!instruction) return { outcome: "presented", blockers, confirmation: `${confirmation} attempt <fresh-nonce>` };
	if (blockers.length === 0) return { outcome: "refused", arm: "blocker-population" };
	const selected = instruction.scope === "all-observed" ? blockers : uniq(instruction.scope);
	if (selected.length === 0 || selected.length !== blockers.length || selected.some((item) => !blockers.includes(item)))
		return { outcome: "refused", arm: "blocker-scope", blockers };
	if (
		!/^[A-Za-z0-9_-]{8,128}$/.test(instruction.attempt) ||
		instruction.confirmation !== `${confirmation} attempt ${instruction.attempt}`
	)
		return { outcome: "refused", arm: "instruction-confirmation", blockers };
	const label = snapshot.labels.includes(BYPASS_LABEL) ? "present" : await effects.applyLabel(BYPASS_LABEL);
	if (label === "failed" || label === "unknown") return { outcome: "refused", arm: "label-apply", blockers };
	const comment = operatorAuditComment(snapshot, blockers, instruction.confirmation);
	const publication = await effects.comment(comment);
	if (publication !== "published") return { outcome: "refused", arm: "audit-publication", blockers };
	const comments = await effects.readComments();
	if (!comments || comments.filter((value) => value === comment).length !== 1)
		return { outcome: "refused", arm: "audit-ambiguity", blockers };
	const current = await effects.reread();
	if (!current || !sameOperands(snapshot, current)) return { outcome: "refused", arm: "operand-drift", blockers };
	const currentBlockers = observedBlockers(current);
	if (currentBlockers.length !== blockers.length || blockers.some((item) => !currentBlockers.includes(item)))
		return { outcome: "refused", arm: "blocker-population-drift", blockers: currentBlockers };
	const result = await effects.merge("operator-directed", current.headSha);
	return result === "merged"
		? { outcome: "merged", route: "operator-directed" }
		: { outcome: "refused", arm: result === "unknown" ? "merge-outcome-unknown" : "policy-refusal" };
}

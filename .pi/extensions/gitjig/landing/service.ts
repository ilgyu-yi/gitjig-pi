/** Warning-surface roster: EXEMPT — pure decisions return closed outcome and blocker tokens. */
import type { MergeMode } from "../modes.ts";

export const BYPASS_LABEL = "merge:bypass-permitted";
export const OPERATOR_AUDIT_MARKER = "<!-- gitjig-operator-directed-merge: v1 -->";

export type BlockerClass =
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
export interface Blocker {
	class: BlockerClass;
	detail: string;
}

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
	scope: "all-observed" | readonly BlockerClass[];
	attemptId: string;
	operatorInstructionObservedAt: string;
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
	readComments(): Promise<readonly { id: number; authorId: string; body: string }[] | undefined>;
	reread(): Promise<LandingSnapshot | undefined>;
}
const DETAIL: Readonly<Record<BlockerClass, string>> = Object.freeze({
	"review-missing": "complete Review evidence is absent from the current head",
	"judge-missing": "required Judge adjudication is absent",
	"resolver-not-clear": "the final Resolver result is not clear",
	"native-approval": "the positive native approving-review quorum is unmet",
	"ac-closeout": "the Tier-1 ac-closeout predicate is unmet",
	"required-checks": "one or more selected required checks are not successful",
	threads: "one or more review threads are unresolved",
	freshness: "the pull request is not fresh against the live base",
	"merge-method": "the requested merge-commit method is unavailable",
	"force-push-protection": "non-fast-forward protection is absent",
	"deletion-protection": "deletion protection is absent",
	"pr-closed": "the pull request is not open",
	draft: "the pull request is a draft",
	"merge-conflict": "the platform reports a merge conflict",
	"mergeability-unknown": "the platform cannot determine mergeability",
});
function blocker(value: BlockerClass): Blocker {
	return { class: value, detail: DETAIL[value] };
}
export function observedBlockers(snapshot: LandingSnapshot): Blocker[] {
	const result: Blocker[] = [];
	const add = (value: BlockerClass) => result.push(blocker(value));
	if (!snapshot.reviewComplete || snapshot.reviewHeadSha !== snapshot.headSha) add("review-missing");
	if (!snapshot.judgeComplete) add("judge-missing");
	if (snapshot.resolver !== "clear") add("resolver-not-clear");
	if (snapshot.requiredApprovals > 0 && snapshot.approvals < snapshot.requiredApprovals) add("native-approval");
	if (!snapshot.acCloseout) add("ac-closeout");
	if (snapshot.requiredChecks !== "pass") add("required-checks");
	if (!snapshot.threadsResolved) add("threads");
	if (!snapshot.fresh) add("freshness");
	if (!snapshot.mergeMethodAllowed) add("merge-method");
	if (!snapshot.forcePushProtected) add("force-push-protection");
	if (!snapshot.deletionProtected) add("deletion-protection");
	if (!snapshot.open) add("pr-closed");
	if (!snapshot.nonDraft) add("draft");
	if (snapshot.mergeability === "conflicting") add("merge-conflict");
	if (snapshot.mergeability === "unknown") add("mergeability-unknown");
	return result;
}
function canonicalInstant(value: string): boolean {
	return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function operatorConfirmation(
	snapshot: LandingSnapshot,
	blockers: readonly Blocker[],
	attemptId = "<fresh-uuid>",
	observedAt = "<instruction-observed-at>",
): string {
	return `land ${snapshot.repositoryId}#${snapshot.pullRequestNumber} ${snapshot.headSha} onto ${snapshot.baseRef}@${snapshot.baseSha} despite ${blockers.map((item) => `${item.class}:${item.detail}`).join("|")} attempt ${attemptId} observed ${observedAt}`;
}
export function operatorAuditComment(
	snapshot: LandingSnapshot,
	blockers: readonly Blocker[],
	instruction: OperatorInstruction,
	observedAt: string,
): string {
	return `${OPERATOR_AUDIT_MARKER}\n\n\`\`\`json\n${JSON.stringify({
		schemaVersion: 1,
		repositoryId: snapshot.repositoryId,
		pullRequestId: snapshot.pullRequestId,
		pullRequestNumber: snapshot.pullRequestNumber,
		headSha: snapshot.headSha,
		baseRef: snapshot.baseRef,
		baseSha: snapshot.baseSha,
		instructionScope: instruction.scope === "all-observed" ? "all-observed" : "named",
		observedBlockers: blockers,
		operatorInstructionObservedAt: instruction.operatorInstructionObservedAt,
		writerId: snapshot.operatorId,
		attemptId: instruction.attemptId,
		observedAt,
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
function sameBlockers(a: readonly Blocker[], b: readonly Blocker[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
function mergeResult(
	result: "merged" | "blocked" | "unknown",
	route: "ordinary" | "approval-waiver" | "operator-directed",
): LandingResult {
	return result === "merged"
		? { outcome: "merged", route }
		: { outcome: "refused", arm: result === "unknown" ? "merge-outcome-unknown" : "policy-refusal" };
}
export async function executeLanding(
	input: { mode: MergeMode; snapshot: LandingSnapshot; now: string; instruction?: OperatorInstruction },
	effects: LandingEffects,
): Promise<LandingResult> {
	if (input.mode !== "on") return { outcome: "refused", arm: "merge-mode-off" };
	const snapshot = input.snapshot;
	if (snapshot.predicateOwnership !== "single") return { outcome: "refused", arm: "blocker-population-incomplete" };
	if (!Number.isInteger(snapshot.requiredApprovals) || snapshot.requiredApprovals < 0 || !canonicalInstant(input.now))
		return { outcome: "refused", arm: "blocker-population-incomplete" };
	const blockers = observedBlockers(snapshot);
	if (!snapshot.open || !snapshot.mergeMethodAllowed)
		return { outcome: "refused", arm: "blocker-population-incomplete", blockers };
	if (blockers.length === 0) return mergeResult(await effects.merge("ordinary", snapshot.headSha), "ordinary");
	const approvalOnly = blockers.length === 1 && blockers[0]?.class === "native-approval";
	if (approvalOnly && !input.instruction) {
		const ordinary = await effects.merge("ordinary", snapshot.headSha);
		if (ordinary === "merged") return { outcome: "merged", route: "ordinary" };
		if (ordinary === "unknown") return { outcome: "refused", arm: "merge-outcome-unknown" };
		const label = snapshot.labels.includes(BYPASS_LABEL) ? "present" : await effects.applyLabel(BYPASS_LABEL);
		if (label === "failed" || label === "unknown") return { outcome: "refused", arm: "label-apply-failed" };
		const current = await effects.reread();
		if (!current || !sameOperands(snapshot, current)) return { outcome: "refused", arm: "operand-drift" };
		if (!current.labels.includes(BYPASS_LABEL)) return { outcome: "refused", arm: "label-apply-failed" };
		const currentBlockers = observedBlockers(current);
		if (currentBlockers.length !== 1 || currentBlockers[0]?.class !== "native-approval")
			return { outcome: "refused", arm: "blocker-population-incomplete", blockers: currentBlockers };
		return mergeResult(await effects.merge("approval-waiver", current.headSha), "approval-waiver");
	}
	const instruction = input.instruction;
	if (!instruction) return { outcome: "presented", blockers, confirmation: operatorConfirmation(snapshot, blockers) };
	if (blockers.length === 0) return { outcome: "refused", arm: "instruction-absent" };
	const classes = blockers.map((item) => item.class);
	const selected = instruction.scope === "all-observed" ? classes : [...new Set(instruction.scope)];
	if (selected.length !== classes.length || selected.some((item, index) => item !== classes[index]))
		return { outcome: "refused", arm: "instruction-scope-mismatch", blockers };
	if (
		!UUID.test(instruction.attemptId) ||
		!canonicalInstant(instruction.operatorInstructionObservedAt) ||
		Date.parse(instruction.operatorInstructionObservedAt) > Date.parse(input.now) ||
		instruction.confirmation !==
			operatorConfirmation(snapshot, blockers, instruction.attemptId, instruction.operatorInstructionObservedAt)
	)
		return { outcome: "refused", arm: "instruction-absent", blockers };
	const label = snapshot.labels.includes(BYPASS_LABEL) ? "present" : await effects.applyLabel(BYPASS_LABEL);
	if (label === "failed" || label === "unknown") return { outcome: "refused", arm: "label-apply-failed", blockers };
	const labeled = await effects.reread();
	if (!labeled || !sameOperands(snapshot, labeled)) return { outcome: "refused", arm: "operand-drift", blockers };
	if (!labeled.labels.includes(BYPASS_LABEL)) return { outcome: "refused", arm: "label-apply-failed", blockers };
	if (!sameBlockers(blockers, observedBlockers(labeled)))
		return { outcome: "refused", arm: "blocker-population-incomplete", blockers: observedBlockers(labeled) };
	const comment = operatorAuditComment(snapshot, blockers, instruction, input.now);
	const publication = await effects.comment(comment);
	if (publication !== "published")
		return {
			outcome: "refused",
			arm: publication === "failed" ? "audit-publication-failed" : "audit-publication-ambiguous",
			blockers,
		};
	const comments = await effects.readComments();
	if (!comments) return { outcome: "refused", arm: "audit-publication-ambiguous", blockers };
	const matching = comments.filter((value) => value.body === comment);
	if (matching.length !== 1 || matching[0]?.authorId !== snapshot.operatorId || !Number.isSafeInteger(matching[0]?.id))
		return { outcome: "refused", arm: "audit-population-ambiguous", blockers };
	const current = await effects.reread();
	if (!current || !sameOperands(snapshot, current) || !current.labels.includes(BYPASS_LABEL))
		return { outcome: "refused", arm: "operand-drift", blockers };
	const currentBlockers = observedBlockers(current);
	if (!sameBlockers(blockers, currentBlockers))
		return { outcome: "refused", arm: "blocker-population-incomplete", blockers: currentBlockers };
	return mergeResult(await effects.merge("operator-directed", current.headSha), "operator-directed");
}

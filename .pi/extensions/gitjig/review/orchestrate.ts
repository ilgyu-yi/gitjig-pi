/**
 * The review round driver (issue #184, Directive #183) — ONE composed
 * round of §1.7/§1.9's pipeline at one head:
 *
 *   policy → coverage → panel dispatch (composed briefs) → join →
 *   bundle → findings-free fast path | Judge dispatch (manifest) →
 *   admission → Resolver → the durable review record.
 *
 * What is deliberately NOT here: the repair (the author's act, §1.9);
 * driving successive rounds (the caller's loop — a fresh head draws a
 * fresh required panel, §1.6/§1.7); posting the record (the landed
 * egress boundary's, through whichever call site drives the round);
 * and dispatch mechanics (§4.9's — the driver takes a dispatch
 * function, and `makeDispatcher` is the one wiring to the real
 * dispatcher, so unit arms measure the composition without running a
 * delegate).
 *
 * DECISION — the Judge dispatch is keyed on the brief's own composed
 * subject line ("You are the JUDGE"), which briefs.ts owns as part of
 * its contract; the driver never re-reads a delegate's text to decide
 * what it dispatched — it knows, because it composed it.
 *
 * DECISION — the panel's slots dispatch concurrently. Mutual blindness
 * is the dispatcher's isolation (§1.7: every slot in its own execution
 * context); concurrency here neither adds nor subtracts from it, and a
 * serial loop would only make one round slower.
 */
import { execFileSync } from "node:child_process";
import type { DispatchOutcome, RunDispatchOptions } from "../dispatch/index.ts";
import { runDispatch } from "../dispatch/index.ts";
import { withoutRepoLocatingGitEnv } from "../dispatch/provision.ts";
import { type BriefTiming, composeJudgeBrief, composeReviewerBrief, type ReviewFences } from "./briefs.ts";
import { slotResultFromDispatch } from "./join.ts";
import {
	buildBundle,
	changedPathsFromRepo,
	decideValidity,
	deriveRequiredSlots,
	loadPolicy,
	panelOutcome,
	type SlotResult,
} from "./panel.ts";
import { composeReviewRecord, type ReviewRecord, type SlotRecord } from "./record.ts";
import {
	type AdjudicationInput,
	adjudicationFromDispatch,
	admitAdjudication,
	type Manifest,
	type ReviewState,
	reviewOutcome,
} from "./resolve.ts";

export type RoundOptions = {
	repoRoot: string;
	baseRef: string;
	headRef: string;
	manifest: Manifest;
	fences: ReviewFences;
	changeDescription: string;
	timing?: BriefTiming;
	/**
	 * The one seam to §4.9's dispatcher — `makeDispatcher` for the real
	 * one. The second argument is the round's OWN resolved head, passed
	 * on every dispatch so the panel slots, the Judge, and the record all
	 * carry one pin — round 1's EF7: a seam with no per-dispatch pin let
	 * a mutable ref hand each dispatch a different held hash with every
	 * compare confirming.
	 */
	dispatch: (brief: string, expectedHead: string) => Promise<DispatchOutcome>;
};

export type RoundResult = { review: ReviewState; record: ReviewRecord; recordBody: string };

/**
 * Wire the round to the real dispatcher: one brief in, one outcome
 * back, everything else — provision, isolation, bounded return, blind
 * compare — the dispatcher's own (§4.9).
 */
export function makeDispatcher(
	options: Omit<RunDispatchOptions, "brief" | "expectedRef">,
	// The real dispatcher, injectable so a test can pin the wiring without
	// running a delegate (round 2's EF-A: the pin-forwarding was killed by
	// no arm because runDispatch was a static import nothing could observe).
	run: (options: RunDispatchOptions) => Promise<DispatchOutcome> = runDispatch,
): (brief: string, expectedHead: string) => Promise<DispatchOutcome> {
	// The held operand is the round's resolved head, never a caller-fixed
	// ref: provision resolves the expectedRef once per dispatch, so only a
	// hash already resolved by the round makes every dispatch's pin the
	// same pin (round 1's EF7).
	return (brief, expectedHead) => run({ ...options, brief, expectedRef: expectedHead });
}

/**
 * One composed review round at one head. Throws panel.ts's
 * RoutingRefusal upstream of any dispatch where §1.7 refuses the
 * surface — a routing failure produces no panel state and no brief.
 */
export async function reviewRound(options: RoundOptions): Promise<RoundResult> {
	const policy = loadPolicy();
	const changed = changedPathsFromRepo(options.baseRef, options.headRef, options.repoRoot);
	const required = deriveRequiredSlots(changed, policy);
	// The record's pin is the resolved head, not the caller's spelling of
	// it — §1.6's reviewed-head rule — resolved BEFORE any dispatch so the
	// same hash pins every dispatch of the round. Same env discipline as
	// the changed-path read: an ambient GIT_DIR must not redirect the pin.
	const head = execFileSync("git", ["rev-parse", "--verify", `${options.headRef}^{commit}`], {
		cwd: options.repoRoot,
		encoding: "utf8",
		env: withoutRepoLocatingGitEnv(process.env),
	}).trim();

	const results: SlotResult[] = await Promise.all(
		required.map(async (slot) => {
			const brief = composeReviewerBrief(
				slot,
				{ changeDescription: options.changeDescription },
				options.fences,
				options.timing,
			);
			return slotResultFromDispatch(slot, await options.dispatch(brief, head));
		}),
	);
	const slots: SlotRecord[] = results.map((result) => {
		const ruled = decideValidity(result, result.slot);
		const entry: SlotRecord = { slot: result.slot, valid: ruled.valid };
		if (ruled.reason !== undefined) {
			entry.reason = ruled.reason;
		}
		return entry;
	});
	const panel = panelOutcome(results, required);

	let adjudication: AdjudicationInput | null = null;
	let review: ReviewState;
	if (panel.outcome === "bundle" && options.manifest.state !== "absent") {
		const judgeBrief = composeJudgeBrief(
			panel.bundle,
			options.manifest,
			{ changeDescription: options.changeDescription },
			options.fences,
			options.timing,
		);
		const outcome = await options.dispatch(judgeBrief, head);
		const input = adjudicationFromDispatch(outcome);
		adjudication = input ?? null;
		const admission = input === undefined ? undefined : admitAdjudication(input, options.manifest);
		review = reviewOutcome(panel, admission);
	} else {
		// The findings-free fast path and the incomplete panel: the Judge
		// never runs — nothing to adjudicate on the first, completeness
		// precedes adjudication on the second (§1.7, §1.9). The ABSENT
		// manifest stops here too (round 1's EF4): §1.9 rules it a missing
		// input the review is incomplete on, so a Judge dispatched anyway
		// would be run to rule what the caller already knows cannot
		// complete.
		review = reviewOutcome(panel, undefined);
	}

	const record: ReviewRecord = {
		head,
		slots,
		// From every VALID slot, whatever the panel outcome — §1.7 builds
		// the bundle from valid slots, not from complete panels, and a
		// record that understates what was discovered misleads the history
		// reader (round 1's EF6).
		bundle: buildBundle(results, required),
		adjudication,
		review,
	};
	return { review, record, recordBody: composeReviewRecord(record) };
}

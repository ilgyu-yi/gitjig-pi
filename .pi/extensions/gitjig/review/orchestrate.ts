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
import { createHash } from "node:crypto";
import type { DispatchOutcome, RunDispatchOptions } from "../dispatch/index.ts";
import { runDispatch } from "../dispatch/index.ts";
import { withoutRepoLocatingGitEnv } from "../dispatch/provision.ts";
import {
	type BriefTiming,
	composeJudgeBrief,
	composeReviewerBrief,
	RETURN_PROTOCOL_RETRY_SUFFIX,
	type ReviewFences,
} from "./briefs.ts";
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
import { composeReviewRecord, type ReviewRecord, type RoundSummary, type SlotRecord } from "./record.ts";
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
	 * carry one pin: a seam with no per-dispatch pin would let a mutable
	 * ref hand each dispatch a different held hash with every compare
	 * confirming (issue #184).
	 */
	dispatch: (brief: string, expectedHead: string) => Promise<DispatchOutcome>;
};

export type RoundResult = { review: ReviewState; record: ReviewRecord; recordBody: string };

export type HostAttemptEvent = {
	sequence: number;
	attempt: 1 | 2;
	startedOffsetMs: number;
	finishedOffsetMs: number;
	diagnostic: DispatchOutcome["diagnostic"];
	outcomeDigest: string;
};

const LEDGER = Symbol("recovery-attempt-ledger");
export class HostAttemptLedger {
	readonly [LEDGER] = true;
	readonly #routeT0: number;
	#sequence = 0;

	private constructor(routeT0: number) {
		this.#routeT0 = routeT0;
	}

	static create(routeT0: number): HostAttemptLedger {
		if (!Number.isFinite(routeT0) || routeT0 < 0) throw new TypeError("invalid recovery route epoch");
		return new HostAttemptLedger(routeT0);
	}

	start(): number {
		return Math.max(0, Math.trunc(performance.now() - this.#routeT0));
	}

	append(attempt: 1 | 2, startedOffsetMs: number, outcome: DispatchOutcome): HostAttemptEvent {
		this.#sequence += 1;
		return Object.freeze({
			sequence: this.#sequence,
			attempt,
			startedOffsetMs,
			finishedOffsetMs: Math.max(startedOffsetMs, Math.trunc(performance.now() - this.#routeT0)),
			diagnostic: outcome.diagnostic,
			outcomeDigest: digestOutcome(outcome),
		});
	}
}

export function createRecoveryAttemptLedger(routeT0: number): HostAttemptLedger {
	return HostAttemptLedger.create(routeT0);
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	// biome-ignore lint/style/useTemplate: avoids interpolation in a warning-adjacent module.
	if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
	const record = value as Record<string, unknown>;
	return (
		"{" +
		Object.keys(record)
			.filter((key) => !(key === "message" && Object.hasOwn(record, "code")))
			.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
			// biome-ignore lint/style/useTemplate: avoids interpolation in a warning-adjacent module.
			.map((key) => JSON.stringify(key) + ":" + canonical(record[key]))
			.join(",") +
		"}"
	);
}

function digestOutcome(outcome: DispatchOutcome): string {
	return createHash("sha256")
		.update("gitjig-recovery-dispatch-outcome:v1\n", "ascii")
		.update(canonical(outcome), "utf8")
		.digest("hex");
}

export type ObservedDispatchOutcome = {
	outcome: DispatchOutcome;
	attempts: readonly HostAttemptEvent[];
	retryState: "available" | "spent";
};

type RecoveryAttemptPolicy = {
	attemptPolicy: { beforeRetry: (diagnostic: DispatchOutcome["diagnostic"]) => boolean; ledger: HostAttemptLedger };
};

/**
 * Wire the round to the real dispatcher: one brief in, one outcome
 * back, everything else — provision, isolation, bounded return, blind
 * compare — the dispatcher's own (§4.9).
 *
 * This seam owns the review dispatch retry required by SPEC §1.7;
 * `briefs.ts` owns its caller-composed wording and takes no transport act.
 */
export function makeDispatcher(
	options: Omit<RunDispatchOptions, "brief" | "expectedRef">,
	run: (options: RunDispatchOptions) => Promise<DispatchOutcome>,
	configuration: RecoveryAttemptPolicy,
): (brief: string, expectedHead: string) => Promise<ObservedDispatchOutcome>;
export function makeDispatcher(
	options: Omit<RunDispatchOptions, "brief" | "expectedRef">,
	run?: (options: RunDispatchOptions) => Promise<DispatchOutcome>,
	onEvent?: (event: "retry-return-protocol") => void,
): (brief: string, expectedHead: string) => Promise<DispatchOutcome>;
export function makeDispatcher(
	options: Omit<RunDispatchOptions, "brief" | "expectedRef">,
	run: (options: RunDispatchOptions) => Promise<DispatchOutcome> = runDispatch,
	third?: ((event: "retry-return-protocol") => void) | RecoveryAttemptPolicy,
): (brief: string, expectedHead: string) => Promise<DispatchOutcome | ObservedDispatchOutcome> {
	return async (brief, expectedHead) => {
		const policy = typeof third === "object" ? third.attemptPolicy : undefined;
		const onEvent = typeof third === "function" ? third : undefined;
		const attempts: HostAttemptEvent[] = [];
		let attempt: 1 | 2 = 1;
		const send = async (semanticBrief: string): Promise<DispatchOutcome> => {
			const started = policy?.ledger.start();
			const outcome = await run({ ...options, brief: semanticBrief, expectedRef: expectedHead });
			if (policy !== undefined && started !== undefined) attempts.push(policy.ledger.append(attempt, started, outcome));
			return outcome;
		};
		let retryAvailable = true;
		let outcome = await send(brief);
		while (
			outcome.disposition === "refused" &&
			outcome.diagnostic.run.class === "exited" &&
			Number.isInteger(outcome.diagnostic.run.exitCode) &&
			outcome.diagnostic.return.class === "missing" &&
			retryAvailable
		) {
			retryAvailable = false;
			if (policy !== undefined) {
				let allowed = false;
				try {
					allowed = policy.beforeRetry(outcome.diagnostic);
				} catch {
					allowed = false;
				}
				if (!allowed) break;
			}
			attempt = 2;
			try {
				onEvent?.("retry-return-protocol");
			} catch {
				// Fixture-only observation cannot alter the authorized transport act.
			}
			outcome = await send(brief + RETURN_PROTOCOL_RETRY_SUFFIX);
		}
		if (policy === undefined) return outcome;
		return { outcome, attempts: Object.freeze(attempts.slice()), retryState: retryAvailable ? "available" : "spent" };
	};
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

	// The round's durable prose (issue #203). §1.9's admission burden
	// defaults to RECORD, DO NOT ADMIT and both briefs route such an item
	// to the return's `summary`; on this path nothing read it, so the
	// RECORD half was unrealizable. Collected here, at the one place that
	// holds the DispatchOutcome, and carried VERBATIM into the record.
	//
	// Deliberately NOT threaded through SlotResult: that is §1.7's
	// discovery grammar and feeds validity and the bundle. Prose that
	// entered it would reach decisions no adjudicator made.
	const summaries: RoundSummary[] = [];
	/** An empty summary is nothing to record; a delegate that wrote none gets no entry. */
	const collect = (entry: RoundSummary) => {
		if (entry.text.length > 0) {
			summaries.push(entry);
		}
	};

	const results: SlotResult[] = await Promise.all(
		required.map(async (slot) => {
			const brief = composeReviewerBrief(
				slot,
				{ changeDescription: options.changeDescription },
				options.fences,
				options.timing,
			);
			const outcome = await options.dispatch(brief, head);
			if (outcome.disposition === "admitted") {
				collect({ from: "slot", slot, text: outcome.summary });
			}
			return slotResultFromDispatch(slot, outcome);
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
		if (outcome.disposition === "admitted") {
			collect({ from: "judge", text: outcome.summary });
		}
		const input = adjudicationFromDispatch(outcome);
		adjudication = input ?? null;
		const admission = input === undefined ? undefined : admitAdjudication(input, options.manifest);
		review = reviewOutcome(panel, admission);
	} else {
		// The findings-free fast path and the incomplete panel: the Judge
		// never runs — nothing to adjudicate on the first, completeness
		// precedes adjudication on the second (§1.7, §1.9). The ABSENT
		// manifest stops here too: §1.9 rules it a missing input the review
		// is incomplete on, so a Judge dispatched anyway would be run to
		// rule what the caller already knows cannot complete.
		review = reviewOutcome(panel, undefined);
	}

	const record: ReviewRecord = {
		head,
		slots,
		// From every VALID slot, whatever the panel outcome — §1.7 builds
		// the bundle from valid slots, not from complete panels, and a
		// record that understates what was discovered misleads the history
		// reader (§1.4).
		bundle: buildBundle(results, required),
		adjudication,
		review,
		// Always present on this path, empty where no admitted return wrote
		// prose. The key is optional in the record's shape for records written
		// before it existed, not for rounds this function drives.
		summaries,
	};
	return { review, record, recordBody: composeReviewRecord(record) };
}

/**
 * The dispatch→slot join (issue #177, subsuming issue #173's checklist;
 * Directive #166) — the caller side of §1.6 mapped onto §4.9's dispatcher:
 * the widened `payload` channel's one reader, and the panel's one producer.
 * It enforces §1.6 and §1.7's invalidity causes at the seam; read those
 * sections for what a result owes, and expect comments here to point at a
 * clause rather than restate it (§2.8).
 *
 * DECISION — the payload's encoding is this layer's contract, not the
 * dispatcher's. The dispatcher fixes the slot's TYPE and bound and scans
 * its bytes; what the bytes MEAN is review policy, which Directive #166
 * makes a non-goal inside the dispatcher. The shape is closed —
 * `{ "token": "APPROVED"|"FINDINGS", "findings": string[] }`, unknown keys
 * refused — the same posture `dispatch/admit.ts` takes one layer down,
 * because a minimum-match admits a surface no contract bounds.
 *
 * DECISION — three predicates, three owners (§3.11). The parse here rules
 * STRUCTURE only; §1.6's result grammar (a token contradicting its own
 * findings) stays `decideValidity`'s one branch, so a well-formed
 * contradictory payload passes through and is refused where the grammar
 * lives. A parse that re-ruled it would be a second spelling of the
 * predicate and would collapse two of §1.7's distinguishable causes into
 * one, costing the caller the reason it decides re-dispatch on.
 *
 * DECISION — the refusal-cause mapping is fixed and total. The dispatcher's
 * bound-exceeded class is §1.7's timed-out cause; every other refusal, a
 * delegate-reported failed run (`ok: false`), and any cause this mapping
 * does not know are the malformed cause — no dispatch outcome reaches the
 * panel unmapped, and an unknown future cause degrades to no-result rather
 * than a throw. A refused dispatch records the compare as `"absent"`,
 * because no compare ran: §1.6 names the absent state and rules it invalid,
 * which is what gives it a home here rather than a collapse into
 * `"invalid"`.
 */
import { REFUSAL_CAUSES } from "../dispatch/admit.ts";
import { type DispatchOutcome, type RunDispatchOptions, runDispatch } from "../dispatch/index.ts";
import { type Compare, type ReviewerReturn, receive, type Slot, type SlotResult } from "./panel.ts";

const PAYLOAD_KEYS = new Set(["token", "findings"]);

/**
 * Parse a reviewer's structured result out of the opaque payload slot.
 * Every deviation from the closed shape is §1.7's malformed cause — a
 * value, never a throw, so the cause reaches `decideValidity` as itself.
 */
export function reviewerReturnFromPayload(payload: string | undefined): ReviewerReturn {
	if (typeof payload !== "string") {
		return { failure: "malformed" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return { failure: "malformed" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { failure: "malformed" };
	}
	const keys = Object.keys(parsed);
	if (keys.length !== PAYLOAD_KEYS.size || !keys.every((key) => PAYLOAD_KEYS.has(key))) {
		return { failure: "malformed" };
	}
	const { token, findings } = parsed as { token: unknown; findings: unknown };
	if (token !== "APPROVED" && token !== "FINDINGS") {
		return { failure: "malformed" };
	}
	if (!Array.isArray(findings) || findings.some((finding) => typeof finding !== "string")) {
		return { failure: "malformed" };
	}
	// A grammar contradiction (APPROVED carrying findings, FINDINGS carrying
	// none) passes through deliberately: decideValidity owns that rule.
	return { token, findings: findings as string[] };
}

/**
 * The one mapping from a dispatch outcome to a slot result. Constructed
 * through `receive`, the panel's only result constructor, so everything
 * §1.6 makes the caller's fact — the compare, the copy discipline, the
 * brand — holds for a joined result exactly as for a hand-recorded one.
 */
export function slotResultFromDispatch(slot: Slot, outcome: DispatchOutcome): SlotResult {
	if (outcome.disposition === "refused") {
		const failure = outcome.cause === REFUSAL_CAUSES.boundExceeded ? "timeout" : "malformed";
		return receive(slot, "absent", { failure });
	}
	const compare: Compare = outcome.compare ?? "absent";
	if (!outcome.ok) {
		// The delegate's own failure claim: the payload has no valid producer,
		// and reading it anyway would act on output its author disowned.
		return receive(slot, compare, { failure: "malformed" });
	}
	return receive(slot, compare, reviewerReturnFromPayload(outcome.payload));
}

/**
 * Dispatch one required slot through §4.9's dispatcher and record what
 * came back — the composed caller issue #173 measured as missing. The
 * brief and argv are the caller's (reviewer conduct is not this module's
 * carry); what this function owns is that every outcome shape the
 * dispatcher can produce lands in the panel as a ruled result.
 */
export async function dispatchSlot(slot: Slot, options: RunDispatchOptions): Promise<SlotResult> {
	return slotResultFromDispatch(slot, await runDispatch(options));
}

/* Internal, explicit Pi-mode runner. Generic argv dispatch never reaches
 * this module. The consumer fixes the role before provision; the child is
 * given a trusted scratch tool but never the caller's expected ref/hash.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { type RecoveryPiRole, recoveryPiProfile } from "../recovery/pi-profile.ts";
import { REVIEW_PI_PROFILES, type ReviewPiRole } from "../review/pi-profile.ts";
import { DEFAULT_RUN_BOUND_MS, type DelegateRunOutcome } from "./executor.ts";
import { namesHeldOperand } from "./operand.ts";
import { beginPiOperatorSession } from "./pi-operator.ts";
import { startPiRpc } from "./pi-rpc.ts";
import { provisionPiSubmitTool } from "./pi-submit.ts";
import type { DispatchContext } from "./provision.ts";

export type PiInvocation = {
	piExecutable: string;
	provider: string;
	model: string;
	role: ReviewPiRole | RecoveryPiRole;
	/** Only a measurement result receives this caller-fixed digest. */
	specDigest?: string;
};

export async function runPiDelegate(
	context: DispatchContext,
	invocation: PiInvocation,
	options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<DelegateRunOutcome> {
	const refusal = (className: "abort" | "timeout" | "invalid" | "spawn") => ({
		exitCode: null,
		signal: null,
		timedOut: className === "timeout",
		aborted: className === "abort",
		spawnFailed: className === "spawn",
		protocolInvalid: className === "invalid",
	});
	const profile = Object.hasOwn(REVIEW_PI_PROFILES, invocation.role)
		? REVIEW_PI_PROFILES[invocation.role as ReviewPiRole]
		: recoveryPiProfile(invocation.role as RecoveryPiRole, invocation.specDigest);
	if (profile === undefined || (invocation.role !== "measurement" && invocation.specDigest !== undefined))
		return refusal("invalid");
	if (options.signal?.aborted) return refusal("abort");
	// Caller-authored recovery/history evidence may mention the current head.
	// Do not transfer the held compare operand in the Pi brief; the child can
	// independently resolve its clone HEAD for the trusted tool instead.
	try {
		if (!/^[0-9a-f]{40}$/.test(context.heldHash)) return refusal("invalid");
		const original = readFileSync(context.briefPath, "utf8");
		const redacted = original.replaceAll(new RegExp(context.heldHash, "gi"), "[clone head withheld]");
		// The brief is held to the dispatcher's own ruled scan, not to a second
		// spelling of it: a run this predicate says names the held operand must not
		// reach the child, including a contained run shorter than the 7-prefix
		// (MIN_CONTAINED_RUN, issue #104). Checking only the prefix let a
		// six-character contained run through while the return side refused it.
		if (namesHeldOperand(redacted, context.heldHash)) return refusal("invalid");
		if (redacted !== original) writeFileSync(context.briefPath, redacted);
	} catch {
		return refusal("invalid");
	}
	let session: ReturnType<typeof startPiRpc>;
	const operator = beginPiOperatorSession();
	try {
		const extensionPath = provisionPiSubmitTool(context, profile);
		session = startPiRpc({
			context,
			extensionPath,
			piExecutable: invocation.piExecutable,
			provider: invocation.provider,
			model: invocation.model,
			prompt: "Read ../brief.md; submit your final result with the available submit_result tool.",
			timeoutMs: options.timeoutMs ?? DEFAULT_RUN_BOUND_MS,
			signal: options.signal,
			onOperatorEvent: operator.onEvent,
		});
	} catch {
		operator.end();
		return refusal("spawn");
	}
	operator.bind(session);
	let terminal: Awaited<typeof session.done>;
	try {
		// A settled agent is not an admitted result. Review/recovery orchestration
		// owns its existing single numeric-exit + missing-return retry; a second
		// transport-level continuation here would double that allowance.
		await session.waitForSettle(0);
		session.close();
		terminal = await session.done;
	} finally {
		operator.end();
	}
	if (terminal === "timeout") return refusal("timeout");
	if (terminal === "abort") return refusal("abort");
	if (terminal === "spawn-failed") return refusal("spawn");
	if (terminal === "signaled" && session.exitSignal !== null)
		return {
			exitCode: null,
			signal: session.exitSignal,
			timedOut: false,
			aborted: false,
			spawnFailed: false,
			protocolInvalid: false,
		};
	if ((terminal !== "settled" && terminal !== "exited") || session.exitCode === null) return refusal("invalid");
	// A numeric exit settles the process only. Even without agent_settled, the
	// existing dispatcher inspects the final slot on output validity alone.
	return {
		exitCode: session.exitCode,
		signal: null,
		timedOut: false,
		aborted: false,
		spawnFailed: false,
		protocolInvalid: false,
	};
}

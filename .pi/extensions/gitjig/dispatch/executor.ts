/**
 * Dispatch executor — the delegate-agnostic bounded child (SPEC §4.9;
 * §3.10's outcome classes decided by the caller from this run shape).
 *
 * The delegate is an argv child (never a shell string) with cwd pinned to
 * the provisioned tree; the parent environment passes through with two
 * edits — the repo-locating and config-injection `GIT_*` families
 * (`GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` /
 * `GIT_OBJECT_DIRECTORY` / `GIT_COMMON_DIR`, and
 * `GIT_CONFIG_PARAMETERS` / `GIT_CONFIG_COUNT`) are
 * DELETED, because git resolves those ahead of cwd and an inherited one
 * retargets every delegate git write at the caller repository despite
 * the pinned cwd, or injects arbitrary config into the delegate's git
 * children (§1.5), and the ONE state seam is rebound —
 * `GITJIG_TEST_STATE_ROOT=<scratch>/state`
 * (§5.5's disposable-root carve-out, pointed inside the scratch so the
 * delegate's state dies with the dispatch). Both streams are always drained
 * into §4.9's bounded operator-only trace reducer: retention never pauses a
 * pipe, so a flooding delegate cannot wedge on a kernel buffer, and no trace
 * byte enters the final return, failure, compare, details, or audit channel.
 *
 * Two timers, one phase each (the measured race class this split
 * closes): the kill timer bounds the RUN and is cleared the moment the
 * child exits — an orphaned grandchild can hold the pipes open past the
 * child's death, and a kill timer still armed during the flush grace
 * would mark an in-bound run timed out; from exit the grace timer bounds
 * the FLUSH, deciding from what has arrived when "close" never comes
 * (§5.9's hung-dependency terms). A spawn failure surfaces as
 * `spawnFailed` so the caller can refuse on §3.10's delegate-absent
 * class rather than conflate it with a failed run. The child is spawned
 * detached and the bound kills its whole process group. Named residual
 * (§3.11): a double-forked, re-setsid'd grandchild survives any group
 * kill on this platform and inherits the passthrough environment —
 * named, not claimed closed. The group kill fires on the timeout path
 * alone: a delegate-spawned child surviving a normal exit or a
 * post-spawn error is not group-killed, inherits the passthrough
 * environment, and outlives the scratch's removal. Operator abort sends
 * SIGTERM to the group, escalates to SIGKILL after the stream grace, and a
 * second finite grace settles even if process or pipe teardown never reports.
 */
import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { type DispatchContext, withoutRepoLocatingGitEnv } from "./provision.ts";
import { BoundedDelegateTrace, TRACE_UPDATE_MS, type TraceLifecycle, type TraceSnapshot } from "./trace.ts";

/** Grace for stream flush after exit, when an orphan may hold the pipes. */
const STREAM_GRACE_MS = 2_000;

/** The run bound when the caller names none. */
export const DEFAULT_RUN_BOUND_MS = 120_000;

/**
 * The largest bound this timer can honor. `setTimeout` clamps any delay past
 * the 32-bit signed ceiling to 1 ms, so a bound above it does not run long —
 * it inverts into an immediate kill, and the run is then reported under the
 * bound-exceeded class for a delegate that outlived nothing. The admissible
 * domain is therefore the CONSUMING PRIMITIVE's, not a category list: a caller
 * surface that refuses non-finite values while admitting a value the timer
 * treats identically is drawing the line in the wrong place (issue #94).
 */
export const MAX_RUN_BOUND_MS = 2_147_483_647;

export interface DelegateRunOutcome {
	exitCode: number | null;
	timedOut: boolean;
	aborted: boolean;
	/** True iff the child never started — §3.10's delegate-absent class. */
	spawnFailed: boolean;
}

export interface DelegateRunOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	onTrace?: (snapshot: TraceSnapshot) => void;
}

export function runDelegate(
	context: DispatchContext,
	argv: string[],
	options: DelegateRunOptions = {},
): Promise<DelegateRunOutcome> {
	return new Promise((resolve) => {
		const trace = new BoundedDelegateTrace();
		if (argv.length === 0) {
			resolve({ exitCode: null, timedOut: false, aborted: false, spawnFailed: true });
			return;
		}
		if (options.signal?.aborted) {
			resolve({ exitCode: null, timedOut: false, aborted: true, spawnFailed: false });
			return;
		}
		let settled = false;
		let termination: "none" | "abort" | "timeout" = "none";
		let updateTimer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		let abortEscalation: ReturnType<typeof setTimeout> | undefined;
		let outerTimer: ReturnType<typeof setTimeout> | undefined;
		let abortListener: (() => void) | undefined;
		let releaseChildResources = (): void => {};
		const emitTrace = (lifecycle: TraceLifecycle = "running"): void => {
			updateTimer = undefined;
			try {
				options.onTrace?.(trace.snapshot(lifecycle));
			} catch {
				// Operator presentation is fail-open and cannot decide the run.
			}
		};
		const scheduleTrace = (): void => {
			if (options.onTrace === undefined || updateTimer !== undefined) return;
			updateTimer = setTimeout(() => emitTrace(), TRACE_UPDATE_MS);
		};
		const cleanup = (): void => {
			for (const timer of [updateTimer, killTimer, graceTimer, abortEscalation, outerTimer]) {
				if (timer !== undefined) clearTimeout(timer);
			}
			updateTimer = undefined;
			killTimer = undefined;
			graceTimer = undefined;
			abortEscalation = undefined;
			outerTimer = undefined;
			if (abortListener !== undefined) options.signal?.removeEventListener("abort", abortListener);
		};
		const lifecycleOf = (outcome: DelegateRunOutcome): TraceLifecycle => {
			if (outcome.timedOut) return "timed-out";
			if (outcome.aborted) return "aborted";
			if (outcome.spawnFailed) return "spawn-failed";
			return outcome.exitCode === 0 ? "completed" : "failed";
		};
		const settle = (outcome: DelegateRunOutcome): void => {
			if (settled) return;
			settled = true;
			cleanup();
			releaseChildResources();
			trace.finish();
			emitTrace(lifecycleOf(outcome));
			resolve(outcome);
		};
		// Passthrough with the repo-locating and config-injection GIT_*
		// families deleted — the one shared scrub provision's own git
		// children ride too (§1.5) — and the one state seam rebound (§5.5);
		// nothing else is edited.
		const env = withoutRepoLocatingGitEnv(process.env);
		env.GITJIG_TEST_STATE_ROOT = context.stateDir;
		// Typed from the `stdio` tuple below rather than as the general
		// `spawn` return: both streams are pipes by that argument, so the
		// drain below reaches a stream the type system knows exists. The
		// general return admits `null` on either, and the two repairs that
		// admits — an optional call, or an assertion — would both let a
		// future edit of `stdio` silently stop draining while still compiling.
		let child: ChildProcessByStdio<null, Readable, Readable>;
		try {
			child = spawn(argv[0], argv.slice(1), {
				cwd: context.treeDir,
				// Detached: the child leads its own process group, so the bound's
				// kill reaches delegate-spawned children too, not the child alone.
				detached: true,
				env,
				stdio: ["ignore", "pipe", "pipe"] as const,
			});
		} catch {
			// A synchronous spawn throw (an empty or NUL-bearing argv entry the
			// tool-surface guard admits): nothing started, no timer is armed
			// yet, and the outcome settles into §3.10's delegate-absent class —
			// a raw rejection would escape the closed refusal taxonomy.
			settle({ exitCode: null, timedOut: false, aborted: false, spawnFailed: true });
			return;
		}
		releaseChildResources = () => {
			// A grace or watchdog settlement may precede `close` when an orphan
			// holds the inherited pipes. Stop those handles from keeping the host
			// alive after the bounded promise has settled.
			child.stdout.destroy();
			child.stderr.destroy();
			child.unref();
		};
		let spawned = false;
		child.on("spawn", () => {
			spawned = true;
			// The explicit start update makes a silent long-running delegate
			// visible before its first byte arrives (§4.9).
			emitTrace("running");
		});
		const killGroup = (signal: NodeJS.Signals): void => {
			if (typeof child.pid === "number") {
				try {
					process.kill(-child.pid, signal);
				} catch {
					child.kill(signal);
				}
			} else child.kill(signal);
		};
		const armOuter = (): void => {
			if (outerTimer !== undefined) return;
			outerTimer = setTimeout(() => {
				killGroup("SIGKILL");
				settle({
					exitCode: null,
					timedOut: termination === "timeout",
					aborted: termination === "abort",
					spawnFailed: false,
				});
			}, STREAM_GRACE_MS * 2);
		};
		const abort = (): void => {
			if (settled || termination !== "none") return;
			termination = "abort";
			killGroup("SIGTERM");
			abortEscalation = setTimeout(() => killGroup("SIGKILL"), STREAM_GRACE_MS);
			armOuter();
		};
		abortListener = abort;
		options.signal?.addEventListener("abort", abort, { once: true });
		killTimer = setTimeout(() => {
			if (settled || termination !== "none") return;
			termination = "timeout";
			killGroup("SIGKILL");
			armOuter();
		}, options.timeoutMs ?? DEFAULT_RUN_BOUND_MS);
		const decide = (code: number | null): void => {
			settle({
				exitCode: code,
				timedOut: termination === "timeout",
				aborted: termination === "abort",
				spawnFailed: false,
			});
		};
		child.on("error", () => {
			// Delegate-absent iff the child never started: a post-spawn error
			// is a run that ran, decided as a failed run, never as absence.
			settle({
				exitCode: null,
				timedOut: termination === "timeout",
				aborted: termination === "abort",
				spawnFailed: !spawned,
			});
		});
		// Always drained. Retention is bounded and never applies backpressure.
		child.stdout.on("data", (chunk: Buffer) => {
			trace.consume("stdout", chunk);
			scheduleTrace();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			trace.consume("stderr", chunk);
			scheduleTrace();
		});
		child.on("exit", (code) => {
			// The bound is on the child's run, which has just ended — cleared
			// here: an orphan can hold the pipes past the bound, and a kill timer
			// still armed during the flush grace would mark an in-bound run timed
			// out. From here the grace timer bounds the flush alone.
			if (killTimer !== undefined) clearTimeout(killTimer);
			killTimer = undefined;
			graceTimer = setTimeout(() => decide(code), STREAM_GRACE_MS);
		});
		child.on("close", (code) => decide(code));
	});
}

/**
 * Egress publish executor — the bounded child under the Clean disposition
 * (SPEC §3.3; §3.10's five outcome classes; postures
 * `egress-publish-executor` and `egress-publish-outcome`).
 *
 * The child is `gh`, argv-composed (never a shell string), the body on
 * stdin (`--body-file -`, never an argv byte), cwd pinned to the
 * runtime's own repository root — `gh` resolves the target repository
 * from cwd, so an ambient cwd retargets the publication (§4.6) — the
 * environment passed through, and the run time-bounded.
 *
 * Admission is keyed on output validity alone (§3.10): success exactly
 * when the child exits 0 with a comment-URL shape as the whole of its
 * trimmed stdout. Exit status admits nothing by itself, and no presence
 * probe runs. A zero-exit run without that shape is post-send ambiguity —
 * the send left the process and no valid outcome can be established — and
 * lands the `outcome-unverified` terminal outcome, claiming neither
 * publication nor withholding (§5.6). A spawn failure, a non-zero exit,
 * and an exceeded bound each refuse admission with a fixed content-free
 * cause. No child stream bytes ever enter a returned cause: the streams
 * can echo request bodies (§3.3's Clean clause), so stderr is drained
 * unrecorded and stdout is consulted only by the anchored shape test —
 * the one surface a validated success URL may cross on.
 *
 * The settle logic never waits on stream EOF alone: an orphaned
 * grandchild can hold the pipes open past the child's death (the hanging
 * shape), so the exit event starts a short flush grace and the outcome is
 * decided from what has arrived — a wedge becomes a bounded refusal,
 * never a wedged session (§5.9's hung-dependency terms).
 *
 * Two timers, one phase each. The kill timer bounds the RUN and is cleared
 * the moment the child exits — an orphan can hold the pipes past that exit,
 * and a kill timer still armed during the flush grace would mark an in-bound
 * run TIMED OUT, refusing a send that succeeded, which is the false
 * withholding §5.6 forbids. From exit, the grace timer bounds the FLUSH.
 * The kill reaches the child's whole process GROUP, so a gh-spawned
 * grandchild dies with it rather than surviving to hold the pipes.
 *
 * Named residuals, in place (§3.11), each a consequence of how far the kill
 * reaches rather than a claim it reaches everywhere:
 *
 *   - A double-forked, re-setsid'd grandchild leaves the group and survives
 *     any group kill on this platform. Named, not claimed closed.
 *   - The group kill fires on the timeout path alone. A gh-spawned child
 *     surviving a normal exit, or a post-error one, is not group-killed and
 *     outlives this call.
 *   - SIGKILL is delivered, never guaranteed to be REAPED: a child in an
 *     uninterruptible wait emits no `exit`. The outer backstop bounds the
 *     CALL in that case rather than the child — the promise settles on the
 *     bound-exceeded cause and this side of the pipes is released, and the
 *     unreaped child outlives the session. So the bounded-refusal claim
 *     above is a claim about this tool call, never about the child.
 */
import { spawn } from "node:child_process";

/** The structured publish target — the actor names it, nothing infers it (§3.3). */
export interface PublishDestination {
	kind: "issue-comment" | "pr-comment";
	number: number;
}

/** Structural admission for a destination that arrived untyped. */
export function isPublishDestination(value: unknown): value is PublishDestination {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const { kind, number } = value as { kind?: unknown; number?: unknown };
	return (
		(kind === "issue-comment" || kind === "pr-comment") &&
		typeof number === "number" &&
		Number.isSafeInteger(number) &&
		number > 0
	);
}

/** The destination union's pinned argv spelling (§3.3's measurement domain). */
export function ghCommentArgv(destination: PublishDestination): string[] {
	const surface = destination.kind === "issue-comment" ? "issue" : "pr";
	return [surface, "comment", String(destination.number), "--body-file", "-"];
}

/** The child's bound — well under any caller's own backstop (§3.3). */
export const CHILD_TIMEOUT_MS = 10_000;

/** Grace for stream flush after exit, when an orphan may hold the pipes. */
const STREAM_GRACE_MS = 2_000;

/** Output validity: one comment-URL, the whole of the trimmed stdout (§3.10). */
const COMMENT_URL_SHAPE = /^https:\/\/[^\s]+#issuecomment-\d+$/;

export type PublishChildOutcome =
	| { outcome: "published"; url: string }
	| { outcome: "outcome-unverified" }
	| { outcome: "refused"; cause: string };

/**
 * Run one bounded publish child and admit its outcome per the header.
 * Every returned `cause` is a fixed composition over numbers and signal
 * names — never a stream byte, never an error message.
 */
export function runPublishChild(argv: string[], body: string, repoRoot: string): Promise<PublishChildOutcome> {
	return new Promise((resolve) => {
		let settled = false;
		let timedOut = false;
		let stdout = "";
		const child = spawn("gh", argv, {
			cwd: repoRoot,
			// Detached: the child leads its own process group, so the bound's
			// kill reaches gh-spawned children too, not the direct child alone
			// — a wedged grandchild otherwise survives the kill and holds the
			// pipes (issue #85). The same treatment the dispatch executor's
			// sibling child already takes; nothing about the piped stdin this
			// child reads its body from makes that treatment inapplicable here.
			detached: true,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const settle = (outcome: PublishChildOutcome): void => {
			if (settled) {
				return;
			}
			settled = true;
			// Release this side of the pipes: an orphan holding the far ends
			// must not hold this process open after the outcome is decided.
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
			resolve(outcome);
		};
		let unkillableTimer: ReturnType<typeof setTimeout> | undefined;
		const killTimer = setTimeout(() => {
			timedOut = true;
			// The whole process group, so a gh-spawned grandchild dies with it.
			// The negative-pid kill throws where the group is already gone or
			// was never formed; the direct-child kill is the fallback.
			if (typeof child.pid === "number") {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			} else {
				child.kill("SIGKILL");
			}
			// The outer backstop. SIGKILL is delivered, never guaranteed to be
			// REAPED: a child wedged in an uninterruptible wait emits no
			// `exit`, and without this the awaited promise never settles and
			// the tool call wedges — against this module's own bounded-refusal
			// claim. Decide from what has arrived instead of waiting forever.
			unkillableTimer = setTimeout(() => decide(null, "SIGKILL"), STREAM_GRACE_MS);
		}, CHILD_TIMEOUT_MS);
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const decide = (code: number | null, signal: string | null): void => {
			clearTimeout(killTimer);
			if (graceTimer !== undefined) {
				clearTimeout(graceTimer);
			}
			if (unkillableTimer !== undefined) {
				clearTimeout(unkillableTimer);
			}
			if (timedOut) {
				settle({
					outcome: "refused",
					cause: `the publish child exceeded its ${CHILD_TIMEOUT_MS} ms bound and was terminated; the send is not admitted`,
				});
			} else if (code === 0) {
				const line = stdout.trim();
				if (COMMENT_URL_SHAPE.test(line)) {
					settle({ outcome: "published", url: line });
				} else {
					settle({ outcome: "outcome-unverified" });
				}
			} else {
				settle({
					outcome: "refused",
					cause: `the delegated run reported failure (${code !== null ? `exit status ${code}` : `signal ${signal ?? "unknown"}`})`,
				});
			}
		};
		child.on("error", () => {
			clearTimeout(killTimer);
			settle({
				outcome: "refused",
				cause: "the publish delegate could not be run from this session's environment; the send never started",
			});
		});
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		// Drained, never recorded (§3.3's stream exclusion).
		child.stderr.resume();
		// A child that never reads its stdin surfaces here as EPIPE; the
		// outcome is decided by the exit path, not the write.
		child.stdin.on("error", () => {});
		child.stdin.end(body);
		child.on("exit", (code, signal) => {
			// The bound is on the child's run, which has just ended — clear it
			// here, not in `decide`: an orphan can hold the pipes past the
			// bound, and a kill timer still armed during the flush grace would
			// mark an in-bound run timed out. A child that never exits still
			// trips the kill timer. From here the grace timer bounds the flush.
			clearTimeout(killTimer);
			// Streams may still be flushing; "close" decides as soon as they
			// end, and the grace decides when an orphan never lets them end.
			graceTimer = setTimeout(() => decide(code, signal), STREAM_GRACE_MS);
		});
		child.on("close", (code, signal) => decide(code, signal));
	});
}

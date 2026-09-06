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
 * Named residuals, in place (§3.11). The first three are consequences of how
 * far the kill reaches, rather than a claim it reaches everywhere; the last
 * runs the other way, and is a reach this change GAVE UP:
 *
 *   - A double-forked, re-setsid'd grandchild leaves the group and survives
 *     any group kill on this platform. Named, not claimed closed.
 *   - The group kill fires on the timeout path alone. A gh-spawned child
 *     surviving a normal exit, or a post-error one, is not group-killed and
 *     outlives this call.
 *   - SIGKILL is delivered, never guaranteed to be REAPED: a child in an
 *     uninterruptible wait emits no `exit`. The outer backstop bounds the
 *     CALL in that case rather than the child — the promise settles on the
 *     bound-exceeded cause, this side of the pipes is released, and the
 *     handle is unref'd so the unreaped child cannot hold this process open
 *     either. It outlives the call, and outlives the session if the session
 *     ends first. So the bounded-refusal claim above is a claim about this
 *     tool call, never about the child.
 *
 *   - Detaching runs the OTHER WAY too, and this residual is on that axis
 *     rather than on how far the kill reaches. `detached` starts a new
 *     session with no controlling terminal, so terminal-generated signals —
 *     an operator's interrupt, a hangup when the terminal closes — no longer
 *     reach the child; before it, they did. An operator interrupting a
 *     publish used to take `gh` down with the parent, usually before the
 *     request left the machine. Now the parent dies and the child runs to
 *     completion, so the comment can land after the operator tried to stop
 *     it, with the parent gone and nothing left to record it. The window for
 *     an unrecorded send widens from the in-flight moment to the child's
 *     whole lifetime. Not closed here: an in-flight send cannot be unsent,
 *     and a parent-side handler that group-kills on every signal is a
 *     larger decision than this bound. Named so the reach this change added
 *     is not read as strictly more containment than before.
 */
import { spawn } from "node:child_process";

/**
 * Every publication kind this gate reaches (issue #120). The list is
 * EXPORTED and the suite enumerates it, so a kind added here without an
 * admission rule or an argv spelling reds rather than publishing unchecked.
 *
 * Comments were once the whole union while the shell also created issues
 * and pull requests and edited their bodies — the same guarded act, with no
 * reach, publishing unscanned past a class whose backstop §3.3 records as
 * structurally unavailable.
 */
export const PUBLISH_DESTINATION_KINDS = [
	"issue-comment",
	"pr-comment",
	"issue-body",
	"pr-body",
	"issue-create",
	"pr-create",
] as const;

export type PublishDestinationKind = (typeof PUBLISH_DESTINATION_KINDS)[number];

/** A comment's own url — the shape only the comment verbs print. */
const COMMENT_URL_SHAPE = /^https:\/\/[^\s]+#issuecomment-\d+$/;
/** An issue or pull-request url — what the create and edit verbs print. */
const SURFACE_URL_SHAPE = /^https:\/\/[^\s]+\/(?:issues|pull)\/\d+$/;

/**
 * ONE table keyed by kind (§3.11's one-home rule). Every property that
 * varies by kind lives here: which operand identifies the target, the `gh`
 * noun and verb, and the shape a SUCCESSFUL run prints.
 *
 * Three separate lists — a numbered set, a create set, and a pair of
 * derivations over the kind string — is three places to forget a kind. The
 * derivation form was worse than redundant: reading the noun from a
 * `startsWith` and the verb from an `endsWith` made the argv builder TOTAL
 * over any string, so a future `issue-close` would fall through to the
 * `comment` verb and silently post a comment instead of doing the act it
 * names. An unmapped kind now has no entry and refuses.
 */
interface KindSpec {
	noun: "issue" | "pr";
	verb: "comment" | "edit" | "create";
	/** Which operand names the target. */
	target: "number" | "title";
	/** Output validity for THIS kind — admitted on shape alone (§3.10). */
	successShape: RegExp;
}

const KIND_SPECS: Readonly<Record<PublishDestinationKind, KindSpec>> = {
	"issue-comment": { noun: "issue", verb: "comment", target: "number", successShape: COMMENT_URL_SHAPE },
	"pr-comment": { noun: "pr", verb: "comment", target: "number", successShape: COMMENT_URL_SHAPE },
	"issue-body": { noun: "issue", verb: "edit", target: "number", successShape: SURFACE_URL_SHAPE },
	"pr-body": { noun: "pr", verb: "edit", target: "number", successShape: SURFACE_URL_SHAPE },
	"issue-create": { noun: "issue", verb: "create", target: "title", successShape: SURFACE_URL_SHAPE },
	"pr-create": { noun: "pr", verb: "create", target: "title", successShape: SURFACE_URL_SHAPE },
};

/** The spec for a kind, or `undefined` where the kind is unmapped. */
export function specForKind(kind: string): KindSpec | undefined {
	return Object.hasOwn(KIND_SPECS, kind) ? KIND_SPECS[kind as PublishDestinationKind] : undefined;
}

/** True where this kind's published operands include a title. */
export function kindCarriesTitle(kind: string): boolean {
	return specForKind(kind)?.target === "title";
}

/** The structured publish target — the actor names it, nothing infers it (§3.3). */
export interface PublishDestination {
	kind: PublishDestinationKind;
	/** Required for the numbered kinds; absent on the create kinds. */
	number?: number;
	/** Required for the create kinds; absent on the numbered kinds. */
	title?: string;
}

/**
 * A title is published text in ARGUMENT position, unlike the body, which
 * reaches `gh` on stdin. Three refusals follow from that difference and
 * from nothing else: an option-shaped title would be parsed as a flag
 * rather than a value; a newline makes it not a title; and a NUL cannot
 * cross the exec boundary intact. Each costs a spelling nobody needs and
 * fails toward the block (§3.9's ambiguity rule).
 */
function isAdmissibleTitle(title: unknown): title is string {
	return (
		typeof title === "string" &&
		title.trim().length > 0 &&
		!title.startsWith("-") &&
		!/[\n\r\0]/.test(title)
	);
}

/** Structural admission for a destination that arrived untyped. */
export function isPublishDestination(value: unknown): value is PublishDestination {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const { kind, number, title } = value as { kind?: unknown; number?: unknown; title?: unknown };
	if (typeof kind !== "string") {
		return false;
	}
	// An unmapped kind is inadmissible rather than defaulted: a gate that
	// guessed a surface would publish somewhere the actor did not name.
	const spec = specForKind(kind);
	if (spec === undefined) {
		return false;
	}
	if (spec.target === "number") {
		return typeof number === "number" && Number.isSafeInteger(number) && number > 0;
	}
	return isAdmissibleTitle(title);
}

/**
 * The destination union's pinned argv spelling (§3.3's measurement domain).
 *
 * Every spelling ends `--body-file -`, so the body reaches `gh` on stdin
 * and never in argv: an argv-borne body is visible in the process table and
 * can exceed the argument limit. The title has no such route — `gh` takes
 * it as an argument — which is why admission constrains its shape above.
 */
export function ghPublishArgv(destination: PublishDestination): string[] {
	const spec = specForKind(destination.kind);
	if (spec === undefined) {
		// Unreachable through the tool, which admits first. Throwing rather
		// than defaulting keeps the builder NON-total: a kind with no spec
		// has no argv, instead of quietly acquiring the wrong verb.
		throw new Error("publish: no argv spelling is mapped for this destination kind");
	}
	const tail = ["--body-file", "-"];
	if (spec.target === "title") {
		return [spec.noun, spec.verb, "--title", String(destination.title), ...tail];
	}
	return [spec.noun, spec.verb, String(destination.number), ...tail];
}

/** @deprecated Retained call-site spelling; `ghPublishArgv` is the one predicate. */
export const ghCommentArgv = ghPublishArgv;

/** The child's bound — well under any caller's own backstop (§3.3). */
export const CHILD_TIMEOUT_MS = 10_000;

/** Grace for stream flush after exit, when an orphan may hold the pipes. */
const STREAM_GRACE_MS = 2_000;

/** Output validity: one comment-URL, the whole of the trimmed stdout (§3.10). */

export type PublishChildOutcome =
	| { outcome: "published"; url: string }
	| { outcome: "outcome-unverified" }
	| { outcome: "refused"; cause: string };

/**
 * Run one bounded publish child and admit its outcome per the header.
 * Every returned `cause` is a fixed composition over numbers and signal
 * names — never a stream byte, never an error message.
 */
export function runPublishChild(
	argv: string[],
	body: string,
	repoRoot: string,
	successShape: RegExp,
): Promise<PublishChildOutcome> {
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
			// Destroying this side of the pipes does NOT release the child
			// handle: it holds this process's event loop open until the child
			// exits. Measured — a settled call still held the loop for the
			// child's full remaining 30s. In the one case the backstop below
			// exists for, that child never exits, so without this the wedge
			// would move from the tool call to the session's own exit rather
			// than being closed. The exit and close handlers still run if the
			// child ever dies; decide no-ops behind the settled guard.
			child.unref();
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
				if (successShape.test(line)) {
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
			if (graceTimer !== undefined) {
				clearTimeout(graceTimer);
			}
			if (unkillableTimer !== undefined) {
				clearTimeout(unkillableTimer);
			}
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
			// A late exit after the backstop already settled the call must not
			// arm a fresh timer on a finished call.
			if (settled) {
				return;
			}
			// Streams may still be flushing; "close" decides as soon as they
			// end, and the grace decides when an orphan never lets them end.
			graceTimer = setTimeout(() => decide(code, signal), STREAM_GRACE_MS);
		});
		child.on("close", (code, signal) => decide(code, signal));
	});
}

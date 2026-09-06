/**
 * Executor/outcome suite for the egress publish instrument's bounded child
 * (issue #83 AC1, AC6; SPEC §3.3 "Clean" disposition + outcome-unverified;
 * §3.10's five outcome classes; postures `egress-publish-executor` and
 * `egress-publish-outcome`).
 *
 * Same hermetic shape as `egress-publish.integration.test.ts`, with
 * MISBEHAVING `gh` shims: absent (a curated PATH carrying everything the
 * run needs except gh — the minimal symlink set pi/git/node/sh/bash/env,
 * measured sufficient on this substrate 2026-09-05), a failed run, junk
 * output, a hostile stdin-echoing child, the payload on the wrong stream,
 * and a hanging child. Every instrument arm is RED until the Code phase
 * registers `gitjig_publish` — each arm's first assertion is the authored
 * subject-absence anchor (the substrate's "Tool … not found" stand-in).
 *
 * AUTHORED PHASE-C CONTRACT (beyond the sibling suite's): success is keyed
 * on output VALIDITY — a comment-URL shape on the child's stdout — never
 * exit status or a presence probe (§3.10); every non-success outcome lands
 * an `"category":"egress"` audit record that excludes the child's streams;
 * junk output after the child consumed the body is post-send ambiguity and
 * reports the `outcome-unverified` token, claiming neither publication nor
 * withholding (§5.6); the child runs with its cwd pinned to the runtime's
 * own repository root (§4.6 — never the ambient cwd); the child is
 * time-bounded well under this suite's 60s arm timeout.
 *
 * WHAT THIS SUITE DOES NOT ESTABLISH. The shims prove the executor's
 * admission discipline against the shim's contract, never real `gh`
 * behavior — the URL-shape key is the shim's promise, and a real `gh`
 * whose output drifts lands in `outcome-unverified`, which is exactly the
 * disposition this suite pins for that shape. "No child-stream bytes in
 * any failure record" is asserted lexically on the audit trail and the
 * toolResult entries; the assistant toolCall-args entry is §3.3's
 * enumerated residual and excluded. The five §3.10 classes are staged by
 * outcome shape, not by cause: which syscall failed inside the shim is not
 * measured, only what the executor admitted.
 *
 * Mutants, both directions: the success direction (valid URL on stdout →
 * published) is pinned by the sibling suite's AC3 arm; every arm here is
 * the refuse direction, so an executor keyed on exit status alone reddens
 * at the junk/echo/wrong-stream arms and one keyed on presence alone
 * reddens at the absent arm.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	buildFixture,
	type Fixture,
	type PiRunResult,
	readAuditLines,
	readSessionEntries,
	removeFixture,
	repoRoot,
	runPi,
} from "./harness/run-pi.ts";

const TOOL = "gitjig_publish";
const SUBSTRATE_NOT_FOUND = /Tool gitjig_publish not found/;
/** The success-claim shape no failure record or result may carry. */
const SUCCESS_URL_TOKEN = "issuecomment-";
const SHIM_URL = "https://github.com/zqowner/zqrepo/issues/5#issuecomment-987654321";

/** Distinctive payload + stream markers (byte-absence assertions). */
const EXEC_PAYLOAD = "ZQEXECPAYLOAD";
const EXEC_BODY = "zqexec publish body carrying " + EXEC_PAYLOAD + "\n";
const STREAM_MARKER = "ZQCHILDSTREAM";

function redUntilRegistered(arm: string): string {
	return (
		`${arm}: red until the Code phase registers the ${TOOL} tool (issue #83; SPEC §3.3's egress ` +
		`home slot) — the scripted toolCall reached no handler and the substrate answered for the missing tool`
	);
}

// ---------------------------------------------------------------------------
// Substrate.
// ---------------------------------------------------------------------------

interface ExecutorRun {
	fixture: Fixture;
	result: PiRunResult;
	sinkDir: string;
}

const SCRIPT = [
	{ kind: "toolCall" as const, name: TOOL, arguments: { body: EXEC_BODY, destination: { kind: "issue-comment", number: 5 } } },
	{ kind: "text" as const, text: "EGRESS_EXEC_DONE" },
];

/** Fixture with a shim whose body is `shim` (sh, `$SINK` bound), on a prepended PATH. */
async function runWithShim(shim: string, timeoutMs?: number): Promise<ExecutorRun> {
	const fixture = buildFixture({ script: SCRIPT, linkGitjigRuntime: true });
	const binDir = join(fixture.root, "bin");
	const sinkDir = join(fixture.root, "sink");
	mkdirSync(binDir);
	mkdirSync(sinkDir);
	const shimPath = join(binDir, "gh");
	writeFileSync(shimPath, `#!/bin/sh\nSINK='${sinkDir}'\n${shim}`);
	chmodSync(shimPath, 0o755);
	const result = await runPi(fixture, {
		env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
		timeoutMs: timeoutMs ?? 90_000,
	});
	return { fixture, result, sinkDir };
}

/** Fixture on a curated PATH that resolves everything the run needs EXCEPT gh. */
async function runWithoutGh(): Promise<ExecutorRun> {
	const fixture = buildFixture({ script: SCRIPT, linkGitjigRuntime: true });
	const binDir = join(fixture.root, "bin-nogh");
	const sinkDir = join(fixture.root, "sink");
	mkdirSync(binDir);
	mkdirSync(sinkDir);
	for (const tool of ["pi", "git", "node", "sh", "bash", "env"]) {
		const real = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
		symlinkSync(real, join(binDir, tool));
	}
	const result = await runPi(fixture, { env: { PATH: binDir }, timeoutMs: 90_000 });
	return { fixture, result, sinkDir };
}

function diagnostics(result: PiRunResult): string {
	return `pi ${result.piVersion} exit=${result.exitCode} timedOut=${result.timedOut}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
}

interface ToolResultMessage {
	role: string;
	toolName?: string;
	isError?: boolean;
	content?: Array<{ type: string; text?: string }>;
}

function publishResults(fixture: Fixture): ToolResultMessage[] {
	return readSessionEntries(fixture)
		.map((entry) => (entry as { message?: ToolResultMessage }).message)
		.filter(
			(message): message is ToolResultMessage =>
				message !== undefined && message.role === "toolResult" && message.toolName === TOOL,
		);
}

function textOf(message: ToolResultMessage): string {
	return (message.content ?? []).map((part) => part.text ?? "").join("\n");
}

function requireOwnResult(run: ExecutorRun, arm: string): ToolResultMessage {
	const results = publishResults(run.fixture);
	assert.equal(results.length, 1, `${arm}: expected exactly one ${TOOL} toolResult\n${diagnostics(run.result)}`);
	const own = results[0];
	assert.ok(!SUBSTRATE_NOT_FOUND.test(textOf(own)), redUntilRegistered(arm));
	return own;
}

function auditLines(run: ExecutorRun): string[] {
	return existsSync(run.fixture.auditFile) ? readAuditLines(run.fixture) : [];
}

function egressAuditLines(run: ExecutorRun): string[] {
	return auditLines(run).filter((line) => line.includes('"category":"egress"'));
}

/** No success claim: the comment-URL shape on neither the result nor the egress records. */
function assertNoSuccessClaim(run: ExecutorRun, arm: string): void {
	for (const message of publishResults(run.fixture)) {
		assert.ok(
			!textOf(message).includes(SUCCESS_URL_TOKEN),
			`${arm}: the tool's result carries the comment-URL success shape for a run §3.10 refuses admission`,
		);
	}
	for (const line of egressAuditLines(run)) {
		assert.ok(
			!line.includes(SUCCESS_URL_TOKEN),
			`${arm}: an egress record carries the success URL for a refused admission (§3.10)`,
		);
	}
}

/** Child-stream exclusion (§3.3's Clean clause): marker and payload bytes reach no record. */
function assertStreamsExcluded(run: ExecutorRun, arm: string): void {
	for (const guarded of [STREAM_MARKER, EXEC_PAYLOAD]) {
		for (const message of publishResults(run.fixture)) {
			assert.ok(
				!JSON.stringify(message).includes(guarded),
				`${arm}: child-stream bytes ('${guarded}') reached the tool's result — a failure record must exclude ` +
					`the child's streams, which can echo request bodies (§3.3)`,
			);
		}
		for (const line of auditLines(run)) {
			assert.ok(!line.includes(guarded), `${arm}: child-stream bytes ('${guarded}') reached the audit trail (§3.3)`);
		}
	}
}

// ---------------------------------------------------------------------------
// Runs.
// ---------------------------------------------------------------------------

let absentRun: ExecutorRun;
let failedRun: ExecutorRun;
let junkRun: ExecutorRun;
let echoRun: ExecutorRun;
let wrongStreamRun: ExecutorRun;
let hangingRun: ExecutorRun;
let orphanLateRun: ExecutorRun;
let groupKillRun: ExecutorRun;

before(async () => {
	absentRun = await runWithoutGh();
	// Failed run: consumes the body, echoes it (marker-tagged) on BOTH
	// streams — the §3.3 hazard verbatim — records its cwd, exits non-zero.
	failedRun = await runWithShim(
		'body=$(cat)\npwd >> "$SINK/gh-cwd"\n' +
			`printf '${STREAM_MARKER}OUT %s\\n' "$body"\n` +
			`printf '${STREAM_MARKER}ERR %s\\n' "$body" >&2\n` +
			"exit 1\n",
	);
	// Junk output after consuming the body: exit 0, no comment-URL shape —
	// the post-send-ambiguity shape (§3.3's outcome-unverified).
	junkRun = await runWithShim('cat > "$SINK/gh-consumed"\nprintf \'zqjunk output with no comment url\\n\'\nexit 0\n');
	// Hostile echo: the child prints the request body back as its output.
	echoRun = await runWithShim(`printf '${STREAM_MARKER}ECHO '\ncat\nexit 0\n`);
	// Payload on the wrong stream: a well-formed URL, but on stderr.
	wrongStreamRun = await runWithShim(`cat > "$SINK/gh-consumed"\nprintf '%s\\n' '${SHIM_URL}' >&2\nexit 0\n`);
	// Hanging child: never reads stdin, sleeps past the executor's bound.
	// The arm's own 60s timeout is the backstop that turns a wedge into a
	// measured failure instead of a wedged suite.
	hangingRun = await runWithShim("sleep 120\n", 60_000);
	// The race the exit-handler's timer clear repairs. The child exits WELL
	// INSIDE its bound but LATE — past (bound - flush grace) — while an
	// orphaned grandchild holds the pipes open past that exit, so "close"
	// never comes and the outcome is decided by the flush grace. With the
	// kill timer still armed across that grace, the bound elapses before the
	// grace decides and an in-bound run is marked timed out: a refusal for a
	// send that succeeded, which is the false-withholding direction §5.6
	// forbids. The URL is on stdout, so the only correct outcome is published.
	orphanLateRun = await runWithShim(
		"sleep 30 &\n" + "sleep 9\n" + `printf '${SHIM_URL}\\n'\n` + "exit 0\n",
		90_000,
	);
	// Kill REACH. The shim spawns a grandchild that keeps ticking a file, then
	// hangs past its own bound. Killing the direct child alone leaves that
	// grandchild running; killing the process group takes it too. The ticks
	// are the observable — the run's own outcome is identical either way,
	// which is exactly why the reach needed its own arm (issue #85).
	groupKillRun = await runWithShim(
		'( while : ; do printf t >> "$SINK/ticks"; sleep 0.2; done ) &\n' + "sleep 120\n",
		60_000,
	);
});

after(() => {
	for (const run of [absentRun, failedRun, junkRun, echoRun, wrongStreamRun, hangingRun, orphanLateRun, groupKillRun]) {
		if (run !== undefined) {
			removeFixture(run.fixture);
		}
	}
});

// ---------------------------------------------------------------------------
// The five outcome classes refuse admission (§3.10; posture egress-publish-executor).
// ---------------------------------------------------------------------------

describe("delegate absent: no gh on PATH refuses admission with a record (issue #83)", () => {
	it("the publish tool answers for itself", () => {
		requireOwnResult(absentRun, "delegate-absent");
	});

	it("a content-free egress record lands and no success is claimed", () => {
		assert.ok(
			egressAuditLines(absentRun).length >= 1,
			"delegate-absent: no egress audit record — a presence-probe-free executor still owes its refusal a " +
				"record (§3.5); " +
				redUntilRegistered("delegate-absent record"),
		);
		assertNoSuccessClaim(absentRun, "delegate-absent");
	});
});

describe("failed run: non-zero exit refuses admission, streams excluded (issue #83)", () => {
	it("the publish tool answers for itself", () => {
		requireOwnResult(failedRun, "failed-run");
	});

	it("no success claim, and no child-stream bytes in any record", () => {
		assert.ok(egressAuditLines(failedRun).length >= 1, redUntilRegistered("failed-run record"));
		assertNoSuccessClaim(failedRun, "failed-run");
		assertStreamsExcluded(failedRun, "failed-run");
	});

	it("the child ran with its cwd pinned to the runtime's repository root", () => {
		const cwdPath = join(failedRun.sinkDir, "gh-cwd");
		assert.ok(existsSync(cwdPath), redUntilRegistered("child-cwd capture"));
		assert.equal(
			readFileSync(cwdPath, "utf8").trim(),
			repoRoot(),
			"child cwd: the publish child ran somewhere other than the runtime's own repository root — " +
				"gh resolves the target repo from cwd, so an ambient cwd retargets the publication (§4.6)",
		);
	});
});

describe("junk output after a consumed body is post-send ambiguity (issue #83)", () => {
	it("the publish tool answers for itself", () => {
		requireOwnResult(junkRun, "junk-output");
	});

	it("reports outcome-unverified, claiming neither publication nor withholding", () => {
		const own = requireOwnResult(junkRun, "junk-output");
		const carried =
			textOf(own).includes("outcome-unverified") ||
			egressAuditLines(junkRun).some((line) => line.includes("outcome-unverified"));
		assert.ok(
			carried,
			"junk-output: neither the result nor an egress record carries the outcome-unverified token — the send " +
				"left the process and no valid outcome exists, so the tool may claim neither publication nor " +
				"withholding (§3.3; §5.6's unconfirmable-publish-toward-silence direction)",
		);
		assertNoSuccessClaim(junkRun, "junk-output");
	});
});

describe("a stdin-echoing hostile child cannot ride its bytes into a record (issue #83)", () => {
	it("the publish tool answers for itself", () => {
		requireOwnResult(echoRun, "stdin-echo");
	});

	it("no success claim, and the echoed body reaches no record", () => {
		assert.ok(egressAuditLines(echoRun).length >= 1, redUntilRegistered("stdin-echo record"));
		assertNoSuccessClaim(echoRun, "stdin-echo");
		assertStreamsExcluded(echoRun, "stdin-echo");
	});
});

describe("the payload on the wrong stream refuses admission (issue #83)", () => {
	it("the publish tool answers for itself", () => {
		requireOwnResult(wrongStreamRun, "wrong-stream");
	});

	it("a URL on stderr is not output validity: no success claim, URL in no record", () => {
		assert.ok(egressAuditLines(wrongStreamRun).length >= 1, redUntilRegistered("wrong-stream record"));
		assertNoSuccessClaim(wrongStreamRun, "wrong-stream");
	});
});

describe("a late in-bound exit behind an orphan-held pipe publishes (issue #85, SPEC §5.6)", () => {
	it("the run completes and the tool answers for itself", () => {
		assert.equal(
			orphanLateRun.result.timedOut,
			false,
			"orphan-late: the session wedged — an in-bound exit behind a held pipe must still decide inside the " +
				"flush grace\n" + diagnostics(orphanLateRun.result),
		);
		assert.equal(orphanLateRun.result.exitCode, 0, diagnostics(orphanLateRun.result));
		requireOwnResult(orphanLateRun, "orphan-late");
	});

	it("the in-bound send is reported PUBLISHED, never refused as bound-exceeded", () => {
		// The regression direction is the one §5.6 forbids: withholding claimed
		// for a send that succeeded. The child exited at 9s against a 10s bound
		// with the URL on stdout; only a kill timer left armed across the flush
		// grace can turn that into a timeout refusal.
		const results = publishResults(orphanLateRun.fixture).map((message) => textOf(message));
		assert.ok(results.length >= 1, redUntilRegistered("orphan-late result"));
		const joined = results.join("\n");
		assert.ok(
			joined.includes(SUCCESS_URL_TOKEN),
			`orphan-late: an in-bound exit whose stdout carried the comment-URL shape was not reported published — ` +
				`the run is inside its bound and the send landed, so a refusal here claims withholding for a send ` +
				`that succeeded (§5.6): ${JSON.stringify(results)}`,
		);
		assert.ok(
			!joined.includes("exceeded its"),
			`orphan-late: the run was refused as bound-exceeded though the child exited inside its bound — the ` +
				`orphan held the pipes, not the child: ${JSON.stringify(results)}`,
		);
	});
});

describe("the bound's kill reaches the child's process group (issue #85)", () => {
	it("a grandchild the child spawned stops ticking once the bound fires", async () => {
		// Sampled AFTER the run settled: the direct child is gone either way,
		// so a still-growing tick file means the grandchild outlived the kill.
		const ticks = join(groupKillRun.sinkDir, "ticks");
		assert.ok(existsSync(ticks), `group-kill: the grandchild never ran, so the arm measures nothing`);
		const before = readFileSync(ticks, "utf8").length;
		await new Promise((r) => setTimeout(r, 3_000));
		const after = readFileSync(ticks, "utf8").length;
		assert.equal(
			after,
			before,
			`group-kill: the grandchild kept ticking (${before} -> ${after}) for 3s after the run settled — the ` +
				`bound's kill reached the direct child only, so a gh-spawned child survives it and holds the pipes ` +
				`the executor was bounded against (§3.3's bounded child)`,
		);
	});
});

describe("the call is bounded even when the child cannot be reaped (issue #85)", () => {
	it("a backstop settles the call when SIGKILL produces no exit", () => {
		// STRUCTURAL, and recorded as such (§1.5), naming what it substitutes
		// for: an arm staging a child in an uninterruptible wait. SIGKILL is
		// delivered but not guaranteed to be REAPED, and such a child emits no
		// `exit` — the promise would never settle and the tool call would
		// wedge. No portable way exists to put a child into that state from a
		// test (it needs a blocking kernel path this suite cannot arrange), so
		// what is pinned is that the kill path arms a backstop at all. Every
		// OTHER bound in this module is pinned behaviourally above.
		const executor = readFileSync(
			join(repoRoot(), ".pi", "extensions", "gitjig", "publish", "executor.ts"),
			"utf8",
		);
		const body = executor.replace(/\/\*[\s\S]*?\*\//g, "");
		assert.match(
			body,
			/unkillableTimer\s*=\s*setTimeout\(/,
			"the kill path arms no backstop, so a child that never emits `exit` leaves the awaited promise " +
				"unsettled and wedges the tool call — against this module's own bounded-refusal claim (§5.9)",
		);
		assert.match(
			body,
			/clearTimeout\(unkillableTimer\)/,
			"the backstop is armed and never cleared, so it outlives a settled call",
		);
	});
});

describe("a hanging child is bounded, never a wedged session (issue #83)", () => {
	it("the run completes inside the arm's 60s backstop, and the tool answers for itself", () => {
		// Order is load-bearing: the bound is measured FIRST (a wedged run is
		// its own failure, whatever the tool answered), then the red anchor.
		assert.equal(
			hangingRun.result.timedOut,
			false,
			"hanging child: the session wedged past 60s — the executor's child bound must fire well under the " +
				"arm's backstop (§3.3's bounded child)\n" + diagnostics(hangingRun.result),
		);
		assert.equal(hangingRun.result.exitCode, 0, diagnostics(hangingRun.result));
		requireOwnResult(hangingRun, "hanging-child");
	});
});

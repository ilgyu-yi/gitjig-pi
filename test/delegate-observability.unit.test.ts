import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { runDelegate } from "../.pi/extensions/gitjig/dispatch/executor.ts";
import {
	BoundedDelegateTrace,
	renderTraceSnapshot,
	retainTrace,
	TRACE_DIRECTORY,
	TRACE_LINE_BYTES,
	TRACE_LINES,
	TRACE_RENDER_CODEPOINTS,
	TRACE_RETAIN_COUNT,
	TRACE_RETAIN_MS,
} from "../.pi/extensions/gitjig/dispatch/trace.ts";

/** The TERM/KILL arm's bounds (#426): pid-file reads 10 ms apart, and the wait for its killed grandchild to be reaped. */
const PID_READ_TRIES = 100;
const REAP_BOUND_MS = 2_000;
/** The executor's abort grace, `STREAM_GRACE_MS`: SIGTERM, then SIGKILL this long after (§4.9). */
const ABORT_GRACE_MS = 2_000;
/** Whether a pid still exists (a zombie included). */
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
/** A descendant's pid, from a shell that starts under load: up to 5 s of reads 10 ms apart. */
const DESCENDANT_PID_TRIES = 500;
/** Read a whole pid from the file the fixture shell writes, within DESCENDANT_PID_TRIES reads 10 ms apart. */
async function wholePid(file: string): Promise<number> {
	for (let tries = 0; tries < DESCENDANT_PID_TRIES; tries++) {
		const text = existsSync(file) ? readFileSync(file, "utf8") : "";
		if (/^\d+\n$/.test(text)) return Number(text);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return 0;
}
/** Wait until `until` (epoch ms), or less if the pid goes first; returns whether it is gone. */
async function goneBy(pid: number, until: number): Promise<boolean> {
	while (alive(pid) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
	return !alive(pid);
}
const roots: string[] = [];
after(() => roots.forEach((root) => void rmSync(root, { recursive: true, force: true })));

const root = (): string => {
	const value = mkdtempSync(join(tmpdir(), "gitjig-observe-"));
	roots.push(value);
	return value;
};

describe("#132 bounded delegate trace", () => {
	it("drains an overlong line while retaining only the fixed prefix and truncation signal", () => {
		const trace = new BoundedDelegateTrace();
		trace.consume("stdout", Buffer.from(`${"x".repeat(TRACE_LINE_BYTES * 3)}\nnext\n`));
		trace.finish();
		const snapshot = trace.snapshot();
		assert.equal(snapshot.counters.stdoutBytes, TRACE_LINE_BYTES * 3 + 6);
		assert.equal(snapshot.counters.truncatedLines, 1);
		assert.equal(snapshot.lines.at(-1)?.text, "next");
	});

	it("keeps the newest fixed line count and records every eviction", () => {
		const trace = new BoundedDelegateTrace();
		for (let index = 0; index < TRACE_LINES + 7; index++) trace.consume("stderr", Buffer.from(`line-${index}\n`));
		trace.finish();
		const snapshot = trace.snapshot();
		assert.equal(snapshot.lines.length, TRACE_LINES);
		assert.equal(snapshot.counters.evictedLines, 7);
		assert.equal(snapshot.lines[0].text, "line-7");
	});

	it("clips rendered code points and exposes running and terminal lifecycle classes", () => {
		const trace = new BoundedDelegateTrace();
		trace.consume("stdout", Buffer.from(`${"🙂".repeat(TRACE_RENDER_CODEPOINTS + 1)}\n`));
		trace.finish();
		const running = trace.snapshot();
		assert.equal([...running.lines[0].text].length, TRACE_RENDER_CODEPOINTS);
		assert.equal(running.lines[0].truncated, true);
		assert.match(renderTraceSnapshot(running), /^delegate running\n/);
		assert.match(renderTraceSnapshot(trace.snapshot("completed")), /^delegate completed\n/);
		assert.match(renderTraceSnapshot(new BoundedDelegateTrace().snapshot("failed")), /^delegate failed ·/);
	});

	it("retains owner-only files and prunes independently by count", () => {
		const state = root();
		const snapshot = new BoundedDelegateTrace().snapshot("completed");
		for (let index = 0; index < TRACE_RETAIN_COUNT + 3; index++)
			assert.equal(typeof retainTrace(state, snapshot, index), "string");
		const directory = join(state, TRACE_DIRECTORY);
		const files = readdirSync(directory);
		assert.equal(files.length, TRACE_RETAIN_COUNT);
		assert.equal(
			files.some((name) => name.startsWith("0-")),
			false,
		);
		assert.equal(lstatSync(directory).mode & 0o077, 0);
		assert.equal(lstatSync(join(directory, files[0])).mode & 0o077, 0);
		assert.equal(JSON.parse(readFileSync(join(directory, files[0]), "utf8")).lifecycle, "completed");
	});

	it("prunes by age below the count bound", () => {
		const state = root();
		const snapshot = new BoundedDelegateTrace().snapshot("completed");
		assert.equal(typeof retainTrace(state, snapshot, 1), "string");
		assert.equal(typeof retainTrace(state, snapshot, TRACE_RETAIN_MS + 2), "string");
		const files = readdirSync(join(state, TRACE_DIRECTORY));
		assert.equal(files.length, 1);
		assert.equal(files[0].startsWith(`${TRACE_RETAIN_MS + 2}-`), true);
	});

	it("encodes hostile at-rest controls and counts only decoder-introduced replacements", () => {
		const state = root();
		const trace = new BoundedDelegateTrace();
		const text = "literal-�\u007f\u009b\u2028";
		trace.consume("stderr", Buffer.concat([Buffer.from(text), Buffer.from([0xff]), Buffer.from("\n")]));
		trace.finish();
		const snapshot = trace.snapshot("failed");
		assert.equal(snapshot.counters.decodeReplacements, 1);
		assert.equal(typeof retainTrace(state, snapshot), "string");
		const raw = readFileSync(join(state, TRACE_DIRECTORY, readdirSync(join(state, TRACE_DIRECTORY))[0]), "utf8");
		for (const rawControl of ["\u007f", "\u009b", "\u2028"]) assert.equal(raw.includes(rawControl), false);
		assert.equal(JSON.parse(raw).lines[0].text, `${text}�`);
	});

	it("refuses an absent state root and a linked trace directory without creating or following either", () => {
		assert.equal(retainTrace("relative-state", new BoundedDelegateTrace().snapshot()), undefined);
		const absent = join(root(), "missing-state-root");
		assert.equal(retainTrace(absent, new BoundedDelegateTrace().snapshot()), undefined);
		assert.equal(existsSync(absent), false);
		const state = root();
		const outside = root();
		mkdirSync(state, { recursive: true });
		symlinkSync(outside, join(state, TRACE_DIRECTORY));
		assert.equal(retainTrace(state, new BoundedDelegateTrace().snapshot()), undefined);
		assert.deepEqual(readdirSync(outside), []);
	});

	it("settles descriptor-exhausted spawn as delegate-absent without an uncaught stream failure", () => {
		const executorUrl = pathToFileURL(join(process.cwd(), ".pi/extensions/gitjig/dispatch/executor.ts")).href;
		const probe = `import {closeSync,mkdirSync,mkdtempSync,openSync} from "node:fs"; import {tmpdir} from "node:os"; import {join} from "node:path"; import {runDelegate} from ${JSON.stringify(executorUrl)}; const tree=mkdtempSync(join(tmpdir(),"zq-emfile-")); const stateDir=join(tree,"state"); mkdirSync(stateDir); const fds=[]; try{for(;;)fds.push(openSync("/dev/null","r"))}catch{} const outcome=await runDelegate({treeDir:tree,stateDir},["sh"],{timeoutMs:100}); await new Promise(r=>setTimeout(r,20)); for(const fd of fds){try{closeSync(fd)}catch{}} process.stdout.write(JSON.stringify(outcome));`;
		const measured = spawnSync(
			"sh",
			["-c", 'ulimit -n 64; exec "$@"', "sh", process.execPath, "--input-type=module", "-e", probe],
			{ cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
		);
		assert.equal(measured.status, 0, measured.stderr);
		assert.deepEqual(JSON.parse(measured.stdout), {
			exitCode: null,
			signal: null,
			timedOut: false,
			aborted: false,
			spawnFailed: true,
		});
	});

	it("propagates TERM then KILL to the child group without misclassifying abort as timeout", async () => {
		const tree = root();
		const stateDir = join(tree, "state");
		mkdirSync(stateDir);
		const controller = new AbortController();
		const started = Date.now();
		const lifecycles: string[] = [];
		// The grandchild holds none of the runner's pipes, so a grandchild the runner
		// never signals cannot hold the run open and fail the timing window instead
		// of the reap wait below (#426).
		const run = runDelegate(
			{ treeDir: tree, stateDir } as never,
			["sh", "-c", 'trap "" TERM; sleep 30 >/dev/null 2>&1 & echo $! > zq-child.pid; wait'],
			{ timeoutMs: 10_000, signal: controller.signal, onTrace: (snapshot) => lifecycles.push(snapshot.lifecycle) },
		);
		// The redirect creates the file before echo writes it, so an empty read is
		// not yet a pid; read until the file holds a whole one, within the bound.
		const pidFile = join(tree, "zq-child.pid");
		let grandchild = 0;
		let gone = false;
		try {
			for (let tries = 0; tries < PID_READ_TRIES && grandchild === 0; tries++) {
				const text = existsSync(pidFile) ? readFileSync(pidFile, "utf8") : "";
				if (/^\d+\n$/.test(text)) grandchild = Number(text);
				else await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.ok(
				Number.isInteger(grandchild) && grandchild > 1,
				`no whole grandchild pid within the bound: ${grandchild}`,
			);
			controller.abort();
			const outcome = await run;
			const elapsed = Date.now() - started;
			assert.equal(outcome.timedOut, false);
			assert.equal(outcome.aborted, true);
			assert.equal(outcome.spawnFailed, false);
			assert.equal(lifecycles.at(-1), "aborted");
			assert.ok(elapsed >= 1_800 && elapsed < 3_500, `TERM/KILL escalation settled in ${elapsed}ms`);
			// A killed grandchild exists until it is reaped, which happens after the
			// run settles, so wait for it to go rather than probing once.
			const deadline = Date.now() + REAP_BOUND_MS;
			for (;;) {
				try {
					process.kill(grandchild, 0);
				} catch (error) {
					assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
					gone = true;
					break;
				}
				if (Date.now() >= deadline) break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.ok(gone, `grandchild ${grandchild} outlived the ${REAP_BOUND_MS}ms reap bound`);
		} finally {
			controller.abort();
			if (grandchild > 1 && !gone)
				try {
					process.kill(grandchild, "SIGKILL");
				} catch {}
		}
	});

	it("ends a SIGTERM-ignoring, pipe-less descendant by the abort's SIGKILL after the grace, even once the run has settled", async () => {
		// The shell dies on the abort's SIGTERM and the descendant holds none of
		// its pipes, so the run settles at once; only the escalation, two seconds
		// after the SIGTERM, may end the descendant (§4.9, #448).
		const tree = root();
		const stateDir = join(tree, "state");
		mkdirSync(stateDir);
		const controller = new AbortController();
		const run = runDelegate(
			{ treeDir: tree, stateDir } as never,
			// The descendant ignores TERM before it records its pid, so the abort can
			// never find it with TERM still at its default (R1 F1).
			["sh", "-c", "sh -c 'trap \"\" TERM; echo $$ > zq-child.pid; exec sleep 30' >/dev/null 2>&1 & wait"],
			{ timeoutMs: 10_000, signal: controller.signal },
		);
		let descendant = 0;
		try {
			descendant = await wholePid(join(tree, "zq-child.pid"));
			assert.ok(
				Number.isInteger(descendant) && descendant > 1,
				`no whole descendant pid within the bound: ${descendant}`,
			);
			const aborted = Date.now();
			controller.abort();
			const outcome = await run;
			assert.equal(outcome.aborted, true);
			assert.equal(outcome.timedOut, false);
			assert.ok(Date.now() - aborted < ABORT_GRACE_MS / 2, "the run waited instead of settling at once");
			assert.equal(
				alive(descendant),
				true,
				"the descendant was gone at settlement, so nothing here measures the escalation",
			);
			await new Promise((resolve) => setTimeout(resolve, Math.max(0, aborted + ABORT_GRACE_MS - 500 - Date.now())));
			assert.equal(alive(descendant), true, "the descendant was SIGKILLed before the grace");
			assert.equal(
				await goneBy(descendant, aborted + ABORT_GRACE_MS + 1_500),
				true,
				`descendant ${descendant} outlived the abort's SIGKILL escalation`,
			);
		} finally {
			controller.abort();
			if (descendant > 1 && alive(descendant))
				try {
					process.kill(descendant, "SIGKILL");
				} catch {}
		}
	});

	it("keeps an otherwise idle host alive until the abort's SIGKILL, so the descendant does not outlive it", async () => {
		// A host that ends naturally right after the run settles: only a ref'd
		// escalation keeps it until the SIGKILL is sent (R3).
		const executorUrl = pathToFileURL(join(process.cwd(), ".pi/extensions/gitjig/dispatch/executor.ts")).href;
		const fixture = "sh -c 'trap \"\" TERM; echo $$ > zq-child.pid; exec sleep 30' >/dev/null 2>&1 & wait";
		const host = `import {existsSync,mkdirSync,mkdtempSync,readFileSync} from "node:fs"; import {tmpdir} from "node:os"; import {join} from "node:path"; import {runDelegate} from ${JSON.stringify(executorUrl)}; const tree=mkdtempSync(join(tmpdir(),"zq-host-")); const stateDir=join(tree,"state"); mkdirSync(stateDir); const c=new AbortController(); const run=runDelegate({treeDir:tree,stateDir},["sh","-c",${JSON.stringify(fixture)}],{timeoutMs:10000,signal:c.signal}); let pid=0; for(let i=0;i<500&&pid===0;i++){const t=existsSync(join(tree,"zq-child.pid"))?readFileSync(join(tree,"zq-child.pid"),"utf8"):""; if(/^\\d+\\n$/.test(t)) pid=Number(t); else await new Promise(r=>setTimeout(r,10));} const abortedAt=Date.now(); c.abort(); await run; process.stdout.write(JSON.stringify({pid,abortedAt}));`;
		let descendant = 0;
		try {
			const ran = spawnSync(process.execPath, ["--input-type=module", "-e", host], {
				cwd: process.cwd(),
				encoding: "utf8",
				timeout: 15_000,
			});
			const hostEnded = Date.now();
			assert.equal(ran.status, 0, ran.stderr);
			const { pid, abortedAt } = JSON.parse(ran.stdout) as { pid: number; abortedAt: number };
			descendant = pid;
			assert.ok(
				Number.isInteger(descendant) && descendant > 1,
				`no whole descendant pid within the bound: ${descendant}`,
			);
			assert.equal(
				await goneBy(descendant, Date.now() + 1_500),
				true,
				`descendant ${descendant} outlived the host, which ended ${hostEnded - abortedAt}ms after the abort`,
			);
		} finally {
			if (descendant > 1 && alive(descendant))
				try {
					process.kill(descendant, "SIGKILL");
				} catch {}
		}
	});

	it("schedules no signal after a run that was not aborted settles", async () => {
		// A delegate-spawned descendant that survives a normal exit is not
		// group-killed, now or after the grace (#448: only an abort arms it).
		const tree = root();
		const stateDir = join(tree, "state");
		mkdirSync(stateDir);
		const run = runDelegate(
			{ treeDir: tree, stateDir } as never,
			["sh", "-c", "sleep 30 >/dev/null 2>&1 & echo $! > zq-child.pid"],
			{ timeoutMs: 10_000 },
		);
		let descendant = 0;
		try {
			const outcome = await run;
			assert.equal(outcome.exitCode, 0);
			descendant = await wholePid(join(tree, "zq-child.pid"));
			assert.ok(
				Number.isInteger(descendant) && descendant > 1,
				`no whole descendant pid within the bound: ${descendant}`,
			);
			const settledAt = Date.now();
			await new Promise((resolve) => setTimeout(resolve, ABORT_GRACE_MS + 500));
			assert.equal(
				alive(descendant),
				true,
				`a signal reached the descendant ${Date.now() - settledAt}ms after settlement`,
			);
		} finally {
			if (descendant > 1)
				try {
					process.kill(descendant, "SIGKILL");
				} catch {}
		}
	});

	it("emits the correct terminal lifecycle when cancellation precedes spawn", async () => {
		const controller = new AbortController();
		controller.abort();
		const lifecycles: string[] = [];
		const outcome = await runDelegate({ treeDir: root(), stateDir: root() } as never, ["sh"], {
			signal: controller.signal,
			onTrace: (snapshot) => lifecycles.push(snapshot.lifecycle),
		});
		assert.equal(outcome.aborted, true);
		assert.deepEqual(lifecycles, ["aborted"]);
	});

	it("keeps timeout terminal when a later abort races the bound", async () => {
		const tree = root();
		const stateDir = join(tree, "state");
		mkdirSync(stateDir);
		const controller = new AbortController();
		const lifecycles: string[] = [];
		setTimeout(() => controller.abort(), 100);
		const outcome = await runDelegate({ treeDir: tree, stateDir } as never, ["sh", "-c", "sleep 30"], {
			timeoutMs: 50,
			signal: controller.signal,
			onTrace: (snapshot) => lifecycles.push(snapshot.lifecycle),
		});
		assert.equal(outcome.timedOut, true);
		assert.equal(outcome.aborted, false);
		assert.equal(lifecycles.at(-1), "timed-out");
	});
});

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
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

	it("retains owner-only files and prunes by both count and age", () => {
		const state = root();
		const snapshot = new BoundedDelegateTrace().snapshot("completed");
		const oldNow = 1_000_000;
		assert.equal(retainTrace(state, snapshot, oldNow), true);
		for (let index = 0; index < TRACE_RETAIN_COUNT + 3; index++)
			assert.equal(retainTrace(state, snapshot, oldNow + TRACE_RETAIN_MS + 1 + index), true);
		const directory = join(state, TRACE_DIRECTORY);
		const files = readdirSync(directory);
		assert.equal(files.length, TRACE_RETAIN_COUNT);
		assert.equal(
			files.some((name) => name.startsWith(`${oldNow}-`)),
			false,
		);
		assert.equal(lstatSync(directory).mode & 0o077, 0);
		assert.equal(lstatSync(join(directory, files[0])).mode & 0o077, 0);
		assert.equal(JSON.parse(readFileSync(join(directory, files[0]), "utf8")).lifecycle, "completed");
	});

	it("refuses an absent state root and a linked trace directory without creating or following either", () => {
		const absent = join(root(), "missing-state-root");
		assert.equal(retainTrace(absent, new BoundedDelegateTrace().snapshot()), false);
		assert.equal(existsSync(absent), false);
		const state = root();
		const outside = root();
		mkdirSync(state, { recursive: true });
		symlinkSync(outside, join(state, TRACE_DIRECTORY));
		assert.equal(retainTrace(state, new BoundedDelegateTrace().snapshot()), false);
		assert.deepEqual(readdirSync(outside), []);
	});

	it("propagates TERM then KILL to the child group without misclassifying abort as timeout", async () => {
		const tree = root();
		const stateDir = join(tree, "state");
		mkdirSync(stateDir);
		const controller = new AbortController();
		const started = Date.now();
		const lifecycles: string[] = [];
		const run = runDelegate(
			{ treeDir: tree, stateDir } as never,
			["sh", "-c", 'trap "" TERM; sleep 30 & echo $! > zq-child.pid; wait'],
			{ timeoutMs: 10_000, signal: controller.signal, onTrace: (snapshot) => lifecycles.push(snapshot.lifecycle) },
		);
		for (let tries = 0; tries < 100 && !existsSync(join(tree, "zq-child.pid")); tries++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		const grandchild = Number(readFileSync(join(tree, "zq-child.pid"), "utf8"));
		controller.abort();
		const outcome = await run;
		const elapsed = Date.now() - started;
		assert.equal(outcome.timedOut, false);
		assert.equal(outcome.aborted, true);
		assert.equal(outcome.spawnFailed, false);
		assert.equal(lifecycles.at(-1), "aborted");
		assert.ok(elapsed >= 1_800 && elapsed < 3_500, `TERM/KILL escalation settled in ${elapsed}ms`);
		assert.throws(() => process.kill(grandchild, 0), /ESRCH/);
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

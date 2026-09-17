import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runDelegate } from "../.pi/extensions/gitjig/dispatch/executor.ts";
import {
	BoundedDelegateTrace,
	retainTrace,
	TRACE_DIRECTORY,
	TRACE_LINE_BYTES,
	TRACE_LINES,
	TRACE_RETAIN_COUNT,
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

	it("retains owner-only files and prunes to the newest fixed count", () => {
		const state = root();
		const snapshot = new BoundedDelegateTrace().snapshot();
		for (let index = 0; index < TRACE_RETAIN_COUNT + 3; index++)
			assert.equal(retainTrace(state, snapshot, 1_000_000 + index), true);
		const directory = join(state, TRACE_DIRECTORY);
		const files = readdirSync(directory);
		assert.equal(files.length, TRACE_RETAIN_COUNT);
		assert.equal(lstatSync(directory).mode & 0o077, 0);
		assert.equal(lstatSync(join(directory, files[0])).mode & 0o077, 0);
	});

	it("refuses a linked trace directory without following it", () => {
		const state = root();
		const outside = root();
		mkdirSync(state, { recursive: true });
		symlinkSync(outside, join(state, TRACE_DIRECTORY));
		assert.equal(retainTrace(state, new BoundedDelegateTrace().snapshot()), false);
		assert.deepEqual(readdirSync(outside), []);
	});

	it("propagates abort to the child group without misclassifying it as timeout", async () => {
		const tree = root();
		const stateDir = join(tree, "state");
		mkdirSync(stateDir);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);
		const started = Date.now();
		const outcome = await runDelegate({ treeDir: tree, stateDir } as never, ["sh", "-c", "sleep 30 & wait"], {
			timeoutMs: 10_000,
			signal: controller.signal,
		});
		assert.equal(outcome.timedOut, false);
		assert.equal(outcome.spawnFailed, false);
		assert.ok(Date.now() - started < 3_000);
	});
});

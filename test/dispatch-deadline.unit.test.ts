import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runDispatch } from "../.pi/extensions/gitjig/dispatch/index.ts";
import { provisionDispatchContext } from "../.pi/extensions/gitjig/dispatch/provision.ts";

function repository(): string {
	const root = mkdtempSync(join(tmpdir(), "gitjig-recovery-deadline-"));
	execFileSync("git", ["init", "-q", root]);
	execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
	execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
	execFileSync("git", ["-C", root, "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-qm", "base"]);
	mkdirSync(join(root, "state"));
	return root;
}

const writer = [
	"const {execFileSync}=require('node:child_process');",
	"const {writeFileSync}=require('node:fs');",
	"const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();",
	"writeFileSync('../return.json',JSON.stringify({ok:true,summary:'ok',reviewedHead:head}));",
].join("");

describe("recovery optional dispatch deadline", () => {
	it("refuses before the first provision operation when no time remains", () => {
		const repo = repository();
		try {
			assert.throws(
				() =>
					provisionDispatchContext(repo, { brief: "brief", expectedRef: "HEAD", operationDeadline: performance.now() }),
				/expected ref resolves to no commit/,
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("caps a running delegate at the remaining absolute operation time", async () => {
		const repo = repository();
		try {
			const outcome = await runDispatch({
				callerRepoRoot: repo,
				stateRoot: join(repo, "state"),
				delegateArgv: [process.execPath, "-e", "setTimeout(()=>{},10000)"],
				brief: "brief",
				expectedRef: "HEAD",
				timeoutMs: 600_000,
				operationDeadline: performance.now() + 100,
				enteredAt: performance.now(),
			});
			assert.equal(outcome.disposition, "refused");
			assert.ok(outcome.diagnostic.code === "TIMED_OUT" || outcome.diagnostic.code === "ABORTED");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("rejects a clock crossing observed only after cleanup", async () => {
		const original = performance.now;
		const first = repository();
		let calls = 0;
		try {
			Object.defineProperty(performance, "now", {
				configurable: true,
				value: () => {
					calls += 1;
					return 0;
				},
			});
			const calibration = await runDispatch({
				callerRepoRoot: first,
				stateRoot: join(first, "state"),
				delegateArgv: [process.execPath, "-e", writer],
				brief: "brief",
				expectedRef: "HEAD",
				timeoutMs: 10_000,
				operationDeadline: 1_000,
				enteredAt: 0,
			});
			assert.equal(calibration.disposition, "admitted");
		} finally {
			Object.defineProperty(performance, "now", { configurable: true, value: original });
			rmSync(first, { recursive: true, force: true });
		}
		const second = repository();
		let observed = 0;
		try {
			Object.defineProperty(performance, "now", {
				configurable: true,
				value: () => {
					observed += 1;
					return observed < calls ? 0 : 2_000;
				},
			});
			const crossed = await runDispatch({
				callerRepoRoot: second,
				stateRoot: join(second, "state"),
				delegateArgv: [process.execPath, "-e", writer],
				brief: "brief",
				expectedRef: "HEAD",
				timeoutMs: 10_000,
				operationDeadline: 1_000,
				enteredAt: 0,
			});
			assert.equal(crossed.disposition, "refused");
			assert.equal(crossed.diagnostic.code, "ABORTED");
			const records = readFileSync(join(second, "state", "audit.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { action: string });
			assert.equal(records.at(-1)?.action, "refuse-operation-deadline");
		} finally {
			Object.defineProperty(performance, "now", { configurable: true, value: original });
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("freezes final checkpoint bytes and rejects a later overwrite", async () => {
		const repo = repository();
		const originalSetTimeout = globalThis.setTimeout;
		try {
			globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
				originalSetTimeout(
					callback,
					delay === 360_000 ? 30 : delay === 540_000 ? 60 : delay,
					...args,
				)) as typeof setTimeout;
			const script = [
				"const {execFileSync}=require('node:child_process'); const {writeFileSync}=require('node:fs');",
				"const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();",
				"const put=(summary)=>writeFileSync('../return.json',JSON.stringify({ok:true,summary,reviewedHead:head}));",
				"put('provisional'); setTimeout(()=>put('too late'),80); setTimeout(()=>{},110);",
			].join("");
			const outcome = await runDispatch({
				callerRepoRoot: repo,
				stateRoot: join(repo, "state"),
				delegateArgv: [process.execPath, "-e", script],
				brief: "brief",
				expectedRef: "HEAD",
				timeoutMs: 10_000,
				operationDeadline: performance.now() + 5_000,
				enteredAt: performance.now(),
			});
			assert.equal(outcome.disposition, "refused");
			assert.equal(outcome.diagnostic.code, "ABORTED");
			assert.equal(outcome.diagnostic.phase, "run");
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("preserves the admitted path when the optional deadline is absent", async () => {
		const repo = repository();
		try {
			const outcome = await runDispatch({
				callerRepoRoot: repo,
				stateRoot: join(repo, "state"),
				delegateArgv: [process.execPath, "-e", writer],
				brief: "brief",
				expectedRef: "HEAD",
				timeoutMs: 10_000,
			});
			assert.equal(outcome.disposition, "admitted");
			assert.equal(outcome.compare, "confirmed");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

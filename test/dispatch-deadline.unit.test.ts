import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

	it("refuses an absent provisional return at the 360-second checkpoint", async () => {
		const repo = repository();
		const originalSetTimeout = globalThis.setTimeout;
		try {
			globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
				originalSetTimeout(
					callback,
					delay === 360_000 ? 100 : delay === 540_000 ? 250 : delay,
					...args,
				)) as typeof setTimeout;
			const outcome = await runDispatch({
				callerRepoRoot: repo,
				stateRoot: join(repo, "state"),
				delegateArgv: [process.execPath, "-e", "setTimeout(()=>{},500)"],
				brief: "brief",
				expectedRef: "HEAD",
				timeoutMs: 5_000,
				operationDeadline: performance.now() + 5_000,
				enteredAt: performance.now(),
			});
			assert.equal(outcome.disposition, "refused");
			assert.equal(outcome.diagnostic.code, "ABORTED");
			assert.equal(outcome.diagnostic.phase, "run");
			const actions = readFileSync(join(repo, "state", "audit.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => (JSON.parse(line) as { action: string }).action);
			assert.ok(actions.includes("refuse-aborted"));
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("kills a private-copy removal of the provisional checkpoint", async () => {
		const box = mkdtempSync(join(tmpdir(), "gitjig-checkpoint-mutant-"));
		const repo = repository();
		const originalSetTimeout = globalThis.setTimeout;
		try {
			cpSync(new URL("../.pi/extensions/gitjig", import.meta.url), join(box, "gitjig"), { recursive: true });
			symlinkSync(new URL("../node_modules", import.meta.url), join(box, "node_modules"), "dir");
			const path = join(box, "gitjig", "dispatch", "index.ts");
			const original = readFileSync(path, "utf8");
			const needle = "if (!admitReturn(context.returnPath).admitted) checkpointAbort.abort();";
			assert.equal(original.split(needle).length, 2);
			writeFileSync(path, original.replace(needle, "void context.returnPath;"));
			globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
				originalSetTimeout(
					callback,
					delay === 360_000 ? 90 : delay === 540_000 ? 500 : delay,
					...args,
				)) as typeof setTimeout;
			const mutated = await import(new URL(`file://${path}`).href);
			const lateWriter = [
				"const {execFileSync}=require('node:child_process'); const {writeFileSync}=require('node:fs');",
				"const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();",
				"setTimeout(()=>writeFileSync('../return.json',JSON.stringify({ok:true,summary:'late',reviewedHead:head})),170);",
			].join("");
			const options = {
				callerRepoRoot: repo,
				stateRoot: join(repo, "state"),
				delegateArgv: [process.execPath, "-e", lateWriter],
				brief: "brief",
				expectedRef: "HEAD",
				timeoutMs: 5_000,
			};
			const baseline = await runDispatch({ ...options, operationDeadline: performance.now() + 5_000 });
			assert.equal(baseline.disposition, "refused");
			assert.equal(baseline.diagnostic.code, "ABORTED");
			const outcome = await mutated.runDispatch({ ...options, operationDeadline: performance.now() + 5_000 });
			assert.equal(
				outcome.disposition,
				"admitted",
				"mutant must survive without the checkpoint and thus be killed by the owner test",
			);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			rmSync(repo, { recursive: true, force: true });
			rmSync(box, { recursive: true, force: true });
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

	it("kills a private-copy omission of the final checkpoint freeze", async () => {
		const box = mkdtempSync(join(tmpdir(), "gitjig-final-mutant-"));
		const repo = repository();
		const originalSetTimeout = globalThis.setTimeout;
		try {
			cpSync(new URL("../.pi/extensions/gitjig", import.meta.url), join(box, "gitjig"), { recursive: true });
			symlinkSync(new URL("../node_modules", import.meta.url), join(box, "node_modules"), "dir");
			const path = join(box, "gitjig", "dispatch", "index.ts");
			const original = readFileSync(path, "utf8");
			assert.equal(original.split("finalCheckpointBytes = after;").length, 2);
			writeFileSync(path, original.replace("finalCheckpointBytes = after;", "void after;"));
			globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
				originalSetTimeout(
					callback,
					delay === 360_000 ? 100 : delay === 540_000 ? 160 : delay,
					...args,
				)) as typeof setTimeout;
			const script = [
				"const {execFileSync}=require('node:child_process'); const {writeFileSync}=require('node:fs');",
				"const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();",
				"const put=(summary)=>writeFileSync('../return.json',JSON.stringify({ok:true,summary,reviewedHead:head}));",
				"put('provisional'); setTimeout(()=>put('changed after freeze'),220); setTimeout(()=>{},260);",
			].join("");
			const options = {
				callerRepoRoot: repo,
				stateRoot: join(repo, "state"),
				delegateArgv: [process.execPath, "-e", script],
				brief: "brief",
				expectedRef: "HEAD",
				timeoutMs: 5_000,
			};
			const baseline = await runDispatch({ ...options, operationDeadline: performance.now() + 5_000 });
			assert.equal(baseline.disposition, "refused");
			assert.equal(baseline.diagnostic.code, "ABORTED");
			const mutated = await import(new URL(`file://${path}`).href);
			const result = await mutated.runDispatch({ ...options, operationDeadline: performance.now() + 5_000 });
			assert.equal(result.disposition, "admitted", "removing final freeze must fail the owner behavioral assertion");
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			rmSync(repo, { recursive: true, force: true });
			rmSync(box, { recursive: true, force: true });
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

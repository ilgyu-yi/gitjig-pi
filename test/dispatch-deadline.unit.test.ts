import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runDispatch } from "../.pi/extensions/gitjig/dispatch/index.ts";

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
		} finally {
			Object.defineProperty(performance, "now", { configurable: true, value: original });
			rmSync(second, { recursive: true, force: true });
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

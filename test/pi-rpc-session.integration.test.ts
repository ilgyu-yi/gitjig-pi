import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { admitReturn } from "../.pi/extensions/gitjig/dispatch/admit.ts";
import { startPiRpc } from "../.pi/extensions/gitjig/dispatch/pi-rpc.ts";
import { provisionPiSubmitTool } from "../.pi/extensions/gitjig/dispatch/pi-submit.ts";
import type { DispatchContext } from "../.pi/extensions/gitjig/dispatch/provision.ts";
import { reviewerReturnFromPayload } from "../.pi/extensions/gitjig/review/join.ts";
import { REVIEW_PI_PROFILES } from "../.pi/extensions/gitjig/review/pi-profile.ts";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));

test(
	"real Pi RPC session uses an isolated clone, operator-only events and no result-by-settled",
	{ timeout: 20000 },
	async () => {
		const scratch = mkdtempSync(join(tmpdir(), "gitjig-370-rpc-session-"));
		const tree = join(scratch, "tree");
		const home = join(scratch, "home");
		const state = join(scratch, "state");
		const agentDir = join(scratch, "agent");
		const extensionDir = join(scratch, "trusted", "extensions");
		const extension = join(extensionDir, "scripted-provider.ts");
		const previous = Object.fromEntries(
			["HOME", "PI_CODING_AGENT_DIR", "XDG_STATE_HOME", "PI_OFFLINE"].map((key) => [key, process.env[key]]),
		);
		try {
			execFileSync("git", ["clone", "-q", "--no-hardlinks", repo, tree]);
			execFileSync("git", ["-C", tree, "remote", "remove", "origin"]);
			rmSync(join(tree, ".git", "logs"), { recursive: true, force: true });
			for (const directory of [home, state, agentDir, extensionDir]) mkdirSync(directory, { recursive: true });
			// The provider resolves its script from two directories above this file.
			copyFileSync(join(repo, "test/harness/scripted-provider.ts"), extension);
			writeFileSync(join(scratch, "script.json"), JSON.stringify([{ kind: "text", text: "PRIVATE_DELEGATE_TEXT" }]));
			process.env.HOME = home;
			process.env.PI_CODING_AGENT_DIR = agentDir;
			process.env.XDG_STATE_HOME = state;
			process.env.PI_OFFLINE = "1";
			const context: DispatchContext = {
				scratchRoot: scratch,
				treeDir: tree,
				stateDir: state,
				briefPath: join(scratch, "brief.md"),
				returnPath: join(scratch, "return.json"),
				heldHash: execFileSync("git", ["-C", tree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
			};
			const events: string[] = [];
			const session = startPiRpc({
				context,
				extensionPath: extension,
				piExecutable: join(repo, "node_modules", ".bin", "pi"),
				provider: "scripted",
				model: "scripted-model",
				prompt: "Say ready",
				timeoutMs: 10000,
				onOperatorEvent: (event) => events.push(String(event.type)),
			});
			assert.equal(await session.waitForSettle(0), 1);
			assert.equal(await session.prompt("Explicit follow-up"), true);
			assert.equal(await session.waitForSettle(1), 2);
			session.close();
			assert.equal(await session.command("steer", "late operator input"), false);
			assert.equal(await session.clearQueue(), false);
			assert.equal(await session.prompt("late continuation"), false);
			assert.equal(await session.done, "settled");
			assert.ok(events.includes("message_end"));
			assert.ok(events.includes("agent_settled"));
			assert.equal(existsSync(context.returnPath), false); // agent_settled is not a result
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(scratch, { recursive: true, force: true });
		}
	},
);

/**
 * A fake Pi that puts a grandchild in its own process group and records that
 * grandchild's pid. The grandchild outlives its parent unless the supervisor
 * signals the whole group, so its death is the only direct evidence that the
 * group kill ran — awaiting the supervisor's outcome alone proves nothing.
 */
function fakePiWithGrandchild(path: string, pidFile: string, stdout: string): void {
	writeFileSync(
		path,
		"#!/usr/bin/env node\n" +
			'const cp = require("node:child_process"), fs = require("node:fs");\n' +
			'const kid = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });\n' +
			`fs.writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid));\n` +
			(stdout === "" ? "" : `process.stdout.write(${JSON.stringify(stdout)});\n`) +
			"setInterval(() => {}, 1000);\n",
		{ mode: 0o700 },
	);
}

/** Wait, bounded, for one pid to stop existing; returns whether it is gone. */
async function reaped(pid: number): Promise<boolean> {
	for (let attempt = 0; attempt < 120; attempt++) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

function grandchildScratch(stdout: string): {
	scratch: string;
	context: DispatchContext;
	fake: string;
	pidFile: string;
} {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-370-group-"));
	const tree = join(scratch, "tree");
	const state = join(scratch, "state");
	const extension = join(scratch, "trusted.ts");
	const fake = join(scratch, "fake-pi");
	const pidFile = join(scratch, "grandchild.pid");
	mkdirSync(tree);
	mkdirSync(state);
	writeFileSync(extension, "// trusted scratch placeholder\n");
	fakePiWithGrandchild(fake, pidFile, stdout);
	chmodSync(fake, 0o700);
	return {
		scratch,
		fake,
		pidFile,
		context: {
			scratchRoot: scratch,
			treeDir: tree,
			stateDir: state,
			briefPath: join(scratch, "brief.md"),
			returnPath: join(scratch, "return.json"),
			heldHash: "a".repeat(40),
		},
	};
}

test("malformed protocol kills the child group and returns no child-authored content", { timeout: 20000 }, async () => {
	const { scratch, context, fake, pidFile } = grandchildScratch("{invalid\n");
	try {
		const session = startPiRpc({
			context,
			extensionPath: join(scratch, "trusted.ts"),
			piExecutable: fake,
			provider: "scripted",
			model: "scripted-model",
			prompt: "test",
			timeoutMs: 4000,
		});
		assert.equal(await session.done, "protocol-invalid");
		assert.equal(existsSync(context.returnPath), false);
		const pid = Number(readFileSync(pidFile, "utf8"));
		assert.ok(Number.isInteger(pid) && pid > 1, `no grandchild pid recorded: ${pid}`);
		assert.equal(await reaped(pid), true, "the grandchild outlived the protocol refusal, so no group was killed");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("an exhausted bound kills the child group, not only the child", { timeout: 20000 }, async () => {
	// Silent and never exiting: the bound is the only terminal available.
	const { scratch, context, fake, pidFile } = grandchildScratch("");
	try {
		const session = startPiRpc({
			context,
			extensionPath: join(scratch, "trusted.ts"),
			piExecutable: fake,
			provider: "scripted",
			model: "scripted-model",
			prompt: "test",
			timeoutMs: 1500,
		});
		assert.equal(await session.done, "timeout");
		assert.equal(existsSync(context.returnPath), false);
		const pid = Number(readFileSync(pidFile, "utf8"));
		assert.ok(Number.isInteger(pid) && pid > 1, `no grandchild pid recorded: ${pid}`);
		assert.equal(await reaped(pid), true, "the grandchild outlived the bound, so no group was killed");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test(
	"real Pi submit_result writes the existing closed slot with a reviewer-owned profile",
	{ timeout: 20000 },
	async () => {
		const scratch = mkdtempSync(join(tmpdir(), "gitjig-370-submit-"));
		const tree = join(scratch, "tree");
		const state = join(scratch, "state");
		const providerDir = join(scratch, "trusted", "extensions");
		const provider = join(providerDir, "scripted-provider.ts");
		const home = join(scratch, "home");
		const agentDir = join(scratch, "agent");
		const before = Object.fromEntries(
			["HOME", "PI_CODING_AGENT_DIR", "XDG_STATE_HOME", "PI_OFFLINE"].map((key) => [key, process.env[key]]),
		);
		try {
			execFileSync("git", ["clone", "-q", "--no-hardlinks", repo, tree]);
			execFileSync("git", ["-C", tree, "remote", "remove", "origin"]);
			rmSync(join(tree, ".git", "logs"), { recursive: true, force: true });
			for (const dir of [state, providerDir, home, agentDir]) mkdirSync(dir, { recursive: true });
			copyFileSync(join(repo, "test/harness/scripted-provider.ts"), provider);
			writeFileSync(
				join(scratch, "script.json"),
				JSON.stringify([
					{ kind: "toolCall", name: "submit_result", arguments: { token: "APPROVED", findings: [] } },
					{ kind: "text", text: "PRIVATE_DELEGATE_TEXT" },
				]),
			);
			process.env.HOME = home;
			process.env.PI_CODING_AGENT_DIR = agentDir;
			process.env.XDG_STATE_HOME = state;
			process.env.PI_OFFLINE = "1";
			const context: DispatchContext = {
				scratchRoot: scratch,
				treeDir: tree,
				stateDir: state,
				briefPath: join(scratch, "brief.md"),
				returnPath: join(scratch, "return.json"),
				heldHash: execFileSync("git", ["-C", tree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
			};
			const extensionPath = provisionPiSubmitTool(context, REVIEW_PI_PROFILES.reviewer);
			const session = startPiRpc({
				context,
				extensionPath,
				providerExtensionPath: provider,
				piExecutable: join(repo, "node_modules", ".bin", "pi"),
				provider: "scripted",
				model: "scripted-model",
				prompt: "Submit the final result",
				timeoutMs: 10000,
			});
			assert.equal(await session.waitForSettle(0), 1);
			session.close();
			assert.equal(await session.done, "settled");
			const admission = admitReturn(context.returnPath);
			assert.equal(admission.admitted, true);
			if (admission.admitted) {
				assert.equal(admission.reviewedHead, context.heldHash);
				assert.deepEqual(reviewerReturnFromPayload(admission.payload), { token: "APPROVED", findings: [] });
				assert.equal(admission.summary, "review-result");
				assert.ok(!admission.payload?.includes(context.heldHash));
			}
		} finally {
			for (const [key, value] of Object.entries(before)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(scratch, { recursive: true, force: true });
		}
	},
);

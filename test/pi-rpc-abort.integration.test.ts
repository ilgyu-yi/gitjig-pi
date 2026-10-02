import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { admitReturn } from "../.pi/extensions/gitjig/dispatch/admit.ts";
import { type PiRpcSession, startPiRpc } from "../.pi/extensions/gitjig/dispatch/pi-rpc.ts";
import { provisionPiSubmitTool } from "../.pi/extensions/gitjig/dispatch/pi-submit.ts";
import type { DispatchContext } from "../.pi/extensions/gitjig/dispatch/provision.ts";
import { REVIEW_PI_PROFILES } from "../.pi/extensions/gitjig/review/pi-profile.ts";

const project = resolve(fileURLToPath(new URL("..", import.meta.url)));

test(
	"real submit-result/abort race: installed slot cannot override the abort terminal",
	{ timeout: 20000 },
	async () => {
		const scratch = mkdtempSync(join(tmpdir(), "gitjig-370-submit-abort-"));
		const tree = join(scratch, "tree");
		const state = join(scratch, "state");
		const providerDir = join(scratch, "trusted", "extensions");
		const provider = join(providerDir, "scripted-provider.ts");
		const before = Object.fromEntries(
			["HOME", "PI_CODING_AGENT_DIR", "XDG_STATE_HOME", "PI_OFFLINE"].map((key) => [key, process.env[key]]),
		);
		try {
			execFileSync("git", ["clone", "-q", "--no-hardlinks", project, tree]);
			execFileSync("git", ["-C", tree, "remote", "remove", "origin"]);
			rmSync(join(tree, ".git", "logs"), { recursive: true, force: true });
			for (const dir of [state, providerDir, join(scratch, "home"), join(scratch, "agent")])
				mkdirSync(dir, { recursive: true });
			copyFileSync(join(project, "test/harness/scripted-provider.ts"), provider);
			writeFileSync(
				join(scratch, "script.json"),
				JSON.stringify([{ kind: "toolCall", name: "submit_result", arguments: { token: "APPROVED", findings: [] } }]),
			);
			process.env.HOME = join(scratch, "home");
			process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
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
			let session: PiRpcSession | undefined;
			let observedSubmission = false;
			session = startPiRpc({
				context,
				extensionPath,
				providerExtensionPath: provider,
				piExecutable: join(project, "node_modules", ".bin", "pi"),
				provider: "scripted",
				model: "scripted-model",
				prompt: "Submit the result",
				timeoutMs: 10_000,
				onOperatorEvent: (event) => {
					if (event.type === "tool_execution_end" && event.toolName === "submit_result" && event.isError === false) {
						observedSubmission = true;
						session?.abort();
					}
				},
			});
			assert.equal(await session.done, "abort");
			assert.equal(observedSubmission, true);
			assert.equal(admitReturn(context.returnPath).admitted, true);
			// The runner maps the abort terminal to refusal before inspecting this
			// already installed slot; the slot alone cannot reverse cancellation.
		} finally {
			for (const [key, value] of Object.entries(before)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(scratch, { recursive: true, force: true });
		}
	},
);

/**
 * The abort path's own group reach, pinned on the signal the descendant sees.
 * `stop("abort")` sends SIGTERM to the whole process group and escalates to
 * SIGKILL; the exit path's own group kill would reap a descendant either way,
 * so reaping alone cannot tell the two apart. A grandchild that records having
 * received SIGTERM can: under the abort-only group sends it writes its marker,
 * and under a direct child-only kill it is reaped later by the exit path's
 * group SIGKILL without ever seeing SIGTERM.
 */
test("abort sends its first signal to the whole child process group", { timeout: 20000 }, async () => {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-370-abort-group-"));
	const tree = join(scratch, "tree");
	const state = join(scratch, "state");
	const extension = join(scratch, "trusted.ts");
	const fake = join(scratch, "fake-pi");
	const pidFile = join(scratch, "grandchild.pid");
	const termFile = join(scratch, "grandchild.sigterm");
	const readyFile = join(scratch, "grandchild.ready");
	try {
		mkdirSync(tree);
		mkdirSync(state);
		writeFileSync(extension, "// trusted scratch placeholder\n");
		const grandchild =
			`const fs = require("node:fs");` +
			`process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(termFile)}, "sigterm"); process.exit(0); });` +
			// The readiness marker is written only after the handler is installed,
			// so the abort below can never race the grandchild's startup.
			`fs.writeFileSync(${JSON.stringify(readyFile)}, "ready");` +
			`setInterval(() => {}, 1000);`;
		// Valid framing, so nothing refuses the protocol: it answers each
		// correlated request, puts a grandchild in its own group, and hangs.
		writeFileSync(
			fake,
			"#!/usr/bin/env node\n" +
				'const cp = require("node:child_process"), fs = require("node:fs");\n' +
				`const kid = cp.spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });\n` +
				`fs.writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid));\n` +
				'let buffer = "";\n' +
				'process.stdin.on("data", (chunk) => {\n' +
				"	buffer += chunk;\n" +
				'	for (let end = buffer.indexOf("\\n"); end >= 0; end = buffer.indexOf("\\n")) {\n' +
				"		const line = buffer.slice(0, end);\n" +
				"		buffer = buffer.slice(end + 1);\n" +
				"		let request;\n" +
				"		try {\n" +
				"			request = JSON.parse(line);\n" +
				"		} catch {\n" +
				"			continue;\n" +
				"		}\n" +
				"		if (request && request.id !== undefined)\n" +
				'			process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, success: true })}\\n`);\n' +
				"	}\n" +
				"});\n" +
				"setInterval(() => {}, 1000);\n",
			{ mode: 0o700 },
		);
		const context: DispatchContext = {
			scratchRoot: scratch,
			treeDir: tree,
			stateDir: state,
			briefPath: join(scratch, "brief.md"),
			returnPath: join(scratch, "return.json"),
			heldHash: "a".repeat(40),
		};
		const controller = new AbortController();
		const session = startPiRpc({
			context,
			extensionPath: extension,
			piExecutable: fake,
			provider: "scripted",
			model: "scripted-model",
			prompt: "hang",
			timeoutMs: 15_000,
			signal: controller.signal,
		});
		for (let attempt = 0; attempt < 200 && !(existsSync(pidFile) && existsSync(readyFile)); attempt++)
			await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(existsSync(pidFile), true, "the fake never recorded a grandchild");
		assert.equal(existsSync(readyFile), true, "the grandchild never installed its SIGTERM handler");
		controller.abort();
		assert.equal(await session.done, "abort");
		const pid = Number(readFileSync(pidFile, "utf8"));
		assert.ok(Number.isInteger(pid) && pid > 1, `no grandchild pid recorded: ${pid}`);
		let gone = false;
		for (let attempt = 0; attempt < 160 && !gone; attempt++) {
			try {
				process.kill(pid, 0);
				await new Promise((resolve) => setTimeout(resolve, 50));
			} catch {
				gone = true;
			}
		}
		assert.equal(gone, true, "the grandchild outlived the abort, so no group was signalled");
		assert.equal(
			existsSync(termFile),
			true,
			"the grandchild never received SIGTERM, so abort signalled the child alone rather than its group",
		);
		assert.equal(readFileSync(termFile, "utf8"), "sigterm");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

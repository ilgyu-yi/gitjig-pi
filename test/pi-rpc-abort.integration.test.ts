import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

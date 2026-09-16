import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { safeIssueNumber } from "../.pi/extensions/gitjig/act-render.ts";
import { dispatchTarget, dispatchTerminal, registerDispatchTool } from "../.pi/extensions/gitjig/dispatch/index.ts";
import { PUBLISH_DESTINATION_KINDS } from "../.pi/extensions/gitjig/publish/executor.ts";
import { publishTarget, publishTerminal, registerPublishTool } from "../.pi/extensions/gitjig/publish/index.ts";
import { SessionSurface } from "../.pi/extensions/gitjig/session-surface.ts";

const theme = {
	fg: (color: string, text: string) => `[${color}]${text}`,
	bold: (text: string) => text,
};
type FakeTheme = typeof theme;
type Component = { render(width: number): string[] };
type ToolResult = { content: Array<{ type: "text"; text: string }>; details: unknown };
type RegisteredTool = {
	execute(id: string, params: Record<string, unknown>): Promise<ToolResult>;
	renderCall(args: unknown, theme: FakeTheme, context: unknown): Component;
	renderResult(
		result: ToolResult,
		options: { expanded: boolean },
		theme: FakeTheme,
		context: { isError: boolean },
	): Component;
};

function rendered(component: Component): string {
	return component
		.render(200)
		.map((line) => line.trimEnd())
		.join("\n");
}

function capture(register: (pi: ExtensionAPI) => void): RegisteredTool {
	let tool: RegisteredTool | undefined;
	register({
		registerTool: (value: unknown) => {
			tool = value as RegisteredTool;
		},
	} as unknown as ExtensionAPI);
	assert.ok(tool, "the real registration produced no tool");
	return tool;
}

function result(details: Record<string, unknown>, text = "fixed detail"): ToolResult {
	return { content: [{ type: "text", text }], details };
}

describe("#131 collapsed operator-visible acts", () => {
	it("states the act and minimal persistent-state decisions in SPEC §5.9", () => {
		const spec = readFileSync(fileURLToPath(new URL("../SPEC.md", import.meta.url)), "utf8");
		const section = spec.slice(
			spec.indexOf("### 5.9 Session surfaces"),
			spec.indexOf("## 6. Self-governance milestone"),
		);
		for (const clause of [
			"intent",
			"structured target",
			"success, failure, or refusal",
			"Refusal never borrows success styling or wording",
			"active-dispatch count",
			"Execution mode is excluded until the owning §5.6 mode instrument lands",
			"Current issue or PR and workflow phase are excluded",
			"A UI-less mode makes no status call",
		])
			assert.ok(section.includes(clause), `SPEC §5.9 lost the #131 clause: ${clause}`);
	});

	it("dispatch renders fixed intent, a non-secret target, and three styled terminal classes", () => {
		const tool = capture((pi) => registerDispatchTool(pi, "/repo", "/state"));
		const expectedRef = "refs/heads/redacted-ref";
		const brief = "secret brief must not render";
		const call = rendered(tool.renderCall({ brief, delegateArgv: ["secret-program"], expectedRef }, theme, {}));
		assert.equal(call, "[toolTitle]Dispatch [muted]· isolated clone · blind compare");
		assert.ok(!call.includes(brief) && !call.includes(expectedRef) && !call.includes("secret-program"));

		const success = rendered(
			tool.renderResult(
				result({ disposition: "admitted", ok: true, compare: "confirmed" }),
				{ expanded: false },
				theme,
				{ isError: false },
			),
		);
		const failure = rendered(
			tool.renderResult(result({ disposition: "admitted", ok: false }), { expanded: false }, theme, { isError: false }),
		);
		const refusal = rendered(
			tool.renderResult(result({ disposition: "refused" }), { expanded: false }, theme, { isError: false }),
		);
		assert.deepEqual([success, failure, refusal], ["[success]✓ success", "[error]✗ failure", "[warning]! refusal"]);
	});

	it("expanded dispatch exposes a fixed refusal cause but never an admitted delegate payload", () => {
		const tool = capture((pi) => registerDispatchTool(pi, "/repo", "/state"));
		assert.equal(
			rendered(
				tool.renderResult(
					result({ disposition: "refused" }, "dispatch refused: fixed cause"),
					{ expanded: true },
					theme,
					{ isError: false },
				),
			),
			"[warning]! refusal\n[dim]dispatch refused: fixed cause",
		);
		const secret = "delegate-secret-payload";
		const admitted = rendered(
			tool.renderResult(result({ disposition: "admitted", ok: true }, secret), { expanded: true }, theme, {
				isError: false,
			}),
		);
		assert.equal(admitted, "[success]✓ success");
		assert.ok(!admitted.includes(secret));
	});

	it("publish renders only its structured destination and withholds operands and raw success URLs", () => {
		const tool = capture((pi) => registerPublishTool(pi, "/repo", "/state"));
		const withheld = "matched-secret-operand";
		const call = rendered(
			tool.renderCall(
				{ body: withheld, destination: { kind: "pr-comment", number: 131, title: "withheld title" } },
				theme,
				{},
			),
		);
		assert.equal(call, "[toolTitle]Publish [muted]· PR comment #131");
		assert.ok(!call.includes(withheld) && !call.includes("withheld title"));

		const refusal = rendered(
			tool.renderResult(
				result(
					{ disposition: "refuse-match", patternIds: ["private-key"], matchedText: withheld },
					"publish refused: patterns private-key lines 1",
				),
				{ expanded: false },
				theme,
				{ isError: false },
			),
		);
		const success = rendered(
			tool.renderResult(
				result(
					{ disposition: "published", url: "https://example.invalid/raw-control" },
					"published: https://example.invalid/raw-control",
				),
				{ expanded: true },
				theme,
				{ isError: false },
			),
		);
		assert.equal(refusal, "[warning]! refusal");
		assert.equal(success, "[success]✓ success");
		assert.ok(!refusal.includes("private-key") && !refusal.includes(withheld));
		assert.ok(!success.includes("https://"));
	});

	it("expanded publish distinguishes content-free refusal and outcome-unverified explanations", () => {
		const tool = capture((pi) => registerPublishTool(pi, "/repo", "/state"));
		const refused = rendered(
			tool.renderResult(
				result({ disposition: "refuse-destination" }, "publish refused: destination invalid"),
				{ expanded: true },
				theme,
				{ isError: false },
			),
		);
		const unverified = rendered(
			tool.renderResult(
				result({ disposition: "outcome-unverified" }, "outcome-unverified: no valid outcome shape"),
				{ expanded: true },
				theme,
				{ isError: false },
			),
		);
		assert.match(refused, /refuse.*destination/);
		assert.match(unverified, /outcome-unverified/);
	});

	it("classification and target tables are total over malformed and exceptional shapes", () => {
		assert.equal(dispatchTarget(null), "isolated clone");
		assert.equal(dispatchTarget({ expectedRef: "secret" }), "isolated clone · blind compare");
		assert.deepEqual(
			[
				dispatchTerminal({ disposition: "admitted", ok: true }),
				dispatchTerminal({ disposition: "admitted", ok: true, compare: "invalid" }),
				dispatchTerminal({ disposition: "refused" }),
				dispatchTerminal({}, true),
			],
			["success", "failure", "refusal", "failure"],
		);
		assert.deepEqual(
			[
				publishTerminal({ disposition: "published" }),
				publishTerminal({ disposition: "refuse-destination" }),
				publishTerminal({ disposition: "outcome-unverified" }),
				publishTerminal({}, true),
			],
			["success", "refusal", "failure", "failure"],
		);
		assert.equal(publishTarget(null), "invalid target");
		assert.equal(publishTarget(undefined), "invalid target");
		assert.equal(publishTarget({ destination: { kind: "issue-create" } }), "new issue");
		assert.equal(publishTarget({ destination: { kind: "unknown", number: 7 } }), "invalid target");
	});

	it("projects every owned publish kind and admits only positive safe issue numbers", () => {
		for (const kind of PUBLISH_DESTINATION_KINDS) {
			assert.notEqual(
				publishTarget({ destination: { kind, number: 7 } }),
				"invalid target",
				`${kind} lacks a render target`,
			);
		}
		for (const value of [undefined, "7", 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
			assert.equal(safeIssueNumber(value), "", `inadmissible issue number rendered: ${String(value)}`);
		}
		assert.equal(safeIssueNumber(1), " #1");
	});
});

describe("#131 persistent session surface", () => {
	it("carries delegate activity and terminal state in one composable status slot and resets on attach", () => {
		const writes: Array<[string, string | undefined]> = [];
		const surface = new SessionSurface();
		const ctx = {
			hasUI: true,
			ui: { theme, setStatus: (key: string, text: string | undefined) => writes.push([key, text]) },
		} as unknown as Pick<ExtensionContext, "hasUI" | "ui">;
		surface.attach(ctx);
		surface.dispatchStarted();
		surface.dispatchFinished("refusal");
		surface.attach(ctx);
		assert.deepEqual(writes, [
			["gitjig-session", "[dim]delegate idle"],
			["gitjig-session", "[accent]delegate active (1)"],
			["gitjig-session", "[warning]delegate refusal"],
			["gitjig-session", "[dim]delegate idle"],
		]);
	});

	it("makes no UI call headlessly and swallows a throwing interactive UI", () => {
		for (const hasUI of [false, true]) {
			const surface = new SessionSurface();
			surface.attach({
				hasUI,
				ui: {
					get theme() {
						throw new Error("ui theme");
					},
					setStatus() {
						throw new Error("ui status");
					},
				},
			} as unknown as Pick<ExtensionContext, "hasUI" | "ui">);
			surface.dispatchStarted();
			surface.dispatchFinished("success");
		}
	});

	it("wires active and terminal updates through refusal, admission, and thrown execution", async () => {
		const events: string[] = [];
		const recording = {
			dispatchStarted: () => events.push("active"),
			dispatchFinished: (terminal: string) => events.push(terminal),
		} as unknown as SessionSurface;
		const root = mkdtempSync(join(tmpdir(), "gitjig-surface-dispatch-"));
		try {
			execFileSync("git", ["init", "-q", root]);
			execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"]);
			execFileSync("git", ["-C", root, "config", "user.name", "Fixture"]);
			execFileSync("git", ["-C", root, "config", "commit.gpgsign", "false"]);
			writeFileSync(join(root, "README.md"), "fixture\n");
			execFileSync("git", ["-C", root, "add", "README.md"]);
			execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
			mkdirSync(join(root, "state"));
			const tool = capture((pi) => registerDispatchTool(pi, root, join(root, "state"), recording));
			assert.equal(
				(await tool.execute("refuse", { brief: "x", delegateArgv: [] })).details && events.at(-1),
				"refusal",
			);
			const admitted = await tool.execute("admit", {
				brief: "x",
				delegateArgv: ["sh", "-c", `printf '%s' '{"ok":true,"summary":"done"}' > ../return.json`],
			});
			assert.equal((admitted.details as { disposition?: unknown }).disposition, "admitted");
			assert.equal(events.at(-1), "success");
			await assert.rejects(tool.execute("throw", null as unknown as Record<string, unknown>), TypeError);
			assert.equal(events.at(-1), "failure");
			assert.deepEqual(events, ["active", "refusal", "active", "success", "active", "failure"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("a throwing status implementation cannot change a dispatch refusal", async () => {
		const state = mkdtempSync(join(tmpdir(), "gitjig-surface-state-"));
		try {
			const surface = new SessionSurface();
			surface.attach({
				hasUI: true,
				ui: {
					theme,
					setStatus: () => {
						throw new Error("status");
					},
				},
			} as unknown as Pick<ExtensionContext, "hasUI" | "ui">);
			const tool = capture((pi) => registerDispatchTool(pi, "/repo", state, surface));
			const outcome = await tool.execute("refuse", { brief: "x", delegateArgv: [] });
			assert.equal((outcome.details as { disposition?: unknown }).disposition, "refused");
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});
});

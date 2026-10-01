import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beginPiOperatorSession, registerPiOperatorCommand } from "../.pi/extensions/gitjig/dispatch/pi-operator.ts";
import type { PiRpcSession } from "../.pi/extensions/gitjig/dispatch/pi-rpc.ts";

test("operator-only view supersedes provisional text, steers and detaches without aborting child", async () => {
	let handler: ((arg: string, ctx: unknown) => Promise<void>) | undefined;
	registerPiOperatorCommand({
		registerCommand: (_name: string, definition: { handler: typeof handler }) => {
			handler = definition.handler;
		},
	} as unknown as ExtensionAPI);
	assert.ok(handler);
	const actions: string[] = [];
	const screen: string[][] = [];
	const choices = ["Steer", "Detach"];
	const controller = beginPiOperatorSession();
	controller.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "draft" } });
	controller.onEvent({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "final private text" }] },
	});
	const fake = {
		command: async (type: string, text: string) => {
			actions.push(`${type}:${text}`);
			return true;
		},
		clearQueue: async () => {
			actions.push("clear");
			return true;
		},
		abort: () => actions.push("abort"),
	} as unknown as PiRpcSession;
	controller.bind(fake);
	const ui = {
		select: async (_title: string, options: string[]) => {
			screen.push(options);
			return choices.shift();
		},
		input: async () => "private operator steer",
		notify: () => {},
	};
	await handler("", { mode: "tui", ui });
	assert.deepEqual(actions, ["steer:private operator steer"]);
	assert.ok(screen[0].includes("· assistant: final private text"));
	assert.ok(!screen[0].some((line) => line.includes("draft")));
	choices.push("Follow up", "Clear queue", "Abort");
	await handler("", { mode: "tui", ui });
	assert.deepEqual(actions, ["steer:private operator steer", "follow_up:private operator steer", "clear", "abort"]);
	assert.ok(screen.at(-1)?.includes("· assistant: final private text"));
	controller.end();
});

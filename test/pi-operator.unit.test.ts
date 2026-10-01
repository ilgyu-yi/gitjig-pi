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

test("the operator view keeps only the newest 20 lines and clips each to 512 code points", async () => {
	let handler: ((arg: string, ctx: unknown) => Promise<void>) | undefined;
	registerPiOperatorCommand({
		registerCommand: (_name: string, definition: { handler: typeof handler }) => {
			handler = definition.handler;
		},
	} as unknown as ExtensionAPI);
	assert.ok(handler);
	const controller = beginPiOperatorSession();
	// 25 completed messages: the five oldest must have fallen out of the view.
	for (let index = 0; index < 25; index++)
		controller.onEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: `line-${index}` }] },
		});
	// One over-long completed message and one over-long provisional delta: both
	// are clipped to the newest 512 code points, counted in code points rather
	// than UTF-16 units, so an astral character is never split.
	const astral = "\u{1F600}".repeat(600);
	controller.onEvent({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: astral }] },
	});
	controller.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: astral } });
	controller.bind({ abort: () => {} } as unknown as PiRpcSession);
	const screen: string[][] = [];
	const ui = {
		select: async (_title: string, options: string[]) => {
			screen.push(options);
			return "Detach";
		},
		input: async () => undefined,
		notify: () => {},
	};
	await handler("", { mode: "tui", ui });
	const view = (screen[0] ?? []).filter((option) => option.startsWith("· "));
	// 20 retained lines plus the partial row the view appends.
	assert.equal(view.filter((line) => line.startsWith("· assistant: ")).length, 20);
	// 26 lines were pushed (25 numbered, then the astral one), so the oldest
	// retained is line-6 and everything before it has fallen out.
	assert.equal(
		view.some((line) => line === "· assistant: line-6"),
		true,
	);
	assert.equal(
		view.some((line) => line === "· assistant: line-5" || line === "· assistant: line-0"),
		false,
	);
	const clipped = view.find((line) => line.includes("\u{1F600}") && line.startsWith("· assistant: "));
	assert.ok(clipped);
	assert.equal([...clipped.slice("· assistant: ".length)].length, 512);
	const partial = view.find((line) => line.startsWith("· partial: "));
	assert.ok(partial);
	assert.equal([...partial.slice("· partial: ".length)].length, 512);
	controller.end();
});

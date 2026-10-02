/* Operator-only Pi session view and control. This in-memory hub has no
 * session entry, audit, result, or model-visible tool-update writer.
 * Detach discards only the TUI view; stdout remains continuously drained.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiRpcEvent, PiRpcSession } from "./pi-rpc.ts";

const MAX_LINES = 20;
const MAX_LINE_POINTS = 512;
function clip(value: string): string {
	return [...value]
		.slice(-MAX_LINE_POINTS)
		.map((character) => {
			const point = character.codePointAt(0) ?? 0;
			return point < 32 || (point >= 127 && point <= 159) ? " " : character;
		})
		.join("");
}
interface Active {
	id: string;
	lines: string[];
	partial: string;
	session?: PiRpcSession;
}
const active = new Map<string, Active>();

export function beginPiOperatorSession() {
	const item: Active = { id: randomUUID(), lines: [], partial: "" };
	active.set(item.id, item);
	return {
		onEvent(event: PiRpcEvent): void {
			if (!active.has(item.id)) return;
			if (event.type === "message_update") {
				const delta = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
				if (delta?.type === "text_delta" && typeof delta.delta === "string")
					item.partial = clip(item.partial + delta.delta);
				return;
			}
			let line: string | undefined;
			if (event.type === "message_end") {
				const message = event.message as { role?: unknown; content?: unknown } | undefined;
				if (message?.role === "assistant" && Array.isArray(message.content)) {
					const text = message.content
						.flatMap((block: unknown) =>
							typeof block === "object" && block !== null && "text" in block && typeof block.text === "string"
								? [block.text]
								: [],
						)
						.join(" ");
					line = `assistant: ${clip(text)}`;
					item.partial = ""; // completion supersedes deltas
				}
			} else if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
				const name = typeof event.toolName === "string" ? clip(event.toolName) : "tool";
				line = `${event.type === "tool_execution_start" ? "tool started" : "tool ended"}: ${name}`;
			}
			if (line !== undefined) {
				item.lines.push(line);
				if (item.lines.length > MAX_LINES) item.lines.shift();
			}
		},
		bind(session: PiRpcSession): void {
			item.session = session;
		},
		end(): void {
			active.delete(item.id);
			item.lines.length = 0;
			item.partial = "";
			item.session = undefined;
		},
	};
}

export function registerPiOperatorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("delegate", {
		description: "Attach to a running Pi delegate (operator-only view and controls)",
		handler: async (_arg, ctx) => {
			if (ctx.mode !== "tui") return;
			const entries = [...active.values()].filter((item) => item.session !== undefined);
			if (entries.length === 0) {
				ctx.ui.notify("No running Pi delegate", "info");
				return;
			}
			const id =
				entries.length === 1
					? entries[0].id
					: await ctx.ui.select(
							"Attach to delegate",
							entries.map((item) => item.id),
						);
			if (id === undefined) return;
			const item = active.get(id);
			if (item?.session === undefined) return;
			const session = item.session;
			for (;;) {
				if (!active.has(id)) return;
				const view = [...item.lines, ...(item.partial ? [`partial: ${item.partial}`] : [])];
				const options = [
					"Refresh",
					"Steer",
					"Follow up",
					"Clear queue",
					"Abort",
					"Detach",
					...view.map((line) => `· ${line}`),
				];
				const action = await ctx.ui.select("Pi delegate (events are operator-only)", options);
				if (action === undefined || action === "Detach") return;
				if (action === "Abort") {
					session.abort();
					return;
				}
				if (action === "Clear queue") {
					await session.clearQueue();
					continue;
				}
				if (action === "Steer" || action === "Follow up") {
					const text = await ctx.ui.input(action, "Operator message to delegate");
					if (text !== undefined && text.length > 0)
						await session.command(action === "Steer" ? "steer" : "follow_up", text);
				}
			}
		},
	});
}

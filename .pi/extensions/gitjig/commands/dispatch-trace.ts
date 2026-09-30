/**
 * The /dispatch-trace command — the one sanctioned operator reader of a
 * retained delegate trace (SPEC §4.9 *The sanctioned retained-trace reader*,
 * #263; §4.8 rung 1, because it takes a bounded state read that must not
 * depend on a model's cooperation).
 *
 * TUI only. Outside the terminal UI the handler returns before splitting,
 * validating or reading anything: RPC forwards notifications to a client
 * process that may itself be an agent harness, so it gets one fixed notice
 * and never trace content. The command writes no session message or entry,
 * returns no tool result, and puts trace content only in one terminal custom
 * component the operator dismisses.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { canonicalTraceId, readRetainedTrace, type TraceRead } from "../dispatch/trace-reader.ts";

export const DISPATCH_TRACE_NOTICES = Object.freeze({
	rpc: "/dispatch-trace is available only in the terminal UI",
	usage: "usage: /dispatch-trace <trace id>",
	missing: "no retained trace for that identifier",
	unavailable: "that retained trace is unavailable",
});

/** Split on ASCII whitespace only; exactly one canonical token is accepted. */
export function parseTraceId(args: string): string | undefined {
	const tokens = args.split(/[\t\n\v\f\r ]+/).filter((token) => token.length > 0);
	return tokens.length === 1 && canonicalTraceId(tokens[0]) ? tokens[0] : undefined;
}

export function registerDispatchTraceCommand(
	pi: ExtensionAPI,
	stateRoot: string,
	read: (stateRoot: string, id: string) => TraceRead = readRetainedTrace,
): void {
	pi.registerCommand("dispatch-trace", {
		description:
			"Show one retained delegate trace in the terminal UI by the identifier on an expanded dispatch row: " +
			"/dispatch-trace <trace id>. Operator-only and read-only.",
		handler: async (args: string, ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.mode === "rpc" && ctx.hasUI) ctx.ui.notify(DISPATCH_TRACE_NOTICES.rpc, "warning");
				return;
			}
			const id = parseTraceId(args);
			if (id === undefined) {
				ctx.ui.notify(DISPATCH_TRACE_NOTICES.usage, "error");
				return;
			}
			const trace = read(stateRoot, id);
			if (trace.outcome !== "rendered") {
				ctx.ui.notify(DISPATCH_TRACE_NOTICES[trace.outcome], "warning");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
				// Exactly the bounded rendering; any key dismisses it.
				const text = new Text(theme.fg("toolOutput", trace.text), 1, 0);
				return {
					render: (width: number) => text.render(width),
					invalidate: () => text.invalidate(),
					handleInput: () => done(undefined),
				};
			});
		},
	});
}

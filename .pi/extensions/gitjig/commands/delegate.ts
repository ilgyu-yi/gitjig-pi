/**
 * The /delegate command — the operator's attachment to a running Pi delegate
 * (SPEC §4.9's opt-in Pi clause, #370/#424; §4.8 rung 1, because its controls
 * are operator acts that must not depend on a model's cooperation).
 *
 * TUI only. Outside the terminal UI the handler returns before reading the
 * hub, showing nothing and offering no control: a JSON, print or RPC session
 * may forward to a client that is itself an agent harness.
 *
 * It reads part 6's operator event hub only through what the hub exports —
 * the live identifiers, the bounded rendered rows, and the named control set —
 * and holds nothing of a session's own: no observer slot, no subscription, no
 * lifecycle read. So attaching never pauses a deadline, detaching never stops
 * the draining, and an act cannot reach a session that has ended, because the
 * controls are fetched again before each one.
 *
 * Nothing it observes or receives is published. Steer and follow-up text
 * crosses to the child, which is what those acts are, and nowhere else. The
 * command writes no session message or entry, no audit record, no tool result
 * and no trace, and states no count of operator acts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { livePiOperatorIds, piOperatorControls, piOperatorView } from "../dispatch/pi-operator.ts";

export const DELEGATE_NOTICES = Object.freeze({
	none: "No running Pi delegate",
	ended: "That Pi delegate has ended",
});

/** The actions an attached operator chooses from, before the rows it is shown. */
export const DELEGATE_ACTIONS = Object.freeze(["Refresh", "Steer", "Follow up", "Clear queue", "Abort", "Detach"]);

/** The view's own mark on a rendered row, so a row can never read as an action. */
const VIEW_ROW = "· ";

export function registerDelegateCommand(pi: ExtensionAPI): void {
	pi.registerCommand("delegate", {
		description:
			"Attach to a running Pi delegate in the terminal UI: an operator-only view with steer, follow-up, " +
			"queue-clear, detach and abort. Nothing it shows reaches the model, the dispatch result or any record.",
		handler: async (_args: string, ctx) => {
			if (ctx.mode !== "tui") return;
			const ids = livePiOperatorIds();
			if (ids.length === 0) {
				ctx.ui.notify(DELEGATE_NOTICES.none, "info");
				return;
			}
			const id = ids.length === 1 ? ids[0] : await ctx.ui.select("Attach to delegate", ids);
			// Only an identifier the hub listed is ever acted on.
			if (id === undefined || !ids.includes(id)) return;
			for (;;) {
				if (piOperatorControls(id) === undefined) {
					ctx.ui.notify(DELEGATE_NOTICES.ended, "info");
					return;
				}
				const rows = piOperatorView(id).map((row) => `${VIEW_ROW}${row}`);
				const action = await ctx.ui.select("Pi delegate (events are operator-only)", [...DELEGATE_ACTIONS, ...rows]);
				// A cancelled choice leaves exactly as Detach does: no act at all.
				if (action === undefined || action === "Detach") return;
				let text: string | undefined;
				if (action === "Steer" || action === "Follow up") {
					text = await ctx.ui.input(action, "Operator message to the delegate");
					if (text === undefined || text.length === 0) continue;
				} else if (action !== "Clear queue" && action !== "Abort") {
					// Refresh, or a row: read the view again.
					continue;
				}
				// The controls are fetched again for the act itself, so a session that
				// ended while the operator chose receives nothing.
				const controls = piOperatorControls(id);
				if (controls === undefined) {
					ctx.ui.notify(DELEGATE_NOTICES.ended, "info");
					return;
				}
				if (action === "Abort") {
					controls.abort();
					return;
				}
				if (action === "Clear queue") await controls.clearQueue();
				else if (text !== undefined) await controls.command(action === "Steer" ? "steer" : "follow_up", text);
			}
		},
	});
}

/* Operator-only Pi session event hub. This in-memory hub has no session
 * entry, audit, result, or model-visible tool-update writer. Draining never
 * depends on anyone observing it: events are reduced here for the lifetime of
 * the child whether or not a view is attached, and a view's departure
 * discards only what it was rendering.
 *
 * The bounds below are stated over what an operator would SEE, which is the
 * only thing a bound on a view can mean: the partial row counts against the
 * row cap because it is rendered beside the others, and the code-point cap
 * applies to the composed row including this module's own prefix, not to the
 * delegate text before one is added (#420).
 *
 * The delegate's share of a row is what gives way, never the local label. A
 * bound applied to the composed row from the right would drop the prefix off
 * a long message and leave delegate text standing where a trusted label is
 * read — so each row is composed as a fixed local prefix plus the delegate
 * text bounded to what remains.
 */
import { randomUUID } from "node:crypto";
import { quoted } from "../quote.ts";
import type { PiRpcEvent, PiRpcSession } from "./pi-rpc.ts";

/**
 * What a view may do to a running delegate, named positively because the set
 * is settled: explicit steer and follow-up (`command`, closed over exactly
 * those two), clear queue, and abort. §4.9 lists no other operator act.
 * Reading progress is `piOperatorView`'s plane, and whether a session is still
 * live is this hub's own answer, since an ended session has no controls, so the
 * session's lifecycle reads and its settle wait are not a view's either (#424).
 * Three further capabilities the session has are deliberately absent (#420):
 *
 * - `attach`/`detach`: the supervisor has ONE observer slot and this hub holds
 *   it for the child's whole life. A view that could take it would stop the
 *   draining this hub exists to do, exactly while someone was watching. Views
 *   read `piOperatorView`; they do not subscribe.
 * - `prompt`: a second send is not an operator act. §1.7's shared one-retry
 *   state is the only automatic second send, and this transport adds none.
 * - `close`: ending the child's input is the runner's own lifecycle step,
 *   taken after the settle wait. A view that closed early would cut off the
 *   submission the run is waiting for; a view that wants to stop a delegate
 *   aborts it, which is the act §4.9 gives it.
 */
export type PiOperatorControls = Pick<PiRpcSession, "command" | "clearQueue" | "abort">;

/** Rendered rows an operator may see at once, the partial row included. */
export const MAX_VIEW_ROWS = 20;
/** Code points in one rendered row, this module's own prefix included. */
export const MAX_ROW_POINTS = 512;

/** The view's own prefix for the one uncompleted row, counted in its bound. */
const PARTIAL_PREFIX = "partial: ";

/**
 * Delegate text, made inert through the repository's one escaper and then
 * bounded. The escaper owns which classes are inert — C0 and C1, the line and
 * paragraph separators, and the bidi controls — so this module consumes that
 * rule instead of restating a narrower one of its own (§3.11): a row that
 * replaced only C0 would still let a delegate push text onto a line of its
 * own, or reverse what an operator reads (#420).
 */
function clip(value: string, points: number): string {
	return [...quoted(value)].slice(-Math.max(0, points)).join("");
}

/** One rendered row: the local label in full, the delegate's text bounded. */
function row(prefix: string, text: string): string {
	return `${prefix}${clip(text, MAX_ROW_POINTS - [...prefix].length)}`;
}
interface Active {
	id: string;
	lines: string[];
	partial: string;
	session?: PiOperatorControls;
}
const active = new Map<string, Active>();

/**
 * How many sessions are live. Read-only: it is what makes a runner's teardown
 * observable from outside without exposing a session or its text.
 */
export function livePiOperatorSessions(): number {
	return active.size;
}

/**
 * The identifiers of the live sessions a view can attach to: those with bound
 * controls, in the order they began. With the count above, this is all this
 * module tells anyone about its registry. An identifier is the hub's own
 * random UUID and carries no delegate text; a session begun but not yet bound
 * has nothing to attach to, and an ended one is gone (#424).
 */
export function livePiOperatorIds(): string[] {
	return [...active.values()].flatMap((item) => (item.session === undefined ? [] : [item.id]));
}

/** The controls a view may use on one live session, if it is still running. */
export function piOperatorControls(id: string): PiOperatorControls | undefined {
	return active.get(id)?.session;
}

/**
 * The rows an attached view would render, in order, bounded as a whole: the
 * partial row is one of them, so the cap counts it rather than letting a
 * twenty-first row ride beside twenty.
 */
export function piOperatorView(id: string): string[] {
	const item = active.get(id);
	if (item === undefined) return [];
	const rows = [...item.lines, ...(item.partial.length > 0 ? [row(PARTIAL_PREFIX, item.partial)] : [])];
	return rows.slice(-MAX_VIEW_ROWS);
}

export function beginPiOperatorSession() {
	const item: Active = { id: randomUUID(), lines: [], partial: "" };
	active.set(item.id, item);
	return {
		/** This session's own identity, so a caller's teardown is its own. */
		id: item.id,
		onEvent(event: PiRpcEvent): void {
			if (!active.has(item.id)) return;
			if (event.type === "message_update") {
				const delta = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
				// Clipped to leave room for the `partial: ` prefix the view adds,
				// so the rendered row stays inside the same bound as any other.
				// Kept raw and bounded here, made inert when the row is rendered:
				// escaping each delta as it arrives would escape the escapes.
				if (delta?.type === "text_delta" && typeof delta.delta === "string")
					item.partial = [...(item.partial + delta.delta)].slice(-MAX_ROW_POINTS).join("");
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
					line = row("assistant: ", text);
					item.partial = ""; // completion supersedes deltas
				}
			} else if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
				const name = typeof event.toolName === "string" ? event.toolName : "tool";
				line = row(event.type === "tool_execution_start" ? "tool started: " : "tool ended: ", name);
			}
			if (line !== undefined) {
				// Already composed within the bound by `row`, prefix included.
				item.lines.push(line);
				if (item.lines.length > MAX_VIEW_ROWS) item.lines.shift();
			}
		},
		bind(session: PiRpcSession): void {
			// Bound as the settled control set alone, built by naming what a view
			// may do rather than by removing what it may not: a capability added
			// to the session later does not reach a view by default.
			item.session = {
				command: (type, message) => session.command(type, message),
				clearQueue: () => session.clearQueue(),
				abort: () => session.abort(),
			};
		},
		end(): void {
			active.delete(item.id);
			item.lines.length = 0;
			item.partial = "";
			item.session = undefined;
		},
	};
}

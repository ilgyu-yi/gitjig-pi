/**
 * The /ship command — the AC-closeout caller-side composition (SPEC §4.8
 * rung 1; a call site of the predicate the §3.3 `ac-closeout` row owns).
 *
 * No merge is performed and no network is reached. The command accepts the
 * whitespace-split fact `ac=closed`, records only whether that caller-supplied
 * fact satisfies closeout, and leaves the platform-held AC state and every
 * landing decision on their owning surfaces.
 *
 * After the entry is appended the handler triggers one empty custom-message
 * turn and awaits idle. The turn makes a command-only headless run durable
 * without putting caller-held content into the session.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerShipCommand(pi: ExtensionAPI, _repoRoot: string): void {
	pi.registerCommand("ship", {
		description:
			"Compose the AC-closeout caller-side check over a caller-supplied fact: " +
			"/ship ac=closed. It cannot decide offline the platform-held AC state and never performs a landing.",
		handler: async (args: string, ctx) => {
			const facts = new Map<string, string>();
			for (const token of args.split(/\s+/)) {
				const eq = token.indexOf("=");
				if (eq > 0) facts.set(token.slice(0, eq), token.slice(eq + 1));
			}
			const acClosure = facts.get("ac") === "closed" ? "asserted" : "unsatisfied";
			const composition = acClosure === "asserted" ? "satisfied" : "unsatisfied";
			pi.appendEntry("gitjig-ship", { composition, acClosure });
			pi.sendMessage({ customType: "gitjig-spine-turn", content: [], display: false }, { triggerTurn: true });
			await ctx.waitForIdle();
		},
	});
}

/**
 * `/freshness` — the on-demand installed-asset freshness measurement (SPEC
 * §4.5, §5.9; #365). It reads, evaluates and renders; it never selects a
 * revision, provisions, writes a pin or aborts the session.
 *
 * Warning-surface roster: EXEMPT — every rendered line is a fixed string.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { CarriedObservation } from "../install/classifier.ts";
import {
	FRESHNESS_STATES,
	type FreshnessResult,
	measureFreshness,
	PROVISION_COMMAND,
	RELOAD_COMMAND,
	sessionClone,
} from "../install/freshness.ts";

export const FRESHNESS_MESSAGE = "gitjig-freshness";

/** The help: the measurement's false-positive shapes, and each state's recovery token, pointing to SPEC for what the recovery does. */
export const FRESHNESS_HELP = [
	"/freshness compares the committed pin, the verified installed-pin record and this clone's carried files.",
	"It runs only when asked, reads under a 2-second budget, caches nothing, and changes nothing.",
	"",
	"Known false positives:",
	"- an intended local edit to a carried file reports placement-mismatch (true per SPEC 4.5, perhaps unwanted);",
	"- a provision running at the same time reports placement-mismatch until it advances the record;",
	"- a carried data file (a .json policy, say) edited when this process loaded and corrected since reports",
	"  session-stale, though no code the session imported changed.",
	"",
	`placement-mismatch: run ${PROVISION_COMMAND}. What its provision run converges, refuses or leaves alone`,
	"is SPEC 4.6 (Installed-pin authority); the launcher's own stop causes are SPEC 4.2, their exit statuses SPEC 4.7.",
	`session-stale: run ${RELOAD_COMMAND}; the files are current, but the extension tree differed when this process`,
	"last loaded it.",
	`cannot-measure: run ${PROVISION_COMMAND}, or ${RELOAD_COMMAND} when only the load-time capture is missing.`,
	"A measurement whose reads pass the 2-second budget never reads current.",
].join("\n");

/** One content-free line: the state and its recovery token, never a path, operand or error. */
export function freshnessLine(outcome: FreshnessResult): string {
	return outcome.recovery === null
		? `gitjig freshness: ${outcome.state}`
		: `gitjig freshness: ${outcome.state} — run ${outcome.recovery} (see /freshness help)`;
}

function admitted(details: unknown): FreshnessResult | undefined {
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const { state, recovery } = details as { state?: unknown; recovery?: unknown };
	if (Object.keys(details).sort().join(",") !== "recovery,state") return undefined;
	if (!FRESHNESS_STATES.includes(state as FreshnessResult["state"])) return undefined;
	if (recovery !== null && recovery !== PROVISION_COMMAND && recovery !== RELOAD_COMMAND) return undefined;
	return { state, recovery } as FreshnessResult;
}

export function registerFreshnessCommand(
	pi: ExtensionAPI,
	repoRoot: string,
	capture: CarriedObservation | undefined,
): void {
	pi.registerMessageRenderer(FRESHNESS_MESSAGE, (message, options) => {
		if (message.details === "help") return new Text(FRESHNESS_HELP, options.outputPad, 0);
		const outcome = admitted(message.details);
		return new Text(
			outcome === undefined ? "[invalid gitjig freshness record]" : freshnessLine(outcome),
			options.outputPad,
			0,
		);
	});
	pi.registerCommand("freshness", {
		description: "Measure installed-asset freshness on demand (SPEC 4.5); `/freshness help` names its shapes.",
		handler: async (args, ctx) => {
			const help = args.trim() !== "";
			// The session's own clone, from the cwd Pi loads it in (a resumed session
			// keeps its recorded one), compared with the self-located root only.
			const cwd = (ctx as { cwd?: unknown } | undefined)?.cwd;
			const session = typeof cwd === "string" ? sessionClone(cwd) : undefined;
			const outcome = help ? undefined : measureFreshness(repoRoot, capture, Date.now, session);
			pi.sendMessage(
				{
					customType: FRESHNESS_MESSAGE,
					content: outcome === undefined ? FRESHNESS_HELP : freshnessLine(outcome),
					display: true,
					details: outcome === undefined ? "help" : { state: outcome.state, recovery: outcome.recovery },
				},
				{ triggerTurn: false },
			);
		},
	});
}

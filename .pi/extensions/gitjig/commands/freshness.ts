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

/** The help: the measurement's false-positive shapes and what the recovery does, shape by shape. */
export const FRESHNESS_HELP = [
	"/freshness compares the committed pin, the verified installed-pin record and this clone's carried files.",
	"It runs only when asked, reads under a 2-second budget, caches nothing, and changes nothing.",
	"",
	"Known false positives:",
	"- an intended local edit to a carried file reports placement-mismatch (true per SPEC 4.5, perhaps unwanted);",
	"- a provision running at the same time reports placement-mismatch until it advances the record;",
	"- a case- or normalization-insensitive filesystem can report a rename as placement-mismatch;",
	"- a carried file the runtime reads from disk at each use rather than importing (a .json policy, or a file",
	"  it copies, say) that was edited when this process loaded and corrected since reports session-stale,",
	"  though the session already uses it.",
	"",
	`placement-mismatch: run ${PROVISION_COMMAND}. Its provision run converges when:`,
	"- every handed-over file the new pin lists (.github/**, .githooks/**, changelog_unreleased/TEMPLATE.md) is",
	"  exactly the bytes the new pin lists, and a handed-over file only the old pin lists is absent;",
	"- under a present installed-pin record, every carried file both pins list is exactly the old or the new",
	"  bytes, one only the new pin lists is absent or exactly the new bytes, and one only the old pin lists is",
	"  exactly the old bytes or absent;",
	"- under an absent record, every carried file the new pin lists is absent or exactly the new bytes.",
	"It refuses (provision-refused) otherwise, on a malformed record, and on a changed source or class transition.",
	"It also refuses a record it cannot read, a directory included, and a listed carried file it cannot read; it reads a",
	"linked record through its link, and a dangling one as absent.",
	"It refuses as well when .gitjig, or any directory on a carried path (.pi/extensions, .pi/prompts or one",
	"below them), is a link, and when a directory on a handed-over path (.githooks, changelog_unreleased, or one",
	"below .github other than .github/bin) is a link.",
	"A carried file neither pin lists is left alone, so it keeps reporting until removed.",
	"Before running it: restore a handed-over file to the bytes the new pin lists (from HEAD, unless an edit to",
	"it was committed, which must be reverted), and remove one only the old pin lists; remove a",
	"carried file neither pin lists; under a present record restore each listed carried file to the bytes",
	"above, or else remove .gitjig/installed-pin.json and every carried file that is not exactly the new bytes;",
	"make an unreadable record or carried file readable, or else remove the record and the unreadable file and",
	"take the absent-record step; remove a malformed record, or a directory in its place, then take the",
	"absent-record step; replace any such linked directory with a real directory holding its files; under an",
	"absent record remove every carried",
	"file that is not exactly the new bytes. Removing an edited carried file both pins list, alone, still refuses.",
	"",
	"The launcher can also stop before provision, or report after it; its one-line cause names which:",
	"invalid-input (exit 64), snapshot-identity-mismatch (exit 65), source-unavailable (exit 69),",
	"temporary-storage-unavailable (exit 73) or cleanup-failed (exit 74). SPEC 4.2 defines each, and /freshness",
	"does not diagnose them. invalid-input includes checkouts the launcher never provisions: a linked .pi,",
	".github or .github/bin, a linked worktree (its .git a file), and a clone sharing another's objects.",
	"",
	`session-stale: run ${RELOAD_COMMAND}; the files are current, but the extension tree differed when this process`,
	"first loaded it.",
	"Prompts take no part in it: a prompt edited and restored while a session runs is not seen.",
	`cannot-measure: run ${PROVISION_COMMAND}, or ${RELOAD_COMMAND} when only the load-time capture is missing. When`,
	"a carried file cannot be read, or the carried files pass 64 MiB, make it readable or remove it first if",
	"neither pin lists it: provision leaves such a file alone, and the measurement would stay cannot-measure.",
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

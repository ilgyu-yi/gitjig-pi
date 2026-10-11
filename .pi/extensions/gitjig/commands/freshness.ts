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
} from "../install/freshness.ts";

export const FRESHNESS_MESSAGE = "gitjig-freshness";

/** The help: the measurement's false-positive shapes and what the recovery does, shape by shape. */
export const FRESHNESS_HELP = [
	"/freshness compares the committed pin, the verified installed-pin record and this clone's carried files.",
	"It runs only when asked, reads under a 2-second budget, caches nothing, and changes nothing.",
	"",
	"Known false positives:",
	"- an intended local edit to a carried file reports placement-mismatch (true per SPEC 4.5, perhaps unwanted);",
	"- a provision running at the same time reports cannot-measure;",
	"- a case- or normalization-insensitive filesystem can report a rename as placement-mismatch.",
	"",
	`placement-mismatch: run ${PROVISION_COMMAND}. It converges when every handed-over file the pin lists`,
	"(.github/**, .githooks/**, changelog_unreleased/TEMPLATE.md) is exactly its committed bytes and either the",
	"installed-pin record is present and every listed carried file is exactly the old or the new bytes, or the",
	"record is absent and every carried file is absent or exactly the new bytes. It refuses (provision-refused,",
	"exit 70) otherwise: a handed-over file differing from or missing against its committed bytes, or one only the",
	"old pin lists still present; under a present record a carried file edited, foreign, renamed, a link, not a",
	"regular file, or missing while both pins list it; under an absent record an older, edited, foreign, linked",
	"or non-regular carried file; a malformed record; a changed source or class transition. A carried file",
	"neither pin lists is left alone, so it keeps reporting.",
	"First: restore a handed-over file from HEAD (remove one only the old pin lists); remove a carried file",
	"neither pin lists; under a present record restore every listed carried file to the exact old or new",
	"bytes, or else remove .gitjig/installed-pin.json and every carried file that is not exactly the new bytes;",
	"remove a malformed record, then do the absent-record step; under an absent record remove every carried",
	"file that is not exactly the new bytes. Removing an edited carried file both pins list, alone, still refuses.",
	"The launcher itself refuses before provision with invalid-input (exit 64), for example when the working",
	"pin differs from HEAD or .git is not a directory, and with source-unavailable (exit 69).",
	"",
	`session-stale: run ${RELOAD_COMMAND}; the files are current but this session loaded others.`,
	`cannot-measure: run ${PROVISION_COMMAND}, or ${RELOAD_COMMAND} when only the load-time capture is missing.`,
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
		handler: async (args) => {
			const help = args.trim() !== "";
			const outcome = help ? undefined : measureFreshness(repoRoot, capture);
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

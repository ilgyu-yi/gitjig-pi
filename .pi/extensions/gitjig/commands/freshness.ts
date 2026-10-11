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
	`placement-mismatch: run ${PROVISION_COMMAND}. Its provision run converges when:`,
	"- every handed-over file the new pin lists (.github/**, .githooks/**, changelog_unreleased/TEMPLATE.md) is",
	"  exactly its committed bytes, and a handed-over file only the old pin lists is absent;",
	"- under a present installed-pin record, every carried file both pins list is exactly the old or the new",
	"  bytes, one only the new pin lists is absent or exactly the new bytes, and one only the old pin lists is",
	"  exactly the old bytes or absent;",
	"- under an absent record, every carried file the new pin lists is absent or exactly the new bytes.",
	"It refuses (provision-refused) otherwise, on a malformed record, and on a changed source or class transition.",
	"A carried file neither pin lists is left alone, so it keeps reporting until removed.",
	"Before running it: restore a handed-over file from HEAD, and remove one only the old pin lists; remove a",
	"carried file neither pin lists; under a present record restore each listed carried file to the bytes",
	"above, or else remove .gitjig/installed-pin.json and every carried file that is not exactly the new bytes;",
	"remove a malformed record, then take the absent-record step; under an absent record remove every carried",
	"file that is not exactly the new bytes. Removing an edited carried file both pins list, alone, still refuses.",
	"The launcher can also refuse before provision: invalid-input (exit 64), for example when the working pin",
	"differs from HEAD or .git is not a directory, source-unavailable (exit 69), snapshot-identity-mismatch (exit 65) or temporary-storage-unavailable (exit 73); cleanup-failed (exit 74) can follow even a completed provision run.",
	"For those: 64, commit or restore the pin and repair .git; 69, reach the pinned source and check that it",
	"serves the pinned revision; 65, the fetched snapshot failed its checks (its HEAD, origin, alternates,",
	"working files, scope file or provision entry), so run it again, and if it repeats the pinned revision is",
	"not a usable gitjig snapshot; 73, make the temporary directory writable; 74, remove the leftover",
	"gitjig-acquire-* directory under the temporary directory, then run it again.",
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

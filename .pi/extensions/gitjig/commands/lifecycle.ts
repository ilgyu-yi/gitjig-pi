/**
 * The /lifecycle command — the on-demand request of the #347 lifecycle
 * projection (SPEC §5.9; §4.8 rung 1, because it evaluates the handed-over
 * engine's admission over a platform read, not a model's cooperation).
 *
 * The operator addresses exactly one subject, `issue=<n>` or `pr=<n>`, in
 * the current repository. The result is shown only in the operator's status
 * slot. The command appends no session entry, sends no message and triggers
 * no turn, so no record body can reach a model; a UI-less run makes no
 * platform read and no status call. It never writes, clears, authorizes or
 * blocks any act.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LifecycleProjection, type LifecycleTarget } from "../lifecycle-projection.ts";
import type { SessionSurface } from "../session-surface.ts";

const USAGE = "lifecycle refused: name exactly one subject as issue=<number> or pr=<number>";
const SILENT = "lifecycle: no projection is available for that subject (unavailable, invalid, or stale evidence)";

/** Parse the closed argument grammar; anything else is refused. */
export function parseLifecycleTarget(args: string): LifecycleTarget | undefined {
	const tokens = args
		.trim()
		.split(/\s+/)
		.filter((token) => token.length > 0);
	if (tokens.length !== 1) return undefined;
	const match = /^(issue|pr)=([1-9][0-9]{0,15})$/.exec(tokens[0]);
	if (match === null) return undefined;
	const number = Number(match[2]);
	if (!Number.isSafeInteger(number)) return undefined;
	return { kind: match[1] === "pr" ? "pull" : "issue", number };
}

export function registerLifecycleCommand(
	pi: ExtensionAPI,
	repoRoot: string,
	surface: SessionSurface | undefined,
	projection: LifecycleProjection | undefined = surface === undefined
		? undefined
		: new LifecycleProjection(repoRoot, surface),
): void {
	pi.registerCommand("lifecycle", {
		description:
			"Show awaiting-author, blocked and handoff lifecycle states for one explicitly addressed subject in the " +
			"operator status line: /lifecycle issue=<n> or /lifecycle pr=<n>. Read-only; it never changes any record or act.",
		handler: async (args: string, ctx) => {
			if (!ctx.hasUI || projection === undefined) return;
			const target = parseLifecycleTarget(args);
			if (target === undefined) {
				ctx.ui.notify(USAGE, "error");
				return;
			}
			const outcome = await projection.request(target);
			if (outcome === "silent") ctx.ui.notify(SILENT, "info");
		},
	});
}

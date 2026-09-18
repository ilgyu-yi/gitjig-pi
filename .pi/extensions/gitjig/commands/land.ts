/** Warning-surface roster: EXEMPT — the command persists only fixed outcome arms and closed mode values. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPlatformLanding, platformLandingEffects } from "../landing/platform.ts";
import { executeGuardedLanding } from "../landing/service.ts";
import type { ResolvedModes } from "../modes.ts";

function facts(args: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const token of args.split(/\s+/)) {
		const index = token.indexOf("=");
		if (index > 0 && !result.has(token.slice(0, index))) result.set(token.slice(0, index), token.slice(index + 1));
		else if (index > 0) result.set("duplicate", token.slice(0, index));
	}
	return result;
}

export function registerLandCommand(pi: ExtensionAPI, repoRoot: string, modes: ResolvedModes): void {
	pi.registerCommand("land", {
		description:
			"Guarded exact-head landing: /land repo=owner/name pr=123 [host=github.com]. Refuses until live Phase-4 rulesets are measurable.",
		handler: async (args: string, ctx) => {
			const input = facts(args);
			const repository = input.get("repo") ?? "";
			const pr = Number(input.get("pr"));
			const host = input.get("host") ?? "github.com";
			if (input.has("duplicate")) {
				pi.appendEntry("gitjig-land", { outcome: "refused", arm: "argument-duplicate", modes });
				return;
			}
			const now = new Date().toISOString();
			const loaded = await loadPlatformLanding(host, repository, pr, repoRoot, now);
			if (!loaded.snapshot || !loaded.engine || !loaded.consumerId) {
				pi.appendEntry("gitjig-land", { outcome: "refused", arm: loaded.arm, modes });
				return;
			}
			const result = await executeGuardedLanding(
				{
					mode: modes.mergeMode,
					snapshot: loaded.snapshot,
					consumerId: loaded.consumerId,
					now,
					engine: loaded.engine,
				},
				platformLandingEffects(host, repository, pr, repoRoot, loaded.consumerId),
			);
			pi.appendEntry("gitjig-land", { ...result, modes });
			pi.sendMessage({ customType: "gitjig-spine-turn", content: [], display: false }, { triggerTurn: true });
			await ctx.waitForIdle();
		},
	});
}

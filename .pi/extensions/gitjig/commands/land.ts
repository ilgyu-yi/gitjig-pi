/** Warning-surface roster: EXEMPT — the command persists only closed landing outcome tokens. */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPlatformLanding, platformLandingEffects } from "../landing/platform.ts";
import {
	type BlockerClass,
	executeLanding,
	type OperatorInstruction,
	operatorConfirmation,
} from "../landing/service.ts";
import type { ResolvedModes } from "../modes.ts";

function facts(args: string): Map<string, string> | undefined {
	const result = new Map<string, string>();
	for (const token of args.split(/\s+/).filter(Boolean)) {
		const index = token.indexOf("=");
		if (index <= 0 || result.has(token.slice(0, index))) return undefined;
		result.set(token.slice(0, index), token.slice(index + 1));
	}
	return result;
}
function instruction(input: Map<string, string>): OperatorInstruction | undefined {
	const scope = input.get("scope");
	const encoded = input.get("confirm");
	const attemptId = input.get("attempt");
	const operatorInstructionObservedAt = input.get("observed");
	if (!scope && !encoded && !attemptId && !operatorInstructionObservedAt) return undefined;
	if (!scope || !encoded || !attemptId || !operatorInstructionObservedAt)
		return { scope: [], attemptId: "", operatorInstructionObservedAt: "", confirmation: "" };
	let confirmation = "";
	try {
		confirmation = decodeURIComponent(encoded);
	} catch {
		return { scope: [], attemptId: "", operatorInstructionObservedAt: "", confirmation: "" };
	}
	return {
		scope: scope === "all-observed" ? "all-observed" : (scope.split(",").filter(Boolean) as BlockerClass[]),
		attemptId,
		operatorInstructionObservedAt,
		confirmation,
	};
}
export function registerLandCommand(pi: ExtensionAPI, repoRoot: string, modes: ResolvedModes): void {
	pi.registerCommand("land", {
		description:
			"Ordinary-first exact-head landing; use scope=all-observed attempt=<fresh-uuid> observed=<presented-time> confirm=<URL-encoded exact prompt> for one operator-directed attempt.",
		handler: async (args: string, ctx) => {
			const input = facts(args);
			const repository = input?.get("repo") ?? "";
			const pr = Number(input?.get("pr"));
			const host = input?.get("host") ?? "github.com";
			if (!input) {
				pi.appendEntry("gitjig-land", { outcome: "refused", arm: "argument-grammar", modes });
				return;
			}
			const now = new Date().toISOString();
			const reload = () => loadPlatformLanding(host, repository, pr, repoRoot, new Date().toISOString());
			const loaded = await reload();
			if (!loaded.snapshot) {
				pi.appendEntry("gitjig-land", { outcome: "refused", arm: loaded.arm, modes });
				return;
			}
			let result = await executeLanding(
				{ mode: modes.mergeMode, snapshot: loaded.snapshot, now, instruction: instruction(input) },
				platformLandingEffects(host, repository, pr, repoRoot, reload),
			);
			if (result.outcome === "presented") {
				const attemptId = randomUUID();
				result = {
					...result,
					confirmation: operatorConfirmation(loaded.snapshot, result.blockers, attemptId, now),
				};
				pi.appendEntry("gitjig-land", { ...result, attemptId, operatorInstructionObservedAt: now, modes });
			} else pi.appendEntry("gitjig-land", { ...result, modes });
			pi.sendMessage({ customType: "gitjig-spine-turn", content: [], display: false }, { triggerTurn: true });
			await ctx.waitForIdle();
		},
	});
}

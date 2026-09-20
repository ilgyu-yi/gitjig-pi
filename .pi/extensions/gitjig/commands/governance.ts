/** Warning-surface roster: EXEMPT — closed service outcomes are persisted as structured entries. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function governanceRefusalArm(error: unknown): string {
	if (!(error instanceof Error)) return "unknown";
	const property = (error as Error & { arm?: unknown }).arm;
	if (typeof property === "string" && /^[a-z-]+$/.test(property)) return property;
	const shared = /governance (?:platform|service) refused: ([a-z-]+)$/.exec(error.message)?.[1];
	if (shared) return shared;
	return new Set(["argument-grammar", "subcommand", "plan-path", "confirmation-encoding", "confirmation-mismatch"]).has(
		error.message,
	)
		? error.message
		: "unknown";
}

function facts(args: string): Map<string, string> | undefined {
	const out = new Map<string, string>();
	for (const token of args.split(/\s+/).filter(Boolean)) {
		const index = token.indexOf("=");
		if (index < 1 || out.has(token.slice(0, index))) return undefined;
		out.set(token.slice(0, index), token.slice(index + 1));
	}
	return out;
}

interface GovernanceService {
	plan(config: unknown, effects: unknown): Promise<unknown>;
	audit(config: unknown, effects: unknown): Promise<unknown>;
	apply(input: unknown, effects: unknown): Promise<Record<string, unknown>>;
}

export function registerGovernanceCommand(pi: ExtensionAPI, repoRoot: string): void {
	let service: GovernanceService | undefined;
	const presented = new Map<string, { repository: string; planHash: string; confirmation: string }>();
	pi.registerCommand("governance", {
		description:
			"Consult the shared governance engine: action=plan|audit, or action=apply plan=<path>; repeat apply with attempt=<id> confirm=<URL-encoded exact prompt>.",
		handler: async (args, ctx) => {
			const input = facts(args);
			try {
				if (!input) throw new Error("argument-grammar");
				const action = input.get("action");
				const keys = [...input.keys()].sort();
				if (
					((action === "plan" || action === "audit") && keys.join(",") !== "action") ||
					(action === "apply" && !["action,plan", "action,attempt,confirm,plan"].includes(keys.join(",")))
				)
					throw new Error("argument-grammar");
				const load = (path: string) => import(pathToFileURL(join(repoRoot, path)).href);
				const { admitConfirmation, confirmationPresentation, createGovernanceService } = await load(
					".github/workflows/gitjig-governance-service.mjs",
				);
				const { createCliPlatform, readGovernanceConfig, readGovernancePlan } = await load(
					".github/bin/gitjig-governance.mjs",
				);
				service ??= createGovernanceService() as GovernanceService;
				const configPath = join(repoRoot, ".github", "gitjig-governance.json");
				const config = readGovernanceConfig(configPath);
				const platform = createCliPlatform(config, repoRoot);
				if (action === "plan") {
					pi.appendEntry("gitjig-governance", { outcome: "planned", plan: await service.plan(config, platform) });
				} else if (action === "audit") {
					pi.appendEntry("gitjig-governance", { outcome: "audited", audit: await service.audit(config, platform) });
				} else if (action === "apply") {
					const path = input.get("plan");
					if (!path) throw new Error("plan-path");
					const plan = readGovernancePlan(path);
					const attempt = input.get("attempt");
					const encoded = input.get("confirm");
					if (!attempt && !encoded) {
						const id = randomUUID();
						const presentation = confirmationPresentation(config.repository.nameWithOwner, plan);
						presented.set(id, {
							repository: presentation.repository,
							planHash: presentation.planHash,
							confirmation: presentation.confirmation,
						});
						pi.appendEntry("gitjig-governance", { outcome: "presented", attemptId: id, ...presentation });
					} else {
						let confirmation = "";
						try {
							confirmation = decodeURIComponent(encoded ?? "");
						} catch {
							throw new Error("confirmation-encoding");
						}
						const bound = attempt ? presented.get(attempt) : undefined;
						if (!bound || bound.planHash !== plan.planHash || bound.confirmation !== confirmation)
							throw new Error("confirmation-mismatch");
						const admitted = admitConfirmation("pi", confirmation, bound.repository, plan, attempt ?? "");
						presented.delete(attempt as string);
						const result = await service.apply(
							{
								config,
								plan,
								confirmation: admitted,
							},
							platform,
						);
						pi.appendEntry("gitjig-governance", result);
					}
				} else throw new Error("subcommand");
			} catch (error) {
				pi.appendEntry("gitjig-governance", {
					outcome: "refused",
					arm: governanceRefusalArm(error),
				});
			}
			pi.sendMessage({ customType: "gitjig-spine-turn", content: [], display: false }, { triggerTurn: true });
			await ctx.waitForIdle();
		},
	});
}

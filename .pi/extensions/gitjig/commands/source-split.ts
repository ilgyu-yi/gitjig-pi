/** Warning-surface roster: EXEMPT — command entries contain only closed outcome/arm values. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readRepositoryInput } from "./review-round-input.ts";

function facts(args: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const token of args.split(/\s+/u).filter(Boolean)) {
		const at = token.indexOf("=");
		if (at <= 0 || result.has(token.slice(0, at))) result.set("duplicate", token);
		else result.set(token.slice(0, at), token.slice(at + 1));
	}
	return result;
}

export function registerSourceSplitCommand(pi: ExtensionAPI, repoRoot: string): void {
	pi.registerCommand("source-split", {
		description:
			"Apply one exact authorized source-split plan: /source-split repo=owner/name issue=N plan=topology-plan.json [host=github.com]",
		handler: async (args) => {
			const input = facts(args);
			const repository = input.get("repo") ?? "";
			const issue = Number(input.get("issue"));
			const host = input.get("host") ?? "github.com";
			const planBytes = readRepositoryInput(repoRoot, input.get("plan") ?? "");
			let plan: unknown;
			try {
				plan = planBytes === undefined ? undefined : JSON.parse(planBytes);
			} catch {
				plan = undefined;
			}
			if (
				input.has("duplicate") ||
				plan === undefined ||
				[...input.keys()].some((key) => !["repo", "issue", "plan", "host", "duplicate"].includes(key))
			) {
				pi.appendEntry("gitjig-source-split", { outcome: "refused", arm: "subject-invalid" });
				return;
			}
			const { executePlatformTopologySource, loadTopologySourceApplication } = await import(
				"../landing/source-split-platform.ts"
			);
			const loaded = await loadTopologySourceApplication(
				host,
				repository,
				issue,
				new Date().toISOString(),
				repoRoot,
				plan,
			);
			const result = await executePlatformTopologySource(loaded);
			pi.appendEntry("gitjig-source-split", {
				outcome: result.outcome,
				...(result.outcome === "success" ? { replay: result.replay } : { arm: result.arm }),
			});
		},
	});
}

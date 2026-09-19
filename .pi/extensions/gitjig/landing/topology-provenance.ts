/** Warning-surface roster: EXEMPT — trusted topology bytes return a closed module or no value. */
import { join } from "node:path";
import type { BootstrapTopologyEngine } from "./bootstrap.ts";
import { trustedDefaultBranchBytes } from "./provenance.ts";

export async function loadTrustedTopologyEngine(
	repoRoot: string,
	defaultBranchBlobSha: unknown,
): Promise<BootstrapTopologyEngine | undefined> {
	const bytes = trustedDefaultBranchBytes(
		join(repoRoot, ".github/workflows/landing-topology.mjs"),
		defaultBranchBlobSha,
	);
	if (!bytes) return undefined;
	try {
		const module = (await import(
			`data:text/javascript;base64,${bytes.toString("base64")}`
		)) as Partial<BootstrapTopologyEngine>;
		return typeof module.attestLandingTopology === "function" &&
			typeof module.canonicalInstant === "function" &&
			typeof module.encodeLandingTopology === "function"
			? (module as BootstrapTopologyEngine)
			: undefined;
	} catch {
		return undefined;
	}
}

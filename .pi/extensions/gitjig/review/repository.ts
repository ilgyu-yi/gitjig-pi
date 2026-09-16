/**
 * Process capability for repository facts used by review.
 *
 * Warning-surface roster: EXEMPT — every failure is a fixed typed error or
 * undefined result; child and caller-controlled text is never rendered.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { withoutRepoLocatingGitEnv } from "../dispatch/provision.ts";

/**
 * The one process capability for Git facts consumed by the review pipeline.
 * Every child is quiet by construction; callers receive only typed/fixed
 * consequences and never Git's localized diagnostics.
 */
function quietGit(repoRoot: string, args: readonly string[]): string {
	return execFileSync("git", [...args], {
		cwd: repoRoot,
		encoding: "utf8",
		env: withoutRepoLocatingGitEnv(process.env),
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/**
 * The authoritative changed-path read failed before a change surface existed.
 * The fixed limbs suppress localized child output and remain distinct from
 * panel routing refusals.
 */
export class ChangedPathsRefusal extends Error {
	readonly limb: "root-unreadable" | "range-unreadable";
	constructor(limb: "root-unreadable" | "range-unreadable") {
		super(
			limb === "root-unreadable"
				? "changed-path read refused: the supplied repository root cannot be measured as a repository toplevel"
				: "changed-path read refused: the requested revision range cannot be measured; no change surface was produced",
		);
		this.name = "ChangedPathsRefusal";
		this.limb = limb;
	}
}

/** Resolve one caller spelling to the full commit object, without diagnostics. */
export function resolveRepositoryHead(repoRoot: string, ref: string): string | undefined {
	try {
		const head = quietGit(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
		return /^[0-9a-f]{40}$/.test(head) ? head : undefined;
	} catch {
		return undefined;
	}
}

/** Read the authoritative NUL-delimited changed-path set. */
export function readChangedPaths(baseRef: string, headRef: string, repoRoot: string): string[] {
	let toplevel: string;
	try {
		toplevel = quietGit(repoRoot, ["rev-parse", "--show-toplevel"]).trim();
	} catch {
		throw new ChangedPathsRefusal("root-unreadable");
	}
	let physicalTop: string;
	let physicalRoot: string;
	try {
		physicalTop = realpathSync(toplevel);
		physicalRoot = realpathSync(repoRoot);
	} catch {
		throw new ChangedPathsRefusal("root-unreadable");
	}
	if (physicalTop !== physicalRoot) {
		throw new Error(
			"changed-path read: the supplied repository root is a directory inside a repository, not the repository's " +
				"own toplevel — an unpinned read would silently answer about the enclosing repository (§4.7)",
		);
	}
	try {
		return quietGit(repoRoot, ["diff", "--name-only", "-z", "--end-of-options", `${baseRef}...${headRef}`])
			.split("\0")
			.filter((entry) => entry.length > 0);
	} catch {
		throw new ChangedPathsRefusal("range-unreadable");
	}
}

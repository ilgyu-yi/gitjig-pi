/**
 * Exact-revision carried bootstrap entrypoint (#130).
 * Warning-surface roster: EXEMPT — emits fixed terminal tokens and renders no operands.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function git(root: string, args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
	}).trim();
}

export function bootstrap(argv: readonly string[]): number {
	if (argv.length !== 4) return 2;
	const [sourceUrl, revision, targetOperand, snapshotOperand] = argv;
	if (
		!sourceUrl ||
		!revision ||
		!targetOperand ||
		!snapshotOperand ||
		!/^https:\/\/github\.com\/[^/%?#@]+\/[^/%?#@]+(?:\.git)?$/u.test(sourceUrl) ||
		!/^[0-9a-f]{40}$/u.test(revision)
	)
		return 2;
	try {
		const target = realpathSync(targetOperand);
		const snapshot = realpathSync(snapshotOperand);
		if (target === snapshot || realpathSync(git(target, ["rev-parse", "--show-toplevel"])) !== target) return 2;
		if (
			git(snapshot, ["rev-parse", "HEAD"]) !== revision ||
			git(snapshot, ["remote", "get-url", "origin"]) !== sourceUrl
		)
			return 2;
		const entry = join(snapshot, ".pi/extensions/gitjig/install/provision-cli.ts");
		const stats = lstatSync(entry);
		if (!stats.isFile() || stats.isSymbolicLink()) return 2;
		execFileSync(
			process.execPath,
			["--experimental-strip-types", entry, "--target", target, "--source", sourceUrl, "--revision", revision],
			{
				stdio: ["ignore", "inherit", "inherit"],
				env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: "0" },
			},
		);
		return 0;
	} catch {
		return 2;
	}
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]))
	process.exitCode = bootstrap(process.argv.slice(2));

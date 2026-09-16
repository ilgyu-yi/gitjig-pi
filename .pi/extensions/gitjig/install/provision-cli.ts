/**
 * Exact-revision provision entrypoint invoked from the verified disposable snapshot.
 * Warning-surface roster: EXEMPT — emits fixed terminal tokens and renders no operands.
 */
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalProvisionPlatform } from "./local-provision.ts";
import { parsePin } from "./pin.ts";
import { provisionAdopter } from "./provision.ts";

function option(name: string): string | null {
	const at = process.argv.indexOf(name);
	return at >= 0 && at + 1 < process.argv.length ? (process.argv[at + 1] ?? null) : null;
}

export async function main(): Promise<number> {
	const target = option("--target");
	const sourceUrl = option("--source");
	const revision = option("--revision");
	if (!target || !sourceUrl || !revision || !/^[0-9a-f]{40}$/u.test(revision)) return 2;
	const matched = /^https:\/\/github\.com\/([^/%?#@]+)\/([^/%?#@]+?)(?:\.git)?$/u.exec(sourceUrl);
	if (!matched) return 2;
	const targetRoot = resolve(target);
	let committedPinBytes: Buffer;
	let installedPinBytes: Buffer | null;
	try {
		committedPinBytes = readFileSync(join(targetRoot, ".pi/gitjig.pin.json"));
		try {
			installedPinBytes = readFileSync(join(targetRoot, ".gitjig/installed-pin.json"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return 2;
			installedPinBytes = null;
		}
		const pin = parsePin(committedPinBytes.toString("utf8"));
		if (
			pin.source.provider !== "github" ||
			pin.source.host !== "github.com" ||
			pin.source.owner !== matched[1] ||
			pin.source.repository !== matched[2] ||
			pin.revision !== revision
		)
			return 2;
	} catch {
		return 2;
	}
	const result = await provisionAdopter({
		snapshotRoot: fileURLToPath(new URL("../../../../", import.meta.url)),
		targetRoot,
		committedPinBytes,
		installedPinBytes,
		platform: new LocalProvisionPlatform(targetRoot),
	});
	if (result.outcome === "refused") return 2;
	process.stdout.write(`provision: ${result.outcome}\n`);
	return 0;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]))
	process.exitCode = await main();

/** Warning-surface roster: EXEMPT — this pure byte verifier emits no warning or operator text. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function gitBlobOid(bytes: Uint8Array): string {
	return createHash("sha1")
		.update(Buffer.from(`blob ${bytes.byteLength}\0`))
		.update(bytes)
		.digest("hex");
}

export function trustedDefaultBranchBytes(path: string, expectedBlobOid: unknown): Buffer | undefined {
	if (typeof expectedBlobOid !== "string" || !/^[0-9a-f]{40}$/.test(expectedBlobOid)) return undefined;
	try {
		const bytes = readFileSync(path);
		return gitBlobOid(bytes) === expectedBlobOid ? bytes : undefined;
	} catch {
		return undefined;
	}
}

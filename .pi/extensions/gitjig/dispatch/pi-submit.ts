/* Parent-owned provisioning of the sole trusted Pi final-submission tool.
 * Nothing under the reviewed clone is read to select the tool or its schema.
 */
import { chmodSync, copyFileSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Profile } from "./pi-submit-extension.ts";
import type { DispatchContext } from "./provision.ts";

export function provisionPiSubmitTool(context: DispatchContext, profile: Profile): string {
	const base = join(context.scratchRoot, "trusted-pi");
	mkdirSync(base, { mode: 0o700 });
	if (!lstatSync(base).isDirectory()) throw Error("trusted Pi tool directory refused");
	const source = fileURLToPath(new URL("./pi-submit-extension.ts", import.meta.url));
	if (!lstatSync(source).isFile()) throw Error("trusted Pi tool source refused");
	const destination = join(base, "submit.ts");
	copyFileSync(source, destination);
	chmodSync(destination, 0o600);
	const profilePath = join(base, "profile.json");
	// Common final summary is separate from the consumer's closed payload.
	// The caller, never the delegate, adds it to the invocation-bound tool.
	const exposed: Profile = {
		...profile,
		schema: {
			...profile.schema,
			properties: {
				...profile.schema.properties,
				summary: { type: "string", minLength: 1, maxLength: 6000 },
			},
		},
	};
	writeFileSync(profilePath, JSON.stringify(exposed), { flag: "wx", mode: 0o600 });
	if (dirname(destination) !== base) throw Error("trusted Pi tool path refused");
	return destination;
}

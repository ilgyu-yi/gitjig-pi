/* Parent-owned provisioning of the sole trusted Pi final-submission tool.
 * Nothing under the reviewed clone is read to select the tool or its schema.
 */
import { chmodSync, copyFileSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Profile } from "./pi-submit-extension.ts";
import type { DispatchContext } from "./provision.ts";

/**
 * The invocation-bound tool's exposed schema: the consumer's closed payload plus
 * the common final summary, which the caller adds and the delegate never
 * chooses. Exported so what the tool actually validates is readable without
 * provisioning a scratch, and so one definition serves both. The 6,000 bound is
 * stated in characters, matching the briefs and `matchesProfile`'s count.
 */
export function exposedPiProfile(profile: Profile): Profile {
	return {
		...profile,
		schema: {
			...profile.schema,
			properties: {
				...profile.schema.properties,
				summary: { type: "string", minLength: 1, maxLength: 6000 },
			},
		},
	};
}

export function provisionPiSubmitTool(context: DispatchContext, profile: Profile): string {
	const base = join(context.scratchRoot, "trusted-pi");
	mkdirSync(base, { mode: 0o700 });
	if (!lstatSync(base).isDirectory()) throw Error("trusted Pi tool directory refused");
	const source = fileURLToPath(new URL("./pi-submit-extension.ts", import.meta.url));
	if (!lstatSync(source).isFile()) throw Error("trusted Pi tool source refused");
	const destination = join(base, "submit.ts");
	copyFileSync(source, destination);
	chmodSync(destination, 0o600);
	// The tool consumes the ruled held-operand predicate rather than carrying a
	// second spelling of it (SPEC §3.11), so its one owner is provisioned beside
	// it, parent-owned and read-only like the tool itself. The copied tool's
	// `./operand.ts` import resolves to this file inside the scratch.
	const operandSource = fileURLToPath(new URL("./operand.ts", import.meta.url));
	if (!lstatSync(operandSource).isFile()) throw Error("trusted Pi operand source refused");
	const operandDestination = join(base, "operand.ts");
	copyFileSync(operandSource, operandDestination);
	chmodSync(operandDestination, 0o600);
	if (dirname(operandDestination) !== base) throw Error("trusted Pi operand path refused");
	const profilePath = join(base, "profile.json");
	writeFileSync(profilePath, JSON.stringify(exposedPiProfile(profile)), { flag: "wx", mode: 0o600 });
	if (dirname(destination) !== base) throw Error("trusted Pi tool path refused");
	return destination;
}

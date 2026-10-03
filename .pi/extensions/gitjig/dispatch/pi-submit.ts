/* Parent-owned provisioning of the sole trusted Pi final-submission tool.
 * Nothing under the reviewed clone is read to select the tool or its schema.
 */
import { chmodSync, copyFileSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Profile } from "./pi-submit-extension.ts";
import type { DispatchContext } from "./provision.ts";

/**
 * The invocation-bound tool's exposed schema: the consumer's closed payload,
 * plus the final summary where — and only where — the consuming parser admits
 * a free one. The recovery consumer requires the outer summary to be exactly
 * its own `recovery-result`, so offering a delegate-chosen summary for those
 * roles would let a submission install a slot that consumer then discards
 * (#418). For them the summary property is not exposed at all, the closed
 * schema refuses one that is sent anyway, and the profile's own value is
 * written. Exported so what the tool actually validates is readable without
 * provisioning a scratch, and so one definition serves both. The 6,000 bound
 * is stated in characters, matching the briefs and `matchesProfile`'s count.
 */
export function exposedPiProfile(profile: Profile): Profile {
	if (profile.role.startsWith("recovery-")) return profile;
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

/**
 * Both destinations are `join(base, <fixed leaf>)`, so the two `dirname`
 * equality checks this function once ended with could not fail and no test
 * could reach their refusals; they are gone (#418). The `isDirectory` check
 * below is kept and is likewise unreachable from outside — `mkdirSync` without
 * `recursive` refuses an existing path — so only a concurrent replacement
 * between these two statements can trip it. That residual is recorded here
 * rather than claimed as measured.
 */
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
	// `wx`: the profile is written once into a directory this call just made,
	// so an existing file there means another actor reached it in between.
	const profilePath = join(base, "profile.json");
	writeFileSync(profilePath, JSON.stringify(exposedPiProfile(profile)), { flag: "wx", mode: 0o600 });
	return destination;
}

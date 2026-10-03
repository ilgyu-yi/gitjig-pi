/* Recovery's Pi-only closed submission profiles. The existing recovery
 * consumers in coordinator.ts still decide canonicality, role and sequence.
 */
import type { JsonSchema, Profile } from "../dispatch/pi-submit-extension.ts";
import { DIAGNOSIS_VALUES, INVALIDATIONS } from "../review/history.ts";

const text: JsonSchema = { type: "string", minLength: 1, maxLength: 4096 };
const maybeEmpty: JsonSchema = { type: "string", maxLength: 4096 };
function object(properties: Record<string, JsonSchema>): JsonSchema {
	return { type: "object", additionalProperties: false, properties, required: Object.keys(properties) };
}
export type RecoveryPiRole = "challenger" | "selector-contest" | "selector-measurement" | "measurement" | "diagnosis";
export function recoveryPiProfile(role: RecoveryPiRole, specDigest?: string): Profile | undefined {
	const common = { summary: "recovery-result" };
	if (role === "challenger")
		return {
			...common,
			role: "recovery-challenger",
			fixed: {},
			schema: object({
				outcome: { type: "string", enum: ["ALTERNATIVE", "BASE_STANDS"] },
				method: maybeEmpty,
				evidence: text,
			}),
		};
	if (role === "selector-contest")
		return {
			...common,
			role: "recovery-selector-contest",
			fixed: {},
			schema: object({
				selected: { type: "string", enum: ["root", "blast-radius", "none"] },
				materiallyDifferent: { type: "boolean" },
				evidence: text,
			}),
		};
	if (role === "selector-measurement")
		return {
			...common,
			role: "recovery-selector-measurement",
			fixed: { kind: "measurement", nonMutating: true, notPreviouslyPresent: true },
			schema: object({ question: text, method: text, expectedDiscriminator: text, evidence: text }),
		};
	if (role === "measurement") {
		if (specDigest === undefined || !/^[0-9a-f]{64}$/.test(specDigest)) return undefined;
		return {
			...common,
			role: "recovery-measurement",
			fixed: { kind: "measurement-result", specDigest },
			schema: object({ result: text, evidence: text }),
		};
	}
	if (role === "diagnosis")
		return {
			...common,
			role: "recovery-diagnosis",
			fixed: {},
			schema: object({
				value: { type: "string", enum: [...DIAGNOSIS_VALUES] },
				invalidation: { type: "string", enum: [...INVALIDATIONS] },
				evidence: text,
			}),
		};
	return undefined;
}

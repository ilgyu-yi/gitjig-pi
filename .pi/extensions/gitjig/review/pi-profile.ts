/* Closed Pi submit_result profiles owned beside their consuming parsers.
 * Consumer parsers remain the authority after final dispatcher admission.
 */
import type { JsonSchema, Profile } from "../dispatch/pi-submit-extension.ts";
import { DIAGNOSIS_VALUES, INVALIDATIONS } from "./history.ts";

const string: JsonSchema = { type: "string" };
const boolean: JsonSchema = { type: "boolean" };
const strings: JsonSchema = { type: "array", items: string };
const slot: JsonSchema = {
	type: "object",
	additionalProperties: false,
	properties: { lens: string, surface: string },
	required: ["lens", "surface"],
};
const ruling: JsonSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		finding: string,
		provenance: { type: "array", items: slot },
		validity: { type: "string", enum: ["CONFIRMED", "REFUTED", "INDETERMINATE"] },
		severity: { type: "string", enum: ["SUBSTANTIVE", "NIT"] },
		remedy: string,
		direction: { type: "string", enum: ["fail-closed", "live-harm"] },
		onCriterion: boolean,
		evidence: string,
	},
	required: ["finding", "provenance", "validity", "evidence"],
};
export const REVIEW_PI_PROFILES = {
	reviewer: {
		role: "reviewer",
		summary: "review-result",
		fixed: {},
		schema: {
			type: "object",
			additionalProperties: false,
			properties: {
				token: { type: "string", enum: ["APPROVED", "FINDINGS"] },
				findings: strings,
			},
			required: ["token", "findings"],
		},
	},
	judge: {
		role: "judge",
		summary: "judge-result",
		fixed: {},
		schema: {
			type: "object",
			additionalProperties: false,
			properties: { dedupAttested: boolean, rulings: { type: "array", items: ruling } },
			required: ["dedupAttested", "rulings"],
		},
	},
	history: {
		role: "history",
		summary: "history-result",
		fixed: {},
		schema: {
			type: "object",
			additionalProperties: false,
			properties: {
				value: { type: "string", enum: [...DIAGNOSIS_VALUES] },
				invalidation: { type: "string", enum: [...INVALIDATIONS] },
				evidence: { type: "string", minLength: 1 },
			},
			required: ["value", "invalidation", "evidence"],
		},
	},
} satisfies Record<string, Profile>;
export type ReviewPiRole = keyof typeof REVIEW_PI_PROFILES;

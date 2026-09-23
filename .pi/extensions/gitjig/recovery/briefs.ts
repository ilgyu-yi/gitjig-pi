/** Warning-surface roster: EXEMPT — this module emits no operator-facing warning text. */
import type { DiagnosisInput, RepairBasis } from "../review/history.ts";
import {
	type Challenger,
	canonicalJson,
	type MeasurementResult,
	type MeasurementSpec,
	type RecoverySemanticBrief,
} from "./types.ts";

const RETURN =
	'Return only through ../return.json with exact outer keys {"ok":true,"summary":"recovery-result","reviewedHead":"<held head>","payload":"<JSON string>"}. Write a complete provisional return within 360 seconds and overwrite it with the final return within 540 seconds after process start.';

function brief(role: string, input: unknown, output: string): RecoverySemanticBrief {
	return [
		`Role: ${role}. This is independent recovery evidence, not author repair or authorization.`,
		RETURN,
		`Input JSON: ${canonicalJson(input)}`,
		`The decoded payload must be exact JSON of shape ${output}. No extra keys.`,
	].join("\n\n");
}

export function challengerBrief(
	slot: "root" | "blast-radius",
	diagnosis: DiagnosisInput,
	basis: RepairBasis,
): RecoverySemanticBrief {
	return brief(
		`STAGNATION ${slot} challenger; remain mutually blind from the other challenger`,
		{ slot, diagnosis, basis: { states: basis.states, intervals: basis.intervals } },
		'{"outcome":"ALTERNATIVE|BASE_STANDS","method":"string","evidence":"string"}',
	);
}

export function contestSelectorBrief(candidates: readonly Challenger[]): RecoverySemanticBrief {
	return brief(
		"STAGNATION selector",
		{ candidates },
		'{"selected":"root|blast-radius|none","materiallyDifferent":boolean,"evidence":"string"}',
	);
}

export function measurementSelectorBrief(diagnosis: DiagnosisInput, basis: RepairBasis): RecoverySemanticBrief {
	return brief(
		`${diagnosis.value} non-mutating measurement selector`,
		{ taxonomy: diagnosis.value, basis: { states: basis.states, intervals: basis.intervals } },
		'{"kind":"measurement","question":"string","method":"string","expectedDiscriminator":"string","evidence":"string","nonMutating":true,"notPreviouslyPresent":true}',
	);
}

export function measurementBrief(spec: MeasurementSpec): RecoverySemanticBrief {
	return brief(
		"bounded non-mutating recovery measurement executor",
		{ spec },
		'{"kind":"measurement-result","specDigest":"64 lowercase hex","result":"string","evidence":"string"}',
	);
}

export function freshDiagnosisBrief(
	original: DiagnosisInput,
	basis: RepairBasis,
	spec: MeasurementSpec,
	result: MeasurementResult,
): RecoverySemanticBrief {
	return brief(
		"fresh history Judge; the measurement result is new evidence and the original diagnosis is classification context only",
		{ original, basis: { states: basis.states, intervals: basis.intervals }, spec, result },
		'{"value":"NONE|STAGNATION|OSCILLATION|INDETERMINATE","invalidation":"nothing|plan|authorization","evidence":"string"}',
	);
}

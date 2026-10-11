/** Warning-surface roster: EXEMPT — this module emits no operator-facing warning text. */
import { type DiagnosisInput, hasRewriteMarker, REWRITE_MARKER_RULE, type RepairBasis } from "../review/history.ts";
import {
	type Challenger,
	canonicalJson,
	type MeasurementResult,
	type MeasurementSpec,
	type RecoverySemanticBrief,
} from "./types.ts";

const RETURN =
	'Return only through ../return.json with exact outer keys {"ok":true,"summary":"recovery-result","reviewedHead":"<held head>","payload":"<JSON string>"}. Resolve <held head> independently as the full 40-hex output of `git rev-parse HEAD` in your provisioned tree; do not copy a head from the input JSON. Put that hash only in reviewedHead, not in summary or payload. Write a complete provisional return within 360 seconds and overwrite it with the final return within 540 seconds after process start.';
const READ_ONLY =
	"Read-only evidence only: do not make any public/server or platform act; do not publish, merge, plan, re-plan, authorize, mutate repository metadata or artifacts, or write anything except the required provisional/final ../return.json in your isolated scratch. Report inability without acting.";
const PAYLOAD_PREFIX = "The decoded payload must be exact JSON of shape ";

/** Transport-specific projection of this module's own generic brief. A missing
 * or duplicate anchor refuses; a reviewed-clone datum cannot select a rewrite. */
export function piRecoveryBrief(semantic: RecoverySemanticBrief): RecoverySemanticBrief {
	if (
		semantic.split(READ_ONLY).length !== 2 ||
		semantic.split(RETURN).length !== 2 ||
		semantic.split(PAYLOAD_PREFIX).length !== 2
	)
		throw Error("recovery Pi brief projection refused");
	const withoutGeneric = semantic
		.replace(
			READ_ONLY,
			"Read-only evidence only: do not make any public/server or platform act; do not publish, merge, plan, re-plan, authorize, or mutate repository metadata or artifacts. Submit only via the trusted submit_result tool; never write ../return.json directly. Report inability without acting.",
		)
		.replace(
			RETURN,
			"Use the closed submit_result tool for a single complete final typed submission within 540 seconds. The caller owns the role, clone HEAD, summary, fixed fields and payload encoding; a recovery submission carries no summary field. Do not supply an outer return envelope or a commit hash; a settled agent without a valid tool submission is not a result.",
		);
	return (
		withoutGeneric.slice(0, withoutGeneric.indexOf(PAYLOAD_PREFIX)) +
		"Submit only the typed fields in submit_result's current role schema; the caller supplies any fixed fields. No extra keys."
	);
}

function brief(role: string, input: unknown, output: string, rule: readonly string[] = []): RecoverySemanticBrief {
	return [
		`Role: ${role}. This is independent recovery evidence, not author repair or authorization.`,
		READ_ONLY,
		RETURN,
		`Input JSON: ${canonicalJson(input)}`,
		...(rule.length === 0 ? [] : [rule.join("\n").trimEnd()]),
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
		hasRewriteMarker(basis) ? REWRITE_MARKER_RULE : [],
	);
}

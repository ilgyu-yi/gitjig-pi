/** Warning-surface roster: EXEMPT — this module returns data and emits no warning, throw, record, or operator-facing text. */
/** Content-bounded semantic brief projection for Phase-A recovery actors. */
import type { DiagnosisInput, RepairBasis } from "../review/history.ts";
import type { MeasurementSpec, PhaseAProfileId, RecoverySemanticBrief } from "./types.ts";

export function recoveryBrief(
	kind: PhaseAProfileId,
	input: {
		diagnosis: DiagnosisInput;
		basis: RepairBasis;
		candidates?: unknown;
		measurement?: MeasurementSpec;
		result?: unknown;
	},
): RecoverySemanticBrief {
	const timing = { provisionalDeadlineSeconds: 360, finalDeadlineSeconds: 540 };
	const contract =
		kind === "stagnation-root" || kind === "stagnation-blast-radius"
			? '{"outcome":"ALTERNATIVE|BASE_STANDS","method":"string","evidence":"string"}'
			: kind === "recovery-measurement"
				? '{"kind":"measurement-result","specDigest":"lowercase sha256","result":"string","evidence":"string"}'
				: kind === "recovery-diagnosis"
					? '{"value":"NONE|STAGNATION|OSCILLATION|INDETERMINATE","invalidation":"nothing|plan|authorization","evidence":"string"}'
					: input.diagnosis.value === "STAGNATION"
						? '{"selected":"root|blast-radius|none","materiallyDifferent":true|false,"evidence":"string"}'
						: '{"kind":"measurement","question":"string","method":"string","expectedDiscriminator":"string","evidence":"string","nonMutating":true,"notPreviouslyPresent":true}';
	return {
		kind,
		text: [
			"Act only as the independent recovery role named below. Do not mutate the artifact or any platform state.",
			"Independently resolve the current detached HEAD and put it in reviewedHead; do not copy an expected hash from this brief.",
			`Return payload must be a JSON string encoding exactly ${contract}.`,
			'Return file shape is exactly {"ok":true,"summary":"recovery-result","reviewedHead":"<resolved full HEAD>","payload":"<encoded closed payload>"}.',
			"Semantic input follows:",
			JSON.stringify({ schemaVersion: 1, kind, timing, ...input }),
		].join("\n"),
	};
}

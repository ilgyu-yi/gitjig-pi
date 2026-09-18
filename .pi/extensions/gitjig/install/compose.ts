/**
 * Warning-surface roster: EXEMPT — composition returns structured data and renders no operator text.
 *
 * The adopter composition owner (SPEC §§4.1–4.2, 4.6–4.7; issue #250).
 * Observation is separated from the pure pin/planner decisions. Delivery and
 * provisioning consume this result; neither owns a second membership,
 * destination, collision, digest, or action predicate.
 */
import { sourceProjectionAdmits } from "../../../../.github/workflows/landing-policy.mjs";
import { type ObservedCandidate, observeCandidates, renderMembershipSnapshot } from "./classifier.ts";
import { buildPin, encodePin, type PinSource, type PinV1 } from "./pin.ts";
import { type CompositionPlan, type Occupant, planComposition } from "./plan.ts";

export interface CompositionInput {
	sourceRoot: string;
	source: PinSource;
	revision: string;
	priorPinBytes: Buffer | null;
	occupants: ReadonlyMap<string, Occupant>;
}
export interface AdopterComposition {
	candidates: readonly ObservedCandidate[];
	membershipSnapshot: string;
	pin: PinV1;
	pinBytes: Buffer;
	plan: CompositionPlan;
}

export function composeAdopter(input: CompositionInput): AdopterComposition {
	const candidates = observeCandidates(input.sourceRoot);
	const landingPolicy = candidates.find(({ path }) => path === ".github/landing-policy.json");
	if (landingPolicy) {
		let value: unknown;
		try {
			value = JSON.parse(landingPolicy.bytes.toString("utf8"));
		} catch {
			throw new Error("source landing policy is not the null-disabled scaffold");
		}
		if (!sourceProjectionAdmits(value)) throw new Error("source landing policy is not the null-disabled scaffold");
	}
	const membershipSnapshot = renderMembershipSnapshot(
		candidates.map(({ path, disposition }) => ({ path, disposition })),
	);
	const pin = buildPin(
		input.source,
		input.revision,
		candidates.flatMap((candidate) =>
			candidate.disposition === "handed-over" || candidate.disposition === "carried"
				? [{ path: candidate.path, class: candidate.disposition, bytes: candidate.bytes }]
				: [],
		),
	);
	const pinBytes = Buffer.from(encodePin(pin));
	return {
		candidates,
		membershipSnapshot,
		pin,
		pinBytes,
		plan: planComposition({
			nextPinBytes: pinBytes,
			priorPinBytes: input.priorPinBytes,
			occupants: input.occupants,
		}),
	};
}

export * from "./classifier.ts";
export * from "./pin.ts";
export * from "./plan.ts";

/**
 * Immutable-snapshot acquisition verification for per-clone provision (#130).
 * Warning-surface roster: EXEMPT — returns fixed structured causes and renders no operands.
 */
import { timingSafeEqual } from "node:crypto";
import { type ObservedCandidate, observeCandidates } from "./classifier.ts";
import { buildPin, encodePin, type PinV1, parsePin } from "./pin.ts";

export type AcquisitionResult =
	| {
			readonly outcome: "verified";
			readonly pin: PinV1;
			readonly candidates: readonly ObservedCandidate[];
	  }
	| { readonly outcome: "refused"; readonly cause: "malformed-pin" | "snapshot-mismatch" };

const exact = (left: Buffer, right: Buffer): boolean => left.length === right.length && timingSafeEqual(left, right);

/** Reconstruct pin v1 through its sole classifier/codec, before target mutation. */
export function verifyAcquiredSnapshot(snapshotRoot: string, pinBytes: Buffer): AcquisitionResult {
	let pin: PinV1;
	try {
		pin = parsePin(pinBytes.toString("utf8"));
	} catch {
		return Object.freeze({ outcome: "refused", cause: "malformed-pin" });
	}
	try {
		const candidates = observeCandidates(snapshotRoot);
		const reconstructed = buildPin(
			pin.source,
			pin.revision,
			candidates.flatMap((candidate) =>
				candidate.disposition === "handed-over" || candidate.disposition === "carried"
					? [{ path: candidate.path, class: candidate.disposition, bytes: candidate.bytes }]
					: [],
			),
		);
		if (!exact(Buffer.from(encodePin(reconstructed)), pinBytes))
			return Object.freeze({ outcome: "refused", cause: "snapshot-mismatch" });
		return Object.freeze({ outcome: "verified", pin, candidates: Object.freeze(candidates) });
	} catch {
		return Object.freeze({ outcome: "refused", cause: "snapshot-mismatch" });
	}
}

/**
 * Classifier-owned carried projection and verified per-clone provision (#130).
 * Warning-surface roster: EXEMPT — returns fixed structured causes and renders no operands.
 */

import { verifyAcquiredSnapshot } from "./acquire.ts";
import { observeOccupants } from "./classifier.ts";
import type { AdopterComposition } from "./compose.ts";
import { composeAdopter } from "./compose.ts";
import { GENERATED_PIN_PATH, parsePin } from "./pin.ts";
import { type Occupant, verifyPlannedState } from "./plan.ts";

export interface ProvisionChange {
	readonly path: string;
	readonly operation: "upsert" | "delete";
	readonly expected: Occupant;
	readonly bytes?: Buffer;
}
export interface ProvisionRequest {
	readonly changes: readonly ProvisionChange[];
	readonly verifyPaths: readonly string[];
	readonly exclude: readonly string[];
	readonly bindHooksPath: ".githooks";
	readonly installedPinBytes: Buffer;
}
export interface ProvisionSnapshot {
	readonly occupants: ReadonlyMap<string, Occupant>;
	readonly excluded: readonly string[];
	readonly hooksPath: string;
}
export interface ProvisionPlatform {
	apply(request: ProvisionRequest): Promise<ProvisionSnapshot | null>;
	advanceInstalledPin(pinBytes: Buffer): Promise<Buffer | null>;
}
export type ProvisionResult =
	| { readonly outcome: "verified" | "converged"; readonly changes: readonly ProvisionChange[] }
	| {
			readonly outcome: "refused";
			readonly cause: "acquisition" | "composition" | "platform-unconfirmed" | "final-verification";
	  };

function unionPaths(composition: AdopterComposition, priorPinBytes: Buffer | null): string[] {
	const paths = new Set(composition.pin.manifest.map((entry) => entry.path));
	if (priorPinBytes !== null) {
		const prior = parsePin(priorPinBytes.toString("utf8"));
		for (const entry of prior.manifest) paths.add(entry.path);
	}
	paths.add(GENERATED_PIN_PATH);
	return [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

function copyChange(change: ProvisionChange): ProvisionChange {
	return Object.freeze(
		change.operation === "delete"
			? { path: change.path, operation: "delete" as const, expected: copyOccupant(change.expected) }
			: {
					path: change.path,
					operation: "upsert" as const,
					expected: copyOccupant(change.expected),
					bytes: Buffer.from(change.bytes ?? []),
				},
	);
}

function copyOccupant(occupant: Occupant): Occupant {
	return occupant.kind === "absent"
		? Object.freeze({ kind: "absent" })
		: Object.freeze({ kind: "bytes", bytes: Buffer.from(occupant.bytes) });
}

export async function provisionAdopter(input: {
	readonly snapshotRoot: string;
	readonly targetRoot: string;
	readonly committedPinBytes: Buffer;
	readonly installedPinBytes: Buffer | null;
	readonly platform: ProvisionPlatform;
}): Promise<ProvisionResult> {
	const acquired = verifyAcquiredSnapshot(input.snapshotRoot, input.committedPinBytes);
	if (acquired.outcome === "refused") return Object.freeze({ outcome: "refused", cause: "acquisition" });
	let composition: AdopterComposition;
	let occupants: ReadonlyMap<string, Occupant>;
	try {
		const seed = composeAdopter({
			sourceRoot: input.snapshotRoot,
			source: acquired.pin.source,
			revision: acquired.pin.revision,
			priorPinBytes: input.installedPinBytes,
			occupants: new Map(),
		});
		occupants = observeOccupants(input.targetRoot, unionPaths(seed, input.installedPinBytes));
		composition = composeAdopter({
			sourceRoot: input.snapshotRoot,
			source: acquired.pin.source,
			revision: acquired.pin.revision,
			priorPinBytes: input.installedPinBytes,
			occupants,
		});
	} catch {
		return Object.freeze({ outcome: "refused", cause: "composition" });
	}
	if (composition.plan.outcome === "refused") return Object.freeze({ outcome: "refused", cause: "composition" });
	const candidates = new Map(composition.candidates.map((candidate) => [candidate.path, candidate]));
	const changes: ProvisionChange[] = [];
	for (const member of composition.plan.members) {
		if (member.class === "handed-over" || member.class === "pin") {
			if (member.action !== "converged") return Object.freeze({ outcome: "refused", cause: "composition" });
			continue;
		}
		if (member.class !== "carried") return Object.freeze({ outcome: "refused", cause: "composition" });
		if (member.action === "converged") continue;
		if (member.action === "refuse") return Object.freeze({ outcome: "refused", cause: "composition" });
		const expected = occupants.get(member.path);
		if (!expected) return Object.freeze({ outcome: "refused", cause: "composition" });
		if (member.action === "retire")
			changes.push(Object.freeze({ path: member.path, operation: "delete", expected: copyOccupant(expected) }));
		else {
			const bytes = candidates.get(member.path)?.bytes;
			if (!bytes) return Object.freeze({ outcome: "refused", cause: "composition" });
			changes.push(
				Object.freeze({
					path: member.path,
					operation: "upsert",
					expected: copyOccupant(expected),
					bytes: Buffer.from(bytes),
				}),
			);
		}
	}
	const sealed = Object.freeze(changes.map(copyChange));
	const request = Object.freeze({
		changes: Object.freeze(sealed.map(copyChange)),
		verifyPaths: Object.freeze(unionPaths(composition, input.installedPinBytes)),
		exclude: Object.freeze(
			composition.pin.manifest.filter((entry) => entry.class === "carried").map((entry) => entry.path),
		),
		bindHooksPath: ".githooks" as const,
		installedPinBytes: Buffer.from(input.committedPinBytes),
	});
	let snapshot: ProvisionSnapshot | null;
	try {
		snapshot = await input.platform.apply(request);
	} catch {
		return Object.freeze({ outcome: "refused", cause: "platform-unconfirmed" });
	}
	if (snapshot === null) return Object.freeze({ outcome: "refused", cause: "platform-unconfirmed" });
	try {
		if (
			verifyPlannedState(composition.plan, snapshot.occupants, input.committedPinBytes) === "refused" ||
			snapshot.hooksPath !== ".githooks" ||
			!request.exclude.every((path) => snapshot.excluded.includes(path))
		)
			return Object.freeze({ outcome: "refused", cause: "final-verification" });
	} catch {
		return Object.freeze({ outcome: "refused", cause: "final-verification" });
	}
	let advanced: Buffer | null;
	try {
		advanced = await input.platform.advanceInstalledPin(Buffer.from(input.committedPinBytes));
	} catch {
		return Object.freeze({ outcome: "refused", cause: "platform-unconfirmed" });
	}
	if (advanced === null || !advanced.equals(input.committedPinBytes))
		return Object.freeze({ outcome: "refused", cause: "final-verification" });
	return Object.freeze({ outcome: sealed.length === 0 ? "converged" : "verified", changes: sealed });
}

/**
 * Reviewed delivery of a classifier-owned adopter composition (issue #118).
 * Warning-surface roster: EXEMPT — returns structured fixed causes and renders no operands.
 */
import { createHash } from "node:crypto";
import { appendAuditRecord } from "../audit.ts";
import { neutralizeForDestination, neutralizeOperand } from "../publish/neutralize.ts";
import { mergeScanOutcomes, scanBody } from "../publish/scan.ts";
import type { AdopterComposition } from "./compose.ts";
import { encodePin, GENERATED_PIN_PATH, type PinSource, type PinV1, parsePin } from "./pin.ts";
import { type Occupant, type PlanAction, type PlanCause, verifyPlannedState } from "./plan.ts";

export interface DeliveryTarget {
	readonly source: PinSource;
	readonly baseRef: string;
	readonly baseRevision: string;
}
export interface DeliveryChange {
	readonly path: string;
	readonly operation: "upsert" | "delete";
	readonly action: Exclude<PlanAction, "converged" | "refuse">;
	readonly cause: PlanCause;
	readonly bytes?: Buffer;
}
export interface DraftPullRequestRequest {
	readonly target: DeliveryTarget;
	readonly title: string;
	readonly body: string;
	readonly draft: true;
	readonly changes: readonly DeliveryChange[];
}
export interface DraftPullRequestSnapshot {
	readonly source: PinSource;
	readonly baseRef: string;
	readonly baseRevision: string;
	readonly headRevision: string;
	readonly number: number;
	readonly draft: boolean;
	readonly title: string;
	readonly body: string;
	readonly changes: readonly DeliveryChange[];
}
export interface DeliveryPlatform {
	publishDraft(request: DraftPullRequestRequest): Promise<DraftPullRequestSnapshot | null>;
}
export type EgressPreparation =
	| { readonly outcome: "prepared"; readonly title: string; readonly body: string }
	| { readonly outcome: "refused" };
export interface DeliveryEgress {
	prepare(title: string, body: string): EgressPreparation;
}

/** The delivery adapter for the landed egress scan and neutralization predicates. */
export function createDeliveryEgress(stateRoot: string): DeliveryEgress {
	return Object.freeze({
		prepare(title: string, body: string): EgressPreparation {
			try {
				const merged = mergeScanOutcomes(scanBody(body), scanBody(title));
				if (merged.scan.disposition !== "clean") {
					appendAuditRecord(stateRoot, {
						category: "egress",
						action: "refuse-delivery",
						text: `delivery prose refused: ${merged.scan.disposition}`,
					});
					return Object.freeze({ outcome: "refused" });
				}
				return Object.freeze({
					outcome: "prepared",
					title: neutralizeOperand(title).text,
					body: neutralizeForDestination(body, "pr-create").text,
				});
			} catch {
				appendAuditRecord(stateRoot, {
					category: "egress",
					action: "refuse-delivery-machinery",
					text: "delivery prose refused: egress machinery failed",
				});
				return Object.freeze({ outcome: "refused" });
			}
		},
	});
}
export type DeliveryCause =
	| "invalid-target"
	| "invalid-composition"
	| "egress-refused"
	| "platform-unconfirmed"
	| "platform-mismatch";
export type DeliveryResult =
	| { readonly outcome: "converged"; readonly members: readonly DeliveryChange[] }
	| { readonly outcome: "verified"; readonly members: readonly DeliveryChange[]; readonly pullRequest: number }
	| { readonly outcome: "refused"; readonly cause: DeliveryCause; readonly members: readonly DeliveryChange[] };

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const validScalar = (value: unknown): value is string => {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.normalize("NFC") !== value ||
		Buffer.from(value, "utf8").toString("utf8") !== value
	)
		return false;
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined || codePoint < 0x20 || codePoint === 0x7f) return false;
	}
	return true;
};
function validTarget(target: DeliveryTarget): boolean {
	return (
		target.source.provider === "github" &&
		target.source.host === "github.com" &&
		validScalar(target.source.owner) &&
		!target.source.owner.includes("/") &&
		!target.source.owner.includes("%") &&
		validScalar(target.source.repository) &&
		!target.source.repository.includes("/") &&
		!target.source.repository.includes("%") &&
		validScalar(target.baseRef) &&
		!target.baseRef.startsWith("-") &&
		/^[0-9a-f]{40}$/u.test(target.baseRevision)
	);
}
const sameSource = (a: PinSource, b: PinSource): boolean =>
	a.provider === b.provider && a.host === b.host && a.owner === b.owner && a.repository === b.repository;
const sameChange = (a: DeliveryChange, b: DeliveryChange): boolean =>
	a.path === b.path &&
	a.operation === b.operation &&
	a.action === b.action &&
	a.cause === b.cause &&
	(a.operation === "delete" || (a.bytes !== undefined && b.bytes !== undefined && a.bytes.equals(b.bytes)));
function copyChange(change: DeliveryChange): DeliveryChange {
	return Object.freeze(
		change.operation === "delete"
			? { path: change.path, operation: "delete" as const, action: change.action, cause: change.cause }
			: {
					path: change.path,
					operation: "upsert" as const,
					action: change.action,
					cause: change.cause,
					bytes: Buffer.from(change.bytes ?? []),
				},
	);
}
function refuse(cause: DeliveryCause, members: readonly DeliveryChange[] = []): DeliveryResult {
	return Object.freeze({ outcome: "refused", cause, members: Object.freeze(members.map(copyChange)) });
}

function constructChanges(composition: AdopterComposition): readonly DeliveryChange[] | null {
	let pin: PinV1;
	try {
		pin = parsePin(composition.pinBytes.toString("utf8"));
	} catch {
		return null;
	}
	if (
		!Buffer.from(encodePin(composition.pin)).equals(composition.pinBytes) ||
		pin.payloadDigest !== composition.pin.payloadDigest ||
		digest(composition.pinBytes) !== composition.plan.pinDigest ||
		composition.plan.nextPayloadDigest !== pin.payloadDigest
	)
		return null;
	const candidates = new Map<string, (typeof composition.candidates)[number]>();
	for (const candidate of composition.candidates) {
		if (candidates.has(candidate.path)) return null;
		candidates.set(candidate.path, candidate);
	}
	const planned = new Map<string, (typeof composition.plan.members)[number]>();
	if (!Object.isFrozen(composition.plan) || !Object.isFrozen(composition.plan.members)) return null;
	for (const member of composition.plan.members) {
		if (!Object.isFrozen(member) || planned.has(member.path)) return null;
		planned.set(member.path, member);
	}
	if (planned.get(GENERATED_PIN_PATH)?.class !== "pin") return null;
	const desired = new Map<string, Occupant>();
	for (const entry of pin.manifest) {
		if (planned.get(entry.path)?.class !== entry.class) return null;
		const candidate = candidates.get(entry.path);
		if (!candidate || candidate.disposition !== entry.class) return null;
		desired.set(entry.path, { kind: "bytes", bytes: Buffer.from(candidate.bytes) });
	}
	for (const member of composition.plan.members)
		if (member.class !== "pin" && !desired.has(member.path)) desired.set(member.path, { kind: "absent" });
	desired.set(GENERATED_PIN_PATH, { kind: "bytes", bytes: Buffer.from(composition.pinBytes) });
	if (verifyPlannedState(composition.plan, desired, composition.pinBytes) === "refused") return null;

	const changes: DeliveryChange[] = [];
	const seen = new Set<string>();
	for (const member of composition.plan.members) {
		if (member.class !== "handed-over" && member.class !== "pin") continue;
		if (seen.has(member.path)) return null;
		seen.add(member.path);
		if (member.action === "converged") continue;
		if (member.action === "refuse") return null;
		if (member.action === "retire") {
			if (member.class === "pin") return null;
			changes.push(
				Object.freeze({ path: member.path, operation: "delete", action: member.action, cause: member.cause }),
			);
			continue;
		}
		if (member.action !== "land" && member.action !== "replace") return null;
		const bytes = member.class === "pin" ? composition.pinBytes : candidates.get(member.path)?.bytes;
		if (!bytes) return null;
		changes.push(
			Object.freeze({
				path: member.path,
				operation: "upsert",
				action: member.action,
				cause: member.cause,
				bytes: Buffer.from(bytes),
			}),
		);
	}
	return Object.freeze(changes);
}

export async function deliverAdopter(input: {
	readonly composition: AdopterComposition;
	readonly target: DeliveryTarget;
	readonly title: string;
	readonly body: string;
	readonly egress: DeliveryEgress;
	readonly platform: DeliveryPlatform;
}): Promise<DeliveryResult> {
	if (!validTarget(input.target)) return refuse("invalid-target");
	const changes = constructChanges(input.composition);
	if (changes === null) return refuse("invalid-composition");
	if (changes.length === 0) return Object.freeze({ outcome: "converged", members: changes });
	let prepared: EgressPreparation;
	try {
		prepared = input.egress.prepare(input.title, input.body);
	} catch {
		return refuse("egress-refused", changes);
	}
	if (
		prepared.outcome !== "prepared" ||
		!validScalar(prepared.title) ||
		typeof prepared.body !== "string" ||
		Buffer.from(prepared.body, "utf8").toString("utf8") !== prepared.body
	)
		return refuse("egress-refused", changes);
	const retained = Object.freeze(changes.map(copyChange));
	const request = Object.freeze({
		target: Object.freeze({ ...input.target, source: Object.freeze({ ...input.target.source }) }),
		title: prepared.title,
		body: prepared.body,
		draft: true as const,
		changes: Object.freeze(changes.map(copyChange)),
	});
	let snapshot: DraftPullRequestSnapshot | null;
	try {
		snapshot = await input.platform.publishDraft(request);
	} catch {
		return refuse("platform-unconfirmed", retained);
	}
	if (snapshot === null) return refuse("platform-unconfirmed", retained);
	try {
		if (
			!sameSource(snapshot.source, input.target.source) ||
			snapshot.baseRef !== input.target.baseRef ||
			snapshot.baseRevision !== input.target.baseRevision ||
			!/^[0-9a-f]{40}$/u.test(snapshot.headRevision) ||
			snapshot.headRevision === snapshot.baseRevision ||
			!Number.isSafeInteger(snapshot.number) ||
			snapshot.number <= 0 ||
			snapshot.draft !== true ||
			snapshot.title !== prepared.title ||
			snapshot.body !== prepared.body ||
			snapshot.changes.length !== retained.length ||
			!retained.every((change, index) => sameChange(change, snapshot.changes[index]))
		)
			return refuse("platform-mismatch", retained);
		return Object.freeze({ outcome: "verified", members: retained, pullRequest: snapshot.number });
	} catch {
		return refuse("platform-mismatch", retained);
	}
}

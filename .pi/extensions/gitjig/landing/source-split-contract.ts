/** Warning-surface roster: EXEMPT — closed record predicates return fixed arms and render no warning text. */
import { createHash } from "node:crypto";
import {
	TOPOLOGY_SOURCE_CLAIM_MARKER,
	TOPOLOGY_SOURCE_STEP_MARKER,
	TOPOLOGY_SOURCE_TERMINAL_MARKER,
} from "./topology-authorization.ts";
import type { TopologyPlan } from "./topology-plan.ts";

export interface TopologySourceClaimRecord {
	schemaVersion: 1;
	repositoryId: string;
	issueId: string;
	authorizationRecordId: string;
	planHash: string;
	pairKey: string;
	correlationId: string;
	writerId: string;
	claimedAt: string;
}
export interface TopologySourceStepRecord {
	schemaVersion: 1;
	repositoryId: string;
	issueId: string;
	claimCommentId: string;
	authorizationRecordId: string;
	planHash: string;
	pairKey: string;
	order: number;
	method: "PATCH" | "POST" | "DELETE";
	path: string;
	requestBodyDigest: string | null;
	beforeStateDigest: string;
	afterStateDigest: string;
	observedAt: string;
	writerId: string;
}
export const TOPOLOGY_SOURCE_REFUSAL_ARMS = [
	"subject-invalid",
	"population-incomplete",
	"plan-invalid",
	"authorization-absent",
	"authorization-ambiguous",
	"authorization-unattested",
	"authorization-stale",
	"stage-mismatch",
	"pair-mismatch",
	"claim-conflict",
	"live-drift",
	"ownership-mismatch",
	"write-unverified",
	"postread-mismatch",
	"record-failed",
	"partial-consumed",
	"audit-failed",
] as const;
export type TopologySourceRefusalArm = (typeof TOPOLOGY_SOURCE_REFUSAL_ARMS)[number];
export interface TopologySourceMismatch {
	arm: TopologySourceRefusalArm;
	condition: string;
	observedDigest: string | null;
}
export interface TopologySourceTerminalBase {
	schemaVersion: 1;
	repositoryId: string;
	issueId: string;
	completedOrders: number[];
	lastVerifiedStateDigest: string | null;
	observedMismatch: TopologySourceMismatch | null;
	remainingOrders: number[];
	writerId: string;
	observedAt: string;
}
export type TopologySourceTerminalRecord = TopologySourceTerminalBase &
	(
		| {
				authorizationRecordId: null;
				claimCommentId: null;
				outcome: "refused";
				completedOrders: [];
				lastVerifiedStateDigest: null;
				observedMismatch: TopologySourceMismatch & {
					arm: "authorization-absent" | "authorization-ambiguous";
					observedDigest: string;
				};
				expiresAt: null;
		  }
		| {
				authorizationRecordId: string;
				claimCommentId: null;
				outcome: "refused";
				completedOrders: [];
				lastVerifiedStateDigest: null;
				observedMismatch: TopologySourceMismatch & {
					arm: "authorization-unattested";
					observedDigest: string;
				};
				expiresAt: null;
		  }
		| {
				authorizationRecordId: string;
				claimCommentId: null;
				outcome: "refused";
				expiresAt: string;
		  }
		| {
				authorizationRecordId: string;
				claimCommentId: string;
				outcome: "partial" | "success";
				expiresAt: string;
		  }
	);

function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		Object.keys(value).every((key) => keys.includes(key))
	);
}
function text(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value === value.normalize("NFC") &&
		![...value].some((character) => {
			const point = character.codePointAt(0) ?? 0;
			return point < 32 || (point >= 127 && point <= 159) || point === 0x2028 || point === 0x2029;
		})
	);
}
const hex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
export type TopologyCanonicalInstant = (value: unknown) => string | undefined;
const instant = (value: unknown, canonicalInstant: TopologyCanonicalInstant): value is string =>
	canonicalInstant(value) === value;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
function ordered(value: unknown): value is number[] {
	return (
		Array.isArray(value) &&
		value.every(positive) &&
		value.every((item, index) => index === 0 || item > value[index - 1])
	);
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
export function topologySourceDigest(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}
export function topologySourcePairKey(plan: TopologyPlan): string {
	return topologySourceDigest({
		repositoryId: plan.repositoryId,
		defaultBranch: plan.defaultBranch,
		beforeDigest: plan.beforeDigest,
		optimisticRulesets: plan.optimisticRulesets,
	});
}
function parse(body: unknown, marker: string): unknown {
	if (typeof body !== "string" || !body.startsWith(`${marker}\n`) || body.indexOf(marker, marker.length) !== -1)
		return undefined;
	try {
		return JSON.parse(body.slice(marker.length + 1));
	} catch {
		return undefined;
	}
}
export const parseTopologySourceClaim = (body: unknown): unknown => parse(body, TOPOLOGY_SOURCE_CLAIM_MARKER);
export const parseTopologySourceStep = (body: unknown): unknown => parse(body, TOPOLOGY_SOURCE_STEP_MARKER);
export const parseTopologySourceTerminal = (body: unknown): unknown => parse(body, TOPOLOGY_SOURCE_TERMINAL_MARKER);
export function encodeTopologySourceRecord(marker: string, value: unknown): string {
	return `${marker}\n${JSON.stringify(value)}`;
}
export function admitTopologySourceClaim(
	value: unknown,
	canonicalInstant: TopologyCanonicalInstant,
): value is TopologySourceClaimRecord {
	return (
		object(value, [
			"schemaVersion",
			"repositoryId",
			"issueId",
			"authorizationRecordId",
			"planHash",
			"pairKey",
			"correlationId",
			"writerId",
			"claimedAt",
		]) &&
		value.schemaVersion === 1 &&
		[value.repositoryId, value.issueId, value.authorizationRecordId, value.writerId].every(text) &&
		[value.planHash, value.pairKey, value.correlationId].every(hex) &&
		instant(value.claimedAt, canonicalInstant)
	);
}
export function admitTopologySourceStep(
	value: unknown,
	canonicalInstant: TopologyCanonicalInstant,
): value is TopologySourceStepRecord {
	return (
		object(value, [
			"schemaVersion",
			"repositoryId",
			"issueId",
			"claimCommentId",
			"authorizationRecordId",
			"planHash",
			"pairKey",
			"order",
			"method",
			"path",
			"requestBodyDigest",
			"beforeStateDigest",
			"afterStateDigest",
			"observedAt",
			"writerId",
		]) &&
		value.schemaVersion === 1 &&
		[
			value.repositoryId,
			value.issueId,
			value.claimCommentId,
			value.authorizationRecordId,
			value.path,
			value.writerId,
		].every(text) &&
		[value.planHash, value.pairKey, value.beforeStateDigest, value.afterStateDigest].every(hex) &&
		(value.requestBodyDigest === null || hex(value.requestBodyDigest)) &&
		positive(value.order) &&
		["PATCH", "POST", "DELETE"].includes(String(value.method)) &&
		instant(value.observedAt, canonicalInstant)
	);
}
function validMismatch(value: unknown): value is TopologySourceMismatch {
	return (
		object(value, ["arm", "condition", "observedDigest"]) &&
		TOPOLOGY_SOURCE_REFUSAL_ARMS.includes(value.arm as TopologySourceRefusalArm) &&
		text(value.condition) &&
		(value.observedDigest === null || hex(value.observedDigest))
	);
}
export function admitTopologySourceTerminal(
	value: unknown,
	canonicalInstant: TopologyCanonicalInstant,
): value is TopologySourceTerminalRecord {
	if (
		!object(value, [
			"schemaVersion",
			"repositoryId",
			"issueId",
			"authorizationRecordId",
			"claimCommentId",
			"outcome",
			"completedOrders",
			"lastVerifiedStateDigest",
			"observedMismatch",
			"remainingOrders",
			"expiresAt",
			"writerId",
			"observedAt",
		])
	)
		return false;
	if (
		value.schemaVersion !== 1 ||
		![value.repositoryId, value.issueId, value.writerId].every(text) ||
		!ordered(value.completedOrders) ||
		!ordered(value.remainingOrders) ||
		!instant(value.observedAt, canonicalInstant)
	)
		return false;
	const completed = value.completedOrders as number[];
	const remaining = value.remainingOrders as number[];
	const all = [...completed, ...remaining];
	if (new Set(all).size !== all.length || all.some((item, index) => item !== index + 1)) return false;
	if (value.outcome === "refused") {
		if (
			value.claimCommentId !== null ||
			completed.length !== 0 ||
			value.lastVerifiedStateDigest !== null ||
			!validMismatch(value.observedMismatch)
		)
			return false;
		const noAuthorization = ["authorization-absent", "authorization-ambiguous"].includes(value.observedMismatch.arm);
		if (noAuthorization)
			return (
				value.authorizationRecordId === null && value.expiresAt === null && hex(value.observedMismatch.observedDigest)
			);
		if (value.observedMismatch.arm === "authorization-unattested" && value.expiresAt === null)
			return text(value.authorizationRecordId) && hex(value.observedMismatch.observedDigest);
		return text(value.authorizationRecordId) && instant(value.expiresAt, canonicalInstant);
	}
	if (value.outcome === "partial")
		return (
			text(value.authorizationRecordId) &&
			text(value.claimCommentId) &&
			instant(value.expiresAt, canonicalInstant) &&
			hex(value.lastVerifiedStateDigest) &&
			validMismatch(value.observedMismatch)
		);
	return (
		value.outcome === "success" &&
		text(value.authorizationRecordId) &&
		text(value.claimCommentId) &&
		instant(value.expiresAt, canonicalInstant) &&
		remaining.length === 0 &&
		hex(value.lastVerifiedStateDigest) &&
		value.observedMismatch === null
	);
}

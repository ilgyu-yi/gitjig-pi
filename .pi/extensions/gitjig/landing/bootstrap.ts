/** Warning-surface roster: EXEMPT — this dormant module returns one fixed refusal token. */
import { createHash } from "node:crypto";

export interface BootstrapTopologyEngine {
	attestLandingTopology(value: unknown, live: unknown): { ok: boolean; arm?: string };
	canonicalInstant(value: unknown): string | undefined;
	encodeLandingTopology(value: unknown): string | undefined;
}
export type BootstrapEngine = Record<never, never>;
export interface BootstrapAuthorization {
	schemaVersion: 1;
	recordId: string;
	repositoryId: string;
	stage: "source-split" | "carrier-bootstrap";
	planHash: string;
	pairKey: string;
	actorId: string;
	actorPermission: "admin";
	correlationId: string;
	issuedAt: string;
	expiresAt: string;
}
export interface BootstrapInput {
	live: {
		repositoryId: string;
		core: Record<string, unknown>;
		human: Record<string, unknown>;
		actionsIntegrationId: number;
	};
	topologyEngine: BootstrapTopologyEngine;
	[key: string]: unknown;
}
export function topologyPairKey(
	live: BootstrapInput["live"],
	topologyEngine: BootstrapTopologyEngine,
): string | undefined {
	const core = topologyEngine.canonicalInstant(live.core.updated_at);
	const human = topologyEngine.canonicalInstant(live.human.updated_at);
	if (!core || !human || !Number.isSafeInteger(live.core.id) || !Number.isSafeInteger(live.human.id)) return undefined;
	return createHash("sha256")
		.update(JSON.stringify([live.repositoryId, live.core.id, core, live.human.id, human]))
		.digest("hex");
}
export function examineBootstrap(_input: BootstrapInput): { ok: false; arm: string } {
	return { ok: false, arm: "bootstrap-superseded-dormant" };
}
export async function executeBootstrapLanding(
	_input: BootstrapInput,
	_effects: unknown,
): Promise<{ outcome: "refused"; arm: string }> {
	return { outcome: "refused", arm: "bootstrap-superseded-dormant" };
}

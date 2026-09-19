/** Warning-surface roster: EXEMPT — bootstrap decisions return fixed arm tokens and no actor operand. */
import { createHash } from "node:crypto";
import {
	executeGuardedLanding,
	type LandingEffects,
	type LandingExecutionResult,
	type LandingSnapshot,
	type LifecycleEngine,
} from "./service.ts";

export interface BootstrapTopologyEngine {
	attestLandingTopology(value: unknown, live: unknown): { ok: boolean; arm?: string };
	canonicalInstant(value: unknown): string | undefined;
	encodeLandingTopology(value: unknown): string | undefined;
}
export interface BootstrapEngine extends LifecycleEngine {
	ownBehalfRefusal(input: {
		producerId: string;
		prAuthorId: string;
		beneficiaryIds: string[];
		controlledIdentityIds: string[];
	}): boolean;
}
export interface BootstrapAuthorization {
	schemaVersion: 1;
	platformBacked: true;
	recordId: string;
	repositoryId: string;
	planHash: string;
	pairKey: string;
	actorId: string;
	actorRole: string;
	edited: false;
	authorizedAt: string;
}
export interface BootstrapInput {
	snapshot: LandingSnapshot;
	consumerId: string;
	consumerRunId?: string;
	now: string;
	engine: BootstrapEngine;
	topologyEngine: BootstrapTopologyEngine;
	defaultBranchTopology: "absent" | "active" | "invalid";
	candidatePaths: readonly string[];
	candidateTopology: unknown;
	candidateBytes: string;
	live: {
		repositoryId: string;
		core: Record<string, unknown>;
		human: Record<string, unknown>;
		actionsIntegrationId: number;
	};
	repositorySettings: { allow_merge_commit: boolean; allow_squash_merge: boolean; allow_rebase_merge: boolean };
	authorization: BootstrapAuthorization;
	escapeProducerId: string;
	beneficiaryIds: string[];
	controlledIdentityIds: string[];
	consumedPairKeys: readonly string[];
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

export function examineBootstrap(input: BootstrapInput): { ok: true; pairKey: string } | { ok: false; arm: string } {
	if (input.defaultBranchTopology !== "absent") return { ok: false, arm: "bootstrap-carrier-not-absent" };
	if (input.candidatePaths.length !== 1 || input.candidatePaths[0] !== ".github/landing-topology.json")
		return { ok: false, arm: "bootstrap-constituents" };
	const attested = input.topologyEngine.attestLandingTopology(input.candidateTopology, input.live);
	if (!attested.ok) return { ok: false, arm: `bootstrap-${attested.arm}` };
	if (input.topologyEngine.encodeLandingTopology(input.candidateTopology) !== input.candidateBytes)
		return { ok: false, arm: "bootstrap-topology-bytes" };
	if (
		input.repositorySettings.allow_merge_commit !== true ||
		input.repositorySettings.allow_squash_merge !== false ||
		input.repositorySettings.allow_rebase_merge !== false
	)
		return { ok: false, arm: "bootstrap-repository-settings" };
	const pairKey = topologyPairKey(input.live, input.topologyEngine);
	if (!pairKey) return { ok: false, arm: "bootstrap-pair" };
	const authorization = input.authorization;
	if (
		authorization.schemaVersion !== 1 ||
		authorization.platformBacked !== true ||
		!authorization.recordId ||
		authorization.repositoryId !== input.live.repositoryId ||
		authorization.pairKey !== pairKey ||
		!/^[0-9a-f]{64}$/.test(authorization.planHash) ||
		!authorization.actorId ||
		authorization.actorRole.toLowerCase() !== "admin" ||
		authorization.edited !== false ||
		!input.topologyEngine.canonicalInstant(authorization.authorizedAt)
	)
		return { ok: false, arm: "bootstrap-authorization" };
	if (input.consumedPairKeys.includes(pairKey)) return { ok: false, arm: "bootstrap-pair-consumed" };
	if (
		input.engine.ownBehalfRefusal({
			producerId: input.escapeProducerId,
			prAuthorId: input.snapshot.prAuthorId,
			beneficiaryIds: input.beneficiaryIds,
			controlledIdentityIds: input.controlledIdentityIds,
		})
	)
		return { ok: false, arm: "bootstrap-own-behalf" };
	if (input.snapshot.quorum.measurable !== true || input.snapshot.quorum.approvals >= input.snapshot.quorum.required)
		return { ok: false, arm: "bootstrap-quorum-not-measured-unmet" };
	return { ok: true, pairKey };
}

/** Execute only through the existing claim/terminal/exact-merge service after bootstrap-specific admission. */
export async function executeBootstrapLanding(
	input: BootstrapInput,
	effects: LandingEffects,
): Promise<LandingExecutionResult> {
	const examined = examineBootstrap(input);
	if (!examined.ok) return { outcome: "refused", arm: examined.arm };
	return executeGuardedLanding(
		{
			mode: "on",
			snapshot: { ...input.snapshot, topologyActive: true },
			consumerId: input.consumerId,
			consumerRunId: input.consumerRunId,
			now: input.now,
			engine: input.engine,
		},
		effects,
	);
}

/** Warning-surface roster: EXEMPT — the service returns fixed arms and persists only closed records. */

import type { BootstrapAuthorization } from "./bootstrap.ts";
import {
	admitTopologySourceClaim,
	admitTopologySourceStep,
	admitTopologySourceTerminal,
	encodeTopologySourceRecord,
	parseTopologySourceClaim,
	parseTopologySourceStep,
	parseTopologySourceTerminal,
	type TopologyCanonicalInstant,
	type TopologySourceClaimRecord,
	type TopologySourceRefusalArm,
	type TopologySourceStepRecord,
	type TopologySourceTerminalRecord,
	topologySourceDigest,
	topologySourcePairKey,
} from "./source-split-contract.ts";
import {
	TOPOLOGY_SOURCE_CLAIM_MARKER,
	TOPOLOGY_SOURCE_STEP_MARKER,
	TOPOLOGY_SOURCE_TERMINAL_MARKER,
} from "./topology-authorization.ts";
import type { TopologyPlan } from "./topology-plan.ts";

export interface TopologySourceComment {
	nodeId: string;
	databaseId: number;
	authorId: string;
	createdAt: string;
	updatedAt: string;
	body: string;
}
export type TopologySourceAuthorization =
	| { ok: true; authorization: BootstrapAuthorization }
	| { ok: false; arm: "authorization-absent" | "authorization-ambiguous"; populationDigest: string }
	| {
			ok: false;
			arm: Exclude<TopologySourceRefusalArm, "authorization-absent" | "authorization-ambiguous">;
			authorizationRecordId?: string;
			expiresAt?: string;
			populationDigest?: string;
	  };
export interface TopologySourceInput {
	repositoryId: string;
	issueId: string;
	writerId: string;
	now: string;
	complete: boolean;
	plan: TopologyPlan;
	freshPlan: TopologyPlan;
	authorization: TopologySourceAuthorization;
	comments: readonly TopologySourceComment[];
}
export type TopologyMutationResult = { kind: "written" } | { kind: "not-written" } | { kind: "unknown" };
export interface TopologySourceEffects {
	canonicalInstant: TopologyCanonicalInstant;
	attestPlan(plan: unknown): plan is TopologyPlan;
	appendAndRead(body: string): Promise<TopologySourceComment | undefined>;
	readComments(): Promise<readonly TopologySourceComment[] | undefined>;
	readState(expectedShape: unknown): Promise<unknown | undefined>;
	mutate(step: TopologyPlan["steps"][number]): Promise<TopologyMutationResult>;
	auditFinal(): Promise<boolean>;
}
export type TopologySourceResult =
	| { outcome: "refused"; arm: TopologySourceRefusalArm; terminal?: TopologySourceTerminalRecord }
	| { outcome: "partial"; arm: TopologySourceRefusalArm; terminal?: TopologySourceTerminalRecord }
	| { outcome: "success"; terminal: TopologySourceTerminalRecord; replay: boolean };

function currentComment(comment: TopologySourceComment, writerId: string): boolean {
	return (
		Number.isSafeInteger(comment.databaseId) &&
		comment.databaseId > 0 &&
		comment.authorId === writerId &&
		comment.createdAt === comment.updatedAt
	);
}
function admittedClaims(
	input: TopologySourceInput,
	authorizationId: string,
	canonicalInstant: TopologyCanonicalInstant,
): Array<{ comment: TopologySourceComment; record: TopologySourceClaimRecord }> {
	return input.comments
		.flatMap((comment) => {
			const value = parseTopologySourceClaim(comment.body);
			return currentComment(comment, input.writerId) &&
				admitTopologySourceClaim(value, canonicalInstant) &&
				value.repositoryId === input.repositoryId &&
				value.issueId === input.issueId &&
				value.authorizationRecordId === authorizationId &&
				value.writerId === comment.authorId
				? [{ comment, record: value }]
				: [];
		})
		.sort((left, right) => left.comment.databaseId - right.comment.databaseId);
}
function admittedSteps(
	input: TopologySourceInput,
	claimId: string,
	canonicalInstant: TopologyCanonicalInstant,
): Array<{ comment: TopologySourceComment; record: TopologySourceStepRecord }> {
	return input.comments.flatMap((comment) => {
		const value = parseTopologySourceStep(comment.body);
		return currentComment(comment, input.writerId) &&
			admitTopologySourceStep(value, canonicalInstant) &&
			value.repositoryId === input.repositoryId &&
			value.issueId === input.issueId &&
			value.claimCommentId === claimId &&
			value.writerId === comment.authorId
			? [{ comment, record: value }]
			: [];
	});
}
function admittedTerminals(
	input: TopologySourceInput,
	canonicalInstant: TopologyCanonicalInstant,
): TopologySourceTerminalRecord[] {
	return input.comments.flatMap((comment) => {
		const value = parseTopologySourceTerminal(comment.body);
		return currentComment(comment, input.writerId) &&
			admitTopologySourceTerminal(value, canonicalInstant) &&
			value.repositoryId === input.repositoryId &&
			value.issueId === input.issueId &&
			value.writerId === comment.authorId
			? [value]
			: [];
	});
}
function sourcePopulationArm(
	input: TopologySourceInput,
	authorizationId: string,
	canonicalInstant: TopologyCanonicalInstant,
): "ownership-mismatch" | "claim-conflict" | undefined {
	for (const comment of input.comments) {
		const marker = [TOPOLOGY_SOURCE_CLAIM_MARKER, TOPOLOGY_SOURCE_STEP_MARKER, TOPOLOGY_SOURCE_TERMINAL_MARKER].find(
			(candidate) => comment.body.includes(candidate),
		);
		if (!marker) continue;
		const value =
			marker === TOPOLOGY_SOURCE_CLAIM_MARKER
				? parseTopologySourceClaim(comment.body)
				: marker === TOPOLOGY_SOURCE_STEP_MARKER
					? parseTopologySourceStep(comment.body)
					: parseTopologySourceTerminal(comment.body);
		const admitted =
			marker === TOPOLOGY_SOURCE_CLAIM_MARKER
				? admitTopologySourceClaim(value, canonicalInstant)
				: marker === TOPOLOGY_SOURCE_STEP_MARKER
					? admitTopologySourceStep(value, canonicalInstant)
					: admitTopologySourceTerminal(value, canonicalInstant);
		if (!admitted || comment.createdAt !== comment.updatedAt) return "claim-conflict";
		const sourceRecord = value as TopologySourceClaimRecord | TopologySourceStepRecord | TopologySourceTerminalRecord;
		if (comment.authorId !== input.writerId || sourceRecord.writerId !== input.writerId) return "ownership-mismatch";
		if (sourceRecord.repositoryId !== input.repositoryId || sourceRecord.issueId !== input.issueId)
			return "claim-conflict";
		if (sourceRecord.authorizationRecordId !== authorizationId) {
			const historicalPreAuthorization =
				marker === TOPOLOGY_SOURCE_TERMINAL_MARKER &&
				sourceRecord.authorizationRecordId === null &&
				"outcome" in sourceRecord &&
				sourceRecord.outcome === "refused";
			if (!historicalPreAuthorization) return "claim-conflict";
		}
	}
	return undefined;
}

export async function executeTopologySourceSplit(
	input: TopologySourceInput,
	effects: TopologySourceEffects,
): Promise<TopologySourceResult> {
	const orders = input.plan.steps.map((step) => step.order);
	let claimId: string | null = null;
	let authorizationId: string | null = null;
	let expiresAt: string | null = null;
	let completed: number[] = [];
	let lastDigest: string | null = null;
	let liveInput = input;

	const publishTerminal = async (
		arm: TopologySourceRefusalArm,
		condition: string,
		observedDigest: string | null,
	): Promise<TopologySourceResult> => {
		const partial = claimId !== null;
		if (!partial) {
			const prior = admittedTerminals(input, effects.canonicalInstant).filter((record) => {
				const mismatch = record.observedMismatch;
				return (
					record.outcome === "refused" &&
					record.authorizationRecordId === authorizationId &&
					mismatch !== null &&
					mismatch.arm === arm &&
					(authorizationId !== null || mismatch.observedDigest === observedDigest)
				);
			});
			if (prior.length === 1) return { outcome: "refused", arm, terminal: prior[0] };
			if (prior.length > 1) return { outcome: "refused", arm: "claim-conflict" };
		}
		const terminal = {
			schemaVersion: 1,
			repositoryId: input.repositoryId,
			issueId: input.issueId,
			authorizationRecordId: authorizationId,
			claimCommentId: claimId,
			outcome: partial ? "partial" : "refused",
			completedOrders: completed,
			lastVerifiedStateDigest: partial ? lastDigest : null,
			observedMismatch: { arm, condition, observedDigest },
			remainingOrders: orders.slice(completed.length),
			expiresAt,
			writerId: input.writerId,
			observedAt: input.now,
		} as TopologySourceTerminalRecord;
		if (!admitTopologySourceTerminal(terminal, effects.canonicalInstant)) {
			if (!partial && authorizationId === null && expiresAt === null) return { outcome: "refused", arm };
			return { outcome: partial ? "partial" : "refused", arm: "record-failed" };
		}
		const body = encodeTopologySourceRecord(TOPOLOGY_SOURCE_TERMINAL_MARKER, terminal);
		const written = await effects.appendAndRead(body);
		const reparsed = parseTopologySourceTerminal(written?.body);
		if (
			!written ||
			written.body !== body ||
			!currentComment(written, input.writerId) ||
			!admitTopologySourceTerminal(reparsed, effects.canonicalInstant)
		)
			return { outcome: partial ? "partial" : "refused", arm: "record-failed" };
		return { outcome: partial ? "partial" : "refused", arm, terminal };
	};

	if (!input.repositoryId || !input.issueId || !input.writerId) return { outcome: "refused", arm: "subject-invalid" };
	if (!input.complete) return { outcome: "refused", arm: "population-incomplete" };
	if (
		!effects.attestPlan(input.plan) ||
		input.plan.stage !== "source-split" ||
		input.plan.repositoryId !== input.repositoryId
	)
		return { outcome: "refused", arm: "plan-invalid" };
	if (input.authorization.ok === false) {
		const refusal = input.authorization;
		authorizationId = "authorizationRecordId" in refusal ? (refusal.authorizationRecordId ?? null) : null;
		expiresAt = "expiresAt" in refusal ? (refusal.expiresAt ?? null) : null;
		const populationDigest = "populationDigest" in refusal ? (refusal.populationDigest ?? null) : null;
		const existing = admittedTerminals(input, effects.canonicalInstant).filter((record) => {
			const mismatch = record.observedMismatch;
			return (
				record.outcome === "refused" &&
				record.authorizationRecordId === authorizationId &&
				mismatch !== null &&
				mismatch.arm === refusal.arm &&
				mismatch.observedDigest === populationDigest
			);
		});
		if (existing.length === 1) return { outcome: "refused", arm: refusal.arm, terminal: existing[0] };
		if (existing.length > 1) return { outcome: "refused", arm: "claim-conflict" };
		return publishTerminal(refusal.arm, "authorization", populationDigest);
	}
	const authorization = input.authorization.authorization;
	authorizationId = authorization.recordId;
	expiresAt = authorization.expiresAt;
	if (authorization.stage !== "source-split") return publishTerminal("stage-mismatch", "stage", null);
	if (
		authorization.repositoryId !== input.repositoryId ||
		authorization.planHash !== input.plan.artifactHash ||
		authorization.correlationId !== input.plan.correlationId ||
		authorization.actorId !== input.plan.actorId ||
		authorization.actorPermission !== "admin"
	)
		return publishTerminal("authorization-unattested", "binding", null);
	if (Date.parse(authorization.expiresAt) <= Date.parse(input.now))
		return publishTerminal("authorization-stale", "expiry", null);
	if (authorization.pairKey !== topologySourcePairKey(input.plan))
		return publishTerminal("pair-mismatch", "pair", null);
	const populationArm = sourcePopulationArm(input, authorization.recordId, effects.canonicalInstant);
	if (populationArm) return publishTerminal(populationArm, "source-record-population", null);

	const priorTerminal = admittedTerminals(input, effects.canonicalInstant).filter(
		(record) => record.authorizationRecordId === authorization.recordId && record.outcome !== "refused",
	);
	if (priorTerminal.length > 1) return publishTerminal("claim-conflict", "terminal-population", null);

	let claims = admittedClaims(liveInput, authorization.recordId, effects.canonicalInstant);
	if (
		claims.some(
			({ record }) =>
				record.planHash !== input.plan.artifactHash ||
				record.pairKey !== authorization.pairKey ||
				record.correlationId !== authorization.correlationId,
		)
	)
		return publishTerminal("claim-conflict", "claim-binding", null);
	if (
		claims.length === 0 &&
		(!effects.attestPlan(input.freshPlan) || input.freshPlan.artifactHash !== input.plan.artifactHash)
	)
		return publishTerminal("live-drift", "fresh-plan", input.freshPlan.beforeDigest);
	if (claims.length >= 1) claimId = claims[0]?.comment.nodeId ?? null;
	else if (priorTerminal.length === 1)
		return { outcome: "partial", arm: "partial-consumed", terminal: priorTerminal[0] };
	else {
		const claim: TopologySourceClaimRecord = {
			schemaVersion: 1,
			repositoryId: input.repositoryId,
			issueId: input.issueId,
			authorizationRecordId: authorization.recordId,
			planHash: input.plan.artifactHash,
			pairKey: authorization.pairKey,
			correlationId: authorization.correlationId,
			writerId: input.writerId,
			claimedAt: input.now,
		};
		const body = encodeTopologySourceRecord(TOPOLOGY_SOURCE_CLAIM_MARKER, claim);
		const written = await effects.appendAndRead(body);
		const reparsed = parseTopologySourceClaim(written?.body);
		if (
			!written ||
			written.body !== body ||
			!currentComment(written, input.writerId) ||
			!admitTopologySourceClaim(reparsed, effects.canonicalInstant)
		)
			return { outcome: "refused", arm: "record-failed" };
		const refreshed = await effects.readComments();
		if (!refreshed) return { outcome: "refused", arm: "population-incomplete" };
		liveInput = { ...input, comments: refreshed };
		const refreshedArm = sourcePopulationArm(liveInput, authorization.recordId, effects.canonicalInstant);
		if (refreshedArm) return { outcome: "refused", arm: refreshedArm };
		claims = admittedClaims(liveInput, authorization.recordId, effects.canonicalInstant);
		if (claims[0]?.comment.nodeId !== written.nodeId) return { outcome: "refused", arm: "claim-conflict" };
		claimId = written.nodeId;
	}
	lastDigest = input.plan.beforeDigest;

	const existing = admittedSteps(liveInput, claimId, effects.canonicalInstant);
	const recordedOrders = [...new Set(existing.map((item) => item.record.order))].sort((left, right) => left - right);
	if (existing.length !== recordedOrders.length || recordedOrders.some((order, index) => order !== index + 1))
		return publishTerminal("partial-consumed", "step-prefix", null);
	for (const item of existing) {
		const planned = input.plan.steps[item.record.order - 1];
		const expectedBefore =
			item.record.order === 1 ? input.plan.before : input.plan.steps[item.record.order - 2]?.postRead;
		if (
			!planned ||
			item.record.planHash !== input.plan.artifactHash ||
			item.record.pairKey !== authorization.pairKey ||
			item.record.method !== planned.method ||
			item.record.path !== planned.path ||
			item.record.requestBodyDigest !== ("body" in planned ? topologySourceDigest(planned.body) : null) ||
			item.record.beforeStateDigest !== topologySourceDigest(expectedBefore) ||
			item.record.afterStateDigest !== topologySourceDigest(planned.postRead)
		)
			return publishTerminal("partial-consumed", "recorded-step-binding", null);
	}
	if (existing.length > 0) {
		const latest = existing.reduce((left, right) => (left.record.order > right.record.order ? left : right));
		const planned = input.plan.steps[latest.record.order - 1];
		const replayState = planned ? await effects.readState(planned.postRead) : undefined;
		const replayDigest = replayState === undefined ? null : topologySourceDigest(replayState);
		if (!planned || replayDigest !== latest.record.afterStateDigest)
			return publishTerminal("partial-consumed", "recorded-prefix", replayDigest);
		completed = recordedOrders;
		lastDigest = replayDigest;
	}
	if (priorTerminal[0]?.outcome === "success") {
		const terminal = priorTerminal[0];
		if (
			terminal.claimCommentId !== claimId ||
			existing.length !== input.plan.steps.length ||
			terminal.completedOrders.length !== orders.length ||
			terminal.completedOrders.some((order, index) => order !== orders[index]) ||
			terminal.remainingOrders.length !== 0 ||
			terminal.lastVerifiedStateDigest !== input.plan.desiredDigest ||
			!(await effects.auditFinal())
		)
			return { outcome: "partial", arm: "partial-consumed", terminal };
		return { outcome: "success", terminal, replay: true };
	}
	if (priorTerminal.length === 1) return { outcome: "partial", arm: "partial-consumed", terminal: priorTerminal[0] };
	for (const step of input.plan.steps) {
		if (recordedOrders.includes(step.order)) continue;
		const expectedBefore = step.order === 1 ? input.plan.before : input.plan.steps[step.order - 2]?.postRead;
		const before = await effects.readState(expectedBefore);
		if (before === undefined) return publishTerminal("population-incomplete", "pre-read", null);
		const beforeDigest = topologySourceDigest(before);
		if (beforeDigest !== topologySourceDigest(expectedBefore))
			return publishTerminal("live-drift", "pre-read", beforeDigest);
		const mutation = await effects.mutate(step);
		if (mutation.kind !== "written") return publishTerminal("write-unverified", mutation.kind, beforeDigest);
		const after = await effects.readState(step.postRead);
		if (after === undefined) return publishTerminal("write-unverified", "post-read-unavailable", null);
		const afterDigest = topologySourceDigest(after);
		if (afterDigest !== topologySourceDigest(step.postRead))
			return publishTerminal("postread-mismatch", "post-read", afterDigest);
		const record: TopologySourceStepRecord = {
			schemaVersion: 1,
			repositoryId: input.repositoryId,
			issueId: input.issueId,
			claimCommentId: claimId,
			authorizationRecordId: authorization.recordId,
			planHash: input.plan.artifactHash,
			pairKey: authorization.pairKey,
			order: step.order,
			method: step.method,
			path: step.path,
			requestBodyDigest: "body" in step ? topologySourceDigest(step.body) : null,
			beforeStateDigest: beforeDigest,
			afterStateDigest: afterDigest,
			observedAt: input.now,
			writerId: input.writerId,
		};
		const body = encodeTopologySourceRecord(TOPOLOGY_SOURCE_STEP_MARKER, record);
		const written = await effects.appendAndRead(body);
		if (
			!written ||
			written.body !== body ||
			!currentComment(written, input.writerId) ||
			!admitTopologySourceStep(parseTopologySourceStep(written.body), effects.canonicalInstant)
		)
			return publishTerminal("record-failed", "step-record", afterDigest);
		completed = [...completed, step.order];
		lastDigest = afterDigest;
	}
	if (!(await effects.auditFinal())) return publishTerminal("audit-failed", "final-audit", lastDigest);
	lastDigest = input.plan.desiredDigest;
	const terminal: TopologySourceTerminalRecord = {
		schemaVersion: 1,
		repositoryId: input.repositoryId,
		issueId: input.issueId,
		authorizationRecordId: authorization.recordId,
		claimCommentId: claimId,
		outcome: "success",
		completedOrders: completed,
		lastVerifiedStateDigest: lastDigest,
		observedMismatch: null,
		remainingOrders: [],
		expiresAt: authorization.expiresAt,
		writerId: input.writerId,
		observedAt: input.now,
	};
	const body = encodeTopologySourceRecord(TOPOLOGY_SOURCE_TERMINAL_MARKER, terminal);
	const written = await effects.appendAndRead(body);
	if (
		!written ||
		written.body !== body ||
		!currentComment(written, input.writerId) ||
		!admitTopologySourceTerminal(parseTopologySourceTerminal(written.body), effects.canonicalInstant)
	)
		return { outcome: "partial", arm: "record-failed" };
	return { outcome: "success", terminal, replay: false };
}

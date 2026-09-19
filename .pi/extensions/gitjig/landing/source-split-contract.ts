/** Warning-surface roster: EXEMPT — data-only interfaces contain no interpolated warning surface. */
/**
 * Data-only source-split record vocabulary settled by #289.
 * This module deliberately exports no parser, writer, executor, or production call site.
 */
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
export interface TopologySourceMismatch {
	arm: string;
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

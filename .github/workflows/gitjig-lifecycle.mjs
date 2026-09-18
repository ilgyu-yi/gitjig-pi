// Handed-over lifecycle predicate and record engine.
// Pure decisions live here; platform adapters supply freshly attested snapshots.

export const RECORD_MARKERS = Object.freeze({
	awaitingAuthor: "<!-- lifecycle-awaiting-author-record: v1 -->",
	blocked: "<!-- lifecycle-blocked-record: v1 -->",
	handoff: "<!-- lifecycle-handoff-record: v1 -->",
	escape: "<!-- lifecycle-escape-record: v1 -->",
	escapeRefusal: "<!-- lifecycle-escape-refusal: v1 -->",
	awaitingAuthorTerminal: "<!-- lifecycle-awaiting-author-terminal: v1 -->",
	blockedTerminal: "<!-- lifecycle-blocked-terminal: v1 -->",
	handoffTerminal: "<!-- lifecycle-handoff-terminal: v1 -->",
	escapeTerminal: "<!-- lifecycle-escape-terminal: v1 -->",
	landingClaim: "<!-- lifecycle-landing-claim: v1 -->",
	landingTerminal: "<!-- lifecycle-landing-terminal: v1 -->",
});

const OID = /^[0-9a-f]{40}$/;
const ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const TERMINAL_ESCAPE_OUTCOMES = new Set(["landed", "refused"]);
const LANDING_CLAIM_KEYS = [
	"schemaVersion",
	"escapeCommentId",
	"replayKey",
	"consumerRunId",
	"consumerId",
	"repositoryId",
	"pullRequestId",
	"headSha",
	"baseSha",
	"claimedAt",
];
const LANDING_TERMINAL_KEYS = [
	"schemaVersion",
	"escapeCommentId",
	"claimCommentId",
	"consumerRunId",
	"writerId",
	"consumedAt",
	"outcome",
	"headSha",
	"baseSha",
];

/** @param {any} value @param {string[]} keys */
function exactObject(value, keys) {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

/** @param {any} value */
function instant(value) {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** @param {any} value */
function nullableOid(value) {
	return value === null || (typeof value === "string" && OID.test(value));
}

/** @param {any} value */
function nonempty(value) {
	return typeof value === "string" && value.trim().length > 0;
}

/** Latest current-head state per actor; unknown actors and stale reviews disappear. */
/** @param {any[]} reviews @param {string} prAuthorId @param {string} headSha */
export function latestEligibleHumanReviews(reviews, prAuthorId, headSha) {
	if (!Array.isArray(reviews) || !nonempty(prAuthorId) || !OID.test(headSha ?? "")) return new Map();
	const latest = new Map();
	for (const review of reviews) {
		if (
			!exactObject(review, ["actorId", "actorType", "association", "state", "headSha", "submittedAt", "dismissed"]) ||
			review.actorType !== "User" ||
			!ASSOCIATIONS.has(review.association) ||
			!nonempty(review.actorId) ||
			(!review.dismissed && review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED") ||
			review.actorId === prAuthorId ||
			review.headSha !== headSha ||
			!instant(review.submittedAt)
		)
			continue;
		const prior = latest.get(review.actorId);
		if (
			prior === undefined ||
			Date.parse(review.submittedAt) > Date.parse(prior.submittedAt) ||
			(Date.parse(review.submittedAt) === Date.parse(prior.submittedAt) &&
				JSON.stringify(review) > JSON.stringify(prior))
		)
			latest.set(review.actorId, review);
	}
	return latest;
}

/** @param {any[]} reviews @param {string} prAuthorId @param {string} headSha @param {number} quorum */
export function eligibleApprovalCount(reviews, prAuthorId, headSha, quorum) {
	if (!Number.isSafeInteger(quorum) || quorum <= 0) return { ok: false, arm: "quorum-unmeasurable" };
	const latest = latestEligibleHumanReviews(reviews, prAuthorId, headSha);
	const count = [...latest.values()].filter((review) => !review.dismissed && review.state === "APPROVED").length;
	return { ok: count >= quorum, arm: count >= quorum ? "quorum-satisfied" : "quorum-missing", count, quorum };
}

/** @param {any} review @param {string} prAuthorId @param {string} headSha */
export function eligibleChangesRequested(review, prAuthorId, headSha) {
	const latest = latestEligibleHumanReviews([review], prAuthorId, headSha);
	const admitted = [...latest.values()][0];
	return admitted !== undefined && !admitted.dismissed && admitted.state === "CHANGES_REQUESTED";
}

/** @param {any} snapshot */
export function authorizedMaintainer(snapshot) {
	return (
		exactObject(snapshot, ["actorId", "actorType", "repositoryId", "addressedRepositoryId", "permission"]) &&
		snapshot.actorType === "User" &&
		nonempty(snapshot.actorId) &&
		snapshot.repositoryId === snapshot.addressedRepositoryId &&
		(snapshot.permission === "MAINTAIN" || snapshot.permission === "ADMIN")
	);
}

/** Resolver records require a freshly addressed human collaborator role. */
/** @param {any} snapshot */
export function authorizedResolver(snapshot) {
	return (
		exactObject(snapshot, ["actorId", "actorType", "repositoryId", "addressedRepositoryId", "permission"]) &&
		snapshot.actorType === "User" &&
		nonempty(snapshot.actorId) &&
		snapshot.repositoryId === snapshot.addressedRepositoryId &&
		new Set(["WRITE", "MAINTAIN", "ADMIN"]).has(snapshot.permission)
	);
}

/** @param {any} snapshot @param {any} policy */
export function authorizedPolicyApp(snapshot, policy) {
	return (
		exactObject(snapshot, [
			"actorId",
			"actorType",
			"installationId",
			"nodeId",
			"repositoryId",
			"addressedRepositoryId",
		]) &&
		exactObject(policy, ["installationId", "nodeId"]) &&
		snapshot.actorType === "App" &&
		snapshot.repositoryId === snapshot.addressedRepositoryId &&
		snapshot.installationId === policy.installationId &&
		snapshot.nodeId === policy.nodeId &&
		nonempty(snapshot.actorId)
	);
}

/** App identity never substitutes for fresh, complete clear review evidence. */
/** @param {any} snapshot @param {any} policy @param {any} evidence */
export function authorizedPolicyProducer(snapshot, policy, evidence) {
	return (
		authorizedPolicyApp(snapshot, policy) &&
		exactObject(evidence, ["complete", "outcome", "prHead", "baseHead", "currentPrHead", "currentBaseHead"]) &&
		evidence.complete === true &&
		evidence.outcome === "clear" &&
		OID.test(evidence.prHead ?? "") &&
		OID.test(evidence.baseHead ?? "") &&
		evidence.prHead === evidence.currentPrHead &&
		evidence.baseHead === evidence.currentBaseHead
	);
}

/** @param {{producerId:string,prAuthorId:string,beneficiaryIds:string[],controlledIdentityIds:string[]}} input */
export function ownBehalfRefusal({ producerId, prAuthorId, beneficiaryIds, controlledIdentityIds }) {
	if (
		!nonempty(producerId) ||
		!nonempty(prAuthorId) ||
		!Array.isArray(beneficiaryIds) ||
		!beneficiaryIds.every(nonempty) ||
		!Array.isArray(controlledIdentityIds) ||
		!controlledIdentityIds.every(nonempty)
	)
		return true;
	return producerId === prAuthorId || beneficiaryIds.includes(producerId) || controlledIdentityIds.includes(producerId);
}

const AWAITING_KEYS = ["producer", "producerKind", "observedAt", "subjectHead", "baseHead"];
const BLOCKED_KEYS = ["condition", "recovery", "observedAt", "subjectHead", "baseHead"];
const HANDOFF_KEYS = ["cause", "recipient", "reentry", "observedAt", "subjectHead", "baseHead"];
const AWAITING_TERMINAL_KEYS = ["recordCommentId", "clearerId", "clearedAt", "cause", "subjectHead", "baseHead"];
const TRANSITION_TERMINAL_KEYS = ["recordCommentId", "transition", "observedAt", "subjectHead", "baseHead"];
export const ESCAPE_KEYS = [
	"schemaVersion",
	"repositoryId",
	"pullRequestId",
	"headSha",
	"baseRef",
	"baseSha",
	"producerKind",
	"producerId",
	"producerPermission",
	"reason",
	"appliedAt",
	"expiresAt",
	"consumedAt",
	"consumerRunId",
	"outcome",
];

/** @param {any} value @param {"issue"|"pull"} subjectKind */
export function admitAwaitingAuthorRecord(value, subjectKind) {
	if (!exactObject(value, AWAITING_KEYS) || !nonempty(value.producer) || !instant(value.observedAt)) return false;
	if (!new Set(["resolver-repair", "human-changes-requested"]).has(value.producerKind)) return false;
	if (subjectKind === "issue") return value.subjectHead === null && value.baseHead === null;
	return subjectKind === "pull" && OID.test(value.subjectHead ?? "") && OID.test(value.baseHead ?? "");
}

/** @param {any} value */
export function admitAwaitingAuthorTerminal(value) {
	return (
		exactObject(value, AWAITING_TERMINAL_KEYS) &&
		Number.isSafeInteger(value.recordCommentId) &&
		value.recordCommentId > 0 &&
		nonempty(value.clearerId) &&
		instant(value.clearedAt) &&
		new Set(["pull-synchronize", "issue-author-body-edit"]).has(value.cause) &&
		nullableOid(value.subjectHead) &&
		nullableOid(value.baseHead)
	);
}

/** @param {any} value */
export function admitTransitionTerminal(value) {
	return (
		exactObject(value, TRANSITION_TERMINAL_KEYS) &&
		Number.isSafeInteger(value.recordCommentId) &&
		value.recordCommentId > 0 &&
		new Set(["blocked-clear", "handoff-reentry", "escape-revoke", "escape-invalidate", "escape-expire"]).has(
			value.transition,
		) &&
		instant(value.observedAt) &&
		nullableOid(value.subjectHead) &&
		nullableOid(value.baseHead)
	);
}

/** @param {any} value */
export function admitBlockedRecord(value) {
	return (
		exactObject(value, BLOCKED_KEYS) &&
		nonempty(value.condition) &&
		nonempty(value.recovery) &&
		instant(value.observedAt) &&
		nullableOid(value.subjectHead) &&
		nullableOid(value.baseHead)
	);
}

/** @param {any} value */
export function admitHandoffRecord(value) {
	return (
		exactObject(value, HANDOFF_KEYS) &&
		nonempty(value.cause) &&
		nonempty(value.recipient) &&
		nonempty(value.reentry) &&
		instant(value.observedAt) &&
		nullableOid(value.subjectHead) &&
		nullableOid(value.baseHead)
	);
}

/** @param {any} value @param {any} context */
export function validateEscapeRecord(value, context) {
	if (!exactObject(value, ESCAPE_KEYS)) return { ok: false, arm: "record-shape" };
	if (value.schemaVersion !== 1) return { ok: false, arm: "schema-version" };
	if (value.producerKind !== "maintainer" && value.producerKind !== "app") return { ok: false, arm: "producer-kind" };
	if (value.producerKind === "maintainer" && !new Set(["MAINTAIN", "ADMIN"]).has(value.producerPermission))
		return { ok: false, arm: "producer-permission" };
	if (value.producerKind === "app" && value.producerPermission !== null)
		return { ok: false, arm: "producer-permission" };
	if (!nonempty(value.producerId) || !nonempty(value.reason) || !nonempty(value.baseRef))
		return { ok: false, arm: "record-value" };
	if (value.producerId !== context.carryingCommentAuthorId) return { ok: false, arm: "producer-attestation" };
	if (
		(value.producerKind === "maintainer" && value.producerPermission !== context.livePermission) ||
		(value.producerKind === "app" && context.appAttested !== true)
	)
		return { ok: false, arm: "producer-attestation" };
	if (!OID.test(value.headSha ?? "") || !OID.test(value.baseSha ?? "")) return { ok: false, arm: "record-head" };
	if (!instant(value.appliedAt) || !instant(value.expiresAt) || !instant(context.now))
		return { ok: false, arm: "clock" };
	if (Date.parse(value.expiresAt) - Date.parse(value.appliedAt) !== 24 * 60 * 60 * 1000)
		return { ok: false, arm: "expiry-shape" };
	if (Date.parse(context.now) >= Date.parse(value.expiresAt)) return { ok: false, arm: "expired" };
	if (
		value.repositoryId !== context.repositoryId ||
		value.pullRequestId !== context.pullRequestId ||
		value.headSha !== context.headSha ||
		value.baseRef !== context.baseRef ||
		value.baseSha !== context.baseSha
	)
		return { ok: false, arm: "subject-mismatch" };
	if (!context.labelPresent) return { ok: false, arm: "label-removed" };
	if (value.consumedAt !== null || value.consumerRunId !== null || value.outcome !== null)
		return { ok: false, arm: "consumed" };
	return { ok: true, arm: "valid" };
}

/** @param {string} marker @param {any} record */
export function encodeRecord(marker, record) {
	if (!Object.values(RECORD_MARKERS).map(String).includes(marker)) throw new Error("unknown lifecycle marker");
	return `${marker}\n\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\``;
}

/** @param {any} body @param {string} marker */
export function parseMarkedRecord(body, marker) {
	if (typeof body !== "string" || !body.startsWith(`${marker}\n`)) return undefined;
	const match = body.match(/\n```json\n([^\n]+)\n```\s*$/);
	if (match === null) return undefined;
	try {
		return JSON.parse(match[1]);
	} catch {
		return undefined;
	}
}

/** @param {any[]} comments @param {string} marker @param {(value:any)=>boolean} admit */
export function admitSingleCurrentRecord(comments, marker, admit) {
	const records = comments
		.map((comment) => ({ comment, record: parseMarkedRecord(comment.body, marker) }))
		.filter(({ record }) => record !== undefined && admit(record));
	return records.length === 1 ? records[0] : undefined;
}

/**
 * Inspect one fully attested marker population. Adapters must set `attested: true`
 * only after re-reading the carrying comment identity and its live authority.
 * @param {any[]} comments @param {"issue"|"pull"} subjectKind
 */
export function inspectAwaitingAuthorPopulation(comments, subjectKind) {
	if (!Array.isArray(comments)) return { ok: false, arm: "population-unmeasurable" };
	const records = [];
	const terminals = [];
	for (const comment of comments) {
		if (typeof comment?.body !== "string") continue;
		if (comment.body.startsWith(RECORD_MARKERS.awaitingAuthor)) {
			const record = parseMarkedRecord(comment.body, RECORD_MARKERS.awaitingAuthor);
			if (
				comment.attested !== true ||
				!Number.isSafeInteger(comment.id) ||
				record === undefined ||
				!admitAwaitingAuthorRecord(record, subjectKind)
			)
				return { ok: false, arm: "record-unparseable" };
			records.push({ comment, record });
		}
		if (comment.body.startsWith(RECORD_MARKERS.awaitingAuthorTerminal)) {
			const record = parseMarkedRecord(comment.body, RECORD_MARKERS.awaitingAuthorTerminal);
			if (
				comment.attested !== true ||
				record === undefined ||
				!admitAwaitingAuthorTerminal(record) ||
				comment.authorId !== record.clearerId
			)
				return { ok: false, arm: "terminal-unparseable" };
			terminals.push({ comment, record });
		}
	}
	const recordIds = new Set(records.map(({ comment }) => comment.id));
	const terminalIds = terminals.map(({ record }) => record.recordCommentId);
	if (terminalIds.some((id) => !recordIds.has(id)) || new Set(terminalIds).size !== terminalIds.length)
		return { ok: false, arm: "terminal-ambiguous" };
	const terminalized = new Set(terminalIds);
	const current = records.filter(({ comment }) => !terminalized.has(comment.id));
	const replayKeys = current.map(({ record }) =>
		JSON.stringify([record.producer, record.producerKind, record.subjectHead, record.baseHead]),
	);
	if (new Set(replayKeys).size !== replayKeys.length || current.length > 1)
		return { ok: false, arm: "record-ambiguous", current, terminals };
	return { ok: true, current, terminals };
}

/** Compatibility helper for callers that require exactly one current record. */
/** @param {any[]} comments @param {"issue"|"pull"} subjectKind */
export function admitCurrentAwaitingAuthor(comments, subjectKind) {
	const population = inspectAwaitingAuthorPopulation(comments, subjectKind);
	const current = population.current ?? [];
	return population.ok && current.length === 1 ? current[0] : undefined;
}

/** @param {string} recordBody @param {string} label */
export function recordThenLabelPlan(recordBody, label) {
	return Object.freeze([
		{ kind: "comment", body: recordBody },
		{ kind: "add-label", label },
	]);
}

/** @param {string} recordBody @param {string} label */
export function terminalThenUnlabelPlan(recordBody, label) {
	return Object.freeze([
		{ kind: "comment", body: recordBody },
		{ kind: "remove-label", label },
	]);
}

/** @param {any} record */
export function handoffKey(record) {
	if (!admitHandoffRecord(record)) return undefined;
	return JSON.stringify([record.cause, record.recipient, record.reentry, record.subjectHead, record.baseHead]);
}

/** @param {string} arm @param {string} observedAt */
export function escapeRefusalRecord(arm, observedAt) {
	if (!/^[a-z][a-z0-9-]*$/.test(arm) || !instant(observedAt)) throw new Error("invalid escape refusal");
	return { arm, observedAt };
}

/** @param {any} input */
export function createEscapeRecord(input) {
	const applied = Date.parse(input.appliedAt);
	if (!Number.isFinite(applied)) return undefined;
	const permission = input.producerKind === "app" ? null : input.producerPermission;
	const record = {
		schemaVersion: 1,
		repositoryId: input.repositoryId,
		pullRequestId: input.pullRequestId,
		headSha: input.headSha,
		baseRef: input.baseRef,
		baseSha: input.baseSha,
		producerKind: input.producerKind,
		producerId: input.producerId,
		producerPermission: permission,
		reason: input.reason,
		appliedAt: input.appliedAt,
		expiresAt: new Date(applied + 24 * 60 * 60 * 1000).toISOString(),
		consumedAt: null,
		consumerRunId: null,
		outcome: null,
	};
	return Object.keys(record).length === ESCAPE_KEYS.length ? record : undefined;
}

/** @param {any} value */
export function validTerminalEscapeFields(value) {
	return instant(value.consumedAt) && nonempty(value.consumerRunId) && TERMINAL_ESCAPE_OUTCOMES.has(value.outcome);
}

/** Platform-neutral blocked writer; adapters execute the returned closed plan. */
/** @param {any} record */
export function createBlockedTransition(record) {
	if (!admitBlockedRecord(record)) return { ok: false, arm: "blocked-record" };
	return {
		ok: true,
		plan: recordThenLabelPlan(encodeRecord(RECORD_MARKERS.blocked, record), "blocked"),
	};
}

/** Blocked clear never changes Proposed/Active and refuses changed Active Directives. */
/** @param {any} input */
export function clearBlockedTransition(input) {
	if (!new Set(["Proposed", "Active"]).has(input.status)) return { ok: false, arm: "blocked-status" };
	if (input.status === "Active" && input.directiveChanged === true) return { ok: false, arm: "activation-required" };
	const terminal = {
		recordCommentId: input.recordCommentId,
		transition: "blocked-clear",
		observedAt: input.observedAt,
		subjectHead: input.subjectHead,
		baseHead: input.baseHead,
	};
	if (!admitTransitionTerminal(terminal)) return { ok: false, arm: "blocked-terminal" };
	return {
		ok: true,
		preservedStatus: input.status,
		plan: terminalThenUnlabelPlan(encodeRecord(RECORD_MARKERS.blockedTerminal, terminal), "blocked"),
	};
}

/** @param {any} record */
export function createHandoffTransition(record) {
	if (!admitHandoffRecord(record)) return { ok: false, arm: "handoff-record" };
	return {
		ok: true,
		key: handoffKey(record),
		plan: [{ kind: "comment", body: encodeRecord(RECORD_MARKERS.handoff, record) }],
	};
}

/** @param {any} input */
export function reenterHandoffTransition(input) {
	const terminal = {
		recordCommentId: input.recordCommentId,
		transition: "handoff-reentry",
		observedAt: input.observedAt,
		subjectHead: input.subjectHead,
		baseHead: input.baseHead,
	};
	if (!admitTransitionTerminal(terminal)) return { ok: false, arm: "handoff-terminal" };
	return { ok: true, plan: [{ kind: "comment", body: encodeRecord(RECORD_MARKERS.handoffTerminal, terminal) }] };
}

/** Escape creation remains record-first; absence of App policy must be decided before this entry point. */
/** @param {any} input */
export function createEscapeTransition(input) {
	const record = createEscapeRecord(input);
	if (record === undefined) return { ok: false, arm: "escape-record" };
	const authority =
		record.producerKind === "maintainer"
			? authorizedMaintainer(input.authoritySnapshot)
			: authorizedPolicyProducer(input.authoritySnapshot, input.policy, input.evidence);
	if (!authority || input.authoritySnapshot?.actorId !== record.producerId)
		return { ok: false, arm: "producer-unauthorized" };
	if (
		ownBehalfRefusal({
			producerId: record.producerId,
			prAuthorId: input.prAuthorId,
			beneficiaryIds: input.beneficiaryIds,
			controlledIdentityIds: input.controlledIdentityIds,
		})
	)
		return { ok: false, arm: "own-behalf" };
	const subject = input.subjectSnapshot;
	if (
		!exactObject(subject, ["repositoryId", "pullRequestId", "headSha", "baseRef", "baseSha"]) ||
		input.authoritySnapshot.repositoryId !== subject.repositoryId ||
		input.authoritySnapshot.addressedRepositoryId !== subject.repositoryId
	)
		return { ok: false, arm: "authority-subject-mismatch" };
	const creationValidity = validateEscapeRecord(record, {
		carryingCommentAuthorId: input.authoritySnapshot.actorId,
		livePermission: input.authoritySnapshot.permission,
		appAttested: record.producerKind === "app",
		now: input.currentTime,
		repositoryId: subject?.repositoryId,
		pullRequestId: subject?.pullRequestId,
		headSha: subject?.headSha,
		baseRef: subject?.baseRef,
		baseSha: subject?.baseSha,
		labelPresent: true,
	});
	if (!creationValidity.ok) return { ok: false, arm: creationValidity.arm };
	if (input.currentTime !== record.appliedAt) return { ok: false, arm: "clock" };
	return {
		ok: true,
		record,
		plan: recordThenLabelPlan(encodeRecord(RECORD_MARKERS.escape, record), "merge:bypass-permitted"),
	};
}

/** Every examined refusal has exactly one content-free terminal refusal write. */
/** @param {any} record @param {any} context @param {string} observedAt */
export function examineEscapeTransition(record, context, observedAt) {
	const decision = validateEscapeRecord(record, context);
	if (decision.ok) return { ok: true, arm: "valid", plan: [] };
	const refusal = escapeRefusalRecord(decision.arm, observedAt);
	return {
		ok: false,
		arm: decision.arm,
		plan: [{ kind: "comment", body: encodeRecord(RECORD_MARKERS.escapeRefusal, refusal) }],
	};
}

/** @param {any} input */
export function terminateEscapeTransition(input) {
	if (!new Set(["escape-revoke", "escape-invalidate", "escape-expire"]).has(input.transition))
		return { ok: false, arm: "escape-transition" };
	const terminal = {
		recordCommentId: input.recordCommentId,
		transition: input.transition,
		observedAt: input.observedAt,
		subjectHead: input.subjectHead,
		baseHead: input.baseHead,
	};
	if (!admitTransitionTerminal(terminal)) return { ok: false, arm: "escape-terminal" };
	return {
		ok: true,
		plan: terminalThenUnlabelPlan(encodeRecord(RECORD_MARKERS.escapeTerminal, terminal), "merge:bypass-permitted"),
	};
}

/** @param {any} value */
export function admitLandingClaim(value) {
	return (
		exactObject(value, LANDING_CLAIM_KEYS) &&
		value.schemaVersion === 1 &&
		Number.isSafeInteger(value.escapeCommentId) &&
		value.escapeCommentId > 0 &&
		nonempty(value.replayKey) &&
		nonempty(value.consumerRunId) &&
		nonempty(value.consumerId) &&
		nonempty(value.repositoryId) &&
		nonempty(value.pullRequestId) &&
		OID.test(value.headSha ?? "") &&
		OID.test(value.baseSha ?? "") &&
		instant(value.claimedAt)
	);
}

/** @param {any} input */
export function createLandingClaim(input) {
	const claim = {
		schemaVersion: 1,
		escapeCommentId: input.escapeCommentId,
		replayKey: input.replayKey,
		consumerRunId: input.consumerRunId,
		consumerId: input.consumerId,
		repositoryId: input.repositoryId,
		pullRequestId: input.pullRequestId,
		headSha: input.headSha,
		baseSha: input.baseSha,
		claimedAt: input.claimedAt,
	};
	return admitLandingClaim(claim) ? claim : undefined;
}

/** Lowest platform comment id wins; unattested or unauthorized comments never claim. @param {any[]} comments @param {string} replayKey @param {string[]} authorizedConsumerIds */
export function landingClaimWinner(comments, replayKey, authorizedConsumerIds) {
	if (!Array.isArray(comments) || !nonempty(replayKey) || !Array.isArray(authorizedConsumerIds)) return undefined;
	const admitted = comments.flatMap((comment) => {
		if (!exactObject(comment, ["id", "authorId", "body"]) || !Number.isSafeInteger(comment.id) || comment.id <= 0)
			return [];
		const claim = parseMarkedRecord(comment.body, RECORD_MARKERS.landingClaim);
		return admitLandingClaim(claim) &&
			claim.replayKey === replayKey &&
			claim.consumerId === comment.authorId &&
			authorizedConsumerIds.includes(comment.authorId)
			? [{ id: comment.id, claim }]
			: [];
	});
	return admitted.sort((left, right) => left.id - right.id)[0];
}

/** @param {any} value */
export function admitLandingTerminal(value) {
	return (
		exactObject(value, LANDING_TERMINAL_KEYS) &&
		value.schemaVersion === 1 &&
		Number.isSafeInteger(value.escapeCommentId) &&
		value.escapeCommentId > 0 &&
		(value.claimCommentId === null || (Number.isSafeInteger(value.claimCommentId) && value.claimCommentId > 0)) &&
		nonempty(value.consumerRunId) &&
		nonempty(value.writerId) &&
		instant(value.consumedAt) &&
		TERMINAL_ESCAPE_OUTCOMES.has(value.outcome) &&
		OID.test(value.headSha ?? "") &&
		OID.test(value.baseSha ?? "")
	);
}

/** @param {any} input */
export function createLandingTerminalPlan(input) {
	const terminal = {
		schemaVersion: 1,
		escapeCommentId: input.escapeCommentId,
		claimCommentId: input.claimCommentId,
		consumerRunId: input.consumerRunId,
		writerId: input.writerId,
		consumedAt: input.consumedAt,
		outcome: input.outcome,
		headSha: input.headSha,
		baseSha: input.baseSha,
	};
	if (!admitLandingTerminal(terminal)) return { ok: false, arm: "landing-terminal" };
	return {
		ok: true,
		plan: terminalThenUnlabelPlan(encodeRecord(RECORD_MARKERS.landingTerminal, terminal), "merge:bypass-permitted"),
	};
}

/** Execute one plan sequentially; a failed record write cannot reach a label operation. */
/** @param {readonly any[]} plan @param {{comment:(body:string)=>Promise<void>,addLabel:(label:string)=>Promise<void>,removeLabel:(label:string)=>Promise<void>}} effects */
export async function executeTransitionPlan(plan, effects) {
	for (const operation of plan) {
		if (operation.kind === "comment") await effects.comment(operation.body);
		else if (operation.kind === "add-label") await effects.addLabel(operation.label);
		else if (operation.kind === "remove-label") await effects.removeLabel(operation.label);
		else throw new Error("unknown lifecycle transition operation");
	}
}

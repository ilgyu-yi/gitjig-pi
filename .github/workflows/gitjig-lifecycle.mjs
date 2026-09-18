// Handed-over lifecycle predicate and record engine.
// Pure decisions live here; platform adapters supply freshly attested snapshots.

export const RECORD_MARKERS = Object.freeze({
	awaitingAuthor: "<!-- lifecycle-awaiting-author-record: v1 -->",
	blocked: "<!-- lifecycle-blocked-record: v1 -->",
	handoff: "<!-- lifecycle-handoff-record: v1 -->",
	escape: "<!-- lifecycle-escape-record: v1 -->",
	escapeRefusal: "<!-- lifecycle-escape-refusal: v1 -->",
	awaitingAuthorTerminal: "<!-- lifecycle-awaiting-author-terminal: v1 -->",
});

const OID = /^[0-9a-f]{40}$/;
const ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const TERMINAL_ESCAPE_OUTCOMES = new Set(["landed", "refused"]);

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
			review.actorId === prAuthorId ||
			review.headSha !== headSha ||
			!instant(review.submittedAt)
		)
			continue;
		const prior = latest.get(review.actorId);
		if (prior === undefined || Date.parse(review.submittedAt) > Date.parse(prior.submittedAt))
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

/** @param {{producerId:string,prAuthorId:string,beneficiaryIds?:string[],controlledIdentityIds?:string[]}} input */
export function ownBehalfRefusal({ producerId, prAuthorId, beneficiaryIds = [], controlledIdentityIds = [] }) {
	return producerId === prAuthorId || beneficiaryIds.includes(producerId) || controlledIdentityIds.includes(producerId);
}

const AWAITING_KEYS = ["producer", "producerKind", "observedAt", "subjectHead", "baseHead"];
const BLOCKED_KEYS = ["condition", "recovery", "observedAt", "subjectHead", "baseHead"];
const HANDOFF_KEYS = ["cause", "recipient", "reentry", "observedAt", "subjectHead", "baseHead"];
const AWAITING_TERMINAL_KEYS = ["recordCommentId", "clearedAt", "cause", "subjectHead", "baseHead"];
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
		instant(value.clearedAt) &&
		new Set(["pull-synchronize", "issue-author-body-edit"]).has(value.cause) &&
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

/** @param {any[]} comments @param {"issue"|"pull"} subjectKind */
export function admitCurrentAwaitingAuthor(comments, subjectKind) {
	const terminalized = new Set(
		comments
			.map((comment) => parseMarkedRecord(comment.body, RECORD_MARKERS.awaitingAuthorTerminal))
			.filter(admitAwaitingAuthorTerminal)
			.map((record) => record.recordCommentId),
	);
	const records = comments
		.map((comment) => ({ comment, record: parseMarkedRecord(comment.body, RECORD_MARKERS.awaitingAuthor) }))
		.filter(
			({ comment, record }) =>
				!terminalized.has(comment.id) && record !== undefined && admitAwaitingAuthorRecord(record, subjectKind),
		);
	return records.length === 1 ? records[0] : undefined;
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

/**
 * The §1.4 review-history handoff record and its re-entry (SPEC §1.4,
 * "Handoff record and re-entry for this gate", #402/#404). The handed-over
 * #276 engine owns the record and terminal schemas, their admission and the
 * `authorizedResolver` predicate; `lifecycle-attestation.ts` decides which
 * carrying comments are attested. This module only classifies this gate's
 * records by their fixed `cause`, finds the one standing record, computes the
 * honored re-entry reset point, and composes the engine's own record and
 * terminal bodies for the caller to publish.
 *
 * Warning-surface roster: EXEMPT — it composes closed engine records and
 * returns fixed-literal causes; it renders no actor-influenced text.
 */
import { attestTransitionComments, type LifecycleComment, type PermissionOf } from "../lifecycle-attestation.ts";
import type { AttestedCommentPopulation } from "./comments.ts";
import { legacyUnderivable, repairHistory } from "./history.ts";
import { parseReviewRecord, REVIEW_RECORD_MARKER, type ReviewRecord } from "./record.ts";

type Engine = typeof import("../../../../.github/workflows/gitjig-lifecycle.mjs");

/** The three settled `cause` literals, one per limb (SPEC §1.4). */
export const HISTORY_HANDOFF_CAUSE = Object.freeze({
	a: "review-history-legacy-underivable",
	b: "review-history-diagnosis-handoff",
	c: "review-history-unmeasured",
} as const);

export type HistoryLimb = keyof typeof HISTORY_HANDOFF_CAUSE;
export type HistoryReentry = "nothing" | "plan" | "authorization" | "none";

type HandoffRecord = {
	cause: string;
	recipient: string;
	reentry: string;
	observedAt: string;
	subjectHead: string | null;
	baseHead: string | null;
};

export type StandingHandoff = { commentId: number; record: HandoffRecord; limb: HistoryLimb | undefined };

export type HistoryHandoffView =
	| { ok: false; cause: string }
	| {
			ok: true;
			/** The one unterminated handoff record of any cause or owner, if one stands. */
			standing: StandingHandoff | undefined;
			/** Comment id after which review records form this gate's run; undefined when no re-entry is honored. */
			resetAfter: number | undefined;
	  };

function limbOf(cause: string): HistoryLimb | undefined {
	for (const [limb, literal] of Object.entries(HISTORY_HANDOFF_CAUSE))
		if (literal === cause) return limb as HistoryLimb;
	return undefined;
}

/**
 * Admit only the review-record writer's own records, in platform order, each
 * paired with its comment id. Undefined when any marked record is malformed.
 */
function orderedReviewRecords(
	comments: readonly LifecycleComment[],
	writerId: string,
): { commentId: number; record: ReviewRecord }[] | undefined {
	const opening = `<!-- ${REVIEW_RECORD_MARKER}:`;
	const records: { commentId: number; record: ReviewRecord }[] = [];
	for (const comment of comments) {
		if (comment.authorId !== writerId || !comment.body.startsWith(opening)) continue;
		const record = parseReviewRecord(comment.body);
		if (record === undefined) return undefined;
		records.push({ commentId: comment.id, record });
	}
	return records;
}

/**
 * Read this gate's handoff state from one attested comment population. The
 * engine inspects the whole handoff population; more than one current record,
 * an unattested carrier or a malformed marker refuses. A terminal is an
 * honored re-entry only when it references a limb-(a) or limb-(b) record, and a
 * limb-(a) terminal only while the record-local classifier still refuses on
 * the review records that precede it (the engine admits any non-empty cause).
 * Limb-(c) terminals end a record but never reset the run.
 */
export async function readHistoryHandoffs(
	engine: Engine,
	population: AttestedCommentPopulation,
	repositoryId: string,
	writerId: string,
	permissionOf: PermissionOf,
): Promise<HistoryHandoffView> {
	if (!population.ok) return { ok: false, cause: "the handoff population was unreadable" };
	const comments = population.comments;
	const attested = await attestTransitionComments(engine, comments, repositoryId, permissionOf);
	const inspected = engine.inspectHandoffPopulation(attested);
	if (!inspected.ok) return { ok: false, cause: "the handoff population was ambiguous or unattested" };
	// An unreadable review record never refuses the handoff population: it only
	// withholds every limb-(a) honor below, so the round still reaches its own
	// history read and records that stop as limb (c) (#404).
	const reviews = orderedReviewRecords(comments, writerId);
	const position = new Map(comments.map((comment, index) => [comment.id, index]));
	const records = new Map<number, HandoffRecord>();
	for (const comment of attested) {
		const record = engine.parseMarkedRecord(comment.body, engine.RECORD_MARKERS.handoff) as HandoffRecord | undefined;
		if (record !== undefined) records.set(comment.id, record);
	}
	let resetAfter: number | undefined;
	// A limb-(a) terminal the classifier no longer supports is a refusal (§1.4):
	// the engine counts its record as terminalized, but the hand-off it ended
	// still stands, so the round fails closed to it (#404).
	const dishonored: Array<{ commentId: number; record: HandoffRecord }> = [];
	const terminals = [...(inspected.terminals ?? [])].sort(
		(left, right) => (position.get(left.comment.id) ?? 0) - (position.get(right.comment.id) ?? 0),
	);
	for (const { comment, record } of terminals) {
		const referenced = records.get(record.recordCommentId);
		const limb = referenced === undefined ? undefined : limbOf(referenced.cause);
		if (limb !== "a" && limb !== "b") continue;
		if (limb === "a") {
			const refuse = () => {
				if (referenced !== undefined) dishonored.push({ commentId: record.recordCommentId, record: referenced });
			};
			if (reviews === undefined) {
				refuse();
				continue;
			}
			const at = position.get(comment.id) ?? -1;
			const from = resetAfter === undefined ? -1 : (position.get(resetAfter) ?? -1);
			const before = reviews
				.filter(({ commentId }) => {
					const index = position.get(commentId) ?? -1;
					return index > from && index < at;
				})
				.map(({ record: review }) => review);
			if (!legacyUnderivable(repairHistory(before))) {
				refuse();
				continue;
			}
		}
		resetAfter = comment.id;
	}
	const standingRecords = [
		...(inspected.current ?? []).map((current) => ({
			commentId: current.comment.id,
			record: current.record as HandoffRecord,
		})),
		...dishonored,
	];
	// More than one standing record is the ambiguity the engine itself refuses.
	if (standingRecords.length > 1) return { ok: false, cause: "more than one handoff record stands" };
	const only = standingRecords[0];
	const standing = only === undefined ? undefined : { ...only, limb: limbOf(only.record.cause) };
	return { ok: true, standing, resetAfter };
}

/** The review records that form this gate's run: those posted after the honored reset. */
export function recordsAfterReset(
	population: AttestedCommentPopulation,
	records: readonly ReviewRecord[] | undefined,
	writerId: string,
	resetAfter: number | undefined,
): ReviewRecord[] | undefined {
	if (records === undefined || !population.ok) return undefined;
	if (resetAfter === undefined) return [...records];
	const ordered = orderedReviewRecords(population.comments, writerId);
	if (ordered === undefined) return undefined;
	const at = population.comments.findIndex((comment) => comment.id === resetAfter);
	if (at < 0) return undefined;
	const position = new Map(population.comments.map((comment, index) => [comment.id, index]));
	return ordered.filter(({ commentId }) => (position.get(commentId) ?? -1) > at).map(({ record }) => record);
}

/** The engine's record body for one limb at the exact PR heads. */
export function historyHandoffBody(
	engine: Engine,
	limb: HistoryLimb,
	reentry: HistoryReentry,
	subjectHead: string,
	baseHead: string,
	observedAt: string,
): string | undefined {
	const planned = engine.createHandoffTransition({
		cause: HISTORY_HANDOFF_CAUSE[limb],
		recipient: "maintainer",
		reentry: limb === "b" ? reentry : "none",
		observedAt,
		subjectHead,
		baseHead,
	});
	const operation = planned.ok ? planned.plan?.[0] : undefined;
	return operation?.kind === "comment" ? operation.body : undefined;
}

/** The engine's `handoff-reentry` terminal body for one standing record, at that record's heads. */
export function historyReentryBody(engine: Engine, standing: StandingHandoff, observedAt: string): string | undefined {
	const planned = engine.reenterHandoffTransition({
		recordCommentId: standing.commentId,
		observedAt,
		subjectHead: standing.record.subjectHead,
		baseHead: standing.record.baseHead,
	});
	const operation = planned.ok ? planned.plan?.[0] : undefined;
	return operation?.kind === "comment" ? operation.body : undefined;
}

/**
 * The /review-round production call site for one composed review round and
 * §1.4's history decision over the record it just made durable. Its JSON
 * file input keeps the fences explicit instead of inventing a positional
 * prose grammar; every review target — repository, pull request, base, head
 * and criterion manifest — comes from the platform-attested ReviewSubject,
 * never from the caller.
 */
import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MAX_RUN_BOUND_MS } from "../dispatch/executor.ts";
import type { DispatchOutcome } from "../dispatch/index.ts";
import type { PiInvocation } from "../dispatch/pi-run.ts";
import { withoutRepoLocatingGitEnv } from "../dispatch/provision.ts";
import type { ResolvedModes } from "../modes.ts";
import { platformScalarValue, runPlatformRead } from "../platform/read.ts";
import { quoted } from "../quote.ts";
import {
	coordinateHistoryRecovery,
	makeRecoveryProfileDispatcher,
	type RecoveryProfileDispatcher,
} from "../recovery/coordinator.ts";
import type { RecoveryFreshness, RecoveryResult } from "../recovery/types.ts";
import type { BriefTiming, ReviewFences } from "../review/briefs.ts";
import {
	type AttestedCommentPopulation,
	fetchAttestedReviewComments,
	recordsFromAttestedComments,
} from "../review/comments.ts";
import {
	admitDiagnosis,
	type Consequence,
	composeDiagnosisBrief,
	type DiagnosisInput,
	deriveRepairBasis,
	diagnosisConsequence,
	historyAvailability,
	legacyUnderivable,
	repairHistory,
	type StateSummary,
	triggerFires,
} from "../review/history.ts";
import {
	HISTORY_HANDOFF_CAUSE,
	type HistoryLimb,
	type HistoryReentry,
	historyHandoffBody,
	historyReentryBody,
	readHistoryHandoffs,
	recordsAfterReset,
	type StandingHandoff,
} from "../review/history-handoff.ts";
import { makeDispatcher, type RoundResult, reviewRound } from "../review/orchestrate.ts";
import type { ReviewPublicationOutcome, ReviewPublicationReceipt } from "../review/publication.ts";
import { publishAndRefetchReviewRecord, publishResolverRepairHandoff } from "../review/publication.ts";
import type { ReviewRecord } from "../review/record.ts";
import {
	CriterionOwnerUnavailableError,
	fetchReviewSubject,
	type ReviewSubject,
	refetchReviewSubject,
	subjectCriterionManifest,
} from "../review/subject.ts";
import type { SessionSurface } from "../session-surface.ts";
import { readRepositoryInput } from "./review-round-input.ts";

const REFUSE_SPEC =
	"review-round refused: the argument must name one readable, in-repository JSON spec of the closed shape; see README.md, Driving a review round";
const HANDOFF_SUBJECT = "review-round handed off: the platform-attested review subject could not be established";
const HANDOFF_CRITERION_OWNER = "review-round handed off: the handed-over criterion owner was unavailable";
const HANDOFF_HEAD = "review-round handed off: the attested head is not the head this clone resolves";
const HANDOFF_DRIFT = "review-round handed off: the review subject changed while the round ran";
const HANDOFF_HISTORY = "review-round handed off: installed review history could not be read";
const HANDOFF_DIAGNOSIS = "review-round handed off: the required history diagnosis was unavailable or required handoff";
const HANDOFF_REENTRY = "review-round handed off: the diagnosis invalidated a gate that must be re-entered";
const HANDOFF_PUBLISH = "review-round handed off: the durable review record was not confirmed published";
const HANDOFF_ROUND = "review-round handed off: the composed round could not produce a terminal result";
const HANDOFF_STANDING = "review-round handed off: a standing review-history handoff awaits its re-entry";
const HANDOFF_POPULATION = "review-round handed off: the handoff record population was unreadable or ambiguous";
const HANDOFF_RECORD = "review-round handed off: the review-history handoff record could not be written";
const HANDOFF_RESET = "review-round handed off: a review-history re-entry landed while the round ran";
const REVIEW_ROUND_RUN_BOUND_MS = 30 * 60 * 1_000;

function alignedTiming(timeoutMs: number): BriefTiming {
	return { firstReturnSeconds: timeoutMs / 3_000, finalReturnSeconds: timeoutMs / 2_000 };
}

export type ReviewRoundSpec = {
	pr: number;
	fences: ReviewFences;
	changeDescription: string;
	delegateArgv?: string[];
	/** Explicit operator-owned Pi mode. Consumer dispatch fixes reviewer/Judge/history roles. */
	pi?: { piExecutable: string; provider: string; model: string };
	timeoutMs?: number;
	timing?: BriefTiming;
};

export type CommandDisposition =
	| { disposition: "refused"; cause: string }
	| { disposition: "hand-off"; cause: string; reentry: Consequence["reentry"]; diagnosis?: DiagnosisInput }
	| { disposition: "posted"; review: RoundResult["review"]; diagnosis?: DiagnosisInput }
	| { disposition: "recovery"; result: RecoveryResult; diagnosis: DiagnosisInput };

type TerminalSeed =
	| { disposition: "refused"; cause: string }
	| { disposition: "hand-off"; cause: string; reentry: Consequence["reentry"] }
	| { disposition: "posted"; review: RoundResult["review"] }
	| { disposition: "recovery"; result: RecoveryResult };

type TransactionState = { phase: "pre-admission" } | { phase: "diagnosis-admitted"; diagnosis: DiagnosisInput };

/** The sole constructor of a public command outcome. */
function finish(state: TransactionState, seed: TerminalSeed): CommandDisposition {
	if (seed.disposition === "recovery") {
		if (state.phase !== "diagnosis-admitted")
			return { disposition: "hand-off", cause: HANDOFF_DIAGNOSIS, reentry: "none" };
		return { ...seed, diagnosis: state.diagnosis };
	}
	if (state.phase === "pre-admission" || seed.disposition === "refused") return seed;
	return { ...seed, diagnosis: state.diagnosis };
}

/** Fixed operator-visible projection; evidence and artifact text never ride it. */
export function terminalText(outcome: CommandDisposition): string {
	if (outcome.disposition === "refused") return ["review-round: refused — ", quoted(outcome.cause)].join("");
	const diagnosis = outcome.diagnosis
		? ["; diagnosis ", outcome.diagnosis.value, "/", outcome.diagnosis.invalidation].join("")
		: "";
	switch (outcome.disposition) {
		case "hand-off":
			return ["review-round: hand-off (", outcome.reentry, ") — ", quoted(outcome.cause), diagnosis].join("");
		case "posted":
			return ["review-round: posted ", outcome.review.state, diagnosis].join("");
		case "recovery": {
			const reference = outcome.result.recordRef;
			const identifiers =
				reference === null
					? ""
					: [
							"; hashes ",
							quoted(reference.repoHash),
							"/",
							quoted(reference.keyHash),
							"; claim ",
							quoted(reference.claimId),
						].join("");
			return [
				"review-round: recovery ",
				outcome.result.terminal,
				"/",
				outcome.result.nextGate,
				"; route ",
				outcome.result.route,
				identifiers,
				diagnosis,
			].join("");
		}
	}
}

export type ReviewRoundSeams = {
	fetchSubject: (repoRoot: string, pr: number) => Promise<ReviewSubject | undefined>;
	refetchSubject: (repoRoot: string, subject: ReviewSubject) => Promise<ReviewSubject | undefined>;
	readComments: (repoRoot: string, subject: ReviewSubject) => Promise<AttestedCommentPopulation>;
	recordsFromComments: (population: AttestedCommentPopulation, writerId: string) => ReviewRecord[] | undefined;
	makeDispatch: (
		spec: ReviewRoundSpec,
	) => (brief: string, expectedHead: string, role?: PiInvocation["role"]) => Promise<DispatchOutcome>;
	runRound: typeof reviewRound;
	publishRecord: (body: string, subject: ReviewSubject) => Promise<ReviewPublicationOutcome>;
	publishAwaitingAuthor: (subject: ReviewSubject) => Promise<ReviewPublicationOutcome>;
	resolveHead: (repoRoot: string, headRef: string) => string | undefined;
	coordinateRecovery?: typeof coordinateHistoryRecovery;
	recoveryDispatch?: RecoveryProfileDispatcher;
	/**
	 * SPEC §1.4's review-history handoff record and re-entry (#402/#404).
	 * Production always supplies it; an embedding without it keeps the
	 * earlier behavior of writing no record and honoring no re-entry.
	 */
	historyHandoff?: HistoryHandoffSeams;
};

export type HistoryHandoffSeams = {
	engine: () => Promise<typeof import("../../../../.github/workflows/gitjig-lifecycle.mjs")>;
	/** Live same-repository permission of one comment author, or undefined when unreadable. */
	permissionOf: (subject: ReviewSubject, login: string) => Promise<string | undefined>;
	/** Whether this round's own account passes `authorizedResolver`; its records are admitted only then. */
	writerAuthorized: (subject: ReviewSubject) => Promise<boolean>;
	now: () => string;
};

/** One `gh --jq` scalar read through the shared terminator owner. */
async function platformScalar(argv: string[], repoRoot: string): Promise<string | undefined> {
	return platformScalarValue(await runPlatformRead(argv, repoRoot));
}

/** Production seams: the handed-over engine and live platform permission reads. */
export function platformHistoryHandoffSeams(repoRoot: string): HistoryHandoffSeams {
	const engine = () => import("../../../../.github/workflows/gitjig-lifecycle.mjs");
	const permissionOf = (subject: ReviewSubject, login: string): Promise<string | undefined> =>
		platformScalar(
			[
				"api",
				"--hostname",
				subject.context.repository.host,
				`repos/${subject.context.repository.nameWithOwner}/collaborators/${encodeURIComponent(login)}/permission`,
				"--jq",
				".role_name",
			],
			repoRoot,
		);
	return {
		engine,
		permissionOf,
		writerAuthorized: async (subject) => {
			const login = await platformScalar(
				["api", "--hostname", subject.context.repository.host, "user", "--jq", ".login"],
				repoRoot,
			);
			if (login === undefined || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return false;
			const role = await permissionOf(subject, login);
			return (await engine()).authorizedResolver({
				actorId: subject.writerId,
				actorType: "User",
				repositoryId: subject.context.repository.id,
				addressedRepositoryId: subject.context.repository.id,
				permission: role?.toUpperCase(),
			});
		},
		now: () => new Date().toISOString(),
	};
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).every((key) => keys.includes(key))
	);
}

function stringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function fences(value: unknown): value is ReviewFences {
	if (!exactObject(value, ["outOfScope", "forbiddenRemedies", "deferralHomes", "priorFindings"])) return false;
	if (
		Object.keys(value).length !== 4 ||
		!stringList(value.outOfScope) ||
		!stringList(value.forbiddenRemedies) ||
		!stringList(value.deferralHomes)
	)
		return false;
	return (
		Array.isArray(value.priorFindings) &&
		value.priorFindings.every(
			(entry) =>
				exactObject(entry, ["label", "text"]) &&
				Object.keys(entry).length === 2 &&
				typeof entry.label === "string" &&
				typeof entry.text === "string",
		)
	);
}

function timing(value: unknown): value is BriefTiming {
	return (
		exactObject(value, ["firstReturnSeconds", "finalReturnSeconds"]) &&
		Object.keys(value).length === 2 &&
		typeof value.firstReturnSeconds === "number" &&
		Number.isFinite(value.firstReturnSeconds) &&
		value.firstReturnSeconds > 0 &&
		typeof value.finalReturnSeconds === "number" &&
		Number.isFinite(value.finalReturnSeconds) &&
		value.finalReturnSeconds > value.firstReturnSeconds
	);
}

export function parseReviewRoundSpec(value: unknown): ReviewRoundSpec | undefined {
	const keys = ["pr", "fences", "changeDescription", "delegateArgv", "pi", "timeoutMs", "timing"];
	if (!exactObject(value, keys)) return undefined;
	if (!Number.isSafeInteger(value.pr) || (value.pr as number) <= 0) return undefined;
	if (!fences(value.fences) || typeof value.changeDescription !== "string" || value.changeDescription.length === 0)
		return undefined;
	if (value.pi === undefined) {
		if (
			!stringList(value.delegateArgv) ||
			value.delegateArgv.length === 0 ||
			value.delegateArgv.some((entry) => entry.length === 0)
		)
			return undefined;
	} else {
		if (
			value.delegateArgv !== undefined ||
			// No key outside the three, and each of the three typed below: exactly three.
			!exactObject(value.pi, ["piExecutable", "provider", "model"]) ||
			typeof value.pi.piExecutable !== "string" ||
			value.pi.piExecutable.length === 0 ||
			typeof value.pi.provider !== "string" ||
			typeof value.pi.model !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.pi.provider) ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.pi.model)
		)
			return undefined;
	}
	if (
		value.timeoutMs !== undefined &&
		(typeof value.timeoutMs !== "number" ||
			!Number.isFinite(value.timeoutMs) ||
			value.timeoutMs <= 0 ||
			value.timeoutMs > MAX_RUN_BOUND_MS)
	)
		return undefined;
	if (value.timing !== undefined && !timing(value.timing)) return undefined;
	const timeoutMs = (value.timeoutMs as number | undefined) ?? REVIEW_ROUND_RUN_BOUND_MS;
	const briefTiming = (value.timing as BriefTiming | undefined) ?? alignedTiming(timeoutMs);
	if (briefTiming.finalReturnSeconds * 1_000 >= timeoutMs) return undefined;
	return { ...(value as ReviewRoundSpec), timeoutMs, timing: briefTiming };
}

function reentryConsequence(consequence: Consequence): TerminalSeed | undefined {
	switch (consequence.reentry) {
		case "none":
			return consequence.handoff ? { disposition: "hand-off", cause: HANDOFF_DIAGNOSIS, reentry: "none" } : undefined;
		case "plan":
			return { disposition: "hand-off", cause: HANDOFF_REENTRY, reentry: "plan" };
		case "authorization":
			return { disposition: "hand-off", cause: HANDOFF_REENTRY, reentry: "authorization" };
	}
}

/**
 * Read the durable history back across the publication boundary: the round's
 * own record is assembled from what the platform returns, never from the
 * body this process just composed (§1.4's record the acting agent does not
 * author, issue #212's acceptance criterion 2).
 */
type DurableState = { history: StateSummary[] };

async function durableState(
	repoRoot: string,
	subject: ReviewSubject,
	seams: ReviewRoundSeams,
	requiredReceipt?: ReviewPublicationReceipt,
	resetAfter?: number,
): Promise<DurableState | undefined> {
	const population = await seams.readComments(repoRoot, subject);
	if (
		requiredReceipt !== undefined &&
		(!population.ok ||
			!population.comments.some(
				(comment) =>
					comment.id === requiredReceipt.commentId &&
					comment.authorId === requiredReceipt.authorId &&
					comment.body === requiredReceipt.body,
			))
	)
		return undefined;
	// An honored §1.4 re-entry starts this gate's run after its terminal; the
	// complete history on the platform is unchanged (#402).
	const records = recordsAfterReset(
		population,
		seams.recordsFromComments(population, subject.writerId),
		subject.writerId,
		resetAfter,
	);
	// The substrate is the platform's own comment record on the subject this
	// command already attested, so for this call site it is installed by
	// construction and §1.4's absent limb has no case here.
	const availability = historyAvailability(true, records);
	if (!availability.available) return undefined;
	return { history: repairHistory(availability.records) };
}

export async function driveReviewRound(
	spec: ReviewRoundSpec,
	repoRoot: string,
	seams: ReviewRoundSeams,
	modes: ResolvedModes = {
		mergeMode: "off",
		mergeSource: "default",
		decisionMode: "handoff",
		decisionSource: "default",
		refusals: [],
	},
): Promise<CommandDisposition> {
	let state: TransactionState = { phase: "pre-admission" };
	try {
		const subject = await seams.fetchSubject(repoRoot, spec.pr);
		if (subject === undefined)
			return finish(state, { disposition: "hand-off", cause: HANDOFF_SUBJECT, reentry: "none" });
		const head = subject.context.pullRequest.head.oid;
		if (seams.resolveHead(repoRoot, head) !== head)
			return finish(state, { disposition: "hand-off", cause: HANDOFF_HEAD, reentry: "none" });
		const dispatch = seams.makeDispatch(spec);
		const briefTiming = spec.timing ?? alignedTiming(spec.timeoutMs ?? REVIEW_ROUND_RUN_BOUND_MS);
		let diagnosedHistory: string | undefined;

		// SPEC §1.4's review-history handoff (#402): read the standing record and
		// the honored re-entry before any history read of this round.
		const handoffSeams = seams.historyHandoff;
		let handoffEngine: Awaited<ReturnType<HistoryHandoffSeams["engine"]>> | undefined;
		let standing: StandingHandoff | undefined;
		let resetAfter: number | undefined;
		if (handoffSeams !== undefined) {
			try {
				handoffEngine = await handoffSeams.engine();
			} catch {
				return finish(state, { disposition: "hand-off", cause: HANDOFF_POPULATION, reentry: "none" });
			}
			const view = await readHistoryHandoffs(
				handoffEngine,
				await seams.readComments(repoRoot, subject),
				subject.context.repository.id,
				subject.writerId,
				async (comment) =>
					comment.authorLogin === undefined ? undefined : handoffSeams.permissionOf(subject, comment.authorLogin),
			);
			if (!view.ok) return finish(state, { disposition: "hand-off", cause: HANDOFF_POPULATION, reentry: "none" });
			// A standing limb-(a)/(b) record, or another owner's, waits for its
			// re-entry: no new diagnosis runs. Only a limb-(c) record lets the gate
			// try again for a determinate outcome.
			if (view.standing !== undefined && view.standing.limb !== "c")
				return finish(state, { disposition: "hand-off", cause: HANDOFF_STANDING, reentry: "none" });
			standing = view.standing;
			resetAfter = view.resetAfter;
		}
		// Set by each diagnosis: the limb its stop falls in, and whether its
		// outcome was determinate (a limb-(a) refusal or a valid diagnosis).
		let pending: { limb: HistoryLimb; reentry: HistoryReentry } | undefined;
		let determinate = false;
		const stopAs = (limb: HistoryLimb, reentry: HistoryReentry, seed: TerminalSeed): TerminalSeed => {
			pending = { limb, reentry };
			if (limb === "a") determinate = true;
			return seed;
		};
		/** Write this gate's terminal and record after a diagnosis, before the round acts on it. */
		const settleHandoff = async (): Promise<TerminalSeed | undefined> => {
			let write = pending;
			pending = undefined;
			const wasDeterminate = determinate;
			determinate = false;
			if (handoffSeams === undefined || handoffEngine === undefined) return undefined;
			// Re-read the population right before writing, so a record that appeared
			// while this round ran is the standing one and no second record is
			// written. RESIDUAL, stated: the read and the write are not one
			// transaction; a record posted between them is not observable here.
			let latest: AttestedCommentPopulation = { ok: false, cause: "unread" };
			const readHandoffs = async () => {
				latest = await seams.readComments(repoRoot, subject);
				return readHistoryHandoffs(
					handoffEngine,
					latest,
					subject.context.repository.id,
					subject.writerId,
					async (comment) =>
						comment.authorLogin === undefined ? undefined : handoffSeams.permissionOf(subject, comment.authorLogin),
				);
			};
			const fresh = await readHandoffs();
			if (!fresh.ok) return { disposition: "hand-off", cause: HANDOFF_POPULATION, reentry: "none" };
			// A limb-(a)/(b) or foreign record that appeared while this round ran
			// now stands: the round writes nothing and hands off citing it.
			if (fresh.standing !== undefined && fresh.standing.limb !== "c")
				return { disposition: "hand-off", cause: HANDOFF_STANDING, reentry: "none" };
			standing = fresh.standing;
			// Immediately before each write: a record or terminal is admitted only
			// from an authorized carrier (§1.4's residual), none binds heads that
			// moved while this round ran, and the standing record is still exactly
			// the one this write expects (none, before a new record), so no record or
			// terminal appearing between this round's writes is followed by a second.
			// Each write re-reads all three facts.
			const settleBlocked = async (expected: number | undefined): Promise<TerminalSeed | undefined> => {
				if (!(await handoffSeams.writerAuthorized(subject)))
					return { disposition: "hand-off", cause: HANDOFF_RECORD, reentry: "none" };
				if ((await seams.refetchSubject(repoRoot, subject)) === undefined)
					return { disposition: "hand-off", cause: HANDOFF_DRIFT, reentry: "none" };
				const reread = await readHandoffs();
				if (!reread.ok) return { disposition: "hand-off", cause: HANDOFF_POPULATION, reentry: "none" };
				if (reread.standing?.commentId !== expected)
					return { disposition: "hand-off", cause: HANDOFF_STANDING, reentry: "none" };
				// A re-entry honored while this round ran starts a new trailing run, so
				// this round's history and diagnosis no longer describe the gate.
				if (reread.resetAfter !== resetAfter) return { disposition: "hand-off", cause: HANDOFF_RESET, reentry: "none" };
				// A limb-(a) record is written only while the record-local check still
				// refuses on the fresh history; otherwise the stop is no longer
				// persistent and is recorded as limb (c), never as an un-re-enterable (a).
				if (write?.limb === "a" && !legacyRefusesOn(seams, latest, subject.writerId, reread.resetAfter))
					write = { limb: "c", reentry: "none" };
				return undefined;
			};
			if (standing !== undefined && standing.limb === "c" && wasDeterminate) {
				const terminalBlocked = await settleBlocked(standing.commentId);
				if (terminalBlocked !== undefined) return terminalBlocked;
				const body = historyReentryBody(handoffEngine, standing, handoffSeams.now());
				if (body === undefined || !(await seams.publishRecord(body, subject)).ok)
					return { disposition: "hand-off", cause: HANDOFF_RECORD, reentry: "none" };
				standing = undefined;
			}
			if (write === undefined) return undefined;
			// While any record stands, a later stop writes no second one and hands
			// off citing the standing record (§1.4).
			if (standing !== undefined) return { disposition: "hand-off", cause: HANDOFF_STANDING, reentry: "none" };
			const recordBlocked = await settleBlocked(undefined);
			if (recordBlocked !== undefined) return recordBlocked;
			const pull = subject.context.pullRequest;
			const body = historyHandoffBody(
				handoffEngine,
				write.limb,
				write.reentry,
				pull.head.oid,
				pull.base.oid,
				handoffSeams.now(),
			);
			if (body === undefined || !(await seams.publishRecord(body, subject)).ok)
				return { disposition: "hand-off", cause: HANDOFF_RECORD, reentry: "none" };
			return undefined;
		};

		const currentSubject = async (): Promise<boolean> => (await seams.refetchSubject(repoRoot, subject)) !== undefined;
		const diagnose = async (
			history: StateSummary[],
			requiredReceipt?: ReviewPublicationReceipt,
		): Promise<TerminalSeed | undefined> => {
			if (!(await currentSubject())) return { disposition: "hand-off", cause: HANDOFF_DRIFT, reentry: "none" };
			const basis = await deriveRepairBasis(repoRoot, history);
			if (basis === undefined)
				return stopAs(legacyUnderivable(history) ? "a" : "c", "none", {
					disposition: "hand-off",
					cause: HANDOFF_DIAGNOSIS,
					reentry: "none",
				});
			const admitted = admitDiagnosis(
				await dispatch(
					composeDiagnosisBrief(basis, {
						changeDescription: spec.changeDescription,
						withheldHead: head,
						timing: briefTiming,
						transport: spec.pi === undefined ? "generic" : "pi",
					}),
					head,
					"history",
				),
			);
			if (!admitted.available)
				return stopAs("c", "none", { disposition: "hand-off", cause: HANDOFF_DIAGNOSIS, reentry: "none" });
			const diagnosis = admitted.diagnosis;
			if (!(await currentSubject())) return { disposition: "hand-off", cause: HANDOFF_DRIFT, reentry: "none" };
			const confirmed = await durableState(repoRoot, subject, seams, requiredReceipt, resetAfter);
			if (confirmed === undefined || JSON.stringify(confirmed.history) !== JSON.stringify(history))
				return stopAs("c", "none", { disposition: "hand-off", cause: HANDOFF_HISTORY, reentry: "none" });
			if (!(await currentSubject())) return { disposition: "hand-off", cause: HANDOFF_DRIFT, reentry: "none" };
			state = { phase: "diagnosis-admitted", diagnosis };
			diagnosedHistory = JSON.stringify(history);
			determinate = true;
			const consequence = diagnosisConsequence(diagnosis.value, diagnosis.invalidation);
			if (diagnosis.value === "NONE" || diagnosis.invalidation !== "nothing" || modes.decisionMode !== "autonomous") {
				const seed = reentryConsequence(consequence);
				return seed?.disposition === "hand-off" ? stopAs("b", diagnosis.invalidation, seed) : seed;
			}
			if (seams.coordinateRecovery === undefined || seams.recoveryDispatch === undefined)
				return stopAs("b", diagnosis.invalidation, {
					disposition: "hand-off",
					cause: HANDOFF_DIAGNOSIS,
					reentry: "none",
				});
			const refresh = async (): Promise<RecoveryFreshness | undefined> => {
				const refreshedSubject = await seams.refetchSubject(repoRoot, subject);
				if (refreshedSubject === undefined) return undefined;
				const refreshedState = await durableState(repoRoot, refreshedSubject, seams, requiredReceipt, resetAfter);
				if (refreshedState === undefined) return undefined;
				const refreshedBasis = await deriveRepairBasis(repoRoot, refreshedState.history);
				if (refreshedBasis === undefined) return undefined;
				return { subject: refreshedSubject, history: refreshedState.history, basis: refreshedBasis };
			};
			const recovery = await seams.coordinateRecovery({
				repoRoot,
				modes,
				subject,
				history,
				basis,
				diagnosis,
				refreshPreclaim: refresh,
				refreshPrecontinue: refresh,
				dispatchProfile: seams.recoveryDispatch,
			});
			if (recovery.nextGate === "ordinary-flow") return undefined;
			// The autonomous route's handoff terminal is a limb-(b) stop; its
			// reentry is the most recent valid ruling's invalidation (§1.4).
			if (recovery.terminal === "handoff") pending = { limb: "b", reentry: recovery.reentry };
			return { disposition: "recovery", result: recovery };
		};

		// A trigger already present at invocation gates the round; another state
		// cannot reset it before its durable ruling is consumed.
		const before = await durableState(repoRoot, subject, seams, undefined, resetAfter);
		if (before === undefined) {
			pending = { limb: "c", reentry: "none" };
			return finish(
				state,
				(await settleHandoff()) ?? { disposition: "hand-off", cause: HANDOFF_HISTORY, reentry: "none" },
			);
		}
		if (triggerFires(before.history)) {
			const stop = await diagnose(before.history);
			const settled = await settleHandoff();
			if (settled !== undefined) return finish(state, settled);
			if (stop !== undefined) return finish(state, stop);
		}
		if (!(await currentSubject()))
			return finish(state, { disposition: "hand-off", cause: HANDOFF_DRIFT, reentry: "none" });

		const round = await seams.runRound({
			repoRoot,
			baseRef: subject.context.pullRequest.base.oid,
			headRef: head,
			manifest: subjectCriterionManifest(subject),
			fences: spec.fences,
			changeDescription: spec.changeDescription,
			timing: briefTiming,
			transport: spec.pi === undefined ? "generic" : "pi",
			dispatch,
		});
		if (!(await currentSubject()))
			return finish(state, { disposition: "hand-off", cause: HANDOFF_DRIFT, reentry: "none" });
		const publication = await seams.publishRecord(round.recordBody, subject);
		if (!publication.ok) return finish(state, { disposition: "hand-off", cause: HANDOFF_PUBLISH, reentry: "none" });
		if (
			round.review.state === "resolved" &&
			round.review.resolution.outcome === "repair" &&
			!(await seams.publishAwaitingAuthor(subject)).ok
		)
			return finish(state, { disposition: "hand-off", cause: HANDOFF_PUBLISH, reentry: "none" });
		if (!(await currentSubject()))
			return finish(state, { disposition: "hand-off", cause: HANDOFF_DRIFT, reentry: "none" });
		const after = await durableState(repoRoot, subject, seams, publication.receipt, resetAfter);
		if (after === undefined) {
			pending = { limb: "c", reentry: "none" };
			return finish(
				state,
				(await settleHandoff()) ?? { disposition: "hand-off", cause: HANDOFF_HISTORY, reentry: "none" },
			);
		}
		if (!(await currentSubject()))
			return finish(state, { disposition: "hand-off", cause: HANDOFF_DRIFT, reentry: "none" });
		if (!triggerFires(after.history) || JSON.stringify(after.history) === diagnosedHistory)
			return finish(state, { disposition: "posted", review: round.review });
		const stop = await diagnose(after.history, publication.receipt);
		const settled = await settleHandoff();
		if (settled !== undefined) return finish(state, settled);
		return finish(state, stop ?? { disposition: "posted", review: round.review });
	} catch (error) {
		return finish(state, {
			disposition: "hand-off",
			cause: error instanceof CriterionOwnerUnavailableError ? HANDOFF_CRITERION_OWNER : HANDOFF_ROUND,
			reentry: "none",
		});
	}
}

export type ReentryDisposition =
	| { disposition: "re-entered"; limb: "a" | "b" }
	| { disposition: "refused"; cause: string };

const REENTRY_REFUSED = {
	subject: "review-round re-entry refused: the platform-attested review subject could not be established",
	unavailable: "review-round re-entry refused: the review-history handoff runtime is unavailable",
	population: "review-round re-entry refused: the handoff record population was unreadable or ambiguous",
	authority: "review-round re-entry refused: this account does not pass authorizedResolver for the repository",
	limb: "review-round re-entry refused: the standing record is not a limb-(a) or limb-(b) review-history handoff",
	legacy: "review-round re-entry refused: the record-local legacy check does not refuse on this PR's history",
	write: "review-round re-entry refused: the handoff record or terminal was not confirmed published",
	stale: "review-round re-entry refused: the PR subject changed or could not be re-attested before writing",
	failed: "review-round re-entry refused: a platform read or write failed before re-entry completed",
	number: "review-round re-entry refused: pr is not a positive safe integer",
	changed: "review-round re-entry refused: the handoff population changed before the write",
} as const;

/** Whether the record-local limb-(a) check refuses on this population's run after the honored reset. */
function legacyRefusesOn(
	seams: ReviewRoundSeams,
	population: AttestedCommentPopulation,
	writerId: string,
	resetAfter: number | undefined,
): boolean {
	const records = recordsAfterReset(population, seams.recordsFromComments(population, writerId), writerId, resetAfter);
	if (records === undefined) return false;
	const availability = historyAvailability(true, records);
	return availability.available && legacyUnderivable(repairHistory(availability.records));
}

/**
 * The maintainer's re-entry of a limb-(a) or limb-(b) review-history handoff
 * (SPEC §1.4, #402/#404): the engine's `handoff-reentry` terminal for the
 * standing record, at that record's heads, from an `authorizedResolver`
 * account. With no standing record, the limb-(a) legacy-prose route first
 * writes the limb-(a) record at the current heads, only while the
 * record-local check refuses on this PR's own history. It never runs a
 * diagnosis, claims or resets an allowance, or grants a verdict.
 */
export async function reenterReviewHistory(
	pr: number,
	repoRoot: string,
	seams: ReviewRoundSeams,
): Promise<ReentryDisposition> {
	// Every refusal fails closed to the existing hand-off (§1.4): a thrown read
	// or write is a refusal with a terminal, never an escaped exception.
	try {
		return await reenterAttested(pr, repoRoot, seams);
	} catch {
		return { disposition: "refused", cause: REENTRY_REFUSED.failed };
	}
}

async function reenterAttested(pr: number, repoRoot: string, seams: ReviewRoundSeams): Promise<ReentryDisposition> {
	// A grammar-valid decimal beyond 2^53 converts lossily to another number;
	// only an exact positive safe integer names the PR the operator typed.
	if (!Number.isSafeInteger(pr) || pr < 1) return { disposition: "refused", cause: REENTRY_REFUSED.number };
	const subject = await seams.fetchSubject(repoRoot, pr);
	if (subject === undefined) return { disposition: "refused", cause: REENTRY_REFUSED.subject };
	const handoffSeams = seams.historyHandoff;
	if (handoffSeams === undefined) return { disposition: "refused", cause: REENTRY_REFUSED.unavailable };
	let engine: Awaited<ReturnType<HistoryHandoffSeams["engine"]>>;
	try {
		engine = await handoffSeams.engine();
	} catch {
		return { disposition: "refused", cause: REENTRY_REFUSED.unavailable };
	}
	const population = await seams.readComments(repoRoot, subject);
	const view = await readHistoryHandoffs(
		engine,
		population,
		subject.context.repository.id,
		subject.writerId,
		async (comment) =>
			comment.authorLogin === undefined ? undefined : handoffSeams.permissionOf(subject, comment.authorLogin),
	);
	if (!view.ok) return { disposition: "refused", cause: REENTRY_REFUSED.population };
	// Immediately before each write, re-read this account's authority and
	// re-attest the exact PR subject, so neither the record nor the terminal is
	// written by a revoked account or binds heads that have since moved.
	// It also re-reads the handoff population: the standing record must still be
	// exactly the one this write expects (none, before the legacy-prose record),
	// so a concurrent record or terminal is never followed by a second one.
	// A limb-(a) write also recomputes the record-local check on that fresh
	// history, so no terminal is written that the next reader would refuse.
	// RESIDUAL, stated: the read and the write are not one transaction.
	const reentryBlocked = async (
		expected: number | undefined,
		limb: "a" | "b",
	): Promise<ReentryDisposition | undefined> => {
		if (!(await handoffSeams.writerAuthorized(subject)))
			return { disposition: "refused", cause: REENTRY_REFUSED.authority };
		if ((await seams.refetchSubject(repoRoot, subject)) === undefined)
			return { disposition: "refused", cause: REENTRY_REFUSED.stale };
		const rereadPopulation = await seams.readComments(repoRoot, subject);
		const reread = await readHistoryHandoffs(
			engine,
			rereadPopulation,
			subject.context.repository.id,
			subject.writerId,
			async (comment) =>
				comment.authorLogin === undefined ? undefined : handoffSeams.permissionOf(subject, comment.authorLogin),
		);
		if (!reread.ok) return { disposition: "refused", cause: REENTRY_REFUSED.population };
		if (reread.standing?.commentId !== expected) return { disposition: "refused", cause: REENTRY_REFUSED.changed };
		if (limb === "a" && !legacyRefusesOn(seams, rereadPopulation, subject.writerId, reread.resetAfter))
			return { disposition: "refused", cause: REENTRY_REFUSED.legacy };
		return undefined;
	};
	let target = view.standing;
	if (target === undefined) {
		// The limb-(a) legacy-prose route; no other limb is re-entered from prose.
		// Its record-local check runs on the fresh history inside reentryBlocked.
		const legacyBlocked = await reentryBlocked(undefined, "a");
		if (legacyBlocked !== undefined) return legacyBlocked;
		const pull = subject.context.pullRequest;
		const observedAt = handoffSeams.now();
		const body = historyHandoffBody(engine, "a", "none", pull.head.oid, pull.base.oid, observedAt);
		const published = body === undefined ? undefined : await seams.publishRecord(body, subject);
		if (published === undefined || !published.ok) return { disposition: "refused", cause: REENTRY_REFUSED.write };
		target = {
			commentId: published.receipt.commentId,
			limb: "a",
			record: {
				cause: HISTORY_HANDOFF_CAUSE.a,
				recipient: "maintainer",
				reentry: "none",
				observedAt,
				subjectHead: pull.head.oid,
				baseHead: pull.base.oid,
			},
		};
	} else if (target.limb !== "a" && target.limb !== "b") {
		return { disposition: "refused", cause: REENTRY_REFUSED.limb };
	}
	const terminalBlocked = await reentryBlocked(target.commentId, target.limb === "a" ? "a" : "b");
	if (terminalBlocked !== undefined) return terminalBlocked;
	const terminal = historyReentryBody(engine, target, handoffSeams.now());
	const written = terminal === undefined ? undefined : await seams.publishRecord(terminal, subject);
	if (written === undefined || !written.ok) return { disposition: "refused", cause: REENTRY_REFUSED.write };
	return { disposition: "re-entered", limb: target.limb === "a" ? "a" : "b" };
}

function resolveLocalHead(repoRoot: string, ref: string): string | undefined {
	try {
		const head = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], {
			cwd: repoRoot,
			encoding: "utf8",
			env: withoutRepoLocatingGitEnv(process.env),
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
			killSignal: "SIGKILL",
			maxBuffer: 1024,
		}).trim();
		return /^[0-9a-f]{40}$/.test(head) ? head : undefined;
	} catch {
		return undefined;
	}
}

function readRepositorySpec(repoRoot: string, name: string): ReviewRoundSpec | undefined {
	const input = readRepositoryInput(repoRoot, name);
	if (input === undefined) return undefined;
	try {
		return parseReviewRoundSpec(JSON.parse(input));
	} catch {
		return undefined;
	}
}

export function registerReviewRoundCommand(
	pi: ExtensionAPI,
	repoRoot: string,
	stateRoot: string,
	modes: ResolvedModes,
	injected?: Partial<ReviewRoundSeams>,
	surface?: SessionSurface,
): void;
/** Compatibility overload for tests and non-spine embeddings; production always supplies startup modes. */
export function registerReviewRoundCommand(
	pi: ExtensionAPI,
	repoRoot: string,
	stateRoot: string,
	injected?: Partial<ReviewRoundSeams>,
	surface?: SessionSurface,
): void;
export function registerReviewRoundCommand(
	pi: ExtensionAPI,
	repoRoot: string,
	stateRoot: string,
	fourth: ResolvedModes | Partial<ReviewRoundSeams> = {},
	fifth: Partial<ReviewRoundSeams> | SessionSurface = {},
	sixth?: SessionSurface,
): void {
	const hasModes = "decisionMode" in fourth && "mergeMode" in fourth;
	const modes: ResolvedModes = hasModes
		? (fourth as ResolvedModes)
		: { mergeMode: "off", mergeSource: "default", decisionMode: "handoff", decisionSource: "default", refusals: [] };
	const injected = (hasModes ? fifth : fourth) as Partial<ReviewRoundSeams>;
	const surface = (hasModes ? sixth : fifth) as SessionSurface | undefined;
	pi.registerCommand("review-round", {
		description:
			"Drive panel, Judge, Resolver, durable record, and §1.4 history from one closed JSON spec: " +
			"/review-round <spec-file>. Schema and example: README.md, Driving a review round. " +
			"/review-round reenter pr=<n> re-enters a standing §1.4 limb-(a)/(b) review-history handoff or a refusing limb-(a) legacy-prose history (SPEC §1.4). The delegate runs " +
			"in the caller's trust domain and inherits its environment, credentials included: remote reach through " +
			"inherited credentials is not confined.",
		handler: async (args: string, ctx) => {
			// The spec is read first because the Pi transport's seams are keyed
			// by it; `reenter pr=<n>` carries no spec and leaves it undefined,
			// which the re-entry path below never reads.
			const spec = readRepositorySpec(repoRoot, args.trim());
			const defaults: ReviewRoundSeams = {
				fetchSubject: fetchReviewSubject,
				refetchSubject: refetchReviewSubject,
				readComments: (root, current) => fetchAttestedReviewComments(root, current.context),
				recordsFromComments: recordsFromAttestedComments,
				makeDispatch: (input) =>
					makeDispatcher({
						callerRepoRoot: repoRoot,
						stateRoot,
						delegateArgv: input.delegateArgv ?? [],
						...(input.pi === undefined ? {} : { pi: { ...input.pi, role: "reviewer" as const } }),
						timeoutMs: input.timeoutMs,
						surface,
					}),
				runRound: reviewRound,
				publishRecord: (body, current) => publishAndRefetchReviewRecord(body, current, repoRoot, stateRoot),
				publishAwaitingAuthor: (current) => publishResolverRepairHandoff(current, repoRoot, stateRoot),
				resolveHead: resolveLocalHead,
				coordinateRecovery: coordinateHistoryRecovery,
				recoveryDispatch: makeRecoveryProfileDispatcher({
					repoRoot,
					stateRoot,
					surface,
					...(spec?.pi === undefined ? {} : { pi: spec.pi }),
				}),
				historyHandoff: platformHistoryHandoffSeams(repoRoot),
			};
			// `/review-round reenter pr=<n>`: the §1.4 maintainer re-entry (#404).
			const reentry = /^\s*reenter\s+pr=([1-9][0-9]{0,15})\s*$/.exec(args);
			if (reentry !== null) {
				const result = await reenterReviewHistory(Number(reentry[1]), repoRoot, { ...defaults, ...injected });
				pi.appendEntry("gitjig-review-round", result);
				pi.sendMessage(
					{
						customType: "gitjig-review-round-terminal",
						content: [
							{
								type: "text",
								text:
									result.disposition === "re-entered"
										? `review-round: re-entered (limb ${result.limb})`
										: `review-round: ${result.cause}`,
							},
						],
						display: true,
					},
					{ triggerTurn: true },
				);
				await ctx.waitForIdle();
				return;
			}
			const outcome: CommandDisposition =
				spec === undefined
					? { disposition: "refused", cause: REFUSE_SPEC }
					: await driveReviewRound(spec, repoRoot, { ...defaults, ...injected }, modes);
			pi.appendEntry("gitjig-review-round", outcome);
			pi.sendMessage(
				{
					customType: "gitjig-review-round-terminal",
					content: [{ type: "text", text: terminalText(outcome) }],
					display: true,
				},
				{ triggerTurn: true },
			);
			await ctx.waitForIdle();
		},
	});
}

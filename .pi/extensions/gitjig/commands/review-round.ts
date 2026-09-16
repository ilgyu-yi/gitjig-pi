/**
 * The /review-round production call site for one composed review round and
 * §1.4's history decision over the record it just made durable. Its JSON
 * file input keeps the fences explicit instead of inventing a positional
 * prose grammar; every review target — repository, pull request, base, head
 * and criterion manifest — comes from the platform-attested ReviewSubject,
 * never from the caller.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MAX_RUN_BOUND_MS } from "../dispatch/executor.ts";
import type { DispatchOutcome } from "../dispatch/index.ts";
import { quoted } from "../quote.ts";
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
	diagnosisConsequence,
	historyAvailability,
	repairHistory,
	type StateSummary,
	triggerFires,
} from "../review/history.ts";
import { makeDispatcher, type RoundResult, reviewRound } from "../review/orchestrate.ts";
import type { ReviewPublicationOutcome } from "../review/publication.ts";
import { commitPostStateDiagnosis, publishAndRefetchReviewRecord } from "../review/publication.ts";
import type { ReviewRecord } from "../review/record.ts";
import { resolveRepositoryHead } from "../review/repository.ts";
import {
	fetchReviewSubject,
	type ReviewSubject,
	refetchPlatformReviewContext,
	subjectCriterionManifest,
} from "../review/subject.ts";
import { readRepositoryInput } from "./review-round-input.ts";

const REFUSE_SPEC =
	"review-round refused: the argument must name one readable, in-repository JSON spec of the closed shape; see README.md, Driving a review round";
const HANDOFF_SUBJECT = "review-round handed off: the platform-attested review subject could not be established";
const HANDOFF_HEAD = "review-round handed off: the attested head is not the head this clone resolves";
const HANDOFF_DRIFT = "review-round handed off: the review subject changed while the round ran";
const HANDOFF_DIAGNOSIS_RECORD = "review-round handed off: the post-state diagnosis record was not made durable";
const HANDOFF_HISTORY = "review-round handed off: installed review history could not be read";
const HANDOFF_DIAGNOSIS = "review-round handed off: the required history diagnosis was unavailable or required parking";
const HANDOFF_REENTRY = "review-round handed off: the diagnosis invalidated a gate that must be re-entered";
const HANDOFF_PUBLISH = "review-round handed off: the durable review record was not confirmed published";
const HANDOFF_ROUND = "review-round handed off: the composed round could not produce a terminal result";
const REVIEW_ROUND_RUN_BOUND_MS = 30 * 60 * 1_000;

function alignedTiming(timeoutMs: number): BriefTiming {
	return { firstReturnSeconds: timeoutMs / 3_000, finalReturnSeconds: timeoutMs / 2_000 };
}

export type ReviewRoundSpec = {
	pr: number;
	fences: ReviewFences;
	changeDescription: string;
	delegateArgv: string[];
	timeoutMs?: number;
	timing?: BriefTiming;
};

export type CommandDisposition =
	| { disposition: "refused"; cause: string }
	| { disposition: "hand-off"; cause: string; reentry: Consequence["reentry"]; diagnosis?: DiagnosisInput }
	| { disposition: "posted"; review: RoundResult["review"]; diagnosis?: DiagnosisInput };

type TerminalSeed =
	| { disposition: "refused"; cause: string }
	| { disposition: "hand-off"; cause: string; reentry: Consequence["reentry"] }
	| { disposition: "posted"; review: RoundResult["review"] };

type TransactionState = { phase: "pre-admission" } | { phase: "diagnosis-admitted"; diagnosis: DiagnosisInput };

/** The sole constructor of a public command outcome. */
function finish(state: TransactionState, seed: TerminalSeed): CommandDisposition {
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
	}
}

export type ReviewRoundSeams = {
	fetchSubject: (repoRoot: string, pr: number) => Promise<ReviewSubject | undefined>;
	refetchSubject: (repoRoot: string, subject: ReviewSubject) => Promise<ReviewSubject | undefined>;
	readComments: (repoRoot: string, subject: ReviewSubject) => Promise<AttestedCommentPopulation>;
	recordsFromComments: (population: AttestedCommentPopulation, writerId: string) => ReviewRecord[] | undefined;
	makeDispatch: (spec: ReviewRoundSpec) => (brief: string, expectedHead: string) => Promise<DispatchOutcome>;
	runRound: typeof reviewRound;
	publishRecord: (body: string, subject: ReviewSubject) => Promise<ReviewPublicationOutcome>;
	commitDiagnosis: (
		subject: ReviewSubject,
		history: readonly StateSummary[],
		diagnosis: DiagnosisInput,
	) => Promise<ReviewPublicationOutcome>;
	resolveHead: (repoRoot: string, headRef: string) => string | undefined;
};

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
	const keys = ["pr", "fences", "changeDescription", "delegateArgv", "timeoutMs", "timing"];
	if (!exactObject(value, keys)) return undefined;
	if (!Number.isSafeInteger(value.pr) || (value.pr as number) <= 0) return undefined;
	if (!fences(value.fences) || typeof value.changeDescription !== "string" || value.changeDescription.length === 0)
		return undefined;
	if (
		!stringList(value.delegateArgv) ||
		value.delegateArgv.length === 0 ||
		value.delegateArgv.some((entry) => entry.length === 0)
	)
		return undefined;
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
			return consequence.park ? { disposition: "hand-off", cause: HANDOFF_DIAGNOSIS, reentry: "none" } : undefined;
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
async function durableHistory(
	repoRoot: string,
	subject: ReviewSubject,
	seams: ReviewRoundSeams,
): Promise<StateSummary[] | undefined> {
	const records = seams.recordsFromComments(await seams.readComments(repoRoot, subject), subject.writerId);
	// The substrate is the platform's own comment record on the subject this
	// command already attested, so for this call site it is installed by
	// construction and §1.4's absent limb has no case here. A clone that cannot
	// reach the platform never gets a subject and never arrives at this line.
	const availability = historyAvailability(true, records);
	return availability.available ? repairHistory(availability.records) : undefined;
}

export async function driveReviewRound(
	spec: ReviewRoundSpec,
	repoRoot: string,
	seams: ReviewRoundSeams,
): Promise<CommandDisposition> {
	let state: TransactionState = { phase: "pre-admission" };
	try {
		const subject = await seams.fetchSubject(repoRoot, spec.pr);
		if (subject === undefined)
			return finish(state, { disposition: "hand-off", cause: HANDOFF_SUBJECT, reentry: "none" });
		const head = subject.context.pullRequest.head.oid;
		if (seams.resolveHead(repoRoot, head) !== head)
			return finish(state, { disposition: "hand-off", cause: HANDOFF_HEAD, reentry: "none" });
		// Read the substrate BEFORE spending a round on it: an unreadable
		// history hands off (§1.4's present-but-cannot-measure limb) rather
		// than producing a review state no next round could ever read.
		if ((await durableHistory(repoRoot, subject, seams)) === undefined)
			return finish(state, { disposition: "hand-off", cause: HANDOFF_HISTORY, reentry: "none" });
		const dispatch = seams.makeDispatch(spec);
		const briefTiming = spec.timing ?? alignedTiming(spec.timeoutMs ?? REVIEW_ROUND_RUN_BOUND_MS);
		const round = await seams.runRound({
			repoRoot,
			baseRef: subject.context.pullRequest.base.oid,
			headRef: head,
			manifest: subjectCriterionManifest(subject),
			fences: spec.fences,
			changeDescription: spec.changeDescription,
			timing: briefTiming,
			dispatch,
		});
		if ((await seams.refetchSubject(repoRoot, subject)) === undefined)
			return finish(state, { disposition: "hand-off", cause: HANDOFF_DRIFT, reentry: "none" });
		if (!(await seams.publishRecord(round.recordBody, subject)).ok)
			return finish(state, { disposition: "hand-off", cause: HANDOFF_PUBLISH, reentry: "none" });
		const history = await durableHistory(repoRoot, subject, seams);
		if (history === undefined)
			return finish(state, { disposition: "hand-off", cause: HANDOFF_HISTORY, reentry: "none" });
		if (!triggerFires(history)) return finish(state, { disposition: "posted", review: round.review });
		const admitted = admitDiagnosis(
			await dispatch(
				composeDiagnosisBrief(history, {
					changeDescription: spec.changeDescription,
					withheldHead: head,
					timing: briefTiming,
				}),
				head,
			),
		);
		if (!admitted.available)
			return finish(state, { disposition: "hand-off", cause: HANDOFF_DIAGNOSIS, reentry: "none" });
		state = { phase: "diagnosis-admitted", diagnosis: admitted.diagnosis };
		// Durable before the consequence: the ruling that gates continuation is
		// made durable before anything acts on it (§1.9, §1.4).
		if (!(await seams.commitDiagnosis(subject, history, admitted.diagnosis)).ok)
			return finish(state, { disposition: "hand-off", cause: HANDOFF_DIAGNOSIS_RECORD, reentry: "none" });
		const stop = reentryConsequence(diagnosisConsequence(admitted.diagnosis.value, admitted.diagnosis.invalidation));
		return finish(state, stop ?? { disposition: "posted", review: round.review });
	} catch {
		return finish(state, { disposition: "hand-off", cause: HANDOFF_ROUND, reentry: "none" });
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
	injected: Partial<ReviewRoundSeams> = {},
): void {
	pi.registerCommand("review-round", {
		description:
			"Drive panel, Judge, Resolver, durable record, and §1.4 history from one closed JSON spec: " +
			"/review-round <spec-file>. Schema and example: README.md, Driving a review round. The delegate runs " +
			"in the caller's trust domain and inherits its environment, credentials included: remote reach through " +
			"inherited credentials is not confined.",
		handler: async (args: string, ctx) => {
			const spec = readRepositorySpec(repoRoot, args.trim());
			let outcome: CommandDisposition;
			if (spec === undefined) {
				outcome = { disposition: "refused", cause: REFUSE_SPEC };
			} else {
				const defaults: ReviewRoundSeams = {
					fetchSubject: fetchReviewSubject,
					refetchSubject: async (root, current) => {
						const context = await refetchPlatformReviewContext(root, current.context);
						return context === undefined ? undefined : current;
					},
					readComments: (root, current) => fetchAttestedReviewComments(root, current.context),
					recordsFromComments: recordsFromAttestedComments,
					makeDispatch: (input) =>
						makeDispatcher({
							callerRepoRoot: repoRoot,
							stateRoot,
							delegateArgv: input.delegateArgv,
							timeoutMs: input.timeoutMs,
						}),
					runRound: reviewRound,
					publishRecord: (body, current) => publishAndRefetchReviewRecord(body, current, repoRoot, stateRoot),
					commitDiagnosis: (current, history, diagnosis) =>
						commitPostStateDiagnosis(current, history, diagnosis, repoRoot, stateRoot),
					resolveHead: resolveRepositoryHead,
				};
				outcome = await driveReviewRound(spec, repoRoot, { ...defaults, ...injected });
			}
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

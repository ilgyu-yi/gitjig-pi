/**
 * The /review-round production call site for one composed review round and
 * §1.4's preceding history decision. Its JSON file input keeps the manifest
 * and fences explicit instead of inventing a positional prose grammar.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MAX_RUN_BOUND_MS } from "../dispatch/executor.ts";
import type { DispatchOutcome } from "../dispatch/index.ts";
import { withoutRepoLocatingGitEnv } from "../dispatch/provision.ts";
import { type PublishResult, performPublish } from "../publish/index.ts";
import type { BriefTiming, ReviewFences } from "../review/briefs.ts";
import { fetchReviewComments, recordsFromComments } from "../review/comments.ts";
import {
	admitDiagnosis,
	type Consequence,
	composeDiagnosisBrief,
	type DiagnosisInput,
	diagnosisConsequence,
	historyAvailability,
	repairHistory,
	triggerFires,
} from "../review/history.ts";
import { makeDispatcher, type RoundResult, reviewRound } from "../review/orchestrate.ts";
import type { Manifest } from "../review/resolve.ts";

const REFUSE_SPEC =
	"review-round refused: the argument must name one readable, in-repository JSON spec of the closed shape; see README.md, Driving a review round";
const HANDOFF_HEAD = "review-round handed off: the requested review head could not be resolved";
const HANDOFF_HISTORY = "review-round handed off: installed review history could not be read";
const HANDOFF_DIAGNOSIS = "review-round handed off: the required history diagnosis was unavailable or required parking";
const HANDOFF_REENTRY = "review-round handed off: the diagnosis invalidated a gate that must be re-entered";
const HANDOFF_PUBLISH = "review-round handed off: the durable review record was not confirmed published";
const HANDOFF_ROUND = "review-round handed off: the composed round could not produce a terminal result";

export type ReviewRoundSpec = {
	pr: number;
	baseRef: string;
	headRef: string;
	manifest: Manifest;
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

export type ReviewRoundSeams = {
	readComments: typeof fetchReviewComments;
	recordsFromComments: typeof recordsFromComments;
	makeDispatch: (spec: ReviewRoundSpec) => (brief: string, expectedHead: string) => Promise<DispatchOutcome>;
	runRound: typeof reviewRound;
	publish: (body: string, pr: number) => Promise<PublishResult>;
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

function manifest(value: unknown): value is Manifest {
	if (!exactObject(value, ["state", "criteria"])) return false;
	if (value.state === "absent") return Object.keys(value).length === 1;
	return value.state === "present" && Object.keys(value).length === 2 && stringList(value.criteria);
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
	const keys = [
		"pr",
		"baseRef",
		"headRef",
		"manifest",
		"fences",
		"changeDescription",
		"delegateArgv",
		"timeoutMs",
		"timing",
	];
	if (!exactObject(value, keys)) return undefined;
	if (!Number.isSafeInteger(value.pr) || (value.pr as number) <= 0) return undefined;
	if (
		typeof value.baseRef !== "string" ||
		value.baseRef.length === 0 ||
		typeof value.headRef !== "string" ||
		value.headRef.length === 0
	)
		return undefined;
	if (
		!manifest(value.manifest) ||
		!fences(value.fences) ||
		typeof value.changeDescription !== "string" ||
		value.changeDescription.length === 0
	)
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
	return value as ReviewRoundSpec;
}

function reentryConsequence(consequence: Consequence, diagnosis: DiagnosisInput): CommandDisposition | undefined {
	switch (consequence.reentry) {
		case "none":
			return consequence.park
				? { disposition: "hand-off", cause: HANDOFF_DIAGNOSIS, reentry: "none", diagnosis }
				: undefined;
		case "plan":
			return { disposition: "hand-off", cause: HANDOFF_REENTRY, reentry: "plan", diagnosis };
		case "authorization":
			return { disposition: "hand-off", cause: HANDOFF_REENTRY, reentry: "authorization", diagnosis };
	}
}

export async function driveReviewRound(
	spec: ReviewRoundSpec,
	repoRoot: string,
	seams: ReviewRoundSeams,
): Promise<CommandDisposition> {
	const head = seams.resolveHead(repoRoot, spec.headRef);
	if (head === undefined) return { disposition: "hand-off", cause: HANDOFF_HEAD, reentry: "none" };
	const records = seams.recordsFromComments(seams.readComments(repoRoot, spec.pr));
	const availability = historyAvailability(true, records);
	if (!availability.available) return { disposition: "hand-off", cause: HANDOFF_HISTORY, reentry: "none" };
	const history = repairHistory(availability.records);
	const dispatch = seams.makeDispatch(spec);
	let diagnosis: DiagnosisInput | undefined;
	if (triggerFires(history)) {
		const admitted = admitDiagnosis(
			await dispatch(composeDiagnosisBrief(history, { changeDescription: spec.changeDescription }), head),
		);
		if (!admitted.available) return { disposition: "hand-off", cause: HANDOFF_DIAGNOSIS, reentry: "none" };
		diagnosis = admitted.diagnosis;
		const stop = reentryConsequence(
			diagnosisConsequence(admitted.diagnosis.value, admitted.diagnosis.invalidation),
			admitted.diagnosis,
		);
		if (stop !== undefined) return stop;
	}
	const round = await seams.runRound({
		repoRoot,
		baseRef: spec.baseRef,
		headRef: head,
		manifest: spec.manifest,
		fences: spec.fences,
		changeDescription: spec.changeDescription,
		timing: spec.timing,
		dispatch,
	});
	const published = await seams.publish(round.recordBody, spec.pr);
	if (published.details.disposition !== "published")
		return { disposition: "hand-off", cause: HANDOFF_PUBLISH, reentry: "none" };
	return diagnosis === undefined
		? { disposition: "posted", review: round.review }
		: { disposition: "posted", review: round.review, diagnosis };
}

function readRepositorySpec(repoRoot: string, name: string): ReviewRoundSpec | undefined {
	if (name.length === 0 || isAbsolute(name)) return undefined;
	const path = resolve(repoRoot, name);
	const fromRoot = relative(repoRoot, path);
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) return undefined;
	try {
		let cursor = repoRoot;
		for (const component of fromRoot.split(sep)) {
			cursor = join(cursor, component);
			const stat = lstatSync(cursor);
			if (stat.isSymbolicLink()) return undefined;
		}
		if (!lstatSync(path).isFile()) return undefined;
		return parseReviewRoundSpec(JSON.parse(readFileSync(path, "utf8")));
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
					readComments: fetchReviewComments,
					recordsFromComments,
					makeDispatch: (input) =>
						makeDispatcher({
							callerRepoRoot: repoRoot,
							stateRoot,
							delegateArgv: input.delegateArgv,
							timeoutMs: input.timeoutMs,
						}),
					runRound: reviewRound,
					publish: (body, pr) =>
						performPublish({ body, destination: { kind: "pr-comment", number: pr } }, repoRoot, stateRoot),
					resolveHead: (root, ref) => {
						try {
							return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
								cwd: root,
								encoding: "utf8",
								env: withoutRepoLocatingGitEnv(process.env),
							}).trim();
						} catch {
							return undefined;
						}
					},
				};
				try {
					outcome = await driveReviewRound(spec, repoRoot, { ...defaults, ...injected });
				} catch {
					outcome = { disposition: "hand-off", cause: HANDOFF_ROUND, reentry: "none" };
				}
			}
			pi.appendEntry("gitjig-review-round", outcome);
			pi.sendMessage({ customType: "gitjig-spine-turn", content: [], display: false }, { triggerTurn: true });
			await ctx.waitForIdle();
		},
	});
}

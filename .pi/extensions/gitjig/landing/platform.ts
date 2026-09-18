/** Warning-surface roster: EXEMPT — platform bytes enter closed parsers/results and this adapter renders no text. */
import { join } from "node:path";
import { runPlatformRead } from "../platform/read.ts";
import { trustedDefaultBranchBytes } from "./provenance.ts";
import type { CoreFacts, LandingEffects, LandingSnapshot, LifecycleEngine } from "./service.ts";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OID = /^[0-9a-f]{40}$/;
const REQUIRED_CONTEXTS = [
	"fragment-gate",
	"ssot-home",
	"toc-freshness",
	"source-style",
	"type-check",
	"suite",
	"ac-closeout",
];

export function normalizeReviewActorType(value: unknown): "User" | "Bot" | "Unknown" {
	return value === "User" ? "User" : value === "Bot" ? "Bot" : "Unknown";
}

export function landingPermission(value: unknown): "ADMIN" | "MAINTAIN" | undefined {
	const role =
		typeof record(value)?.role_name === "string" ? String(record(value)?.role_name).toLowerCase() : undefined;
	return role === "admin" ? "ADMIN" : role === "maintain" ? "MAINTAIN" : undefined;
}

export function activeRulesetApplies(detail: unknown, baseRef: string, defaultBranch: string): boolean {
	const ruleset = record(detail);
	if (!ruleset || ruleset.target !== "branch" || baseRef !== defaultBranch) return false;
	const ref = record(record(ruleset.conditions)?.ref_name);
	const include = array(ref?.include);
	const exclude = array(ref?.exclude);
	const subject = `refs/heads/${baseRef}`;
	return (
		(include.includes("~DEFAULT_BRANCH") || include.includes(subject)) &&
		!exclude.includes("~DEFAULT_BRANCH") &&
		!exclude.includes(subject)
	);
}

function parse(value: string | undefined): unknown {
	if (value === undefined) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}
function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

async function api(host: string, repository: string, repoRoot: string, endpoint: string): Promise<unknown> {
	const path = endpoint === "" ? `repos/${repository}` : `repos/${repository}/${endpoint}`;
	return parse(await runPlatformRead(["api", "--hostname", host, path], repoRoot));
}

export function selectCurrentConsumption(
	comments: readonly { id: unknown; authorId: unknown; body: unknown }[],
	currentEscape: { commentId: number; replayKey: string } | undefined,
	headSha: string,
	baseSha: string,
	authorizedConsumerIds: readonly string[],
	engine: Pick<LifecycleEngine, "RECORD_MARKERS" | "parseMarkedRecord" | "admitLandingClaim" | "admitLandingTerminal">,
): { claims: { commentId: number; consumerRunId: string }[]; terminalPresent: boolean } {
	const claims = comments
		.flatMap((comment) => {
			const claim = engine.parseMarkedRecord(comment.body, engine.RECORD_MARKERS.landingClaim);
			const claimRecord = record(claim);
			return currentEscape !== undefined &&
				engine.admitLandingClaim(claim) &&
				claimRecord?.consumerId === comment.authorId &&
				typeof comment.authorId === "string" &&
				authorizedConsumerIds.includes(comment.authorId) &&
				claimRecord?.replayKey === currentEscape.replayKey &&
				claimRecord?.escapeCommentId === currentEscape.commentId &&
				claimRecord?.headSha === headSha &&
				claimRecord?.baseSha === baseSha &&
				Number.isSafeInteger(comment.id)
				? [{ commentId: Number(comment.id), consumerRunId: String(claimRecord?.consumerRunId) }]
				: [];
		})
		.sort((left, right) => left.commentId - right.commentId);
	const terminalPresent = comments.some((comment) => {
		const terminal = engine.parseMarkedRecord(comment.body, engine.RECORD_MARKERS.landingTerminal);
		const terminalRecord = record(terminal);
		return (
			currentEscape !== undefined &&
			engine.admitLandingTerminal(terminal) &&
			terminalRecord?.escapeCommentId === currentEscape.commentId &&
			terminalRecord?.headSha === headSha &&
			terminalRecord?.baseSha === baseSha
		);
	});
	return { claims, terminalPresent };
}

export interface PlatformLandingLoad {
	snapshot?: LandingSnapshot;
	engine?: LifecycleEngine;
	consumerId?: string;
	arm: string;
}

export async function loadPlatformLanding(
	host: string,
	repository: string,
	prNumber: number,
	repoRoot: string,
	_now: string,
): Promise<PlatformLandingLoad> {
	if (!HOST.test(host) || !REPOSITORY.test(repository) || !Number.isSafeInteger(prNumber) || prNumber <= 0)
		return { arm: "address-invalid" };
	const [repoRaw, prRaw] = await Promise.all([
		api(host, repository, repoRoot, ""),
		api(host, repository, repoRoot, `pulls/${prNumber}`),
	]);
	const repo = record(repoRaw);
	const pr = record(prRaw);
	if (!repo || !pr) return { arm: "platform-unreadable" };
	const repositoryId = repo.node_id;
	const pullRequestId = pr.node_id;
	const head = record(pr.head);
	const base = record(pr.base);
	const author = record(pr.user);
	if (
		typeof repositoryId !== "string" ||
		typeof pullRequestId !== "string" ||
		!OID.test(String(head?.sha ?? "")) ||
		!OID.test(String(base?.sha ?? "")) ||
		typeof base?.ref !== "string" ||
		typeof author?.node_id !== "string"
	)
		return { arm: "subject-unmeasurable" };
	const headSha = String(head?.sha);
	const baseSha = String(base?.sha);
	const baseRef = String(base?.ref);
	const authorId = String(author?.node_id);
	const [owner, name] = repository.split("/") as [string, string];
	const threadQuery =
		"query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}pageInfo{hasNextPage}}}}}";
	const [reviewsRaw, commentsRaw, rulesetsRaw, checksRaw, viewerRaw, threadsRaw, baseBranchRaw] = await Promise.all([
		api(host, repository, repoRoot, `pulls/${prNumber}/reviews?per_page=100`),
		api(host, repository, repoRoot, `issues/${prNumber}/comments?per_page=100`),
		api(host, repository, repoRoot, "rulesets?includes_parents=true&per_page=100"),
		api(host, repository, repoRoot, `commits/${headSha}/check-runs?per_page=100`),
		parse(await runPlatformRead(["api", "--hostname", host, "user"], repoRoot)),
		parse(
			await runPlatformRead(
				[
					"api",
					"--hostname",
					host,
					"graphql",
					"-f",
					`query=${threadQuery}`,
					"-F",
					`owner=${owner}`,
					"-F",
					`name=${name}`,
					"-F",
					`number=${prNumber}`,
				],
				repoRoot,
			),
		),
		api(host, repository, repoRoot, `branches/${encodeURIComponent(baseRef)}`),
	]);

	if (array(reviewsRaw).length === 100 || array(commentsRaw).length === 100 || array(rulesetsRaw).length === 100)
		return { arm: "platform-population-incomplete" };
	if (Number(record(checksRaw)?.total_count ?? 0) > array(record(checksRaw)?.check_runs).length)
		return { arm: "platform-population-incomplete" };

	const content = async (path: string): Promise<Record<string, unknown> | undefined> =>
		record(
			await api(host, repository, repoRoot, `contents/${path}?ref=${encodeURIComponent(String(repo.default_branch))}`),
		);
	const [engineBlob, policyBlob, policyCarrierBlob, topologyBlob] = await Promise.all([
		content(".github/workflows/gitjig-lifecycle.mjs"),
		content(".github/workflows/landing-policy.mjs"),
		content(".github/landing-policy.json"),
		content(".github/landing-topology.json"),
	]);
	const enginePath = join(repoRoot, ".github/workflows/gitjig-lifecycle.mjs");
	const policyPath = join(repoRoot, ".github/workflows/landing-policy.mjs");
	const engineBytes = trustedDefaultBranchBytes(enginePath, engineBlob?.sha);
	const policyBytes = trustedDefaultBranchBytes(policyPath, policyBlob?.sha);
	if (!engineBytes || !policyBytes) return { arm: "trusted-engine-policy-mismatch" };
	let engine: LifecycleEngine;
	let appPolicyConfigured = false;
	try {
		engine = (await import(`data:text/javascript;base64,${engineBytes.toString("base64")}`)) as LifecycleEngine;
		const policyModule = (await import(`data:text/javascript;base64,${policyBytes.toString("base64")}`)) as {
			parseLandingPolicy(value: unknown): { ok: boolean };
		};
		if (policyCarrierBlob?.encoding === "base64" && typeof policyCarrierBlob.content === "string") {
			const policyValue: unknown = JSON.parse(
				Buffer.from(policyCarrierBlob.content.replace(/\s/g, ""), "base64").toString("utf8"),
			);
			appPolicyConfigured = policyModule.parseLandingPolicy(policyValue).ok;
		}
	} catch {
		return { arm: "shared-module-unloadable" };
	}

	const rulesets = array(rulesetsRaw)
		.map(record)
		.filter((item): item is Record<string, unknown> => item !== undefined);
	const activeNamed = (name: string) => rulesets.filter((item) => item.name === name && item.enforcement === "active");
	const human = activeNamed("human-approval");
	const coreRulesets = activeNamed("core-governance");
	const detailFor = async (items: Record<string, unknown>[]) =>
		items.length === 1 && Number.isSafeInteger(items[0]?.id)
			? record(await api(host, repository, repoRoot, `rulesets/${String(items[0]?.id)}`))
			: undefined;
	const [humanDetail, coreDetail] = await Promise.all([detailFor(human), detailFor(coreRulesets)]);
	const applies = (detail: Record<string, unknown> | undefined): boolean =>
		activeRulesetApplies(detail, baseRef, String(repo.default_branch));
	const rule = (detail: Record<string, unknown> | undefined, type: string) =>
		array(detail?.rules)
			.map(record)
			.find((item) => item?.type === type);
	const humanPull = applies(humanDetail) ? rule(humanDetail, "pull_request") : undefined;
	const humanParameters = record(humanPull?.parameters);
	const required = Number(humanParameters?.required_approving_review_count ?? 0);
	const coreApplies = applies(coreDetail);
	let topologyRecord: Record<string, unknown> | undefined;
	try {
		if (topologyBlob?.encoding === "base64" && typeof topologyBlob.content === "string")
			topologyRecord = record(
				JSON.parse(Buffer.from(topologyBlob.content.replace(/\s/g, ""), "base64").toString("utf8")),
			);
	} catch {
		topologyRecord = undefined;
	}
	const topologyActive =
		topologyRecord !== undefined &&
		Object.keys(topologyRecord).length === 8 &&
		topologyRecord.schemaVersion === 1 &&
		topologyRecord.phase === 4 &&
		topologyRecord.repositoryId === repositoryId &&
		topologyRecord.coreRulesetId === coreDetail?.id &&
		topologyRecord.humanApprovalRulesetId === humanDetail?.id &&
		topologyRecord.coreRulesetUpdatedAt === coreDetail?.updated_at &&
		topologyRecord.humanApprovalRulesetUpdatedAt === humanDetail?.updated_at &&
		typeof topologyRecord.activatedAt === "string" &&
		Number.isFinite(Date.parse(topologyRecord.activatedAt)) &&
		Date.parse(topologyRecord.activatedAt) >= Date.parse(String(coreDetail?.updated_at)) &&
		Date.parse(topologyRecord.activatedAt) >= Date.parse(String(humanDetail?.updated_at));
	const corePull = coreApplies ? rule(coreDetail, "pull_request") : undefined;
	const corePullParameters = record(corePull?.parameters);
	const statusParameters = record((coreApplies ? rule(coreDetail, "required_status_checks") : undefined)?.parameters);
	const configuredContexts = array(statusParameters?.required_status_checks)
		.map(record)
		.map((item) => item?.context)
		.filter((item): item is string => typeof item === "string");
	const reviews = array(reviewsRaw);
	const normalizedReviews = reviews.map((item) => {
		const review = record(item);
		return {
			actorId: record(review?.user)?.node_id,
			actorType: normalizeReviewActorType(record(review?.user)?.type),
			association: review?.author_association,
			state: review?.state,
			headSha: review?.commit_id,
			submittedAt: review?.submitted_at,
			dismissed: review?.state === "DISMISSED",
		};
	});
	const approval = engine.eligibleApprovalCount?.(normalizedReviews, authorId, headSha, required) as
		| { ok: boolean; count?: number }
		| undefined;
	const standingChangesRequested = normalizedReviews.some((review) =>
		engine.eligibleChangesRequested?.(review, authorId, headSha),
	);
	const checkRuns = array(record(checksRaw)?.check_runs).map(record);
	const successful = new Set(
		checkRuns
			.filter((check) => check?.status === "completed" && check.conclusion === "success")
			.map((check) => String(check?.name)),
	);
	const requiredContexts =
		REQUIRED_CONTEXTS.every((context) => configuredContexts.includes(context)) &&
		configuredContexts.length > 0 &&
		configuredContexts.every((context) => successful.has(context));
	const commentRecords = array(commentsRaw).map((item) => {
		const comment = record(item);
		const user = record(comment?.user);
		return { id: comment?.id, authorId: user?.node_id, authorLogin: user?.login, body: comment?.body };
	});
	const comments = commentRecords.map(({ id, authorId, body }) => ({ id, authorId, body }));
	const threadConnection = record(record(record(record(threadsRaw)?.data)?.repository)?.pullRequest)?.reviewThreads;
	const threadRecord = record(threadConnection);
	const threadNodes = array(threadRecord?.nodes).map(record);
	const threadsMeasured = record(threadRecord?.pageInfo)?.hasNextPage === false;
	const allThreadsResolved = threadsMeasured && threadNodes.every((thread) => thread?.isResolved === true);
	const labels = new Set(
		array(pr.labels)
			.map(record)
			.map((label) => String(label?.name)),
	);
	const escapeCandidates = [] as { commentId: number; replayKey: string; record: unknown; context: unknown }[];
	for (const comment of commentRecords) {
		const escapeRecord = engine.parseMarkedRecord(comment.body, engine.RECORD_MARKERS.escape);
		if (escapeRecord === undefined || typeof comment.authorLogin !== "string" || typeof comment.authorId !== "string")
			continue;
		const permission = record(
			await api(host, repository, repoRoot, `collaborators/${encodeURIComponent(comment.authorLogin)}/permission`),
		);
		const context = {
			carryingCommentAuthorId: comment.authorId,
			livePermission: landingPermission(permission) ?? null,
			// A configured carrier is necessary but not sufficient: this REST surface
			// supplies no installation identity, so the App arm remains closed.
			appAttested: record(escapeRecord)?.producerKind === "app" ? false : appPolicyConfigured,
			now: _now,
			repositoryId,
			pullRequestId,
			headSha,
			baseRef,
			baseSha,
			labelPresent: labels.has("merge:bypass-permitted"),
		};
		if (engine.validateEscapeRecord(escapeRecord, context).ok && Number.isSafeInteger(comment.id))
			escapeCandidates.push({
				commentId: Number(comment.id),
				replayKey: JSON.stringify([repositoryId, pullRequestId, headSha, Number(comment.id)]),
				record: escapeRecord,
				context,
			});
	}
	const currentEscape = escapeCandidates.length === 1 ? escapeCandidates[0] : undefined;
	const claimAuthorPermissions = await Promise.all(
		commentRecords.map(async (comment) => {
			if (
				typeof comment.body !== "string" ||
				!comment.body.startsWith(engine.RECORD_MARKERS.landingClaim) ||
				typeof comment.authorId !== "string" ||
				typeof comment.authorLogin !== "string"
			)
				return undefined;
			const permission = record(
				await api(host, repository, repoRoot, `collaborators/${encodeURIComponent(comment.authorLogin)}/permission`),
			);
			return new Set(["admin", "maintain", "write"]).has(String(permission?.role_name).toLowerCase())
				? comment.authorId
				: undefined;
		}),
	);
	const authorizedClaimAuthors = claimAuthorPermissions.filter((value): value is string => value !== undefined);
	const consumption = selectCurrentConsumption(
		comments,
		currentEscape,
		headSha,
		baseSha,
		authorizedClaimAuthors,
		engine,
	);
	const admittedClaims = consumption.claims;
	const terminalPresent = consumption.terminalPresent;
	const claimExists = admittedClaims.length > 0;
	const acCloseout = successful.has("ac-closeout") && configuredContexts.includes("ac-closeout");
	const core: CoreFacts = {
		changelog: successful.has("fragment-gate"),
		ssotHome: successful.has("ssot-home"),
		tocFreshness: successful.has("toc-freshness"),
		sourceStyle: successful.has("source-style"),
		typeCheck: successful.has("type-check"),
		suite: successful.has("suite"),
		acCloseout,
		protectedBranch: corePull !== undefined,
		deletionProtection: coreApplies && rule(coreDetail, "deletion") !== undefined,
		forcePushProtection: coreApplies && rule(coreDetail, "non_fast_forward") !== undefined,
		requiredContexts,
		threadsResolved: corePullParameters?.required_review_thread_resolution === true && allThreadsResolved,
		mergeMethod:
			repo.allow_merge_commit === true &&
			repo.allow_squash_merge === false &&
			repo.allow_rebase_merge === false &&
			array(corePullParameters?.allowed_merge_methods).length === 1 &&
			array(corePullParameters?.allowed_merge_methods)[0] === "merge",
		// Snapshot head existence is measured above; freshness is re-measured
		// immediately before the exact-sha merge request by the service.
		headFresh: true,
		baseFresh: record(record(baseBranchRaw)?.commit)?.sha === baseSha,
		history: coreApplies && rule(coreDetail, "non_fast_forward") !== undefined,
		open: pr.state === "open",
		nonDraft: pr.draft === false,
		mergeable: pr.mergeable === true,
		upToDate: !new Set(["behind", "dirty", "unknown", "unstable"]).has(String(pr.mergeable_state)),
	};
	return {
		arm: "loaded",
		engine,
		consumerId: typeof record(viewerRaw)?.node_id === "string" ? String(record(viewerRaw)?.node_id) : undefined,
		snapshot: {
			repositoryId,
			pullRequestId,
			headSha,
			baseSha,
			baseRef,
			prAuthorId: authorId,
			core,
			quorum: {
				measurable: required > 0 && human.length === 1 && applies(humanDetail),
				required,
				approvals: approval?.count ?? 0,
			},
			standingChangesRequested,
			topologyActive,
			escape:
				currentEscape !== undefined
					? {
							...currentEscape,
							alreadyClaimed: claimExists || terminalPresent,
							claim: admittedClaims[0],
							terminalPresent,
						}
					: undefined,
		},
	};
}

export function platformLandingEffects(
	host: string,
	repository: string,
	prNumber: number,
	repoRoot: string,
): LandingEffects {
	const post = async (endpoint: string, fields: string[] = []): Promise<unknown> =>
		parse(
			await runPlatformRead(
				["api", "--hostname", host, "--method", "POST", `repos/${repository}/${endpoint}`, ...fields],
				repoRoot,
			),
		);
	return {
		comment: async (body) => {
			const result = record(await post(`issues/${prNumber}/comments`, ["-f", `body=${body}`]));
			return Number(result?.id ?? 0);
		},
		removeLabel: async (label) =>
			(await runPlatformRead(
				[
					"api",
					"--hostname",
					host,
					"--method",
					"DELETE",
					`repos/${repository}/issues/${prNumber}/labels/${encodeURIComponent(label)}`,
				],
				repoRoot,
			)) !== undefined,
		readClaims: async () => {
			const raw = array(await api(host, repository, repoRoot, `issues/${prNumber}/comments?per_page=100`));
			if (raw.length === 100) return undefined;
			const normalized = raw.map((item) => {
				const comment = record(item);
				const user = record(comment?.user);
				return { id: comment?.id, authorId: user?.node_id, authorLogin: user?.login, body: comment?.body };
			});
			const claimAuthors = new Map<string, string>();
			for (const comment of normalized)
				if (
					typeof comment.body === "string" &&
					comment.body.startsWith("<!-- lifecycle-landing-claim: v1 -->") &&
					typeof comment.authorId === "string" &&
					typeof comment.authorLogin === "string"
				)
					claimAuthors.set(comment.authorId, comment.authorLogin);
			const permissions = await Promise.all(
				[...claimAuthors].map(async ([actorId, login]) => {
					const permission = record(
						await api(host, repository, repoRoot, `collaborators/${encodeURIComponent(login)}/permission`),
					);
					return new Set(["admin", "maintain", "write"]).has(String(permission?.role_name).toLowerCase())
						? actorId
						: undefined;
				}),
			);
			return {
				comments: normalized.map(({ id, authorId, body }) => ({ id, authorId, body })),
				authorizedConsumerIds: permissions.filter((value): value is string => value !== undefined),
			};
		},
		rereadHeads: async () => {
			const value = record(await api(host, repository, repoRoot, `pulls/${prNumber}`));
			const head = record(value?.head);
			const base = record(value?.base);
			return typeof head?.sha === "string" && typeof base?.sha === "string"
				? { headSha: head.sha, baseSha: base.sha }
				: undefined;
		},
		merge: async (expectedHeadSha) => {
			const value = record(
				parse(
					await runPlatformRead(
						[
							"api",
							"--hostname",
							host,
							"--method",
							"PUT",
							`repos/${repository}/pulls/${prNumber}/merge`,
							"-f",
							`sha=${expectedHeadSha}`,
							"-f",
							"merge_method=merge",
						],
						repoRoot,
					),
				),
			);
			return value?.merged === true ? "accepted" : value === undefined ? "unknown" : "rejected";
		},
		verifyMerge: async (headSha, baseSha) => {
			const pull = record(await api(host, repository, repoRoot, `pulls/${prNumber}`));
			if (!pull || pull.merged !== true || typeof pull.merge_commit_sha !== "string")
				return pull?.merged === false ? "not-landed" : "unknown";
			const commit = record(await api(host, repository, repoRoot, `commits/${pull.merge_commit_sha}`));
			const parents = array(commit?.parents).map(record);
			if (parents.length !== 2) return "unknown";
			if (parents[1]?.sha !== headSha) return "unknown";
			return parents[0]?.sha === baseSha ? "landed" : "unknown";
		},
	};
}

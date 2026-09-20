/** Warning-surface roster: EXEMPT — platform bytes enter closed parsers/results and this adapter renders no text. */
import { runPlatformRead } from "../platform/read.ts";
import { runPlatformMutation } from "../platform/write.ts";
import { parseReviewRecord } from "../review/record.ts";
import { BYPASS_LABEL, type LandingEffects, type LandingSnapshot } from "./service.ts";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OID = /^[0-9a-f]{40}$/;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
function parse(value: string | undefined): unknown {
	try {
		return value === undefined ? undefined : JSON.parse(value);
	} catch {
		return undefined;
	}
}
export type PlatformRunner = (argv: string[], repoRoot: string) => Promise<string | undefined>;

function refPatternMatches(pattern: unknown, subject: string): boolean | undefined {
	if (pattern === "~ALL") return true;
	if (typeof pattern !== "string" || pattern.length === 0 || /[[\]{}\\]/.test(pattern)) return undefined;
	const escaped = pattern
		.replace(/[.+^$()|]/g, "\\$&")
		.replace(/\*\*/g, "\0")
		.replace(/\*/g, "[^/]*")
		.replace(/\0/g, ".*")
		.replace(/\?/g, "[^/]");
	try {
		return new RegExp(`^${escaped}$`, "u").test(subject);
	} catch {
		return undefined;
	}
}
function rulesetApplicability(detail: unknown, baseRef: string, defaultBranch: string): boolean | undefined {
	const ruleset = record(detail);
	if (!ruleset || typeof ruleset.target !== "string" || typeof ruleset.enforcement !== "string") return undefined;
	if (ruleset.target !== "branch" || ruleset.enforcement !== "active") return false;
	const conditions = record(ruleset.conditions);
	const names = record(conditions?.ref_name);
	if (
		!conditions ||
		Object.keys(conditions).some((key) => key !== "ref_name") ||
		!names ||
		!Array.isArray(names.include) ||
		!Array.isArray(names.exclude) ||
		Object.keys(names).some((key) => key !== "include" && key !== "exclude")
	)
		return undefined;
	const subject = `refs/heads/${baseRef}`;
	const match = (pattern: unknown) =>
		pattern === "~DEFAULT_BRANCH" ? baseRef === defaultBranch : refPatternMatches(pattern, subject);
	const excluded = names.exclude.map(match);
	const included = names.include.map(match);
	if ([...excluded, ...included].some((item) => item === undefined)) return undefined;
	if (excluded.some(Boolean)) return false;
	return included.length > 0 && included.some(Boolean);
}
export function activeRulesetApplies(detail: unknown, baseRef: string, defaultBranch: string): boolean {
	return rulesetApplicability(detail, baseRef, defaultBranch) === true;
}

export function newestCheckConclusions(
	checks: readonly unknown[],
): Map<string, { status: string; conclusion: string }> | undefined {
	const result = new Map<string, { id: number; status: string; conclusion: string }>();
	const ids = new Set<number>();
	for (const value of checks) {
		const item = record(value);
		if (!item || typeof item.name !== "string" || !Number.isSafeInteger(item.id) || typeof item.status !== "string")
			return undefined;
		const id = Number(item.id);
		if (ids.has(id)) return undefined;
		ids.add(id);
		const prior = result.get(item.name);
		if (!prior || id > prior.id)
			result.set(item.name, {
				id,
				status: item.status,
				conclusion: typeof item.conclusion === "string" ? item.conclusion : "",
			});
	}
	return new Map([...result].map(([name, item]) => [name, { status: item.status, conclusion: item.conclusion }]));
}

interface StrictCheck {
	name: string;
	appId: number;
	appSlug: string;
	status: string;
	conclusion: string;
}
function strictCheckRollup(checks: readonly unknown[]): Map<string, StrictCheck> | undefined {
	const result = new Map<string, StrictCheck & { id: number }>();
	const ids = new Set<number>();
	for (const value of checks) {
		const item = record(value);
		const app = record(item?.app);
		if (
			!item ||
			typeof item.name !== "string" ||
			item.name.length === 0 ||
			!Number.isSafeInteger(item.id) ||
			typeof item.status !== "string" ||
			!app ||
			!Number.isSafeInteger(app.id) ||
			typeof app.slug !== "string"
		)
			return undefined;
		const id = Number(item.id);
		if (ids.has(id)) return undefined;
		ids.add(id);
		const key = JSON.stringify([item.name, Number(app.id)]);
		const prior = result.get(key);
		if (!prior || prior.id < id)
			result.set(key, {
				id,
				name: item.name,
				appId: Number(app.id),
				appSlug: app.slug,
				status: item.status,
				conclusion: typeof item.conclusion === "string" ? item.conclusion : "",
			});
	}
	return result;
}

async function api(
	host: string,
	repository: string,
	repoRoot: string,
	endpoint: string,
	runner: PlatformRunner,
): Promise<unknown> {
	return parse(
		await runner(
			["api", "--hostname", host, endpoint === "" ? `repos/${repository}` : `repos/${repository}/${endpoint}`],
			repoRoot,
		),
	);
}
async function pages(
	host: string,
	repository: string,
	repoRoot: string,
	endpoint: string,
	runner: PlatformRunner,
): Promise<unknown[] | undefined> {
	const result: unknown[] = [];
	for (let page = 1; page <= 100; page += 1) {
		const separator = endpoint.includes("?") ? "&" : "?";
		const value = await api(host, repository, repoRoot, `${endpoint}${separator}per_page=100&page=${page}`, runner);
		if (!Array.isArray(value)) return undefined;
		result.push(...value);
		if (value.length < 100) return result;
	}
	return undefined;
}
function rule(detail: Record<string, unknown>, type: string): Record<string, unknown> | undefined {
	return array(detail.rules)
		.map(record)
		.find((item) => item?.type === type);
}
async function checkPages(
	host: string,
	repository: string,
	headSha: string,
	repoRoot: string,
	runner: PlatformRunner,
): Promise<unknown[] | undefined> {
	const result: unknown[] = [];
	let total: number | undefined;
	for (let page = 1; page <= 100; page += 1) {
		const value = record(
			await api(host, repository, repoRoot, `commits/${headSha}/check-runs?per_page=100&page=${page}`, runner),
		);
		const items = array(value?.check_runs);
		if (!Number.isSafeInteger(value?.total_count) || (total !== undefined && total !== value?.total_count))
			return undefined;
		total = Number(value?.total_count);
		result.push(...items);
		if (result.length === total) return result;
		if (items.length !== 100 || result.length > total) return undefined;
	}
	return undefined;
}
async function allThreadsResolved(
	host: string,
	repository: string,
	number: number,
	repoRoot: string,
	runner: PlatformRunner,
): Promise<boolean | undefined> {
	const [owner, name] = repository.split("/") as [string, string];
	let cursor: string | null = null;
	for (let page = 0; page < 100; page += 1) {
		const query =
			"query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}";
		const argv = [
			"api",
			"--hostname",
			host,
			"graphql",
			"-f",
			`query=${query}`,
			"-F",
			`owner=${owner}`,
			"-F",
			`name=${name}`,
			"-F",
			`number=${number}`,
		];
		if (cursor !== null) argv.push("-F", `cursor=${cursor}`);
		const connection = record(
			record(record(record(parse(await runner(argv, repoRoot)))?.data)?.repository)?.pullRequest,
		)?.reviewThreads;
		const threads = record(connection);
		const nodes = array(threads?.nodes).map(record);
		const info = record(threads?.pageInfo);
		if (nodes.some((item) => typeof item?.isResolved !== "boolean") || typeof info?.hasNextPage !== "boolean")
			return undefined;
		if (nodes.some((item) => item?.isResolved !== true)) return false;
		if (info.hasNextPage === false) return true;
		if (typeof info.endCursor !== "string" || info.endCursor.length === 0) return undefined;
		cursor = info.endCursor;
	}
	return undefined;
}

export interface PlatformLandingLoad {
	snapshot?: LandingSnapshot;
	arm: string;
}
export async function loadPlatformLanding(
	host: string,
	repository: string,
	prNumber: number,
	repoRoot: string,
	_now: string,
	runner: PlatformRunner = runPlatformRead,
): Promise<PlatformLandingLoad> {
	if (!HOST.test(host) || !REPOSITORY.test(repository) || !Number.isSafeInteger(prNumber) || prNumber <= 0)
		return { arm: "address-invalid" };
	const get = (endpoint: string) => api(host, repository, repoRoot, endpoint, runner);
	const [repoRaw, prRaw, viewerRaw, rulesetsRaw] = await Promise.all([
		get(""),
		get(`pulls/${prNumber}`),
		parse(await runner(["api", "--hostname", host, "user"], repoRoot)),
		pages(host, repository, repoRoot, "rulesets?includes_parents=true", runner),
	]);
	const repo = record(repoRaw);
	const pr = record(prRaw);
	const viewer = record(viewerRaw);
	const head = record(pr?.head);
	const base = record(pr?.base);
	const author = record(pr?.user);
	if (
		!repo ||
		!pr ||
		!viewer ||
		!rulesetsRaw ||
		typeof repo.node_id !== "string" ||
		typeof pr.node_id !== "string" ||
		typeof viewer.node_id !== "string" ||
		!OID.test(String(head?.sha ?? "")) ||
		!OID.test(String(base?.sha ?? "")) ||
		typeof base?.ref !== "string" ||
		typeof author?.node_id !== "string"
	)
		return { arm: "subject-unmeasurable" };
	const headSha = String(head?.sha);
	const baseSha = String(base?.sha);
	const baseRef = String(base?.ref);
	const summaries = rulesetsRaw.map(record);
	if (summaries.some((item) => !item || !Number.isSafeInteger(item.id))) return { arm: "ruleset-population" };
	const details = await Promise.all(summaries.map((item) => get(`rulesets/${String(item?.id)}`).then(record)));
	if (details.some((item) => !item)) return { arm: "ruleset-population" };
	const applicability = details.map((item) => rulesetApplicability(item, baseRef, String(repo.default_branch)));
	if (applicability.some((item) => item === undefined)) return { arm: "predicate-ownership-unknown" };
	const active = details.filter(
		(item, index): item is Record<string, unknown> => item !== undefined && applicability[index] === true,
	);
	if (active.length !== 1)
		return { arm: active.length === 0 ? "predicate-ownership-unknown" : "predicate-ownership-multiple" };
	const owner = active[0];
	if (owner.source_type !== "Repository") return { arm: "predicate-ownership-inherited" };
	if (
		typeof repo.allow_merge_commit !== "boolean" ||
		typeof repo.allow_squash_merge !== "boolean" ||
		typeof repo.allow_rebase_merge !== "boolean"
	)
		return { arm: "repository-settings-unmeasurable" };
	if (!Array.isArray(owner.rules)) return { arm: "predicate-rule-malformed" };
	const ownerRules = owner.rules.map(record);
	const knownRuleTypes = new Set(["pull_request", "required_status_checks", "deletion", "non_fast_forward"]);
	if (
		ownerRules.some(
			(item) =>
				!item ||
				typeof item.type !== "string" ||
				!knownRuleTypes.has(item.type) ||
				Object.keys(item).some((key) => key !== "type" && key !== "parameters"),
		)
	)
		return { arm: "predicate-rule-unsupported" };
	if (
		ownerRules.some(
			(item) => new Set(["deletion", "non_fast_forward"]).has(String(item?.type)) && item?.parameters !== undefined,
		)
	)
		return { arm: "predicate-rule-malformed" };
	const ruleTypes = ownerRules.map((item) => String(item?.type));
	if (new Set(ruleTypes).size !== ruleTypes.length) return { arm: "predicate-rule-duplicate" };
	const pull = rule(owner, "pull_request");
	const pullParameters = pull === undefined ? undefined : record(pull.parameters);
	const pullKeys = new Set([
		"required_approving_review_count",
		"dismiss_stale_reviews_on_push",
		"require_code_owner_review",
		"require_last_push_approval",
		"required_review_thread_resolution",
		"required_reviewers",
		"require_extra_approval_for_unattributed_changes",
		"allowed_merge_methods",
	]);
	if (
		pull !== undefined &&
		(!pullParameters ||
			Object.keys(pullParameters).some((key) => !pullKeys.has(key)) ||
			typeof pullParameters.dismiss_stale_reviews_on_push !== "boolean" ||
			typeof pullParameters.require_code_owner_review !== "boolean" ||
			typeof pullParameters.require_last_push_approval !== "boolean" ||
			typeof pullParameters.required_review_thread_resolution !== "boolean" ||
			!Array.isArray(pullParameters.required_reviewers) ||
			typeof pullParameters.require_extra_approval_for_unattributed_changes !== "boolean" ||
			!Array.isArray(pullParameters.allowed_merge_methods))
	)
		return { arm: "pull-request-rule-malformed" };
	const statusRule = rule(owner, "required_status_checks");
	const status = statusRule === undefined ? undefined : record(statusRule.parameters);
	if (
		statusRule !== undefined &&
		(!status ||
			Object.keys(status).some(
				(key) =>
					key !== "required_status_checks" &&
					key !== "strict_required_status_checks_policy" &&
					key !== "do_not_enforce_on_create",
			) ||
			!Array.isArray(status.required_status_checks) ||
			typeof status.strict_required_status_checks_policy !== "boolean" ||
			typeof status.do_not_enforce_on_create !== "boolean")
	)
		return { arm: "status-rule-malformed" };
	const configuredChecks: { context: string; integrationId: number | null }[] = [];
	for (const value of array(status?.required_status_checks)) {
		const item = record(value);
		const keys = item ? Object.keys(item) : [];
		if (
			!item ||
			!keys.every((key) => key === "context" || key === "integration_id") ||
			typeof item.context !== "string" ||
			item.context.length === 0 ||
			!(item.integration_id === undefined || item.integration_id === null || Number.isSafeInteger(item.integration_id))
		)
			return { arm: "status-rule-malformed" };
		configuredChecks.push({
			context: item.context,
			integrationId: item.integration_id == null ? null : Number(item.integration_id),
		});
	}
	if (
		new Set(configuredChecks.map((item) => JSON.stringify([item.context, item.integrationId]))).size !==
		configuredChecks.length
	)
		return { arm: "status-rule-duplicate" };
	if (
		pullParameters &&
		!array(pullParameters.allowed_merge_methods).every((item) =>
			new Set(["merge", "squash", "rebase"]).has(String(item)),
		)
	)
		return { arm: "pull-request-rule-malformed" };
	if (
		pullParameters?.require_code_owner_review === true ||
		pullParameters?.require_last_push_approval === true ||
		array(pullParameters?.required_reviewers).length > 0 ||
		pullParameters?.require_extra_approval_for_unattributed_changes === true
	)
		return { arm: "pull-request-rule-unsupported" };
	const requiredApprovals = Number(pullParameters?.required_approving_review_count ?? 0);
	if (!Number.isInteger(requiredApprovals) || requiredApprovals < 0) return { arm: "native-approval-unmeasurable" };
	const [reviews, comments, checkRuns, branchRaw, threads, permissionRaw] = await Promise.all([
		pages(host, repository, repoRoot, `pulls/${prNumber}/reviews`, runner),
		pages(host, repository, repoRoot, `issues/${prNumber}/comments`, runner),
		checkPages(host, repository, headSha, repoRoot, runner),
		get(`branches/${encodeURIComponent(baseRef)}`),
		allThreadsResolved(host, repository, prNumber, repoRoot, runner),
		typeof viewer.login === "string"
			? get(`collaborators/${encodeURIComponent(viewer.login)}/permission`)
			: Promise.resolve(undefined),
	]);
	if (!reviews || !comments || !checkRuns) return { arm: "platform-population-incomplete" };
	if (!new Set(["write", "maintain", "admin"]).has(String(record(permissionRaw)?.role_name).toLowerCase()))
		return { arm: "operator-permission" };
	const checks = strictCheckRollup(checkRuns);
	if (!checks) return { arm: "check-rollup-ambiguous" };
	const matchingChecks = (context: string, integrationId: number | null) =>
		[...checks.values()].filter(
			(item) => item.name === context && (integrationId === null || item.appId === integrationId),
		);
	const requiredStates = configuredChecks.map((item) => matchingChecks(item.context, item.integrationId));
	if (requiredStates.some((items) => items.length !== 1)) return { arm: "check-rollup-ambiguous" };
	const requiredChecks = requiredStates.every(
		(items) => items[0]?.status === "completed" && items[0]?.conclusion === "success",
	)
		? "pass"
		: requiredStates.some((items) => items[0]?.status !== "completed")
			? "pending"
			: "fail";
	const acChecks = [...checks.values()].filter(
		(item) => item.name === "ac-closeout" && item.appSlug === "github-actions",
	);
	if (acChecks.length > 1) return { arm: "ac-closeout-ambiguous" };
	const acCloseout =
		acChecks.length === 1 && acChecks[0]?.status === "completed" && acChecks[0]?.conclusion === "success";
	const latestReview = new Map<string, Record<string, unknown>>();
	for (const value of reviews) {
		const item = record(value);
		const user = record(item?.user);
		if (typeof user?.node_id !== "string" || typeof item?.submitted_at !== "string")
			return { arm: "review-population" };
		const prior = latestReview.get(user.node_id);
		if (!prior || String(prior.submitted_at) < item.submitted_at) latestReview.set(user.node_id, item);
	}
	const approvals = [...latestReview.values()].filter(
		(item) =>
			item.state === "APPROVED" &&
			item.commit_id === headSha &&
			record(item.user)?.node_id !== author.node_id &&
			new Set(["OWNER", "MEMBER", "COLLABORATOR"]).has(String(item.author_association)),
	).length;
	const markedComments = comments.filter(
		(item) =>
			record(record(item)?.user)?.node_id === viewer.node_id &&
			String(record(item)?.body ?? "").startsWith("<!-- gitjig-review-record:"),
	);
	if (markedComments.some((item) => parseReviewRecord(String(record(item)?.body ?? "")) === undefined))
		return { arm: "review-record-malformed" };
	const reviewRecords = markedComments
		.map((item) => parseReviewRecord(String(record(item)?.body ?? "")))
		.filter((item) => item?.head === headSha);
	if (reviewRecords.length > 1) return { arm: "review-record-ambiguous" };
	const reviewRecord = reviewRecords[0];
	let resolver: LandingSnapshot["resolver"] = "missing";
	if (reviewRecord?.review.state === "approved") resolver = "clear";
	else if (reviewRecord?.review.state === "resolved")
		resolver = reviewRecord.review.resolution.outcome === "clear" ? "clear" : "blocked";
	else if (reviewRecord) resolver = "blocked";
	const labels = array(pr.labels)
		.map(record)
		.map((item) => String(item?.name));
	const branch = record(branchRaw);
	const branchSha = record(branch?.commit)?.sha;
	const allowed = array(pullParameters?.allowed_merge_methods);
	return {
		arm: "loaded",
		snapshot: {
			repositoryId: String(repo.node_id),
			pullRequestId: String(pr.node_id),
			pullRequestNumber: prNumber,
			operatorId: String(viewer.node_id),
			headSha,
			baseRef,
			baseSha,
			labels,
			reviewHeadSha: reviewRecord?.head,
			reviewComplete: reviewRecord !== undefined,
			judgeComplete:
				reviewRecord?.review.state === "approved" ||
				(reviewRecord?.adjudication !== null && reviewRecord?.adjudication !== undefined),
			resolver,
			acCloseout,
			requiredApprovals,
			approvals,
			requiredChecks,
			threadsResolved: pullParameters?.required_review_thread_resolution !== true || threads === true,
			fresh:
				branchSha === baseSha && !new Set(["behind", "dirty", "unknown", "unstable"]).has(String(pr.mergeable_state)),
			mergeMethodAllowed:
				repo.allow_merge_commit === true &&
				repo.allow_squash_merge === false &&
				repo.allow_rebase_merge === false &&
				(allowed.length === 0 || (allowed.length === 1 && allowed[0] === "merge")),
			forcePushProtected: rule(owner, "non_fast_forward") !== undefined,
			deletionProtected: rule(owner, "deletion") !== undefined,
			mergeability: pr.mergeable === true ? "mergeable" : pr.mergeable === false ? "conflicting" : "unknown",
			open: pr.state === "open",
			nonDraft: pr.draft === false,
			predicateOwnership: "single",
		},
	};
}

export function platformLandingEffects(
	host: string,
	repository: string,
	pr: number,
	repoRoot: string,
	reread: () => Promise<PlatformLandingLoad> = () =>
		loadPlatformLanding(host, repository, pr, repoRoot, new Date().toISOString()),
): LandingEffects {
	return {
		async merge(route, expectedHead) {
			const argv = [
				"api",
				"--hostname",
				host,
				"--method",
				"PUT",
				`repos/${repository}/pulls/${pr}/merge`,
				"-f",
				`sha=${expectedHead}`,
				"-f",
				"merge_method=merge",
			];
			if (route !== "ordinary") argv.push("-H", "X-GitHub-Api-Version: 2022-11-28");
			const value = parse(await runPlatformMutation(argv, repoRoot));
			const result = record(value);
			return result?.merged === true ? "merged" : result ? "blocked" : "unknown";
		},
		async applyLabel(label) {
			if (label !== BYPASS_LABEL) return "failed";
			const value = await runPlatformMutation(
				[
					"api",
					"--hostname",
					host,
					"--method",
					"POST",
					`repos/${repository}/issues/${pr}/labels`,
					"-f",
					`labels[]=${label}`,
				],
				repoRoot,
			);
			const labels = array(parse(value))
				.map(record)
				.map((item) => item?.name);
			return labels.includes(BYPASS_LABEL) ? "applied" : "unknown";
		},
		async comment(body) {
			const response = record(
				parse(
					await runPlatformMutation(
						[
							"api",
							"--hostname",
							host,
							"--method",
							"POST",
							`repos/${repository}/issues/${pr}/comments`,
							"-f",
							`body=${body}`,
						],
						repoRoot,
					),
				),
			);
			const authorId = record(response?.user)?.node_id;
			return response && Number.isSafeInteger(response.id) && typeof authorId === "string"
				? { status: "published", id: Number(response.id), authorId }
				: "unknown";
		},
		async readComments() {
			const value = await pages(host, repository, repoRoot, `issues/${pr}/comments`, runPlatformRead);
			if (!value) return undefined;
			const comments = value.map(record);
			if (
				comments.some(
					(item) =>
						!item ||
						!Number.isSafeInteger(item.id) ||
						typeof item.body !== "string" ||
						typeof record(item.user)?.node_id !== "string",
				)
			)
				return undefined;
			return comments.map((item) => ({
				id: Number(item?.id),
				authorId: String(record(item?.user)?.node_id),
				body: String(item?.body),
			}));
		},
		async reread() {
			return (await reread()).snapshot;
		},
	};
}

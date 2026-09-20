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
export function activeRulesetApplies(detail: unknown, baseRef: string, defaultBranch: string): boolean {
	const ruleset = record(detail);
	if (!ruleset || ruleset.target !== "branch" || ruleset.enforcement !== "active") return false;
	const names = record(record(ruleset.conditions)?.ref_name);
	const subject = `refs/heads/${baseRef}`;
	const match = (pattern: unknown) =>
		pattern === "~DEFAULT_BRANCH" ? baseRef === defaultBranch : refPatternMatches(pattern, subject);
	const excluded = array(names?.exclude).map(match);
	if (excluded.some((item) => item !== false)) return false;
	const included = array(names?.include).map(match);
	return included.length > 0 && included.every((item) => item !== undefined) && included.some(Boolean);
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
	const active = details.filter(
		(item): item is Record<string, unknown> =>
			item !== undefined && activeRulesetApplies(item, baseRef, String(repo.default_branch)),
	);
	if (active.length !== 1)
		return { arm: active.length === 0 ? "predicate-ownership-unknown" : "predicate-ownership-multiple" };
	const owner = active[0];
	if (owner.source_type !== undefined && owner.source_type !== "Repository")
		return { arm: "predicate-ownership-inherited" };
	const pull = rule(owner, "pull_request");
	const pullParameters = record(pull?.parameters);
	const status = record(rule(owner, "required_status_checks")?.parameters);
	const contexts = array(status?.required_status_checks)
		.map(record)
		.map((item) => item?.context)
		.filter((item): item is string => typeof item === "string");
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
	const checks = newestCheckConclusions(checkRuns);
	if (!checks) return { arm: "check-rollup-ambiguous" };
	const successful = (name: string) => {
		const check = checks.get(name);
		return check?.status === "completed" && check.conclusion === "success";
	};
	const requiredChecks = contexts.every(successful)
		? "pass"
		: contexts.some((name) => checks.get(name)?.status !== "completed")
			? "pending"
			: "fail";
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
		(item) => item.state === "APPROVED" && item.commit_id === headSha && record(item.user)?.node_id !== author.node_id,
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
			judgeComplete: reviewRecord?.adjudication !== null && reviewRecord?.adjudication !== undefined,
			resolver,
			acCloseout: successful("ac-closeout"),
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

function mutationOk(value: string | undefined): boolean {
	return record(parse(value)) !== undefined;
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
			return mutationOk(value) || Array.isArray(parse(value)) ? "applied" : "unknown";
		},
		async comment(body) {
			return mutationOk(
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
			)
				? "published"
				: "unknown";
		},
		async readComments() {
			const value = await pages(host, repository, repoRoot, `issues/${pr}/comments`, runPlatformRead);
			return value?.map((item) => String(record(item)?.body ?? ""));
		},
		async reread() {
			return (await reread()).snapshot;
		},
	};
}

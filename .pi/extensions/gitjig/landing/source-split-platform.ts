/** Warning-surface roster: EXEMPT — platform values are consumed by closed records and fixed result arms. */
import { runPlatformRead } from "../platform/read.ts";
import { runPlatformJsonMutation, runPlatformMutation } from "../platform/write.ts";
import { type TopologySourceRefusalArm, topologySourceDigest } from "./source-split-contract.ts";
import {
	executeTopologySourceSplit,
	type TopologySourceAuthorization,
	type TopologySourceComment,
	type TopologySourceEffects,
	type TopologySourceInput,
	type TopologySourceResult,
} from "./source-split-service.ts";
import {
	loadTopologyAuthorization,
	parseTopologyAuthorization,
	TOPOLOGY_AUTHORIZATION_MARKER,
} from "./topology-authorization.ts";
import type { TopologyPlan, TopologyPlanningSnapshot } from "./topology-plan.ts";
import { loadTrustedTopologyEngine } from "./topology-provenance.ts";

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
export type SourcePlatformRead = (argv: string[], repoRoot: string) => Promise<string | undefined>;
export type SourcePlatformMutation = (argv: string[], repoRoot: string) => Promise<string | undefined>;
export type SourcePlatformJsonMutation = (
	argv: string[],
	body: unknown,
	repoRoot: string,
) => Promise<string | undefined>;

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
function comment(value: unknown): TopologySourceComment | undefined {
	const item = record(value);
	const author = record(item?.user);
	return item &&
		author &&
		typeof item.node_id === "string" &&
		Number.isSafeInteger(item.id) &&
		typeof author.node_id === "string" &&
		typeof item.created_at === "string" &&
		typeof item.updated_at === "string" &&
		typeof item.body === "string"
		? {
				nodeId: item.node_id,
				databaseId: Number(item.id),
				authorId: author.node_id,
				createdAt: item.created_at,
				updatedAt: item.updated_at,
				body: item.body,
			}
		: undefined;
}
function writableRuleset(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		["name", "target", "enforcement", "bypass_actors", "conditions", "rules"].map((key) => [key, value[key]]),
	);
}
type TopologyPlanner = (
	snapshot: TopologyPlanningSnapshot,
) => { ok: true; plan: TopologyPlan } | { ok: false; arm: string };
function observedShape(
	snapshot: TopologyPlanningSnapshot,
	plan: TopologyPlan,
	expected: unknown,
	planner: TopologyPlanner,
): unknown | undefined {
	if (
		!snapshot.complete ||
		snapshot.repositoryId !== plan.repositoryId ||
		snapshot.defaultBranch !== plan.defaultBranch ||
		snapshot.actorId !== plan.actorId ||
		snapshot.actorRole !== "admin"
	)
		return undefined;
	if (topologySourceDigest(expected) === topologySourceDigest(plan.before)) {
		const fresh = planner(snapshot);
		return fresh.ok ? fresh.plan.before : undefined;
	}
	const shape = record(expected);
	const before = record(plan.before);
	const original = Array.isArray(before?.rulesets) ? before.rulesets.map(record) : [];
	if (!shape || original.some((item) => item === undefined)) return undefined;
	const coreId = Number(plan.steps[0]?.path.split("/").at(-1));
	const humanStep = plan.steps[1];
	const retainedHumanId = humanStep?.method === "PATCH" ? Number(humanStep.path.split("/").at(-1)) : undefined;
	const deleteIds = plan.steps
		.filter((step) => step.method === "DELETE")
		.map((step) => Number(step.path.split("/").at(-1)));
	const absentThrough = "absentRulesetId" in shape ? deleteIds.indexOf(Number(shape.absentRulesetId)) : -1;
	const deleted = new Set(absentThrough >= 0 ? deleteIds.slice(0, absentThrough + 1) : []);
	const liveById = new Map(snapshot.rulesets.map((item) => [item.id, item]));
	for (const item of original as Record<string, unknown>[]) {
		const id = Number(item.id);
		if (id === coreId || (retainedHumanId !== undefined && id === retainedHumanId && "human" in shape)) continue;
		if (deleted.has(id)) {
			if (liveById.has(id)) return undefined;
		} else if (topologySourceDigest(liveById.get(id)) !== topologySourceDigest(item)) return undefined;
	}
	const allowedIds = new Set(original.map((item) => Number((item as Record<string, unknown>).id)));
	const added = snapshot.rulesets.filter((item) => !allowedIds.has(Number(item.id)));
	if (!("human" in shape) && added.length !== 0) return { unexpectedRulesetPopulation: true };
	if ("human" in shape && retainedHumanId !== undefined && added.length !== 0)
		return { unexpectedRulesetPopulation: true };
	if ("human" in shape && retainedHumanId === undefined && (added.length !== 1 || added[0]?.name !== "human-approval"))
		return { unexpectedRulesetPopulation: true };
	const result: Record<string, unknown> = {};
	if ("core" in shape) {
		const core = liveById.get(coreId);
		if (!core || core.name !== "core-governance") return undefined;
		result.core = writableRuleset(core);
	}
	if ("human" in shape) {
		const human = retainedHumanId === undefined ? added[0] : liveById.get(retainedHumanId);
		if (!human || human.name !== "human-approval") return undefined;
		if (snapshot.rulesets.filter((item) => item.name === "human-approval").length !== 1)
			return { unexpectedRulesetPopulation: true };
		result.human = writableRuleset(human);
	}
	if ("repositorySettings" in shape) result.repositorySettings = snapshot.repositorySettings;
	if ("absentRulesetId" in shape) {
		const id = Number(shape.absentRulesetId);
		if (snapshot.rulesets.some((item) => item.id === id)) return { ...result, presentRulesetId: id };
		result.absentRulesetId = id;
	}
	return result;
}
function mapAuthorizationArm(arm: string, hasCanonicalExpiry: boolean): TopologySourceRefusalArm {
	if (arm === "authorization-absent" || arm === "authorization-ambiguous") return arm;
	if (arm.includes("time") && hasCanonicalExpiry) return "authorization-stale";
	if (arm.includes("subject")) return "subject-invalid";
	if (arm.includes("population") || arm.includes("platform")) return "population-incomplete";
	return "authorization-unattested";
}

export interface LoadedTopologySource {
	input?: TopologySourceInput;
	effects?: TopologySourceEffects;
	arm: TopologySourceRefusalArm;
}

export async function loadTopologySourceApplication(
	host: string,
	repository: string,
	issueNumber: number,
	now: string,
	repoRoot: string,
	authorizedPlan: unknown = undefined,
	read: SourcePlatformRead = runPlatformRead,
	mutate: SourcePlatformMutation = runPlatformMutation,
	mutateJson: SourcePlatformJsonMutation = runPlatformJsonMutation,
): Promise<LoadedTopologySource> {
	if (!HOST.test(host) || !REPOSITORY.test(repository) || !Number.isSafeInteger(issueNumber) || issueNumber <= 0)
		return { arm: "subject-invalid" };
	const get = async (endpoint: string, paginate = false): Promise<unknown> => {
		const argv = ["api", "--hostname", host];
		if (paginate) argv.push("--paginate", "--slurp");
		argv.push(endpoint);
		return parse(await read(argv, repoRoot));
	};
	const [repositoryRaw, issueRaw, viewerRaw, commentPages] = await Promise.all([
		get(`repos/${repository}`),
		get(`repos/${repository}/issues/${issueNumber}`),
		get("user"),
		get(`repos/${repository}/issues/${issueNumber}/comments?per_page=100`, true),
	]);
	const repositoryRecord = record(repositoryRaw);
	const issue = record(issueRaw);
	const viewer = record(viewerRaw);
	if (
		!repositoryRecord ||
		!issue ||
		!viewer ||
		!Array.isArray(commentPages) ||
		commentPages.some((page) => !Array.isArray(page))
	)
		return { arm: "population-incomplete" };
	if (
		issue.state !== "open" ||
		issue.number !== issueNumber ||
		typeof issue.node_id !== "string" ||
		typeof viewer.node_id !== "string" ||
		typeof repositoryRecord.node_id !== "string" ||
		typeof repositoryRecord.default_branch !== "string"
	)
		return { arm: "subject-invalid" };
	const topologyBlob = record(
		await get(
			`repos/${repository}/contents/.github/workflows/landing-topology.mjs?ref=${encodeURIComponent(repositoryRecord.default_branch)}`,
		),
	);
	const topologyEngine = await loadTrustedTopologyEngine(repoRoot, topologyBlob?.sha);
	if (!topologyEngine) return { arm: "population-incomplete" };
	const { attestTopologyPlan, loadTopologyPlanningSnapshot, planSplitTopology } = await import("./topology-plan.ts");
	const snapshot = await loadTopologyPlanningSnapshot(host, repository, repoRoot, read);
	if (!snapshot) return { arm: "population-incomplete" };
	if (repositoryRecord.node_id !== snapshot.repositoryId) return { arm: "subject-invalid" };
	const comments = commentPages.flat().map(comment);
	if (comments.some((item) => item === undefined)) return { arm: "population-incomplete" };
	const planned = planSplitTopology(snapshot);
	if (!planned.ok) return { arm: "plan-invalid" };
	const applicationPlan = authorizedPlan === undefined ? planned.plan : authorizedPlan;
	if (!attestTopologyPlan(applicationPlan) || applicationPlan.stage !== "source-split") return { arm: "plan-invalid" };
	if (authorizedPlan === undefined && planned.plan.stage !== "source-split") return { arm: "plan-invalid" };
	const loadedAuthorization = await loadTopologyAuthorization(
		host,
		repository,
		issueNumber,
		now,
		topologyEngine,
		repoRoot,
		read,
	);
	let authorization: TopologySourceAuthorization;
	if (loadedAuthorization.ok) authorization = loadedAuthorization;
	else {
		const marked = (comments as TopologySourceComment[]).filter((item) =>
			item.body.includes(TOPOLOGY_AUTHORIZATION_MARKER),
		);
		const populationDigest = topologySourceDigest(
			marked.map((item) => [item.nodeId, item.body, item.createdAt, item.updatedAt]),
		);
		const candidate = marked.length === 1 ? marked[0] : undefined;
		const parsedCandidate = parseTopologyAuthorization(candidate?.body);
		const canonicalExpiry = topologyEngine.canonicalInstant(parsedCandidate?.expiresAt);
		const arm = mapAuthorizationArm(loadedAuthorization.arm, canonicalExpiry !== undefined);
		authorization =
			arm === "authorization-absent" || arm === "authorization-ambiguous"
				? { ok: false, arm, populationDigest }
				: {
						ok: false,
						arm,
						...(candidate ? { authorizationRecordId: candidate.nodeId } : {}),
						...(canonicalExpiry ? { expiresAt: canonicalExpiry } : {}),
						...(arm === "authorization-unattested" ? { populationDigest } : {}),
					};
	}
	const reloadSnapshot = async (): Promise<TopologyPlanningSnapshot | undefined> =>
		loadTopologyPlanningSnapshot(host, repository, repoRoot, read);
	const freshSnapshot = await reloadSnapshot();
	const freshPlanned = freshSnapshot ? planSplitTopology(freshSnapshot) : undefined;
	if (!freshPlanned?.ok) return { arm: "population-incomplete" };
	const freshPlan = freshPlanned.plan;
	const reloadComments = async (): Promise<readonly TopologySourceComment[] | undefined> => {
		const pages = await get(`repos/${repository}/issues/${issueNumber}/comments?per_page=100`, true);
		if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) return undefined;
		const loaded = pages.flat().map(comment);
		return loaded.some((item) => item === undefined) ? undefined : (loaded as TopologySourceComment[]);
	};
	let lastVerifiedSnapshotDigest: string | undefined;
	let mutationPending = false;
	const effects: TopologySourceEffects = {
		canonicalInstant: topologyEngine.canonicalInstant,
		attestPlan: attestTopologyPlan,
		appendAndRead: async (body) => {
			const raw = parse(
				await mutateJson(
					[
						"api",
						"--hostname",
						host,
						"--method",
						"POST",
						`repos/${repository}/issues/${issueNumber}/comments`,
						"--input",
						"-",
					],
					{ body },
					repoRoot,
				),
			);
			const written = comment(raw);
			return written ? comment(await get(`repos/${repository}/issues/comments/${written.databaseId}`)) : undefined;
		},
		readComments: reloadComments,
		readState: async (expected) => {
			const live = await reloadSnapshot();
			if (!live) return undefined;
			const liveDigest = topologySourceDigest({
				repositoryId: live.repositoryId,
				defaultBranch: live.defaultBranch,
				actorId: live.actorId,
				actorRole: live.actorRole,
				actionsIntegrationId: live.actionsIntegrationId,
				repositorySettings: live.repositorySettings,
				rulesets: live.rulesets,
			});
			if (!mutationPending && lastVerifiedSnapshotDigest && liveDigest !== lastVerifiedSnapshotDigest)
				return { drift: true };
			const observed = observedShape(live, applicationPlan, expected, planSplitTopology);
			if (observed !== undefined && topologySourceDigest(observed) === topologySourceDigest(expected))
				lastVerifiedSnapshotDigest = liveDigest;
			mutationPending = false;
			return observed;
		},
		mutate: async (step) => {
			const endpoint = step.path.replace(/^\//u, "");
			const argv = ["api", "--hostname", host, "--method", step.method, endpoint];
			const output =
				"body" in step
					? await mutateJson([...argv, "--input", "-"], step.body, repoRoot)
					: await mutate(argv, repoRoot);
			if (output === undefined) return { kind: "unknown" };
			mutationPending = true;
			return { kind: "written" };
		},
		auditFinal: async () => {
			const live = await reloadSnapshot();
			if (!live) return false;
			const final = planSplitTopology(live);
			return final.ok && final.plan.stage === "carrier-bootstrap";
		},
	};
	return {
		arm: "subject-invalid",
		input: {
			repositoryId: snapshot.repositoryId,
			issueId: issue.node_id,
			writerId: viewer.node_id,
			now,
			complete: snapshot.complete,
			plan: applicationPlan,
			freshPlan,
			authorization,
			comments: comments as TopologySourceComment[],
		},
		effects,
	};
}

export async function executePlatformTopologySource(loaded: LoadedTopologySource): Promise<TopologySourceResult> {
	return loaded.input && loaded.effects
		? executeTopologySourceSplit(loaded.input, loaded.effects)
		: { outcome: "refused", arm: loaded.arm };
}

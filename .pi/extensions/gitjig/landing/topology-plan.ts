/** Warning-surface roster: EXEMPT — closed data plans only; no command is executed or rendered to the model. */
import { createHash } from "node:crypto";
import {
	auditCoreRuleset,
	auditHumanApprovalRuleset,
	canonicalInstant,
} from "../../../../.github/workflows/landing-topology.mjs";
import { runPlatformRead } from "../platform/read.ts";
import { activeRulesetApplies } from "./platform.ts";

const KNOWN_RULESET_KEYS = new Set([
	"id",
	"name",
	"target",
	"source_type",
	"source",
	"enforcement",
	"bypass_actors",
	"conditions",
	"rules",
	"created_at",
	"updated_at",
	"current_user_can_bypass",
	"_links",
	"node_id",
]);
const CONTEXTS = [
	"fragment-gate",
	"ssot-home",
	"toc-freshness",
	"source-style",
	"type-check",
	"suite",
	"ac-closeout",
] as const;

export interface TopologyPlanningSnapshot {
	repositoryId: string;
	repositoryName: string;
	defaultBranch: string;
	actorId: string;
	actorRole: string;
	actionsIntegrationId: number;
	repositorySettings: { allow_merge_commit: boolean; allow_squash_merge: boolean; allow_rebase_merge: boolean };
	rulesets: readonly Record<string, unknown>[];
	complete: boolean;
	bypassSemantics: "assumption-unverified" | "verified";
}

export type TopologyRead = (argv: string[], repoRoot: string) => Promise<string | undefined>;

export interface TopologyPlan {
	schemaVersion: 1;
	authorized: false;
	assumption: "bypass-exemption-unverified";
	stage: "source-split" | "carrier-bootstrap";
	repositoryId: string;
	actorId: string;
	actorPermission: "admin";
	defaultBranch: string;
	before: unknown;
	optimisticRulesets: readonly { id: number; updatedAt: string }[];
	beforeDigest: string;
	desiredDigest: string;
	correlationId: string;
	artifactHash: string;
	steps: readonly {
		order: number;
		method: "PATCH" | "POST" | "DELETE";
		path: string;
		body?: unknown;
		postRead: unknown;
	}[];
	postconditions: unknown;
	rollback: readonly { method: "PATCH" | "POST" | "DELETE"; path: string; body?: unknown }[];
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
function digest(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}
export function topologyPlanArtifactHash(plan: Omit<TopologyPlan, "artifactHash">): string {
	return digest(plan);
}
export function attestTopologyPlan(value: unknown): value is TopologyPlan {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const plan = value as Record<string, unknown>;
	const keys = [
		"schemaVersion",
		"authorized",
		"assumption",
		"stage",
		"repositoryId",
		"actorId",
		"actorPermission",
		"defaultBranch",
		"before",
		"optimisticRulesets",
		"beforeDigest",
		"desiredDigest",
		"correlationId",
		"artifactHash",
		"steps",
		"postconditions",
		"rollback",
	];
	if (Object.keys(plan).length !== keys.length || Object.keys(plan).some((key) => !keys.includes(key))) return false;
	const hex = (item: unknown): item is string => typeof item === "string" && /^[0-9a-f]{64}$/u.test(item);
	if (
		plan.schemaVersion !== 1 ||
		plan.authorized !== false ||
		plan.assumption !== "bypass-exemption-unverified" ||
		!["source-split", "carrier-bootstrap"].includes(String(plan.stage)) ||
		![plan.repositoryId, plan.actorId, plan.defaultBranch].every(
			(item) => typeof item === "string" && item.length > 0,
		) ||
		plan.actorPermission !== "admin" ||
		!hex(plan.beforeDigest) ||
		!hex(plan.desiredDigest) ||
		!hex(plan.correlationId) ||
		!hex(plan.artifactHash) ||
		!Array.isArray(plan.optimisticRulesets) ||
		!Array.isArray(plan.steps) ||
		!Array.isArray(plan.rollback)
	)
		return false;
	if (
		plan.optimisticRulesets.some(
			(item) =>
				item === null ||
				typeof item !== "object" ||
				Array.isArray(item) ||
				!Number.isSafeInteger((item as Record<string, unknown>).id) ||
				!canonicalInstant((item as Record<string, unknown>).updatedAt),
		) ||
		plan.steps.some(
			(item, index) =>
				item === null ||
				typeof item !== "object" ||
				Array.isArray(item) ||
				(item as Record<string, unknown>).order !== index + 1 ||
				!["PATCH", "POST", "DELETE"].includes(String((item as Record<string, unknown>).method)) ||
				typeof (item as Record<string, unknown>).path !== "string" ||
				!("postRead" in item),
		) ||
		plan.rollback.some(
			(item) =>
				item === null ||
				typeof item !== "object" ||
				Array.isArray(item) ||
				!["PATCH", "POST", "DELETE"].includes(String((item as Record<string, unknown>).method)) ||
				typeof (item as Record<string, unknown>).path !== "string",
		)
	)
		return false;
	if (plan.beforeDigest !== digest(plan.before) || plan.desiredDigest !== digest(plan.postconditions)) return false;
	if (
		plan.correlationId !==
		digest({
			repositoryId: plan.repositoryId,
			actorId: plan.actorId,
			before: plan.beforeDigest,
			desired: plan.desiredDigest,
		})
	)
		return false;
	const { artifactHash, ...artifact } = plan as unknown as TopologyPlan;
	return artifactHash === topologyPlanArtifactHash(artifact);
}
function validName(value: string): boolean {
	return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}
function writableRuleset(detail: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		["name", "target", "enforcement", "bypass_actors", "conditions", "rules"].map((key) => [key, detail[key]]),
	);
}
function measurableConditions(detail: Record<string, unknown>): boolean {
	const conditions = detail.conditions as { ref_name?: { include?: unknown; exclude?: unknown } } | undefined;
	const include = conditions?.ref_name?.include;
	const exclude = conditions?.ref_name?.exclude;
	return (
		Array.isArray(include) &&
		Array.isArray(exclude) &&
		[...include, ...exclude].every(
			(pattern) => typeof pattern === "string" && (pattern === "~DEFAULT_BRANCH" || !/[[\]{}\\]/u.test(pattern)),
		)
	);
}
function applies(detail: Record<string, unknown>, defaultBranch: string): boolean {
	return (
		detail.enforcement === "active" &&
		measurableConditions(detail) &&
		activeRulesetApplies(detail, defaultBranch, defaultBranch)
	);
}

export function desiredCoreRuleset(actionsIntegrationId: number): Record<string, unknown> {
	return {
		name: "core-governance",
		target: "branch",
		enforcement: "active",
		bypass_actors: [],
		conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
		rules: [
			{
				type: "pull_request",
				parameters: {
					required_approving_review_count: 0,
					dismiss_stale_reviews_on_push: true,
					required_reviewers: [],
					require_code_owner_review: false,
					require_last_push_approval: false,
					required_review_thread_resolution: true,
					require_extra_approval_for_unattributed_changes: false,
					allowed_merge_methods: ["merge"],
				},
			},
			{
				type: "required_status_checks",
				parameters: {
					strict_required_status_checks_policy: true,
					do_not_enforce_on_create: false,
					required_status_checks: CONTEXTS.map((context) => ({ context, integration_id: actionsIntegrationId })),
				},
			},
			{ type: "non_fast_forward" },
			{ type: "deletion" },
		],
	};
}

export function desiredHumanApprovalRuleset(): Record<string, unknown> {
	return {
		name: "human-approval",
		target: "branch",
		enforcement: "active",
		bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }],
		conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
		rules: [
			{
				type: "pull_request",
				parameters: {
					required_approving_review_count: 1,
					dismiss_stale_reviews_on_push: false,
					required_reviewers: [],
					require_code_owner_review: false,
					require_last_push_approval: false,
					required_review_thread_resolution: false,
					require_extra_approval_for_unattributed_changes: false,
					allowed_merge_methods: ["merge", "squash", "rebase"],
				},
			},
		],
	};
}

function parse(value: string | undefined): unknown {
	if (value === undefined) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

/** Read every planning operand through GET-only platform calls. */
export async function loadTopologyPlanningSnapshot(
	host: string,
	repositoryName: string,
	repoRoot: string,
	read: TopologyRead = runPlatformRead,
): Promise<TopologyPlanningSnapshot | undefined> {
	if (!/^[a-z0-9.-]+$/.test(host) || !validName(repositoryName)) return undefined;
	const get = (path: string) => read(["api", "--hostname", host, path], repoRoot);
	const [repositoryRaw, userRaw, appRaw, pagesRaw] = await Promise.all([
		get(`repos/${repositoryName}`),
		get("user"),
		get("apps/github-actions"),
		read(
			[
				"api",
				"--hostname",
				host,
				"--paginate",
				"--slurp",
				`repos/${repositoryName}/rulesets?includes_parents=true&per_page=100`,
			],
			repoRoot,
		),
	]);
	const repository = parse(repositoryRaw) as Record<string, unknown> | undefined;
	const user = parse(userRaw) as Record<string, unknown> | undefined;
	const app = parse(appRaw) as Record<string, unknown> | undefined;
	const pages = parse(pagesRaw);
	if (!repository || !user || !app || !Array.isArray(pages) || !pages.every(Array.isArray)) return undefined;
	const summaries = pages.flat() as Record<string, unknown>[];
	if (summaries.some((entry) => !Number.isSafeInteger(entry?.id))) return undefined;
	const details = await Promise.all(
		summaries.map((entry) => get(`repos/${repositoryName}/rulesets/${String(entry.id)}`)),
	);
	const rulesets = details.map(parse);
	if (
		rulesets.some((entry) => entry === undefined || entry === null || typeof entry !== "object" || Array.isArray(entry))
	)
		return undefined;
	const login = user.login;
	if (typeof login !== "string" || !login) return undefined;
	const permission = parse(
		await get(`repos/${repositoryName}/collaborators/${encodeURIComponent(login)}/permission`),
	) as Record<string, unknown> | undefined;
	if (!permission) return undefined;
	return {
		repositoryId: String(repository.node_id ?? ""),
		repositoryName,
		defaultBranch: String(repository.default_branch ?? ""),
		actorId: String(user.node_id ?? ""),
		actorRole: String(permission.role_name ?? ""),
		actionsIntegrationId: Number(app.id),
		repositorySettings: {
			allow_merge_commit: repository.allow_merge_commit === true,
			allow_squash_merge: repository.allow_squash_merge === true,
			allow_rebase_merge: repository.allow_rebase_merge === true,
		},
		rulesets: rulesets as Record<string, unknown>[],
		complete: true,
		bypassSemantics: "assumption-unverified",
	};
}

/** Produce data-only operator calls. This module deliberately exports no executor. */
export function planSplitTopology(
	snapshot: TopologyPlanningSnapshot,
): { ok: true; plan: TopologyPlan } | { ok: false; arm: string } {
	if (!snapshot.complete) return { ok: false, arm: "population-incomplete" };
	if (!snapshot.repositoryId || !validName(snapshot.repositoryName) || !snapshot.defaultBranch || !snapshot.actorId)
		return { ok: false, arm: "subject-invalid" };
	if (snapshot.actorRole.toLowerCase() !== "admin") return { ok: false, arm: "operator-not-admin" };
	if (!Number.isSafeInteger(snapshot.actionsIntegrationId) || snapshot.actionsIntegrationId <= 0)
		return { ok: false, arm: "actions-integration-unavailable" };
	if (
		!Array.isArray(snapshot.rulesets) ||
		snapshot.rulesets.some((rule) => !Number.isSafeInteger(rule.id) || !canonicalInstant(rule.updated_at))
	)
		return { ok: false, arm: "ruleset-unmeasurable" };
	if (snapshot.rulesets.some((rule) => Object.keys(rule).some((key) => !KNOWN_RULESET_KEYS.has(key))))
		return { ok: false, arm: "ruleset-unknown-field" };
	const observedRulesets = snapshot.rulesets.map((rule) => ({
		...rule,
		updated_at: canonicalInstant(rule.updated_at) as string,
	}));
	if (
		observedRulesets.some(
			(rule) => rule.target === "branch" && rule.enforcement === "active" && !measurableConditions(rule),
		)
	)
		return { ok: false, arm: "ruleset-condition-unmeasurable" };
	const applicable = observedRulesets.filter((rule) => applies(rule, snapshot.defaultBranch));
	if (applicable.some((rule) => rule.source_type === "Organization")) return { ok: false, arm: "inherited-ruleset" };
	const exactCore = applicable.filter((rule) => auditCoreRuleset(rule, snapshot.actionsIntegrationId).ok);
	const nonHuman = applicable.filter((rule) => rule.name !== "human-approval");
	const current = exactCore.length === 1 ? exactCore : nonHuman.length === 1 ? nonHuman : [];
	if (current.length !== 1) return { ok: false, arm: "core-candidate-ambiguous" };
	const humans = applicable.filter((rule) => rule.name === "human-approval");
	if (humans.length > 1) return { ok: false, arm: "human-candidate-ambiguous" };
	const coreId = Number(current[0].id);
	const core = desiredCoreRuleset(snapshot.actionsIntegrationId);
	const human = desiredHumanApprovalRuleset();
	const repositorySettings = { allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false };
	const retainedHuman = humans[0];
	const duplicateIds = applicable
		.filter((rule) => Number(rule.id) !== coreId && rule !== retainedHuman)
		.map((rule) => Number(rule.id));
	const humanMethod = retainedHuman ? "PATCH" : "POST";
	const humanPath = retainedHuman
		? `/repos/${snapshot.repositoryName}/rulesets/${Number(retainedHuman.id)}`
		: `/repos/${snapshot.repositoryName}/rulesets`;
	const steps: TopologyPlan["steps"] = [
		{
			order: 1,
			method: "PATCH",
			path: `/repos/${snapshot.repositoryName}/rulesets/${coreId}`,
			body: core,
			postRead: { core },
		},
		{ order: 2, method: humanMethod, path: humanPath, body: human, postRead: { core, human } },
		{
			order: 3,
			method: "PATCH",
			path: `/repos/${snapshot.repositoryName}`,
			body: repositorySettings,
			postRead: { core, human, repositorySettings },
		},
		...duplicateIds.map((id, index) => ({
			order: index + 4,
			method: "DELETE" as const,
			path: `/repos/${snapshot.repositoryName}/rulesets/${id}`,
			postRead: { core, human, repositorySettings, absentRulesetId: id },
		})),
	];
	const desired = { core, human, repositorySettings };
	const before = { repositorySettings: snapshot.repositorySettings, rulesets: observedRulesets };
	const postSplit =
		auditCoreRuleset(current[0], snapshot.actionsIntegrationId).ok &&
		retainedHuman !== undefined &&
		auditHumanApprovalRuleset(retainedHuman).ok &&
		snapshot.repositorySettings.allow_merge_commit === true &&
		snapshot.repositorySettings.allow_squash_merge === false &&
		snapshot.repositorySettings.allow_rebase_merge === false;
	const artifact: Omit<TopologyPlan, "artifactHash"> = {
		schemaVersion: 1,
		authorized: false,
		assumption: "bypass-exemption-unverified",
		stage: postSplit ? "carrier-bootstrap" : "source-split",
		repositoryId: snapshot.repositoryId,
		actorId: snapshot.actorId,
		actorPermission: "admin",
		defaultBranch: snapshot.defaultBranch,
		before,
		optimisticRulesets: observedRulesets.map((rule) => ({
			id: Number(rule.id),
			updatedAt: canonicalInstant(rule.updated_at) as string,
		})),
		beforeDigest: digest(before),
		desiredDigest: digest(desired),
		correlationId: digest({
			repositoryId: snapshot.repositoryId,
			actorId: snapshot.actorId,
			before: digest(before),
			desired: digest(desired),
		}),
		steps,
		postconditions: desired,
		rollback: [
			...duplicateIds.map((id) => ({
				method: "POST" as const,
				path: `/repos/${snapshot.repositoryName}/rulesets`,
				body: writableRuleset(observedRulesets.find((rule) => Number(rule.id) === id) as Record<string, unknown>),
			})),
			{ method: "PATCH", path: `/repos/${snapshot.repositoryName}`, body: snapshot.repositorySettings },
			retainedHuman
				? {
						method: "PATCH",
						path: `/repos/${snapshot.repositoryName}/rulesets/${Number(retainedHuman.id)}`,
						body: writableRuleset(retainedHuman),
					}
				: {
						method: "DELETE",
						path: `/repos/${snapshot.repositoryName}/rulesets/{step-2-response-id}`,
					},
			{
				method: "PATCH",
				path: `/repos/${snapshot.repositoryName}/rulesets/${coreId}`,
				body: writableRuleset(current[0]),
			},
		],
	};
	return { ok: true, plan: { ...artifact, artifactHash: topologyPlanArtifactHash(artifact) } };
}

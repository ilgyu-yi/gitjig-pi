/** Self-standing split-landing topology schema and live-shape auditor. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const CONTEXTS = ["fragment-gate", "ssot-home", "toc-freshness", "source-style", "type-check", "suite", "ac-closeout"];

/** @param {any} value @param {readonly string[]} keys */
function closed(value, keys) {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		Object.keys(value).every((key) => keys.includes(key))
	);
}
/** @param {any} value */
function positive(value) {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

/** Reject sub-millisecond precision; normalize equivalent offset spellings to UTC. @param {any} value */
export function canonicalInstant(value) {
	if (typeof value !== "string" || !ISO_INSTANT.test(value)) return undefined;
	const time = Date.parse(value);
	return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** @param {any} value @returns {{ok:true,value:Record<string,any>}|{ok:false,arm:string}} */
export function parseLandingTopology(value) {
	const keys = [
		"schemaVersion",
		"phase",
		"repositoryId",
		"coreRulesetId",
		"humanApprovalRulesetId",
		"coreRulesetUpdatedAt",
		"humanApprovalRulesetUpdatedAt",
		"activatedAt",
	];
	if (!closed(value, keys)) return { ok: false, arm: "topology-schema" };
	const record = /** @type {Record<string, unknown>} */ (value);
	const coreUpdated = canonicalInstant(record.coreRulesetUpdatedAt);
	const humanUpdated = canonicalInstant(record.humanApprovalRulesetUpdatedAt);
	const activated = canonicalInstant(record.activatedAt);
	if (
		record.schemaVersion !== 1 ||
		record.phase !== 4 ||
		typeof record.repositoryId !== "string" ||
		record.repositoryId.length === 0 ||
		!positive(record.coreRulesetId) ||
		!positive(record.humanApprovalRulesetId) ||
		!coreUpdated ||
		!humanUpdated ||
		!activated
	)
		return { ok: false, arm: "topology-schema" };
	if (Date.parse(activated) < Date.parse(coreUpdated) || Date.parse(activated) < Date.parse(humanUpdated))
		return { ok: false, arm: "topology-activation-stale" };
	return {
		ok: true,
		value: {
			...record,
			coreRulesetUpdatedAt: coreUpdated,
			humanApprovalRulesetUpdatedAt: humanUpdated,
			activatedAt: activated,
		},
	};
}

/** @param {any} value */
function condition(value) {
	return (
		closed(value, ["ref_name"]) &&
		closed(value.ref_name, ["include", "exclude"]) &&
		Array.isArray(value.ref_name.include) &&
		value.ref_name.include.length === 1 &&
		value.ref_name.include[0] === "~DEFAULT_BRANCH" &&
		Array.isArray(value.ref_name.exclude) &&
		value.ref_name.exclude.length === 0
	);
}
/** @param {any} value */
function pullParameters(value) {
	return closed(value, [
		"required_approving_review_count",
		"dismiss_stale_reviews_on_push",
		"required_reviewers",
		"require_code_owner_review",
		"require_last_push_approval",
		"required_review_thread_resolution",
		"require_extra_approval_for_unattributed_changes",
		"allowed_merge_methods",
	]);
}
/** @param {any} value */
function rulesetEnvelope(value) {
	const allowed = new Set([
		"id",
		"node_id",
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
	]);
	return (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		[
			"id",
			"name",
			"target",
			"source_type",
			"source",
			"enforcement",
			"bypass_actors",
			"conditions",
			"rules",
			"updated_at",
		].every((key) => Object.hasOwn(value, key)) &&
		Object.keys(value).every((key) => allowed.has(key))
	);
}
/** @param {any} value */
function ruleMap(value) {
	if (!Array.isArray(value)) return undefined;
	const map = new Map();
	for (const rule of value) {
		if (!rule || typeof rule !== "object" || Array.isArray(rule) || typeof rule.type !== "string" || map.has(rule.type))
			return undefined;
		map.set(rule.type, rule);
	}
	return map;
}
/** @param {any} detail @param {number} actionsIntegrationId @returns {{ok:true}|{ok:false,arm:string}} */
export function auditCoreRuleset(detail, actionsIntegrationId) {
	if (
		!rulesetEnvelope(detail) ||
		detail.name !== "core-governance" ||
		detail.target !== "branch" ||
		detail.source_type !== "Repository" ||
		detail.enforcement !== "active" ||
		!Array.isArray(detail.bypass_actors) ||
		detail.bypass_actors.length !== 0 ||
		!condition(detail.conditions) ||
		!canonicalInstant(detail.updated_at)
	)
		return { ok: false, arm: "core-shape" };
	const rules = ruleMap(detail.rules);
	if (
		!rules ||
		rules.size !== 4 ||
		!rules.has("pull_request") ||
		!rules.has("required_status_checks") ||
		!rules.has("non_fast_forward") ||
		!rules.has("deletion")
	)
		return { ok: false, arm: "core-rules" };
	const pull = rules.get("pull_request");
	const parameters = pull?.parameters;
	if (
		!pullParameters(parameters) ||
		parameters.required_approving_review_count !== 0 ||
		parameters.dismiss_stale_reviews_on_push !== true ||
		parameters.required_reviewers.length !== 0 ||
		parameters.require_code_owner_review !== false ||
		parameters.require_last_push_approval !== false ||
		parameters.required_review_thread_resolution !== true ||
		parameters.require_extra_approval_for_unattributed_changes !== false ||
		JSON.stringify(parameters.allowed_merge_methods) !== JSON.stringify(["merge"])
	)
		return { ok: false, arm: "core-pull-request" };
	const status = rules.get("required_status_checks")?.parameters;
	if (
		!closed(status, ["strict_required_status_checks_policy", "do_not_enforce_on_create", "required_status_checks"]) ||
		status.strict_required_status_checks_policy !== true ||
		status.do_not_enforce_on_create !== false ||
		!Array.isArray(status.required_status_checks)
	)
		return { ok: false, arm: "core-contexts" };
	const contexts = status.required_status_checks.map(
		/** @param {any} entry */ (entry) =>
			closed(entry, ["context", "integration_id"]) && entry.integration_id === actionsIntegrationId
				? entry.context
				: undefined,
	);
	if (JSON.stringify(contexts) !== JSON.stringify(CONTEXTS)) return { ok: false, arm: "core-contexts" };
	return { ok: true };
}

/** @param {any} detail @returns {{ok:true}|{ok:false,arm:string}} */
export function auditHumanApprovalRuleset(detail) {
	if (
		!rulesetEnvelope(detail) ||
		detail.name !== "human-approval" ||
		detail.target !== "branch" ||
		detail.source_type !== "Repository" ||
		detail.enforcement !== "active" ||
		!condition(detail.conditions) ||
		!canonicalInstant(detail.updated_at)
	)
		return { ok: false, arm: "human-shape" };
	if (
		!Array.isArray(detail.bypass_actors) ||
		detail.bypass_actors.length !== 1 ||
		!closed(detail.bypass_actors[0], ["actor_id", "actor_type", "bypass_mode"]) ||
		detail.bypass_actors[0].actor_id !== 5 ||
		detail.bypass_actors[0].actor_type !== "RepositoryRole" ||
		detail.bypass_actors[0].bypass_mode !== "pull_request"
	)
		return { ok: false, arm: "human-bypass" };
	const rules = ruleMap(detail.rules);
	if (!rules || rules.size !== 1 || !rules.has("pull_request")) return { ok: false, arm: "human-rules" };
	const parameters = rules.get("pull_request")?.parameters;
	if (
		!pullParameters(parameters) ||
		parameters.required_approving_review_count !== 1 ||
		parameters.dismiss_stale_reviews_on_push !== false ||
		parameters.required_reviewers.length !== 0 ||
		parameters.require_code_owner_review !== false ||
		parameters.require_last_push_approval !== false ||
		parameters.required_review_thread_resolution !== false ||
		parameters.require_extra_approval_for_unattributed_changes !== false ||
		JSON.stringify(parameters.allowed_merge_methods) !== JSON.stringify(["merge", "squash", "rebase"])
	)
		return { ok: false, arm: "human-pull-request" };
	return { ok: true };
}

/** @param {any} topology @param {{repositoryId:string,core:any,human:any,actionsIntegrationId:number}} live @returns {{ok:true,value:Record<string,any>}|{ok:false,arm:string}} */
export function attestLandingTopology(topology, live) {
	const parsed = parseLandingTopology(topology);
	if (!parsed.ok) return parsed;
	if (!live || typeof live.repositoryId !== "string" || !positive(live.actionsIntegrationId))
		return { ok: false, arm: "topology-live-unavailable" };
	const core = auditCoreRuleset(live.core, live.actionsIntegrationId);
	if (!core.ok) return core;
	const human = auditHumanApprovalRuleset(live.human);
	if (!human.ok) return human;
	const value = parsed.value;
	return value.repositoryId === live.repositoryId &&
		value.coreRulesetId === live.core.id &&
		value.humanApprovalRulesetId === live.human.id &&
		value.coreRulesetUpdatedAt === canonicalInstant(live.core.updated_at) &&
		value.humanApprovalRulesetUpdatedAt === canonicalInstant(live.human.updated_at)
		? { ok: true, value }
		: { ok: false, arm: "topology-live-mismatch" };
}

/** @param {any} value */
export function encodeLandingTopology(value) {
	const parsed = parseLandingTopology(value);
	if (!parsed.ok) return undefined;
	const record = parsed.value;
	return `${JSON.stringify(
		{
			schemaVersion: record.schemaVersion,
			phase: record.phase,
			repositoryId: record.repositoryId,
			coreRulesetId: record.coreRulesetId,
			coreRulesetUpdatedAt: record.coreRulesetUpdatedAt,
			humanApprovalRulesetId: record.humanApprovalRulesetId,
			humanApprovalRulesetUpdatedAt: record.humanApprovalRulesetUpdatedAt,
			activatedAt: record.activatedAt,
		},
		null,
		"\t",
	)}\n`;
}

export const REQUIRED_CORE_CONTEXTS = Object.freeze([...CONTEXTS]);

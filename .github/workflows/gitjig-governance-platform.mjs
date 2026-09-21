import {
	CAPABILITIES,
	canonicalJson,
	parseGovernanceConfig,
	parseMeasuredGovernance,
	transitionMeasuredGovernance,
} from "./gitjig-governance.mjs";

export class GovernancePlatformRefusal extends Error {
	/** @param {string} arm */
	constructor(arm) {
		super(`governance platform refused: ${arm}`);
		this.arm = arm;
	}
}

/** @param {unknown} value */
function positive(value) {
	return Number.isSafeInteger(value) && Number(value) > 0;
}
/** @param {any[]} values @param {(value:any)=>unknown} identity */
function unique(values, identity) {
	return new Set(values.map(identity)).size === values.length;
}
/** @param {(method:string,path:string,body?:unknown)=>Promise<any>} request @param {string} path */
async function pages(request, path) {
	const out = [];
	for (let page = 1; page <= 100; page++) {
		const separator = path.includes("?") ? "&" : "?";
		const value = await request("GET", `${path}${separator}per_page=100&page=${page}`);
		if (!Array.isArray(value)) throw new GovernancePlatformRefusal("pagination-shape");
		out.push(...value);
		if (value.length < 100) return out;
	}
	throw new GovernancePlatformRefusal("pagination-bound");
}

/** @param {any} detail */
function normalizeRuleset(detail) {
	if (
		!positive(detail?.id) ||
		typeof detail.name !== "string" ||
		detail.target !== "branch" ||
		detail.source_type !== "Repository" ||
		typeof detail.source !== "string" ||
		!["active", "evaluate", "disabled"].includes(detail.enforcement) ||
		!Array.isArray(detail.bypass_actors) ||
		!Array.isArray(detail.rules) ||
		!detail.conditions?.ref_name ||
		!Array.isArray(detail.conditions.ref_name.include) ||
		!Array.isArray(detail.conditions.ref_name.exclude)
	)
		throw new GovernancePlatformRefusal("ruleset-shape");
	if (!unique(detail.bypass_actors, (actor) => `${actor?.actor_type}:${actor?.actor_id}:${actor?.bypass_mode}`))
		throw new GovernancePlatformRefusal("bypass-duplicate");
	const bypass = detail.bypass_actors.map(
		/** @param {any} actor */ (actor) => {
			if (
				!positive(actor?.actor_id) ||
				!["RepositoryRole", "Team", "Integration"].includes(actor?.actor_type) ||
				!["always", "pull_request"].includes(actor?.bypass_mode)
			)
				throw new GovernancePlatformRefusal("bypass-shape");
			return { actorId: actor.actor_id, actorType: actor.actor_type, bypassMode: actor.bypass_mode };
		},
	);
	if (!unique(detail.rules, /** @param {any} rule */ (rule) => rule?.type))
		throw new GovernancePlatformRefusal("rule-duplicate");
	const known = new Set([
		"pull_request",
		"required_status_checks",
		"deletion",
		"non_fast_forward",
		"required_linear_history",
	]);
	if (detail.rules.some(/** @param {any} rule */ (rule) => !known.has(rule?.type)))
		throw new GovernancePlatformRefusal("rule-unsupported");
	const rules = new Map(detail.rules.map(/** @param {any} rule */ (rule) => [rule.type, rule]));
	const pull = rules.get("pull_request")?.parameters;
	const status = rules.get("required_status_checks")?.parameters;
	const pullDefaults = {
		allowedMergeMethods: [],
		requiredApprovingReviews: 0,
		dismissStaleReviews: false,
		requiredReviewers: [],
		codeOwnerReview: false,
		lastPushApproval: false,
		reviewThreadResolution: false,
		extraApprovalForUnattributedChanges: false,
	};
	if (pull) {
		if (
			!Array.isArray(pull.allowed_merge_methods) ||
			!Number.isSafeInteger(pull.required_approving_review_count) ||
			!Array.isArray(pull.required_reviewers) ||
			[
				"dismiss_stale_reviews_on_push",
				"require_code_owner_review",
				"require_last_push_approval",
				"required_review_thread_resolution",
				"require_extra_approval_for_unattributed_changes",
			].some((key) => typeof pull[key] !== "boolean")
		)
			throw new GovernancePlatformRefusal("pull-parameters");
		Object.assign(pullDefaults, {
			allowedMergeMethods: pull.allowed_merge_methods,
			requiredApprovingReviews: pull.required_approving_review_count,
			dismissStaleReviews: pull.dismiss_stale_reviews_on_push,
			requiredReviewers: pull.required_reviewers.map(
				/** @param {any} reviewer */ (reviewer) => {
					if (
						!positive(reviewer?.actor_id) ||
						!["RepositoryRole", "Team", "Integration"].includes(reviewer?.actor_type)
					)
						throw new GovernancePlatformRefusal("reviewer-shape");
					return { actorId: reviewer.actor_id, actorType: reviewer.actor_type };
				},
			),
			codeOwnerReview: pull.require_code_owner_review,
			lastPushApproval: pull.require_last_push_approval,
			reviewThreadResolution: pull.required_review_thread_resolution,
			extraApprovalForUnattributedChanges: pull.require_extra_approval_for_unattributed_changes,
		});
	}
	const statusDefaults = { strictRequiredStatusChecks: false, doNotEnforceOnCreate: false, requiredStatusChecks: [] };
	if (status) {
		if (
			typeof status.strict_required_status_checks_policy !== "boolean" ||
			typeof status.do_not_enforce_on_create !== "boolean" ||
			!Array.isArray(status.required_status_checks)
		)
			throw new GovernancePlatformRefusal("status-parameters");
		Object.assign(statusDefaults, {
			strictRequiredStatusChecks: status.strict_required_status_checks_policy,
			doNotEnforceOnCreate: status.do_not_enforce_on_create,
			requiredStatusChecks: status.required_status_checks.map(
				/** @param {any} check */ (check) => {
					if (typeof check?.context !== "string" || check.context.length === 0)
						throw new GovernancePlatformRefusal("check-shape");
					if (check.integration_id !== undefined && check.integration_id !== null && !positive(check.integration_id))
						throw new GovernancePlatformRefusal("check-shape");
					return { context: check.context, integrationId: check.integration_id ?? null };
				},
			),
		});
	}
	return {
		meta: {
			id: detail.id,
			name: detail.name,
			target: detail.target,
			sourceType: detail.source_type,
			source: detail.source,
			include: detail.conditions.ref_name.include,
			exclude: detail.conditions.ref_name.exclude,
			ruleTypes: detail.rules.map(/** @param {any} rule */ (rule) => rule.type),
		},
		capabilities: {
			rulesetEnforcement: detail.enforcement,
			administratorBypass: bypass,
			...pullDefaults,
			...statusDefaults,
			deletionProtection: rules.has("deletion"),
			nonFastForwardProtection: rules.has("non_fast_forward"),
			requiredLinearHistory: rules.has("required_linear_history"),
		},
	};
}

/** @param {unknown} configInput @param {(method:string,path:string,body?:unknown)=>Promise<any>} request */
export function createGovernancePlatform(configInput, request) {
	const config = parseGovernanceConfig(configInput);
	const repositoryPath = `repos/${config.repository.nameWithOwner}`;
	const headPath = `${repositoryPath}/git/ref/heads/${encodeURIComponent(config.repository.defaultBranch)}`;
	const readHead = async () => {
		const value = await request("GET", headPath);
		if (
			value?.ref !== `refs/heads/${config.repository.defaultBranch}` ||
			value?.object?.type !== "commit" ||
			!/^[0-9a-f]{40}$/.test(value?.object?.sha ?? "")
		)
			throw new GovernancePlatformRefusal("default-head-shape");
		return value.object.sha;
	};
	const readMeasured = async () => {
		const beforeHead = await readHead();
		const repository = await request("GET", repositoryPath);
		if (
			repository?.node_id !== config.repository.id ||
			repository?.full_name !== config.repository.nameWithOwner ||
			repository?.default_branch !== config.repository.defaultBranch ||
			[repository.allow_merge_commit, repository.allow_squash_merge, repository.allow_rebase_merge].some(
				(value) => typeof value !== "boolean",
			)
		)
			throw new GovernancePlatformRefusal("repository-shape");
		const summaries = await pages(request, `${repositoryPath}/rulesets?includes_parents=true`);
		if (
			summaries.some(
				(summary) =>
					!positive(summary?.id) ||
					typeof summary?.name !== "string" ||
					summary.name.length === 0 ||
					!["Repository", "Organization", "Enterprise"].includes(summary?.source_type),
			)
		)
			throw new GovernancePlatformRefusal("ruleset-summary-shape");
		if (!unique(summaries, (summary) => summary.id) || !unique(summaries, (summary) => summary.name))
			throw new GovernancePlatformRefusal("ruleset-duplicate");
		if (summaries.some((summary) => summary.source_type !== "Repository"))
			throw new GovernancePlatformRefusal("ruleset-inherited");
		if (summaries.length !== 1) throw new GovernancePlatformRefusal("ruleset-population");
		const detail = await request("GET", `${repositoryPath}/rulesets/${summaries[0].id}`);
		if (detail?.id !== summaries[0].id || detail?.name !== summaries[0].name)
			throw new GovernancePlatformRefusal("ruleset-detail-identity");
		const normalized = normalizeRuleset(detail);
		if (normalized.meta.sourceType !== "Repository" || normalized.meta.source !== config.repository.nameWithOwner)
			throw new GovernancePlatformRefusal("ruleset-source");
		const capabilities = {
			mergeCommits: repository.allow_merge_commit,
			squashMerging: repository.allow_squash_merge,
			rebaseMerging: repository.allow_rebase_merge,
			...normalized.capabilities,
		};
		if (Object.keys(capabilities).length !== CAPABILITIES.length)
			throw new GovernancePlatformRefusal("capability-population");
		const afterHead = await readHead();
		if (beforeHead !== afterHead) throw new GovernancePlatformRefusal("default-head-drift");
		return parseMeasuredGovernance({
			schemaVersion: 2,
			repository: {
				id: repository.node_id,
				nameWithOwner: repository.full_name,
				defaultBranch: repository.default_branch,
				defaultBranchSha: beforeHead,
			},
			rulesets: [normalized.meta],
			capabilities,
		});
	};
	const writeOperation = async (/** @type {any} */ operation, /** @type {unknown} */ expectedInput) => {
		let current;
		try {
			current = await readMeasured();
		} catch (error) {
			return {
				outcome: /** @type {const} */ ("refused"),
				arm: error instanceof GovernancePlatformRefusal ? "compare-read-invalid" : "compare-read-unavailable",
				current: null,
			};
		}
		let expected;
		let expectedAfter;
		try {
			expected = parseMeasuredGovernance(expectedInput);
			expectedAfter = transitionMeasuredGovernance(expected, operation);
		} catch {
			return { outcome: /** @type {const} */ ("refused"), arm: "payload-refused", current };
		}
		if (canonicalJson(current) !== canonicalJson(expected))
			return { outcome: /** @type {const} */ ("refused"), arm: "operand-drift", current };

		const setting = /** @type {Record<string,string>} */ ({
			mergeCommits: "allow_merge_commit",
			squashMerging: "allow_squash_merge",
			rebaseMerging: "allow_rebase_merge",
		})[operation.capability];
		if (setting) {
			try {
				await request("PATCH", repositoryPath, { [setting]: operation.after });
				return { outcome: /** @type {const} */ ("acknowledged") };
			} catch {
				return { outcome: /** @type {const} */ ("unknown") };
			}
		}

		const next = expectedAfter.capabilities;
		const rules = [];
		if (
			next.allowedMergeMethods.length > 0 ||
			next.requiredApprovingReviews > 0 ||
			next.dismissStaleReviews ||
			next.requiredReviewers.length > 0 ||
			next.codeOwnerReview ||
			next.lastPushApproval ||
			next.reviewThreadResolution ||
			next.extraApprovalForUnattributedChanges
		)
			rules.push({
				type: "pull_request",
				parameters: {
					allowed_merge_methods: next.allowedMergeMethods,
					required_approving_review_count: next.requiredApprovingReviews,
					dismiss_stale_reviews_on_push: next.dismissStaleReviews,
					required_reviewers: next.requiredReviewers.map(
						/** @param {any} reviewer */ (reviewer) => ({
							actor_id: reviewer.actorId,
							actor_type: reviewer.actorType,
						}),
					),
					require_code_owner_review: next.codeOwnerReview,
					require_last_push_approval: next.lastPushApproval,
					required_review_thread_resolution: next.reviewThreadResolution,
					require_extra_approval_for_unattributed_changes: next.extraApprovalForUnattributedChanges,
				},
			});
		if (next.strictRequiredStatusChecks || next.doNotEnforceOnCreate || next.requiredStatusChecks.length > 0)
			rules.push({
				type: "required_status_checks",
				parameters: {
					strict_required_status_checks_policy: next.strictRequiredStatusChecks,
					do_not_enforce_on_create: next.doNotEnforceOnCreate,
					required_status_checks: next.requiredStatusChecks.map(
						/** @param {any} check */ (check) =>
							check.integrationId === null
								? { context: check.context }
								: { context: check.context, integration_id: check.integrationId },
					),
				},
			});
		if (next.deletionProtection) rules.push({ type: "deletion" });
		if (next.nonFastForwardProtection) rules.push({ type: "non_fast_forward" });
		if (next.requiredLinearHistory) rules.push({ type: "required_linear_history" });
		const metadata = expectedAfter.rulesets[0];
		const payload = {
			name: metadata.name,
			target: metadata.target,
			enforcement: next.rulesetEnforcement,
			bypass_actors: next.administratorBypass.map(
				/** @param {any} actor */ (actor) => ({
					actor_id: actor.actorId,
					actor_type: actor.actorType,
					bypass_mode: actor.bypassMode,
				}),
			),
			conditions: { ref_name: { include: metadata.include, exclude: metadata.exclude } },
			rules,
		};
		try {
			await request("PUT", `${repositoryPath}/rulesets/${metadata.id}`, payload);
			return { outcome: /** @type {const} */ ("acknowledged") };
		} catch {
			return { outcome: /** @type {const} */ ("unknown") };
		}
	};
	return Object.freeze({ readMeasured, writeOperation, request, repositoryPath });
}

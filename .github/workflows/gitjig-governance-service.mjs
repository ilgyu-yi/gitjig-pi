import {
	auditGovernance,
	canonicalByteLength,
	canonicalJson,
	GOVERNANCE_BOUNDS,
	parseGovernanceAudit,
	parseGovernanceConfig,
	parseGovernanceOperation,
	parseGovernancePlan,
	parseMeasuredGovernance,
	planGovernance,
	transitionMeasuredGovernance,
} from "./gitjig-governance.mjs";

export class GovernanceServiceRefusal extends Error {
	/** @param {string} arm */
	constructor(arm) {
		super(`governance service refused: ${arm}`);
		this.arm = arm;
	}
}

/** @param {unknown} left @param {unknown} right */
function equal(left, right) {
	return canonicalJson(left) === canonicalJson(right);
}
/** @param {unknown} plan @returns {Record<string,any>} */
function admittedPlan(plan) {
	try {
		return parseGovernancePlan(plan);
	} catch {
		throw new GovernanceServiceRefusal("plan-schema");
	}
}

const EFFECT_REFUSAL_ARMS = new Set([
	"compare-read-unavailable",
	"compare-read-invalid",
	"operand-drift",
	"payload-refused",
]);
const STOP_ARMS = new Set([
	"compare-read-unavailable",
	"compare-read-invalid",
	"operand-drift",
	"payload-refused",
	"write-unknown",
	"post-read-unavailable",
	"post-read-mismatch",
	"final-read-unavailable",
	"final-state-drift",
	"final-audit",
]);
/** @param {unknown} value @param {readonly string[]} keys */
function closed(value, keys) {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		Object.keys(value).every((key) => keys.includes(key))
	);
}
/** @param {unknown} input */
export function parseGovernanceApplyResult(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new GovernanceServiceRefusal("result-schema");
	const value = /** @type {Record<string,any>} */ (structuredClone(input));
	if (value.outcome === "applied") {
		if (!closed(value, ["outcome", "completed", "current", "remaining", "audit"]))
			throw new GovernanceServiceRefusal("result-schema");
		value.current = parseMeasuredGovernance(value.current);
		value.audit = parseGovernanceAudit(value.audit);
		if (!Array.isArray(value.remaining) || value.remaining.length !== 0)
			throw new GovernanceServiceRefusal("result-schema");
	} else if (value.outcome === "stopped") {
		if (!closed(value, ["outcome", "arm", "completed", "current", "remaining"]) || !STOP_ARMS.has(value.arm))
			throw new GovernanceServiceRefusal("result-schema");
		if (value.current !== null) value.current = parseMeasuredGovernance(value.current);
	} else throw new GovernanceServiceRefusal("result-schema");
	for (const name of ["completed", "remaining"]) {
		if (!Array.isArray(value[name])) throw new GovernanceServiceRefusal("result-schema");
		value[name] = value[name].map(parseGovernanceOperation);
	}
	if (canonicalByteLength(value) > GOVERNANCE_BOUNDS.applyResult) throw new GovernanceServiceRefusal("result-bound");
	return structuredClone(value);
}

/** @param {unknown} input @returns {Record<string,any>} */
function parseEffectResult(input) {
	if (closed(input, ["outcome"]) && ["acknowledged", "unknown"].includes(/** @type {any} */ (input).outcome))
		return /** @type {Record<string,any>} */ (structuredClone(input));
	if (
		!closed(input, ["outcome", "arm", "current"]) ||
		/** @type {any} */ (input).outcome !== "refused" ||
		!EFFECT_REFUSAL_ARMS.has(/** @type {any} */ (input).arm)
	)
		throw new GovernanceServiceRefusal("effect-result");
	const result = /** @type {Record<string,any>} */ (structuredClone(input));
	if (result.current !== null) result.current = parseMeasuredGovernance(result.current);
	return result;
}

/** @typedef {{readMeasured:()=>Promise<unknown>,writeOperation:(operation:unknown,expected:unknown)=>Promise<{outcome:'acknowledged'|'unknown'}|{outcome:'refused',arm:string,current:unknown}>}} GovernanceEffects */

/** One service instance owns one-invocation confirmation consumption. */
export function createGovernanceService() {
	const spent = new Set();
	return Object.freeze({
		/** @param {unknown} config @param {GovernanceEffects} effects */
		async plan(config, effects) {
			const parsed = parseGovernanceConfig(config);
			const measured = parseMeasuredGovernance(await effects.readMeasured());
			return planGovernance(parsed, measured);
		},
		/** @param {unknown} config @param {GovernanceEffects} effects */
		async audit(config, effects) {
			const parsed = parseGovernanceConfig(config);
			const measured = parseMeasuredGovernance(await effects.readMeasured());
			return auditGovernance(parsed, measured);
		},
		/**
		 * @param {{config:unknown,plan:unknown,confirmation:{kind:'interactive'|'non-interactive'|'pi',repository:string,planHash:string,invocationId:string}}} input
		 * @param {GovernanceEffects} effects
		 */
		async apply(input, effects) {
			const config = parseGovernanceConfig(input.config);
			const supplied = admittedPlan(input.plan);
			const confirmation = input.confirmation;
			if (
				!confirmation ||
				Object.keys(confirmation).length !== 4 ||
				!["kind", "repository", "planHash", "invocationId"].every((key) => Object.hasOwn(confirmation, key)) ||
				!["interactive", "non-interactive", "pi"].includes(confirmation.kind) ||
				confirmation.repository !== config.repository.nameWithOwner ||
				confirmation.planHash !== supplied.planHash ||
				typeof confirmation.invocationId !== "string" ||
				confirmation.invocationId.length === 0
			)
				throw new GovernanceServiceRefusal("confirmation-mismatch");
			const replayKey = canonicalJson(confirmation);
			if (spent.has(replayKey)) throw new GovernanceServiceRefusal("confirmation-replayed");
			spent.add(replayKey);
			const initial = planGovernance(config, parseMeasuredGovernance(await effects.readMeasured()));
			if (!equal(initial, supplied)) throw new GovernanceServiceRefusal("plan-stale");
			const completed = [];
			let expected = structuredClone(supplied.measured);
			for (let index = 0; index < supplied.operations.length; index++) {
				const remaining = supplied.operations.slice(index);
				let current;
				try {
					current = planGovernance(config, parseMeasuredGovernance(await effects.readMeasured()));
				} catch {
					return { outcome: "stopped", arm: "compare-read-unavailable", completed, current: null, remaining };
				}
				if (!equal(current.measured, expected) || !equal(current.operations, remaining))
					return { outcome: "stopped", arm: "operand-drift", completed, current: current.measured, remaining };
				const operation = supplied.operations[index];
				const expectedAfter = transitionMeasuredGovernance(expected, operation);
				let result;
				try {
					result = parseEffectResult(
						await effects.writeOperation(structuredClone(operation), structuredClone(expected)),
					);
				} catch {
					result = { outcome: "unknown" };
				}
				if (result.outcome === "refused")
					return { outcome: "stopped", arm: result.arm, completed, current: result.current, remaining };
				if (result.outcome !== "acknowledged") {
					let measured = null;
					try {
						measured = parseMeasuredGovernance(await effects.readMeasured());
					} catch {
						// Unknown means exactly that; absence of a reread must not invent the pre-write state as current.
					}
					return { outcome: "stopped", arm: "write-unknown", completed, current: measured, remaining };
				}
				let after;
				try {
					after = planGovernance(config, parseMeasuredGovernance(await effects.readMeasured()));
				} catch {
					return { outcome: "stopped", arm: "post-read-unavailable", completed, current: null, remaining };
				}
				if (!equal(after.measured, expectedAfter) || !equal(after.operations, supplied.operations.slice(index + 1)))
					return {
						outcome: "stopped",
						arm: "post-read-mismatch",
						completed,
						current: after.measured,
						remaining,
					};
				expected = expectedAfter;
				completed.push(structuredClone(operation));
			}
			let finalMeasured;
			try {
				finalMeasured = parseMeasuredGovernance(await effects.readMeasured());
			} catch {
				return { outcome: "stopped", arm: "final-read-unavailable", completed, current: null, remaining: [] };
			}
			if (!equal(finalMeasured, expected))
				return { outcome: "stopped", arm: "final-state-drift", completed, current: finalMeasured, remaining: [] };
			const audit = auditGovernance(config, finalMeasured);
			if (!audit.compliant)
				return { outcome: "stopped", arm: "final-audit", completed, current: finalMeasured, remaining: [] };
			return { outcome: "applied", completed, current: finalMeasured, remaining: [], audit };
		},
	});
}

/** @param {string} repository @param {unknown} plan */
export function confirmationPresentation(repository, plan) {
	const candidate = admittedPlan(plan);
	if (repository !== candidate.repository.nameWithOwner) throw new GovernanceServiceRefusal("confirmation-mismatch");
	return {
		repository,
		configDigest: candidate.configDigest,
		measuredBasis: candidate.measured,
		operations: candidate.operations,
		planHash: candidate.planHash,
		risks: ["writes repository governance", "stops without retry or rollback on uncertainty"],
		confirmation: `${repository} ${candidate.planHash}`,
	};
}

/** @param {string} repository @param {unknown} plan */
export function confirmationText(repository, plan) {
	return confirmationPresentation(repository, plan).confirmation;
}

/** @param {'interactive'|'non-interactive'|'pi'} kind @param {unknown} supplied @param {string} repository @param {unknown} plan @param {string} invocationId */
export function admitConfirmation(kind, supplied, repository, plan, invocationId) {
	const presentation = confirmationPresentation(repository, plan);
	const expected = kind === "non-interactive" ? presentation.planHash : presentation.confirmation;
	if (
		typeof supplied !== "string" ||
		supplied !== expected ||
		typeof invocationId !== "string" ||
		invocationId.length === 0
	)
		throw new GovernanceServiceRefusal("confirmation-mismatch");
	return { kind, repository, planHash: presentation.planHash, invocationId };
}

import {
	auditGovernance,
	canonicalJson,
	parseGovernanceConfig,
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
					result = await effects.writeOperation(structuredClone(operation), structuredClone(expected));
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

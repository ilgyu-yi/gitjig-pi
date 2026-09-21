import { createHash } from "node:crypto";

export class GovernanceRefusal extends Error {
	/** @param {string} arm */
	constructor(arm) {
		super(`governance refused: ${arm}`);
		this.arm = arm;
	}
}

export const CAPABILITIES = Object.freeze([
	"mergeCommits",
	"squashMerging",
	"rebaseMerging",
	"rulesetEnforcement",
	"administratorBypass",
	"allowedMergeMethods",
	"requiredApprovingReviews",
	"dismissStaleReviews",
	"requiredReviewers",
	"codeOwnerReview",
	"lastPushApproval",
	"reviewThreadResolution",
	"extraApprovalForUnattributedChanges",
	"strictRequiredStatusChecks",
	"doNotEnforceOnCreate",
	"requiredStatusChecks",
	"deletionProtection",
	"nonFastForwardProtection",
	"requiredLinearHistory",
]);
const BOOLEAN_CAPABILITIES = new Set([
	"mergeCommits",
	"squashMerging",
	"rebaseMerging",
	"dismissStaleReviews",
	"codeOwnerReview",
	"lastPushApproval",
	"reviewThreadResolution",
	"extraApprovalForUnattributedChanges",
	"strictRequiredStatusChecks",
	"doNotEnforceOnCreate",
	"deletionProtection",
	"nonFastForwardProtection",
	"requiredLinearHistory",
]);
const UNSUPPORTED_POSITIVE = new Set([
	"requiredReviewers",
	"codeOwnerReview",
	"lastPushApproval",
	"extraApprovalForUnattributedChanges",
	"doNotEnforceOnCreate",
]);
const RULE_TYPES = Object.freeze([
	"pull_request",
	"required_status_checks",
	"deletion",
	"non_fast_forward",
	"required_linear_history",
]);
/** @param {string} left @param {string} right */
function compareRuleTypes(left, right) {
	return RULE_TYPES.indexOf(left) - RULE_TYPES.indexOf(right);
}

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
/** @param {unknown} value */
function positive(value) {
	return Number.isSafeInteger(value) && Number(value) > 0;
}
/** @param {unknown[]} values */
function uniqueCanonical(values) {
	const rendered = values.map(canonicalJson);
	return new Set(rendered).size === rendered.length;
}
/** @param {unknown} value */
function validStrings(value) {
	return Array.isArray(value) && uniqueCanonical(value) && value.every(scalarSequence);
}
/** @param {unknown} left @param {unknown} right */
function compareCanonical(left, right) {
	const a = canonicalJson(left);
	const b = canonicalJson(right);
	return a < b ? -1 : a > b ? 1 : 0;
}
/** @param {unknown} value */
function scalarSequence(value) {
	if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")) return false;
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(++index);
			if (next < 0xdc00 || next > 0xdfff) return false;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
	}
	return true;
}

/** @param {string} source */
function rejectDuplicateJsonKeys(source) {
	let at = 0;
	const space = () => {
		while (/\s/.test(source[at] ?? "")) at++;
	};
	const string = () => {
		const start = at++;
		while (at < source.length) {
			if (source[at] === "\\") at += 2;
			else if (source[at++] === '"') return JSON.parse(source.slice(start, at));
		}
		throw new GovernanceRefusal("config-json");
	};
	const value = () => {
		space();
		if (source[at] === '"') return void string();
		if (source[at] === "{") return object();
		if (source[at] === "[") return array();
		const match = source.slice(at).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
		if (!match) throw new GovernanceRefusal("config-json");
		at += match[0].length;
	};
	const array = () => {
		at++;
		space();
		if (source[at] === "]") return void at++;
		for (;;) {
			value();
			space();
			if (source[at] === "]") return void at++;
			if (source[at++] !== ",") throw new GovernanceRefusal("config-json");
		}
	};
	const object = () => {
		at++;
		const keys = new Set();
		space();
		if (source[at] === "}") return void at++;
		for (;;) {
			space();
			if (source[at] !== '"') throw new GovernanceRefusal("config-json");
			const key = string();
			if (keys.has(key)) throw new GovernanceRefusal("config-duplicate-key");
			keys.add(key);
			space();
			if (source[at++] !== ":") throw new GovernanceRefusal("config-json");
			value();
			space();
			if (source[at] === "}") return void at++;
			if (source[at++] !== ",") throw new GovernanceRefusal("config-json");
		}
	};
	value();
	space();
	if (at !== source.length) throw new GovernanceRefusal("config-json");
}

/** @param {unknown} value @returns {string} */
export function canonicalJson(value) {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) throw new GovernanceRefusal("canonical-number");
		return String(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(/** @type {Record<string,unknown>} */ (value)[key])}`)
			.join(",")}}`;
	}
	throw new GovernanceRefusal("canonical-value");
}

/** @param {any} value */
function validCheck(value) {
	return closed(value, ["context", "integrationId"]) && scalarSequence(value.context) && positive(value.integrationId);
}
/** @param {any[]} value */
function validReviewers(value) {
	return (
		Array.isArray(value) &&
		uniqueCanonical(value) &&
		value.every(
			(reviewer) =>
				closed(reviewer, ["actorId", "actorType"]) &&
				positive(reviewer.actorId) &&
				["RepositoryRole", "Team", "Integration"].includes(reviewer.actorType),
		)
	);
}
/** @param {any} value */
function validMeasuredCheck(value) {
	return (
		closed(value, ["context", "integrationId"]) &&
		scalarSequence(value.context) &&
		(value.integrationId === null || positive(value.integrationId))
	);
}
/** @param {any[]} value */
function validChecks(value) {
	return (
		Array.isArray(value) &&
		value.every(validCheck) &&
		new Set(value.map((entry) => entry.context)).size === value.length
	);
}
/** @param {string} name @param {any} value */
function validCapabilityValue(name, value) {
	if (BOOLEAN_CAPABILITIES.has(name)) return typeof value === "boolean";
	if (name === "rulesetEnforcement") return value === "active" || value === "evaluate" || value === "disabled";
	if (name === "administratorBypass")
		return (
			Array.isArray(value) &&
			uniqueCanonical(value) &&
			value.every(
				(actor) =>
					closed(actor, ["actorId", "actorType", "bypassMode"]) &&
					positive(actor.actorId) &&
					["RepositoryRole", "Team", "Integration"].includes(actor.actorType) &&
					["always", "pull_request"].includes(actor.bypassMode),
			)
		);
	if (name === "allowedMergeMethods")
		return (
			Array.isArray(value) &&
			value.length > 0 &&
			uniqueCanonical(value) &&
			value.every((entry) => entry === "merge" || entry === "squash" || entry === "rebase")
		);
	if (name === "requiredApprovingReviews")
		return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 6;
	if (name === "requiredReviewers") return validReviewers(value);
	if (name === "requiredStatusChecks") return validChecks(value);
	return false;
}
/** @param {string} name */
function disabledValue(name) {
	if (BOOLEAN_CAPABILITIES.has(name)) return false;
	if (name === "rulesetEnforcement") return "disabled";
	if (name === "administratorBypass") return [];
	if (name === "allowedMergeMethods" || name === "requiredReviewers" || name === "requiredStatusChecks") return [];
	if (name === "requiredApprovingReviews") return 0;
	throw new GovernanceRefusal("capability-name");
}

/** @param {string} name @param {any} value */
function validMeasuredValue(name, value) {
	if (name === "administratorBypass" || name === "requiredReviewers") return validCapabilityValue(name, value);
	if (name === "requiredStatusChecks")
		return (
			Array.isArray(value) &&
			value.every(validMeasuredCheck) &&
			new Set(value.map((entry) => entry.context)).size === value.length
		);
	if (name === "allowedMergeMethods")
		return (
			Array.isArray(value) &&
			uniqueCanonical(value) &&
			value.every((entry) => ["merge", "squash", "rebase"].includes(entry))
		);
	return validCapabilityValue(name, value);
}

/** @param {unknown} input */
export function parseGovernanceConfig(input) {
	let value = input;
	if (typeof input === "string" || input instanceof Uint8Array) {
		let source;
		try {
			source = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
			rejectDuplicateJsonKeys(source);
			value = JSON.parse(source);
		} catch (error) {
			if (error instanceof GovernanceRefusal) throw error;
			throw new GovernanceRefusal("config-json");
		}
	}
	if (!closed(value, ["schemaVersion", "repository", "ruleset", "capabilities"]))
		throw new GovernanceRefusal("config-schema");
	const record = /** @type {Record<string,any>} */ (value);
	if (record.schemaVersion !== 1) throw new GovernanceRefusal("config-version");
	if (
		!closed(record.repository, ["id", "nameWithOwner", "defaultBranch"]) ||
		!scalarSequence(record.repository.id) ||
		!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(record.repository.nameWithOwner ?? "") ||
		!scalarSequence(record.repository.defaultBranch)
	)
		throw new GovernanceRefusal("config-repository");
	if (!closed(record.ruleset, ["name", "target", "include", "exclude"])) throw new GovernanceRefusal("config-ruleset");
	if (
		!scalarSequence(record.ruleset.name) ||
		record.ruleset.target !== "branch" ||
		!Array.isArray(record.ruleset.include) ||
		!Array.isArray(record.ruleset.exclude) ||
		record.ruleset.include.length !== 1 ||
		record.ruleset.include[0] !== "~DEFAULT_BRANCH" ||
		record.ruleset.exclude.length !== 0
	)
		throw new GovernanceRefusal("config-ruleset");
	if (!closed(record.capabilities, CAPABILITIES)) throw new GovernanceRefusal("config-capability-population");
	for (const name of CAPABILITIES) {
		const entry = record.capabilities[name];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new GovernanceRefusal("config-capability");
		if (entry.mode === "unmanaged" || entry.mode === "disabled") {
			if (!closed(entry, ["mode"])) throw new GovernanceRefusal("config-capability");
			continue;
		}
		if (entry.mode !== "selected" || !closed(entry, ["mode", "value"]) || !validCapabilityValue(name, entry.value))
			throw new GovernanceRefusal("config-capability");
		if (UNSUPPORTED_POSITIVE.has(name)) throw new GovernanceRefusal("unsupported-positive-option");
		if (
			(typeof entry.value === "boolean" && !entry.value) ||
			entry.value === "disabled" ||
			(typeof entry.value === "number" && entry.value === 0) ||
			(Array.isArray(entry.value) && entry.value.length === 0)
		)
			throw new GovernanceRefusal("contradictory-selection");
	}
	const parsed = structuredClone(record);
	for (const name of ["administratorBypass", "allowedMergeMethods", "requiredStatusChecks"]) {
		const entry = parsed.capabilities[name];
		if (entry.mode === "selected") entry.value.sort(compareCanonical);
	}
	return parsed;
}

/** @param {any} value */
function deepFreeze(value) {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const entry of Object.values(value)) deepFreeze(entry);
	}
	return value;
}

/** @param {unknown} config @param {unknown} repository */
export function validateGovernanceConfig(config, repository) {
	const parsed = parseGovernanceConfig(config);
	if (
		!closed(repository, ["id", "nameWithOwner", "defaultBranch"]) ||
		canonicalJson(parsed.repository) !== canonicalJson(repository)
	)
		throw new GovernanceRefusal("repository-mismatch");
	return deepFreeze(structuredClone(parsed));
}

/** @param {unknown} input */
export function parseMeasuredGovernance(input) {
	if (!closed(input, ["schemaVersion", "repository", "rulesets", "capabilities"]))
		throw new GovernanceRefusal("measured-schema");
	const measured = /** @type {Record<string,any>} */ (input);
	if (measured.schemaVersion !== 2) throw new GovernanceRefusal("measured-version");
	if (
		!closed(measured.repository, ["id", "nameWithOwner", "defaultBranch", "defaultBranchSha"]) ||
		!scalarSequence(measured.repository.id) ||
		!scalarSequence(measured.repository.nameWithOwner) ||
		!scalarSequence(measured.repository.defaultBranch) ||
		!/^[0-9a-f]{40}$/.test(measured.repository.defaultBranchSha ?? "")
	)
		throw new GovernanceRefusal("measured-repository");
	if (!Array.isArray(measured.rulesets) || measured.rulesets.length !== 1)
		throw new GovernanceRefusal("measured-ruleset-population");
	const ruleset = measured.rulesets[0];
	if (
		!closed(ruleset, ["id", "name", "target", "sourceType", "source", "include", "exclude", "ruleTypes"]) ||
		!positive(ruleset.id) ||
		!scalarSequence(ruleset.name) ||
		ruleset.target !== "branch" ||
		ruleset.sourceType !== "Repository" ||
		!scalarSequence(ruleset.source) ||
		!validStrings(ruleset.include) ||
		!validStrings(ruleset.exclude) ||
		!Array.isArray(ruleset.ruleTypes) ||
		!uniqueCanonical(ruleset.ruleTypes) ||
		!ruleset.ruleTypes.every(/** @param {any} type */ (type) => RULE_TYPES.includes(type))
	)
		throw new GovernanceRefusal("measured-ruleset");
	if (!closed(measured.capabilities, CAPABILITIES)) throw new GovernanceRefusal("measured-capability-population");
	for (const name of CAPABILITIES) {
		if (!validMeasuredValue(name, measured.capabilities[name])) throw new GovernanceRefusal("measured-capability");
	}
	const parsed = structuredClone(measured);
	parsed.rulesets[0].ruleTypes.sort(compareRuleTypes);
	if (canonicalJson(parsed.rulesets[0].ruleTypes) !== canonicalJson(ruleTypesForCapabilities(parsed.capabilities)))
		throw new GovernanceRefusal("measured-rule-parameter-mismatch");
	for (const name of ["administratorBypass", "allowedMergeMethods", "requiredReviewers", "requiredStatusChecks"])
		parsed.capabilities[name].sort(compareCanonical);
	return parsed;
}

const PULL_CAPABILITIES = Object.freeze([
	"allowedMergeMethods",
	"requiredApprovingReviews",
	"dismissStaleReviews",
	"requiredReviewers",
	"codeOwnerReview",
	"lastPushApproval",
	"reviewThreadResolution",
	"extraApprovalForUnattributedChanges",
]);
const STATUS_CAPABILITIES = Object.freeze([
	"strictRequiredStatusChecks",
	"doNotEnforceOnCreate",
	"requiredStatusChecks",
]);

/** @param {Record<string,any>} capabilities */
export function ruleTypesForCapabilities(capabilities) {
	const enabled = (/** @type {string} */ name) =>
		canonicalJson(capabilities[name]) !== canonicalJson(disabledValue(name));
	const types = [];
	if (PULL_CAPABILITIES.some(enabled)) types.push("pull_request");
	if (STATUS_CAPABILITIES.some(enabled)) types.push("required_status_checks");
	if (capabilities.deletionProtection) types.push("deletion");
	if (capabilities.nonFastForwardProtection) types.push("non_fast_forward");
	if (capabilities.requiredLinearHistory) types.push("required_linear_history");
	return types;
}

/** @param {Record<string,any>} ruleset */
function identityMetadata(ruleset) {
	return { name: ruleset.name, target: ruleset.target, include: ruleset.include, exclude: ruleset.exclude };
}
/** @param {Record<string,any>} ruleset */
function stableIdentity(ruleset) {
	return { id: ruleset.id, sourceType: ruleset.sourceType, source: ruleset.source };
}
/** @param {Record<string,any>} config @param {Record<string,any>} measured */
function admitBasis(config, measured) {
	const parsed = parseMeasuredGovernance(measured);
	const { defaultBranchSha: _sha, ...measuredRepository } = parsed.repository;
	if (canonicalJson(config.repository) !== canonicalJson(measuredRepository))
		throw new GovernanceRefusal("measured-repository-mismatch");
	const ruleset = parsed.rulesets[0];
	if (ruleset.source !== config.repository.nameWithOwner || ruleset.sourceType !== "Repository")
		throw new GovernanceRefusal("measured-ruleset-mismatch");
	return parsed;
}

/** @param {unknown} operation */
function parseOperation(operation) {
	if (!operation || typeof operation !== "object" || Array.isArray(operation))
		throw new GovernanceRefusal("operation-schema");
	const value = /** @type {Record<string,any>} */ (operation);
	if (Object.hasOwn(value, "kind")) {
		if (
			!closed(value, ["kind", "stable", "before", "after"]) ||
			value.kind !== "ruleset-identity" ||
			!closed(value.stable, ["id", "sourceType", "source"]) ||
			!positive(value.stable.id) ||
			value.stable.sourceType !== "Repository" ||
			!scalarSequence(value.stable.source)
		)
			throw new GovernanceRefusal("operation-schema");
		for (const metadata of [value.before, value.after])
			if (
				!closed(metadata, ["name", "target", "include", "exclude"]) ||
				!scalarSequence(metadata.name) ||
				metadata.target !== "branch" ||
				!validStrings(metadata.include) ||
				!validStrings(metadata.exclude)
			)
				throw new GovernanceRefusal("operation-schema");
		return structuredClone(value);
	}
	if (!closed(value, ["capability", "before", "after"]) || !CAPABILITIES.includes(value.capability))
		throw new GovernanceRefusal("operation-schema");
	if (!validMeasuredValue(value.capability, value.before) || !validMeasuredValue(value.capability, value.after))
		throw new GovernanceRefusal("operation-schema");
	return structuredClone(value);
}

/** @param {unknown} expected @param {unknown} operation */
export function transitionMeasuredGovernance(expected, operation) {
	const measured = parseMeasuredGovernance(expected);
	const admitted = parseOperation(operation);
	const ruleset = measured.rulesets[0];
	if (admitted.kind === "ruleset-identity") {
		if (
			canonicalJson(stableIdentity(ruleset)) !== canonicalJson(admitted.stable) ||
			canonicalJson(identityMetadata(ruleset)) !== canonicalJson(admitted.before)
		)
			throw new GovernanceRefusal("operation-before");
		Object.assign(ruleset, structuredClone(admitted.after));
	} else {
		if (canonicalJson(measured.capabilities[admitted.capability]) !== canonicalJson(admitted.before))
			throw new GovernanceRefusal("operation-before");
		measured.capabilities[admitted.capability] = structuredClone(admitted.after);
		ruleset.ruleTypes = ruleTypesForCapabilities(measured.capabilities);
	}
	return parseMeasuredGovernance(measured);
}

/** @param {unknown} config @param {unknown} measured */
export function planGovernance(config, measured) {
	const parsedConfig = parseGovernanceConfig(config);
	const parsedMeasured = admitBasis(parsedConfig, /** @type {Record<string,any>} */ (measured));
	const operations = [];
	const ruleset = parsedMeasured.rulesets[0];
	const desiredIdentity = {
		name: parsedConfig.ruleset.name,
		target: parsedConfig.ruleset.target,
		include: parsedConfig.ruleset.include,
		exclude: parsedConfig.ruleset.exclude,
	};
	const observedIdentity = identityMetadata(ruleset);
	if (canonicalJson(observedIdentity) !== canonicalJson(desiredIdentity))
		operations.push({
			kind: "ruleset-identity",
			stable: stableIdentity(ruleset),
			before: observedIdentity,
			after: desiredIdentity,
		});
	for (const name of CAPABILITIES) {
		const selection = parsedConfig.capabilities[name];
		if (selection.mode === "unmanaged") continue;
		const after = selection.mode === "disabled" ? disabledValue(name) : selection.value;
		const before = parsedMeasured.capabilities[name];
		if (canonicalJson(before) !== canonicalJson(after)) operations.push({ capability: name, before, after });
	}
	const basis = {
		schemaVersion: 2,
		repository: parsedConfig.repository,
		configDigest: createHash("sha256").update(canonicalJson(parsedConfig)).digest("hex"),
		measured: parsedMeasured,
		operations,
	};
	return {
		...basis,
		planHash: createHash("sha256").update(canonicalJson(basis)).digest("hex"),
		authorized: false,
	};
}

/** @param {unknown} config @param {unknown} measured */
export function auditGovernance(config, measured) {
	const parsedConfig = parseGovernanceConfig(config);
	const parsedMeasured = admitBasis(parsedConfig, /** @type {Record<string,any>} */ (measured));
	const ruleset = parsedMeasured.rulesets[0];
	const desiredIdentity = {
		name: parsedConfig.ruleset.name,
		target: parsedConfig.ruleset.target,
		include: parsedConfig.ruleset.include,
		exclude: parsedConfig.ruleset.exclude,
	};
	const observedIdentity = identityMetadata(ruleset);
	const identity = {
		stable: stableIdentity(ruleset),
		desired: desiredIdentity,
		observed: observedIdentity,
		compliant: canonicalJson(desiredIdentity) === canonicalJson(observedIdentity),
	};
	const capabilities = CAPABILITIES.map((name) => {
		const selection = parsedConfig.capabilities[name];
		const observed = parsedMeasured.capabilities[name];
		if (selection.mode === "unmanaged") return { capability: name, classification: "unmanaged", observed };
		const desired = selection.mode === "disabled" ? disabledValue(name) : selection.value;
		return {
			capability: name,
			classification: selection.mode,
			desired,
			observed,
			compliant: canonicalJson(desired) === canonicalJson(observed),
		};
	});
	return {
		schemaVersion: 2,
		repository: parsedMeasured.repository,
		identity,
		capabilities,
		compliant:
			identity.compliant && capabilities.every((entry) => entry.classification === "unmanaged" || entry.compliant),
	};
}

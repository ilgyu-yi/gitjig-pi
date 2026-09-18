import { createHash } from "node:crypto";

/** @param {unknown} value @param {PropertyKey} key */
const own = (value, key) => Object.hasOwn(/** @type {object} */ (value), key);
/** @param {unknown} value @param {readonly string[]} keys */
const exactObject = (value, keys) =>
	value !== null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	Object.keys(value).length === keys.length &&
	keys.every((key) => own(value, key));
/** @param {unknown} value */
const nonEmpty = (value) =>
	typeof value === "string" &&
	value.trim() === value &&
	value.length > 0 &&
	value.normalize("NFC") === value &&
	!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
/** @param {unknown} value */
const objectId = (value) => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

/** @param {unknown} value */
export function parseLandingPolicy(value) {
	if (!exactObject(value, ["schemaVersion", "appProducer"])) return { ok: false, arm: "policy-schema-invalid" };
	const record = /** @type {Record<string, unknown>} */ (value);
	if (record.schemaVersion !== 1) return { ok: false, arm: "policy-schema-invalid" };
	if (record.appProducer === null) return { ok: false, arm: "policy-unavailable" };
	if (!exactObject(record.appProducer, ["installationId", "nodeId"]))
		return { ok: false, arm: "policy-schema-invalid" };
	const producer = /** @type {Record<string, unknown>} */ (record.appProducer);
	if (
		!Number.isSafeInteger(producer.installationId) ||
		/** @type {number} */ (producer.installationId) <= 0 ||
		!nonEmpty(producer.nodeId)
	)
		return { ok: false, arm: "policy-schema-invalid" };
	return {
		ok: true,
		policy: Object.freeze({
			installationId: /** @type {number} */ (producer.installationId),
			nodeId: /** @type {string} */ (producer.nodeId),
		}),
	};
}

/** @param {Uint8Array} bytes @param {"sha1" | "sha256"} [algorithm] */
export function gitBlobObjectId(bytes, algorithm = "sha1") {
	if (!(bytes instanceof Uint8Array)) throw new TypeError("policy bytes must be a Uint8Array");
	if (algorithm !== "sha1" && algorithm !== "sha256") throw new TypeError("unsupported object-id algorithm");
	const header = Buffer.from(`blob ${bytes.byteLength}\0`);
	return createHash(algorithm).update(header).update(bytes).digest("hex");
}

/**
 * @param {unknown} bytes
 * @param {unknown} evidence
 */
export function attestLandingPolicy(bytes, evidence) {
	if (!(bytes instanceof Uint8Array)) return { ok: false, arm: "policy-unreadable" };
	if (!exactObject(evidence, ["addressedRepositoryId", "observedRepositoryId", "defaultBranchBlobOid"]))
		return { ok: false, arm: "policy-provenance-unverifiable" };
	const proof = /** @type {Record<string, unknown>} */ (evidence);
	if (!nonEmpty(proof.addressedRepositoryId) || !nonEmpty(proof.observedRepositoryId))
		return { ok: false, arm: "policy-provenance-unverifiable" };
	if (proof.addressedRepositoryId !== proof.observedRepositoryId)
		return { ok: false, arm: "policy-repository-mismatch" };
	if (!objectId(proof.defaultBranchBlobOid)) return { ok: false, arm: "policy-provenance-unverifiable" };
	const expectedOid = /** @type {string} */ (proof.defaultBranchBlobOid);
	const algorithm = expectedOid.length === 64 ? "sha256" : "sha1";
	if (gitBlobObjectId(bytes, algorithm) !== expectedOid) return { ok: false, arm: "policy-provenance-mismatch" };
	let value;
	try {
		value = JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch {
		return { ok: false, arm: "policy-schema-invalid" };
	}
	return parseLandingPolicy(value);
}

/**
 * @param {unknown} entries
 * @param {unknown} evidence
 */
export function loadLandingPolicy(entries, evidence) {
	if (!Array.isArray(entries)) return { ok: false, arm: "policy-unreadable" };
	const matches = entries.filter(
		(entry) =>
			exactObject(entry, ["path", "bytes"]) &&
			/** @type {Record<string, unknown>} */ (entry).path === ".github/landing-policy.json",
	);
	if (matches.length !== 1) return { ok: false, arm: matches.length === 0 ? "policy-absent" : "policy-duplicate" };
	return attestLandingPolicy(/** @type {Record<string, unknown>} */ (matches[0]).bytes, evidence);
}

/** @param {unknown} value */
export function sourceProjectionAdmits(value) {
	if (!exactObject(value, ["schemaVersion", "appProducer"])) return false;
	const record = /** @type {Record<string, unknown>} */ (value);
	return record.schemaVersion === 1 && record.appProducer === null;
}

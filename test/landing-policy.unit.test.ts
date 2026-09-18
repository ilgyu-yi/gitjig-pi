import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	attestLandingPolicy,
	gitBlobObjectId,
	parseLandingPolicy,
	sourceProjectionAdmits,
} from "../.github/workflows/landing-policy.mjs";

const root = join(import.meta.dirname, "..");
const bytes = readFileSync(join(root, ".github/landing-policy.json"));
const evidence = {
	addressedRepositoryId: "R_target",
	observedRepositoryId: "R_target",
	defaultBranchBlobOid: gitBlobObjectId(bytes),
};

describe("#279 null-only landing policy carrier", () => {
	it("keeps production policy explicitly unavailable", () => {
		assert.deepEqual(attestLandingPolicy(bytes, evidence), { ok: false, arm: "policy-unavailable" });
		assert.equal(sourceProjectionAdmits(JSON.parse(bytes.toString("utf8"))), true);
	});

	it("admits only the exact configured fixture schema", () => {
		assert.deepEqual(parseLandingPolicy({ schemaVersion: 1, appProducer: { installationId: 7, nodeId: "I_node" } }), {
			ok: true,
			policy: { installationId: 7, nodeId: "I_node" },
		});
		for (const value of [
			null,
			{},
			{ schemaVersion: 2, appProducer: null },
			{ schemaVersion: 1, appProducer: null, extra: true },
			{ schemaVersion: 1, appProducer: {} },
			{ schemaVersion: 1, appProducer: { installationId: 0, nodeId: "I_node" } },
			{ schemaVersion: 1, appProducer: { installationId: 7, nodeId: "" } },
			{ schemaVersion: 1, appProducer: { installationId: 7, nodeId: " I_node" } },
			{ schemaVersion: 1, appProducer: { installationId: 7, nodeId: "I_node", extra: true } },
		])
			assert.equal(parseLandingPolicy(value).ok, false);
	});

	it("refuses every repository and provenance mismatch independently", () => {
		assert.equal(
			attestLandingPolicy(bytes, { ...evidence, observedRepositoryId: "R_other" }).arm,
			"policy-repository-mismatch",
		);
		assert.equal(
			attestLandingPolicy(bytes, { ...evidence, defaultBranchBlobOid: "0".repeat(40) }).arm,
			"policy-provenance-mismatch",
		);
		assert.equal(
			attestLandingPolicy(bytes, { ...evidence, defaultBranchBlobOid: "bad" }).arm,
			"policy-provenance-unverifiable",
		);
		assert.equal(attestLandingPolicy(bytes, {}).arm, "policy-provenance-unverifiable");
		assert.equal(attestLandingPolicy("not bytes", evidence).arm, "policy-unreadable");
	});

	it("rejects populated source projection instead of exporting target identity", () => {
		assert.equal(
			sourceProjectionAdmits({ schemaVersion: 1, appProducer: { installationId: 7, nodeId: "I_node" } }),
			false,
		);
		assert.equal(sourceProjectionAdmits({ schemaVersion: 1, appProducer: null, extra: true }), false);
	});
});

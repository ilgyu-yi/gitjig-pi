import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { claimAllowance, finalizeAllowance, type RecoveryRecord } from "../.pi/extensions/gitjig/recovery/store.ts";

const key = "a".repeat(64);
function record(): RecoveryRecord {
	return {
		schemaVersion: 1,
		repositoryId: "R",
		repositoryKey: key,
		lineageKey: key,
		lineageInput: "{}",
		pullRequestId: "P",
		issueIds: [],
		subjectHead: "b".repeat(40),
		subjectBase: "c".repeat(40),
		modes: {},
		profileSetVersion: 1,
		profileSetDigest: key,
		basis: {},
		state: "claimed",
		claimId: crypto.randomUUID(),
		claimedAt: new Date().toISOString(),
		attempts: [],
		candidateSet: "not-applicable",
		sequenceAuthority: "authoritative",
		selectedIntervention: null,
		measurement: null,
		freshRuling: null,
		reentry: null,
		nextGate: null,
		terminal: "pending",
		terminalAt: null,
	};
}

describe("#332 durable one-use allowance", () => {
	it("admits exactly one exclusive claim and keeps it owner-only", () => {
		const root = mkdtempSync(join(tmpdir(), "recovery-store-"));
		const first = claimAllowance(root, key, key, record());
		assert.ok(first);
		assert.equal(claimAllowance(root, key, key, record()), undefined);
		assert.equal(statSync(first.path).mode & 0o777, 0o600);
	});
	it("atomically terminalizes immutable identity and never reopens", () => {
		const root = mkdtempSync(join(tmpdir(), "recovery-store-"));
		const claimed = record();
		const claim = claimAllowance(root, key, key, claimed);
		assert.ok(claim);
		const consumed: RecoveryRecord = {
			...claimed,
			state: "consumed",
			terminal: "handoff",
			terminalAt: new Date().toISOString(),
			reentry: "none",
			nextGate: "park",
			sequenceAuthority: "consumed-failure",
			attempts: [{ slot: "x" }],
		};
		assert.equal(finalizeAllowance(claim, consumed), true);
		assert.equal(JSON.parse(readFileSync(claim.path, "utf8")).state, "consumed");
		assert.equal(claimAllowance(root, key, key, record()), undefined);
	});
	it("refuses terminal identity substitution", () => {
		const root = mkdtempSync(join(tmpdir(), "recovery-store-"));
		const claimed = record();
		const claim = claimAllowance(root, key, key, claimed);
		assert.ok(claim);
		assert.equal(
			finalizeAllowance(claim, { ...claimed, claimId: crypto.randomUUID(), state: "consumed", terminal: "handoff" }),
			false,
		);
	});
});

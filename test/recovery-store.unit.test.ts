import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { deriveAllowancePathEncoding } from "../.pi/extensions/gitjig/recovery/lineage.ts";
import { claimAllowance, finalizeAllowance } from "../.pi/extensions/gitjig/recovery/store.ts";
import type { ClaimedRecordV3, ConsumedRecordV3 } from "../.pi/extensions/gitjig/recovery/types.ts";
import type { ReviewSubject } from "../.pi/extensions/gitjig/review/subject.ts";

let stateRoot = "";
const oldXdg = process.env.XDG_STATE_HOME;
const oldTest = process.env.GITJIG_TEST_STATE_ROOT;

beforeEach(() => {
	stateRoot = mkdtempSync(join(tmpdir(), "gitjig-recovery-store-"));
	chmodSync(stateRoot, 0o700);
	process.env.XDG_STATE_HOME = stateRoot;
	delete process.env.GITJIG_TEST_STATE_ROOT;
});
afterEach(() => {
	if (oldXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = oldXdg;
	if (oldTest === undefined) delete process.env.GITJIG_TEST_STATE_ROOT;
	else process.env.GITJIG_TEST_STATE_ROOT = oldTest;
	rmSync(stateRoot, { recursive: true, force: true });
});

function subject(pr = "PR_ONE"): ReviewSubject {
	return {
		context: {
			repository: { id: "REPO", host: "github.com", nameWithOwner: "o/r" },
			pullRequest: {
				id: pr,
				number: 1,
				url: "https://github.com/o/r/pull/1",
				authorId: "A",
				base: { repositoryId: "REPO", name: "main", oid: "a".repeat(40) },
				head: { repositoryId: "REPO", name: "topic", oid: "b".repeat(40) },
				closingIssues: [],
			},
		},
		writerId: "W",
		activation: [],
		criteria: [],
	};
}

function encoding(current: ReviewSubject) {
	const value = deriveAllowancePathEncoding(current);
	assert.ok(value !== undefined);
	return value;
}

function record(current: ReviewSubject): ClaimedRecordV3 {
	const path = encoding(current);
	const now = new Date().toISOString();
	return {
		schemaVersion: 3,
		state: "claimed",
		repoHash: path.repoHash,
		keyHash: path.keyHash,
		claimId: randomUUID(),
		createdAt: now,
		updatedAt: now,
		profileSetDigest: "1".repeat(64),
		subjectDigest: "2".repeat(64),
		historyDigest: "3".repeat(64),
		basisDigest: "4".repeat(64),
		basis: {
			kind: "history-diagnosis",
			triggeringReviewState: { head: "a".repeat(40), historyIndex: 0, stateDigest: "5".repeat(64) },
			taxonomy: "STAGNATION",
			invalidation: "nothing",
			diagnosisDigest: "6".repeat(64),
		},
		modes: { mergeMode: "off", decisionMode: "autonomous", mergeSource: "default", decisionSource: "default" },
		route: "stagnation",
		attempts: [],
		completeness: null,
		sequenceAuthority: null,
		selectedIntervention: null,
		measurement: null,
		freshRuling: null,
		reentry: "nothing",
		nextGate: null,
		terminal: null,
		cause: null,
	};
}

function consumed(claimed: ClaimedRecordV3): ConsumedRecordV3 {
	return {
		...claimed,
		state: "consumed",
		updatedAt: new Date(Date.now() + 1).toISOString(),
		attempts: [],
		completeness: {
			requiredSlots: ["stagnation-root", "stagnation-blast-radius", "recovery-selector"],
			admittedSlots: [],
		},
		sequenceAuthority: { source: "host-attempt-order", lastSequence: 0, retrySlots: [] },
		selectedIntervention: null,
		measurement: null,
		freshRuling: null,
		reentry: "nothing",
		nextGate: "park",
		terminal: "handoff",
		cause: "recovery-failed",
	};
}

describe("state-domain allowance store", () => {
	it("claims once, persists complete bytes, and atomically terminalizes without reopening", () => {
		const current = subject();
		const claimed = record(current);
		const first = claimAllowance({ subject: current, record: claimed });
		assert.equal(first.status, "claimed");
		if (first.status !== "claimed") return;
		const leaf = encoding(current).leaf;
		const path = join(stateRoot, "gitjig", "recovery", leaf);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).state, "claimed");
		const concurrent = claimAllowance({ subject: current, record: record(current) });
		assert.equal(concurrent.status, "consumed");
		assert.equal(finalizeAllowance(first.claim, consumed(claimed)).status, "finalized");
		assert.equal(JSON.parse(readFileSync(path, "utf8")).state, "consumed");
		assert.equal(finalizeAllowance(first.claim, consumed(claimed)).status, "consumed-unverified");
	});

	it("treats malformed existing bytes as consumed without a record reference", () => {
		const current = subject("PR_BAD");
		const pathEncoding = encoding(current);
		mkdirSync(join(stateRoot, "gitjig", "recovery"), { recursive: true, mode: 0o700 });
		const path = join(stateRoot, "gitjig", "recovery", pathEncoding.leaf);
		writeFileSync(path, "partial", { mode: 0o600 });
		const result = claimAllowance({ subject: current, record: record(current) });
		assert.deepEqual(result, { status: "consumed", cause: "existing" });
	});

	it("keeps definite preclaim domain refusal unconsumed", () => {
		process.env.GITJIG_TEST_STATE_ROOT = "";
		const current = subject("PR_PRECLAIM");
		assert.deepEqual(claimAllowance({ subject: current, record: record(current) }), {
			status: "preclaim-refused",
			cause: "state-domain",
		});
	});
});

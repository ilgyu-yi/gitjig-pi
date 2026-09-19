import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const spec = readFileSync("SPEC.md", "utf8");
const authorization = readFileSync(".pi/extensions/gitjig/landing/topology-authorization.ts", "utf8");
const vocabulary = readFileSync(".pi/extensions/gitjig/landing/source-split-contract.ts", "utf8");
const readme = readFileSync("README.md", "utf8");
const postures = readFileSync(".pi/extensions/gitjig/postures.ts", "utf8");

const topology = spec.slice(
	spec.indexOf("**Phase-4 topology and bootstrap.**"),
	spec.indexOf("**The local tier's door"),
);

function requires(subject: string, tokens: readonly string[]): void {
	for (const token of tokens) assert.ok(subject.includes(token), `missing source-split contract token: ${token}`);
}

function interfaceMembers(name: string): string[] {
	const match = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(vocabulary);
	assert.ok(match, `missing interface: ${name}`);
	return match[1]
		.trim()
		.split("\n")
		.map((line) => line.trim());
}

function assertContract(subject: string): void {
	requires(subject, [
		"**Source-split application contract.**",
		"core PATCH, quorum-only `human-approval` POST/PATCH",
		"GitHub Actions integration, complete rulesets, and the application Issue/comments",
		"immediate GET-before-write is the recorded optimistic-emulation residual",
		"Mismatch never continues or rolls back automatically",
		"`{schemaVersion,repositoryId,issueId,issueNumber,stage,planHash,pairKey,correlationId,issuedAt,expiresAt}`",
		"`{repositoryId,defaultBranch,beforeDigest,optimisticRulesets}`",
		"preflight → claim →, for every order, compare → write → post-read → record → final handed-over audit → terminal",
		"lowest valid append-only claim REST database id wins",
		"exact target without matching records is not success",
		"<!-- topology-source-claim: v1 -->",
		"<!-- topology-source-step: v1 -->",
		"<!-- topology-source-terminal: v1 -->",
		"Authorization id is null exactly for zero or multiple marked authorization candidates",
		"Comment publication is a platform write but not source topology mutation",
		"does not arm the topology carrier, bootstrap, pilot or guarded landing",
		"This settlement exports data vocabulary only",
	]);
}

test("#289 settles source-split application without deriving a writer", () => {
	assertContract(topology);
	requires(readme, [
		"Source application is record-first and stepwise",
		"no source executor or production mutation call site",
	]);
	requires(postures, [
		"The Phase-4 scratch proof supports only a quorum-only RepositoryRole-5 pull-request bypass",
		"the completed proof itself grants no source mutation",
	]);
	requires(authorization, [
		'TOPOLOGY_SOURCE_CLAIM_MARKER = "<!-- topology-source-claim: v1 -->"',
		'TOPOLOGY_SOURCE_STEP_MARKER = "<!-- topology-source-step: v1 -->"',
		'TOPOLOGY_SOURCE_TERMINAL_MARKER = "<!-- topology-source-terminal: v1 -->"',
	]);
	requires(vocabulary, [
		"export interface TopologySourceClaimRecord",
		"export interface TopologySourceStepRecord",
		"export type TopologySourceTerminalRecord",
		"deliberately exports no parser, writer, executor, or production call site",
	]);
	assert.deepEqual(interfaceMembers("TopologySourceClaimRecord"), [
		"schemaVersion: 1;",
		"repositoryId: string;",
		"issueId: string;",
		"authorizationRecordId: string;",
		"planHash: string;",
		"pairKey: string;",
		"correlationId: string;",
		"writerId: string;",
		"claimedAt: string;",
	]);
	assert.deepEqual(interfaceMembers("TopologySourceStepRecord"), [
		"schemaVersion: 1;",
		"repositoryId: string;",
		"issueId: string;",
		"claimCommentId: string;",
		"authorizationRecordId: string;",
		"planHash: string;",
		"pairKey: string;",
		"order: number;",
		'method: "PATCH" | "POST" | "DELETE";',
		"path: string;",
		"requestBodyDigest: string | null;",
		"beforeStateDigest: string;",
		"afterStateDigest: string;",
		"observedAt: string;",
		"writerId: string;",
	]);
	assert.deepEqual(interfaceMembers("TopologySourceMismatch"), [
		"arm: string;",
		"condition: string;",
		"observedDigest: string | null;",
	]);
	assert.deepEqual(interfaceMembers("TopologySourceTerminalBase"), [
		"schemaVersion: 1;",
		"repositoryId: string;",
		"issueId: string;",
		"completedOrders: number[];",
		"lastVerifiedStateDigest: string | null;",
		"observedMismatch: TopologySourceMismatch | null;",
		"remainingOrders: number[];",
		"writerId: string;",
		"observedAt: string;",
	]);
	requires(vocabulary, [
		"export type TopologySourceTerminalRecord = TopologySourceTerminalBase &",
		"authorizationRecordId: null;",
		"claimCommentId: null;",
		'outcome: "refused";',
		"expiresAt: null;",
		"authorizationRecordId: string;",
		"expiresAt: string;",
		'outcome: "partial" | "success";',
	]);
	assert.doesNotMatch(
		`${authorization}\n${vocabulary}`,
		/export (?:async )?function (?:execute|apply|mutate)TopologySource/u,
	);
});

test("#296 closes expiry evidence for unique unattested candidates", () => {
	requires(topology, [
		"a unique marked candidate uses its platform GraphQL comment node id even when its payload is unattested",
		"It may be null only on a pre-claim refused/no-source-write",
		"Null expiry is forbidden for `authorization-stale`, `stage-mismatch`, `pair-mismatch`",
		"No candidate-selected invalid field, plan, caller value, or current instant supplies a fabricated expiry",
	]);
	assert.equal(vocabulary.match(/expiresAt: null;/gu)?.length, 2);
	assert.equal(vocabulary.match(/expiresAt: string;/gu)?.length, 2);
	assert.match(
		vocabulary,
		/authorizationRecordId: null;[\s\S]*?claimCommentId: null;[\s\S]*?outcome: "refused";[\s\S]*?expiresAt: null;/u,
	);
	assert.match(
		vocabulary,
		/authorizationRecordId: string;[\s\S]*?claimCommentId: null;[\s\S]*?outcome: "refused";[\s\S]*?expiresAt: null;/u,
	);
	assert.doesNotMatch(vocabulary, /authorizationRecordId: string \| null;[\s\S]*?expiresAt: string \| null;/u);
});

test("#289 contract mutants fail at their missing member", () => {
	for (const { anchor, replacement } of [
		{
			anchor: "immediate GET-before-write is the recorded optimistic-emulation residual",
			replacement: "the plan is a sufficient optimistic comparison",
		},
		{
			anchor: "Mismatch never continues or rolls back automatically",
			replacement: "Mismatch may continue or roll back automatically",
		},
		{
			anchor: "exact target without matching records is not success",
			replacement: "exact target without matching records is success",
		},
		{
			anchor: "Authorization id is null exactly for zero or multiple marked authorization candidates",
			replacement: "Authorization id may be null for any refusal",
		},
		{
			anchor: "does not arm the topology carrier, bootstrap, pilot or guarded landing",
			replacement: "arms the topology carrier and guarded landing",
		},
	] as const) {
		const mutated = topology.replace(anchor, replacement);
		assert.notEqual(mutated, topology, `mutant anchor did not match: ${anchor}`);
		assert.throws(
			() => assertContract(mutated),
			(error: unknown) => error instanceof Error && error.message === `missing source-split contract token: ${anchor}`,
		);
	}
});

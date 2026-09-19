import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const spec = readFileSync("SPEC.md", "utf8");
const authorization = readFileSync(".pi/extensions/gitjig/landing/topology-authorization.ts", "utf8");
const vocabulary = readFileSync(".pi/extensions/gitjig/landing/source-split-contract.ts", "utf8");
const readme = readFileSync("README.md", "utf8");

const topology = spec.slice(
	spec.indexOf("**Phase-4 topology and bootstrap.**"),
	spec.indexOf("**The local tier's door"),
);

function requires(subject: string, tokens: readonly string[]): void {
	for (const token of tokens) assert.ok(subject.includes(token), `missing source-split contract token: ${token}`);
}

function assertContract(subject: string): void {
	requires(subject, [
		"**Source-split application contract.**",
		"core PATCH, quorum-only `human-approval` POST/PATCH",
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
		"authorization id is null only for `authorization-absent` or `authorization-ambiguous`",
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
	requires(authorization, [
		'TOPOLOGY_SOURCE_CLAIM_MARKER = "<!-- topology-source-claim: v1 -->"',
		'TOPOLOGY_SOURCE_STEP_MARKER = "<!-- topology-source-step: v1 -->"',
		'TOPOLOGY_SOURCE_TERMINAL_MARKER = "<!-- topology-source-terminal: v1 -->"',
	]);
	requires(vocabulary, [
		"export interface TopologySourceClaimRecord",
		"export interface TopologySourceStepRecord",
		"export interface TopologySourceTerminalRecord",
		"deliberately exports no parser, writer, executor, or production call site",
	]);
	assert.doesNotMatch(
		`${authorization}\n${vocabulary}`,
		/export (?:async )?function (?:execute|apply|mutate)TopologySource/u,
	);
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
			anchor: "authorization id is null only for `authorization-absent` or `authorization-ambiguous`",
			replacement: "authorization id may be null on refusal",
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

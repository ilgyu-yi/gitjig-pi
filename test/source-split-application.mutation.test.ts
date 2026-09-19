import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(".pi/extensions/gitjig/landing/source-split-service.ts", "utf8");
const platform = readFileSync(".pi/extensions/gitjig/landing/source-split-platform.ts", "utf8");
const command = readFileSync(".pi/extensions/gitjig/commands/source-split.ts", "utf8");

const tokens = [
	"sourcePopulationArm(input, authorization.recordId, effects.canonicalInstant)",
	"sourcePopulationArm(liveInput, authorization.recordId, effects.canonicalInstant)",
	"claims[0]?.comment.nodeId !== written.nodeId",
	"recordedOrders.some((order, index) => order !== index + 1)",
	"item.record.beforeStateDigest !== topologySourceDigest(expectedBefore)",
	"terminal.claimCommentId !== claimId",
	"terminal.lastVerifiedStateDigest !== input.plan.desiredDigest",
	"existing.length !== input.plan.steps.length",
	"const before = await effects.readState(expectedBefore)",
	"const mutation = await effects.mutate(step)",
	"const after = await effects.readState(step.postRead)",
	'return publishTerminal("write-unverified"',
	'return publishTerminal("postread-mismatch"',
	"if (!(await effects.auditFinal()))",
	"written.body !== body",
] as const;

function assertApplicationGuards(subject: string): void {
	for (const token of tokens) assert.ok(subject.includes(token), `missing source application guard: ${token}`);
	assert.ok(
		subject.indexOf("const before = await effects.readState(expectedBefore)") <
			subject.indexOf("const mutation = await effects.mutate(step)"),
	);
	assert.ok(
		subject.indexOf("const mutation = await effects.mutate(step)") <
			subject.indexOf("const after = await effects.readState(step.postRead)"),
	);
	assert.doesNotMatch(subject, /effects\.mutate\([^)]*rollback|for \([^)]*rollback/u);
}

test("#293 planted service mutants lose a required guard or ordering edge", () => {
	assertApplicationGuards(service);
	for (const token of tokens) {
		const mutated = service.replaceAll(token, "/* planted deletion */");
		assert.notEqual(mutated, service, `mutant anchor missing: ${token}`);
		assert.throws(() => assertApplicationGuards(mutated), /missing source application guard|false == true/u);
	}
	const reordered = service.replace(
		"const before = await effects.readState(expectedBefore)",
		"const before = await effects.readState(step.postRead)",
	);
	assert.throws(() => assertApplicationGuards(reordered));
});

test("#293 has one operator and closed source mutation path", () => {
	assert.match(command, /registerCommand\("source-split"/u);
	assert.match(command, /loadTopologySourceApplication/u);
	assert.match(platform, /executeTopologySourceSplit\(loaded\.input, loaded\.effects\)/u);
	assert.match(platform, /step\.path\.replace/u);
	assert.match(platform, /filter\(\(item\) => item\.name === "human-approval"\)\.length !== 1/u);
	assert.match(platform, /"--method", step\.method/u);
	assert.doesNotMatch(platform, /plan\.rollback|\.rollback\)/u);
});

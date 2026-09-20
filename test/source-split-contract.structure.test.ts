import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const spec = readFileSync("SPEC.md", "utf8");
const readme = readFileSync("README.md", "utf8");
const adr = readFileSync("docs/adr/0001-maintainer-terminal-governance.md", "utf8");

function settlement(text: string): void {
	for (const token of [
		"source-split authority",
		"superseded-dormant migration inputs only",
		"authorize no operation",
		"admit no new caller",
		"No live ruleset or repository-setting mutation is authorized",
		"Source-split and configurable-plan artifacts are non-interchangeable",
	])
		assert.ok(text.includes(token), `missing supersession token: ${token}`);
}

test("#293 source-split authority is superseded rather than silently reused", () => {
	settlement(spec);
	assert.ok(readme.includes("must not be authorized or executed"));
	assert.ok(adr.includes("#293 source-split plan and marker must not be authorized or executed"));
});

test("retained runtime receives one bounded removal owner", () => {
	for (const token of [
		"retire `bootstrap.ts`, `provenance.ts`, `topology-authorization.ts`",
		"retire `attestTopologyPlan` and `loadTopologyAuthorization`",
		"| 6 | new Execution | Retire remaining old source-split/topology/policy assets",
		"hard prerequisite of Phase 7",
	])
		assert.ok(spec.includes(token), `missing migration token: ${token}`);
});

test("the replacement apply contract does not inherit marker/claim machinery", () => {
	for (const token of [
		"supersedes #286/#289's source-split marker",
		"no Issue marker, escape record or claim population is required",
		"--confirm-plan-hash <hash>",
		"Partial or ambiguous writes stop",
	])
		assert.ok(spec.includes(token), `missing replacement token: ${token}`);
});

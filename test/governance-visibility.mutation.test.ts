import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const engine = readFileSync(new URL("../.github/workflows/gitjig-governance.mjs", import.meta.url), "utf8");
const service = readFileSync(new URL("../.github/workflows/gitjig-governance-service.mjs", import.meta.url), "utf8");
const command = readFileSync(new URL("../.pi/extensions/gitjig/commands/governance.ts", import.meta.url), "utf8");

const teeth = [
	[engine, "audit: 32 * 1024", "audit: 31 * 1024"],
	[engine, "result: 32 * 1024", "result: 31 * 1024"],
	[engine, "presentation: 32 * 1024", "presentation: 31 * 1024"],
	[
		engine,
		"canonicalByteLength(parsedConfig) + canonicalByteLength(parsedMeasured)",
		"canonicalByteLength(parsedMeasured)",
	],
	[
		service,
		"canonicalByteLength(result.completed) + canonicalByteLength(result.remaining)",
		"canonicalByteLength(result.completed)",
	],
	[service, "canonicalByteLength(supplied.operations) + 2", "canonicalByteLength(supplied.operations) + 1"],
	[
		service,
		"canonicalByteLength(supplied) + currentBytes + auditBytes + GOVERNANCE_OVERHEADS.result",
		"canonicalByteLength(supplied) + auditBytes + GOVERNANCE_OVERHEADS.result",
	],
	[
		service,
		"canonicalByteLength(candidate) + GOVERNANCE_BOUNDS.config + GOVERNANCE_OVERHEADS.presentation",
		"canonicalByteLength(candidate) + GOVERNANCE_OVERHEADS.presentation",
	],
	[command, "const PLAN_BOUND = 256 * 1024", "const PLAN_BOUND = 257 * 1024"],
	[command, "const AUDIT_BOUND = 128 * 1024", "const AUDIT_BOUND = 129 * 1024"],
	[command, "const PRESENTATION_BOUND = 320 * 1024", "const PRESENTATION_BOUND = 321 * 1024"],
	[command, "const APPLY_RESULT_BOUND = 480 * 1024", "const APPLY_RESULT_BOUND = 481 * 1024"],
	[command, "const WRAPPER_OVERHEAD = 1024", "const WRAPPER_OVERHEAD = 1025"],
] as const;

function admitsExactContract(candidate: string, original: string, expected: string): boolean {
	return candidate === original && candidate.includes(expected);
}

describe("governance visibility bound mutation teeth", () => {
	for (const [original, term, replacement] of teeth) {
		it(`kills mutation ${term} -> ${replacement}`, () => {
			assert.ok(original.includes(term), `missing authored term: ${term}`);
			const mutant = original.replace(term, replacement);
			assert.notEqual(mutant, original);
			assert.equal(admitsExactContract(mutant, original, term), false);
			assert.equal(admitsExactContract(original, original, term), true);
		});
	}
});

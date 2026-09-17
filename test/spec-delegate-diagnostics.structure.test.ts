import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const root = repoRoot();
const spec = readFileSync(join(root, "SPEC.md"), "utf8");

function section(heading: string, nextHeading: string): string {
	const start = spec.indexOf(heading);
	const end = spec.indexOf(nextHeading, start + heading.length);
	assert.ok(start >= 0 && end > start, `SPEC section bounds are missing: ${heading} -> ${nextHeading}`);
	return spec.slice(start, end);
}

function requireTokens(subject: string, label: string, tokens: readonly string[]): void {
	for (const token of tokens) {
		assert.ok(subject.includes(token), `${label} is missing the contract token ${JSON.stringify(token)}`);
	}
}

function sourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			files.push(...sourceFiles(path));
		} else if (/\.(?:ts|mjs)$/.test(entry)) {
			files.push(path);
		}
	}
	return files;
}

const panel = section("### 1.7 The reviewer panel", "### 1.8 Plan contest");
const delegated = section("### 3.10 Delegated computation", "### 3.11 Gate design");
const layer = section("### 4.9 The delegation layer", "## 5. Cross-cutting contracts");

describe("Directive #262 contract settlement", () => {
	it("§1.7 fixes the one automatic return-protocol redispatch without turning it into a verdict", () => {
		requireTokens(panel, "SPEC §1.7", [
			"automatic return-protocol redispatch",
			"numeric exit",
			"missing return",
			"exactly once",
			"retry-return-protocol",
			"Return protocol reminder:",
		]);
	});

	it("§3.10 scopes numeric-exit admission to dispatcher return-slot delegation", () => {
		requireTokens(delegated, "SPEC §3.10", [
			"Dispatcher-scoped return-slot rule",
			"zero or nonzero numeric exit",
			"complete provisional return",
			"signal termination, timeout, and abort",
			"non-dispatch delegated consumer",
			"outcome-unverified",
		]);
	});

	it("§4.9 closes the diagnostic grammar, fixed codes, budgets, and surface separation", () => {
		requireTokens(layer, "SPEC §4.9", [
			"Dispatcher diagnostic envelope",
			"schemaVersion: 1",
			'phase: "preflight" | "provision" | "spawn" | "run" | "return" | "compare" | "serialize"',
			'run.class: "not-started" | "exited" | "signaled" | "timed-out" | "aborted" | "internal-failed"',
			'return.class: "not-inspected" | "missing" | "not-regular" | "oversize" | "unreadable" | "json-invalid" | "schema-invalid" | "operand-rejected" | "admitted"',
			'compare.class: "not-reached" | "not-requested" | "confirmed" | "invalid"',
			"PARAMETER_REFUSED",
			"PROVISION_FAILED",
			"SPAWN_FAILED",
			"SIGNAL_TERMINATED",
			"TIMED_OUT",
			"ABORTED",
			"RETURN_MISSING",
			"RETURN_NOT_REGULAR",
			"RETURN_OVERSIZE",
			"RETURN_UNREADABLE",
			"RETURN_JSON_INVALID",
			"RETURN_SCHEMA_INVALID",
			"RETURN_OPERAND_REJECTED",
			"INTERNAL_FAILED",
			"ADMITTED",
			"524,288 UTF-8 bytes",
			"4,096 UTF-8 bytes",
			"2,048 UTF-8 bytes",
		]);
	});

	it("§4.9 states total precedence and impossible combinations", () => {
		requireTokens(layer, "SPEC §4.9", [
			"Lifecycle and return precedence",
			"Parameter refusal precedes provisioning",
			"A claimed timeout, abort, or signal termination precedes return inspection",
			"Every numeric exit reaches return inspection",
			"Impossible combinations",
			"Only `INTERNAL_FAILED` may preserve `return.class=\"admitted\"` with `status=\"refused\"`",
		]);
	});

	it("non-dispatch §3.10 call sites do not absorb dispatcher diagnostic or retry vocabulary", () => {
		const cited = sourceFiles(root)
			.filter((path) => !path.includes(`${join(root, "node_modules")}`))
			.filter((path) => path !== new URL(import.meta.url).pathname)
			.filter((path) => readFileSync(path, "utf8").includes("§3.10"));
		const nonDispatch = cited.filter((path) => {
			const rel = relative(root, path).replaceAll("\\", "/");
			return !rel.startsWith(".pi/extensions/gitjig/dispatch/") &&
				!rel.startsWith(".pi/extensions/gitjig/review/") &&
				!rel.startsWith(".pi/extensions/gitjig/commands/review");
		});
		assert.ok(nonDispatch.length > 0, "the §3.10 consumer sweep found no non-dispatch control population");
		for (const path of nonDispatch) {
			const body = readFileSync(path, "utf8");
			for (const token of ["DispatcherDiagnostic", "retry-return-protocol", "RETURN_MISSING"]) {
				assert.ok(
					!body.includes(token),
					`${relative(root, path)} is a non-dispatch §3.10 consumer but absorbed ${token}`,
				);
			}
		}
	});
});

import assert from "node:assert/strict";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./harness/run-pi.ts";

const root = repoRoot();
const spec = readFileSync(join(root, "SPEC.md"), "utf8");
const thisFile = fileURLToPath(import.meta.url);

function section(source: string, heading: string, nextHeading: string): string {
	const start = source.indexOf(heading);
	const end = source.indexOf(nextHeading, start + heading.length);
	assert.ok(start >= 0 && end > start, `SPEC section bounds are missing: ${heading} -> ${nextHeading}`);
	return source.slice(start, end);
}

function requireTokens(subject: string, label: string, tokens: readonly string[]): void {
	for (const token of tokens) {
		assert.ok(subject.includes(token), `${label} is missing the contract token ${JSON.stringify(token)}`);
	}
}

function panelContract(source: string): void {
	requireTokens(section(source, "### 1.7 The reviewer panel", "### 1.8 Plan contest"), "SPEC §1.7", [
		"automatic return-protocol redispatch",
		"numeric exit and a missing return",
		"retries exactly once",
		"initially `available`, and changes it to `spent` before sending the retry",
		"unrelated to §1.4's per-lineage recovery allowance",
		"retry-return-protocol",
		"\\n\\nReturn protocol reminder: write a complete provisional ../return.json early and overwrite it with the final closed-schema return.",
		"no third dispatch occurs within that orchestrator invocation",
		"separately initiated later review round remains",
		"neither supplies a result nor creates a verdict",
		"cause-keyed, identical-brief retry in the current orchestrator is retired",
	]);
}

function delegatedContract(source: string): void {
	requireTokens(section(source, "### 3.10 Delegated computation", "### 3.11 Gate design"), "SPEC §3.10", [
		"Dispatcher-scoped return-slot rule",
		"zero or nonzero numeric exit",
		"A valid complete return is admitted on output validity alone regardless of that exit code.",
		"complete provisional return",
		"dispatcher cannot attest how much investigation preceded those bytes",
		"signal termination, timeout, and abort",
		"non-dispatch delegated consumer",
		"outcome-unverified",
		"current dispatcher's pre-inspection nonzero-exit refusal is a tracked code defect",
	]);
}

const CODE_MESSAGES = [
	"PARAMETER_REFUSED        | dispatch refused: dispatcher parameters were invalid; nothing started",
	"PROVISION_FAILED         | dispatch refused: the isolated execution context could not be provisioned; nothing started",
	"SPAWN_FAILED             | dispatch refused: the delegate could not be started; no return was inspected",
	"SIGNAL_TERMINATED        | dispatch refused: the delegate terminated by signal; no return was inspected",
	"TIMED_OUT                | dispatch refused: the delegate exceeded its run bound; no return was inspected",
	"ABORTED                  | dispatch refused: the delegate run was aborted; no return was inspected",
	"RETURN_MISSING           | dispatch refused: no return file was present after the delegate exited",
	"RETURN_NOT_REGULAR       | dispatch refused: the return slot was not a regular file",
	"RETURN_OVERSIZE          | dispatch refused: the return exceeded the 65536-byte bound",
	"RETURN_UNREADABLE        | dispatch refused: the return could not be read exactly",
	"RETURN_JSON_INVALID      | dispatch refused: the return was not valid UTF-8 JSON",
	"RETURN_SCHEMA_INVALID    | dispatch refused: the return did not match the closed schema",
	"RETURN_OPERAND_REJECTED  | dispatch refused: the return named a caller-held operand",
	"INTERNAL_FAILED          | dispatch refused: the dispatcher encountered an internal failure",
	"ADMITTED                 | dispatch admitted",
] as const;

function layerContract(source: string): void {
	requireTokens(section(source, "### 4.9 The delegation layer", "## 5. Cross-cutting contracts"), "SPEC §4.9", [
		"Dispatcher diagnostic envelope",
		"current dispatcher lacks this envelope and remains a tracked code defect",
		"schemaVersion: 1",
		'phase: "preflight" | "provision" | "spawn" | "run" | "return" | "compare" | "serialize"',
		'run.class: "not-started" | "exited" | "signaled" | "timed-out" | "aborted" | "internal-failed"',
		'return.class: "not-inspected" | "missing" | "not-regular" | "oversize" | "unreadable" | "json-invalid" | "schema-invalid" | "operand-rejected" | "admitted"',
		'compare.class: "not-reached" | "not-requested" | "confirmed" | "invalid"',
		"immediately before entered-handler parameter validation through completion of outcome serialization",
		"signed-32-bit integer `exitCode`",
		"^SIG[A-Z0-9]{1,12}$",
		"sentinel string `unavailable`",
		...CODE_MESSAGES,
		"Lifecycle and return precedence",
		"Parameter refusal precedes provisioning",
		"A claimed timeout, abort, or signal termination precedes return inspection",
		"Every numeric exit reaches return inspection",
		"internal before run outcome | current phase | internal-failed",
		"internal after run outcome  | current phase | preserved observed run class",
		"Impossible combinations",
		'Only `INTERNAL_FAILED` may preserve `return.class="admitted"` with `status="refused"`',
		"refusal is exactly the compact JSON serialization of the diagnostic",
		"complete return file remains at most 65,536 bytes",
		"524,288 UTF-8 bytes",
		"diagnostic serialization is at most 1,536 UTF-8 bytes",
		"2,048 UTF-8 bytes",
		"4,096 UTF-8 bytes",
		"never carries summary, payload, or raw trace",
	]);
}

function validateContract(source: string): void {
	panelContract(source);
	delegatedContract(source);
	layerContract(source);
}

function sourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			continue;
		}
		if (stat.isDirectory()) {
			files.push(...sourceFiles(path));
		} else if (/\.(?:ts|mjs)$/.test(entry)) {
			files.push(path);
		}
	}
	return files;
}

describe("Execution #264 contract settlement", () => {
	it("pins §1.7's bounded automatic retry and its separation from verdicts and later rounds", () => {
		panelContract(spec);
	});

	it("pins §3.10's dispatcher scope, complete-output residual, and non-dispatch boundary", () => {
		delegatedContract(spec);
	});

	it("pins §4.9's complete grammar, messages, precedence, surfaces, and every byte bound", () => {
		layerContract(spec);
	});

	it("kills representative meaning-inverting SPEC mutants", () => {
		const mutants = [
			spec.replace("no third dispatch occurs within that orchestrator invocation", "keeps dispatching without a bound"),
			spec.replace("retries exactly once", "retries repeatedly"),
			spec.replace(
				"A valid complete return is admitted on output validity alone regardless of that exit code.",
				"A valid complete return is refused whenever the exit code is nonzero.",
			),
			spec.replace("diagnostic serialization is at most 1,536 UTF-8 bytes", "diagnostic serialization is unbounded"),
			spec.replace("complete return file remains at most 65,536 bytes", "complete return file has no bound"),
			spec.replace(CODE_MESSAGES[6], "RETURN_MISSING           | any message the child supplies"),
			spec.replace("^SIG[A-Z0-9]{1,12}$", "any string the child supplies"),
			spec.replace("never carries summary, payload, or raw trace", "may carry summary, payload, and raw trace"),
		];
		for (const mutant of mutants) {
			assert.notEqual(mutant, spec, "the mutation fixture failed to alter SPEC.md");
			assert.throws(() => validateContract(mutant));
		}
	});

	it("keeps production non-dispatch §3.10 consumers free of dispatcher-only vocabulary", () => {
		const productionRoots = [join(root, ".pi", "extensions", "gitjig"), join(root, ".github")];
		const cited = productionRoots
			.flatMap(sourceFiles)
			.filter((path) => path !== thisFile)
			.filter((path) => readFileSync(path, "utf8").includes("§3.10"));
		const nonDispatch = cited.filter((path) => {
			const rel = relative(root, path).replaceAll("\\", "/");
			return (
				!rel.startsWith(".pi/extensions/gitjig/dispatch/") &&
				!rel.startsWith(".pi/extensions/gitjig/review/") &&
				!rel.startsWith(".pi/extensions/gitjig/commands/review")
			);
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
		const publisher = readFileSync(join(root, ".pi/extensions/gitjig/publish/executor.ts"), "utf8");
		requireTokens(publisher, "publish executor control", ["code === 0", 'settle({ outcome: "outcome-unverified" })']);
	});
});

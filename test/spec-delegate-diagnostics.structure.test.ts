import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const root = repoRoot();
const spec = readFileSync(join(root, "SPEC.md"), "utf8");

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

function normalizedRows(block: string): string[] {
	return block
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.includes("|"))
		.map((line) =>
			line
				.split("|")
				.map((cell) => cell.trim())
				.join(" | "),
		);
}

function fencedAfter(subject: string, anchor: string): string {
	const start = subject.indexOf(anchor);
	assert.ok(start >= 0, `missing fenced-block anchor ${anchor}`);
	const open = subject.indexOf("```text\n", start);
	const close = subject.indexOf("\n```", open + 8);
	assert.ok(open >= 0 && close > open, `missing text fence after ${anchor}`);
	return subject.slice(open + 8, close);
}

function panelContract(source: string): void {
	requireTokens(section(source, "### 1.7 The reviewer panel", "### 1.8 Plan contest"), "SPEC §1.7", [
		"automatic return-protocol redispatch",
		"numeric exit and a missing return",
		"retries exactly once",
		"Every dispatcher call made by the review orchestrator",
		"a required panel slot, a Judge or history-diagnosis call",
		"a discretionary same-round or later-round redispatch",
		"sibling calls never share or replenish it",
		"unrelated to §1.4's per-lineage recovery allowance",
		"standing brief contract for each such call instructs the delegate",
		"repeats the same options and pin",
		"\\n\\nReturn protocol reminder: write a complete provisional ../return.json early and overwrite it with the final closed-schema return.",
		"each written `\\n` denotes one U+000A byte sequence",
		"no third send occurs for that call",
		"new call with its own one-retry bound",
		"neither supplies a result nor creates a verdict",
		"retry-return-protocol` through the optional in-process event callback it owns",
		"fixture consumes that callback to prove one event corresponds to exactly one authorized second send",
		"not a delegate JSON event, audit record, operator trace, tool content, details, or session message",
		"A throwing callback degrades open",
		"chosen silence registered at §5.2",
		"cause-keyed, identical-brief retry in the current orchestrator is retired",
		"diagnostic envelope lands first",
		"activate this paragraph under §5.3",
	]);
	requireTokens(section(source, "### 5.2 Graceful degradation", "### 5.3 Gate-activation conditions"), "SPEC §5.2", [
		"Two silences are chosen rather than inherited",
		"§1.7's optional retry-event callback is fixture-only",
		"no production or session surface exists on which to announce that loss",
	]);
}

function delegatedContract(source: string): void {
	requireTokens(section(source, "### 3.10 Delegated computation", "### 3.11 Gate design"), "SPEC §3.10", [
		"Dispatcher-scoped return-slot rule",
		"zero or nonzero numeric exit",
		"A valid complete return is admitted on output validity alone regardless of that exit code.",
		"closed return schema and the consuming role's existing result grammar are both satisfied",
		"dispatcher cannot attest how much investigation preceded those bytes",
		"Requiring every early provisional to carry a non-clear verdict is the rejected mitigation",
		"panel completeness, Judge or history-diagnosis input, gated approval evidence",
		"complete-panel prerequisite on an unattended ready path",
		"second instance of §1.6's named deferred limitation",
		"bypass vector of §3.3's `merge-review` row",
		"§4.9 dispatcher derivation cycle owns hardening it",
		"observed early clear that differs from the later overwrite's verdict",
		"malformed, incomplete, missing, or wrong-surface output remains no result",
		"A complete provisional return remains complete output when the process later exits nonzero",
		"signal termination, timeout, and abort do not inspect or admit a return",
		"non-dispatch delegated consumer keeps its own settled output predicate",
		"outcome-unverified",
		"No dispatcher diagnostic code or retry predicate transfers by analogy.",
		"current dispatcher's pre-inspection nonzero-exit refusal is a tracked code defect",
		"sleeps as runtime behavior under §5.3",
	]);
}

const DIAGNOSTIC_GRAMMAR = [
	"diagnostic = {",
	"schemaVersion: 1,",
	'status: "admitted" | "refused",',
	'phase: "preflight" | "provision" | "spawn" | "run" | "return" | "compare" | "serialize",',
	"run: { class, exitCode, signal },",
	"return: { class },",
	"compare: { class },",
	"durationMs,",
	"code,",
	"message",
	"}",
	'run.class: "not-started" | "exited" | "signaled" | "timed-out" | "aborted" | "internal-failed"',
	'return.class: "not-inspected" | "missing" | "not-regular" | "oversize" | "unreadable" | "json-invalid" | "schema-invalid" | "operand-rejected" | "admitted"',
	'compare.class: "not-reached" | "not-requested" | "confirmed" | "invalid"',
] as const;

const CODE_MESSAGES = [
	"PARAMETER_REFUSED | dispatch refused: dispatcher parameters were invalid; nothing started",
	"PROVISION_FAILED | dispatch refused: the isolated execution context could not be provisioned; nothing started",
	"SPAWN_FAILED | dispatch refused: the delegate could not be started; no return was inspected",
	"SIGNAL_TERMINATED | dispatch refused: the delegate terminated by signal; no return was inspected",
	"TIMED_OUT | dispatch refused: the delegate exceeded its run bound; no return was inspected",
	"ABORTED | dispatch refused: the delegate run was aborted; no return was inspected",
	"RETURN_MISSING | dispatch refused: no return file was present after the delegate exited",
	"RETURN_NOT_REGULAR | dispatch refused: the return slot was not a regular file",
	"RETURN_OVERSIZE | dispatch refused: the return exceeded the 65536-byte bound",
	"RETURN_UNREADABLE | dispatch refused: the return could not be read exactly",
	"RETURN_JSON_INVALID | dispatch refused: the return was not valid UTF-8 JSON",
	"RETURN_SCHEMA_INVALID | dispatch refused: the return did not match the closed schema",
	"RETURN_OPERAND_REJECTED | dispatch refused: the return named a caller-held operand",
	"INTERNAL_FAILED | dispatch refused: the dispatcher encountered an internal failure",
	"ADMITTED | dispatch admitted",
] as const;

const PRECEDENCE_ROWS = [
	"parameter refusal | preflight | not-started | not-inspected | not-reached | PARAMETER_REFUSED",
	"provision failure | provision | not-started | not-inspected | not-reached | PROVISION_FAILED",
	"spawn failure | spawn | not-started | not-inspected | not-reached | SPAWN_FAILED",
	"timeout | run | timed-out | not-inspected | not-reached | TIMED_OUT",
	"abort | run | aborted | not-inspected | not-reached | ABORTED",
	"signal termination | run | signaled | not-inspected | not-reached | SIGNAL_TERMINATED",
	"numeric exit + invalid return | return | exited | exact invalid class | not-reached | corresponding RETURN_*",
	"numeric exit + valid, no expected operand | return | exited | admitted | not-requested | ADMITTED",
	"numeric exit + valid, expected operand | compare | exited | admitted | confirmed or invalid | ADMITTED",
	"internal before run outcome | current phase | internal-failed | not-inspected | not-reached | INTERNAL_FAILED",
	"internal after run outcome | current phase | preserved observed run class | last fully classified return class | last fully classified compare class | INTERNAL_FAILED",
] as const;

function layerContract(source: string): void {
	const layer = section(source, "### 4.9 The delegation layer", "## 5. Cross-cutting contracts");
	requireTokens(layer, "SPEC §4.9", [
		"Closed structured return",
		"occupies `<scratch>/return.json`",
		"brief names the same file as `../return.json`",
		"exactly `{ok:boolean, summary:string, reviewedHead?:string, payload?:string}` and no unknown key",
		"reviewedHead` is the delegate's independently resolved reviewed head",
		"payload` is an opaque caller-interpreted string",
		"covers every byte of `summary` and `payload`",
		"`reviewedHead` is consumed only by the blind comparison and never returned",
		"Dispatcher diagnostic envelope",
		"dispatcher observations and fixed literals only",
		"current dispatcher lacks this envelope and remains a tracked code defect",
		"sleep as runtime behavior under §5.3",
		"no child stream byte, delegate event prose, command, error text, summary, payload, operator trace, or caller-held compare operand",
		"schemaVersion: 1",
		'phase: "preflight" | "provision" | "spawn" | "run" | "return" | "compare" | "serialize"',
		'run.class: "not-started" | "exited" | "signaled" | "timed-out" | "aborted" | "internal-failed"',
		'return.class: "not-inspected" | "missing" | "not-regular" | "oversize" | "unreadable" | "json-invalid" | "schema-invalid" | "operand-rejected" | "admitted"',
		'compare.class: "not-reached" | "not-requested" | "confirmed" | "invalid"',
		"saturated integer in `[0, Number.MAX_SAFE_INTEGER]`",
		"measured by a monotonic clock",
		"immediately before outcome serialization begins",
		"signed-32-bit integer `exitCode`",
		"^SIG[A-Z0-9]{1,12}$",
		"Every other run class carries null for both.",
		"Keys occur in the grammar's order when serialized.",
		"A refusal's `cause` equals its diagnostic `message`",
		"Child bytes never supply any code, message, or cause.",
		"Parameter refusal precedes provisioning.",
		"Inspection classifies, in order, missing slot, non-regular slot, oversize bytes, unreadable bytes, invalid UTF-8 or JSON, closed-schema mismatch, caller-held operand, or admitted return.",
		"Comparison follows only an admitted return",
		"without returning either operand",
		"preserves every earlier fully classified fact",
		"observability degradation and never alter this disposition",
		'status="admitted"` holds if and only if `code="ADMITTED"',
		'every other code requires `status="refused"`',
		'An uninspected or invalid return requires `compare.class="not-reached"`',
		"INTERNAL_FAILED` at serialize phase may preserve an already completed compare result",
		"An admitted result after numeric nonzero exit is valid; exit status is diagnostic metadata, never an admission predicate.",
		"Any constructor request outside these combinations becomes `INTERNAL_FAILED`",
		'{disposition:"admitted",ok,summary,payload?,compare?,diagnostic}',
		'{disposition:"refused",cause,diagnostic}',
		"Persisted `details` is exactly `{disposition,ok?,compare?,diagnostic}`",
		"never carries summary, payload, or raw trace",
		"Model-visible final `content` is exactly one text item",
		"refusal is exactly the compact JSON serialization of the diagnostic",
		"complete return file remains at most 65,536 bytes",
		"524,288 UTF-8 bytes",
		"diagnostic serialization is at most 1,536 UTF-8 bytes",
		"2,048 UTF-8 bytes",
		"4,096 UTF-8 bytes",
		"A bound breach is `INTERNAL_FAILED`, never truncation.",
		"measures each complete serialized surface, not its unframed fields",
		"diagnostic is decision-neutral except where §1.7 explicitly consumes",
	]);
	assert.deepEqual(
		fencedAfter(layer, "The closed grammar is:")
			.split("\n")
			.map((line) => line.trim()),
		DIAGNOSTIC_GRAMMAR,
	);
	assert.deepEqual(normalizedRows(fencedAfter(layer, "Codes and messages are one-to-one and exact:")), CODE_MESSAGES);
	assert.deepEqual(normalizedRows(fencedAfter(layer, "The ordinary rows are:")), PRECEDENCE_ROWS);
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
		assert.ok(
			!stat.isSymbolicLink(),
			`production corpus contains an unmeasured symbolic link: ${relative(root, path)}`,
		);
		if (stat.isDirectory()) {
			files.push(...sourceFiles(path));
		} else if (stat.isFile()) {
			files.push(path);
		}
	}
	return files;
}

const DISPATCH_TOKENS = ["DispatcherDiagnostic", "retry-return-protocol", "RETURN_MISSING"] as const;
const REVIEW_COMMANDS = new Set([
	".pi/extensions/gitjig/commands/review.ts",
	".pi/extensions/gitjig/commands/review-round.ts",
	".pi/extensions/gitjig/commands/review-round-input.ts",
]);

function dispatcherOwned(path: string): boolean {
	const rel = relative(root, path).replaceAll("\\", "/");
	return (
		rel.startsWith(".pi/extensions/gitjig/dispatch/") ||
		rel.startsWith(".pi/extensions/gitjig/review/") ||
		REVIEW_COMMANDS.has(rel)
	);
}

function absorbedDispatcherTokenBody(path: string, body: string): string[] {
	if (dispatcherOwned(path)) {
		return [];
	}
	return DISPATCH_TOKENS.filter((token) => body.includes(token)).map((token) => `${relative(root, path)}:${token}`);
}

function absorbedDispatcherTokens(paths: readonly string[]): string[] {
	return paths.flatMap((path) => absorbedDispatcherTokenBody(path, readFileSync(path, "utf8")));
}

describe("Execution #264 contract settlement", () => {
	it("pins §1.7's bounded per-slot retry and its separation from verdicts and later rounds", () => panelContract(spec));
	it("pins §3.10's dispatcher scope, gate-reaching residual, and non-dispatch boundary", () => delegatedContract(spec));
	it("pins §4.9's complete grammar, messages, rows, precedence, surfaces, and bounds", () => layerContract(spec));

	it("kills representative meaning-inverting SPEC mutants for every contract region", () => {
		const replacements: ReadonlyArray<readonly [string, string]> = [
			["Every dispatcher call made by the review orchestrator", "Only the first panel slot"],
			["sibling calls never share or replenish it", "all calls share and replenish it"],
			["repeats the same options and pin", "changes the options and pin"],
			["each written `\\n` denotes one U+000A byte sequence", "each written \\n is literal text"],
			["retries exactly once", "retries until a return appears"],
			[
				"\\n\\nReturn protocol reminder: write a complete provisional ../return.json early and overwrite it with the final closed-schema return.",
				"a reminder of the caller's choosing",
			],
			["neither supplies a result nor creates a verdict", "supplies a result and creates a verdict"],
			["no third send occurs for that call", "sends until a return appears"],
			[
				"retry-return-protocol` through the optional in-process event callback it owns",
				"retry-return-protocol` through model content",
			],
			["A throwing callback degrades open", "A throwing callback refuses the dispatch"],
			["diagnostic envelope lands first", "orchestrator retry lands first"],
			[
				"A valid complete return is admitted on output validity alone regardless of that exit code.",
				"A valid return is refused after nonzero exit.",
			],
			[
				"A complete provisional return remains complete output when the process later exits nonzero",
				"A complete provisional return is discarded after nonzero exit",
			],
			[
				"Requiring every early provisional to carry a non-clear verdict is the rejected mitigation",
				"No safer provisional alternative exists",
			],
			["second instance of §1.6's named deferred limitation", "unrelated to review integrity"],
			["observed early clear that differs from the later overwrite's verdict", "no hardening trigger exists"],
			["malformed, incomplete, missing, or wrong-surface output remains no result", "malformed output is admitted"],
			["No dispatcher diagnostic code or retry predicate transfers by analogy.", "Every consumer inherits the retry"],
			["occupies `<scratch>/return.json`", "occupies an unspecified path"],
			[
				"exactly `{ok:boolean, summary:string, reviewedHead?:string, payload?:string}` and no unknown key",
				"accepts any JSON object",
			],
			["covers every byte of `summary` and `payload`", "covers the first line of summary"],
			["`reviewedHead` is consumed only by the blind comparison and never returned", "reviewedHead is returned"],
			["dispatcher observations and fixed literals only", "child stream bytes are admitted"],
			["saturated integer in `[0, Number.MAX_SAFE_INTEGER]`", "an unbounded float"],
			["measured by a monotonic clock", "measured by wall clock"],
			["Keys occur in the grammar's order when serialized.", "Keys serialize in any order."],
			["A refusal's `cause` equals its diagnostic `message`", "A refusal cause is child-authored"],
			["Child bytes never supply any code, message, or cause.", "Child bytes supply messages."],
			["Inspection classifies, in order", "Inspection classifies in any order"],
			["Comparison follows only an admitted return", "Comparison precedes return admission"],
			["without returning either operand", "while returning both operands"],
			["preserves every earlier fully classified fact", "discards earlier facts"],
			["observability degradation and never alter this disposition", "observability failure refuses the dispatch"],
			[
				"An admitted result after numeric nonzero exit is valid; exit status is diagnostic metadata, never an admission predicate.",
				"Nonzero exit always refuses.",
			],
			[
				"Any constructor request outside these combinations becomes `INTERNAL_FAILED`",
				"Invalid combinations are normalized",
			],
			["never carries summary, payload, or raw trace", "carries summary, payload, and raw trace"],
			["complete return file remains at most 65,536 bytes", "complete return file remains at most 655,360 bytes"],
			["524,288 UTF-8 bytes", "5,242,880 UTF-8 bytes"],
			[
				"diagnostic serialization is at most 1,536 UTF-8 bytes",
				"diagnostic serialization is at most 15,360 UTF-8 bytes",
			],
			["2,048 UTF-8 bytes", "20,480 UTF-8 bytes"],
			["4,096 UTF-8 bytes", "40,960 UTF-8 bytes"],
			["A bound breach is `INTERNAL_FAILED`, never truncation.", "A bound breach is silently truncated."],
			["measures each complete serialized surface, not its unframed fields", "measures unframed fields only"],
		];
		for (const [from, to] of replacements) {
			assert.ok(spec.includes(from), `mutation source is absent: ${from}`);
			assert.equal(spec.indexOf(from), spec.lastIndexOf(from), `mutation source is not unique: ${from}`);
			const mutant = spec.replace(from, to);
			assert.throws(
				() => validateContract(mutant),
				(error: unknown) =>
					error instanceof assert.AssertionError && error.message.includes(JSON.stringify(from).slice(0, -1)),
				`mutant survived: ${from}`,
			);
		}

		for (const [from, to] of [
			['status: "admitted" | "refused",', 'status: "admitted" | "refused" | "partial",'],
			["run: { class, exitCode, signal },", "run: { class, exitCode, signal, childStderrTail },"],
			[
				"RETURN_OVERSIZE          | dispatch refused: the return exceeded the 65536-byte bound",
				"RETURN_OVERSIZE | child message",
			],
			[
				"numeric exit + invalid return | return | exited     | exact invalid class | not-reached | corresponding RETURN_*",
				"numeric exit + invalid return | compare | exited | admitted | confirmed | ADMITTED",
			],
		] as const) {
			assert.ok(spec.includes(from), `table mutation source is absent: ${from}`);
			assert.equal(spec.indexOf(from), spec.lastIndexOf(from), `table mutation source is not unique: ${from}`);
			assert.throws(
				() => validateContract(spec.replace(from, to)),
				(error: unknown) => error instanceof assert.AssertionError && error.operator === "deepStrictEqual",
				`table mutant survived: ${from}`,
			);
		}
	});

	it("refuses symbolic-link omissions from the production corpus", () => {
		const fixture = mkdtempSync(join(tmpdir(), "gitjig-264-corpus-"));
		symlinkSync("missing-target", join(fixture, "consumer.ts"));
		assert.throws(() => sourceFiles(fixture), /unmeasured symbolic link/);
	});

	it("proves the dispatcher-vocabulary sweep detects absorption and honors exact exemptions", () => {
		const fixture = mkdtempSync(join(tmpdir(), "gitjig-264-absorber-"));
		const consumer = join(fixture, "consumer.ts");
		writeFileSync(consumer, "const leaked = 'RETURN_MISSING';\n");
		assert.deepEqual(absorbedDispatcherTokens([consumer]), [`${relative(root, consumer)}:RETURN_MISSING`]);
		for (const rel of REVIEW_COMMANDS) {
			const path = join(root, rel);
			assert.ok(lstatSync(path).isFile(), `allowlisted review command is absent: ${rel}`);
			assert.deepEqual(absorbedDispatcherTokenBody(path, "RETURN_MISSING"), []);
		}
	});

	it("sleeps explicitly until dispatcher vocabulary lands, then excludes non-dispatch consumers", () => {
		const productionRoots = [join(root, ".pi"), join(root, ".github"), join(root, ".githooks")];
		const production = productionRoots.flatMap(sourceFiles);
		assert.ok(
			production.some((path) => !dispatcherOwned(path)),
			"the production sweep found no non-dispatch control population",
		);
		const vocabularyLanded = production.some((path) => {
			const body = readFileSync(path, "utf8");
			return DISPATCH_TOKENS.some((token) => body.includes(token));
		});
		if (!vocabularyLanded) {
			requireTokens(section(spec, "### 4.9 The delegation layer", "## 5. Cross-cutting contracts"), "sleeping guard", [
				"current dispatcher lacks this envelope and remains a tracked code defect",
				"sleep as runtime behavior under §5.3",
			]);
		}
		assert.deepEqual(absorbedDispatcherTokens(production), []);
	});
});

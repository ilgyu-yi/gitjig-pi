import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "gitjig-263-mutants-"));
after(() => rmSync(root, { recursive: true, force: true }));

const READER = ".pi/extensions/gitjig/dispatch/trace-reader.ts";
const WRITER = ".pi/extensions/gitjig/dispatch/trace.ts";
const TOOL = ".pi/extensions/gitjig/dispatch/index.ts";
const COMMAND = ".pi/extensions/gitjig/commands/dispatch-trace.ts";
const TESTS = [
	"test/dispatch-trace-reader.unit.test.ts",
	"test/operator-surfaces.unit.test.ts",
	"test/delegate-observability.unit.test.ts",
];

/** The real-dispatch arm that owns the tool's details write. */
const DISPATCH_ARM = [
	"test/dispatch-module.integration.test.ts",
	"an absent expectedRef stays legal|a refused dispatch that ran persists|expectedRef: 123 refuses",
] as const;

/** [name, file, exact unique source span, replacement, owner arm?]; each weakens one selected guard. */
const mutations: ReadonlyArray<
	readonly [string, string, string, string] | readonly [string, string, string, string, typeof DISPATCH_ARM]
> = [
	[
		"expiry-unchecked",
		READER,
		'> TRACE_RETAIN_MS) return { outcome: "missing" };',
		'> Infinity) return { outcome: "missing" };',
	],
	[
		"absent-directory-unavailable",
		READER,
		'// The writer creates the directory only on its first retention.\n\t\treturn errorCode(error) === "ENOENT" ? { outcome: "missing" } : { outcome: "unavailable" };',
		'return { outcome: "unavailable" };',
	],
	[
		"absent-record-unavailable",
		READER,
		'\t} catch (error) {\n\t\treturn errorCode(error) === "ENOENT" ? { outcome: "missing" } : { outcome: "unavailable" };\n\t}\n\ttry {',
		'\t} catch {\n\t\treturn { outcome: "unavailable" };\n\t}\n\ttry {',
	],
	["directory-mode-unchecked", READER, " && (stats.mode & 0o077) === 0;", ";"],
	["directory-symlink-followed", READER, "checked = lstatSync(directory);", "checked = statSync(directory);"],
	[
		"record-follows-symlink",
		READER,
		"openSync(path, constants.O_RDONLY | STATE_PATH_GUARD_FLAGS)",
		"openSync(path, constants.O_RDONLY)",
	],
	["sink-rule-unchecked", READER, "if (sinkRefusal(stats, path) !== undefined) return", "if (false) return"],
	["size-unchecked", READER, 'if (bytes.length > TRACE_READ_BYTES) return { outcome: "unavailable" };', ""],
	["decode-not-fatal", READER, 'new TextDecoder("utf-8", { fatal: true })', 'new TextDecoder("utf-8")'],
	[
		"running-admitted",
		READER,
		'"completed", "failed", "aborted", "timed-out", "spawn-failed"]',
		'"completed", "failed", "aborted", "timed-out", "spawn-failed", "running"]',
	],
	["line-count-unbounded", READER, " || lines.length > TRACE_LINES) return undefined;", ") return undefined;"],
	[
		"line-text-unbounded",
		READER,
		" || [...line.text].length > TRACE_RENDER_CODEPOINTS) return undefined;",
		") return undefined;",
	],
	[
		"line-members-open",
		READER,
		'if (!exactKeys(line, ["stream", "text", "truncated"])) return undefined;',
		'if (typeof line !== "object" || line === null) return undefined;',
	],
	["negative-counter-admitted", READER, " || (count as number) < 0) return undefined;", ") return undefined;"],
	["reader-trusts-token", READER, '\tif (!canonicalTraceId(id)) return { outcome: "unavailable" };\n', ""],
	["grammar-uppercase", READER, "[0-9a-f]{8}-[0-9a-f]{4}-4", "[0-9a-fA-F]{8}-[0-9a-f]{4}-4"],
	["writer-returns-no-stem", WRITER, "\t\treturn stem;\n", "\t\treturn undefined;\n"],
	["details-without-trace-id", TOOL, "(traceId === undefined ? {} : { traceId })", "({})", DISPATCH_ARM],
	[
		"refused-details-without-trace-id",
		TOOL,
		"\t\t\t\t\t\t\t\tdiagnostic: outcome.diagnostic,\n\t\t\t\t\t\t\t\t...traceDetails(),\n\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\tfalse,",
		"\t\t\t\t\t\t\t\tdiagnostic: outcome.diagnostic,\n\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\tfalse,",
		DISPATCH_ARM,
	],
	["directory-rebind-unchecked", READER, " || after.dev !== checked.dev || after.ino !== checked.ino)", ")"],
	[
		"record-rebind-unchecked",
		READER,
		" && (named.dev !== stats.dev || named.ino !== stats.ino)) return",
		" && false) return",
	],
	[
		"pre-retention-refusal-gains-trace-id",
		TOOL,
		'\t\t\t\t\t\tresult(serializeDiagnostic(diagnostic), { disposition: "refused", diagnostic }),',
		'\t\t\t\t\t\tresult(serializeDiagnostic(diagnostic), { disposition: "refused", diagnostic, traceId: "1700000000000-0f8fad5b-d9cb-469f-a165-70867728950e" }),',
		DISPATCH_ARM,
	],
	["post-sink-prune-unavailable", READER, "if (named !== undefined && (", "if (named === undefined || ("],
	["terminal-aborted-dropped", READER, '"failed", "aborted", "timed-out"', '"failed", "timed-out"'],
	[
		"indication-unchecked",
		TOOL,
		'typeof traceId === "string" && canonicalTraceId(traceId)',
		'typeof traceId === "string"',
	],
	[
		"collapsed-row-shows-trace",
		TOOL,
		"if (!options.expanded) return renderActTerminal(terminal, theme);",
		"if (!options.expanded) return renderActTerminal(terminal, theme, dispatchTraceIndication(result.details));",
	],
	["non-tui-not-returned", COMMAND, 'if (ctx.mode !== "tui") {', 'if (ctx.mode === "print") {'],
	[
		"usage-unchecked",
		COMMAND,
		'if (id === undefined) {\n\t\t\t\tctx.ui.notify(DISPATCH_TRACE_NOTICES.usage, "error");\n\t\t\t\treturn;\n\t\t\t}',
		"",
	],
	[
		"rendered-as-notice",
		COMMAND,
		'if (trace.outcome !== "rendered") {',
		'if (trace.outcome !== "rendered" || trace.text.length > 0) {\n\t\t\t\tif (trace.outcome === "rendered") ctx.ui.notify(trace.text, "info");\n\t\t\t\telse',
	],
	[
		"session-entry-written",
		COMMAND,
		"\t\t\tconst trace = read(stateRoot, id);\n",
		'\t\t\tconst trace = read(stateRoot, id);\n\t\t\tpi.appendEntry("dispatch-trace", { id });\n',
	],
];

function run(name: string, mutation?: (typeof mutations)[number]): ReturnType<typeof spawnSync> {
	const box = mkdtempSync(join(root, `${name}-`));
	cpSync(join(repository, ".pi"), join(box, ".pi"), { recursive: true });
	cpSync(join(repository, ".github/workflows"), join(box, ".github/workflows"), { recursive: true });
	cpSync(join(repository, "SPEC.md"), join(box, "SPEC.md"));
	mkdirSync(join(box, "test"), { recursive: true });
	cpSync(join(repository, "test/fixtures"), join(box, "test/fixtures"), { recursive: true });
	cpSync(join(repository, "test/harness"), join(box, "test/harness"), { recursive: true });
	for (const file of [...TESTS, DISPATCH_ARM[0]]) cpSync(join(repository, file), join(box, file));
	symlinkSync(join(repository, "node_modules"), join(box, "node_modules"), "dir");
	if (mutation !== undefined) {
		const [label, file, from, to] = mutation;
		const target = join(box, file);
		let source = readFileSync(target, "utf8");
		assert.notEqual(source.indexOf(from), -1, `${label}: mutation target must exist`);
		assert.equal(source.indexOf(from), source.lastIndexOf(from), `${label}: mutation target must be unique`);
		source = source.replace(from, () => to);
		if (label === "directory-symlink-followed")
			source = source.replace("import { closeSync,", () => "import { statSync, closeSync,");
		writeFileSync(target, source);
	}
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const arm = mutation?.[4];
	const argv =
		arm === undefined
			? ["--test", "--test-skip-pattern=emits a distinctive marker on the real JSON update surface", ...TESTS]
			: ["--test", `--test-name-pattern=${arm[1]}`, arm[0]];
	return spawnSync(process.execPath, argv, { cwd: box, encoding: "utf8", timeout: 120_000, env });
}

describe("#263 baseline-first isolated retained-trace reader mutants", () => {
	it("passes the isolated baseline", () => {
		const result = run("baseline");
		assert.equal(result.status, 0, `${String(result.stdout)}\n${String(result.stderr)}`);
		const env = { ...process.env };
		delete env.NODE_TEST_CONTEXT;
		const arm = spawnSync(process.execPath, ["--test", `--test-name-pattern=${DISPATCH_ARM[1]}`, DISPATCH_ARM[0]], {
			cwd: repository,
			encoding: "utf8",
			timeout: 120_000,
			env,
		});
		assert.equal(arm.status, 0, `the real-dispatch arm must pass unmutated: ${String(arm.stdout)}`);
		assert.match(String(arm.stdout), /ℹ pass [1-9]/, "the real-dispatch arm selected no test");
	});

	for (const mutation of mutations) {
		it(`kills ${mutation[0]} on an assertion`, () => {
			const result = run(mutation[0], mutation);
			assert.notEqual(result.status, 0, `${mutation[0]} survived`);
			assert.match(
				`${String(result.stdout)}${String(result.stderr)}`,
				/ERR_ASSERTION|AssertionError/,
				`${mutation[0]} died without an assertion`,
			);
		});
	}
});

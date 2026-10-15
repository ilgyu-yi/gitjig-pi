import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Selection, selectAffected } from "./harness/affected-tests.ts";

/* #443: the between-rounds selector, measured over fixture repositories. */
const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const git = (root: string, ...args: string[]) =>
	execFileSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" },
	}).trim();

/** Each rote tree, and a file directly in it that no narrower rote tree holds. */
const ROTE: ReadonlyArray<readonly [string, string]> = [
	[".pi", ".pi/settings.json"],
	[".pi/extensions", ".pi/extensions/other.ts"],
	[".pi/extensions/gitjig", ".pi/extensions/gitjig/deep.ts"],
	[".github", ".github/CODEOWNERS"],
	[".githooks", ".githooks/pre-commit"],
	["test", "test/notes.md"],
	["changelog_unreleased", "changelog_unreleased/x.md"],
];
/** A repository whose tests reach their subjects in each way the selector reads. */
const FILES: Record<string, string> = {
	"lib/a.ts": "export const a = 1;\n",
	"lib/b.ts": 'import { a } from "./a.ts";\nexport const b = a;\n',
	"lib/c.ts": "export const c = 3;\n",
	"lib/d.ts": 'import { b } from "./b.ts";\nexport const d = b;\n',
	"SPEC.md": "# spec\n",
	"docs/guide.md": "guide\n",
	".pi/extensions/gitjig.ts": "export default () => {};\n",
	".pi/prompts/p.md": "prompt\n",
	"test/imports.test.ts": 'import { d } from "../lib/d.ts";\nvoid d;\n',
	"test/reads.test.ts": 'readFileSync("SPEC.md");\n',
	"test/reads-dir.test.ts": 'readdirSync("docs");\n',
	"test/rote.test.ts": ROTE.map(([tree]) => `cpSync(join(root, "${tree}"), box);\n`).join(""),
	...Object.fromEntries(ROTE.map(([, file]) => [file, "rote\n"])),
	"test/spawns-pi.test.ts": 'spawnSync("pi", ["-p"]);\n',
	"lib/dyn.ts": "export const dyn = 1;\n",
	"test/dynamic.test.ts": 'await import("../lib/dyn.ts");\n',
	"assets/rel.md": "relative\n",
	"test/reads-relative.test.ts": 'readFileSync(new URL("../assets/rel.md", import.meta.url));\n',
	"lib/cycle-a.ts": 'import "./cycle-b.ts";\n',
	"lib/cycle-b.ts": 'import "./cycle-a.ts";\n',
	"test/cycle.test.ts": 'import "../lib/cycle-a.ts";\n',
	"tables/t.json": "{}\n",
	"test/reads-slash.test.ts": 'readdirSync("tables/");\n',
	"lib/spawner.ts": 'spawnSync("pi", []);\n',
	"test/uses-spawner.test.ts": 'import "../lib/spawner.ts";\n',
	"lib/template.ts": "export {};\n",
	"test/template.test.ts": 'await import(`${pathToFileURL(join(root, "lib/template.ts")).href}`);\n',
	"lit/single.md": "lit\n",
	"lit/template.md": "lit\n",
	"lit/brace.md": "lit\n",
	"lit/after-brace.md": "lit\n",
	"lit/comment.md": "lit\n",
	"lit/escape.md": "lit\n",
	"lit/apostrophe.md": "lit\n",
	"lit/multiline.md": "lit\n",
	"test/q-single.test.ts": "readFileSync('lit/single.md');\n",
	"test/q-template.test.ts": "readFileSync(`lit/template.md`);\n",
	"test/q-brace.test.ts": 'const s = `${f({ a: 1 }, "lit/brace.md")}`;\nreadFileSync("lit/after-brace.md");\n',
	"test/q-comment.test.ts": '// }\nreadFileSync("lit/comment.md");\n',
	"test/q-escape.test.ts": 'const q = "it\\"s"; readFileSync("lit/escape.md");\n',
	"test/q-apostrophe.test.ts": "// don't\nreadFileSync(\"lit/apostrophe.md\");\nconst s = 'z';\n",
	"test/q-multiline.test.ts": 'const t = `\nline\n`; readFileSync("lit/multiline.md");\n',
	".gitignore": "scratch.md\n",
	"test/reads-scratch.test.ts": 'readFileSync("scratch.md");\n',
	"test/runs-pi.test.ts": 'import { runPi } from "./harness/run-pi.ts";\nvoid runPi;\n',
	"test/unrelated.test.ts": "export {};\n",
	"test/harness/run.ts": "export {};\n",
	"package.json": "{}\n",
	"package-lock.json": "{}\n",
	"tsconfig.json": "{}\n",
	".pi/skills/s.md": "skill\n",
	"lib/reader.ts": 'readFileSync("data/table.json");\n',
	"data/table.json": "{}\n",
	"test/graph-reads.test.ts": 'import "../lib/reader.ts";\n',
	"test/reads-new.test.ts": 'readFileSync("notes/new.md");\n',
};
function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "gitjig-443-"));
	roots.push(root);
	for (const [path, text] of Object.entries(FILES)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	git(root, "init", "-q");
	git(root, "add", "-A");
	git(root, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "-q", "--no-verify", "-m", "base");
	return root;
}
type Select = typeof selectAffected;
/** The whole suite of the fixture as `picked` renders it: every test file, not just the mode. */
const ALL = `all ${Object.keys(FILES)
	.filter((path) => /^test\/[^/]+\.test\.ts$/.test(path))
	.sort()
	.join(" ")}`;
/** The selected tests, each with its first reason, so each rule is told apart from another that also selects. */
const picked = (selection: Selection) =>
	selection.mode === "all"
		? `all ${[...selection.tests].sort().join(" ")}`
		: [...selection.tests]
				.map(([test, reasons]) => `${test} <- ${reasons[0]}`)
				.sort()
				.join("; ");

/** Each rule, as an edit on a fresh fixture and the selection it owes. */
const ARMS: ReadonlyArray<readonly [string, (root: string) => void, string]> = [
	[
		"a changed test selects itself",
		(root) => writeFileSync(join(root, "test/unrelated.test.ts"), "export const x = 1;\n"),
		"test/unrelated.test.ts <- the test itself changed",
	],
	[
		"a transitively imported module selects its importers",
		(root) => writeFileSync(join(root, "lib/a.ts"), "export const a = 2;\n"),
		"test/imports.test.ts <- imports lib/a.ts",
	],
	[
		"a literally named path selects its readers",
		(root) => writeFileSync(join(root, "SPEC.md"), "# changed\n"),
		"test/reads.test.ts <- reads SPEC.md",
	],
	[
		"a named directory selects readers of the files in it",
		(root) => writeFileSync(join(root, "docs/guide.md"), "changed\n"),
		"test/reads-dir.test.ts <- reads docs/guide.md",
	],
	[
		"an extension entry change selects the tests that start Pi",
		(root) => writeFileSync(join(root, ".pi/extensions/gitjig.ts"), "export default () => 1;\n"),
		"test/runs-pi.test.ts <- starts a real Pi, which loads .pi/extensions/gitjig.ts; test/spawns-pi.test.ts <- starts a real Pi, which loads .pi/extensions/gitjig.ts",
	],
	[
		"a prompt change selects the tests that start Pi",
		(root) => writeFileSync(join(root, ".pi/prompts/p.md"), "changed\n"),
		"test/runs-pi.test.ts <- starts a real Pi, which loads .pi/prompts/p.md; test/spawns-pi.test.ts <- starts a real Pi, which loads .pi/prompts/p.md",
	],
	[
		"an untracked file is in the change set",
		(root) => writeFileSync(join(root, "test/new.test.ts"), "export {};\n"),
		"test/new.test.ts <- the test itself changed",
	],
	[
		"a deleted file selects its former readers",
		(root) => rmSync(join(root, "SPEC.md")),
		"test/reads.test.ts <- reads SPEC.md",
	],
	[
		"a harness change selects the whole suite",
		(root) => writeFileSync(join(root, "test/harness/run.ts"), "export const x = 1;\n"),
		ALL,
	],
	[
		"a package manifest change selects the whole suite",
		(root) => writeFileSync(join(root, "package.json"), '{"x":1}\n'),
		ALL,
	],
	[
		"a skill change selects the tests that start Pi",
		(root) => writeFileSync(join(root, ".pi/skills/s.md"), "changed\n"),
		"test/runs-pi.test.ts <- starts a real Pi, which loads .pi/skills/s.md; test/spawns-pi.test.ts <- starts a real Pi, which loads .pi/skills/s.md",
	],
	["a tsconfig change selects the whole suite", (root) => writeFileSync(join(root, "tsconfig.json"), '{"x":1}\n'), ALL],
	[
		"a lock file change selects the whole suite",
		(root) => writeFileSync(join(root, "package-lock.json"), '{"x":1}\n'),
		ALL,
	],
	[
		"a path an imported module names selects the importing test",
		(root) => writeFileSync(join(root, "data/table.json"), '{"x":1}\n'),
		"test/graph-reads.test.ts <- reads data/table.json",
	],
	[
		"a rename selects the readers of its new path",
		(root) => {
			mkdirSync(join(root, "notes"));
			git(root, "mv", "lib/c.ts", "notes/new.md");
		},
		"test/reads-new.test.ts <- reads notes/new.md",
	],
	[
		"a module imported dynamically by a relative specifier selects its importer",
		(root) => writeFileSync(join(root, "lib/dyn.ts"), "export const dyn = 2;\n"),
		"test/dynamic.test.ts <- imports lib/dyn.ts",
	],
	[
		"a relative path literal selects its reader",
		(root) => writeFileSync(join(root, "assets/rel.md"), "changed\n"),
		"test/reads-relative.test.ts <- reads assets/rel.md",
	],
	[
		"an import cycle is walked once",
		(root) => writeFileSync(join(root, "lib/cycle-b.ts"), 'import "./cycle-a.ts";\nexport {};\n'),
		"test/cycle.test.ts <- imports lib/cycle-b.ts",
	],
	[
		"a directory literal with a trailing slash selects readers of the files in it",
		(root) => writeFileSync(join(root, "tables/t.json"), '{"x":1}\n'),
		"test/reads-slash.test.ts <- reads tables/t.json",
	],
	[
		"a literal inside a template substitution selects its reader",
		(root) => writeFileSync(join(root, "lib/template.ts"), "export const t = 1;\n"),
		"test/template.test.ts <- reads lib/template.ts",
	],
	[
		"a single-quoted literal is read",
		(root) => writeFileSync(join(root, "lit/single.md"), "changed\n"),
		"test/q-single.test.ts <- reads lit/single.md",
	],
	[
		"a template literal's own text is read",
		(root) => writeFileSync(join(root, "lit/template.md"), "changed\n"),
		"test/q-template.test.ts <- reads lit/template.md",
	],
	[
		"a literal after an object in a substitution is read",
		(root) => writeFileSync(join(root, "lit/brace.md"), "changed\n"),
		"test/q-brace.test.ts <- reads lit/brace.md",
	],
	[
		"a literal after a template holding braces is read",
		(root) => writeFileSync(join(root, "lit/after-brace.md"), "changed\n"),
		"test/q-brace.test.ts <- reads lit/after-brace.md",
	],
	[
		"a literal after an unbalanced brace in a comment is read",
		(root) => writeFileSync(join(root, "lit/comment.md"), "changed\n"),
		"test/q-comment.test.ts <- reads lit/comment.md",
	],
	[
		"a literal after an escaped quote is read",
		(root) => writeFileSync(join(root, "lit/escape.md"), "changed\n"),
		"test/q-escape.test.ts <- reads lit/escape.md",
	],
	[
		"a literal after an apostrophe in a comment is read",
		(root) => writeFileSync(join(root, "lit/apostrophe.md"), "changed\n"),
		"test/q-apostrophe.test.ts <- reads lit/apostrophe.md",
	],
	[
		"a literal after a multi-line template is read",
		(root) => writeFileSync(join(root, "lit/multiline.md"), "changed\n"),
		"test/q-multiline.test.ts <- reads lit/multiline.md",
	],
	[
		"an untracked file Git ignores is not in the change set",
		(root) => writeFileSync(join(root, "scratch.md"), "ignored\n"),
		"",
	],
	["an unrelated change selects nothing", (root) => writeFileSync(join(root, "lib/c.ts"), "export const c = 4;\n"), ""],
	...ROTE.map(
		([tree, file]) =>
			[
				`a rote copy of ${tree} is no dependency on ${file}`,
				(root: string) => writeFileSync(join(root, file), "changed\n"),
				"",
			] as const,
	),
];
const run = (select: Select, edit: (root: string) => void, base = "HEAD") => {
	const root = fixture();
	edit(root);
	return picked(select(root, base));
};

describe("#443 affected-test selection", () => {
	for (const [label, edit, expected] of ARMS) it(label, () => assert.equal(run(selectAffected, edit), expected));

	it("selects the whole suite without a base or with an unreadable one", () => {
		const root = fixture();
		assert.equal(picked(selectAffected(root, undefined)), ALL);
		assert.equal(picked(selectAffected(root, "no-such-ref")), ALL);
	});

	it("gives a reason for every selected test", () => {
		const root = fixture();
		writeFileSync(join(root, "lib/a.ts"), "export const a = 2;\n");
		const selection = selectAffected(root, "HEAD");
		assert.equal(selection.mode, "some");
		if (selection.mode === "some")
			for (const reasons of selection.tests.values()) assert.ok(reasons.length > 0 && reasons.every(Boolean));
	});
});

const MUTANTS: ReadonlyArray<readonly [string, string, string]> = [
	[
		"changed tests not selected",
		'if (path === test) add(test, "the test itself changed");',
		'if (false) add(test, "");',
	],
	[
		"importers not selected",
		"else if (graph.has(path)) add(test, `imports ${path}`);",
		'else if (false) add(test, "");',
	],
	["the import graph not followed transitively", "\t\timportGraph(root, target, seen);", "\t\tseen.add(target);"],
	["readers not selected", "else if ([...reads].some((read) => reaches(path, read))) add(", "else if (false) add("],
	[
		"a named directory not reaching its files",
		"changed === path || changed.startsWith(`${path}/`)",
		"changed === path",
	],
	["rote trees read as dependencies", "if (!ROTE_TREES.has(path)) reads.add(path);", "reads.add(path);"],
	[
		"Pi tests not selected",
		"\t\t\telse if (spawnsPi && PI_LOADED.some((prefix) => path.startsWith(prefix)))",
		"\t\t\telse if (false)",
	],
	["untracked files dropped", 'for (const path of untracked.split("\\0")) if (path.length > 0) paths.add(path);', ""],
	["whole-suite machinery ignored", 'if (whole !== undefined) return { mode: "all"', 'if (false) return { mode: "all"'],
	["skills not loaded by Pi", '".pi/prompts/", ".pi/skills/"]', '".pi/prompts/"]'],
	["tsconfig not configuring the suite", ", /^tsconfig\\.json$/];", "];"],
	["the lock file not configuring the suite", "/^package-lock\\.json$/, ", ""],
	[
		"paths read only in the test file itself",
		"for (const literal of literals(source)) {",
		"for (const literal of file === test ? literals(source) : []) {",
	],
	["a rename yielding one side", "const count = /^[RC]/.test(status) ? 2 : 1;", "const count = 1;"],
	...ROTE.map(([tree]) => [`${tree} not a rote tree`, `\t"${tree}",\n`, ""] as const),
	["the run-pi harness not starting Pi", ", /harness\\/run-pi\\.ts[\"']/];", "];"],
	["dynamic imports not followed", "|\\bimport\\s*\\(\\s*|", "|"],
	["relative literals not resolved from their file", "return /^\\.\\.?\\//.test(literal)", "return false"],
	["an import cycle walked without end", "\tif (seen.has(file)) return seen;\n", ""],
	["a trailing slash kept on a directory literal", 'normalize(literal).replace(/\\/$/, "")', "normalize(literal)"],
	["a module that spawns Pi counted as a test that starts Pi", 'if (file.startsWith("test/")) {', "if (true) {"],
	[
		"template substitutions not scanned",
		'else if (quote === "`" && source.startsWith("${", index)) {',
		"else if (false) {",
	],
	["single quotes not opening a literal", '|| char === "\'" ||', "||"],
	["backticks not opening a literal", '|| char === "`") quoted(char);', ") quoted(char);"],
	["braces in a substitution not counted", "\t\t\t\tdepth += 1;\n", ""],
	[
		"a substitution ending at any closing brace",
		" && depth === 0 && inSubstitution) return;",
		" && inSubstitution) return;",
	],
	["a top-level closing brace ending the scan", "depth === 0 && inSubstitution) return;", "depth === 0) return;"],
	["closing braces not counted", '\t\t\t\tif (char === "}") depth -= 1;\n', ""],
	["escapes not skipped", 'if (char === "\\\\") {', "if (false) {"],
	["a quote not ending at a newline", '} else if (char === "\\n" && quote !== "`") break;', "} else if (false) break;"],
	["a template ending at a newline", ' && quote !== "`") break;', ") break;"],
	["the closing quote read again", "\t\tindex += 1;\n\t\tfound.push(text);", "\t\tfound.push(text);"],
	...[
		'"no base to compare against", tests }',
		"`the change set against ${base} is unreadable`, tests }",
		"`${whole} configures every test`, tests }",
	].map((from) => [`the whole suite emptied at ${from}`, from, from.replace("tests }", "tests: [] }")] as const),
	["ignored files counted as untracked", '"--others", "--exclude-standard", "-z"', '"--others", "-z"'],
	[
		"an unreadable change set not falling back",
		'if (changed === undefined) return { mode: "all"',
		'if (false) return { mode: "all"',
	],
];

const repository = fileURLToPath(new URL("..", import.meta.url));
const MODULE = "test/harness/affected-tests.ts";

/**
 * Runs the command, from `source`, in a checkout whose path holds a space and
 * non-ASCII characters, invoked through a link the arm makes itself, so the arm
 * does not depend on the host's temporary directory being a link or not.
 */
function command(source: string, base: "HEAD" | "default" = "HEAD"): string {
	const real = join(fixture(), "with space é");
	mkdirSync(real);
	for (const [path, text] of Object.entries(FILES)) {
		mkdirSync(dirname(join(real, path)), { recursive: true });
		writeFileSync(join(real, path), text);
	}
	writeFileSync(join(real, MODULE), source);
	git(real, "init", "-q");
	git(real, "add", "-A");
	git(real, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "-q", "--no-verify", "-m", "base");
	writeFileSync(join(real, "SPEC.md"), "# changed\n");
	if (base === "default") {
		// origin/main stays at the base commit; the change is committed, so only the merge base sees it.
		git(real, "update-ref", "refs/remotes/origin/main", "HEAD");
		git(real, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "-qam", "change", "--no-verify");
	}
	const link = join(dirname(real), "link");
	symlinkSync(real, link, "dir");
	const args = base === "HEAD" ? ["HEAD", "--list"] : ["--list"];
	return execFileSync(process.execPath, [join(link, MODULE), ...args], { encoding: "utf8" });
}
const LISTED = /^test:affected: 1 test file\(s\) against HEAD\n {2}test\/reads\.test\.ts: reads SPEC\.md\n$/;
const LISTED_DEFAULT =
	/^test:affected: 1 test file\(s\) against [0-9a-f]{40}\n {2}test\/reads\.test\.ts: reads SPEC\.md\n$/;

describe("#443 the command", () => {
	const source = readFileSync(join(repository, MODULE), "utf8");
	it("runs through a link from a checkout whose path holds a space and non-ASCII characters", () =>
		assert.match(command(source), LISTED));
	it("defaults its base to the merge base with origin/main", () =>
		assert.match(command(source, "default"), LISTED_DEFAULT));
	it("kills: the default base not the merge base with origin/main", () => {
		const from = '["merge-base", "origin/main", "HEAD"]';
		assert.ok(source.indexOf(from) >= 0 && source.indexOf(from) === source.lastIndexOf(from), "anchor");
		assert.doesNotMatch(
			command(
				source.replace(from, () => '["merge-base", "HEAD", "HEAD"]'),
				"default",
			),
			LISTED_DEFAULT,
		);
	});
	for (const [label, from, to] of [
		[
			"kills: the invoked path not resolved through links",
			"realpathSync(resolve(process.argv[1]))",
			"resolve(process.argv[1])",
		],
		[
			"kills: the module path compared as an encoded URL",
			"realpathSync(fileURLToPath(import.meta.url))",
			"new URL(import.meta.url).pathname",
		],
	] as const)
		it(label, () => {
			assert.ok(source.indexOf(from) >= 0 && source.indexOf(from) === source.lastIndexOf(from), `${label}: anchor`);
			assert.doesNotMatch(command(source.replace(from, () => to)), LISTED);
		});
});

describe("#443 owned mutants", () => {
	const box = mkdtempSync(join(tmpdir(), "gitjig-443-mutants-"));
	roots.push(box);
	for (const [label, from, to] of MUTANTS)
		it(`kills: ${label}`, async () => {
			const dir = mkdtempSync(join(box, "m-"));
			mkdirSync(join(dir, "test/harness"), { recursive: true });
			cpSync(join(repository, MODULE), join(dir, MODULE));
			symlinkSync(join(repository, "node_modules"), join(dir, "node_modules"), "dir");
			const target = join(dir, MODULE);
			const source = readFileSync(target, "utf8");
			assert.ok(source.indexOf(from) >= 0 && source.indexOf(from) === source.lastIndexOf(from), `${label}: anchor`);
			writeFileSync(
				target,
				source.replace(from, () => to),
			);
			const mutated = (await import(pathToFileURL(target).href)) as { selectAffected: Select };
			const observe = (act: () => string) => {
				try {
					return act();
				} catch (error) {
					return `threw ${String(error)}`;
				}
			};
			const killed =
				[undefined, "no-such-ref"].some(
					(base) => observe(() => picked(mutated.selectAffected(fixture(), base))) !== ALL,
				) || ARMS.some(([, edit, expected]) => observe(() => run(mutated.selectAffected, edit)) !== expected);
			assert.ok(killed, `${label} survived`);
		});
});

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

/** A repository whose tests reach their subjects in each way the selector reads. */
const FILES: Record<string, string> = {
	"lib/a.ts": "export const a = 1;\n",
	"lib/b.ts": 'import { a } from "./a.ts";\nexport const b = a;\n',
	"lib/c.ts": "export const c = 3;\n",
	"lib/d.ts": 'import { b } from "./b.ts";\nexport const d = b;\n',
	"SPEC.md": "# spec\n",
	"docs/guide.md": "guide\n",
	".pi/extensions/gitjig.ts": "export default () => {};\n",
	".pi/extensions/gitjig/deep.ts": "export const deep = 1;\n",
	".pi/prompts/p.md": "prompt\n",
	"test/imports.test.ts": 'import { d } from "../lib/d.ts";\nvoid d;\n',
	"test/reads.test.ts": 'readFileSync("SPEC.md");\n',
	"test/reads-dir.test.ts": 'readdirSync("docs");\n',
	"test/rote.test.ts": 'cpSync(join(root, ".pi"), box);\ncpSync(join(root, ".pi/extensions/gitjig"), box);\n',
	"test/spawns-pi.test.ts": 'spawnSync("pi", ["-p"]);\n',
	"test/unrelated.test.ts": "export {};\n",
	"test/harness/run.ts": "export {};\n",
	"package.json": "{}\n",
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
/** The selected tests, each with its first reason, so each rule is told apart from another that also selects. */
const picked = (selection: Selection) =>
	selection.mode === "all"
		? "all"
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
		"a rote whole-tree copy is no dependency on a deep runtime file",
		(root) => writeFileSync(join(root, ".pi/extensions/gitjig/deep.ts"), "export const deep = 2;\n"),
		"",
	],
	[
		"an extension entry change selects the tests that start Pi",
		(root) => writeFileSync(join(root, ".pi/extensions/gitjig.ts"), "export default () => 1;\n"),
		"test/spawns-pi.test.ts <- starts a real Pi, which loads .pi/extensions/gitjig.ts",
	],
	[
		"a prompt change selects the tests that start Pi",
		(root) => writeFileSync(join(root, ".pi/prompts/p.md"), "changed\n"),
		"test/spawns-pi.test.ts <- starts a real Pi, which loads .pi/prompts/p.md",
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
		"all",
	],
	[
		"a package manifest change selects the whole suite",
		(root) => writeFileSync(join(root, "package.json"), '{"x":1}\n'),
		"all",
	],
	["an unrelated change selects nothing", (root) => writeFileSync(join(root, "lib/c.ts"), "export const c = 4;\n"), ""],
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
		assert.equal(picked(selectAffected(root, undefined)), "all");
		assert.equal(picked(selectAffected(root, "no-such-ref")), "all");
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

const repository = fileURLToPath(new URL("..", import.meta.url));
const MODULE = "test/harness/affected-tests.ts";
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
	[
		"rote trees read as dependencies",
		"if (path !== undefined && !ROTE_TREES.has(path)) reads.add(path);",
		"if (path !== undefined) reads.add(path);",
	],
	[
		"Pi tests not selected",
		"\t\t\telse if (spawnsPi && PI_LOADED.some((prefix) => path.startsWith(prefix)))",
		"\t\t\telse if (false)",
	],
	["untracked files dropped", 'for (const path of untracked.split("\\0")) if (path.length > 0) paths.add(path);', ""],
	["whole-suite machinery ignored", 'if (whole !== undefined) return { mode: "all"', 'if (false) return { mode: "all"'],
	[
		"an unreadable change set not falling back",
		'if (changed === undefined) return { mode: "all"',
		'if (false) return { mode: "all"',
	],
];

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
					(base) => observe(() => picked(mutated.selectAffected(fixture(), base))) !== "all",
				) || ARMS.some(([, edit, expected]) => observe(() => run(mutated.selectAffected, edit)) !== expected);
			assert.ok(killed, `${label} survived`);
		});
});

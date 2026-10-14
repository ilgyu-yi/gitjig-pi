/**
 * Affected-test selection (#443): between review rounds, the tests a change is
 * likely to break, from the change set of a base against the working tree — the
 * changed tests, the tests importing a changed module, and the tests naming a
 * changed path. It is a fast local signal, not the gate: reach it cannot read
 * statically (spawned modules, directory walks) is not followed. The whole
 * suite runs once at the final head and on every PR head in CI. A change to the
 * suite's own machinery, or an unknown change set, selects the whole suite.
 *
 *   node test/harness/affected-tests.ts [base] [--list]
 *
 * The base defaults to the merge base with origin/main.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Selection =
	| { mode: "all"; reason: string; tests: string[] }
	| { mode: "some"; tests: Map<string, string[]> };

/** Changes that reach every test: the harness and the files that configure how tests run. */
const WHOLE_SUITE = [/^test\/harness\//, /^package\.json$/, /^package-lock\.json$/, /^tsconfig\.json$/];
/**
 * What a real Pi session registers from the fixture tree: the extension entry and
 * the prompt and skill directories. A change deeper in the runtime reaches those
 * tests through its own importers' tests, not by starting Pi again.
 */
const PI_LOADED = [".pi/extensions/gitjig.ts", ".pi/prompts/", ".pi/skills/"];
/** Whole top-level trees a mutation box copies by rote; naming one is not a dependency on every file in it. */
const ROTE_TREES = new Set([
	".pi",
	".pi/extensions",
	".pi/extensions/gitjig",
	".github",
	".githooks",
	"test",
	"changelog_unreleased",
]);
const SPAWNS_PI = [/\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*["']pi["']/, /harness\/run-pi\.ts["']/];

function git(root: string, args: string[]): string | undefined {
	const run = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return run.status === 0 ? run.stdout : undefined;
}

/** Repository-relative paths changed from the base to the working tree; a rename yields both sides. */
export function changeSet(root: string, base: string): string[] | undefined {
	const diff = git(root, ["diff", "--name-status", "-M", "-z", base, "--"]);
	const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
	// Git failing on ls-files alone is not reproducible here; without this check the split throws, never a silent pass.
	if (diff === undefined || untracked === undefined) return undefined;
	const paths = new Set<string>();
	const fields = diff.split("\0");
	for (let index = 0; index < fields.length; ) {
		const status = fields[index] as string;
		const count = /^[RC]/.test(status) ? 2 : 1;
		for (const path of fields.slice(index + 1, index + 1 + count)) paths.add(path);
		index += 1 + count;
	}
	for (const path of untracked.split("\0")) if (path.length > 0) paths.add(path);
	return [...paths].sort();
}

/** String literals in a source text: the operands a static reading can resolve. */
function literals(source: string): string[] {
	return [...source.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)].map((match) => match[2] as string);
}

/**
 * Repository-relative path a literal may name from a file. Existence is not
 * required, so a deleted file's former readers still match; a literal that is
 * not a path names nothing any changed path equals or lies below.
 */
function named(root: string, from: string, literal: string): string {
	return /^\.\.?\//.test(literal)
		? relative(root, resolve(root, dirname(from), literal))
		: normalize(literal).replace(/\/$/, "");
}

/** The modules a file imports by literal specifier, transitively, repository-relative. */
function importGraph(root: string, file: string, seen = new Set<string>()): Set<string> {
	if (seen.has(file)) return seen;
	seen.add(file);
	let source: string;
	try {
		source = readFileSync(join(root, file), "utf8");
	} catch (error) {
		// A missing or unreadable module ends this branch; any other error, such as a stack overflow, is not swallowed.
		if (!(error instanceof Error && "code" in error)) throw error;
		return seen;
	}
	for (const match of source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\1/g)) {
		const target = relative(root, resolve(root, dirname(file), match[2] as string));
		importGraph(root, target, seen);
	}
	return seen;
}

/** Whether a changed path lies at or below a path a test names. */
const reaches = (changed: string, path: string) => changed === path || changed.startsWith(`${path}/`);

export function selectAffected(root: string, base: string | undefined): Selection {
	const tests = readdirSync(join(root, "test"))
		.filter((name) => name.endsWith(".test.ts"))
		.map((name) => `test/${name}`)
		.sort();
	// Git would reach the unreadable-change-set fallback below anyway; kept for the reason it prints.
	if (base === undefined) return { mode: "all", reason: "no base to compare against", tests };
	const changed = changeSet(root, base);
	if (changed === undefined) return { mode: "all", reason: `the change set against ${base} is unreadable`, tests };
	const whole = changed.find((path) => WHOLE_SUITE.some((pattern) => pattern.test(path)));
	if (whole !== undefined) return { mode: "all", reason: `${whole} configures every test`, tests };
	const selected = new Map<string, string[]>();
	const add = (test: string, reason: string) => selected.set(test, [...(selected.get(test) ?? []), reason]);
	for (const test of tests) {
		const graph = importGraph(root, test);
		const reads = new Set<string>();
		let spawnsPi = false;
		for (const file of graph) {
			let source: string;
			try {
				source = readFileSync(join(root, file), "utf8");
			} catch {
				continue;
			}
			for (const literal of literals(source)) {
				const path = named(root, file, literal);
				if (!ROTE_TREES.has(path)) reads.add(path);
			}
			if (file.startsWith("test/")) {
				spawnsPi ||= SPAWNS_PI.some((pattern) => pattern.test(source));
			}
		}
		for (const path of changed) {
			if (path === test) add(test, "the test itself changed");
			else if (graph.has(path)) add(test, `imports ${path}`);
			else if ([...reads].some((read) => reaches(path, read))) add(test, `reads ${path}`);
			else if (spawnsPi && PI_LOADED.some((prefix) => path.startsWith(prefix)))
				add(test, `starts a real Pi, which loads ${path}`);
		}
	}
	return { mode: "some", tests: selected };
}

function defaultBase(root: string): string | undefined {
	return git(root, ["merge-base", "origin/main", "HEAD"])?.trim() || undefined;
}

// Compared as real paths: the invoked path may run through a link (macOS /var) or
// carry characters a file URL percent-encodes, and a mismatch would run nothing.
const SELF = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === SELF) {
	const root = resolve(dirname(SELF), "../..");
	const args = process.argv.slice(2);
	const list = args.includes("--list");
	const base = args.find((arg) => !arg.startsWith("--")) ?? defaultBase(root);
	const selection = selectAffected(root, base);
	const files = selection.mode === "all" ? selection.tests : [...selection.tests.keys()];
	if (selection.mode === "all") console.log(`test:affected: whole suite — ${selection.reason}`);
	else {
		console.log(`test:affected: ${files.length} test file(s) against ${base}`);
		for (const [test, reasons] of selection.tests)
			console.log(`  ${test}: ${reasons[0]}${reasons.length > 1 ? ` (+${reasons.length - 1})` : ""}`);
	}
	if (list || files.length === 0) process.exit(0);
	const run = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
	process.exit(run.status ?? 1);
}

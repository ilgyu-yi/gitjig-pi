/** #408 — isolated baseline-first private-copy mutants for every pr-size guard. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "gitjig-408-mutants-"));
after(() => rmSync(root, { recursive: true, force: true }));

const CHECK = ".github/workflows/pr-size.mjs";
const TEST = "test/pr-size.unit.test.ts";

/** [label, exact source text, replacement] — each weakens one guard SPEC §1.11 settles. */
const mutations: ReadonlyArray<readonly [string, string, string]> = [
	[
		"the base-side region read from the base tip, not the merge base",
		'side === "base" ? mergeBase : head',
		'side === "base" ? base : head',
	],
	["the base-side end marker counted inside", "oldLine < base.before) inside", "oldLine <= base.before) inside"],
	["the head-side end marker counted inside", "newLine < head.before) inside", "newLine <= head.before) inside"],
	["a non-integer deletion count admitted", " || !Number.isSafeInteger(deleted))", ")"],
	[
		"a non-list listing page taken as the last",
		'if (!Array.isArray(batch)) throw new Error("listing-malformed");',
		"if (!Array.isArray(batch)) return all;",
	],
	[
		"an evaluation failure posted as a pass",
		'measured: undefined, result: { ok: false, arm: "lookup-unavailable" }',
		'measured: undefined, result: { ok: true, arm: "lookup-unavailable" }',
	],
	["every report posted as success", 'conclusion: outcome.result.ok ? "success" : "failure"', 'conclusion: "success"'],
	["a widened threshold", "export const THRESHOLD = 2400;", "export const THRESHOLD = 24000;"],
	["the bound compared as strictly below", "if (measured <= THRESHOLD)", "if (measured < THRESHOLD)"],
	[
		"an added file exclusion",
		'files: Object.freeze(["test/fixtures/adopter-membership.snapshot.json"]),',
		'files: Object.freeze(["test/fixtures/adopter-membership.snapshot.json", "a.ts"]),',
	],
	[
		"the whole SPEC excluded, not its region",
		"if (EXCLUSIONS.files.includes(file.filename)) continue;",
		'if (EXCLUSIONS.files.includes(file.filename) || file.filename === "SPEC.md") continue;',
	],
	[
		"an unrecorded escape honoured",
		'return { ok: false, arm: "over-bound" };',
		'return { ok: true, arm: "over-bound" };',
	],
	[
		"an escape for another head honoured",
		"record.value.pr === number && record.value.head === head",
		"record.value.pr === number",
	],
	[
		"an escape for another pull request honoured",
		"record.value.pr === number && record.value.head === head",
		"record.value.head === head",
	],
	["a duplicate escape honoured", "if (current.length > 1)", "if (current.length > 2)"],
	["a reader\x27s escape honoured", '["ADMIN", "MAINTAIN", "WRITE"]', '["ADMIN", "MAINTAIN", "WRITE", "READ"]'],
	["an escape naming another value honoured", "if (record.value.measured !== measured)", "if (false)"],
	[
		"a malformed escape skipped",
		'if (value === undefined) return { ok: false, arm: "escape-malformed" };',
		"if (value === undefined) continue;",
	],
	["a truncated listing measured", "files.length !== changedFiles", "files.length > changedFiles"],
	[
		"a SPEC change with no patch counted whole",
		'if (typeof file.patch !== "string") throw new Error("diff-unavailable");',
		'if (typeof file.patch !== "string") continue;',
	],
	[
		"an unknown base admitted",
		'result: { ok: false, arm: "base-unknown" }',
		'result: { ok: true, arm: "base-unknown" }',
	],
	[
		"a missing head admitted",
		'return { head: undefined, result: { ok: false, arm: "head-unknown" } };',
		'return { head: undefined, result: { ok: true, arm: "head-unknown" } };',
	],
	["a moved base admitted", "after?.head?.sha !== head || after?.base?.sha !== base", "after?.head?.sha !== head"],
	["only the first comment page read", "if (batch.length < 100) return all;", "return all;"],
	[
		"the base region read from the head version",
		'regionText(file.filename, "base")',
		'regionText(file.filename, "head")',
	],
	[
		"the start marker counted inside the region",
		"oldLine > base.after && oldLine < base.before",
		"oldLine >= base.after && oldLine < base.before",
	],
	["a maintenance line with a slash governed", "/^[^/]*-maintenance$/", "/-maintenance$/"],
	[
		"a moved head admitted",
		'result: { ok: false, arm: "subject-changed" }',
		'result: { ok: true, arm: "subject-changed" }',
	],
];

function run(name: string, mutation?: (typeof mutations)[number]): ReturnType<typeof spawnSync> {
	const box = mkdtempSync(join(root, `${name.replace(/[^a-z]+/giu, "-").slice(0, 40)}-`));
	mkdirSync(join(box, ".github/workflows"), { recursive: true });
	mkdirSync(join(box, "test"), { recursive: true });
	cpSync(join(repository, CHECK), join(box, CHECK));
	cpSync(join(repository, TEST), join(box, TEST));
	if (mutation !== undefined) {
		const [label, from, to] = mutation;
		const target = join(box, CHECK);
		const source = readFileSync(target, "utf8");
		assert.notEqual(source.indexOf(from), -1, `${label}: mutation target must exist`);
		assert.equal(source.indexOf(from), source.lastIndexOf(from), `${label}: mutation target must be unique`);
		writeFileSync(
			target,
			source.replace(from, () => to),
		);
	}
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	return spawnSync(process.execPath, ["--test", TEST], { cwd: box, encoding: "utf8", timeout: 60_000, env });
}

describe("#408 baseline-first isolated pr-size mutants", () => {
	it("passes the isolated baseline", () => {
		const result = run("baseline");
		assert.equal(result.status, 0, `${String(result.stdout)}\n${String(result.stderr)}`);
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

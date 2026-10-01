/** #406 — isolated baseline-first mutants for the shared `gh --jq` scalar terminator owner. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "gitjig-406-mutants-"));
after(() => rmSync(root, { recursive: true, force: true }));

const READ = ".pi/extensions/gitjig/platform/read.ts";
const PUBLICATION = ".pi/extensions/gitjig/review/publication.ts";
const TEST = "test/resolver-handoff-scalar.unit.test.ts";

const mutations: ReadonlyArray<readonly [string, string, string, string]> = [
	["terminator-kept", READ, 'return output?.endsWith("\\n") ? output.slice(0, -1) : output;', "return output;"],
	[
		"all-trailing-whitespace-trimmed",
		READ,
		'return output?.endsWith("\\n") ? output.slice(0, -1) : output;',
		'return output?.replace(/\\s+$/, "");',
	],
	[
		"publication-reads-verbatim",
		PUBLICATION,
		"\t\tplatformScalarValue(await seams.read(argv, repoRoot));",
		"\t\tawait seams.read(argv, repoRoot);",
	],
];

function run(name: string, mutation?: (typeof mutations)[number]): ReturnType<typeof spawnSync> {
	const box = mkdtempSync(join(root, `${name}-`));
	for (const tree of [".pi", ".github"]) cpSync(join(repository, tree), join(box, tree), { recursive: true });
	mkdirSync(join(box, "test"), { recursive: true });
	cpSync(join(repository, TEST), join(box, TEST));
	symlinkSync(join(repository, "node_modules"), join(box, "node_modules"), "dir");
	if (mutation !== undefined) {
		const [label, file, from, to] = mutation;
		const target = join(box, file);
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
	return spawnSync(process.execPath, ["--test", TEST], { cwd: box, encoding: "utf8", timeout: 180_000, env });
}

describe("#406 baseline-first isolated gh scalar mutants", () => {
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

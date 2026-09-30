/**
 * #399 — isolated baseline-first mutants for the machine-record abort arm:
 * the parent-side send observer must be what the arm waits on.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "gitjig-399-mutants-"));
after(() => rmSync(root, { recursive: true, force: true }));

const EXECUTOR = ".pi/extensions/gitjig/publish/executor.ts";
const TEST = "test/machine-record.unit.test.ts";
const ARM = "verifies all six destinations with one send and one GET";

const mutations: ReadonlyArray<readonly [string, string, string, string]> = [
	["observer-never-invoked", EXECUTOR, "\t\t\t\tonStdout?.(chunk);\n", ""],
	[
		"fixed-30ms-abort",
		TEST,
		"\t\t\tconst crossed = await Promise.race([",
		"\t\t\tawait new Promise((resolve) => setTimeout(resolve, 30));\n\t\t\tcontroller.abort();\n\t\t\tconst crossed = await Promise.race([",
	],
];

function run(name: string, mutation?: (typeof mutations)[number]): ReturnType<typeof spawnSync> {
	const box = mkdtempSync(join(root, `${name}-`));
	for (const tree of [".pi", ".githooks", ".github"])
		cpSync(join(repository, tree), join(box, tree), { recursive: true });
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
	return spawnSync(process.execPath, ["--test", `--test-name-pattern=${ARM}`, TEST], {
		cwd: box,
		encoding: "utf8",
		timeout: 120_000,
		env,
	});
}

describe("#399 baseline-first isolated abort-arm mutants", () => {
	it("passes the isolated baseline", () => {
		const result = run("baseline");
		assert.equal(result.status, 0, `${String(result.stdout)}\n${String(result.stderr)}`);
		assert.match(String(result.stdout), /ℹ pass [1-9]/, "the arm was not selected");
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

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";

const repository = join(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "ac-closeout-mutants-"));
after(() => rmSync(root, { recursive: true, force: true }));
const focused = [
	"--test",
	"test/ac-closeout.unit.test.ts",
	"test/ac-closeout-event.unit.test.ts",
	"test/landing-platform.unit.test.ts",
];

function box(name: string): string {
	const destination = mkdtempSync(join(root, `${name}-`));
	cpSync(repository, destination, {
		recursive: true,
		filter: (source) => !new Set([".git", "node_modules", ".gitjig"]).has(basename(source)),
	});
	symlinkSync(join(repository, "node_modules"), join(destination, "node_modules"), "dir");
	return destination;
}

function run(cwd: string) {
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	return spawnSync(process.execPath, focused, { cwd, encoding: "utf8", timeout: 20_000, env });
}

function kill(name: string, path: string, from: string, to: string): void {
	const cwd = box(name);
	const target = join(cwd, path);
	const source = readFileSync(target, "utf8");
	assert.equal(source.split(from).length, 2, `${name}: mutation target must be unique`);
	writeFileSync(target, source.replace(from, to));
	const result = run(cwd);
	assert.notEqual(result.status, 0, `${name}: mutant survived\n${result.stdout}\n${result.stderr}`);
}

describe("#282 isolated ac-closeout guard mutants", () => {
	it("keeps the focused baseline green", () => {
		const result = run(box("baseline"));
		assert.equal(result.status, 0, `baseline failed\n${result.stdout}\n${result.stderr}`);
	});

	it("kills stale identity and head, unattested writer, duplicate, and unresolved mutants", () => {
		kill(
			"stale-identity",
			".github/workflows/ac-closeout.mjs",
			"JSON.stringify(record.criteria.map(/** @param {any} entry */ (entry) => entry.identity)) !==",
			"JSON.stringify(record.criteria.map(/** @param {any} entry */ (entry) => entry.identity)) ===",
		);
		kill(
			"stale-head",
			".github/workflows/ac-closeout.mjs",
			"record.headSha !== input.headSha || record.baseSha !== input.baseSha",
			"record.headSha !== input.headSha && record.baseSha !== input.baseSha",
		);
		kill(
			"unattested-writer",
			".github/workflows/ac-closeout.mjs",
			"record.writerId !== comment.authorId",
			"record.writerId === comment.authorId",
		);
		kill("duplicate", ".github/workflows/ac-closeout.mjs", "marked.length !== 1", "marked.length === 1");
		kill(
			"unresolved-item",
			".github/workflows/ac-closeout.mjs",
			"if (!prChecklistTerminal(input.pullRequestBody))",
			"if (prChecklistTerminal(input.pullRequestBody))",
		);
	});

	it("kills stale-green and incomplete-pagination mutants", () => {
		kill("stale-green", ".pi/extensions/gitjig/landing/platform.ts", "id > prior.id", "id < prior.id");
		kill(
			"incomplete-pagination",
			".github/workflows/ac-closeout-event.mjs",
			"response.total_count !== response.check_runs.length",
			"response.total_count === response.check_runs.length",
		);
	});
});

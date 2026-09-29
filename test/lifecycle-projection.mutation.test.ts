import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "gitjig-347-mutants-"));
after(() => rmSync(root, { recursive: true, force: true }));

const PROJECTION = ".pi/extensions/gitjig/lifecycle-projection.ts";
const ATTESTATION = ".pi/extensions/gitjig/lifecycle-attestation.ts";
const COMMAND = ".pi/extensions/gitjig/commands/lifecycle.ts";
const SURFACE = ".pi/extensions/gitjig/session-surface.ts";
const ENGINE = ".github/workflows/gitjig-lifecycle.mjs";

/** [name, file, exact unique source span, replacement]; each weakens one implemented guard. */
const mutations: ReadonlyArray<readonly [string, string, string, string]> = [
	["read-bound", PROJECTION, "timeoutMs: 2_000,", "timeoutMs: 10_000,"],
	["ttl-length", PROJECTION, "5 * 60 * 1_000;", "50 * 60 * 1_000;"],
	["ttl-boundary", PROJECTION, "< LIFECYCLE_TTL_MS", "<= LIFECYCLE_TTL_MS"],
	[
		"key-without-head",
		PROJECTION,
		"[repositoryId, target.kind, target.number, head]",
		"[repositoryId, target.kind, target.number]",
	],
	[
		"stamp-on-failure",
		PROJECTION,
		"if (comments === undefined) return undefined;",
		"if (comments === undefined) {\n\t\t\tthis.cache.set(key, { at: this.seams.now(), segment: { subject: target.kind, number: target.number, shortHead: null, states: [] } });\n\t\t\treturn undefined;\n\t\t}",
	],
	["superseded-renders", PROJECTION, 'if (generation !== this.generation) return "superseded";', ""],
	["stale-head-admitted", PROJECTION, "record.subjectHead !== head", "false"],
	["no-ui-reads", PROJECTION, 'if (!this.surface.visible) return "silent";', ""],
	["repository-name-unchecked", PROJECTION, "if (repo.full_name !== nameWithOwner) return undefined;", ""],
	["issue-may-be-pull", PROJECTION, ' || Object.hasOwn(issue, "pull_request")', ""],
	["pull-base-unchecked", PROJECTION, " || base?.full_name !== nameWithOwner", ""],
	["population-refusal-ignored", PROJECTION, "if (!population.ok) return undefined;", ""],
	[
		"failure-keeps-old-segment",
		PROJECTION,
		"this.surface.setLifecycle(segment);",
		"if (segment !== undefined) this.surface.setLifecycle(segment);",
	],
	["permission-untrimmed", PROJECTION, ".then((value) => value?.trim())", ".then((value) => value)"],
	[
		"transition-carrier-unchecked",
		ATTESTATION,
		"attested: await authorizedUser(engine, comment, repositoryId, permissionOf) });",
		"attested: true });",
	],
	[
		"engine-terminal-kind",
		ENGINE,
		"!admitTransitionTerminal(record) ||\n\t\t\t\trecord.transition !== transition",
		"!admitTransitionTerminal(record)",
	],
	["engine-terminal-order", ENGINE, " || comment.id <= record.recordCommentId", ""],
	[
		"engine-transition-attestation",
		ENGINE,
		"\t\t\tconst record = parseMarkedRecord(comment.body, recordMarker);\n\t\t\tif (\n\t\t\t\tcomment.attested !== true ||\n",
		"\t\t\tconst record = parseMarkedRecord(comment.body, recordMarker);\n\t\t\tif (\n",
	],
	[
		"engine-single-current",
		ENGINE,
		'if (current.length > 1) return { ok: false, arm: "record-ambiguous", current, terminals };',
		"",
	],
	[
		"command-without-ui",
		COMMAND,
		"if (!ctx.hasUI || projection === undefined) return;",
		"if (projection === undefined) return;",
	],
	["command-extra-tokens", COMMAND, "if (tokens.length !== 1) return undefined;", ""],
	[
		"attach-keeps-segment",
		SURFACE,
		"\t\tthis.lifecycle = undefined;\n\t\tthis.ui = undefined;",
		"\t\tthis.ui = undefined;",
	],
];

function run(name: string, mutation?: (typeof mutations)[number]): ReturnType<typeof spawnSync> {
	const box = mkdtempSync(join(root, `${name}-`));
	cpSync(join(repository, ".pi/extensions/gitjig"), join(box, ".pi/extensions/gitjig"), { recursive: true });
	mkdirSync(join(box, ".github/workflows"), { recursive: true });
	for (const file of ["gitjig-lifecycle.mjs", "ac-closeout.mjs"])
		cpSync(join(repository, ".github/workflows", file), join(box, ".github/workflows", file));
	mkdirSync(join(box, "test"), { recursive: true });
	for (const file of ["lifecycle-projection.unit.test.ts", "lifecycle-governance.unit.test.ts"])
		cpSync(join(repository, "test", file), join(box, "test", file));
	symlinkSync(join(repository, "node_modules"), join(box, "node_modules"), "dir");
	if (mutation !== undefined) {
		const [label, file, from, to] = mutation;
		const target = join(box, file);
		const source = readFileSync(target, "utf8");
		assert.notEqual(source.indexOf(from), -1, `${label}: mutation target must exist`);
		assert.equal(source.indexOf(from), source.lastIndexOf(from), `${label}: mutation target must be unique`);
		writeFileSync(target, source.replace(from, to));
	}
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	return spawnSync(
		process.execPath,
		["--test", "test/lifecycle-projection.unit.test.ts", "test/lifecycle-governance.unit.test.ts"],
		{ cwd: box, encoding: "utf8", timeout: 60_000, env },
	);
}

describe("#347 baseline-first isolated lifecycle projection mutants", () => {
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

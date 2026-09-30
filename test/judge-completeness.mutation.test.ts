import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "gitjig-378-mutants-"));
after(() => rmSync(root, { recursive: true, force: true }));

const REVIEW = ".pi/extensions/gitjig/review/";
const RESOLVE = `${REVIEW}resolve.ts`;
const RECORD = `${REVIEW}record.ts`;
const ORCHESTRATE = `${REVIEW}orchestrate.ts`;
const HISTORY = `${REVIEW}history.ts`;
const BRIEFS = `${REVIEW}briefs.ts`;

/** [name, file, exact unique source span, replacement]; each weakens one named refusal or terminal. */
const mutations: ReadonlyArray<readonly [string, string, string, string]> = [
	[
		"partition-coverage-unchecked",
		RESOLVE,
		"gaps.push(`raw ordinal ${entry.rawOrdinal} is ruled by no effective finding (§1.9)`);",
		"",
	],
	["partition-disjointness-unchecked", RESOLVE, "if (earlier !== undefined && earlier !== index) {", "if (false) {"],
	[
		"ordinal-order-unchecked",
		RESOLVE,
		"if (ordinals.some((ordinal, at) => at > 0 && ordinal <= ordinals[at - 1])) {",
		"if (false) {",
	],
	[
		"unknown-ordinal-unnamed",
		RESOLVE,
		"if (entry === undefined || entry.rawOrdinal !== ordinal) {\n\t\t\t\tgaps.push(",
		"if (entry === undefined || entry.rawOrdinal !== ordinal) {\n\t\t\t\t[].push(",
	],
	["empty-ordinals-admitted", RESOLVE, "if (ordinals.length === 0) {", "if (false) {"],
	[
		"provenance-multiset-unchecked",
		RESOLVE,
		"if (expected.length !== actual.length || expected.some((value, at) => value !== actual[at])) {",
		"if (false) {",
	],
	["envelope-axes-ignored", RESOLVE, "rulingGaps(ruling, index).length > 0 || ", ""],
	["envelope-empty-admitted", RESOLVE, " || ordinals.length === 0) return undefined;", ") return undefined;"],
	["envelope-order-ignored", RESOLVE, "if (at > 0 && ordinal <= ordinals[at - 1]) return undefined;", ""],
	["envelope-range-ignored", RESOLVE, "ordinal < 0 || ordinal >= bundle.length || ", ""],
	["envelope-duplicates-ignored", RESOLVE, " || ruled.has(ordinal)) return undefined;", ") return undefined;"],
	[
		"re-request-without-omission",
		RECORD,
		"if (omitted === undefined || omitted.length === 0) return undefined;",
		"if (omitted === undefined) return undefined;",
	],
	[
		"re-request-on-invalid-envelope",
		RECORD,
		"if (omitted === undefined || omitted.length === 0) return undefined;",
		"if (omitted?.length === 0) return undefined;",
	],
	["re-request-skipped", ORCHESTRATE, "if (gaps !== undefined) {", "if (false) {"],
	[
		"third-semantic-call",
		ORCHESTRATE,
		"\t\t\tawait judge(2, gaps);\n",
		'\t\t\tawait judge(2, gaps);\n\t\t\tif (reRequestGaps(judgeAttempts[1], manifest, bundle) !== undefined || judgeAttempts[1].disposition === "refused") await judge(2, gaps);\n',
	],
	[
		"re-request-without-gaps",
		ORCHESTRATE,
		"gaps === undefined ? undefined : { gaps }",
		"gaps === undefined ? undefined : { gaps: [] }",
	],
	[
		"re-request-partial-bundle",
		ORCHESTRATE,
		"const judgeBrief = composeJudgeBrief(\n\t\t\t\tbundle,",
		"const judgeBrief = composeJudgeBrief(\n\t\t\t\tgaps === undefined ? bundle : bundle.slice(1),",
	],
	["re-request-brief-unmarked", BRIEFS, '"COMPLETENESS RE-REQUEST — an earlier', '"RE-REQUEST — an earlier'],
	[
		"only-last-attempt-retained",
		ORCHESTRATE,
		"\t\tjudgeAttempts,\n\t\tadjudication,",
		"\t\tjudgeAttempts: judgeAttempts.slice(-1),\n\t\tadjudication,",
	],
	[
		"invalid-first-re-requested",
		RECORD,
		"if (input === undefined) return undefined;",
		'if (input === undefined) return ["x"];',
	],
	[
		"unconfirmed-attempt-admitted",
		RECORD,
		'if (attempt.disposition !== "admitted" || attempt.ok !== true || attempt.compare !== "confirmed") {',
		'if (attempt.disposition !== "admitted") {',
	],
	[
		"incomplete-keeps-adjudication",
		RECORD,
		"gaps: admission.gaps },\n\t\t\tadjudication: null,",
		"gaps: admission.gaps },\n\t\t\tadjudication: input,",
	],
	["attempt-head-unchecked", RECORD, "attempt.head !== head ||", ""],
	["attempt-manifest-unchecked", RECORD, "attempt.manifestDigest !== manifestDigest(manifest) ||", ""],
	["attempt-bundle-unchecked", RECORD, "attempt.bundleDigest !== bundleDigest(indexed) ||", ""],
	["attempt-digest-unchecked", RECORD, "resultDigest !== attemptDigest(evidence)", "false"],
	["attempt-order-unchecked", RECORD, "attempt.attempt !== index + 1 ||", ""],
	[
		"second-attempt-condition-unchecked",
		RECORD,
		"if ((attempts.length === 2) !== (firstGaps !== undefined)) return undefined;",
		"",
	],
	["terminal-review-unchecked", RECORD, "if (canonical(derived.review) !== canonical(review) || ", "if ("],
	["terminal-adjudication-unchecked", RECORD, " || canonical(derived.adjudication) !== canonical(adjudication)", ""],
	["dense-ordinals-unchecked", RECORD, "entry.rawOrdinal === index &&", ""],
	["version-2-parsed-as-historical", RECORD, 'if (Object.hasOwn(parsed, "schemaVersion")) {', "if (false) {"],
	["history-index-join-unchecked", HISTORY, "disposition?.rulingIndex !== index ||", ""],
	["history-extra-dispositions-admitted", HISTORY, "if (dispositions.length !== rulings.length) return undefined;", ""],
	["history-version-2-joined-by-text", HISTORY, "if (record.schemaVersion === 2) {", "if (false) {"],
	[
		"resolver-without-ruling-index",
		RESOLVE,
		'\t\t\treturn { rulingIndex, finding: ruling.finding, disposition: "none" as const };',
		'\t\t\treturn { finding: ruling.finding, disposition: "none" as const };',
	],
];

function run(name: string, mutation?: (typeof mutations)[number]): ReturnType<typeof spawnSync> {
	const box = mkdtempSync(join(root, `${name}-`));
	cpSync(join(repository, ".pi/extensions/gitjig"), join(box, ".pi/extensions/gitjig"), { recursive: true });
	mkdirSync(join(box, ".github/workflows"), { recursive: true });
	for (const file of ["gitjig-lifecycle.mjs", "ac-closeout.mjs"])
		cpSync(join(repository, ".github/workflows", file), join(box, ".github/workflows", file));
	mkdirSync(join(box, "test"), { recursive: true });
	cpSync(join(repository, "test/judge-completeness.unit.test.ts"), join(box, "test/judge-completeness.unit.test.ts"));
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
	return spawnSync(process.execPath, ["--test", "test/judge-completeness.unit.test.ts"], {
		cwd: box,
		encoding: "utf8",
		timeout: 120_000,
		env,
	});
}

describe("#378 baseline-first isolated Judge-completeness mutants", () => {
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

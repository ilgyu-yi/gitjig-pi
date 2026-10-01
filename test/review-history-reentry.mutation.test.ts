/** #404 — isolated baseline-first mutants for every named review-history handoff guard. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "gitjig-404-mutants-"));
after(() => rmSync(root, { recursive: true, force: true }));

const ROUND = ".pi/extensions/gitjig/commands/review-round.ts";
const HANDOFF = ".pi/extensions/gitjig/review/history-handoff.ts";
const HISTORY = ".pi/extensions/gitjig/review/history.ts";
const TEST = "test/review-history-reentry.unit.test.ts";

const mutations: ReadonlyArray<readonly [string, string, string, string]> = [
	["environmental-failure-as-limb-a", ROUND, 'legacyUnderivable(history) ? "a" : "c"', '"a"'],
	["write-without-authority", ROUND, "if (writes && !(await handoffSeams.writerAuthorized(subject)))", "if (false)"],
	[
		"second-record-while-standing",
		ROUND,
		"if (write === undefined || standing !== undefined) return undefined;",
		"if (write === undefined) return undefined;",
	],
	["standing-ab-not-blocking", ROUND, 'if (view.standing !== undefined && view.standing.limb !== "c")', "if (false)"],
	[
		"population-refusal-ignored",
		ROUND,
		"\t\t\tif (!view.ok) return finish(state, {",
		"\t\t\tif (false) return finish(state, {",
	],
	[
		"limb-c-terminal-resets",
		HANDOFF,
		'if (limb !== "a" && limb !== "b") continue;',
		"if (limb === undefined) continue;",
	],
	["limb-a-honor-unchecked", HANDOFF, "if (!legacyUnderivable(repairHistory(before))) {", "if (false) {"],
	["reentry-encoding-dropped", HANDOFF, 'reentry: limb === "b" ? reentry : "none",', 'reentry: "none",'],
	[
		"limb-c-never-ended",
		ROUND,
		'if (standing !== undefined && standing.limb === "c" && wasDeterminate) {',
		"if (false) {",
	],
	[
		"valid-diagnosis-not-determinate",
		ROUND,
		"\t\t\tdiagnosedHistory = JSON.stringify(history);\n\t\t\tdeterminate = true;\n",
		"\t\t\tdiagnosedHistory = JSON.stringify(history);\n",
	],
	[
		"recovery-handoff-unrecorded",
		ROUND,
		'if (recovery.terminal === "handoff") pending = { limb: "b", reentry: recovery.reentry };',
		"",
	],
	[
		"reset-ignored",
		ROUND,
		"const before = await durableState(repoRoot, subject, seams, undefined, resetAfter);",
		"const before = await durableState(repoRoot, subject, seams, undefined, undefined);",
	],
	[
		"reenter-without-authority",
		ROUND,
		'\tif (!(await handoffSeams.writerAuthorized(subject)))\n\t\treturn { disposition: "refused", cause: REENTRY_REFUSED.authority };\n',
		"",
	],
	[
		"reenter-limb-c-accepted",
		ROUND,
		'} else if (target.limb !== "a" && target.limb !== "b") {',
		"} else if (target.limb === undefined) {",
	],
	[
		"reenter-prose-unchecked",
		ROUND,
		'if (!legacyRefuses()) return { disposition: "refused", cause: REENTRY_REFUSED.legacy };',
		"",
	],
	["check-adjudication-null", HISTORY, "if (adjudication === null || record.review", "if (record.review"],
	[
		"check-dedup",
		HISTORY,
		"if (!adjudication.dedupAttested || record.bundle.length === 0)",
		"if (record.bundle.length === 0)",
	],
	[
		"check-empty-bundle",
		HISTORY,
		"if (!adjudication.dedupAttested || record.bundle.length === 0)",
		"if (!adjudication.dedupAttested)",
	],
	[
		"check-count-difference",
		HISTORY,
		" || rulings.size !== dispositions.size) return undefined;",
		") return undefined;",
	],
	[
		"check-empty-provenance",
		HISTORY,
		"if (ruling.provenance.length === 0 || !ruling.evidence)",
		"if (!ruling.evidence)",
	],
	[
		"check-empty-evidence",
		HISTORY,
		"if (ruling.provenance.length === 0 || !ruling.evidence)",
		"if (ruling.provenance.length === 0)",
	],
	["check-severity", HISTORY, "(ruling.severity === undefined ||", "("],
	["check-direction", HISTORY, "\t\t\t\truling.direction === undefined ||\n", ""],
	["check-ac-impact", HISTORY, "\t\t\t\truling.onCriterion === undefined ||\n", ""],
	["check-nit-remedy", HISTORY, ' ||\n\t\t\t\t(ruling.severity === "NIT" && !ruling.remedy))', ")"],
	["check-unknown-slot", HISTORY, "(remaining.get(key) ?? Number.NaN) - 1", "(remaining.get(key) ?? 1) - 1"],
	[
		"check-multiset-leftover",
		HISTORY,
		"if ([...remaining.values()].some((count) => count !== 0)) return undefined;",
		"",
	],
	["check-index-finding", HISTORY, "if (disposition?.finding !== ruling.finding) return undefined;", ""],
	[
		"dishonored-limb-a-released",
		HANDOFF,
		"\t\t\t\trefuse();\n\t\t\t\tcontinue;\n\t\t\t}\n\t\t}\n\t\tresetAfter",
		"\t\t\t\tcontinue;\n\t\t\t}\n\t\t}\n\t\tresetAfter",
	],
	["two-standing-accepted", HANDOFF, "if (standingRecords.length > 1) return", "if (false) return"],
	["cause-literal-c", HANDOFF, 'c: "review-history-unmeasured",', 'c: "review-history-transient",'],
	["help-legacy-route", ROUND, " or a refusing limb-(a) legacy-prose history", ""],
	[
		"unreadable-review-refuses-population",
		HANDOFF,
		"	const reviews = orderedReviewRecords(comments, writerId);\n",
		'	const reviews = orderedReviewRecords(comments, writerId);\n	if (reviews === undefined) return { ok: false, cause: "unreadable" };\n',
	],
	[
		"concurrent-ab-record-ignored",
		ROUND,
		'if (fresh.standing !== undefined && fresh.standing.limb !== "c")',
		"if (false)",
	],
	["concurrent-c-record-ignored", ROUND, "\t\t\tstanding = fresh.standing;\n", ""],
	[
		"reenter-command-unrouted",
		ROUND,
		"const reentry = /^\\s*reenter\\s+pr=([1-9][0-9]{0,15})\\s*$/.exec(args);",
		"const reentry = /(?!)/.exec(args);",
	],
	[
		"reenter-standing-a-unchecked",
		ROUND,
		'} else if (target.limb === "a" && !legacyRefuses()) {',
		"} else if (false) {",
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

describe("#404 baseline-first isolated review-history handoff mutants", () => {
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

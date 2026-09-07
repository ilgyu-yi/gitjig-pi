/**
 * The development-provenance reader (issue #70; SPEC §2.4's genus, §2.5's
 * erasure test).
 *
 * The reader is ADVISORY by construction: §2.5's own closing sentence says
 * no gate class homes a decidable check for the authoring doctrine, and
 * §3.6's cost asymmetry puts a reversible stale-prose miss far below a
 * false block over a word like `now`. So every arm here that measures a
 * disposition measures a REPORT, and one arm measures the exit status
 * directly — refusing is out of contract, and an exit-nonzero reader would
 * be a gate this section does not license.
 *
 * The reader's input is a unified diff of a change's ADDED lines. That
 * choice is what keeps issue bodies, pull request bodies and commit
 * messages outside the domain: none of them is a file in the tree, so none
 * can reach this input at all. The arms below pin the exclusions that are
 * decidable — record-purpose paths, and paths outside the living set.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const READER = join(repoRoot(), ".github", "workflows", "check-provenance.sh");

interface ReaderRun {
	status: number;
	stdout: string;
	stderr: string;
}

/** Runs the reader over a unified diff supplied on stdin. */
function runReader(diff: string): ReaderRun {
	let status = 0;
	let stdout = "";
	let stderr = "";
	try {
		stdout = execFileSync("bash", [READER], { input: diff, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		status = typeof failure.status === "number" ? failure.status : 1;
		stdout = failure.stdout ?? "";
		stderr = failure.stderr ?? "";
	}
	return { status, stdout, stderr };
}

/** A one-file unified diff whose added lines are `lines`. */
function diffAdding(path: string, lines: readonly string[]): string {
	const body = lines.map((line) => `+${line}`).join("\n");
	return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
}

describe("the provenance reader exists and is advisory (issue #70, SPEC §2.5)", () => {
	it("the reader is present and executable by bash", () => {
		// An invariant, not a schedule: the workflow that runs this reader
		// resolves this exact path, so the path IS the contract.
		assert.ok(
			existsSync(READER),
			"no reader at .github/workflows/check-provenance.sh — the workflow resolves that exact path, so every arm below would measure nothing",
		);
	});

	it("exits ZERO on a clean input", () => {
		const run = runReader(diffAdding("src/thing.ts", ["// The predicate refuses an unmeasurable input."]));
		assert.equal(run.status, 0, `a clean input must exit 0. stderr was: ${run.stderr}`);
	});

	it("exits ZERO on a HIT-BEARING input — refusing is out of contract", () => {
		// The arm §2.5's advisory status owes: the reader may report and must
		// never refuse. An exit-nonzero reader is a gate class §2.5 says is not
		// homed for this norm, and §3.6's cost asymmetry rejects a false block
		// over ordinary documentation.
		const run = runReader(diffAdding("src/thing.ts", ["// red until the Code phase lands the helper."]));
		assert.ok(run.stdout.length > 0, "the hit-bearing input produced no report at all, so the arm measures nothing");
		assert.equal(
			run.status,
			0,
			`a hit-bearing input must still exit 0 — this reader is an instruction to re-read, never a verdict. stderr was: ${run.stderr}`,
		);
	});
});

/**
 * One instance of each shape the reader claims to cover. The claim is the
 * reader's own SHAPES list; this table is the measurement of it, so a shape
 * the reader names and cannot find fails here rather than being believed.
 */
const SHAPE_CASES: ReadonlyArray<{ shape: string; line: string; why: string }> = [
	{
		shape: "schedule",
		line: "// red until the Code phase lands publish/scan.ts.",
		why: "§1.2's species: a failing check's contract stating WHEN it goes green rather than what it asserts",
	},
	{
		shape: "schedule",
		line: "// This helper does not exist yet, so the arm fails.",
		why: "the same species in its other spelling",
	},
	{
		shape: "review-archaeology",
		line: "// Review round 3 found this survived the whole suite.",
		why: "§2.4's species: round numbers and prior-defect narrative on a living surface",
	},
	{
		shape: "change-narration",
		line: "// We added the second pass because the first one over-wrapped.",
		why: "the genus in its plainest form — how the repository got here",
	},
	{
		shape: "change-narration",
		line: "// This field was previously called `count`.",
		why: "a rename's provenance; §2.5(c) forbids the alias, and its story belongs in the commit",
	},
	{
		shape: "issue-narration",
		line: "// Added in #123 to close the auto-close channel.",
		why: "a change verb bound to an issue number — the pointer is fine, the narration is not",
	},
];

describe("every shape the reader claims to cover is reported (issue #70)", () => {
	for (const { shape, line, why } of SHAPE_CASES) {
		it(`reports the ${shape} shape: ${JSON.stringify(line.slice(0, 46))}`, () => {
			const run = runReader(diffAdding("src/thing.ts", [line]));
			assert.match(
				run.stdout,
				/src\/thing\.ts/,
				`the report names no file. A reader whose output cannot be navigated is an instruction nobody can follow (${why})`,
			);
			assert.match(run.stdout, /:1\b/, "the report names no line number");
			assert.ok(
				run.stdout.includes(line.trim()) || run.stdout.includes(line.trim().replace(/^\/\/ /, "")),
				`the report does not carry the sentence it found. Report was:\n${run.stdout}`,
			);
			assert.match(
				run.stdout,
				/erasure/i,
				"the report does not carry the remedy. §2.5's erasure test is what a reader applies to decide the sentence, so a hit without it is a flag without a criterion",
			);
		});
	}

	it("every shape the reader NAMES is exercised above — the table cannot silently shrink", () => {
		// The population is read off the reader itself rather than retyped, so
		// a shape added there without a case here fails, and a case here naming
		// a shape the reader dropped fails too.
		const declared = execFileSync(
			"bash",
			["-c", `grep -oE '^# *SHAPE: *[a-z-]+' ${JSON.stringify(READER)} | sed 's/.*: *//'`],
			{
				encoding: "utf8",
			},
		)
			.split("\n")
			.filter((entry) => entry.length > 0)
			.sort();
		const covered = [...new Set(SHAPE_CASES.map((entry) => entry.shape))].sort();
		assert.deepEqual(
			covered,
			[...new Set(declared)].sort(),
			"the shapes this table exercises are not the shapes the reader declares. A reader claiming a shape no case drives is a claim with no measurement behind it",
		);
	});
});

describe("the reader's domain is the living set (issue #70, SPEC §2.5)", () => {
	it("a changelog fragment carrying the MANDATED (#N) produces no hit", () => {
		// changelog_unreleased/** is record-purpose, and its TEMPLATE.md states
		// the bullet MUST contain (#N). A reader that flagged the mandated form
		// would refuse the repository's own contract.
		const run = runReader(
			diffAdding("changelog_unreleased/fixed/70.md", [
				"- The reader now reports development provenance on a change's added lines. (#70)",
			]),
		);
		assert.equal(run.stdout.trim(), "", `a record-purpose path produced a hit:\n${run.stdout}`);
		assert.equal(run.status, 0);
	});

	it("a record-purpose path is excluded even carrying an unambiguous hit", () => {
		// The exclusion is by PATH, not by whether the line looks clean —
		// otherwise the domain would depend on the sentence rather than on the
		// surface's purpose.
		const run = runReader(
			diffAdding("changelog_unreleased/fixed/70.md", [
				"- We added this in review round 3, red until the helper lands. (#70)",
			]),
		);
		assert.equal(
			run.stdout.trim(),
			"",
			`a record-purpose path was scanned. Its purpose is to record how the repository got here, which is exactly the genus — so scanning it would invert the rule:\n${run.stdout}`,
		);
	});

	it("a path outside the living set is not scanned", () => {
		const run = runReader(diffAdding("notes/scratch.txt", ["We added this in review round 3."]));
		assert.equal(run.stdout.trim(), "", `a non-living-set path was scanned:\n${run.stdout}`);
	});

	it("REMOVED lines are not scanned — the domain is a change's ADDED lines", () => {
		const removal =
			"diff --git a/src/thing.ts b/src/thing.ts\n" +
			"--- a/src/thing.ts\n+++ b/src/thing.ts\n" +
			"@@ -1,1 +0,0 @@\n-// red until the Code phase lands the helper.\n";
		const run = runReader(removal);
		assert.equal(
			run.stdout.trim(),
			"",
			`a removed line was reported. Deleting provenance is the repair §2.5 prescribes, so flagging the deletion would report the fix as the defect:\n${run.stdout}`,
		);
	});
});

describe("the reader's false-positive residual is measured, not asserted (issue #70)", () => {
	it("current-state prose using `now`, `no longer` and a bare #N pointer", () => {
		// The three shapes §5.1's pointer idiom and ordinary current-state
		// documentation produce. What the reader does with them is MEASURED
		// here and stated in its header; neither is decided by assertion.
		const lines = [
			"// The boundary now admits §1.1's linkage line on a description kind.",
			"// A bare same-repository reference is no longer wrapped.",
			"// The exemption's placement is the safety property (#129).",
		];
		const run = runReader(diffAdding("src/thing.ts", lines));
		assert.equal(
			run.stdout.trim(),
			"",
			`current-state prose was reported. All three sentences read as documentation of the current HEAD with the repository's history erased, which is §2.5's test — a reader that flags them turns the erasure test into a word filter:\n${run.stdout}`,
		);
	});

	it("the reader's header states the residual it carries", () => {
		const source = execFileSync("cat", [READER], { encoding: "utf8" });
		assert.match(
			source,
			/residual/i,
			"the reader's header does not state its own residual. A reader with a known miss that does not say so leaves its reader believing a clean run means clean prose",
		);
	});
});

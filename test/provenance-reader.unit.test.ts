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
import { existsSync, readFileSync } from "node:fs";
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
 * One instance of every ALTERNATIVE the reader applies — not one per shape.
 *
 * At shape granularity this table measured almost nothing: with the rules
 * written as four fat regexes, thirteen of twenty-one alternatives could be
 * deleted outright and the whole suite stayed green, because one fixture
 * satisfied its shape through a different alternative. The unit of a rule
 * is the alternative, so the unit of a case is too.
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
		line: "// Review round notes belong in the review record.",
		why: "§2.4's species: round numbers and prior-defect narrative on a living surface",
	},
	{
		shape: "change-narration",
		line: "// We added the second pass because the first one over-wrapped.",
		why: "the genus in its plainest form — how the repository got here",
	},
	{
		shape: "change-narration",
		line: "// A field previously called `count`.",
		why: "a rename's provenance; §2.5(c) forbids the alias, and its story belongs in the commit",
	},
	{
		shape: "issue-narration",
		line: "// Added in #123 to close the auto-close channel.",
		why: "a change verb bound to an issue number — the pointer is fine, the narration is not",
	},
	{ shape: "schedule", line: "// Blocked until Phase C.", why: "the phase spelling, with no other rule reaching it" },
	{ shape: "schedule", line: "// The guard is not yet implemented.", why: "a state that dates itself" },
	{ shape: "schedule", line: "// Green once the helper lands.", why: "the same schedule with the keyword moved" },
	{
		shape: "schedule",
		line: "// The count will be added in a later pass.",
		why: "a promise, which the next commit falsifies",
	},
	{
		shape: "review-archaeology",
		line: "// Round 4 caught the survivor here.",
		why: "§2.4's round numbers, in the bare-numeral spelling",
	},
	{
		shape: "review-archaeology",
		line: "// The reviewer noted that both anchors survived.",
		why: "prior-defect narrative attributed to the review",
	},
	{
		shape: "review-archaeology",
		line: "// An earlier review asked for this split.",
		why: "the same narrative without a round number",
	},
	{ shape: "issue-narration", line: "// Introduced in #12 alongside the boundary.", why: "the introduce verb" },
	{ shape: "issue-narration", line: "// Fixed in #34 after the flake was found.", why: "the fix verb" },
	{ shape: "issue-narration", line: "// Removed in #56 when the alias went.", why: "the remove verb" },
	{ shape: "issue-narration", line: "// Landed in #78 with its own arm.", why: "the land verb" },
	{
		shape: "change-narration",
		line: "// It was renamed to keep the call sites honest.",
		why: "the passive spelling, which no `we` catches",
	},
	{ shape: "change-narration", line: "// This used to carry the whole union.", why: "the used-to spelling" },
	{ shape: "change-narration", line: "// The field was previously optional.", why: "the was-previously spelling" },
	{ shape: "change-narration", line: "// A helper formerly named subjectAbsent.", why: "the formerly spelling" },
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

	it("each case violates EXACTLY ONE rule — or it measures a different rule than it names", () => {
		// The property that makes the per-rule table mean anything. The reader
		// stops at the first matching rule, so a fixture satisfying two is
		// reported by the nearer one and the further one stays unmeasured while
		// its case reads as coverage. Measured, two fixtures did exactly that
		// and their rules survived deletion with every arm green.
		const rules = readFileSync(READER, "utf8")
			.split("\n")
			.filter((entry) => entry.startsWith("RULE "))
			.map((entry) => {
				const parsed = entry.match(/^RULE (\S+) '(.*)'$/);
				assert.ok(parsed, `a RULE line this arm cannot parse would silently drop a rule: ${entry}`);
				return parsed[2];
			});
		assert.ok(rules.length > 0, "no RULE lines parsed, so this arm would pass over an empty population");
		for (const { line } of SHAPE_CASES) {
			const sentence = line.replace(/^\/\/ /, "");
			const matched = rules.filter((rule) => {
				const probe = execFileSync(
					"bash",
					["-c", 'if [[ "$1" =~ $2 ]]; then echo yes; else echo no; fi', "probe", sentence, rule],
					{ encoding: "utf8" },
				).trim();
				return probe === "yes";
			});
			assert.equal(
				matched.length,
				1,
				`${JSON.stringify(sentence)} matches ${matched.length} rules, not one: ${JSON.stringify(matched)}. The reader stops at the first, so every other rule this input touches is measured by nothing while this case reads as its coverage`,
			);
		}
	});

	it("every RULE the reader declares has a case — counted per alternative, not per shape", () => {
		// The population is read off the reader itself rather than retyped: each
		// `RULE <shape> '<regex>'` line is one alternative. A rule added there
		// without a case here fails, and a case naming a rule the reader dropped
		// fails too.
		//
		// Counted per SHAPE this arm passed while thirteen alternatives matched
		// nothing, because one fixture satisfied a shape through a different
		// alternative. The granularity is the whole point: one case per rule.
		const declaredCount = execFileSync("bash", ["-c", `grep -cE "^RULE " ${JSON.stringify(READER)}`], {
			encoding: "utf8",
		}).trim();
		assert.equal(
			String(SHAPE_CASES.length),
			declaredCount,
			`the reader declares ${declaredCount} rules and this table drives ${SHAPE_CASES.length}. A rule no case reaches can be deleted or broken by a stray metacharacter and nothing reports it`,
		);
		const declaredShapes = execFileSync(
			"bash",
			["-c", `grep -oE "^RULE [a-z-]+" ${JSON.stringify(READER)} | sed 's/^RULE //'`],
			{ encoding: "utf8" },
		)
			.split("\n")
			.filter((entry) => entry.length > 0);
		assert.deepEqual(
			[...SHAPE_CASES.map((entry) => entry.shape)].sort(),
			[...declaredShapes].sort(),
			"the shapes this table exercises are not the shapes the reader declares, rule for rule",
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

	it("a markdown path IS in the domain — the living set is mostly prose", () => {
		// SPEC.md and README.md are the surfaces the doctrine is most about, and
		// nothing pinned that the reader reads them: dropping markdown from the
		// extension set left every arm green, because every other fixture is a
		// TypeScript path.
		const run = runReader(diffAdding("docs/thing.md", ["We added the second pass in review round 3."]));
		assert.match(
			run.stdout,
			/docs\/thing\.md:1:/,
			"a markdown path was not scanned. The living set is this SPEC, the README and the docs before it is anything else",
		);
	});

	it("a path carrying a SPACE is scanned — git's tab-separated header is parsed", () => {
		// git appends a tab and metadata to a header path containing whitespace.
		// Taking the raw remainder as the path left the extension test failing
		// on the trailing tab, so the whole file was skipped with no diagnostic
		// — a fail-open miss on exactly the files least likely to be noticed.
		const diff =
			"diff --git a/my file.md b/my file.md\n--- a/my file.md\t\n+++ b/my file.md\t\n" +
			"@@ -0,0 +1,1 @@\n+We added the spaced file.\n";
		const run = runReader(diff);
		assert.match(run.stdout, /my file\.md:1:/, `a path with a space was skipped whole:\n${run.stdout}`);
	});

	it("a QUOTED path is scanned — git C-quotes a header path carrying non-ASCII", () => {
		const diff =
			'diff --git a/x.md b/x.md\n--- "a/caf\\303\\251.md"\n+++ "b/caf\\303\\251.md"\n' +
			"@@ -0,0 +1,1 @@\n+We added the accented file.\n";
		const run = runReader(diff);
		assert.match(run.stdout, /\.md:1:/, `a C-quoted path was skipped whole:\n${run.stdout}`);
	});

	it("content that LOOKS like a file header does not steal the attribution", () => {
		// An added line whose own text begins with `++ ` has the diff spelling of
		// a `+++ ` header. Treating it as one reset the path to a file not in the
		// diff and the line counter to zero, so the report pointed at the wrong
		// file and the wrong line. A report that cannot be navigated is worse
		// than no report, so the header arms are gated on where a header can
		// appear: immediately after the matching `--- ` line.
		const diff =
			"diff --git a/hdr.ts b/hdr.ts\n--- a/hdr.ts\n+++ b/hdr.ts\n@@ -0,0 +1,3 @@\n" +
			"+// ok\n+++ b/elsewhere.ts\n+// We added the guard.\n";
		const run = runReader(diff);
		assert.match(
			run.stdout,
			/hdr\.ts:3:/,
			`the hit was attributed to the wrong file or line. It is at hdr.ts line 3:\n${run.stdout}`,
		);
		assert.doesNotMatch(run.stdout, /elsewhere\.ts/, "a file that is not in the diff was named in the report");
	});

	it("a malformed hunk header does not abort the scan", () => {
		// The worst failure mode available to this reader, and it was reachable:
		// a `@@`-leading line whose range does not parse raised an
		// arithmetic-expansion error, which bash makes fatal to the enclosing
		// loop. Every remaining file was dropped, the count stayed 0, and the
		// run was indistinguishable from a clean one — a stopped scan wearing a
		// clean result, in a reader whose header says a clean run must not be
		// read as clean prose.
		const diff = "@@ bogus @@\n--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +5 @@\n+We added junk\n";
		const run = runReader(diff);
		assert.match(
			run.stdout,
			/x\.ts:5:/,
			`the scan stopped at a malformed hunk header and reported nothing, which reads exactly like a clean change:\n${run.stdout}`,
		);
		assert.equal(run.status, 0);
	});

	it("a REMOVED line shaped like a header does not steal the attribution either", () => {
		// The first repair of this class gated `+++ ` on the previous line
		// beginning `--- `. That closed one spelling, not the class: a REMOVED
		// line whose own text begins `-- ` has exactly that diff spelling, so
		// content produced by real git could still take the file and the line.
		//
		// The gate is now ENTRY state — a `+++ ` line is a header only before
		// the first hunk of its `diff --git` entry — which content cannot forge.
		const diff =
			"diff --git a/doc.md b/doc.md\n--- a/doc.md\n+++ b/doc.md\n@@ -1,5 +1,6 @@\n" +
			" line1\n--- old bullet\n+++ b/nonexistent.ts\n keep\n keep2\n+Round 3 caught this\n";
		const run = runReader(diff);
		assert.match(run.stdout, /doc\.md:5:/, `the hit is at doc.md line 5:\n${run.stdout}`);
		assert.doesNotMatch(run.stdout, /nonexistent\.ts/, "a path forged by removed content was named in the report");
	});

	it("a COMBINED diff's added lines get the merge-result line number", () => {
		// Merges produce `@@@ -a,b -c,d +e,f @@@`, which the ordinary hunk
		// pattern does not match — so the header was not recognised, the line
		// counter carried over from whatever came before, and every added line
		// of every combined entry was reported at a silently wrong number. The
		// merge-result range is the LAST one, and a combined entry carries one
		// leading column per parent, so the extra `+` is diff syntax rather than
		// the author's bytes.
		const diff =
			"diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -900,0 +900,1 @@\n+ordinary\n" +
			"diff --cc x.ts\n--- a/x.ts\n+++ b/x.ts\n@@@ -1,3 -1,3 +7,5 @@@\n  ctx\n++We added the flag\n";
		const run = runReader(diff);
		assert.match(
			run.stdout,
			/x\.ts:8: \[change-narration\] We added the flag/,
			`the combined entry's hit is at x.ts line 8, with the parent column stripped from the sentence:\n${run.stdout}`,
		);
	});

	it("a line longer than the cap is not read, and the cap is disclosed", () => {
		// bash's matcher is quadratic in the subject's length: an added line of
		// 200 KB — one minified .json or .js line, well inside the living set —
		// cost seconds each, and a job killed by a timeout is a red X on a check
		// designed never to fail a pull request. A sentence is not 200 KB.
		const long = `once ${"x".repeat(20000)}`;
		const started = Date.now();
		const run = runReader(diffAdding("src/thing.ts", [long, "// red until the helper lands."]));
		assert.ok(Date.now() - started < 10_000, "the reader stalled on a long line");
		assert.doesNotMatch(run.stdout, /xxxx/, "a line past the cap was matched anyway");
		assert.match(
			run.stdout,
			/thing\.ts:2:/,
			`a line past the cap must be SKIPPED, not stop the scan — the line after it still counts and is still read:\n${run.stdout}`,
		);
		const source = readFileSync(READER, "utf8");
		assert.match(source, /MAX_LINE/, "the cap is not stated in the reader, so its miss is undisclosed");
	});

	it("a diff whose HEADERS carry CRLF is still scanned", () => {
		const diff = "diff --git a/x.ts b/x.ts\r\n--- a/x.ts\r\n+++ b/x.ts\r\n@@ -0,0 +1,1 @@\r\n+We added the flag\r\n";
		const run = runReader(diff);
		assert.match(
			run.stdout,
			/x\.ts:1:/,
			`a CRLF header left the path carrying a CR, so the whole file left the domain:\n${run.stdout}`,
		);
	});

	it("a final line with no trailing newline is still read", () => {
		const run = runReader("diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +5 @@\n+We added the flag");
		assert.match(
			run.stdout,
			/x\.ts:5:/,
			`the last line was dropped because the read returned false on it:\n${run.stdout}`,
		);
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

	it("a line that MENTIONS a shape rather than committing it is still reported", () => {
		// The residual that cannot be designed away. A rule that exempted
		// quotation would need to tell use from mention, which is the whole
		// problem; a path allowlist would silence real hits in exactly the files
		// most likely to grow them — this reader's own source, and this file.
		//
		// So it is pinned rather than fixed: the reader reports a definition of a
		// shape exactly as it reports a use. Measured here so the behaviour is a
		// known quantity to whoever reads a run, and so it cannot change silently.
		const mention = runReader(
			diffAdding("src/thing.ts", ["// A sentence saying `red until X lands` is what this rule forbids."]),
		);
		assert.match(
			mention.stdout,
			/\[schedule\]/,
			"a MENTION of a forbidden shape went unreported, which would mean the reader distinguishes use from mention — it does not, and its header says so",
		);
		assert.equal(mention.status, 0, "still advisory");
	});

	it("the workflow does not print a clean line when nothing was scanned", () => {
		// The repair for a scan that never started was landed in the workflow,
		// and nothing in the suite read that file — so the guard could be deleted
		// with every arm green. A guard the suite never measures is decoration
		// (§3.12), and this one carries §3.9's rule that a disarmed check must
		// never read as a passing one.
		const workflow = readFileSync(join(repoRoot(), ".github", "workflows", "check-provenance.yml"), "utf8");
		assert.match(
			workflow,
			/if ! git diff [^\n]*; then/,
			"the diff is piped straight into the reader, so a failing `git diff` leaves the report empty and the job falls through to its clean line — a scan that never started, reported as one that found nothing",
		);
		assert.match(
			workflow,
			/NOT a clean result/,
			"the degraded path does not say plainly that nothing was scanned. §3.9 forbids a disarmed check reading as a passing one, and the posture row claims this signal exists",
		);
		assert.match(
			workflow,
			/must NOT be added to the branch ruleset/i,
			"the workflow no longer states that it must stay out of the required-check set, which is the one thing keeping an advisory reader from becoming a gate",
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

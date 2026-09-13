/**
 * Behavioral suite for the authoring pass at the commit-msg adapter
 * (issue #218; SPEC §2.4, §2.5, §3.9, §3.11).
 *
 * Subject under test: the COMMITTED local-tier chain — this repository's
 * `.githooks/commit-msg` + `.githooks/_lib.sh` +
 * `.githooks/helpers/authoring_pass.sh`, copied byte-for-byte into a
 * disposable git repository by `harness/githook-fixture.ts` and driven only
 * through `git commit`. No arm calls a shell function directly.
 *
 * WHAT THESE ARMS PIN, AND WHAT THEY CANNOT. The step has two halves. The
 * machine half — laying the staged diff and the prepared message out
 * together, with the reader's report and the disposition beside them — is
 * what every arm below measures. The judgement half is a discipline no
 * assertion can reach: nothing here establishes that a sentence is true,
 * and a green commit is not a vouched commit. The arms therefore pin
 * PRESENCE of the layout and ABSENCE of any refusal, which is the whole of
 * what a report-only surface owes (§3.11).
 *
 * Environment constraints stated in place:
 *   - The fixture copies `.githooks/` alone, so the committed reader at
 *     `.github/workflows/check-provenance.sh` is ABSENT there by default.
 *     That is the degradation arm's subject; the call-site arm plants the
 *     repository's own reader at the same relative path and measures the
 *     chain with it present.
 *   - Markers use distinctive spellings so a "these bytes reached the
 *     layout" assertion cannot collide with incidental git output.
 *   - Every message is conventional-commit grammatical unless the arm's
 *     subject IS the grammar, because the commit-format arm runs FIRST and
 *     a refusal there is a different measurement.
 *   - POSIX bytes and bash are required: the suite skips on win32.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	buildGithookFixture,
	commitWithMessage,
	fixtureGit,
	type GithookFixture,
	removeDelegatedHelpers,
	removeGithookFixture,
} from "./harness/githook-fixture.ts";
import { repoRoot } from "./harness/run-pi.ts";

const READER_REL = ".github/workflows/check-provenance.sh";
const HELPER_REL = ".githooks/helpers/authoring_pass.sh";

/** Stage a living-set file carrying `line`, so the reader has a domain to read. */
function stageProse(fixture: GithookFixture, name: string, line: string): void {
	writeFileSync(join(fixture.root, name), `${line}\nexport const zqMarker = 1;\n`);
	fixtureGit(fixture, ["add", name]);
}

/** Plant a reader that never returns, so the budget is what ends the run. */
function plantHangingReader(fixture: GithookFixture): void {
	mkdirSync(join(fixture.root, ".github", "workflows"), { recursive: true });
	writeFileSync(join(fixture.root, READER_REL), "#!/usr/bin/env bash\ncat >/dev/null\nsleep 600\n");
}

/**
 * Pass `budget` as the layout's second argument in the FIXTURE's adapter.
 *
 * This is the seam, and its shape is the point: the budget is an ARGUMENT,
 * so a caller who can set it is already running the function. The committed
 * adapter passes nothing, and no environment variable reaches the budget —
 * for one revision one did, and every all-digit value was honoured, which
 * handed the committing environment control over how long a commit is held.
 */
function patchAdapterBudget(fixture: GithookFixture, budget: string | null): void {
	const adapter = join(fixture.root, ".githooks", "commit-msg");
	const committed = readFileSync(join(repoRoot(), ".githooks", "commit-msg"), "utf8");
	const call = 'authoring_pass_layout "$_gh_msgfile"';
	assert.ok(committed.includes(call), "the adapter's call site did not match, so this arm would patch nothing");
	writeFileSync(adapter, budget === null ? committed : committed.replace(call, `${call} ${JSON.stringify(budget)}`));
}

/** Plant this repository's own committed reader into the fixture. */
function plantReader(fixture: GithookFixture): void {
	mkdirSync(join(fixture.root, ".github", "workflows"), { recursive: true });
	copyFileSync(join(repoRoot(), READER_REL), join(fixture.root, READER_REL));
}

describe(
	"the authoring pass lays the diff and the message out together (issue #218)",
	{ skip: process.platform === "win32" },
	() => {
		let fixture: GithookFixture;

		before(() => {
			fixture = buildGithookFixture();
		});
		after(() => {
			removeGithookFixture(fixture);
		});

		it("prints all four sections of the layout on an ordinary commit", () => {
			const attempt = commitWithMessage(fixture, "feat(#218): lay the pair out\n");
			assert.equal(
				attempt.status,
				0,
				`the pass refused a commit. It is report-only and refuses nothing.\n${attempt.stderr}`,
			);
			for (const section of [
				"authoring pass",
				"the diff this message is about",
				"the message you are about to write",
				"prose the diff ADDS",
			]) {
				assert.ok(
					attempt.stderr.includes(section),
					`the layout is missing the "${section}" section, so the pair was not laid out together. Saw:\n${attempt.stderr}`,
				);
			}
		});

		it("the message's own bytes reach the layout — it is the MESSAGE that is laid out, not a placeholder", () => {
			const attempt = commitWithMessage(fixture, "feat(#218): zqSubjectMarker\n\nzqBodyMarker in the body.\n");
			assert.ok(attempt.stderr.includes("zqSubjectMarker"), `the subject never reached the layout:\n${attempt.stderr}`);
			assert.ok(attempt.stderr.includes("zqBodyMarker"), `the body never reached the layout:\n${attempt.stderr}`);
		});

		it("the staged stat reaches the layout — it is THIS diff that is laid out", () => {
			stageProse(fixture, "zqstat.ts", "// an ordinary comment");
			const attempt = commitWithMessage(fixture, "feat(#218): stat beside the message\n");
			assert.ok(
				attempt.stderr.includes("zqstat.ts"),
				`the staged path never reached the layout, so the message sits beside no diff:\n${attempt.stderr}`,
			);
		});

		it("carries the disposition, its pointer, and all FOUR exceptions", () => {
			const attempt = commitWithMessage(fixture, "feat(#218): the disposition\n");
			assert.ok(
				attempt.stderr.includes("DELETED"),
				`the layout does not state the disposition. A pass that points at a sentence without saying what to do with it is the rewrite generator it exists to close.\n${attempt.stderr}`,
			);
			assert.ok(
				attempt.stderr.includes('SPEC §2.5, "Deletion is the default repair"'),
				`the printed rule names no source clause. §2.8 binds code-adjacent prose to point at the clause it enforces, and a working form with no pointer is a copy a reader cannot check.\n${attempt.stderr}`,
			);
			// An UNENUMERATED exception is where a stated rule breaks, so each is
			// pinned individually rather than by a count. The fourth is §2.5's own
			// repair case, which the first revision of this block dropped.
			for (const exception of ["NIT remedy", "wrong literal", "arm titles", "acceptance criterion"]) {
				assert.ok(
					attempt.stderr.includes(exception),
					`the disposition's "${exception}" exception is missing from the layout:\n${attempt.stderr}`,
				);
			}
		});

		it("the printed rule is pinned WHOLE-STRING, so the copy cannot drift from its clause", () => {
			// The equality lock. A substring check over normative prose stays green
			// while the instruction inverts — an appended negating qualifier defeats
			// it — so the block is compared entire. This is the guard §2.8's
			// never-copy rule asks for where a copy is kept deliberately: the copy is
			// allowed because an acceptance criterion depends on the rule standing at
			// the step, and it is allowed only while something holds it to its source.
			const expected = [
				'  THE DISPOSITION (SPEC §2.5, "Deletion is the default repair")',
				"  A flagged prose sentence is DELETED. It is not replaced, re-tensed, or",
				"  re-derived: a rewrite is a fresh claim carrying the same burden the",
				"  deleted one failed.",
				"",
				"  Exceptions:",
				"    1. A Judge's verbatim NIT remedy — the text is the Judge's, not yours.",
				"    2. A wrong literal — a number, an identifier, a path — may be corrected",
				"       in place. The sentence EXPLAINING it is deleted, not re-derived.",
				"    3. Code, assertions and arm titles are not prose.",
				"    4. A claim an acceptance criterion or a live contract depends on is",
				"       REPAIRED, not deleted, and the repair carries a render or a pointer.",
			].join("\n");

			const printed = execFileSync(
				"bash",
				["-c", `. ${JSON.stringify(join(repoRoot(), HELPER_REL))} && authoring_pass_rule`],
				{ encoding: "utf8" },
			).replace(/\n$/, "");

			assert.equal(
				printed,
				expected,
				"the printed disposition is not byte-equal to the text this arm holds. §2.8 forbids a hand-copy of a contract precisely because the copy loses its qualifiers in transit; the copy stands here only while this equality holds it to what was reviewed against §2.5",
			);
		});
	},
);

describe(
	"the authoring pass is report-only and never refuses (issue #218, SPEC §3.11)",
	{ skip: process.platform === "win32" },
	() => {
		let fixture: GithookFixture;

		before(() => {
			fixture = buildGithookFixture();
			plantReader(fixture);
		});
		after(() => {
			removeGithookFixture(fixture);
		});

		it("a staged sentence the reader FLAGS is reported, and the commit still lands", () => {
			stageProse(fixture, "zqflag.ts", "// the run went 85ms to 12,096ms.");
			const attempt = commitWithMessage(fixture, "feat(#218): a flagged sentence commits\n");
			assert.ok(
				attempt.stderr.includes("measurement-claim"),
				`the planted reader was not called, so the layout's third section establishes nothing:\n${attempt.stderr}`,
			);
			assert.ok(
				attempt.stderr.includes("rendered-or-pointer"),
				`the hit carries no remedy, so it is a flag with no criterion:\n${attempt.stderr}`,
			);
			assert.equal(
				attempt.status,
				0,
				"a flagged sentence blocked the commit. §2.5 states that no gate class homes a decidable check for the authoring doctrine; a refusal here would be that gate",
			);
		});

		it("a reader that EXITS NON-ZERO is not reported as a clean run", () => {
			// Empty output from a crashed reader and empty output from a clean one
			// are the same bytes. Reading only the bytes reports a run that never
			// happened as one that found nothing.
			writeFileSync(join(fixture.root, READER_REL), "#!/usr/bin/env bash\ncat >/dev/null\nexit 3\n");
			stageProse(fixture, "zqcrash.ts", "// an ordinary comment.");
			const attempt = commitWithMessage(fixture, "feat(#218): a crashed reader\n");
			assert.equal(attempt.status, 0, `a crashed reader blocked a commit:\n${attempt.stderr}`);
			assert.ok(
				attempt.stderr.includes("the reader exited 3"),
				`the reader's status was discarded:\n${attempt.stderr}`,
			);
			assert.ok(
				!attempt.stderr.includes("no row matched"),
				`a crashed reader was reported as a clean run, which is the one reading that licenses shipping the sentence it never read:\n${attempt.stderr}`,
			);
			plantReader(fixture);
		});

		it("a clean diff says so, and says what the clean run does NOT establish", () => {
			stageProse(fixture, "zqclean.ts", "// an ordinary invariant comment.");
			const attempt = commitWithMessage(fixture, "feat(#218): a clean diff\n");
			assert.ok(
				attempt.stderr.includes("enumeration and never a class"),
				`a clean run is reported without naming the property it does not establish (§3.11's report-only rule):\n${attempt.stderr}`,
			);
			assert.equal(attempt.status, 0);
		});
	},
);

describe(
	"the authoring pass degrades to allow, loudly (issue #218, SPEC §3.9)",
	{ skip: process.platform === "win32" },
	() => {
		let fixture: GithookFixture;

		before(() => {
			fixture = buildGithookFixture();
		});
		after(() => {
			removeGithookFixture(fixture);
		});

		it("an ABSENT reader is named in place of the report, and the commit lands", () => {
			const attempt = commitWithMessage(fixture, "feat(#218): no reader in this tree\n");
			assert.ok(
				attempt.stderr.includes(READER_REL),
				`the missing reader is not named, so a reader that never ran reads as a clean run:\n${attempt.stderr}`,
			);
			assert.equal(
				attempt.status,
				0,
				"an absent reader blocked a commit. The guarded act here is reading, and a refusal cannot make anyone read",
			);
		});

		it("an ABSENT helper leaves a record naming this arm, and the commit lands", () => {
			// Every delegated helper goes, then conventional_commit.sh comes back:
			// the commit-format arm runs FIRST and its absence would end the hook
			// before this arm is reached, which measures the wrong thing.
			const grammar = readFileSync(join(repoRoot(), ".githooks/helpers/conventional_commit.sh"));
			removeDelegatedHelpers(fixture);
			writeFileSync(join(fixture.helpersDir, "conventional_commit.sh"), grammar);

			const attempt = commitWithMessage(fixture, "feat(#218): the helper is gone\n");
			assert.equal(attempt.status, 0, `an absent helper blocked a commit:\n${attempt.stderr}`);
			assert.ok(
				!attempt.stderr.includes("authoring pass"),
				"a layout was printed with no helper present, so the layout is not coming from the helper this arm thinks it is",
			);
			assert.match(
				attempt.stderr,
				/\[dev-shell\]/,
				`the degradation is silent, so a commit that was never laid out reads exactly like one that was:\n${attempt.stderr}`,
			);
		});

		it("a helper that sources cleanly but defines NOTHING says so, and says what it did not gate", () => {
			// The stub shape satisfies safe_source, so _lib.sh's own miss record
			// never fires and the arm's only possible signal is its own line.
			writeFileSync(
				join(fixture.helpersDir, "authoring_pass.sh"),
				"# stub helper: sources cleanly, defines no delegated function\n",
			);
			const attempt = commitWithMessage(fixture, "feat(#218): a stub helper\n");
			assert.equal(attempt.status, 0, `a stub helper blocked a commit:\n${attempt.stderr}`);
			assert.ok(
				attempt.stderr.includes("no authoring-pass layout was printed"),
				`the missing layout is silent:\n${attempt.stderr}`,
			);
			assert.ok(
				attempt.stderr.includes("Nothing was gated by this"),
				`the line does not say what it did NOT stop. A report-only surface names the property it does not establish (§3.11), and borrowing §3.9's degradation wording here would report an enforcement loss that did not happen:\n${attempt.stderr}`,
			);
			// Scoped to this arm's own category: the fixture's other helpers are
			// still absent from the arm above, and their records are theirs.
			assert.deepEqual(
				attempt.auditDelta.split("\n").filter((line) => line.includes('"category":"authoring-pass"')),
				[],
				`the missing layout wrote to the enforcement trail. That trail is how a reader separates an allow the machinery measured from one it did not, and this arm measures nothing and allows nothing; delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
		});
	},
);

describe(
	"arm ordering at the commit-msg adapter (issue #218, SPEC §3.2)",
	{ skip: process.platform === "win32" },
	() => {
		let fixture: GithookFixture;

		before(() => {
			fixture = buildGithookFixture();
		});
		after(() => {
			removeGithookFixture(fixture);
		});

		it("an emission BELOW the layout reaches `cause` — the harness cuts the block, not the tail", () => {
			// The harness drops the layout from `cause` so the layout is not read as
			// a refusal. Cutting from the banner to the END of the stream instead
			// would blind every negative `cause` assertion in every githook suite to
			// anything an adapter emits after the layout — including the arm whose
			// whole subject is that no line borrows §3.9's degradation wording.
			const adapter = join(fixture.root, ".githooks", "commit-msg");
			const source = readFileSync(adapter, "utf8");
			const marker = "printf 'zqBelowLayout\\n' >&2\n";
			const patched = source.replace(/\nexit 0\n$/, `\n${marker}\nexit 0\n`);
			assert.notEqual(
				patched,
				source,
				"the adapter's trailing `exit 0` did not match, so nothing was appended and this arm measures nothing",
			);
			writeFileSync(adapter, patched);

			const attempt = commitWithMessage(fixture, "feat(#218): an emission below the layout\n");
			assert.ok(
				attempt.stderr.includes("zqBelowLayout"),
				`the appended emission never reached stderr, so this arm measures nothing:\n${attempt.stderr}`,
			);
			assert.ok(
				attempt.cause.includes("zqBelowLayout"),
				"an emission below the layout is invisible to `cause`. Every negative `cause` assertion in every githook suite is then blind to whatever an adapter says after the layout",
			);
			assert.ok(
				!attempt.cause.includes("authoring pass"),
				`the layout itself reached \`cause\`, so it reads as a refusal cause:\n${attempt.cause}`,
			);

			writeFileSync(adapter, source);
		});

		it("a refused subject prints NO layout — the pass runs after the grammar arm", () => {
			const attempt = commitWithMessage(fixture, "not a conventional subject at all\n");
			assert.notEqual(
				attempt.status,
				0,
				"the commit-format arm did not refuse, so this arm measures nothing about ordering",
			);
			assert.ok(
				!attempt.stderr.includes("authoring pass"),
				`a layout was printed for a message that is not going to land. Reading a rejected pair is work spent on a commit that does not exist:\n${attempt.stderr}`,
			);
		});
	},
);

describe(
	"the reader's budget is the adapter's, never the environment's (issue #218, SPEC §3.9)",
	{ skip: process.platform === "win32" },
	() => {
		let fixture: GithookFixture;

		before(() => {
			fixture = buildGithookFixture();
			plantHangingReader(fixture);
		});
		after(() => {
			removeGithookFixture(fixture);
		});

		// WHAT THESE ARMS PIN, and it is the INVARIANT and not a printed number:
		// with a reader that never returns, the commit LANDS, and it lands inside
		// a fixed wall-clock ceiling. That is the property an unbounded budget
		// breaks, and it broke twice — once with no budget at all, once with a
		// budget the environment could set to an arbitrary all-digit value.
		//
		// THEY ARE SLOW BY CONSTRUCTION. Three of the four wait out the
		// compiled-in budget, because a fallback that silently honoured its input
		// would be indistinguishable from one that did not until the wait ran
		// long. The cost is the measurement.
		const CEILING_MS = 60_000;

		const driveHungCommit = (budget: string | null, label: string, env?: Record<string, string>) => {
			patchAdapterBudget(fixture, budget);
			const started = Date.now();
			const attempt = commitWithMessage(fixture, `feat(#218): ${label}\n`, env ? { env } : {});
			const elapsed = Date.now() - started;
			assert.equal(attempt.status, 0, `a reader that never returns blocked a commit:\n${attempt.stderr}`);
			assert.ok(
				elapsed < CEILING_MS,
				`the commit took ${elapsed}ms against a ${CEILING_MS}ms ceiling, so the budget did not end the reader — an arm that cannot refuse still took the commit away`,
			);
			assert.match(
				attempt.stderr,
				/did not finish within \d+s and was stopped/,
				`the expiry is silent, so a stopped reader reads like a clean one:\n${attempt.stderr}`,
			);
			return { attempt, elapsed };
		};

		it("the COMPILED-IN default ends a reader that never returns, and no environment variable reaches it", () => {
			// One arm, two properties, because they share the same 20s wait: the
			// adapter passes no budget, so the compiled-in value is what runs — and
			// it still runs with an environment naming the variable that used to
			// set it, which is the harm this revision closes.
			const { attempt } = driveHungCommit(null, "the default budget", {
				AUTHORING_PASS_BUDGET_S: "999999999999",
			});
			assert.ok(
				attempt.stderr.includes("did not finish within 20s"),
				`either the compiled-in budget did not run, or the environment's value reached it:\n${attempt.stderr}`,
			);
		});

		it("an in-range argument is honoured, which is how an arm reaches this path cheaply", () => {
			const { attempt, elapsed } = driveHungCommit("1", "an in-range budget");
			assert.ok(
				attempt.stderr.includes("did not finish within 1s"),
				`the argument was ignored, so the seam this suite drives the expiry path through does not work:\n${attempt.stderr}`,
			);
			assert.ok(elapsed < 15_000, `an in-range budget of 1s took ${elapsed}ms`);
		});

		it("an OUT-OF-RANGE all-digit argument takes the default, not its own value", () => {
			const { attempt } = driveHungCommit("999999999999", "an out-of-range budget");
			assert.ok(
				attempt.stderr.includes("did not finish within 20s"),
				`an all-digit value past the ceiling was honoured. Every all-digit value being honoured is exactly how the bound was lost before:\n${attempt.stderr}`,
			);
		});

		it("a NON-DIGIT argument takes the default, and does not collapse the wait", () => {
			const { attempt } = driveHungCommit("abc", "a non-digit budget");
			assert.ok(
				attempt.stderr.includes("did not finish within 20s"),
				`a non-digit value reached the arithmetic. Unvalidated it multiplies to 0, which ends the wait immediately and reports a layout that was never produced:\n${attempt.stderr}`,
			);
		});
	},
);

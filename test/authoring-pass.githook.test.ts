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

		it("carries the disposition, and all three exceptions with it", () => {
			const attempt = commitWithMessage(fixture, "feat(#218): the disposition\n");
			assert.ok(
				attempt.stderr.includes("DELETED"),
				`the layout does not state the disposition. A pass that points at a sentence without saying what to do with it is the rewrite generator it exists to close.\n${attempt.stderr}`,
			);
			// An UNENUMERATED exception is where a stated rule breaks, so the
			// rule's three are pinned individually rather than by a count.
			for (const exception of ["NIT remedy", "wrong literal", "arm titles"]) {
				assert.ok(
					attempt.stderr.includes(exception),
					`the disposition's "${exception}" exception is missing from the layout:\n${attempt.stderr}`,
				);
			}
		});

		it("the disposition's own wording has exactly ONE home in the repository", () => {
			// Built at runtime from fragments, never written whole: a literal
			// search string in this source would itself become a second home and
			// green the very check it performs.
			const needle = ["never replaced,", "re-tensed,", "or re-derived"].join(" ");
			// `--untracked` so the arm measures the working tree a pre-commit run
			// stands in, not only what is already committed.
			const hits = execFileSync(
				"bash",
				["-c", `cd ${JSON.stringify(repoRoot())} && git grep -l --untracked -F ${JSON.stringify(needle)} -- . | sort`],
				{ encoding: "utf8" },
			)
				.split("\n")
				.filter((line) => line !== "");
			assert.deepEqual(
				hits,
				[HELPER_REL],
				"this wording is stated somewhere other than where the step happens, so the two copies drift apart in the direction nobody is reading. §2.5 owns the disposition; a surface that restates it in its OWN words is a call site, but two byte-equal copies of one paragraph are not",
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

		it("a reader that does NOT RETURN is stopped at its budget, and the commit lands", () => {
			// The arm cannot refuse a commit, but an unbounded shell-out can take
			// one away by not returning. The budget is driven down from the
			// environment so this arm costs a second rather than the real budget.
			writeFileSync(join(fixture.root, READER_REL), "#!/usr/bin/env bash\ncat >/dev/null\nsleep 60\n");
			stageProse(fixture, "zqhang.ts", "// an ordinary comment.");
			const started = Date.now();
			const attempt = commitWithMessage(fixture, "feat(#218): a reader that hangs\n", {
				env: { AUTHORING_PASS_BUDGET_S: "1" },
			});
			const elapsed = Date.now() - started;
			assert.equal(attempt.status, 0, `a hung reader blocked a commit:\n${attempt.stderr}`);
			assert.ok(
				elapsed < 30_000,
				`the commit took ${elapsed}ms, so the budget did not stop the reader — an arm that cannot refuse still took the commit away`,
			);
			assert.ok(
				attempt.stderr.includes("did not finish within 1s"),
				`the expiry is silent, so a stopped reader reads like a clean one:\n${attempt.stderr}`,
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

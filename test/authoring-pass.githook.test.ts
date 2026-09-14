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
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

		it("carries the disposition's POINTER and the three exceptions", () => {
			const attempt = commitWithMessage(fixture, "feat(#218): the disposition\n");
			assert.ok(
				attempt.stderr.includes('SPEC §2.5, "Deletion is the default repair"'),
				`the layout names no source clause. §2.8 binds code-adjacent prose to point at the clause it enforces.\n${attempt.stderr}`,
			);
			// The exceptions are the operator's procedure and restate no clause, so
			// they are the only authored text here and they carry their source as a
			// pointer. An UNENUMERATED exception is where a stated rule breaks, so
			// each is pinned individually rather than by a count.
			assert.ok(
				attempt.stderr.includes("issue #218"),
				`the exceptions cite no source, so a reader cannot check where they came from:\n${attempt.stderr}`,
			);
			for (const exception of ["NIT remedy", "wrong literal", "arm titles"]) {
				assert.ok(
					attempt.stderr.includes(exception),
					`the disposition's "${exception}" exception is missing from the layout:\n${attempt.stderr}`,
				);
			}
		});

		it("prints the CLAUSE'S OWN BYTES, read from SPEC.md at run time", () => {
			// The property that replaces the equality lock. A lock pins a copy to
			// what it was reviewed as — it cannot stop the copy from being a copy.
			// What is pinned here instead is provenance: the bytes on stderr are the
			// bytes in SPEC.md, so a qualifier cannot be lost in transit because
			// nothing is in transit.
			const specLine = readFileSync(join(repoRoot(), "SPEC.md"), "utf8")
				.split("\n")
				.find((line) => line.startsWith("**Deletion is the default repair.**"));
			assert.ok(specLine, "the anchor did not match in SPEC.md, so this arm measures nothing");

			copyFileSync(join(repoRoot(), "SPEC.md"), join(fixture.root, "SPEC.md"));
			const attempt = commitWithMessage(fixture, "feat(#218): the clause itself\n");

			// Compared on whitespace-collapsed text: the layout folds and indents
			// for a terminal, which moves line breaks and nothing else.
			const flat = (text: string) => text.replace(/\s+/g, " ").trim();
			assert.ok(
				flat(attempt.stderr).includes(flat(specLine)),
				`the printed disposition is not the clause's own text. Either the read failed or something re-minted it — and a restatement is what this arm exists to forbid.\n${attempt.stderr}`,
			);

			// The qualifiers the hand copy lost, each pinned by name so their loss
			// reds here.
			for (const qualifier of ["default fix", "acceptance criterion", "pointing at its source"]) {
				assert.ok(
					flat(attempt.stderr).includes(qualifier),
					`the clause's "${qualifier}" qualifier did not reach the operator:\n${attempt.stderr}`,
				);
			}
		});

		it("keeps NO copy of the clause in its own source", () => {
			// The copy is what must be absent, not merely accurate.
			const specLine = readFileSync(join(repoRoot(), "SPEC.md"), "utf8")
				.split("\n")
				.find((line) => line.startsWith("**Deletion is the default repair.**"));
			assert.ok(specLine, "the anchor did not match in SPEC.md, so this arm measures nothing");
			const helper = readFileSync(join(repoRoot(), HELPER_REL), "utf8");
			// Sentence by sentence, because a copy of one sentence is a copy.
			for (const sentence of specLine
				.split(". ")
				.map((part) => part.trim())
				.filter((part) => part.length > 40)) {
				assert.ok(
					!helper.includes(sentence),
					`the helper carries a copy of the clause: ${JSON.stringify(sentence.slice(0, 60))}. §2.8: a digest that restates a contract is a second copy to keep in sync by hand`,
				);
			}
		});

		it("a missing WRAP tool costs the line breaks, never the clause", () => {
			// The wrap is a convenience; the clause is the point. A pipeline's
			// status is its last stage's, so `fold` going missing upstream leaves
			// `sed` exiting 0 over nothing — the failure has to be caught by an
			// empty capture, and the fallback has to emit the raw bytes.
			//
			// Asserted over the chain's OWN stdout and stderr, never over `cause`:
			// the harness cuts everything between the layout's two markers, so a
			// line leaking here is invisible to every `cause` assertion in every
			// githook suite.
			// The shim mirrors the REAL PATH minus one tool, so the rest of the
			// hook chain still resolves.
			const shim = join(fixture.root, "nofold");
			mkdirSync(shim, { recursive: true });
			const built = spawnSync(
				"bash",
				[
					"-c",
					`set -u; IFS=:; for d in $PATH; do [ -d "$d" ] || continue; for f in "$d"/*; do n=$(basename "$f"); [ "$n" = fold ] && continue; [ -e ${JSON.stringify(shim)}/"$n" ] || ln -s "$f" ${JSON.stringify(shim)}/"$n" 2>/dev/null; done; done; command -v fold >/dev/null && echo REAL_FOLD_EXISTS`,
				],
				{ encoding: "utf8" },
			);
			assert.ok(
				(built.stdout ?? "").includes("REAL_FOLD_EXISTS"),
				"there is no `fold` on this machine's PATH, so removing it from the shim measures nothing",
			);
			assert.ok(
				!existsSync(join(shim, "fold")) && existsSync(join(shim, "grep")),
				"the shim did not come out as PATH-minus-fold, so this arm measures something else",
			);
			copyFileSync(join(repoRoot(), "SPEC.md"), join(fixture.root, "SPEC.md"));

			const attempt = commitWithMessage(fixture, "feat(#218): no fold on PATH\n", { env: { PATH: shim } });
			assert.equal(attempt.status, 0, `a missing wrap tool blocked a commit:\n${attempt.stderr}`);
			assert.ok(
				!/command not found/.test(attempt.stderr) && !/command not found/.test(attempt.stdout),
				`a raw shell error reached the operator in the middle of the layout:\n${attempt.stderr}`,
			);
			// The clause itself must still be there, unwrapped.
			const specLine = readFileSync(join(repoRoot(), "SPEC.md"), "utf8")
				.split("\n")
				.find((line) => line.startsWith("**Deletion is the default repair.**"));
			assert.ok(specLine, "the anchor did not match in SPEC.md, so this arm measures nothing");
			assert.ok(
				attempt.stderr.replace(/\s+/g, " ").includes(specLine.replace(/\s+/g, " ").trim()),
				`the clause vanished when the wrap tool did. The header then announces a disposition over nothing:\n${attempt.stderr}`,
			);
		});

		it("with the wrap tool PRESENT the clause is wrapped, so the fallback is not the only measured path", () => {
			copyFileSync(join(repoRoot(), "SPEC.md"), join(fixture.root, "SPEC.md"));
			const attempt = commitWithMessage(fixture, "feat(#218): fold present\n");
			// Cut BEFORE the exceptions heredoc. Without that cut this arm was
			// vacuous: `body` ran to the end of the layout, and the heredoc's four
			// unconditional lines cleared the threshold on their own, so the arm was
			// green with the clause entirely unread. The boundary is a prose literal,
			// so a reworded heredoc would silently restore `body` whole and
			// re-vacuate the arm — its presence is asserted before the cut.
			const after = attempt.stderr.split("THE DISPOSITION")[1] ?? "";
			assert.ok(
				after.includes("Exceptions to it,"),
				"the exceptions boundary this arm cuts at is not in the output, so the cut did nothing and the arm is measuring the whole layout again",
			);
			const body = after.split("Exceptions to it,")[0];
			const clauseLines = body
				.split("\n")
				.filter((line) => line.startsWith("    ") && line.trim() !== "" && !line.trim().startsWith("("));
			assert.ok(
				clauseLines.length > 3,
				`the clause came out on one line with the wrap tool present, so the wrap is not running and the fallback is the only path this suite ever measures:\n${body}`,
			);
		});

		it("an ABSENT SPEC.md prints no substitute text", () => {
			// The degraded path is where a paraphrase would be most tempting and
			// least checkable. It must say it did not read, not say it differently.
			rmSync(join(fixture.root, "SPEC.md"), { force: true });
			const attempt = commitWithMessage(fixture, "feat(#218): no SPEC in this tree\n");
			assert.equal(attempt.status, 0, `an absent SPEC.md blocked a commit:\n${attempt.stderr}`);
			assert.ok(
				attempt.stderr.includes("not read: SPEC.md is absent."),
				`the layout is silent about a clause it did not read:\n${attempt.stderr}`,
			);
			assert.ok(
				!attempt.stderr.includes("default fix for a prose finding"),
				"a substitute for the clause was printed on the degraded path, which is the copy this change was parked for",
			);
			// The line names WHICH state it is in. One line serving several causes
			// sends a reader after a deleted file when the anchor merely moved.
			assert.ok(
				!attempt.stderr.includes("no longer carries the clause at this anchor") &&
					!attempt.stderr.includes("repository top was not resolved"),
				`an absent file was reported as some other degraded state:\n${attempt.stderr}`,
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

		it("a reader that takes its own subshell down is not reported as a clean run", () => {
			writeFileSync(join(fixture.root, READER_REL), "#!/usr/bin/env bash\ncat >/dev/null\nkill -9 $PPID\n");
			stageProse(fixture, "zqnostatus.ts", "// an ordinary comment.");
			const attempt = commitWithMessage(fixture, "feat(#218): a reader with no status\n");
			assert.equal(
				attempt.status,
				0,
				`a reader that died before recording a status blocked a commit:\n${attempt.stderr}`,
			);
			assert.ok(
				attempt.stderr.includes("stopped before it recorded a status"),
				`the no-status path is silent, so a read that never finished reads like one that did:\n${attempt.stderr}`,
			);
			assert.ok(
				!attempt.stderr.includes("no row matched"),
				`a reader with no status was reported as a clean run:\n${attempt.stderr}`,
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
	"the reader's budget is the adapter's, never the environment's (issue #218, SPEC \u00a73.9)",
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

		// WHAT THIS BLOCK PINS, and it is the INVARIANT rather than a printed
		// number: how long a commit can be held is the adapter's to decide and
		// nobody else's.
		//
		// The effective budget rides the layout's banner, so the clamp is
		// measurable without waiting it out. One arm still waits, because a
		// budget that is printed and not honoured would pass every other arm.
		const budgetOf = (attempt: { stderr: string }) => attempt.stderr.match(/reader budget (\d+)s/)?.[1];

		it("the clamp is TOTAL — every hostile argument takes the compiled-in default", () => {
			// Each row is a shape that reached a comparison or an arithmetic
			// expansion and did damage there. Measured with the guard removed:
			// the commit still landed, and what was lost was the bound and the
			// silence — `08` printed `reader budget 08s` and leaked `value too
			// great for base` onto the operator's stderr.
			const cases: ReadonlyArray<{ arg: string; expect: string; why: string }> = [
				{ arg: "1", expect: "1", why: "in range, honoured — the seam an arm drives the expiry path through" },
				{ arg: "120", expect: "120", why: "the ceiling itself is in range" },
				{ arg: "121", expect: "20", why: "one past the ceiling" },
				{ arg: "abc", expect: "20", why: "a non-digit" },
				{
					arg: "08",
					expect: "20",
					why: "a leading zero that is not octal — the expansion errors and leaks onto stderr",
				},
				{ arg: "010", expect: "20", why: "a leading zero that IS octal — ten asked, eight waited" },
				{ arg: "0x10", expect: "20", why: "a base prefix" },
				{ arg: "+5", expect: "20", why: "a sign" },
				{
					arg: "9".repeat(400),
					expect: "20",
					why: "past the shell's integer range, where the comparison errors and the ceiling goes unenforced",
				},
			];

			for (const { arg, expect, why } of cases) {
				patchAdapterBudget(fixture, arg);
				const attempt = commitWithMessage(fixture, `feat(#218): clamp ${arg.slice(0, 8)}\n`);
				assert.equal(
					attempt.status,
					0,
					`the argument ${JSON.stringify(arg.slice(0, 12))} blocked a commit (${why}). This arm refuses nothing, so no value of it may:\n${attempt.stderr}`,
				);
				assert.equal(
					budgetOf(attempt),
					expect,
					`${JSON.stringify(arg.slice(0, 12))} (${why}) produced budget ${budgetOf(attempt)}s, expected ${expect}s`,
				);
				assert.ok(
					!/integer expression expected|value too great for base/.test(attempt.stderr),
					`a shell error reached the operator for ${JSON.stringify(arg.slice(0, 12))}: the value was let into a comparison or an expansion before it was known to be one\n${attempt.stderr}`,
				);
			}
		});

		it("NO environment variable reaches the budget — driven with an IN-RANGE value", () => {
			// The direction that matters, and the reason this arm uses an in-range
			// value: an out-of-range one is discarded by the clamp whatever its
			// provenance, so it cannot separate "the environment cannot reach the
			// budget" from "it reached it and was handed a value the clamp
			// rejects".
			patchAdapterBudget(fixture, null);
			const attempt = commitWithMessage(fixture, "feat(#218): an environment that tries\n", {
				env: { AUTHORING_PASS_BUDGET_S: "1", AUTHORING_PASS_BUDGET_MAX_S: "1" },
			});
			assert.equal(attempt.status, 0, `the environment took the commit away:\n${attempt.stderr}`);
			assert.equal(
				budgetOf(attempt),
				"20",
				`the environment set the budget to ${budgetOf(attempt)}s. How long a commit is held is not the committing environment's to choose`,
			);
		});

		it("the COMPILED-IN default actually ENDS a reader that never returns", () => {
			// The one arm that waits. A budget printed and not honoured passes
			// every arm above; only elapsed time separates them.
			plantHangingReader(fixture);
			patchAdapterBudget(fixture, null);
			const started = Date.now();
			const attempt = commitWithMessage(fixture, "feat(#218): the default ends it\n");
			const elapsed = Date.now() - started;
			plantReader(fixture);

			assert.equal(attempt.status, 0, `a reader that never returns blocked a commit:\n${attempt.stderr}`);
			assert.ok(
				elapsed < 60_000,
				`the commit took ${elapsed}ms against a 60000ms ceiling — an arm that cannot refuse still took the commit away`,
			);
			assert.ok(
				elapsed > 15_000,
				`the commit took only ${elapsed}ms, so the 20s budget was not what ended the reader and this arm measures something else`,
			);
			assert.ok(
				attempt.stderr.includes("did not finish within 20s"),
				`the expiry is silent, so a stopped reader reads like a clean one:\n${attempt.stderr}`,
			);
		});

		it("an expired reader's own CHILDREN are reaped, not left running", () => {
			// The budget bounds the report. Without the reap it bounds ONLY the
			// report: TERM reaches the subshell, its pipeline children survive,
			// and the scratch is removed while one still holds a descriptor.
			const marker = "zqReapProbe";
			mkdirSync(join(fixture.root, ".github", "workflows"), { recursive: true });
			writeFileSync(
				join(fixture.root, READER_REL),
				`#!/usr/bin/env bash\ncat >/dev/null\nexec -a ${marker} sleep 600\n`,
			);
			patchAdapterBudget(fixture, "1");
			const attempt = commitWithMessage(fixture, "feat(#218): the reap\n");
			plantReader(fixture);
			assert.equal(attempt.status, 0, `the reap path blocked a commit:\n${attempt.stderr}`);

			const survivors = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
			const pids = (survivors.stdout ?? "").split("\n").filter((line) => line.trim() !== "");
			for (const pid of pids) {
				spawnSync("kill", ["-9", pid]);
			}
			assert.deepEqual(
				pids,
				[],
				`${pids.length} child of the expired reader survived its budget. The budget then bounds the report and not the work, and the scratch is removed while a live descriptor still points into it`,
			);
		});
	},
);

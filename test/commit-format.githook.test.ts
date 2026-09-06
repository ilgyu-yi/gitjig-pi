/**
 * Behavioral suite for the commit-format class at the commit-msg adapter
 * (issue #55 ACs; SPEC §3.3 `commit-format` row, §3.9, §3.11).
 *
 * Subject under test: the COMMITTED local-tier chain — this repository's
 * `.githooks/commit-msg` + `.githooks/_lib.sh`, copied byte-for-byte into a
 * disposable git repository by `harness/githook-fixture.ts` and driven only
 * through `git commit` (AC11: the arms measure the chain an operator runs,
 * never a predicate called directly).
 *
 * ARMED-CHAIN ASSERTIONS. Every refuse-shaped arm below asserts the armed
 * contract: while `.githooks/helpers/conventional_commit.sh` is absent from
 * the tree, the chain falls through `githook_source`'s fail-open branch to
 * `exit 0` and every guarded commit SUCCEEDS — those arms are red by
 * design until the helper lands (§1.2 failing-first). The allow-shaped and
 * degradation-shaped arms pass in both tree states: they pin the floor the
 * fix must not break, not the fix itself.
 *
 * Cause text is pinned by COMPARISON, never by string: the helper is free
 * to word its causes, but AC8 requires the unmeasurable outcome to be
 * distinguishable at the observable from an ordinary grammar refusal, an
 * ordinary length refusal, and an ordinary allow. The arms compare
 * decimal-normalized cause shapes across refusals in the same fixture, so
 * a cause that reuses another arm's template with a different number is
 * still caught (the false "out-of-range length" shape).
 *
 * Environment constraints stated in place:
 *   - The builder pins a multibyte-capable baseline locale (en_US.UTF-8);
 *     the degraded-measurement arms override it to the C charmap, in which
 *     a multibyte subject has no codepoint count and a naive byte length is
 *     a confident wrong decimal (§3.9's unmeasurable, environment shape).
 *   - The 0-codepoint arm commits with `--cleanup=verbatim`: git's default
 *     cleanup strips the subject's trailing space BEFORE the commit-msg
 *     hook fires, which would turn the 0-length subject into a grammar
 *     violation and measure the wrong arm.
 *   - ESC/CR/invalid-UTF-8 fixture bytes are built with String.fromCharCode,
 *     escape sequences, and Buffer, never as literal bytes in this source,
 *     so the file carries no raw control byte and no byte outside UTF-8.
 *   - POSIX bytes and bash are required throughout: the suite skips on
 *     win32.
 *
 * Residual, enumerated in place (§3.11: a gate names the vectors it
 * deliberately does not model): git also runs the commit-msg hook for the
 * commit `git merge` creates, and git's default merge message
 * ("Merge branch '<name>'") violates the grammar this tier holds, so an
 * armed tree refuses it with the same `--no-verify` recovery live. No arm
 * here forces a direction: the AC set governs commit subjects, and pinning
 * either the strict refusal or a merge-message carve-out would decide
 * contract the criteria do not cover. A later change that settles merge
 * messages owns its own arm.
 *
 * THE ROSTER FOR THIS FAMILY IS THE ADAPTER'S OWN HEADER, not this block
 * (issue #58). `.githooks/commit-msg` enumerates the merge edge above
 * alongside the hook-less channels that never fire it (`git cherry-pick`,
 * `git am`), the `core.commentChar=auto` reading, and the glob-metacharacter
 * marker — one decision, read in one place, at the site that states the
 * selection rule they are residuals of. This paragraph stays because the
 * merge edge is what an arm here would touch; it is not a second roster.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	buildGithookFixture,
	type CommitAttempt,
	commitWithMessage,
	removeDelegatedHelpers,
	type GithookFixture,
	removeGithookFixture,
} from "./harness/githook-fixture.ts";
import { repoRoot } from "./harness/run-pi.ts";

const IS_WINDOWS = process.platform === "win32";

/** A grammar violation with nothing else at stake — the ordinary-refusal reference. */
const GRAMMAR_VIOLATION = "subject following no grammar at all\n";

/** The C-charmap environment: multibyte input has no codepoint count here. */
const BROKEN_LOCALE = { LANG: "C", LC_ALL: "C", LC_CTYPE: "C" } as const;

/**
 * Decimal-normalized cause shape: two causes that differ only in a measured
 * number are the SAME shape. Distinctness under this normalization is what
 * separates a genuinely different cause from another arm's template carrying
 * a different decimal.
 */
function causeShape(cause: string): string {
	return cause.trim().replace(/\d+/g, "N");
}

function assertRefusedThroughAdapter(attempt: CommitAttempt, arm: string): void {
	assert.notEqual(
		attempt.status,
		0,
		`${arm}: the commit SUCCEEDED — the chain fell through fail-open instead of refusing (red until ` +
			`.githooks/helpers/conventional_commit.sh lands and check_commit_subject refuses this subject)`,
	);
	assert.match(
		attempt.stderr,
		/--no-verify/,
		`${arm}: refusal reached the operator without the adapter's live recovery line (§3.11 arm-scoped remediation)`,
	);
}

describe("commit-format grammar and length at commit-msg (issue #55)", { skip: IS_WINDOWS }, () => {
	let fixture: GithookFixture;
	let grammarRefusal: CommitAttempt;
	let lengthRefusal: CommitAttempt;

	before(() => {
		fixture = buildGithookFixture();
		grammarRefusal = commitWithMessage(fixture, GRAMMAR_VIOLATION);
		lengthRefusal = commitWithMessage(fixture, `feat(#55): ${"x".repeat(73)}\n`);
	});
	after(() => removeGithookFixture(fixture));

	it("refuses a grammar-violating subject, with the tier's recovery appended", () => {
		assertRefusedThroughAdapter(grammarRefusal, "grammar violation");
	});

	it("a grammar refusal emits a non-empty predicate cause beside the recovery line", () => {
		assert.notEqual(
			grammarRefusal.cause,
			"",
			"no cause line reached stderr — the predicate owes the cause, the adapter owes only the recovery (§3.11)",
		);
	});

	it("a grammar refusal lands one block audit record naming the class", () => {
		assert.match(
			grammarRefusal.auditDelta,
			/"category":"commit-format","action":"block"/,
			`expected a block record naming commit-format; this attempt appended: ${JSON.stringify(grammarRefusal.auditDelta)}`,
		);
	});

	it("refuses a required-group subject missing its issue reference", () => {
		const attempt = commitWithMessage(fixture, "feat: subject with no issue reference\n");
		assertRefusedThroughAdapter(attempt, "required group without (#N)");
	});

	it("passes a conforming subject", () => {
		const attempt = commitWithMessage(fixture, "feat(#55): add one conforming change\n");
		assert.equal(attempt.status, 0, attempt.stderr);
	});

	it("a passing commit lands no block record", () => {
		const attempt = commitWithMessage(fixture, "feat(#55): add another conforming change\n");
		assert.equal(attempt.status, 0, attempt.stderr);
		assert.doesNotMatch(attempt.auditDelta, /\bblock\b/, attempt.auditDelta);
	});

	it("passes a conforming subject carrying the breaking-change marker", () => {
		const attempt = commitWithMessage(fixture, "feat(#55)!: change a stated contract\n");
		assert.equal(attempt.status, 0, attempt.stderr);
	});

	it("refuses a 73-codepoint subject", () => {
		assertRefusedThroughAdapter(lengthRefusal, "73 codepoints");
	});

	it("passes a 72-codepoint subject", () => {
		const attempt = commitWithMessage(fixture, `feat(#55): ${"x".repeat(72)}\n`);
		assert.equal(attempt.status, 0, attempt.stderr);
	});

	it("passes a 1-codepoint subject", () => {
		const attempt = commitWithMessage(fixture, "feat(#55): x\n");
		assert.equal(attempt.status, 0, attempt.stderr);
	});

	it("refuses a 0-codepoint subject (verbatim cleanup keeps the separator's trailing space)", () => {
		// Default cleanup strips the trailing space before the hook fires and
		// this subject would land in the grammar arm instead of the 0-length
		// arm; a fully EMPTY message is out of reach by design — the adapter
		// fail-opens it to git's own empty-message handling.
		const attempt = commitWithMessage(fixture, "feat(#55): \n", { gitArgs: ["--cleanup=verbatim"] });
		assertRefusedThroughAdapter(attempt, "0 codepoints");
	});

	it("passes a 72-codepoint multibyte subject where a byte count would refuse", () => {
		// U+D55C x 72: 72 codepoints, 216 UTF-8 bytes — green only under
		// codepoint measurement.
		const attempt = commitWithMessage(fixture, `feat(#55): ${"\uD55C".repeat(72)}\n`);
		assert.equal(attempt.status, 0, attempt.stderr);
	});
});

describe("unmeasurable input refuses, distinctly (issue #55, SPEC §3.9)", { skip: IS_WINDOWS }, () => {
	let fixture: GithookFixture;
	let grammarRefusal: CommitAttempt;
	let lengthRefusal: CommitAttempt;
	let environmentRefusal: CommitAttempt;
	let invalidByteRefusal: CommitAttempt;

	/** Grammar-conforming subject whose bytes are not valid UTF-8 (0xC3 0x28). */
	const invalidUtf8Message = Buffer.concat([
		Buffer.from("feat(#55): ab", "utf8"),
		Buffer.from([0xc3, 0x28]),
		Buffer.from("cd\n", "utf8"),
	]);

	before(() => {
		fixture = buildGithookFixture();
		grammarRefusal = commitWithMessage(fixture, GRAMMAR_VIOLATION);
		lengthRefusal = commitWithMessage(fixture, `feat(#55): ${"y".repeat(73)}\n`);
		// The environment arm is pinned to MULTIBYTE input: only a subject the
		// C charmap cannot measure separates unmeasurability detection from
		// plain byte-counting.
		environmentRefusal = commitWithMessage(fixture, `feat(#55): ${"\uD55C".repeat(8)}\n`, {
			env: { ...BROKEN_LOCALE },
		});
		invalidByteRefusal = commitWithMessage(fixture, invalidUtf8Message);
	});
	after(() => removeGithookFixture(fixture));

	it("a broken measurement environment with multibyte input yields the refuse observable", () => {
		assertRefusedThroughAdapter(environmentRefusal, "unmeasurable (environment shape)");
	});

	it("the environment-shape cause names UTF-8, the property actually tested (issue #58)", () => {
		// The accepted set is the UTF-8 spellings and nothing else, so a cause
		// saying "not multibyte-capable" names a property the check does not
		// test: EUC-KR is multibyte-capable and is refused here too, and its
		// operator would be sent to fix the wrong thing (§3.11).
		assert.match(
			environmentRefusal.cause,
			/not UTF-8/,
			`the unmeasurable cause does not name UTF-8: ${JSON.stringify(environmentRefusal.cause)}`,
		);
		assert.doesNotMatch(
			environmentRefusal.cause,
			/multibyte-capable/,
			`the unmeasurable cause still claims a multibyte-capability test it does not perform: ${JSON.stringify(environmentRefusal.cause)}`,
		);
	});

	it("the environment-shape refusal is distinct from both the grammar cause and the length cause", () => {
		assert.notEqual(environmentRefusal.cause, "", "an unmeasurable refusal owes its own cause line");
		assert.notEqual(
			causeShape(environmentRefusal.cause),
			causeShape(grammarRefusal.cause),
			"the unmeasurable cause reuses the grammar-refusal shape — AC8 requires the three outcomes distinguishable",
		);
		assert.notEqual(
			causeShape(environmentRefusal.cause),
			causeShape(lengthRefusal.cause),
			"the unmeasurable cause reuses the length-refusal shape — a refusal that claims a length it never measured",
		);
	});

	it("the environment-shape refusal lands an audit record (distinct from an allow's silence)", () => {
		assert.match(environmentRefusal.auditDelta, /"category":"commit-format","action":"block"/, environmentRefusal.auditDelta);
	});

	it("a broken environment with pure-ASCII input still passes — degradation refuses only what it would mis-measure", () => {
		const attempt = commitWithMessage(fixture, "feat(#55): plain ascii subject\n", {
			env: { ...BROKEN_LOCALE },
		});
		assert.equal(attempt.status, 0, attempt.stderr);
	});

	it("invalid-UTF-8 subject bytes yield the refuse observable, never a silent pass", () => {
		assertRefusedThroughAdapter(invalidByteRefusal, "unmeasurable (input shape)");
	});

	it("the invalid-UTF-8 refusal never claims an out-of-range length", () => {
		// The refusal precondition repeats here on purpose: on a tree where the
		// commit still succeeds, git's own success-path encoding warning puts a
		// line on stderr and would green the shape comparison vacuously.
		assertRefusedThroughAdapter(invalidByteRefusal, "unmeasurable (input shape)");
		assert.notEqual(invalidByteRefusal.cause, "", "an unmeasurable refusal owes its own cause line");
		assert.notEqual(
			causeShape(invalidByteRefusal.cause),
			causeShape(lengthRefusal.cause),
			"the out-of-domain input drew the length-refusal cause — a naive count over invalid bytes is not a measurement (§3.9)",
		);
	});

	it("the invalid subject bytes never surface on stderr or in the audit record", () => {
		const invalidBytes = Buffer.from([0xc3, 0x28]);
		assert.equal(
			invalidByteRefusal.stderrBytes.includes(invalidBytes),
			false,
			"raw out-of-domain subject bytes reached stderr — causes are content-free (§3.9)",
		);
		assert.equal(
			Buffer.from(invalidByteRefusal.auditDelta, "utf8").includes(invalidBytes),
			false,
			"raw out-of-domain subject bytes reached the audit record — records are content-free (§3.9)",
		);
	});
});

describe("refusal surfaces are content-free (issue #55, SPEC §3.9, §3.11)", { skip: IS_WINDOWS }, () => {
	let fixture: GithookFixture;
	let hostileRefusal: CommitAttempt;

	const ESC = String.fromCharCode(27);
	const SENTINEL = "ZQSUBJECTSENTINELQZ";
	// A grammar-refused subject carrying ESC- and CR-adjacent hostile bytes:
	// any surface that echoes the subject would carry the sentinel and could
	// land control bytes on the operator's terminal or forge audit lines.
	const hostileSubject = `no grammar ${ESC}[31m${SENTINEL}\r tail\n`;

	before(() => {
		fixture = buildGithookFixture();
		hostileRefusal = commitWithMessage(fixture, hostileSubject);
	});
	after(() => removeGithookFixture(fixture));

	it("a hostile-byte subject is refused", () => {
		assertRefusedThroughAdapter(hostileRefusal, "hostile bytes");
	});

	it("no subject byte reaches stderr", () => {
		assert.equal(hostileRefusal.stderr.includes(SENTINEL), false, "subject text surfaced on stderr");
		assert.equal(hostileRefusal.stderr.includes(ESC), false, "a raw ESC byte surfaced on stderr");
	});

	it("no subject byte reaches the audit record", () => {
		assert.equal(hostileRefusal.auditDelta.includes(SENTINEL), false, "subject text reached the audit record");
		assert.equal(hostileRefusal.auditDelta.includes(ESC), false, "a raw ESC byte reached the audit record");
	});

	// The arms above drive the GRAMMAR refusal only. The length refusal is a
	// second cause on a second path, and a surface that echoed the subject
	// there would be equally undetected — so it gets the same pin rather than
	// inheriting a guarantee measured elsewhere (issue #58).
	it("the LENGTH cause is content-free too — a conforming, over-long subject", () => {
		// Conforming grammar so the length arm is what refuses, and 73
		// codepoints so it is out of range by exactly one.
		const prefix = "feat(#58): ";
		const body = `${SENTINEL}${ESC}[31m`;
		const overLong = `${prefix}${body}${"x".repeat(73 - body.length)}\n`;
		const attempt = commitWithMessage(fixture, overLong);
		assert.notEqual(attempt.status, 0, `length sentinel: the over-long subject was not refused: ${attempt.stderr}`);
		assert.equal(
			attempt.stderr.includes(SENTINEL),
			false,
			`length sentinel: subject text surfaced on stderr from the LENGTH path: ${JSON.stringify(attempt.stderr)}`,
		);
		assert.equal(attempt.stderr.includes(ESC), false, "length sentinel: a raw ESC byte surfaced on stderr");
		// Without this the arm stays green if a regression turns the refusal
		// into a GRAMMAR one — the length path would go unmeasured while the
		// arm still claimed to cover it.
		assert.match(
			attempt.cause,
			/codepoints, outside 1\.\.72/,
			`length sentinel: the refusal did not come from the LENGTH path: ${JSON.stringify(attempt.cause)}`,
		);
		assert.equal(
			attempt.auditDelta.includes(SENTINEL),
			false,
			"length sentinel: subject text reached the audit record from the LENGTH path",
		);
	});
});

describe("chain degradation stays fail-open (issue #55 AC9)", { skip: IS_WINDOWS }, () => {
	// Both arms construct their degradation deliberately and are green in
	// both tree states: they pin the fail-open floor (§3.9's machinery
	// carve-out), which the armed helper must not break.

	it("helper file absent: the hook no-ops and even a violating subject commits", () => {
		const fixture = buildGithookFixture();
		removeDelegatedHelpers(fixture);
		try {
			const attempt = commitWithMessage(fixture, GRAMMAR_VIOLATION);
			assert.equal(
				attempt.status,
				0,
				`an absent helper must degrade to allow, never to a false block (githook_source fail-open): ${attempt.stderr}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("helper present without check_commit_subject: the hook no-ops and even a violating subject commits", () => {
		const fixture = buildGithookFixture();
		removeDelegatedHelpers(fixture);
		try {
			writeFileSync(
				join(fixture.helpersDir, "conventional_commit.sh"),
				"# stub helper: sources cleanly, defines everything except the delegated function\nunrelated_helper_function() { :; }\n",
			);
			const attempt = commitWithMessage(fixture, GRAMMAR_VIOLATION);
			assert.equal(
				attempt.status,
				0,
				`a helper without the delegated function must degrade to allow via githook_require: ${attempt.stderr}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("the check_commit_subject require miss records under this arm's own category", () => {
		// A degradation record is read by category: one landing under the
		// tier default is indistinguishable from a record about the tier
		// itself, so the arm that folded cannot be told from the sink.
		const fixture = buildGithookFixture();
		removeDelegatedHelpers(fixture);
		try {
			writeFileSync(
				join(fixture.helpersDir, "conventional_commit.sh"),
				"# stub helper: sources cleanly, defines everything except the delegated function\nunrelated_helper_function() { :; }\n",
			);
			const attempt = commitWithMessage(fixture, GRAMMAR_VIOLATION);
			const miss = attempt.auditDelta
				.split("\n")
				.filter((line) => /\brequire-missing check_commit_subject\b/.test(line));
			assert.equal(
				miss.length,
				1,
				`expected exactly one require-miss record naming check_commit_subject; delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
			assert.match(
				miss[0],
				/"category":"commit-format"/,
				`the require miss records under a category that does not name this arm; record: ${miss[0]}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// The checked line versus the landed subject (issue #58, SPEC §3.11).
//
// `commit-msg` receives ONE argument: the path to the message file. It does
// not receive the cleanup mode, and cannot derive it — `--cleanup=` is a
// command-line flag no hook sees, `commit.cleanup` may be unset, and git's
// DEFAULT differs by invocation (`strip` for an editor commit, `whitespace`
// for `-m`/`-F`). So the adapter cannot know whether comment lines will be
// stripped after it runs, and therefore cannot know which line becomes the
// subject.
//
// That is why the repair is not "mirror git's cleanup". It is: compute both
// readings — the first non-blank line, and the first non-blank non-comment
// line — and approve only if every candidate conforms. Where the two agree
// there is one candidate and the behaviour is what it always was, which is
// every ordinary editor commit: the subject is line 1 and git's template
// comments follow it.
//
// The comment marker is read from git (`core.commentString`, else
// `core.commentChar`, else `#`) and that read is LOAD-BEARING, not defensive.
// An earlier attempt dropped it, arguing no comment marker can begin a valid
// `<type>`. A marker is not restricted to punctuation, and the arms below
// carry the counterexample: under `core.commentChar=f` the line
// `feat(#N): …` IS a comment, and git strips it.
// ---------------------------------------------------------------------------

describe("the adapter approves no subject it cannot vouch for (issue #58, SPEC §3.11)", { skip: IS_WINDOWS }, () => {
	let fixture: GithookFixture;

	before(() => {
		fixture = buildGithookFixture();
	});
	after(() => removeGithookFixture(fixture));

	/** What actually landed, which is the only thing the wrong-allow is about. */
	function landedSubject(): string {
		return spawnSync("git", ["log", "-1", "--format=%s"], {
			cwd: fixture.root,
			env: { PATH: process.env.PATH ?? "", HOME: join(fixture.root, "home") },
		})
			.stdout.toString("utf8")
			.trim();
	}

	it("a comment-led message is refused — the gate vouched for line 2 while line 1 landed", () => {
		// The wrong allow this issue was filed for. Under `-F` the default
		// cleanup is `whitespace`, which keeps the `#` line, so the adapter
		// approved `feat(#58): …` while `#zqcomment …` became the subject.
		const attempt = commitWithMessage(fixture, "#zqcomment leading the message\nfeat(#58): a conforming subject\n");
		assert.notEqual(
			attempt.status,
			0,
			"comment-led: the commit SUCCEEDED. The adapter checked the first non-comment line and approved it, " +
				`while the line that landed as the subject was the comment above it — a silent wrong allow at a ` +
				`gate (§3.11). Landed subject: ${JSON.stringify(landedSubject())}`,
		);
	});

	it("the same shape under an explicit --cleanup=verbatim is refused too", () => {
		const attempt = commitWithMessage(fixture, "#zqverbatim leading\nfeat(#58): a conforming subject\n", {
			gitArgs: ["--cleanup=verbatim"],
		});
		assert.notEqual(
			attempt.status,
			0,
			`verbatim: the commit SUCCEEDED; landed subject: ${JSON.stringify(landedSubject())}`,
		);
	});

	it("a comment-led message separated by a blank line is refused", () => {
		// Here the landed subject is the comment ALONE — the sharpest form,
		// since the approved line is not even part of what git records.
		const attempt = commitWithMessage(fixture, "#zqspaced comment\n\nfeat(#58): a conforming subject\n");
		assert.notEqual(
			attempt.status,
			0,
			`spaced: the commit SUCCEEDED; landed subject: ${JSON.stringify(landedSubject())}`,
		);
	});

	it("an all-comment message is refused rather than fail-open", () => {
		// Under a comment-preserving cleanup the comments ARE the subject, and
		// they conform to nothing. Under `strip` git aborts on the empty
		// message anyway, so refusing is right in both worlds.
		const attempt = commitWithMessage(fixture, "#zqonly a comment\n#zqand another\n");
		assert.notEqual(
			attempt.status,
			0,
			`all-comment: the commit SUCCEEDED; landed subject: ${JSON.stringify(landedSubject())}`,
		);
	});

	it("the refusal names WHY, not just that the subject failed", () => {
		const attempt = commitWithMessage(fixture, "#zqcause check\nfeat(#58): a conforming subject\n");
		assert.match(
			attempt.stderr,
			/cleanup/i,
			"cause: the refusal does not tell the operator that the message's first line and its first " +
				"non-comment line differ and that which one lands depends on a cleanup mode this hook cannot " +
				`observe — without that, the refusal reads as a false block (§3.11): ${JSON.stringify(attempt.stderr)}`,
		);
	});

	it("a `#`-led line git KEEPS is checked, where `;` is the configured marker", () => {
		// `core.commentChar=';'` makes `;` the marker and `#` an ordinary
		// character, so this `#`-led line is text git keeps and the subject it
		// lands. It must be checked.
		const attempt = commitWithMessage(fixture, "#zqhash is not a comment here\nfeat(#58): a conforming subject\n", {
			env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.commentChar", GIT_CONFIG_VALUE_0: ";" },
		});
		assert.notEqual(
			attempt.status,
			0,
			"commentChar: the commit SUCCEEDED. With `;` as git's comment marker a `#`-led line is ordinary " +
				`text that lands as the subject, and the adapter skipped it as a comment; landed subject: ${JSON.stringify(landedSubject())}`,
		);
	});

	it("a `;`-led message is checked too, not skipped", () => {
		// Prior behaviour, pinned rather than newly bought: the old loop
		// skipped `#` only, so this already refused. It is here because it is
		// the other direction of the marker axis, and a marker-aware read
		// must not start skipping it.
		const attempt = commitWithMessage(fixture, ";zqsemicolon is ordinary here\nfeat(#58): a conforming subject\n");
		assert.notEqual(
			attempt.status,
			0,
			`semicolon: the commit SUCCEEDED; landed subject: ${JSON.stringify(landedSubject())}`,
		);
	});

	it("the ordinary editor shape is unchanged: subject first, comments after", () => {
		// The regression guard that keeps this repair from becoming a false
		// block. One candidate, so the behaviour is exactly what it was.
		const attempt = commitWithMessage(
			fixture,
			"feat(#58): a conforming subject\n\n# Please enter the commit message for your changes.\n# with '#' will be ignored.\n",
		);
		assert.equal(
			attempt.status,
			0,
			`editor shape: an ordinary commit was refused — the repair over-blocks the common case: ${attempt.stderr}`,
		);
	});

	it("under --cleanup=verbatim the UNTRIMMED length is what lands, and is refused", () => {
		// The other half of the trailing-whitespace axis. Under `verbatim` git
		// keeps the trailing spaces, so a 72-codepoint subject plus spaces
		// lands over the limit. Checking only the trimmed form would approve
		// it — this arm is what makes the untrimmed candidate load-bearing.
		// The grammar bounds the DESCRIPTION after `<type>(#N): `, so the two
		// forms are built to straddle that boundary: 72 description
		// characters trimmed, 75 untrimmed. The trimmed form conforms and the
		// untrimmed one does not, which is exactly the discriminator.
		const attempt = commitWithMessage(fixture, `feat(#58): ${"x".repeat(72)}   \n`, {
			gitArgs: ["--cleanup=verbatim"],
		});
		assert.notEqual(
			attempt.status,
			0,
			"verbatim length: under verbatim the untrimmed line is what lands, and its description is over the " +
				`limit, but the commit was approved: ${attempt.stderr}`,
		);
	});

	it("a conforming subject with no comments at all still passes", () => {
		const attempt = commitWithMessage(fixture, "feat(#58): plain conforming subject\n");
		assert.equal(attempt.status, 0, `plain: ${attempt.stderr}`);
	});
});

describe("the delegated helper's mode matches its stated use (issue #58)", { skip: IS_WINDOWS }, () => {
	it("conventional_commit.sh is not executable — its header says it is sourced, never executed", () => {
		// Self-enforcing rather than self-contradicting: the file carries no
		// shebang, so an exec bit advertises an entry point that does not
		// exist. Dropping the bit is what makes the header's claim checkable.
		const helper = join(repoRoot(), ".githooks", "helpers", "conventional_commit.sh");
		const mode = statSync(helper).mode & 0o111;
		assert.equal(
			mode,
			0,
			`conventional_commit.sh carries an exec bit (mode ${mode.toString(8)}) while its header states it is ` +
				"sourced and never executed, and it ships no shebang — one of the two has to give (§2.5)",
		);
		assert.doesNotMatch(
			readFileSync(helper, "utf8").split("\n")[0],
			/^#!/,
			"conventional_commit.sh grew a shebang — then the exec bit is the right answer and this arm is inverted",
		);
	});
});

// ---------------------------------------------------------------------------
// Two shapes the `-F`-driven helper cannot reach (issue #58).
//
// `commitWithMessage` always uses `-F`, under which git applies whitespace
// cleanup BEFORE the hook and never applies `strip` by default. Both shapes
// below turn on that difference, so they drive `git commit` directly with a
// scripted editor — which is the path where git hands the hook the file
// untouched and cleans up afterwards.
// ---------------------------------------------------------------------------

describe("the editor path, where git cleans up after the hook (issue #58)", { skip: IS_WINDOWS }, () => {
	let fixture: GithookFixture;

	before(() => {
		fixture = buildGithookFixture();
	});
	after(() => removeGithookFixture(fixture));

	/** One commit through a scripted editor, with optional extra git config. */
	function commitThroughEditor(
		message: string,
		config: Record<string, string> = {},
	): { status: number | null; stderr: string } {
		fixture.seq += 1;
		appendFileSync(join(fixture.root, "work.txt"), `editor ${fixture.seq}\n`);
		spawnSync("git", ["add", "work.txt"], { cwd: fixture.root, env: editorEnv(fixture) });
		const messagePath = join(fixture.root, ".git", `GITJIG_EDITOR_MSG_${fixture.seq}`);
		writeFileSync(messagePath, message);
		const configArgs = Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${value}`]);
		const run = spawnSync("git", [...configArgs, "commit", "-q"], {
			cwd: fixture.root,
			env: { ...editorEnv(fixture), GIT_EDITOR: `cp ${messagePath}` },
		});
		return { status: run.status, stderr: (run.stderr ?? Buffer.alloc(0)).toString("utf8") };
	}

	/**
	 * A refusal that came from THIS adapter, not from any nonzero exit. Without
	 * the recovery-line check a rejected config value or a failed editor would
	 * pass a status-only assertion — the vacuous shape the rest of this file
	 * avoids through `assertRefusedThroughAdapter`.
	 */
	function assertRefusedByAdapter(run: { status: number | null; stderr: string }, arm: string): void {
		assert.notEqual(run.status, 0, `${arm}: the commit SUCCEEDED`);
		assert.match(
			run.stderr,
			/--no-verify/,
			`${arm}: the commit failed, but not through this adapter — no tier recovery line on stderr: ${JSON.stringify(run.stderr)}`,
		);
	}

	function editorEnv(f: GithookFixture): Record<string, string> {
		return {
			PATH: process.env.PATH ?? "",
			HOME: join(f.root, "home"),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
			GITJIG_TEST_STATE_ROOT: join(f.root, ".gitjig", "state"),
		};
	}

	it("a LETTER comment marker: `feat(#N):` is a comment git strips, and the line beneath is checked", () => {
		// The counterexample that retired "no comment marker begins a valid
		// <type>". With `core.commentChar=f`, line 1 IS a comment: git removes
		// it under strip and the non-conforming line 2 lands. An adapter that
		// checked only the first non-blank line would vouch for the comment
		// and never see what landed.
		assertRefusedByAdapter(
			commitThroughEditor("feat(#58): looks conforming but is a comment\nzqnot a conforming subject at all\n", {
				"core.commentChar": "f",
			}),
			"letter marker: git stripped the `f`-led line as a comment and the unchecked line beneath it landed",
		);
	});

	it("`core.commentString` takes precedence, and its marker is honoured too", () => {
		assertRefusedByAdapter(
			commitThroughEditor("feat(#58): also a comment now\nzqbogus subject here\n", {
				"core.commentString": "feat",
			}),
			"commentString: the marker was not read",
		);
	});

	it("a whitespace-only first line is BLANK, not a subject — git drops it", () => {
		// The false block the first-non-blank reading bought if it counted a
		// space-only line as content: git's cleanup drops it, so the
		// conforming line beneath is what lands and the commit must succeed.
		const { status } = commitThroughEditor("   \nfeat(#58): fine after a blankish line\n");
		assert.equal(
			status,
			0,
			"blankish: an ordinary commit was refused because its first line held only spaces — git drops such " +
				"a line, so the conforming subject beneath it is what lands (§3.11's false-block cost)",
		);
	});

	it("a subject that is grammatical only UNTRIMMED is refused — git trims after the hook", () => {
		// `feat(#N):` plus trailing spaces satisfies the grammar as the hook
		// receives it and does not once git trims, so checking the untrimmed
		// form alone approved a commit with no description at all. The trimmed
		// form is a candidate for exactly this reason.
		assertRefusedByAdapter(
			commitThroughEditor("feat(#58):   \n"),
			"trailing space: the hook vouched for the untrimmed line while the trimmed one landed",
		);
	});

	it("a conforming subject with ordinary trailing whitespace still passes", () => {
		// The guard against over-correcting: trimming must not refuse a
		// subject that conforms in BOTH forms.
		const { status, stderr } = commitThroughEditor("feat(#58): a conforming subject with a trailing space \n");
		assert.equal(status, 0, `trailing space (benign): an ordinary commit was refused: ${stderr}`);
	});

	it("the ordinary editor commit still passes", () => {
		const { status } = commitThroughEditor("feat(#58): a plain editor subject\n\n# a template comment\n");
		assert.equal(status, 0, "editor baseline: an ordinary editor commit was refused");
	});
});

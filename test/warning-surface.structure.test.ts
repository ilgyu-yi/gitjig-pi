/**
 * Structural suite for the warning-surface escaping rule (issue #47).
 *
 * Subject under test: the text of every file a recursive walk of
 * `.pi/extensions/` returns. The domain is the WALK, never a list of files
 * or of containers — a module added as a new sibling entry, or nested
 * deeper than `gitjig/`, is in the domain the moment it exists (issue #72).
 *
 * The rule (SPEC §3.10): "a write the guard itself permits must not be able
 * to forge the guard's decisions", and the mitigation for such a class
 * applies "uniformly, with an empty exemption set and a structural lock, so
 * a new site cannot drift in unguarded". The behavioural half of #47 is
 * pinned by `primitives.unit.test.ts`'s forged-line arms, one per emitting
 * surface that exists TODAY; this suite is the structural lock those arms
 * cannot be — a site added tomorrow gets no behavioural arm until someone
 * remembers to write one, but it cannot avoid this scan. SPEC §2.5 permits
 * exactly this shape and no more: "A contract testable only by grepping
 * prose is stranded — it moves into code both sides call. Structural checks
 * over prose files remain normal tests."
 *
 * Each walked file is in exactly one of two states: on the roster, where
 * its text is scanned, or off it with a reason recorded IN THAT MODULE'S
 * OWN HEADER, which this suite reads rather than keeping a second list that
 * could drift from it. A file in neither state fails — that third outcome,
 * the module nobody ruled on, is what the lock exists to make impossible.
 *
 * The lock is lexical: every `${…}` interpolation in a rostered source must
 * either be escaped where it stands — an expression beginning `quoted(` or
 * `JSON.stringify(` — or appear on that file's exact-text allowlist of
 * expressions that carry no path: numeric Stats dimensions, and the
 * composed-message CARRIERS (`cause`, `recovery`, `RECOVERY`, `STATE_SEAM`)
 * whose path content is escaped at its own leaf, where escaping again would
 * double-escape and mangle prose. A second arm holds the one taint the
 * `${…}` scan cannot see: a raw `error.message`/`String(error)` extraction
 * (an ENOENT message embeds the path) must be wrapped at the extraction.
 *
 * WHAT THIS SUITE DOES NOT ESTABLISH (§3.11's report-only shape: a check
 * that does not establish a property says so, so a green run is never read
 * as the missing guarantee). Every assertion below is a claim about source
 * text. None is a claim about runtime behaviour — that half lives in the
 * behavioural arms. Specifically, a green run here does NOT establish:
 *
 *   1. That the sources parse as TypeScript, or that the scan sees what a
 *      parser would. There is no TS parser in this dependency-free tree
 *      (no `package.json` exists), so the readers below are narrow text
 *      scanners over a comment-stripped view. They can be fooled by shapes
 *      these files do not write. A nested template literal and an
 *      expression containing braces are NO LONGER among them — both are
 *      written in this tree and the balanced capture handles both. What
 *      fools it now: a brace or parenthesis inside a string literal or a
 *      regex within an interpolation, which truncates or over-runs the
 *      capture; a `${` in a plain quoted string; a trailing `//` comment
 *      sharing a line with code; a `/*` inside a string. Every one of
 *      those miscaptures lands on REPORT, never on admit — the scanner's
 *      error directions are both fail-closed, at the cost of a misleading
 *      "escape this" message for what is a scanner limit.
 *   2. That `quoted(` resolves to the escaping helper. The scan verifies
 *      the SPELLING, not the callee: a local function named `quoted` that
 *      does not escape would pass. The helper's own contract is pinned
 *      behaviourally, not here.
 *   3. That an allowlisted expression is untainted. The allowlist admits
 *      exact TEXT per file, so an allowlisted spelling reused for a
 *      genuinely path-bearing variable in the same file is admitted —
 *      per-file scoping narrows that residual but does not close it.
 *   4. That message construction outside `.pi/extensions/` is escaped, or
 *      that a recorded exemption reason is TRUE. The silent-omission half
 *      of this residual is closed: the domain is the walk, so a module
 *      cannot join the tree undecided (issue #72). What remains is the
 *      boundary and the reason. The walk's root is `.pi/extensions/`, so a
 *      surface emitting operator text from elsewhere in the repository is
 *      outside this domain and no arm here notices it. And the exemption
 *      state is checked for PRESENCE and for carrying a reason, never for
 *      the reason being sound — a module can exempt itself with a bad
 *      argument, which is why the exemption is one file and its reason is
 *      the structural circularity of escaping the escaper.
 *   5. That a raw error read wrapped LATER on the same line is really
 *      escaped: the raw-extraction arm is same-line lexical, so
 *      `quoted(x) + error.message` would be admitted.
 *   6. That an allowlisted expression carries no EXTERNALLY WRITTEN text.
 *      Residual 3 covers an allowlisted spelling reused for a path-bearing
 *      variable; this is the other shape — an entry whose value is written
 *      by another party outright. The scan cannot tell the two apart: an
 *      allowlist entry is exact TEXT, and nothing about that text says who
 *      wrote the value it names. This residual is a statement about the
 *      SCANNER, so it stands whether or not any entry currently sits in it,
 *      and this header states NO COUNT of entries that do — a residual whose
 *      subject is an unmeasurable property cannot also report a census of
 *      it. The instance that named this residual is closed rather than
 *      allowlisted: `outcome.summary` in `dispatch/index.ts` was admitted
 *      here while a delegate could spell a second dispatch verdict inside
 *      the clause reporting the real one; issue #97 routed it through
 *      `quoted()`, and the sibling `outcome.url` in `publish/index.ts` with
 *      it. Closing one instance narrows nothing about the scanner: an
 *      allowlist entry over external text is a decision about a hole, never
 *      a demonstration there is none, and no arm here would report the next
 *      one.
 *
 *
 * The scanner's own teeth are pinned by the synthetic-mutant arms at the
 * bottom (§3.12 — a guard the suite never measures is decoration): a raw
 * interpolation in an inline source must be reported, a `quoted(` one must
 * pass, and an unlisted bare identifier must be reported even beside an
 * allowlisted one — so a NEW raw site demonstrably fails this check, not
 * just the sites red at the commit that introduced it.
 *
 * This suite walks one directory and reads its files, and writes nothing:
 * no network, no `gh`, no `pi`, no fixture.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const EXTENSIONS_DIR = join(repoRoot(), ".pi", "extensions");

/**
 * The roster and each file's exact-text allowlist. Every entry names why
 * it is admitted, in its own comment beside it. The grounds differ by
 * entry and are deliberately NOT summarized here: a ground stated once in
 * this header is a claim over every entry, and the entries do not share
 * one. An expression not on the list
 * and not escaped where it stands is a violation, so the exemption set
 * stays enumerated here rather than accreting inline (§3.10).
 */
const SOURCES: readonly { file: string; allow: readonly string[]; allowErrorReads?: readonly string[] }[] = [
	{
		file: "gitjig/audit.ts",
		allow: [
			// Numeric dimensions of the sink verdict's Stats — no byte of any
			// of them comes from a path component.
			"stats.nlink",
			"(stats.mode & 0o777).toString(8)",
			"stats.uid",
			"euid",
			// The verdict's enumerated dimensions: prose composed above from
			// the allowlisted pieces, joined — never a raw path.
			'failed.join("; ")',
			// warnDegraded's carriers: composed messages whose path content is
			// escaped at its own leaf; escaping the carrier double-escapes.
			"cause",
			"recovery",
			// The guarded object's own nouns. `GuardedObjectNouns` types both
			// fields as CLOSED literal unions, so the set of bytes either
			// expression can carry is enumerated in that declaration and holds
			// no path component.
			"nouns.noun",
			"nouns.restoredBy",
		],
	},
	{ file: "gitjig/locate.ts", allow: [] },
	{
		file: "gitjig/state-root.ts",
		allow: [
			// The seam's NAME is a constant of this module, not a value an
			// actor supplies.
			"STATE_SEAM",
			// The empty-seam rendering: the only branch that reaches the
			// message unquoted is the string constant "empty value" — the
			// seam itself passes through quoted() — so no actor byte rides
			// this expression raw.
			'seam === "" ? "empty value" : quoted(seam)',
			// The shared recovery clause: a carrier composed of STATE_SEAM and
			// fixed prose, escaped nowhere because it carries no path.
			"RECOVERY",
		],
	},
	// No interpolation exists in postures.ts today; it is on the roster so
	// the module most likely to grow a message cannot grow a raw one.
	{ file: "gitjig/postures.ts", allow: [] },
	{
		file: "gitjig.ts",
		allow: [
			// The entry's two records reach the audit sink and nothing else,
			// and the sink's writer passes the WHOLE record through
			// JSON.stringify at write time, so a path carrying a newline or a
			// quote is encoded before it lands. Measured: a path spelling a
			// complete second record writes one line, parses as one record,
			// and forges none. The surrounding double quotes in the message
			// are presentational, not the escape.
			"repoRoot",
			"stateRoot",
		],
	},
	{
		file: "gitjig/bind-state.ts",
		allow: [
			// A closed literal union — `BindState` enumerates the byte set.
			"state",
			// A module constant, not a value any actor supplies.
			"BIND_REARM_COMMAND",
			// Carriers: the path content is escaped at its own leaf, where
			// this module wraps both the stamp path and the error extraction
			// in quoted(); escaping the carrier would double-escape.
			"cause",
			"recovery",
		],
	},
	// The command spine composes no message text: the rung-1 commands hand
	// fixed literals to the dispatcher and report its causes unrephrased.
	{ file: "gitjig/commands/index.ts", allow: [] },
	{ file: "gitjig/commands/review.ts", allow: [] },
	{ file: "gitjig/commands/ship.ts", allow: [] },
	// Admission and the delegate child compose no interpolated text; every
	// refusal they surface is a fixed content-free literal.
	{ file: "gitjig/dispatch/admit.ts", allow: [] },
	{ file: "gitjig/dispatch/executor.ts", allow: [] },
	{
		file: "gitjig/dispatch/index.ts",
		allow: [
			// A boolean and a closed verdict union; neither carries a byte an
			// actor names.
			"outcome.ok",
			"outcome.compare",
			// The verdict clause composed from the two above.
			"compareClause",
			// `outcome.summary` is NOT here: it is externally written text —
			// a delegate controls it byte for byte — and it now crosses the
			// composition through quoted() like every other actor-influenced
			// value on an operator surface (issue #97). The behavioural
			// contract that replaced this entry lives in the dispatch module
			// suite, which measures the composed text rather than its
			// spelling: one line, no raw control byte, an attributable frame.
		],
		allowErrorReads: [
			// Read only to COMPARE against the closed provision-cause set —
			// the raw message reaches a surface on the one branch where it is
			// a member of that set, and the generic cause is used otherwise.
			'const thrown = error instanceof Error ? error.message : "";',
		],
	},
	{
		file: "gitjig/dispatch/provision.ts",
		allow: [
			// Not a message. This composes a git revision operand passed as a
			// single argv element after --end-of-options; argv safety is a
			// different class from line-forging on an operator surface, and
			// quoting here would corrupt the revision.
			'options.expectedRef ?? "HEAD"',
		],
	},
	{
		file: "gitjig/publish/executor.ts",
		allow: [
			// A numeric module constant.
			"CHILD_TIMEOUT_MS",
			// The child's numeric exit status, and the signal NAME the
			// platform reports — neither is actor-named text. The whole
			// ternary is one entry now that the capture balances braces; the
			// nested template's own interpolations are listed beside it,
			// because the scan reaches them too rather than stopping at the
			// outer expression.
			'code !== null ? `exit status ${code}` : `signal ${signal ?? "unknown"}`',
			"code",
			'signal ?? "unknown"',
		],
	},
	{
		file: "gitjig/publish/index.ts",
		allow: [
			// Carriers of this module's own fixed causes.
			"cause",
			"outcome.cause",
			// `outcome.url` is NOT here either. The comment-URL shape closes
			// the LINE-FORGING half of this class — anchored at both ends,
			// body class excluding whitespace — and closes nothing else:
			// `[^\s]` admits C0, DEL and C1, the ESC byte among them, and the
			// value is the `gh` child's own stdout. §3.10 asks for uniform
			// mitigation with an EMPTY exemption set, so the result text
			// escapes it rather than carrying the one exception (issue #97).
			// Format-checked lowercase-hyphen pattern ids and numeric line
			// locators — the refuse-match composition carries no body byte,
			// which is the property that lets a refusal name where it matched
			// without quoting the match.
			'scan.patternIds.join(", ")',
			'scan.lines.join(", ")',
		],
		allowErrorReads: [
			// Admitted only for PatternSourceError, whose messages are fixed
			// content-free literals; every other throw takes this module's
			// own fixed cause. The allowance is the WHOLE line including that
			// guard, so it cannot silently admit some other ternary raw read
			// that happens to trim to the same few tokens.
			'error instanceof PatternSourceError ? error.message : "the scan machinery failed before a verdict";',
		],
	},
	{
		file: "gitjig/publish/neutralize.ts",
		allow: [
			// Not a message surface. This is the neutralizer composing its
			// own PRODUCT — the wrap delimiter, the matched span it is
			// wrapping, and the separators that keep the wrap from merging
			// with a body backtick run. Escaping the match here would defeat
			// the function, whose whole job is to return the body's own bytes
			// rendered inert.
			"delimiter",
			"match",
			"separatorBefore",
			"separatorAfter",
		],
	},
	// The scanner composes no interpolated text; its refusals are fixed.
	{ file: "gitjig/publish/scan.ts", allow: [] },
];

function read(file: string): string {
	return readFileSync(join(EXTENSIONS_DIR, file), "utf8");
}

/**
 * Every file the extension tree holds, as paths relative to
 * `.pi/extensions/`. The DOMAIN is this walk, never a list of containers:
 * a module added as a new sibling entry beside `gitjig.ts`, or nested
 * deeper than `gitjig/`, is returned here the moment it exists, so it
 * cannot join the tree already decided (§3.2 loads extensions from the
 * repository's extension directory, which makes both shapes supported
 * growth rather than hypotheses).
 */
function walkExtensionFiles(dir: string = EXTENSIONS_DIR, prefix = ""): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir).sort()) {
		const absolute = join(dir, entry);
		const relative = prefix === "" ? entry : `${prefix}/${entry}`;
		if (statSync(absolute).isDirectory()) {
			found.push(...walkExtensionFiles(absolute, relative));
		} else {
			found.push(relative);
		}
	}
	return found;
}

/**
 * The in-module record of non-membership. It lives in the module's own
 * header, where a reader of the module finds it, and this suite reads THAT
 * text rather than a second list that could drift from it — the roster and
 * the reasons are then one record with two readers, not two records.
 */
const EXEMPT_MARKER = /Warning-surface roster:\s*EXEMPT\s*—\s*[A-Za-z][^\n]*/;

/**
 * The module's leading block comment, and nothing after it. The marker is
 * read only from here: matched over the whole file it counts anywhere, so a
 * module could exempt itself with a mid-file comment — including prose
 * merely describing this lock — which is not a disposition.
 */
function leadingBlockComment(source: string): string {
	// Anchored at the FIRST NON-WHITESPACE character. Taking the first block
	// comment wherever it sits would make a mid-module comment the "leading"
	// one in any module that opens with code, which is the same accidental
	// self-exemption one layer in.
	if (!/^\s*\/\*/.test(source)) {
		return "";
	}
	const opened = source.indexOf("/*");
	const closed = source.indexOf("*/", opened);
	return closed === -1 ? "" : source.slice(opened, closed + 2);
}

/**
 * A walked file is in exactly one of two states. `undecided` is the third
 * outcome the lock exists to make impossible: a module that joined the tree
 * and was never ruled on either way.
 *
 * One predicate, two call sites (§3.11): the roster arm calls it over the
 * real tree, the teeth arms below call it over synthetic inputs.
 */
function rosterDisposition(
	file: string,
	roster: readonly string[],
	source: string,
): "locked" | "exempt" | "undecided" {
	if (roster.includes(file)) {
		return "locked";
	}
	return EXEMPT_MARKER.test(leadingBlockComment(source)) ? "exempt" : "undecided";
}

/**
 * The comment-free view. Rostered headers NAME the tokens
 * the scans below turn on — `${`, `error.message`, `JSON.stringify` —
 * while explaining the decisions behind them, so a scan over the raw text
 * would report the commentary as the code. Block comments are removed
 * bodily; line comments only when the line carries nothing else (the
 * sources write no trailing comments — residual 1 in the header).
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter((line) => !/^\s*\/\//.test(line))
		.join("\n");
}

/**
 * Every interpolation's expression, captured WHOLE. A `[^}]*` capture stops
 * at the first inner brace, and rostered modules do write brace-bearing
 * expressions — `JSON.stringify({ … })` among them — so a truncating
 * capture hands the admit test a fragment. Braces are balanced from the
 * opening `${` instead; an interpolation whose braces never balance is
 * returned as the empty-string expression, which no allowlist carries and
 * no escaping prefix matches, so it fails closed rather than vanishing.
 */
function interpolationExpressions(source: string): string[] {
	const found: string[] = [];
	for (let at = source.indexOf("${"); at !== -1; at = source.indexOf("${", at + 2)) {
		let depth = 1;
		let cursor = at + 2;
		while (cursor < source.length && depth > 0) {
			if (source[cursor] === "{") {
				depth += 1;
			} else if (source[cursor] === "}") {
				depth -= 1;
			}
			cursor += 1;
		}
		found.push(depth === 0 ? source.slice(at + 2, cursor - 1).trim() : "");
	}
	return found;
}

/**
 * True iff the expression is WHOLLY one escaping call. A `startsWith` test
 * admits `JSON.stringify({ … }) + rawPath`, whose tail is then never
 * scanned: the escaper's name at the front is not the same claim as the
 * value being escaped. So the call must open at the first character and its
 * parenthesis must close on the last.
 */
function isEscapedWhole(expression: string): boolean {
	const opener = ["quoted(", "JSON.stringify("].find((name) => expression.startsWith(name));
	if (opener === undefined || !expression.endsWith(")")) {
		return false;
	}
	let depth = 0;
	for (let at = opener.length - 1; at < expression.length; at += 1) {
		if (expression[at] === "(") {
			depth += 1;
		} else if (expression[at] === ")") {
			depth -= 1;
			// The opening parenthesis closed before the end, so whatever
			// follows is outside the escaping call.
			if (depth === 0) {
				return at === expression.length - 1;
			}
		}
	}
	return false;
}

/**
 * Every `${…}` whose expression is neither escaped where it stands nor on
 * the file's allowlist. Exported to the mutant arms below by being the one
 * verdict function both the roster arms and the self-tests call — one
 * predicate, two call sites (§3.11).
 */
function interpolationViolations(source: string, allow: readonly string[]): string[] {
	const violations: string[] = [];
	for (const expression of interpolationExpressions(stripComments(source))) {
		if (isEscapedWhole(expression)) {
			continue;
		}
		if (allow.includes(expression)) {
			continue;
		}
		violations.push(expression);
	}
	return violations;
}

/**
 * Lines that read `error.message` or `String(error)` with no `quoted(` or
 * `JSON.stringify(` opening before the read on the same line. This is the
 * taint the `${…}` scan cannot see: `warnDegraded(reason, …)` carries a
 * path-bearing message in argument position with no interpolation at all.
 */
function rawErrorReads(source: string): string[] {
	const offenders: string[] = [];
	for (const line of stripComments(source).split("\n")) {
		const at = line.search(/\berror\.message\b|\bString\(error\)/);
		if (at === -1) {
			continue;
		}
		if (/(quoted|JSON\.stringify)\(/.test(line.slice(0, at))) {
			continue;
		}
		offenders.push(line.trim());
	}
	return offenders;
}

describe("warning-surface escaping lock (§3.10, issue #47)", () => {
	for (const { file, allow } of SOURCES) {
		it(`every interpolated path in ${file} is escaped at the point of interpolation`, () => {
			const violations = interpolationViolations(read(file), allow);
			assert.equal(
				violations.length,
				0,
				`${file} interpolates ${violations.length} expression(s) raw — each is a surface a hostile path ` +
					`component can forge a line into or land control bytes on (issue #47). Escape each where it ` +
					`stands (quoted(…)), or, only if it provably carries no path, add its exact text to this ` +
					`file's allowlist above: ${JSON.stringify(violations, null, 2)}`,
			);
		});
	}

	it("every file the extension walk returns is decided — on the roster, or exempt with a recorded reason", () => {
		const roster = SOURCES.map(({ file }) => file);
		const undecided = walkExtensionFiles().filter(
			(file) => rosterDisposition(file, roster, read(file)) === "undecided",
		);
		assert.deepEqual(
			undecided,
			[],
			`${undecided.length} module(s) under .pi/extensions/ are on neither state: not on this suite's roster, ` +
				`and carrying no recorded reason for staying off it. A module joins the tree and is covered only if ` +
				`someone remembers, which is the silent-omission the lock exists to close (§3.10 asks for an empty ` +
				`exemption set and a structural lock so a new site cannot drift in unguarded). Put each on SOURCES ` +
				`with its allowlist, or write the reason it stays off into its own header as ` +
				`"Warning-surface roster: EXEMPT — <reason>": ${JSON.stringify(undecided, null, 2)}`,
		);
	});

	it("the roster names no file the walk does not return", () => {
		const walked = new Set(walkExtensionFiles());
		const stale = SOURCES.map(({ file }) => file).filter((file) => !walked.has(file));
		assert.deepEqual(
			stale,
			[],
			`the roster names ${stale.length} file(s) the extension tree no longer holds — a roster entry for a ` +
				`deleted module reads as coverage and scans nothing: ${JSON.stringify(stale, null, 2)}`,
		);
	});

	it("no raw error extraction flows to a warn/throw surface in any shipped source", () => {
		const offenders: string[] = [];
		for (const { file, allowErrorReads = [] } of SOURCES) {
			for (const line of rawErrorReads(read(file))) {
				if (allowErrorReads.includes(line)) {
					continue;
				}
				offenders.push(`${file}: ${line}`);
			}
		}
		assert.equal(
			offenders.length,
			0,
			`a raw error.message/String(error) read reaches a message surface unescaped — a filesystem error ` +
				`message embeds the hostile path verbatim, so this carrier forges lines exactly as an ` +
				`interpolation does (issue #47). Wrap the extraction in quoted(…): ${JSON.stringify(offenders, null, 2)}`,
		);
	});
});

describe("the lock's own teeth (§3.12 — a guard the suite never measures is decoration)", () => {
	it("reports a raw interpolation in a synthetic source", () => {
		assert.deepEqual(interpolationViolations("console.warn(`at ${somePath}`);", []), ["somePath"]);
	});

	it("admits a quoted() interpolation in a synthetic source", () => {
		assert.deepEqual(interpolationViolations("console.warn(`at ${quoted(somePath)}`);", []), []);
	});

	it("reports an unlisted bare identifier even beside an allowlisted one", () => {
		assert.deepEqual(interpolationViolations("console.warn(`${cause} at ${sinkPath}`);", ["cause"]), [
			"sinkPath",
		]);
	});

	it("captures a brace-bearing expression WHOLE, not up to its first inner brace", () => {
		assert.deepEqual(interpolationExpressions("`${JSON.stringify({ a: 1 })}`"), ["JSON.stringify({ a: 1 })"]);
	});

	it("reports a raw tail concatenated behind an escaping call", () => {
		// The prefix test admitted this: the escaper's name at the front is
		// not the same claim as the value being escaped.
		assert.deepEqual(interpolationViolations("`${JSON.stringify({ a: 1 }) + rawPath}`", []), [
			"JSON.stringify({ a: 1 }) + rawPath",
		]);
	});

	it("admits an escaping call that spans the whole expression", () => {
		assert.deepEqual(interpolationViolations("`${quoted(somePath)}`", []), []);
		assert.deepEqual(interpolationViolations("`${quoted(a) }`", []), []);
		// The whole-JSON.stringify shape two rostered modules depend on, pinned
		// here rather than only by those modules' arms over today's tree.
		assert.deepEqual(interpolationViolations("`${JSON.stringify({ a: 1 })}`", []), []);
	});

	it("an interpolation whose braces never balance fails closed", () => {
		assert.deepEqual(interpolationViolations('"${quoted(x"', []), [""]);
	});

	it("reads the exemption marker from the leading block comment only", () => {
		const inHeader = "/** Warning-surface roster: EXEMPT — it is the escaper. */\nexport const x = 1;";
		const midLine = "/** ordinary header */\n// Warning-surface roster: EXEMPT — prose describing the rule.\n";
		// A module that opens with CODE has no leading block comment at all,
		// so a block comment further down is not its header.
		const midBlock = "export const x = 1;\n/* Warning-surface roster: EXEMPT — prose describing the rule. */\n";
		assert.equal(rosterDisposition("m.ts", [], inHeader), "exempt");
		assert.equal(rosterDisposition("m.ts", [], midLine), "undecided");
		assert.equal(rosterDisposition("m.ts", [], midBlock), "undecided");
	});

	it("reports an undecided module — on no roster and carrying no recorded reason", () => {
		assert.equal(rosterDisposition("gitjig/newcomer.ts", ["gitjig/audit.ts"], "export const x = 1;"), "undecided");
	});

	it("admits a module on the roster", () => {
		assert.equal(rosterDisposition("gitjig/audit.ts", ["gitjig/audit.ts"], "export const x = 1;"), "locked");
	});

	it("admits an off-roster module carrying the recorded reason in its own text", () => {
		assert.equal(
			rosterDisposition("gitjig/quote.ts", [], "/** Warning-surface roster: EXEMPT — it is the escaper. */"),
			"exempt",
		);
	});

	it("a marker with no reason after it is not a disposition", () => {
		// The record is the REASON; a bare marker would let a module opt out
		// by asserting nothing, which is the silent omission under a new name.
		assert.equal(rosterDisposition("gitjig/quote.ts", [], "/** Warning-surface roster: EXEMPT — */"), "undecided");
	});

	it("reports a raw path interpolation in a degradedMessage-shaped composition", () => {
		// Acceptance criterion 3, in the scanner's own terms: the site that
		// composes the bind-state advisory must not be able to grow a raw path.
		assert.deepEqual(
			interpolationViolations("return `gitjig bind state: ${state}; stamp ${stampPath}`;", ["state"]),
			["stampPath"],
		);
	});

	it("reports a raw error interpolation in a recordStampRefusal-shaped composition", () => {
		// Acceptance criterion 4: the same site with the extraction wrapped passes.
		assert.deepEqual(
			interpolationViolations("`could not be opened: ${error.message}`", []),
			["error.message"],
		);
		assert.deepEqual(interpolationViolations("`could not be opened: ${quoted(error.message)}`", []), []);
	});

	it("reports a raw error extraction and admits a wrapped one", () => {
		assert.deepEqual(rawErrorReads("const reason = error.message;"), ["const reason = error.message;"]);
		assert.deepEqual(rawErrorReads("const reason = quoted(error.message);"), []);
	});
});

describe("in-place disclosure and shipped-comment hygiene (issue #53)", () => {
	// Two more read-only text scans, same posture as the header: claims
	// about source text only, nothing about runtime behaviour.

	it("quote.ts's header discloses the non-bidi invisible-format residual (§3.11)", () => {
		// The header already draws the "not concealment" boundary; §3.11 asks
		// that the class left outside it — the invisible format characters
		// that are not bidi controls, ZERO WIDTH SPACE (U+200B) foremost —
		// be named in place, so the boundary reads as a decision rather than
		// an omission. The codepoint spelling is the stable token: any
		// honest disclosure of the class names its exemplar, and matching
		// only that token leaves the wording free to change.
		assert.match(
			read("gitjig/quote.ts"),
			/U\+200B/,
			"quote.ts's header does not name the non-bidi invisible-format residual — the U+200B class passes quoted() raw, and an undisclosed boundary reads as an omission, not a decision (§3.11)",
		);
	});

	it("the C1-shape doc block ships without review archaeology", () => {
		// A shipped comment may cite the issue that owns a decision — the
		// durable pointer — but not the internals of the review that
		// produced it: such references expire with the review and read as
		// provenance, not contract. The scan is scoped to the one doc block
		// that describes the C1 shape, so legitimate uses of the token
		// elsewhere in the suite cannot false-positive.
		const suite = readFileSync(join(repoRoot(), "test", "primitives.unit.test.ts"), "utf8");
		const blocks = [...suite.matchAll(/\/\*\*(?:[^*]|\*(?!\/))*\*\//g)]
			.map((match) => match[0])
			.filter((block) => block.includes("- C1:"));
		assert.equal(blocks.length, 1, "expected exactly one doc block describing the C1 shape");
		assert.doesNotMatch(
			blocks[0],
			/\bround\b/i,
			"the C1-shape doc block carries a review-round reference — cite the owning issue and drop the review internals",
		);
	});
});

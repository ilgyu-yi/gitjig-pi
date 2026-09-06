/**
 * Egress secret scan — the committed pattern file's second reader (SPEC
 * §3.3 "egress publish-boundary semantics"; issue #83 AC4).
 *
 * Rule source: `.githooks/helpers/secret-patterns`, resolved from the
 * runtime's own repository root (§4.6) — never a caller-supplied location.
 * Parsed on the file's own format contract: one `id<TAB>ERE` row per line,
 * a trailing CR stripped per row, blank and `#`-leading lines ignored,
 * lowercase-hyphen IDs, EREs constrained to the POSIX-ERE ∩ RegExp common
 * subset so `new RegExp` compiles what the tier-2 engine compiles. That
 * subset is now measured at the loader rather than assumed of the committed
 * file — PARTIALLY, and the partiality is the point of the next paragraph.
 * These refuse the load: the three construct classes the pattern file's own
 * contract forbids (backslash-letter escapes and backreferences, `(?` group
 * extensions, and the POSIX bracket constructs — class, equivalence class
 * and collating symbol, whole or truncated); two spellings the engines were
 * measured to split on (a backslash inside a bracket expression, and the
 * leading-`]` bracket family); and four spellings aimed at the asymmetry
 * that matters — an unterminated bracket expression, an unterminated `{`
 * interval, an empty alternation branch, and a lazy `*`/`+`/`?` suffix.
 *
 * That asymmetry, because it decides what is worth catching here: a row
 * RegExp refuses is caught one statement below by the compile step, so it
 * fails closed on its own. A row POSIX refuses arms HERE and disarms the
 * tier-2 scan wholesale, through that scanner's up-front validation probe.
 * Only the second direction needs catching at this loader, and those four
 * are its likeliest spellings — `[A-Z]{16` is one keystroke from a committed
 * row. Two of the four also refuse spellings POSIX accepts as literals;
 * that costs an author a puzzling refusal and never an admission.
 *
 * A named residual of the lazy-suffix arm: it covers the `*`/`+`/`?`
 * spellings and NOT the interval one, so `{16}?` is admitted — one character
 * from a committed row, and in the disarm direction. Left to the bound
 * rather than closed here, because tightening it would refuse `a}?`, which
 * both engines hold; that is a design choice, not an obvious repair. The
 * lock catches this spelling: the tier-2 probe refuses to compile it, so the
 * oracle assertion fails and the suite reds before such a row could land.
 *
 * THIS CHECK IS PARTIAL BY CONSTRUCTION and makes no completeness claim. It
 * is a lexical scanner over a grammar, not the grammar; three review rounds
 * each widened the measuring alphabet and each found another construct class
 * it did not hold, which is what a second implementation of a contract does
 * (§3.11). What it buys is that the likeliest spellings fail at the loader
 * rather than silently. What BOUNDS it is the conformance lock, which is the
 * real check: its oracle asserts the tier-2 probe compiles every committed
 * row, and its ID closure forces a case per row, so a committed pattern the
 * tier-2 engine cannot compile reds the suite whatever this scanner thought
 * of it. A construct class found later is a residual against that bound, not
 * a hole in a claim made here (§3.11, issue #86).
 *
 * Fail posture (§3.9 `egress-publish-patterns`, closed): an unusable rule
 * source — file unreadable, a row failing the format contract, a pattern
 * that does not compile, or a set empty after stripping comments and
 * blanks — throws `PatternSourceError` with a fixed content-free cause.
 * Machinery failure is NOT the out-of-domain disposition: that one is for
 * a body the reading cannot measure, and the caller maps the throw to its
 * own machinery refusal.
 *
 * Measurement pipeline (§3.3, ordered): (1) a NUL-bearing body is
 * out-of-domain; (2) Unicode format characters (category Cf) are stripped
 * before matching — the over-match closure for a split span; (3) matching
 * runs per line over the byte-domain reading of the stripped text (each
 * line's UTF-8 bytes viewed one-byte-one-code-unit), converged with the
 * tier-2 scan's `LC_ALL=C` byte semantics. A refuse-match outcome carries
 * pattern IDs and 1-based line locators and never the matched text (§3.8).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { locateRepoRoot } from "../locate.ts";

/** The committed rule source, relative to the repository root (§3.3). */
const PATTERN_FILE_PARTS = [".githooks", "helpers", "secret-patterns"] as const;

/** Lowercase-hyphen ID tokens, per the pattern file's format contract. */
const ID_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * An unusable rule source (§3.9 `egress-publish-patterns`). The message is
 * a fixed literal — no path, no row content — so a caller may surface it
 * verbatim in a content-free refusal record.
 */
export class PatternSourceError extends Error {}

export type ScanOutcome =
	| { disposition: "clean" }
	| { disposition: "refuse-out-of-domain" }
	| { disposition: "refuse-match"; patternIds: string[]; lines: number[] };

interface CompiledPattern {
	id: string;
	regexp: RegExp;
}

/** Read, parse, and compile the committed set — or throw, never degrade. */
function loadCommittedPatterns(): CompiledPattern[] {
	const path = join(locateRepoRoot(), ...PATTERN_FILE_PARTS);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		throw new PatternSourceError(
			"the committed pattern file is absent or unreadable at the resolved repository root",
		);
	}
	const compiled: CompiledPattern[] = [];
	for (const rawLine of raw.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (/^[ \t]*$/.test(line) || line.startsWith("#")) {
			continue;
		}
		const tab = line.indexOf("\t");
		if (tab === -1 || !ID_SHAPE.test(line.slice(0, tab))) {
			throw new PatternSourceError("a committed pattern row fails the id<TAB>ERE format contract");
		}
		const ere = line.slice(tab + 1);
		// The SUBSET is measured here, before compilation, because `new RegExp`
		// cannot measure it: a JS-only construct compiles happily at this
		// reader and diverges at the tier-2 one, which is the whole hazard.
		if (!inCommonSubset(ere)) {
			throw new PatternSourceError("a committed pattern uses a construct outside the POSIX-ERE and RegExp common subset");
		}
		try {
			compiled.push({ id: line.slice(0, tab), regexp: new RegExp(ere) });
		} catch {
			// What this catch measured is compilation AS A REGULAR EXPRESSION,
			// and the cause now says so. It used to claim the common subset,
			// naming a measurement this code did not take.
			throw new PatternSourceError("a committed pattern does not compile as a regular expression");
		}
	}
	if (compiled.length === 0) {
		throw new PatternSourceError("the committed pattern set is empty after stripping comments and blanks");
	}
	return compiled;
}

/**
 * The index of the `]` closing the bracket expression opened at `at`, or -1.
 * The caller has already refused the leading-`]` spellings, on which the two
 * engines do NOT agree, so this scan never meets one.
 */
function closingBracket(ere: string, at: number): number {
	let cursor = at + 1;
	if (ere[cursor] === "^") {
		cursor += 1;
	}
	for (; cursor < ere.length; cursor += 1) {
		// A POSIX class, equivalence class or collating symbol carries its own
		// `]`, which does not close the bracket expression around it — stepping
		// over the whole span is what keeps `[[=a=]]` from looking closed at
		// its inner bracket.
		const kind = ere[cursor] === "[" ? ere[cursor + 1] : undefined;
		if (kind === ":" || kind === "=" || kind === ".") {
			const end = ere.indexOf(kind + "]", cursor + 2);
			if (end !== -1) {
				cursor = end + 1;
				continue;
			}
		}
		if (ere[cursor] === "]") {
			return cursor;
		}
	}
	return -1;
}

/**
 * True iff `ere` uses only constructs the POSIX-ERE and RegExp readers both
 * hold. The committed pattern file states the contract this enforces — no
 * backreferences or lookarounds, no backslash-letter classes, no POSIX
 * bracket classes, explicit ranges only — and until now nothing enforced it:
 * the loader measured ID shape and RegExp compilability, so a JS-only
 * construct compiled here and diverged at the tier-2 matcher, caught only
 * where the shared case set happened to look (issue #86).
 *
 * Lexical and PARTIAL: it rejects the construct classes the module note
 * enumerates rather than deciding the full grammar, so a construct outside
 * the subset that spells itself none of those ways still passes. That
 * residual is the conformance lock's to bound — see the note — and this
 * function claims no more than the list it implements.
 *
 * Exported for the measurement (§3.12): the loader reads the committed file
 * from the repository root and takes no path, so the only way to stage an
 * out-of-subset pattern against it would be to write one into the committed
 * set. The predicate is one predicate with two call sites — the loader, and
 * the arms that hold it to each construct class it refuses.
 */
export function inCommonSubset(ere: string): boolean {
	for (let at = 0; at < ere.length; at += 1) {
		if (ere[at] === "\\") {
			const next = ere[at + 1];
			// A backslash-letter or backslash-digit escape is either a
			// backreference or one of RegExp's own shorthand classes; POSIX ERE
			// holds neither. Punctuation escapes are the shared ones.
			if (next !== undefined && /[A-Za-z0-9]/.test(next)) {
				return false;
			}
			at += 1;
			continue;
		}
		// `(?` opens every RegExp group extension — lookaround, non-capturing,
		// named. POSIX ERE has no group extension at all.
		if (ere[at] === "(" && ere[at + 1] === "?") {
			return false;
		}
		// A LAZY quantifier suffix. RegExp compiles `a*?`; POSIX refuses it.
		if ("*+?".includes(ere[at]) && ere[at + 1] === "?") {
			return false;
		}
		// An EMPTY alternation branch — leading, trailing, or against a group
		// edge. RegExp compiles `a|`; POSIX refuses it. A trailing `|` is what
		// an appended alternative leaves behind when its right half is lost.
		if (ere[at] === "|") {
			const before = ere[at - 1];
			const after = ere[at + 1];
			if (before === undefined || before === "(" || before === "|") {
				return false;
			}
			if (after === undefined || after === ")" || after === "|") {
				return false;
			}
		}
		// An UNTERMINATED interval. RegExp compiles `a{1`; POSIX refuses it,
		// and a dropped brace on a committed row is the likeliest way to
		// arrive here — `[A-Z]{16` is one keystroke from a committed pattern.
		if (ere[at] === "{" && ere.indexOf("}", at) === -1) {
			return false;
		}
		// Inside a BRACKET EXPRESSION the two engines diverge on three POSIX
		// constructs — the character class `[: :]`, the equivalence class
		// `[= =]` and the collating symbol `[. .]` — which RegExp reads as
		// ordinary characters, and on a backslash, which POSIX ERE reads
		// literally and RegExp reads as an escape. So the whole bracket
		// expression is examined rather than its opening two bytes.
		if (ere[at] === "[") {
			// The leading-`]` family is a MEASURED divergence, not an agreement:
			// POSIX reads `[]]` as a bracket holding one literal `]`, while
			// RegExp reads `[]` as an empty class that matches nothing and the
			// trailing `]` as a literal. A row spelled this way arms at commit
			// time and is inert here — an under-match, and §3.3 records this
			// gate's backstop as none.
			const afterNegation = ere[at + 1] === "^" ? at + 2 : at + 1;
			if (ere[afterNegation] === "]") {
				return false;
			}
			const close = closingBracket(ere, at);
			if (close === -1) {
				// An unterminated bracket expression: the engines cannot agree
				// on what they never finish parsing.
				return false;
			}
			const inside = ere.slice(at + 1, close);
			if (inside.includes("\\")) {
				return false;
			}
			for (const opener of ["[:", "[=", "[."]) {
				// The OPENER alone is enough, and looking for its closer was a
				// measured mistake: POSIX refuses to compile a truncated span
				// like `[[:]` outright, while RegExp reads it as ordinary
				// bytes — and a committed row POSIX cannot compile disarms the
				// whole tier-2 scan through its up-front validation probe, for
				// every path and every commit. There is nothing in the
				// truncated spelling to preserve. Scoping the search to THIS
				// bracket expression is what keeps `[:]`, a literal colon both
				// engines hold, admitted.
				if (inside.includes(opener)) {
					return false;
				}
			}
			at = close;
			continue;
		}
	}
	return true;
}

/**
 * The boundary's measurement, total in the three dispositions above.
 * Throws `PatternSourceError` exactly when the rule source is unusable.
 */
export function scanBody(body: string): ScanOutcome {
	if (body.includes("\u0000")) {
		return { disposition: "refuse-out-of-domain" };
	}
	const stripped = body.replace(/\p{Cf}/gu, "");
	const patterns = loadCommittedPatterns();
	const patternIds: string[] = [];
	const lines: number[] = [];
	stripped.split("\n").forEach((line, index) => {
		// One byte, one code unit: the UTF-8 bytes of the line re-read as
		// latin1, so a multibyte codepoint interrupts a counted class run
		// exactly as it does under the tier-2 engine's byte semantics (§3.3).
		const byteView = Buffer.from(line, "utf8").toString("latin1");
		let matched = false;
		for (const pattern of patterns) {
			if (pattern.regexp.test(byteView)) {
				matched = true;
				if (!patternIds.includes(pattern.id)) {
					patternIds.push(pattern.id);
				}
			}
		}
		if (matched) {
			lines.push(index + 1);
		}
	});
	if (patternIds.length > 0) {
		return { disposition: "refuse-match", patternIds, lines };
	}
	return { disposition: "clean" };
}

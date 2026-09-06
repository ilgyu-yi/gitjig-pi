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
 * subset is now MEASURED at the loader rather than assumed of the committed
 * file: the three construct classes the pattern file's own contract forbids
 * — backslash-letter escapes and backreferences, `(?` group extensions, and
 * POSIX bracket classes — refuse the load. The check is lexical and
 * conservative in the refusing direction, so a divergence spelled none of
 * those three ways still passes here; the conformance lock's shared case set
 * is what bounds that residual, by running both readers over the same
 * cases (§3.11, issue #86).
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
 * True iff `ere` uses only constructs the POSIX-ERE and RegExp readers both
 * hold. The committed pattern file states the contract this enforces — no
 * backreferences or lookarounds, no backslash-letter classes, no POSIX
 * bracket classes, explicit ranges only — and until now nothing enforced it:
 * the loader measured ID shape and RegExp compilability, so a JS-only
 * construct compiled here and diverged at the tier-2 matcher, caught only
 * where the shared case set happened to look (issue #86).
 *
 * Lexical and CONSERVATIVE in the refusing direction: it rejects the three
 * construct classes the contract names rather than deciding the full
 * grammar, so a construct outside the subset that spells itself none of
 * these ways still passes. That residual is the conformance lock's to bound,
 * and it is named in this module's header rather than left implied.
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
		// A POSIX bracket class inside a bracket expression: RegExp reads the
		// characters literally, so the two engines disagree on the same bytes.
		if (ere.startsWith("[:", at) && ere.indexOf(":]", at) !== -1) {
			return false;
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

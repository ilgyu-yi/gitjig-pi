/**
 * Egress neutralization — relayed platform side effects made inert (SPEC
 * §3.3 "Neutralization"; §3.6's worked application; issue #83 AC2).
 *
 * Runs on its own pattern set — mention shapes are not secret patterns.
 * Each actionable shape is transformed WHOLE to a backtick-wrapped
 * spelling, so republished text cannot page uninvolved parties or drive
 * the platform's auto-close channel (§3.7(e), §3.11's auto-close
 * essential): `@`-mentions, close-keyword + issue-reference pairs in
 * their case and separator variants (whitespace and the colon trailer),
 * `GH-N` forms, URL-form issue references, and cross-repository
 * `owner/repo#N` references.
 *
 * TWO shapes stay live as recorded decisions (§3.3), each on its own
 * ground. The bare same-repository `#N` — the pointer idiom §5.1 commits
 * every durable artifact to — stays live inside the predicate itself.
 * §1.1's linkage line stays live at the DESTINATION-AWARE boundary below
 * and nowhere else (issue #129): the predicate is total over close pairs,
 * and what the boundary decides is which text it hands the predicate.
 * That placement is the whole safety property — an exemption inside the
 * predicate would reach the title operand and every destination kind.
 *
 * The wrap is delimiter-length-aware because CommonMark pairs a code
 * span's opener with the next backtick run of EQUAL length: each pass
 * wraps with a run one backtick longer than the longest run in the text
 * it lands in (recomputed per pass — earlier passes insert backticks),
 * space-padded inside per CommonMark's own padding rule, and separated
 * by a space from any adjacent body backtick, whose touching run would
 * otherwise merge with the delimiter and leave no span. Measured ground
 * for both rules: a fixed single-backtick wrap paired with a stray body
 * backtick and rendered the shape live, and a delimiter touching a body
 * backtick merged runs so no span formed. Entity-encoded spellings are
 * refused as a device here: `&#64;`-style escapes decode back into the
 * text nodes reference filters scan.
 */

/**
 * The wrap passes, in application order: longer shapes first, so the
 * common case of a narrower pattern re-matching inside an already
 * wrapped span does not arise. Where a narrower pattern can still match
 * inside a wrapped shape's text (an `@` inside a URL form), the
 * per-pass delimiter rule makes the double wrap err inert — the outer
 * pair still closes around it.
 */
const WRAP_PASSES: readonly RegExp[] = [
	// URL-form issue references: https://…/issues/N and …/pull/N.
	/https?:\/\/[^\s`]+\/(?:issues|pull)\/\d+/g,
	// Close-keyword + issue-reference pairs, case-insensitive, in both
	// separator spellings — whitespace and the colon trailer (`Fixes: #4`,
	// `fixes:#4`). At least one separator is required: bare `fixes#4`
	// adjacency stays a deliberate non-match (§3.3).
	//
	// The separator carries AT MOST ONE newline, which is what keeps it
	// inside a single paragraph — and a bare line break IS one of its
	// spellings, in all three alternatives: after a colon, on its own, or
	// after horizontal space. A first cut required a colon or a space BEFORE
	// the newline and so declined `fixes\n#4`, a same-paragraph pair this
	// very comment says must still match — narrower than the paragraph rule
	// it states, and in the wrong-allow direction. `\s*` admitted a blank
	// line, and a pair
	// whose separator crosses one is worse than an unmatched pair: the
	// wrap still fires, but a fenced span cannot cross a blank line, so
	// no code span forms and the reference is left live wearing backticks
	// — matched-but-void (issue #86). A blank line is also a paragraph
	// break, so the platform does not read the halves as one close pair
	// either; declining to match there costs nothing and voids nothing.
	/\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)(?::[^\S\n]*(?:\n[^\S\n]*)?|[^\S\n]*\n[^\S\n]*|[^\S\n]+)#\d+/gi,
	// Cross-repository references: owner/repo#N.
	/\b[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+#\d+/g,
	// GH-N forms, case-insensitive: the platform autolinks the lowercase
	// spelling too, so a case-sensitive pass left `gh-4` live while wrapping
	// `GH-4` — a neutralization that depends on how the author capitalized
	// is not one (issue #86). `\d+` keeps `gh-pages` and its kin out.
	/\bGH-\d+\b/gi,
	// @-mentions. \B admits a mention after whitespace or punctuation and
	// excludes an @ preceded by a word character (an address-shaped span).
	/\B@[A-Za-z0-9-]+/g,
];

/** The longest backtick run in `text`, 0 when it carries none. */
function longestBacktickRun(text: string): number {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) {
		if (run.length > longest) {
			longest = run.length;
		}
	}
	return longest;
}

/**
 * What one neutralization did: the published spelling, and HOW MANY
 * actionable shapes were made inert. The count and never the text — a
 * result a composer may relay stays content-free about what it names
 * (§3.8's refusal-record rule).
 */
export interface NeutralizationOutcome {
	text: string;
	neutralized: number;
}

/** The one predicate. Total over every shape in `WRAP_PASSES`, no exemption. */
function neutralizeCore(body: string): NeutralizationOutcome {
	let neutralized = body;
	let count = 0;
	for (const pass of WRAP_PASSES) {
		// One backtick longer than anything already present, so the wrap's
		// opener pairs with its own closer and never with a body run.
		const delimiter = "`".repeat(longestBacktickRun(neutralized) + 1);
		neutralized = neutralized.replace(pass, (match, offset: number, whole: string) => {
			count += 1;
			// A body backtick touching the wrap would merge runs (no span
			// forms), so a space separates the delimiter from it.
			const separatorBefore = offset > 0 && whole[offset - 1] === "`" ? " " : "";
			const afterIndex = offset + match.length;
			const separatorAfter = afterIndex < whole.length && whole[afterIndex] === "`" ? " " : "";
			return `${separatorBefore}${delimiter} ${match} ${delimiter}${separatorAfter}`;
		});
	}
	return { text: neutralized, neutralized: count };
}

/**
 * The published spelling of `body`: every actionable shape wrapped whole.
 * The unexempted face of the one predicate, as plain text — the shape the
 * conformance arms that predate the boundary bind to. A title does NOT
 * cross here: it takes `neutralizeOperand`, which is this face plus the
 * count. Both halves of that sentence were true before the split below
 * existed and neither survived it.
 */
export function neutralizeBody(body: string): string {
	return neutralizeCore(body).text;
}

/**
 * The unexempted face WITH its count — what a published operand that is
 * not a pull request description crosses. A title takes this route and
 * never the boundary below, deliberately: §1.1 fixes a grammar for a
 * description's first line and for no other field, so a title spelled
 * like one is prose (§3.3, "never a title").
 */
export function neutralizeOperand(text: string): NeutralizationOutcome {
	return neutralizeCore(text);
}

/**
 * §1.1's linkage line, and nothing adjacent to it. The section fixes this
 * spelling exactly; a variant the platform might honour is NOT admitted,
 * because widening here would be the instrument deciding on the author's
 * behalf that a variant was meant as a control. What makes the narrowness
 * safe rather than merely strict is the count this module returns: an
 * author who spelled it otherwise is told, instead of being handed an
 * exemption they did not earn (§3.3's reporting rule).
 */
const LINKAGE_LINE = /^Closes #\d+$/;

/**
 * The destination kinds that write a pull request's own DESCRIPTION — the
 * one field §1.1 fixes a grammar for and the platform reads as a control.
 * Not `pr-comment`: a comment is prose on a pull request, not its body.
 */
const DESCRIPTION_KINDS: ReadonlySet<string> = new Set(["pr-body", "pr-create"]);

/**
 * The boundary the publish surface calls: the one predicate above, applied
 * to the text this destination admits. Bounded on three axes at once, each
 * of which is a separate arm in the conformance suite — by kind (the two
 * description kinds only), by position (the first line only), and by
 * grammar (§1.1's spelling only). Every other byte of every body reaches
 * `neutralizeCore` exactly as it did before this function existed.
 */
export function neutralizeForDestination(body: string, kind: string): NeutralizationOutcome {
	if (!DESCRIPTION_KINDS.has(kind)) {
		return neutralizeCore(body);
	}
	const breakAt = body.indexOf("\n");
	const first = breakAt === -1 ? body : body.slice(0, breakAt);
	// A CRLF checkout smudge must not silently cost the exemption: the
	// carriage return is dropped for the GRAMMAR test and kept in the bytes
	// that publish, so the line the platform reads is the caller's own.
	if (!LINKAGE_LINE.test(first.replace(/\r$/, ""))) {
		return neutralizeCore(body);
	}
	const rest = breakAt === -1 ? "" : body.slice(breakAt);
	const outcome = neutralizeCore(rest);
	return { text: first + outcome.text, neutralized: outcome.neutralized };
}

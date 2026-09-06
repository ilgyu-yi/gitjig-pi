/**
 * Convergence-lock suite for the two readers of the one committed pattern
 * file (issue #83 AC4; SPEC §3.3's egress rule-source clause, §3.11's
 * converged-implementations clause). The lock is the shared case set
 * `test/harness/secret-pattern-cases.ts`; this suite runs BOTH readers
 * against it:
 *
 *   - the tier-2 reader through the committed chain — a githook fixture
 *     driven by `git commit`, never a predicate called directly;
 *   - the egress reader through the (Phase-C) module
 *     `.pi/extensions/gitjig/publish/scan.ts` — RED until that module
 *     lands: every egress-reader arm first requires the module and fails
 *     with its authored message while it is absent, so the red is the
 *     subject's absence and never a harness crash that kills siblings.
 *
 * AUTHORED PHASE-C CONTRACT (what the egress-reader arms bind to): the
 * module exports `scanBody(body: string)` returning one of
 *   { disposition: "clean" }
 *   { disposition: "refuse-out-of-domain" }
 *   { disposition: "refuse-match", patternIds: string[] }  // committed IDs
 * per §3.3's ordered pipeline (NUL → out-of-domain; Cf stripped; per-line
 * byte-domain matching). The result NEVER carries the matched text.
 *
 * WHAT THIS SUITE DOES NOT ESTABLISH. The bash-oracle arms prove that the
 * case samples and the committed EREs agree under the tier-2 engine's own
 * dialect (`[[ =~ ]]`, LC_ALL=C) — they do not prove the scanner's
 * plumbing (the githook arms do that) nor the egress reader's semantics
 * (its own arms do). ID closure is lexical set equality over the committed
 * file's rows — it proves every committed pattern HAS a case, not that any
 * reader honors it. Nothing here touches a publish surface: the egress
 * reader is exercised as a pure function, and the instrument around it is
 * `egress-publish.integration.test.ts`'s subject.
 *
 * Mutants, both directions, for every matcher surface:
 *   - a dud match sample (would silently prove nothing) dies at the oracle
 *     match arm; an over-wide near-miss dies at the oracle no-match arm;
 *   - a committed pattern row added without a case dies at ID closure (⊇),
 *     a case naming a dead ID dies at ID closure (⊆);
 *   - a truncating tier-2 NUL read (allow) dies at the nul-join arm, and
 *     an over-eager binary verdict (refusing the joined match as
 *     unmeasurable) dies at the same arm's pattern-ID assertion;
 *   - each reader is driven with matching AND non-matching inputs, so a
 *     reader that always refuses or always allows reddens both ways.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import {
	buildGithookFixture,
	type CommitAttempt,
	commitWithMessage,
	fixtureGit,
	type GithookFixture,
	removeGithookFixture,
} from "./harness/githook-fixture.ts";
import { repoRoot } from "./harness/run-pi.ts";
import {
	BODY_MEASUREMENT_CASES,
	committedPatternRows,
	CONFORMANCE_CASES,
} from "./harness/secret-pattern-cases.ts";

const IS_WINDOWS = process.platform === "win32";

/** The egress reader's Phase-C home (SPEC §3.3 egress row; issue #83). */
const SCAN_MODULE_PATH = join(repoRoot(), ".pi", "extensions", "gitjig", "publish", "scan.ts");
const SCAN_MODULE_RED =
	"red until the Code phase lands .pi/extensions/gitjig/publish/scan.ts exporting scanBody " +
	"(issue #83 AC4 — the egress consumer is the committed pattern file's second reader, SPEC §3.3)";

type EgressScanOutcome =
	| { disposition: "clean" }
	| { disposition: "refuse-out-of-domain" }
	| { disposition: "refuse-match"; patternIds: string[] };

let scanBody: ((body: string) => EgressScanOutcome) | undefined;
/** The neutralizer, loaded the same guarded way as the scanner above. */
const NEUTRALIZE_MODULE_PATH = join(repoRoot(), ".pi", "extensions", "gitjig", "publish", "neutralize.ts");
let neutralizeBody: ((body: string) => string) | undefined;
/** The loader's subset predicate, loaded the same guarded way. */
let inCommonSubset: ((ere: string) => boolean) | undefined;

before(async () => {
	// Guarded dynamic import: while the module is absent the arms below red
	// on `requireScanner`'s authored message instead of a loader crash that
	// would take the oracle and tier-2 arms down with it (header note).
	if (existsSync(NEUTRALIZE_MODULE_PATH)) {
		const mod = (await import(NEUTRALIZE_MODULE_PATH)) as Record<string, unknown>;
		if (typeof mod.neutralizeBody === "function") {
			neutralizeBody = mod.neutralizeBody as (body: string) => string;
		}
	}
	if (existsSync(SCAN_MODULE_PATH)) {
		const mod = (await import(SCAN_MODULE_PATH)) as Record<string, unknown>;
		if (typeof mod.inCommonSubset === "function") {
			inCommonSubset = mod.inCommonSubset as (ere: string) => boolean;
		}
		if (typeof mod.scanBody === "function") {
			scanBody = mod.scanBody as (body: string) => EgressScanOutcome;
		}
	}
});

function requireScanner(): (body: string) => EgressScanOutcome {
	assert.ok(scanBody !== undefined, SCAN_MODULE_RED);
	return scanBody as (body: string) => EgressScanOutcome;
}

/**
 * The tier-2 engine's own dialect as oracle: one child bash per probe,
 * LC_ALL=C (§3.3's pinned matcher). Keyed by outcome (§3.10): 0 = match,
 * 1 = no match, anything else = the probe could not measure.
 */
function ereMatches(sample: string, ere: string): boolean {
	const probe = spawnSync("bash", ["-c", '[[ "$2" =~ $1 ]]; exit "$?"', "bash", ere, sample], {
		env: { PATH: process.env.PATH ?? "", LC_ALL: "C" },
	});
	assert.ok(
		probe.status === 0 || probe.status === 1,
		`ERE oracle probe failed (status ${probe.status}) for pattern ${JSON.stringify(ere)}: ` +
			`${(probe.stderr ?? Buffer.alloc(0)).toString("utf8")}`,
	);
	return probe.status === 0;
}

// ---------------------------------------------------------------------------
// Case-set integrity — green now; the lock's own mutants die here.
// ---------------------------------------------------------------------------

describe("case-set integrity: ID closure and oracle agreement (issue #83 AC4)", { skip: IS_WINDOWS }, () => {
	it("ID closure, both directions: the case set and the committed file name the same IDs", () => {
		const committedIds = committedPatternRows().map((row) => row.id);
		const caseIds = CONFORMANCE_CASES.map((c) => c.id);
		for (const id of committedIds) {
			assert.ok(
				caseIds.includes(id),
				`committed pattern '${id}' has no conformance case — a pattern can reach one reader ` +
					`untested by the lock (issue #83 AC4's failing direction)`,
			);
		}
		for (const id of caseIds) {
			assert.ok(
				committedIds.includes(id),
				`conformance case '${id}' names no committed pattern — a stale case vouches for a rule that is gone`,
			);
		}
		assert.equal(new Set(caseIds).size, caseIds.length, "duplicate case IDs would let one arm mask another");
	});

	it("every match sample matches its OWN committed ERE under the tier-2 oracle (kills a dud sample)", () => {
		const rows = committedPatternRows();
		for (const conformanceCase of CONFORMANCE_CASES) {
			const row = rows.find((r) => r.id === conformanceCase.id);
			assert.ok(row !== undefined, `no committed row for '${conformanceCase.id}' (ID closure should have caught this)`);
			assert.ok(
				ereMatches(conformanceCase.match, (row as { ere: string }).ere),
				`case '${conformanceCase.id}': the match sample does not match its committed ERE — ` +
					`every reader arm built on it would prove nothing`,
			);
		}
	});

	it("every near-miss matches NO committed ERE under the oracle (kills an over-wide sample)", () => {
		const rows = committedPatternRows();
		for (const conformanceCase of CONFORMANCE_CASES) {
			for (const row of rows) {
				assert.ok(
					!ereMatches(conformanceCase.nearMiss, row.ere),
					`case '${conformanceCase.id}': the near-miss matches committed pattern '${row.id}' — ` +
						`the allow-direction arms built on it would refuse for the wrong reason`,
				);
			}
		}
	});

	it("every refuse-match expectation names a committed pattern ID, and the declared divergences are exactly the SPEC's", () => {
		const committedIds = committedPatternRows().map((row) => row.id);
		for (const bodyCase of BODY_MEASUREMENT_CASES) {
			for (const [reader, expectation] of [
				["tier2", bodyCase.tier2],
				["egress", bodyCase.egress],
			] as const) {
				if (expectation.disposition === "refuse-match") {
					assert.ok(
						expectation.patternId !== undefined && committedIds.includes(expectation.patternId),
						`body case '${bodyCase.name}' (${reader}): refuse-match without a committed pattern ID`,
					);
				}
			}
			// Correspondence map (case-set contract): allow↔clean,
			// refuse-match↔refuse-match with the same pattern ID,
			// refuse-unmeasurable↔refuse-out-of-domain.
			const corresponds =
				bodyCase.tier2.disposition === "allow"
					? bodyCase.egress.disposition === "clean"
					: bodyCase.tier2.disposition === "refuse-match"
						? bodyCase.egress.disposition === "refuse-match" &&
							bodyCase.egress.patternId === bodyCase.tier2.patternId
						: bodyCase.egress.disposition === "refuse-out-of-domain";
			assert.equal(
				corresponds,
				!bodyCase.divergent,
				`body case '${bodyCase.name}': the divergent flag contradicts the declared dispositions — ` +
					`a reader divergence must be declared, never incidental (SPEC §3.3's enumerated divergences)`,
			);
		}
		const divergent = BODY_MEASUREMENT_CASES.filter((c) => c.divergent).map((c) => c.name).sort();
		assert.deepEqual(
			divergent,
			["cf-split", "nul-join"],
			"the divergence set drifted from §3.3's enumerated per-reader divergences (the NUL-join strip and the Cf allowance)",
		);
	});
});

// ---------------------------------------------------------------------------
// Tier-2 arm — the committed chain against every applicable case. Green
// now: the scanner and its pattern file are landed and armed (issue #66).
// ---------------------------------------------------------------------------

/** Build the standard scan fixture on a feature branch (sibling-suite idiom). */
function buildScanFixture(): GithookFixture {
	const fixture = buildGithookFixture({ remote: { defaultBranch: "zqegresstrunkzq" } });
	fixtureGit(fixture, ["checkout", "-q", "-b", "zqegressfeat"]);
	return fixture;
}

function stageAndCommit(name: string, content: Buffer): CommitAttempt {
	const fixture = buildScanFixture();
	try {
		writeFileSync(join(fixture.root, name), content);
		fixtureGit(fixture, ["add", "--", name]);
		return commitWithMessage(fixture, "chore: exercise a conformance-lock case\n");
	} finally {
		removeGithookFixture(fixture);
	}
}

describe("tier-2 arm: the committed chain honors every applicable case (issue #83 AC4)", { skip: IS_WINDOWS }, () => {
	for (const conformanceCase of CONFORMANCE_CASES) {
		it(`match sample '${conformanceCase.id}': refused naming the pattern ID`, () => {
			const attempt = stageAndCommit(`zqlock-${conformanceCase.id}.txt`, Buffer.from(conformanceCase.match + "\n", "utf8"));
			assert.notEqual(attempt.status, 0, `tier-2 '${conformanceCase.id}': the staged match COMMITTED`);
			assert.match(attempt.auditDelta, /\bblock\b.*\bsecret\b/, `tier-2 '${conformanceCase.id}': no secret block record`);
			assert.ok(
				attempt.auditDelta.includes(conformanceCase.id),
				`tier-2 '${conformanceCase.id}': the refusal record does not name the pattern ID (§3.3)`,
			);
		});

		it(`near-miss '${conformanceCase.id}': allowed with no block record`, () => {
			const attempt = stageAndCommit(`zqlock-nm-${conformanceCase.id}.txt`, Buffer.from(conformanceCase.nearMiss + "\n", "utf8"));
			assert.equal(attempt.status, 0, `tier-2 near-miss '${conformanceCase.id}': ${attempt.stderr}`);
			assert.doesNotMatch(
				attempt.auditDelta,
				/\bblock\b/,
				`tier-2 near-miss '${conformanceCase.id}': a non-matching sample was refused — an over-wide reader`,
			);
		});
	}

	for (const bodyCase of BODY_MEASUREMENT_CASES) {
		it(`body case '${bodyCase.name}': tier-2 lands ${bodyCase.tier2.disposition} — ${bodyCase.tier2.ground}`, () => {
			const attempt = stageAndCommit(`zqlock-body-${bodyCase.name}.txt`, Buffer.from(bodyCase.body, "utf8"));
			const committedIds = committedPatternRows().map((row) => row.id);
			switch (bodyCase.tier2.disposition) {
				case "refuse-match": {
					assert.notEqual(attempt.status, 0, `tier-2 '${bodyCase.name}': the staged body COMMITTED`);
					assert.match(attempt.auditDelta, /\bblock\b.*\bsecret\b/, `tier-2 '${bodyCase.name}': no secret block record`);
					assert.ok(
						attempt.auditDelta.includes(bodyCase.tier2.patternId as string),
						`tier-2 '${bodyCase.name}': the record does not name '${bodyCase.tier2.patternId}' — for nul-join ` +
							`this is the JOIN direction's pin: a truncating line read yields fragments too short to match`,
					);
					break;
				}
				case "refuse-unmeasurable": {
					assert.notEqual(attempt.status, 0, `tier-2 '${bodyCase.name}': the staged body COMMITTED`);
					assert.match(attempt.auditDelta, /\bblock\b.*\bsecret\b/, `tier-2 '${bodyCase.name}': no secret block record`);
					for (const id of committedIds) {
						assert.ok(
							!attempt.auditDelta.includes(id),
							`tier-2 '${bodyCase.name}': an unmeasurable-input refusal names pattern '${id}' (§3.9's split)`,
						);
					}
					break;
				}
				case "allow": {
					assert.equal(attempt.status, 0, `tier-2 '${bodyCase.name}': ${attempt.stderr}`);
					assert.doesNotMatch(
						attempt.auditDelta,
						/\bblock\b/,
						`tier-2 '${bodyCase.name}': an allow-side case was refused — for cf-split this widens ` +
							`the tier-2 reader past its recorded residual without a Doc change (§3.3)`,
					);
					break;
				}
			}
		});
	}
});

// ---------------------------------------------------------------------------
// Egress-reader arm — RED until Phase C lands publish/scan.ts.
// ---------------------------------------------------------------------------

describe("egress-reader arm: publish/scan.ts against the same case set (issue #83 AC4)", () => {
	it("the egress reader module resolves and exports scanBody", () => {
		assert.ok(existsSync(SCAN_MODULE_PATH), SCAN_MODULE_RED);
		assert.ok(scanBody !== undefined, SCAN_MODULE_RED);
	});

	for (const conformanceCase of CONFORMANCE_CASES) {
		it(`match sample '${conformanceCase.id}': refuse-match naming the pattern ID, never the text`, () => {
			const scan = requireScanner();
			const outcome = scan(conformanceCase.match);
			assert.equal(
				outcome.disposition,
				"refuse-match",
				`egress '${conformanceCase.id}': expected refuse-match, got ${JSON.stringify(outcome)}`,
			);
			const ids = (outcome as { patternIds: string[] }).patternIds;
			assert.ok(
				Array.isArray(ids) && ids.includes(conformanceCase.id),
				`egress '${conformanceCase.id}': the outcome does not name the pattern ID (§3.3 pattern-ID reporting)`,
			);
			assert.ok(
				!JSON.stringify(outcome).includes(conformanceCase.match),
				`egress '${conformanceCase.id}': the outcome carries the matched text (§3.8's refusal-record rule)`,
			);
		});

		it(`near-miss '${conformanceCase.id}': clean`, () => {
			const scan = requireScanner();
			const outcome = scan(conformanceCase.nearMiss);
			assert.equal(
				outcome.disposition,
				"clean",
				`egress near-miss '${conformanceCase.id}': a non-matching body was refused — got ${JSON.stringify(outcome)}`,
			);
		});
	}

	for (const bodyCase of BODY_MEASUREMENT_CASES) {
		it(`body case '${bodyCase.name}': egress lands ${bodyCase.egress.disposition} — ${bodyCase.egress.ground}`, () => {
			const scan = requireScanner();
			const outcome = scan(bodyCase.body);
			assert.equal(
				outcome.disposition,
				bodyCase.egress.disposition,
				`egress '${bodyCase.name}': got ${JSON.stringify(outcome)}`,
			);
			if (bodyCase.egress.disposition === "refuse-match") {
				const ids = (outcome as { patternIds: string[] }).patternIds;
				assert.ok(
					Array.isArray(ids) && ids.includes(bodyCase.egress.patternId as string),
					`egress '${bodyCase.name}': the outcome does not name '${bodyCase.egress.patternId}'`,
				);
			}
		});
	}
});

// ---------------------------------------------------------------------------
// Latent edges the readers carry, pinned so arming one fails loud rather than
// under-matching or diverging in silence (issue #86).
// ---------------------------------------------------------------------------

describe("latent reader edges are pinned, not left silent (issue #86, SPEC §3.3)", () => {
	it("no committed pattern is `$`-anchored while body lines keep their CR", () => {
		// The egress reader strips Unicode format characters and splits on
		// "\n", so a CRLF-composed line reaches the match with its CR still
		// on it. A `$`-anchored pattern would therefore UNDER-MATCH exactly
		// those lines — the wrong-allow direction, at the boundary that is the
		// only safety net for its class, with nothing beneath it.
		//
		// No committed pattern is anchored today, so this arm is the guard on
		// ARMING one: it fails loud the moment somebody adds an anchor, and
		// points at the repair rather than letting the under-match ship. The
		// repair is to strip a trailing CR per line in the reader before
		// matching, at which point this arm is retired with that change.
		// ANY unescaped `$` outside a bracket expression, not merely a trailing
		// one: `secret$|other` anchors its first alternative in both engines
		// and would under-match a CR-terminated line just as a trailing anchor
		// does. A literal dollar must be written escaped or bracketed in both
		// engines, so neither spelling can false-positive here — including the
		// leading-`]` spellings, whose first `]` is an ordinary member.
		const anchored = committedPatternRows().filter((row) => {
			let escaped = false;
			let inBracket = false;
			for (let at = 0; at < row.ere.length; at += 1) {
				const ch = row.ere[at];
				if (escaped) {
					escaped = false;
					continue;
				}
				if (ch === "\\") {
					escaped = true;
					continue;
				}
				if (inBracket) {
					if (ch === "]") {
						inBracket = false;
					}
					continue;
				}
				if (ch === "[") {
					inBracket = true;
					// A `]` in first position (after an optional negation) is an
					// ordinary member, not the close — so `[]$]` holds a literal
					// dollar and must not be read as an anchor.
					if (row.ere[at + 1] === "^" && row.ere[at + 2] === "]") {
						at += 2;
					} else if (row.ere[at + 1] === "]") {
						at += 1;
					}
					continue;
				}
				if (ch === "$") {
					return true;
				}
			}
			return false;
		});
		assert.deepEqual(
			anchored.map((row) => row.id),
			[],
			`a committed pattern is '$'-anchored while the egress reader leaves a trailing CR on every ` +
				`CRLF-composed body line, so that pattern silently under-matches exactly those lines and the ` +
				`boundary admits what it was armed to refuse. Strip the trailing CR per line in the reader ` +
				`before matching, then retire this arm with that change (§3.3, issue #86)`,
		);
	});

	it("the loader refuses each construct class outside the common subset", () => {
		// The loader measured ID shape and RegExp compilability and called the
		// second one a subset check, so a JS-only construct compiled here and
		// diverged at the tier-2 matcher — caught only where the shared case
		// set happened to look. The three classes the committed pattern file's
		// own contract forbids are now measured before compilation.
		assert.ok(inCommonSubset !== undefined, "red until publish/scan.ts exports inCommonSubset");
		for (const outside of [
			"(?=lookahead)x", // group extensions: POSIX ERE has none at all
			"(?:group)x",
			"(a)\\1", // a backreference
			"\\d{4}", // a backslash-letter shorthand class
			"\\wfoo",
			"[[:alpha:]]+", // a POSIX bracket class RegExp reads literally
			"[[=a=]]", // an equivalence class — the same divergence, sibling spelling
			"[[.a.]]", // a collating symbol — likewise
			"[[:]", // a TRUNCATED span: POSIX refuses to compile it, RegExp does not
			"[[=]",
			"[[:alpha]",
			"[]]", // the leading-] family: POSIX reads a literal ], RegExp an empty class
			"[]a]",
			"[^]]",
			"[\\-]", // a backslash inside a bracket expression: POSIX literal, RegExp escape
			"[abc", // an unterminated bracket expression the engines never finish parsing
			// POSIX refuses to compile each of these while RegExp accepts it, so
			// a committed row spelled this way arms the publish reader and
			// disarms the tier-2 scan through its up-front validation probe.
			"a{1", // an unterminated interval — one keystroke from a committed row
			"[A-Z]{16",
			"a|", // an empty alternation branch, as an appended alternative leaves
			"|a",
			"(|a)",
			"a*?", // a lazy `*`/`+`/`?` suffix: a RegExp habit POSIX has no form for.
			"a+?" // The interval spelling `{16}?` is NOT covered — a residual the
			// module note records, left to the conformance lock, whose tier-2
			// probe refuses to compile it.
		]) {
			assert.equal(
				inCommonSubset(outside),
				false,
				`${JSON.stringify(outside)} was admitted to the common subset — it compiles at this reader and ` +
					`diverges at the tier-2 one, which is the hazard the check exists for (issue #86)`,
			);
		}
		// Every committed pattern, and the shared punctuation escapes, stay in.
		for (const inside of committedPatternRows().map((row) => row.ere).concat([
			"a\\.b",
			"x\\*y",
			"[A-Za-z0-9._~+/=-]{20,}",
			"[:]", // a bracket expression holding a literal colon — both engines agree
			"[:a]x[b:]", // colons in two separate bracket expressions, neither a class
		])) {
			assert.equal(
				inCommonSubset(inside),
				true,
				`${JSON.stringify(inside)} was refused though both readers hold it — a refusal here costs a future ` +
					`author a puzzling load failure for a pattern both engines agree on`,
			);
		}
	});

	it("a same-paragraph close pair is neutralized in every separator spelling", () => {
		// The blank-line repair overshot once: requiring a colon or a space
		// BEFORE the newline dropped `fixes\n#4`, a same-paragraph pair the
		// paragraph rule says must still match, in the wrong-allow direction.
		assert.ok(neutralizeBody !== undefined, "red until publish/neutralize.ts exports neutralizeBody");
		for (const body of ["fixes #4", "fixes: #4", "fixes:#4", "fixes\n#4", "fixes\n   #4", "fixes:\n#4", "fixes \n#4"]) {
			assert.notEqual(
				neutralizeBody(body),
				body,
				`${JSON.stringify(body)} is a close pair inside one paragraph and was not neutralized — the ` +
					`separator rule is at most one newline, not a colon-or-space requirement before it (issue #86)`,
			);
		}
		// The deliberate non-match is unchanged.
		assert.equal(neutralizeBody("fixes#4"), "fixes#4", "bare adjacency stays a deliberate non-match (§3.3)");
	});

	it("a close pair whose separator crosses a blank line is not matched at all", () => {
		// Matched-but-void is worse than unmatched: the wrap fires, but a code
		// span cannot cross a blank line, so no span forms and the reference
		// ships live wearing backticks. A blank line is a paragraph break, so
		// the platform reads no close pair across it either.
		assert.ok(neutralizeBody !== undefined, "red until publish/neutralize.ts exports neutralizeBody");
		const crossed = neutralizeBody("Fixes:\n\n#4");
		assert.equal(
			crossed,
			"Fixes:\n\n#4",
			`a close pair whose separator crosses a blank line was transformed — the wrap cannot form a code ` +
				`span across a paragraph break, so what ships is a live reference wearing backticks (issue #86)`,
		);
		// The single-newline form stays inside one paragraph and is still a
		// close pair to the platform, so it is still neutralized.
		assert.equal(
			neutralizeBody("Fixes\n\n#4"),
			"Fixes\n\n#4",
			"the no-colon blank-line form must decline too",
		);
	});

	it("the GH-N form is neutralized in either case", () => {
		// The platform autolinks the lowercase spelling too, so a
		// case-sensitive pass left `gh-4` live while wrapping `GH-4` — a
		// neutralization that depends on how the author capitalized.
		assert.ok(neutralizeBody !== undefined, "red until publish/neutralize.ts exports neutralizeBody");
		for (const spelling of ["GH-4", "gh-4", "Gh-4"]) {
			assert.notEqual(
				neutralizeBody(spelling),
				spelling,
				`${spelling} passed through un-neutralized — the platform autolinks it whatever the case (issue #86)`,
			);
		}
		// The digits are what make it a reference; `gh-pages` is not one.
		assert.equal(neutralizeBody("gh-pages"), "gh-pages", "gh-pages is not a reference and must not be wrapped");
	});
});

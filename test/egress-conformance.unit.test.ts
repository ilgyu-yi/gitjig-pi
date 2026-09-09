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
import { BODY_MEASUREMENT_CASES, CONFORMANCE_CASES, committedPatternRows } from "./harness/secret-pattern-cases.ts";

const IS_WINDOWS = process.platform === "win32";

/** The egress reader's Phase-C home (SPEC §3.3 egress row; issue #83). */
const SCAN_MODULE_PATH = join(repoRoot(), ".pi", "extensions", "gitjig", "publish", "scan.ts");
const SCAN_MODULE_RED =
	"publish/scan.ts does not export scanBody, so this arm has no scanner to measure " +
	"(issue #83 AC4 — the egress consumer is the committed pattern file's second reader, SPEC §3.3)";

type EgressScanOutcome =
	| { disposition: "clean" }
	| { disposition: "refuse-out-of-domain" }
	| { disposition: "refuse-match"; patternIds: string[] };

let scanBody: ((body: string) => EgressScanOutcome) | undefined;
/** The neutralizer, loaded the same guarded way as the scanner above. */
const NEUTRALIZE_MODULE_PATH = join(repoRoot(), ".pi", "extensions", "gitjig", "publish", "neutralize.ts");
let neutralizeBody: ((body: string) => string) | undefined;
/** The kind-aware boundary entry point (§3.3's linkage-line exemption, issue #129). */
let neutralizeForDestination: ((body: string, kind: string) => { text: string; neutralized: number }) | undefined;
/** The loader's subset predicate, loaded the same guarded way. */
let inCommonSubset: ((ere: string) => boolean) | undefined;
/**
 * The instrument's OWN kind list, loaded the same guarded way — the
 * population the two kind lists below must partition. Read from the module
 * rather than retyped, so a kind added there cannot go unmeasured here.
 */
const EXECUTOR_MODULE_PATH = join(repoRoot(), ".pi", "extensions", "gitjig", "publish", "executor.ts");
let publishDestinationKinds: readonly string[] | undefined;

before(async () => {
	// Guarded dynamic import: while the module is absent the arms below red
	// on `requireScanner`'s authored message instead of a loader crash that
	// would take the oracle and tier-2 arms down with it (header note).
	if (existsSync(NEUTRALIZE_MODULE_PATH)) {
		const mod = (await import(NEUTRALIZE_MODULE_PATH)) as Record<string, unknown>;
		if (typeof mod.neutralizeBody === "function") {
			neutralizeBody = mod.neutralizeBody as (body: string) => string;
		}
		if (typeof mod.neutralizeForDestination === "function") {
			neutralizeForDestination = mod.neutralizeForDestination as (
				body: string,
				kind: string,
			) => { text: string; neutralized: number };
		}
	}
	if (existsSync(EXECUTOR_MODULE_PATH)) {
		const mod = (await import(EXECUTOR_MODULE_PATH)) as Record<string, unknown>;
		if (Array.isArray(mod.PUBLISH_DESTINATION_KINDS)) {
			publishDestinationKinds = mod.PUBLISH_DESTINATION_KINDS as readonly string[];
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
						? bodyCase.egress.disposition === "refuse-match" && bodyCase.egress.patternId === bodyCase.tier2.patternId
						: bodyCase.egress.disposition === "refuse-out-of-domain";
			assert.equal(
				corresponds,
				!bodyCase.divergent,
				`body case '${bodyCase.name}': the divergent flag contradicts the declared dispositions — ` +
					`a reader divergence must be declared, never incidental (SPEC §3.3's enumerated divergences)`,
			);
		}
		const divergent = BODY_MEASUREMENT_CASES.filter((c) => c.divergent)
			.map((c) => c.name)
			.sort();
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
			const attempt = stageAndCommit(
				`zqlock-${conformanceCase.id}.txt`,
				Buffer.from(conformanceCase.match + "\n", "utf8"),
			);
			assert.notEqual(attempt.status, 0, `tier-2 '${conformanceCase.id}': the staged match COMMITTED`);
			assert.match(
				attempt.auditDelta,
				/\bblock\b.*\bsecret\b/,
				`tier-2 '${conformanceCase.id}': no secret block record`,
			);
			assert.ok(
				attempt.auditDelta.includes(conformanceCase.id),
				`tier-2 '${conformanceCase.id}': the refusal record does not name the pattern ID (§3.3)`,
			);
		});

		it(`near-miss '${conformanceCase.id}': allowed with no block record`, () => {
			const attempt = stageAndCommit(
				`zqlock-nm-${conformanceCase.id}.txt`,
				Buffer.from(conformanceCase.nearMiss + "\n", "utf8"),
			);
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
					assert.match(
						attempt.auditDelta,
						/\bblock\b.*\bsecret\b/,
						`tier-2 '${bodyCase.name}': no secret block record`,
					);
					assert.ok(
						attempt.auditDelta.includes(bodyCase.tier2.patternId as string),
						`tier-2 '${bodyCase.name}': the record does not name '${bodyCase.tier2.patternId}' — for nul-join ` +
							`this is the JOIN direction's pin: a truncating line read yields fragments too short to match`,
					);
					break;
				}
				case "refuse-unmeasurable": {
					assert.notEqual(attempt.status, 0, `tier-2 '${bodyCase.name}': the staged body COMMITTED`);
					assert.match(
						attempt.auditDelta,
						/\bblock\b.*\bsecret\b/,
						`tier-2 '${bodyCase.name}': no secret block record`,
					);
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
// Egress-reader arm: publish/scan.ts is the reader under test here.
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
		assert.ok(
			inCommonSubset !== undefined,
			"publish/scan.ts does not export inCommonSubset, so the subset predicate cannot be measured",
		);
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
			"a+?", // The interval spelling `{16}?` is NOT covered — a residual the
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
		for (const inside of committedPatternRows()
			.map((row) => row.ere)
			.concat([
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
		assert.ok(
			neutralizeBody !== undefined,
			"publish/neutralize.ts does not export neutralizeBody, so the unexempted face cannot be measured",
		);
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
		assert.ok(
			neutralizeBody !== undefined,
			"publish/neutralize.ts does not export neutralizeBody, so the unexempted face cannot be measured",
		);
		const crossed = neutralizeBody("Fixes:\n\n#4");
		assert.equal(
			crossed,
			"Fixes:\n\n#4",
			`a close pair whose separator crosses a blank line was transformed — the wrap cannot form a code ` +
				`span across a paragraph break, so what ships is a live reference wearing backticks (issue #86)`,
		);
		// The single-newline form stays inside one paragraph and is still a
		// close pair to the platform, so it is still neutralized.
		assert.equal(neutralizeBody("Fixes\n\n#4"), "Fixes\n\n#4", "the no-colon blank-line form must decline too");
	});

	it("the GH-N form is neutralized in either case", () => {
		// The platform autolinks the lowercase spelling too, so a
		// case-sensitive pass left `gh-4` live while wrapping `GH-4` — a
		// neutralization that depends on how the author capitalized.
		assert.ok(
			neutralizeBody !== undefined,
			"publish/neutralize.ts does not export neutralizeBody, so the unexempted face cannot be measured",
		);
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

// ---------------------------------------------------------------------------
// §1.1's linkage line at the boundary (issue #129; SPEC §3.3's second
// recorded-live shape).
//
// The exemption lives at the DESTINATION-AWARE entry point, never inside
// `neutralizeBody`. That placement is the subject of the first arm below and
// is not incidental: `neutralizeBody` is the class's one predicate (§3.11
// forbids a second implementation, not a second call), and every arm above
// binds to it. What the exemption changes is which TEXT the boundary hands
// that predicate for two of six kinds — a domain split, not a second matcher.
//
// The issue that filed this warned that a leading-exemption disposition would
// redden the "every separator spelling" arm above. It does not, on two
// INDEPENDENT grounds, and both are asserted below so neither can rot into
// the other: that arm drives `neutralizeBody` directly, which is unexempted;
// and every input it carries is a `fixes` spelling, which §1.1's grammar does
// not admit even at the boundary.
// ---------------------------------------------------------------------------

/** §1.1's own spelling, the only one the exemption admits. */
const LINKAGE = "Closes #129";
/** The four destination kinds that never write a pull request's description. */
const NON_DESCRIPTION_KINDS = ["issue-comment", "pr-comment", "issue-body", "issue-create"] as const;
/** The two that do. */
const DESCRIPTION_KINDS = ["pr-body", "pr-create"] as const;

function requireBoundary(arm: string): (body: string, kind: string) => { text: string; neutralized: number } {
	assert.ok(
		neutralizeForDestination !== undefined,
		`${arm}: publish/neutralize.ts does not export neutralizeForDestination, so the boundary cannot be measured`,
	);
	return neutralizeForDestination;
}

describe("§1.1's linkage line publishes live on a pull request description (issue #129)", () => {
	it("the two kind lists PARTITION the instrument's own kinds — no kind goes unmeasured", () => {
		// The BY KIND arms below iterate two hand-written lists. Their claim is
		// about every kind the instrument admits, not about six names typed here,
		// and nothing tied the one to the other: a SEVENTH kind added to the
		// publish surface would appear in neither list, so neither arm would drive
		// it and the exemption's kind bound would be unmeasured for exactly the
		// kind nobody had thought about. That is the wrong-allow direction — an
		// unclassified kind that takes the exemption opens §3.11's auto-close
		// channel on a surface no arm covers.
		//
		// The population is therefore read off the instrument and partitioned
		// here: disjoint, and exhaustive. A new kind reds this arm until someone
		// decides, deliberately, which side of the bound it belongs on.
		assert.ok(
			publishDestinationKinds !== undefined,
			"publish/executor.ts does not export PUBLISH_DESTINATION_KINDS, so this arm cannot read the population it exists to bind and would be asserting two hand-written lists against each other",
		);
		const partition = [...DESCRIPTION_KINDS, ...NON_DESCRIPTION_KINDS].sort();
		// Disjointness FIRST. Ordered this way deliberately: a duplicate makes
		// the partition one entry longer than the instrument's list, so the
		// deepEqual below would fire first and report a length mismatch — true,
		// but not the failure that happened. An assertion that can only fire for
		// a case other than the one its message describes is a message that will
		// mislead exactly when it is read.
		assert.equal(
			new Set(partition).size,
			partition.length,
			"a kind appears in BOTH lists: it would be asserted to pass the line through and to neutralize it, and one of the two arms would be measuring the opposite of what it claims",
		);
		assert.deepEqual(
			partition,
			[...publishDestinationKinds].sort(),
			"the kinds these arms drive are not the kinds the instrument publishes to. Every kind must sit on exactly one side of the exemption's kind bound, and a kind in neither list is one no arm below can reach",
		);
	});

	it("the exemption is not inside the one predicate — neutralizeBody still wraps the line", () => {
		assert.ok(
			neutralizeBody !== undefined,
			"publish/neutralize.ts does not export neutralizeBody, so the unexempted face cannot be measured",
		);
		assert.notEqual(
			neutralizeBody(LINKAGE),
			LINKAGE,
			"the linkage line was exempted inside neutralizeBody itself. The predicate must stay total over close pairs: every arm above binds to it, and an exemption buried here silently widens to every caller, including the title operand and the four kinds that must never open the auto-close channel",
		);
	});

	it("the standing separator arm's inputs are untouched by the exemption, at the boundary too", () => {
		// The second independent ground. Even where the exemption applies, a
		// `fixes` spelling is not §1.1's and must still be wrapped.
		//
		// WHICH inputs carry that ground, measured rather than assumed: the three
		// SINGLE-LINE spellings do. Under a mutant admitting the fixes family as a
		// whole well-formed line, those three survive un-neutralized and red this
		// arm. The four multi-line spellings stay wrapped under that same mutant,
		// because their reference sits below line one and position disqualifies
		// them before grammar is consulted — they are non-regression cover for the
		// standing separator arm, not measurements of the grammar bound. Recorded
		// so the arm is not read as carrying seven inputs' worth of grammar
		// evidence when it carries three.
		const at = requireBoundary("separator arm");
		for (const body of ["fixes #4", "fixes: #4", "fixes:#4", "fixes\n#4", "fixes\n   #4", "fixes:\n#4", "fixes \n#4"]) {
			for (const kind of DESCRIPTION_KINDS) {
				assert.notEqual(
					at(body, kind).text,
					body,
					`${JSON.stringify(body)} survived un-neutralized on ${kind}: the exemption is bounded BY GRAMMAR to §1.1's spelling, and a fixes-pair is relayed prose wherever it lands`,
				);
			}
		}
	});

	it("BY KIND — the two description kinds pass the line through, live", () => {
		const at = requireBoundary("kind bound");
		for (const kind of DESCRIPTION_KINDS) {
			const out = at(LINKAGE, kind);
			assert.equal(
				out.text,
				LINKAGE,
				`${kind}: §1.1's linkage line was made inert, so a body composed through the one egress boundary cannot carry the reference §1.1 requires — the composing actor is left choosing between §1.1 and §3.4`,
			);
			assert.equal(out.neutralized, 0, `${kind}: nothing was neutralized, so the count must report 0`);
		}
	});

	it("BY KIND — the four other kinds neutralize it, so the auto-close channel stays shut", () => {
		const at = requireBoundary("kind bound");
		for (const kind of NON_DESCRIPTION_KINDS) {
			const out = at(LINKAGE, kind);
			assert.notEqual(
				out.text,
				LINKAGE,
				`${kind}: the linkage line published live off a pull request description. §3.11's auto-close essential is what the kind bound protects, and a blanket exemption re-opens the channel at every surface the instrument can write`,
			);
			assert.ok(out.neutralized >= 1, `${kind}: a shape was made inert and the count did not report it`);
		}
	});

	it("BY POSITION — a line that violates POSITION AND NOTHING ELSE is neutralized", () => {
		// The input is constructed so position is the ONLY bound it fails: the
		// kind is a description kind, and the reference is §1.1's exact grammar
		// on a line of its own. It simply is not line one.
		//
		// This arm replaces one that read the same and measured something else.
		// Its below-the-line input was `and later, Closes #7 in a sentence`,
		// which fails the GRAMMAR bound too — so grammar killed it and position
		// was never exercised, and a mutant exempting the first MATCHING line
		// wherever it sat survived the whole suite. An arm whose input violates
		// two bounds is killed by the nearer one and measures neither.
		const at = requireBoundary("position bound");
		const body = `Some prose that opens the body.\nCloses #7\n`;
		const out = at(body, "pr-body");
		assert.ok(
			out.text.startsWith("Some prose that opens the body.\n"),
			"the opening prose line was rewritten — it carries no actionable shape and must cross untouched",
		);
		// The wrap's own shape is the subject: a backtick run, one space, the
		// matched text, one space, the closing run (§3.3's padding rule).
		assert.match(
			out.text,
			/`+ Closes #7 `+/,
			"§1.1's exact grammar published LIVE off the first line. Position is a load-bearing bound on its own: §1.1 fixes line one and nothing else, so a reference anywhere below it is prose this instrument relays, however it is spelled",
		);
		// The positive shape above shows A wrapped copy exists; it forbids nothing,
		// so a second LIVE copy beside it would satisfy it. The absence probe is
		// the half that forbids. Its lookbehind is what the original spelling got
		// wrong: `[^`]` matched the space the wrap pads with, so a wrapped span
		// read as live and the assertion was vacuous in the other direction.
		assert.doesNotMatch(
			out.text,
			/(?<!` )Closes #7/,
			"an unwrapped occurrence survives somewhere in the output. Every occurrence must be wrapped, not merely one of them",
		);
		assert.equal(out.neutralized, 1, "the below-the-line reference should be counted");
	});

	it("BY POSITION — an exempted first line does not exempt a second reference under it", () => {
		const at = requireBoundary("position bound");
		const out = at(`${LINKAGE}\nCloses #7\n`, "pr-body");
		assert.ok(
			out.text.startsWith(`${LINKAGE}\n`),
			"the first line lost its exemption when the body carried a second reference — the two lines are decided independently",
		);
		assert.match(
			out.text.slice(LINKAGE.length),
			/`+ Closes #7 `+/,
			"a second §1.1-shaped line published live: the exemption is one line, not every line matching the grammar",
		);
		// The forbidding half, as above. Scoped past the exempted first line,
		// which is live BY DESIGN and would trip the probe.
		assert.doesNotMatch(
			out.text.slice(LINKAGE.length),
			/(?<!` )Closes #7/,
			"an unwrapped occurrence survives below the exempted line",
		);
		assert.equal(out.neutralized, 1, "exactly one of the two lines is neutralized");
	});

	it("BY GRAMMAR — a spelling §1.1 does not fix is neutralized rather than guessed at", () => {
		const at = requireBoundary("grammar bound");
		for (const spelling of [
			"Fixes #129",
			"Resolves #129",
			"closes #129",
			"CLOSES #129",
			"Closes: #129",
			"Closes  #129",
		]) {
			const out = at(spelling, "pr-body");
			assert.notEqual(
				out.text,
				spelling,
				`${JSON.stringify(spelling)} was exempted. The grammar bound admits §1.1's own spelling and nothing adjacent to it — a widened exemption is the instrument deciding, on the author's behalf, that a variant was meant as a control. The reporting rule is what makes the narrowness safe: this caller is told.`,
			);
			assert.ok(out.neutralized >= 1, `${JSON.stringify(spelling)}: the count must report what was made inert`);
		}
	});

	it("BY GRAMMAR — a well-spelled line with text AFTER it is neutralized (the tail anchor)", () => {
		// The anchoring half of the grammar bound, which the six spellings above
		// cannot reach: every one of them varies the keyword or the separator, so
		// none puts anything BESIDE a well-spelled line and neither anchor of
		// `^Closes #\d+$` is exercised. Both anchors survived removal against the
		// whole suite until these two arms existed.
		//
		// The input violates the anchoring half and nothing else: the kind is a
		// description kind, the position is line one, and the keyword and
		// separator are §1.1's own. What disqualifies it is the text adjacent to
		// the linkage line — which is exactly what §1.1's grammar excludes.
		const at = requireBoundary("grammar bound, tail anchor");
		const out = at("Closes #4 ping @zqsomeone\nBody prose follows.\n", "pr-body");
		assert.match(
			out.text,
			/`+ @zqsomeone `+/,
			"a mention published LIVE on a pull request description. The exemption passes the WHOLE first line through untouched, so a line that merely BEGINS with §1.1's spelling must not qualify — anything the author put beside the linkage line rides out with it",
		);
		assert.match(
			out.text,
			/`+ Closes #4 `+/,
			"the close pair on a disqualified line was left live: a line that fails the grammar bound is relayed prose in full, on the terms every other body gets",
		);
		assert.equal(out.neutralized, 2, "two actionable shapes on the disqualified line, two counted");
	});

	it("BY GRAMMAR — a well-spelled line with text BEFORE it is neutralized (the head anchor)", () => {
		// The mirror of the arm above, and a separate arm because a separate
		// anchor pins it: dropping `^` alone leaves the tail anchor holding, and
		// the tail arm's input still fails. Same one-bound construction.
		const at = requireBoundary("grammar bound, head anchor");
		const out = at("@zqsomeone Closes #4\nBody prose follows.\n", "pr-body");
		assert.match(
			out.text,
			/`+ @zqsomeone `+/,
			"a mention published LIVE on a pull request description, ahead of the linkage line. §1.1 fixes what the first line IS, not what it ends with",
		);
		assert.match(
			out.text,
			/`+ Closes #4 `+/,
			"the close pair on a disqualified line was left live: a line that fails the grammar bound is relayed prose in full",
		);
		assert.equal(out.neutralized, 2, "two actionable shapes on the disqualified line, two counted");
	});

	it("a CRLF-composed first line keeps the exemption, and publishes the caller's own bytes", () => {
		// The grammar test drops a trailing CR and the published bytes keep it.
		// Both halves are load-bearing and neither was measured: a checkout smudge
		// must not silently cost the exemption, and the line the platform reads
		// must be the one the caller composed.
		const at = requireBoundary("grammar bound, CR tolerance");
		const out = at("Closes #4\r\nthanks @zqsomeone\r\n", "pr-body");
		assert.ok(
			out.text.startsWith("Closes #4\r\n"),
			"a CRLF-composed linkage line lost the exemption to its carriage return, or had the CR stripped from the bytes that publish — the grammar test drops the CR, the send does not",
		);
		assert.match(out.text, /`+ @zqsomeone `+/, "the remainder of a CRLF body is neutralized on the ordinary terms");
		assert.equal(out.neutralized, 1, "one shape below the line, one counted");
	});

	it("the CR tolerance is ANCHORED: an interior carriage return does not buy the exemption", () => {
		// The arm above pins that the strip HAPPENS. This one pins where it may
		// reach, which is a separate claim and was the weaker half: neutering the
		// strip reds the arm above, but WIDENING it — dropping every carriage
		// return in the line rather than only a trailing one — survived the whole
		// suite.
		//
		// What the survivor costs is the auto-close channel itself. A first line
		// of `Closes\r #7` is an actionable close pair at HEAD: the close-keyword
		// pass matches it, because a carriage return is horizontal whitespace to
		// its separator class. Under the widened strip that line launders into
		// §1.1's spelling, takes the exemption, and publishes LIVE on a pull
		// request description — and the count falls from 2 to 1, so the caller is
		// not told either. The strip exists to forgive a checkout smudge at the
		// END of a line, never to rewrite the line the author composed.
		const at = requireBoundary("CR tolerance, anchored");
		const out = at("Closes\r #7\nbody @zquser\n", "pr-body");
		assert.match(
			out.text,
			/`+ Closes\r #7 `+/,
			"a close pair carrying an INTERIOR carriage return published live on a pull request description. §1.1 fixes one spelling; a line that only becomes that spelling after the instrument deletes bytes from its middle was never it, and admitting it opens §3.11's auto-close essential on a body the caller did not compose for it",
		);
		assert.equal(
			out.neutralized,
			2,
			"the count must report both shapes. A widened strip drops this to 1, which is the reporting rule going quiet at exactly the moment a reference went live",
		);
	});

	it("the rest of an exempted body is neutralized exactly as before", () => {
		const at = requireBoundary("rest of body");
		const body = `${LINKAGE}\n\nthanks @someone, see GH-4 and owner/repo#9\n`;
		const out = at(body, "pr-body");
		assert.ok(out.text.startsWith(`${LINKAGE}\n`), "the exempted line did not survive intact");
		for (const shape of ["@someone", "GH-4", "owner/repo#9"]) {
			assert.match(
				out.text,
				new RegExp(`\`+ ${shape.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \`+`),
				`${shape} published live inside an exempted body — the exemption reaches ONE line, and the remainder is relayed text on the terms every other body gets`,
			);
		}
		// The forbidding half, on this arm's own standard. The three probes above
		// show a wrapped copy of each shape exists; none of them forbids a second
		// LIVE copy beside it. This arm kept only positive probes when the two
		// BY POSITION arms gained their lookbehind, which left it weaker than the
		// reasoning written directly above them.
		for (const shape of ["@someone", "GH-4", "owner/repo#9"]) {
			const quoted = shape.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			assert.doesNotMatch(
				out.text,
				new RegExp(`(?<!\` )${quoted}`),
				`${shape}: an unwrapped occurrence survives below the exempted line. Every occurrence must be wrapped, not merely one of them`,
			);
		}
		assert.equal(out.neutralized, 3, "three actionable shapes below the line, three counted");
	});

	it("an address-shaped span is not a mention: it crosses untouched and uncounted", () => {
		// The mention pattern's comment states TWO claims — it admits a mention
		// after whitespace or punctuation, and it EXCLUDES an `@` preceded by a
		// word character. Several arms pin the admitting half. Nothing pinned the
		// excluding half: dropping it survived all 833 tests, because no input
		// anywhere in test/ put a word character immediately ahead of an `@`.
		//
		// The bound is load-bearing in the over-wrap direction. Under the
		// survivor, a relayed address publishes MANGLED — its local part severed
		// from its domain by an injected backtick run — and the count tells the
		// caller a shape was made inert when none was, which is the reporting
		// rule lying in the direction it exists to prevent.
		//
		// Pre-existing, not introduced by the exemption. Repaired here because it
		// is one arm against a pattern in the module this change already touches,
		// and it is the same defect class this change's own review exists to close.
		const at = requireBoundary("address-shaped span");
		for (const kind of ["pr-body", "issue-comment"]) {
			const body = "reach me at ada@zqexample.com\n";
			const out = at(body, kind);
			assert.equal(
				out.text,
				body,
				`${kind}: an address-shaped span was rewritten. The mention pattern excludes an @ preceded by a word character precisely so a relayed address is not severed from its domain by the wrap — republishing it mangled corrupts the caller's own bytes`,
			);
			assert.equal(
				out.neutralized,
				0,
				`${kind}: nothing was made inert, so the count must say 0. A count that reports a rewrite that did not happen is the reporting rule lying in the over-reporting direction`,
			);
		}
		// The admitting half, asserted beside it so a future change cannot buy the
		// exclusion by giving up real mentions — the two claims stand together.
		const admitted = at("ping @zquser and (@zqother) now", "issue-comment");
		assert.equal(
			admitted.neutralized,
			2,
			"a mention after a space and one after punctuation must both still be caught",
		);
		// The bound's REACH, measured rather than assumed, because the sentence
		// above is easy to read as "an address is safe" and that is not what the
		// pattern says. It excludes an @ after a WORD character, so it protects a
		// local part ending in one and nothing else. These three are addresses by
		// any reader's account and are still wrapped and still counted:
		for (const address of ["ada+@zqexample.com", "ada.@zqexample.com", "ada-@zqexample.com"]) {
			assert.equal(
				at(address, "issue-comment").neutralized,
				1,
				`${address}: this arm records the bound's REACH, not an aspiration. The exclusion is drawn at a word character, so an address whose local part ends in punctuation is severed and counted exactly as a mention would be. If that ever changes, this arm is the one to update — deliberately, with the widening stated`,
			);
		}
	});

	it("the count never carries the text it counted (§3.8's refusal-record rule)", () => {
		const at = requireBoundary("count shape");
		const out = at("ping @someone about GH-4", "pr-comment");
		assert.equal(typeof out.neutralized, "number", "the report is a count, not a list");
		assert.equal(out.neutralized, 2, "two shapes were made inert");
	});

	it("the count is WRAPS APPLIED, and both grounds for the difference are pinned", () => {
		// A DECISION, not an accident, and pinned here so it cannot drift into
		// one. The number is transformations applied, never distinct references,
		// because the two cases below can only be told apart by machinery this
		// module deliberately does not have.
		const at = requireBoundary("count semantics");
		// (1) Already inert. The neutralizer does not parse markdown — by
		// design, since a parser is a second reader of the body — so it cannot
		// see that this span is a code span already, and wraps it again. The
		// wrap is harmless; the count reports it.
		assert.equal(
			at("`Closes #4`", "issue-comment").neutralized,
			1,
			"an already-inert span stopped being counted: telling it from a live one needs a markdown parser, which this module does not have and must not grow",
		);
		// (2) One reference, more than one pass. The URL pass wraps the whole
		// link, and any narrower pattern then matches INSIDE that wrap. The module
		// header already records the double wrap and its inert-erring result; what
		// these three inputs fix is that the COUNT says what the pass count is.
		//
		// Three inputs and not one, because the ground is a class rather than a
		// shape: an enumeration of shapes is what SPEC §3.3 and the call site were
		// carrying, and it was not exhaustive. The third input is its falsifier.
		for (const [text, passes] of [
			["see https://github.com/@zqu/r/issues/4", 2],
			["see https://github.com/o/r/GH-4/issues/9", 2],
			["see https://github.com/@zq/GH-4/issues/9", 3],
		] as const) {
			assert.equal(
				at(text, "issue-comment").neutralized,
				passes,
				`${JSON.stringify(text)}: the nested-wrap count moved. One reference draws one pass per narrower pattern that matches inside the wrap, and the number is wraps applied — a report that counted references instead would need a second reader of the body`,
			);
		}
	});
});

describe("five load-bearing pattern elements, each pinned in isolation (issue #140)", () => {
	// Each input violates exactly one element of one wrap pattern and
	// nothing else, so a weakened element reds its own arm rather than a
	// neighbour's (§3.12). The two directions differ: 1 and 2 are
	// wrong-allow (an actionable reference reaches the platform live), 3–5
	// are over-wrap (a wrap laid over text no reference occupies — crossing
	// an author's own code span in 3, splitting an identifier mid-token in
	// 4, and in all three counting a wrap where no reference was).
	it("the URL form's scheme matches the unencrypted spelling too", () => {
		// The platform resolves an http:// issue URL to the issue (measured
		// via the markdown render API: linked with an issue hovercard,
		// though without the shortened issue-link treatment the https form
		// gets), so the pattern deliberately stays wide in the fail-closed
		// direction and this arm keeps it there.
		const at = requireBoundary("url scheme");
		const out = at("see http://github.com/zqo/zqr/issues/4", "issue-comment");
		assert.equal(
			out.neutralized,
			1,
			"an unencrypted issue URL was not made inert — a scheme-strict pattern lets the http spelling reach the platform as a live, resolvable reference",
		);
		assert.equal(
			out.text,
			"see ` http://github.com/zqo/zqr/issues/4 `",
			"the whole URL must sit inside the wrap — a partial cover counts a neutralization while leaving a live fragment outside it",
		);
	});

	it("the URL form reaches pull-request URLs, not only issues", () => {
		// Measured via the markdown render API: a /pull/N URL gets the
		// platform's full issue-link reference treatment (shortened to #N),
		// so a pattern without the alternation publishes a live reference.
		const at = requireBoundary("url pull alternation");
		const out = at("see https://github.com/zqo/zqr/pull/4", "issue-comment");
		assert.equal(
			out.neutralized,
			1,
			"a pull-request URL was not made inert — dropping the pull alternative lets an actionable PR reference reach the platform live",
		);
		assert.equal(
			out.text,
			"see ` https://github.com/zqo/zqr/pull/4 `",
			"the whole URL must sit inside the wrap — a partial cover counts a neutralization while leaving a live fragment outside it",
		);
	});

	it("the URL form's backtick exclusion stops a wrap from crossing a body backtick", () => {
		// The exclusion sits mid-pattern: it bites only when the backtick
		// precedes the trailing /issues/N segment, which is why this input
		// puts it there and why a casual probe finds the element unkillable.
		const at = requireBoundary("url backtick exclusion");
		const input = "`code https://github.com/zqo/zqr`x/issues/4 more` end";
		const out = at(input, "issue-comment");
		assert.equal(
			out.neutralized,
			0,
			"a matched run containing a backtick was wrapped — the wrap then crosses the author's own code-span boundary, and CommonMark's equal-length pairing makes the author's span and the wrap interleave rather than nest, so the closing delimiter pairs with nothing and the caller's bytes carry a wrap that forms no span, counted as a neutralization the text never owed",
		);
		assert.equal(out.text, input, "the body must pass through unmodified when nothing matches");
	});

	it("the cross-repository form starts at a word boundary, never inside a word", () => {
		const at = requireBoundary("cross-repo leading boundary");
		for (const input of ["_zqowner/zqrepo#4", "zq_owner/zqrepo#4"]) {
			const out = at(input, "issue-comment");
			assert.equal(
				out.neutralized,
				0,
				`${JSON.stringify(input)}: a span inside a word was wrapped — without the leading boundary the wrap splits an identifier mid-token and reports a reference where the platform sees none`,
			);
			assert.equal(out.text, input, "the body must pass through unmodified when nothing matches");
		}
	});

	it("the cross-repository form requires at least one digit after the hash", () => {
		const at = requireBoundary("cross-repo digit quantifier");
		const input = "ref zqowner/zqrepo#";
		const out = at(input, "issue-comment");
		assert.equal(
			out.neutralized,
			0,
			"a bare trailing hash was wrapped — a starred quantifier turns a non-reference into a counted wrap, corrupting the caller's bytes for a shape the platform never links",
		);
		assert.equal(out.text, input, "the body must pass through unmodified when nothing matches");
	});
});

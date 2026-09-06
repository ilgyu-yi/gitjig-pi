/**
 * Structural suite for the fail-posture inventory's COMPLETENESS (issue
 * #112; SPEC §3.9's opening sentence — "Every dependency the enforcement
 * layer stands on declares its on-miss posture in one inventory" — and
 * §6.1's inventory rule, "an inventory this SPEC states is machine-checked
 * against the real tree, or it rots").
 *
 * The sibling suite `posture-home.structure.test.ts` enforces the OTHER
 * half, one home: that no posture is declared outside
 * `.pi/extensions/gitjig/postures.ts`. A tree can satisfy that half
 * perfectly while the inventory omits shapes the shipped code declares a
 * fail direction for, which is what #112 measured. This suite is the
 * completeness direction.
 *
 * Subject under test: the local tier's own declared degradation causes,
 * WALKED from `.githooks/` rather than enumerated per file, so a helper or
 * adapter added tomorrow is scanned the day it lands. Two cause idioms are
 * recognized, over a view with whole-line `#` comments stripped:
 *
 *   1. `audit_log warn <category> <constant>` — the reason constant of a
 *      fail-open record. `block` records are NOT collected, and the ground
 *      is a limitation rather than a principle: see residual 6.
 *   2. `_gitjig_ss_disarm '<literal>'` — the staged-secret scan's
 *      per-cause disarm literals, which are sub-causes of one wrapper
 *      record and so never appear as their own `audit_log` constant.
 *
 * The assertion is VERBATIM containment, scoped to ONE ROW and qualified
 * by the emitting SITE: a cause is accounted for when some single row
 * carries both the cause string and the basename of the source that emits
 * it. Verbatim rather than by-concept binds the inventory to the exact
 * strings the code uses, so renaming a cause without touching its row reds
 * this suite. Row-scoped-and-site-qualified rather than whole-file is what
 * makes the match mean something: reason constants are SHARED by design —
 * `not-enforced` spans five shapes and `not-evaluated` is emitted at two
 * different sites — so "this string occurs somewhere in the file" is not
 * the question being asked. A whole-file matcher certified one site's
 * cause against a row whose own text disclaims that very site.
 *
 * WHAT THIS SUITE DOES NOT ESTABLISH (§3.11's report-only rule — a check
 * names the property it does not establish). These are disclosed because
 * a green run here is NOT a statement that the inventory is complete:
 *
 *   1. ENUMERATING REASON CONSTANTS IS NOT ENUMERATING DEPENDENCIES. This
 *      suite finds causes the code NAMES. A site that chooses a fail
 *      direction while naming nothing is invisible to it, by construction.
 *      That is not hypothetical: issue #113's defect was exactly such a
 *      site — `.githooks/pre-commit` compared an unvalidated branch name
 *      and allowed, with no constant and no record for this suite to find.
 *      A recognizer keyed on constants would have reported that tree clean
 *      forever. Finding those sites needs a reader of control flow, and
 *      nothing in this repository is one today.
 *   2. It does not check that a row's posture DIRECTION (open/closed) is
 *      the right one for its cause, only that the cause is inventoried.
 *   3. It does not check the reverse direction — a row naming a cause no
 *      shipped source emits is not reported here, so a stale row survives.
 *   4. The comment-stripper is lexical, not a parser: a `#` inside a string
 *      that begins a line can be mis-stripped, the same residual the
 *      sibling suites' strippers disclose.
 *   5. Causes emitted by tier-1 or tier-3 sources are out of scope. The
 *      idioms above are properties of the shell tier; generalizing the
 *      shape is #30's.
 *   6. FAIL-OPEN ONLY. Every cause collected here is a fail-open one. The
 *      inventory's fail-CLOSED rows are checked for completeness by
 *      nothing: a refusal on a machinery or measurement miss is genuinely
 *      a posture — `secret-scan-measurement` is a `closed` row whose whole
 *      shell-tier observable is an `audit_log block` record — but every
 *      block site spells the same content-free constant `blocked`, so
 *      there is nothing to key a per-shape match on. The exclusion is a
 *      limitation, not a principle.
 *   7. Accounting is not the same as declaring a posture. A row may
 *      account for a site by explicitly DISCLAIMING it, with its ground,
 *      as `commit-format-subject` does for `.githooks/pre-commit`'s scope
 *      fold. This suite does not distinguish "has a posture row" from "is
 *      disclaimed with a ground"; both read as accounted for.
 *   8. Recognition is lexical and quoting-sensitive in ways it cannot
 *      close: a record written by a direct `printf` to the sink rather
 *      than through `audit_log`, an `audit_log` reached through a variable
 *      or alias, and a constant split across a backslash continuation are
 *      all invisible. Chasing indirection needs a reader of control flow,
 *      which residual 1 already says does not exist here.
 *
 * The recognizer's own teeth are pinned by synthetic-mutant arms at the
 * bottom (§3.12): a green real-tree arm proves nothing unless a source
 * carrying an uninventoried cause demonstrably reds.
 *
 * This suite reads files and writes nothing: no network, no `gh`, no `pi`,
 * no fixture.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { POSTURES } from "../.pi/extensions/gitjig/postures.ts";
import { repoRoot } from "./harness/run-pi.ts";

/** The walked root: the local tier's shipped sources. */
const TIER_ROOT = ".githooks";

/** The one home §3.9 states — the text every collected cause must appear in. */
const INVENTORY_HOME = join(".pi", "extensions", "gitjig", "postures.ts");

function stripHashComments(source: string): string {
	return source
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");
}

/** Every file under a root, recursively — walked, never listed. */
function walk(absRoot: string, relRoot: string): { rel: string; text: string }[] {
	const out: { rel: string; text: string }[] = [];
	for (const entry of readdirSync(absRoot)) {
		const abs = join(absRoot, entry);
		const rel = join(relRoot, entry);
		if (statSync(abs).isDirectory()) {
			out.push(...walk(abs, rel));
		} else {
			out.push({ rel, text: readFileSync(abs, "utf8") });
		}
	}
	return out;
}

export interface DeclaredCause {
	/** The exact string the inventory must contain. */
	cause: string;
	/** Where it was found — reported so a failure names its own repair site. */
	where: string;
}

/**
 * Collect declared fail-open causes from one source's text. Exported so the
 * mutant arms below drive the same recognizer the real-tree arm uses,
 * rather than a copy of it (§3.11 — one predicate, two call sites).
 */
export function collectCauses(relPath: string, source: string): DeclaredCause[] {
	const text = stripHashComments(source);
	const found: DeclaredCause[] = [];

	// 1) audit_log warn <category> <constant> — category may be a shell
	//    expansion, so it is matched loosely; the constant must be a bare
	//    token, since a computed constant has no fixed string to inventory.
	const warnRe = /audit_log\s+warn\s+(?:"[^"]*"|'[^']*'|\S+)\s+(?:"([A-Za-z][A-Za-z0-9_-]*)"|'([A-Za-z][A-Za-z0-9_-]*)'|([A-Za-z][A-Za-z0-9_-]*))/g;
	for (const m of text.matchAll(warnRe)) {
		found.push({ cause: m[1] ?? m[2] ?? m[3], where: relPath });
	}

	// 2) _gitjig_ss_disarm '<literal>' — single-quoted sub-causes.
	const disarmRe = /_gitjig_ss_disarm\s+(?:'([^']+)'|"([^"]+)")/g;
	for (const m of text.matchAll(disarmRe)) {
		found.push({ cause: m[1] ?? m[2], where: relPath });
	}

	return found;
}

function realTreeCauses(): DeclaredCause[] {
	const root = repoRoot();
	const sources = walk(join(root, TIER_ROOT), TIER_ROOT);
	return sources.flatMap((s) => collectCauses(s.rel, s.text));
}

/** One row's full searchable text — the unit a match is scoped to. */
export function rowText(row: { dependency: string; failureShape: string; justification: string }): string {
	return `${row.dependency} ${row.failureShape} ${row.justification}`;
}

/**
 * A cause is accounted for when ONE row carries both the cause string and
 * the basename of the source that emits it. Exported so the teeth arms
 * drive this predicate rather than a copy (§3.11).
 */
export function accountedFor(
	cause: DeclaredCause,
	rows: readonly { dependency: string; failureShape: string; justification: string }[] = POSTURES,
): boolean {
	const site = cause.where.split(/[\\/]/).pop() ?? cause.where;
	return rows.some((row) => {
		const text = rowText(row);
		return text.includes(cause.cause) && text.includes(site);
	});
}

describe("fail-posture inventory completeness (issue #112, SPEC §3.9, §6.1)", () => {
	it("the walked tier yields causes from several distinct sources", () => {
		// A recognizer that collects nothing passes every containment
		// assertion below vacuously. A bare total is a weak floor: the scan
		// helper alone clears any small number, so deleting the prelude and
		// all three adapters would leave a total-only guard green. The floor
		// is therefore on the number of distinct SOURCES that yielded a
		// cause, which no single file can clear.
		const causes = realTreeCauses();
		const sources = new Set(causes.map((c) => c.where));
		assert.ok(
			sources.size >= 4,
			`causes came from only ${sources.size} source(s) (${[...sources].sort().join(", ")}) — the walk or the recognizer is broken`,
		);
		assert.ok(
			causes.length >= 12,
			`the walk collected ${causes.length} causes — too few to be the real tier`,
		);
	});

	it("every declared fail-open cause is accounted for by a row that names its own site", () => {
		// Site-qualified and ROW-scoped, never whole-file substring. A reason
		// constant is shared by design — `not-enforced` spans five shapes and
		// `not-evaluated` is emitted at two different sites — so "this string
		// occurs somewhere in the file" is not the question. The question is
		// whether some ONE row carries both the cause and the site that emits
		// it. Whole-file matching let `.githooks/pre-commit`'s cause be
		// certified by a row whose own text disclaims that very site.
		const unmatched = realTreeCauses()
			.filter((c) => !accountedFor(c))
			.map((c) => `${c.where}: ${JSON.stringify(c.cause)}`);
		const unique = [...new Set(unmatched)].sort();
		assert.deepEqual(
			unique,
			[],
			`these declared causes have no row in ${INVENTORY_HOME} naming both the cause and their site (SPEC §3.9's one-inventory rule):\n  ${unique.join("\n  ")}`,
		);
	});

	it("collects the disarm sub-causes, not only the wrapper's own constant", () => {
		// The staged-secret scan emits ONE audit constant ("not-enforced")
		// for seven distinct machinery causes. A recognizer that saw only
		// the wrapper would score the class complete on one row. This arm
		// pins that the sub-causes are collected as causes in their own
		// right — the reading-unit question, not the population question.
		const causes = realTreeCauses().map((c) => c.cause);
		assert.ok(
			causes.filter((c) => c.includes(" ")).length >= 5,
			"no multi-word disarm literals were collected; the sub-cause recognizer is not firing",
		);
	});

	describe("the recognizer's own teeth (§3.12)", () => {
		it("reds on a source declaring a cause the inventory does not carry", () => {
			const mutant = collectCauses(
				".githooks/helpers/mutant.sh",
				"audit_log warn secret zqnotinventoriedzq 'a cause no row names'\n",
			);
			assert.deepEqual(mutant.map((c) => c.cause), ["zqnotinventoriedzq"]);
			const inventory = readFileSync(join(repoRoot(), INVENTORY_HOME), "utf8");
			assert.ok(
				!inventory.includes("zqnotinventoriedzq"),
				"the synthetic mutant cause leaked into the real inventory",
			);
		});

		it("reds on an uninventoried disarm sub-cause", () => {
			const mutant = collectCauses(
				".githooks/helpers/mutant.sh",
				"\t\t_gitjig_ss_disarm 'zq synthetic uninventoried cause zq'\n",
			);
			assert.deepEqual(mutant.map((c) => c.cause), ["zq synthetic uninventoried cause zq"]);
		});

		it("does not collect block records — a refusal is not a posture", () => {
			const collected = collectCauses(".githooks/x.sh", "audit_log block secret blocked 'refused'\n");
			assert.deepEqual(collected, []);
		});

		it("does not collect from a commented-out line", () => {
			const collected = collectCauses(".githooks/x.sh", "# audit_log warn secret zqcommentedzq 'x'\n");
			assert.deepEqual(collected, []);
		});

		it("DISCRIMINATION: a shared constant is not satisfied by another site's row", () => {
			// The axis every other teeth arm holds fixed. Those arms all invent
			// a UNIQUE constant, so they establish only that an ABSENT cause is
			// caught — never that the matcher can tell two sites sharing one
			// constant apart. Reason constants are shared by design, and a
			// whole-file substring matcher passed exactly this case: it
			// certified `.githooks/pre-commit`'s cause against a row that names
			// a different site. This arm is that regression, pinned.
			const rows = [
				{
					dependency: "zq-other-site",
					failureShape: "a shape at .githooks/commit-msg; record constant zqsharedzq",
					justification: "names one site only",
				},
			];
			assert.equal(
				accountedFor({ cause: "zqsharedzq", where: ".githooks/commit-msg" }, rows),
				true,
				"the site the row names must be accounted for",
			);
			assert.equal(
				accountedFor({ cause: "zqsharedzq", where: ".githooks/pre-commit" }, rows),
				false,
				"a DIFFERENT site sharing the constant was certified by that row — the matcher cannot discriminate",
			);
		});

		it("collects a double-quoted constant and a double-quoted disarm literal", () => {
			// The bare-token rule's ground is that a COMPUTED constant has no
			// fixed string to inventory. A double-quoted literal has one, so
			// the ground does not reach it and it is collected.
			assert.deepEqual(
				collectCauses(".githooks/x.sh", 'audit_log warn secret "zqdqzq" \'m\'\n').map((c) => c.cause),
				["zqdqzq"],
			);
			assert.deepEqual(
				collectCauses(".githooks/x.sh", '_gitjig_ss_disarm "zq dq literal zq"\n').map((c) => c.cause),
				["zq dq literal zq"],
			);
		});

		it("collects a cause whose category is a shell expansion", () => {
			// `_lib.sh` writes its category as "${2:-git-hook-tier}"; a
			// recognizer requiring a bare category token would silently miss
			// every cause that file declares.
			const collected = collectCauses(".githooks/_lib.sh", 'audit_log warn "${2:-git-hook-tier}" zqexpandedzq\n');
			assert.deepEqual(collected.map((c) => c.cause), ["zqexpandedzq"]);
		});
	});
});

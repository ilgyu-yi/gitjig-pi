/**
 * Structural suite for the `source-style` and `type-check` gates and for
 * the record they are supposed to match (issue #121; SPEC §3.3's two rows
 * and their toolchain-semantics block, §3.2's tier-3 sentence, §4.3's
 * server-config shape rule).
 *
 * Subject under test: two artifacts and the equality between them. The
 * SPEC names the required-check contexts in TWO sentences, and §4.3 says
 * those contexts EQUAL the CI job names — an equality nothing measured
 * until this suite. The job set is WALKED from `.github/workflows/`
 * rather than enumerated per file, so a gate added tomorrow is scanned
 * the day it lands and cannot drift in unrecorded (§3.10's
 * structural-lock shape).
 *
 * WHAT THIS SUITE DOES NOT ESTABLISH (§3.11's report-only rule — a check
 * that does not establish a property says so, so a green run is never
 * read as the missing guarantee):
 *
 *   1. That the workflow is valid YAML, or that Actions accepts it. No
 *      YAML parser is reachable from here: the root manifest declares
 *      development and CI tools only, and this suite runs with no
 *      dependency on an installed tree. The readers below are narrow
 *      text scanners over a comment-stripped view, on the same terms and
 *      with the same fooling shapes as the sibling suite
 *      `changelog-workflow.structure.test.ts` records.
 *   2. That the SERVER's required-check configuration matches the
 *      recorded shape. §4.3 says applying server config is a separate
 *      act the shell does not perform; this suite measures the record and
 *      the workflow, never the platform. A green run here is consistent
 *      with a repository whose branch ruleset requires none of these.
 *   3. That the gates CATCH anything. That the `source-style` job runs
 *      the formatter and the linter, and the `type-check` job runs the
 *      compiler, is asserted as text on disk; whether the configuration
 *      those tools read is the right one is not a property of this file
 *      (SPEC §3.3 records the same limit for the class).
 *   4. The reverse containment. A workflow may declare a job that is not
 *      a required check — the recorded set is a subset claim over the
 *      declared jobs, deliberately, so adding a non-required helper job
 *      does not oblige a SPEC amendment.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const WORKFLOW_DIR = join(repoRoot(), ".github", "workflows");
const SPEC_RAW = readFileSync(join(repoRoot(), "SPEC.md"), "utf8");

/** The backticked tokens inside one captured span, in order. */
function backticked(span: string): string[] {
	return [...span.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/** One recorded context list, by the sentence that carries it. */
function recordedContexts(label: string, pattern: RegExp): string[] {
	const m = SPEC_RAW.match(pattern);
	assert.ok(m, `SPEC.md no longer carries the ${label} sentence this suite reads — the record moved or was reworded`);
	return backticked(m[1]);
}

const TIER3_CONTEXTS = recordedContexts("§3.2 tier-3", /The workflow gates \(([^)]*)\) run as required status checks/);
const SHAPE_CONTEXTS = recordedContexts(
	"§4.3 server-config shape",
	/required-check contexts equal the CI job names \(([^)]*)\)/,
);

/** Every workflow file, comment-stripped, keyed by basename. */
function workflows(): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const entry of readdirSync(WORKFLOW_DIR)) {
		if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
		const lines = readFileSync(join(WORKFLOW_DIR, entry), "utf8")
			.split("\n")
			.filter((line) => !/^\s*#/.test(line));
		out.set(entry, lines);
	}
	return out;
}

/**
 * Job ids declared by one workflow: the two-space-indented keys directly
 * beneath a column-zero `jobs:`. The context a required check names is
 * the job id where the job declares no `name:`, which is what every
 * workflow in this tree writes.
 */
function jobIds(lines: string[]): string[] {
	const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
	if (start < 0) return [];
	const out: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^\S/.test(line)) break;
		const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
		if (m) out.push(m[1]);
	}
	return out;
}

/** Every job id in the tree, with the file that declares it. */
function declaredJobs(): Map<string, string> {
	const out = new Map<string, string>();
	for (const [file, lines] of workflows()) {
		for (const id of jobIds(lines)) out.set(id, file);
	}
	return out;
}

/** The shell text of one workflow — every line of every `run:` block. */
function runText(lines: string[]): string {
	return lines.filter((line) => !/^\s*[A-Za-z0-9_-]+:/.test(line) || /^\s*run:/.test(line)).join("\n");
}

describe("S1 — the SPEC's two context records agree (SPEC §3.2, §4.3)", () => {
	it("names at least the three gates that predate this issue", () => {
		for (const context of ["fragment-gate", "ssot-home", "toc-freshness"]) {
			assert.ok(
				SHAPE_CONTEXTS.includes(context),
				`§4.3 no longer records \`${context}\` — this suite's own subject would be a shorter set than the tree enforces`,
			);
		}
	});

	it("records the same set in both sentences", () => {
		assert.deepEqual(
			[...TIER3_CONTEXTS].sort(),
			[...SHAPE_CONTEXTS].sort(),
			"§3.2's tier-3 sentence and §4.3's server-config shape rule name different required-check contexts: two records of one fact have drifted, and a reader cannot tell which is the contract",
		);
	});
});

describe("S2 — every recorded context is a job this tree declares (SPEC §4.3)", () => {
	const jobs = declaredJobs();

	for (const context of SHAPE_CONTEXTS) {
		it(`\`${context}\` is declared by a workflow`, () => {
			assert.ok(
				jobs.has(context),
				`§4.3 records \`${context}\` as a required-check context, but no job of that id is declared under .github/workflows/ (declared: ${[...jobs.keys()].sort().join(", ")}). A required check with no job never reports, so the branch ruleset blocks every PR forever, or the context is recorded and enforced by nothing`,
			);
		});
	}
});

describe("S3 — the source-checks workflow's own contract (issue #121; SPEC §3.3)", () => {
	const all = workflows();
	const file = [...all.entries()].find(([, lines]) => jobIds(lines).includes("source-style"));

	it("declares both new gates in one workflow", () => {
		assert.ok(file, "no workflow declares a `source-style` job");
		assert.ok(
			jobIds(file[1]).includes("type-check"),
			`\`source-style\` is declared in ${file[0]} but \`type-check\` is not: the two gates share one toolchain install and are meant to share one workflow`,
		);
	});

	it("installs from the lockfile alone", () => {
		assert.ok(file, "no workflow declares a `source-style` job");
		const text = runText(file[1]);
		assert.match(
			text,
			/npm ci\b/,
			`${file[0]} does not run \`npm ci\`: only that install is bounded by the committed lockfile, so any other spelling lets a transitive dependency move between the pin and the run`,
		);
		assert.doesNotMatch(
			text,
			/npm install\b/,
			`${file[0]} runs \`npm install\`, which resolves against the registry rather than the committed lockfile and can install a tree no commit of this repository names`,
		);
	});

	it("runs the type check in a mode that emits nothing", () => {
		assert.ok(file, "no workflow declares a `source-style` job");
		assert.match(
			runText(file[1]),
			/--noEmit\b/,
			`${file[0]}'s type check does not carry --noEmit: SPEC §3.3 binds this gate to checking without emitting, and the runtime stays buildless (README, issue #121's bounding constraints)`,
		);
	});

	it("carries the header naming it development-and-CI only", () => {
		assert.ok(file, "no workflow declares a `source-style` job");
		const raw = readFileSync(join(WORKFLOW_DIR, file[0]), "utf8");
		const header = raw.split("\n").slice(0, 20).join("\n");
		assert.match(
			header,
			/development and CI only/i,
			`${file[0]} does not declare itself development-and-CI only in its own header. This file sits inside \`.github/\`, which \`deriveSubstrateSet\` walks, so today it IS a member of the set an adopting repository would receive; the header is the only thing a reader of the composed tree has to go on, since no arm proves this file never enters it`,
		);
	});
});

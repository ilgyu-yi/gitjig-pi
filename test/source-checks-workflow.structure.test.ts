/**
 * Structural suite for the `source-style` and `type-check` gates and for
 * the record they are supposed to match (issues #121 and #328; SPEC
 * §3.3's two rows and their toolchain-semantics block, §3.9's posture
 * inventory, and §4.3's measured server-config shape rule).
 *
 * Subject under test: the target-owned selected context list, §4.3's
 * measured source-instance record, the posture row covering checkout at
 * every required gate, and the workflow jobs that report those contexts.
 * The job set is WALKED from `.github/workflows/` rather than enumerated
 * per file, so a gate added tomorrow is scanned the day it lands and
 * cannot drift in unrecorded (§3.10's structural-lock shape).
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
 *      target-owned selection and recorded shape. §4.3 says applying
 *      server config is a separate act the shell does not perform; this
 *      suite measures committed artifacts, never the platform. A green
 *      run here is consistent with a repository whose branch ruleset
 *      requires none of these.
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
import { POSTURES } from "../.pi/extensions/gitjig/postures.ts";
import { repoRoot } from "./harness/run-pi.ts";

const ROOT = repoRoot();
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");
const SPEC_RAW = readFileSync(join(ROOT, "SPEC.md"), "utf8");
const GOVERNANCE_CONFIG = JSON.parse(readFileSync(join(ROOT, ".github", "gitjig-governance.json"), "utf8"));

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

const SHAPE_CONTEXTS = recordedContexts(
	"§4.3 measured source profile",
	/Current source required-check contexts equal the selected config and CI job names \(([^)]*)\)/,
);
const CONFIG_CONTEXTS = GOVERNANCE_CONFIG.capabilities.requiredStatusChecks.value.map(
	(entry: { context: string }) => entry.context,
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

describe("S1 — §4.3's measured source profile matches the target-owned selection", () => {
	it("records exactly the selected config contexts, including history-shape", () => {
		assert.deepEqual(
			[...SHAPE_CONTEXTS].sort(),
			[...CONFIG_CONTEXTS].sort(),
			"§4.3's present-tense source profile and .github/gitjig-governance.json select different required-check contexts",
		);
		assert.ok(SHAPE_CONTEXTS.includes("history-shape"), "the measured source profile omits `history-shape`");
	});

	it("the checkout-machinery posture names every selected required gate", () => {
		const row = POSTURES.find((candidate) => candidate.dependency === "ci-gate-machinery");
		assert.ok(row, "the fail-posture inventory has no ci-gate-machinery row");
		for (const context of CONFIG_CONTEXTS) {
			assert.match(
				row.failureShape,
				new RegExp(`(?:^|[^A-Za-z0-9_-])${context}(?:$|[^A-Za-z0-9_-])`),
				`the ci-gate-machinery row's any-required-gate population omits ${context}`,
			);
		}
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

	it("carries the exact source-only declaration at the classifier's legal position", () => {
		assert.ok(file, "no workflow declares a `source-style` job");
		const raw = readFileSync(join(WORKFLOW_DIR, file[0]), "utf8");
		assert.equal(
			raw.split(/\r?\n/, 1)[0],
			"# gitjig: source-only",
			`${file[0]} is development-only but lacks §4.1's exact first-line source-only declaration`,
		);
	});
});

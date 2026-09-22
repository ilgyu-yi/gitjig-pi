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
	/Current source required-check contexts equal the selected config \(([^)]*)\), and each is emitted by a CI job of the same name/,
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

/** One workflow job and any immediate display-name override. */
interface JobDeclaration {
	id: string;
	name?: string;
}

/**
 * Jobs declared beneath a column-zero `jobs:`. Only an immediate
 * four-space `name:` belongs to the job; nested step names do not.
 */
function jobDeclarations(lines: string[]): JobDeclaration[] {
	const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
	if (start < 0) return [];
	const out: JobDeclaration[] = [];
	let current: JobDeclaration | undefined;
	for (const line of lines.slice(start + 1)) {
		if (/^\S/.test(line)) break;
		const job = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
		if (job) {
			current = { id: job[1] };
			out.push(current);
			continue;
		}
		const name = line.match(/^ {4}name:\s*(\S(?:.*\S)?)\s*$/);
		if (current && name) current.name = name[1];
	}
	return out;
}

/** Every job id in the tree, with its file and display-name override. */
function declaredJobs(): Map<string, { file: string; name?: string }> {
	const out = new Map<string, { file: string; name?: string }>();
	for (const [file, lines] of workflows()) {
		for (const job of jobDeclarations(lines)) out.set(job.id, { file, name: job.name });
	}
	return out;
}

function requiredGatePopulation(failureShape: string): string[] {
	const match = failureShape.match(/any required gate — (.*?) — or actions\/setup-node/);
	assert.ok(match, "ci-gate-machinery no longer carries a bounded any-required-gate clause");
	return match[1].split(",").map((context) => context.trim());
}

function installGatePopulation(failureShape: string): string[] {
	const match = failureShape.match(/committed lockfile .* at (.*?), the gates that install anything/);
	assert.ok(match, "ci-gate-machinery no longer carries a bounded install-gate clause");
	return match[1]
		.replace(", or ", ", ")
		.split(",")
		.map((context) => context.trim());
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

	it("the checkout-machinery posture names exactly the selected required gates", () => {
		const row = POSTURES.find((candidate) => candidate.dependency === "ci-gate-machinery");
		assert.ok(row, "the fail-posture inventory has no ci-gate-machinery row");
		assert.deepEqual(
			[...requiredGatePopulation(row.failureShape)].sort(),
			[...CONFIG_CONTEXTS].sort(),
			"the ci-gate-machinery row's bounded any-required-gate population differs from the selected contexts",
		);
		assert.deepEqual(installGatePopulation(row.failureShape), ["source-style", "type-check", "suite"]);

		const deletionMutant = row.failureShape.replace("source-style, type-check, suite, history-shape", "history-shape");
		assert.notDeepEqual(
			[...requiredGatePopulation(deletionMutant)].sort(),
			[...CONFIG_CONTEXTS].sort(),
			"deleting duplicated install-gate tokens from the any-required-gate clause must be observable",
		);
	});
});

describe("S2 — every recorded context is a job this tree declares (SPEC §4.3)", () => {
	const jobs = declaredJobs();

	it("detects a job-level display-name override in the immediate mapping", () => {
		assert.deepEqual(jobDeclarations(["jobs:", "  history-shape:", "    name: renamed-check"]), [
			{ id: "history-shape", name: "renamed-check" },
		]);
	});

	for (const context of SHAPE_CONTEXTS) {
		it(`\`${context}\` is emitted by a same-named workflow job`, () => {
			const job = jobs.get(context);
			assert.ok(
				job,
				`§4.3 records \`${context}\` as a required-check context, but no job of that id is declared under .github/workflows/ (declared: ${[...jobs.keys()].sort().join(", ")}). A required check with no job never reports, so the branch ruleset blocks every PR forever, or the context is recorded and enforced by nothing`,
			);
			assert.equal(
				job.name,
				undefined,
				`${job.file} overrides job \`${context}\` with display name ${job.name}; the configured context will not be emitted under its selected name`,
			);
		});
	}
});

describe("S3 — the source-checks workflow's own contract (issue #121; SPEC §3.3)", () => {
	const all = workflows();
	const file = [...all.entries()].find(([, lines]) => jobDeclarations(lines).some((job) => job.id === "source-style"));

	it("declares both new gates in one workflow", () => {
		assert.ok(file, "no workflow declares a `source-style` job");
		assert.ok(
			jobDeclarations(file[1]).some((job) => job.id === "type-check"),
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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const spec = readFileSync(join(repoRoot(), "SPEC.md"), "utf8");

function section(heading: string, nextHeading: string): string {
	const start = spec.indexOf(heading);
	const end = spec.indexOf(nextHeading, start + heading.length);
	assert.ok(start >= 0 && end > start, `SPEC section bounds are missing: ${heading} -> ${nextHeading}`);
	return spec.slice(start, end);
}

const crossReview = section("### 1.4 Cross-review repair", "### 1.5 Delegated work");
const modes = section("### 5.6 Operating modes", "### 5.7 Unattended conduct");
const unattended = section("### 5.7 Unattended conduct", "### 5.8 Context lifecycle");

describe("the orthogonal decision-mode settlement (#237)", () => {
	it("names two independently resolved axes and all four combinations", () => {
		for (const token of [
			"Execution mode",
			"Decision mode",
			"`attended + handoff`",
			"`attended + autonomous`",
			"`unattended + handoff`",
			"`unattended + autonomous`",
		]) {
			assert.ok(modes.includes(token), `the operating-mode contract dropped ${token}`);
		}
		assert.ok(
			modes.includes("Execution mode alone governs ready and merge") &&
				modes.includes("decision mode alone chooses the consumer"),
			"the two axes no longer have disjoint decisions",
		);
	});

	it("defaults unknown values toward human control and leaves one project-value home", () => {
		assert.ok(modes.includes("`attended` — the default"), "execution mode lost its attended default");
		assert.ok(modes.includes("`handoff` — the default"), "decision mode lost its handoff default");
		assert.ok(
			modes.includes("invocation-scoped override, then the environment, then the one per-project state home #228"),
			"the resolution order or #228's single project-value home drifted",
		);
		assert.ok(
			modes.includes("execution value falls toward `attended`") && modes.includes("decision value toward `handoff`"),
			"an unknown mode no longer fails toward human control",
		);
	});

	it("makes recovery a durable one-use allowance that restarts cannot replenish", () => {
		for (const token of [
			"One allowance exists per stable change lineage",
			"atomically changes it from `available` to `claimed`",
			"claim, crash, invalid return, or unavailable actor consumes it",
			"no later event resets it for that change",
			"A second recovery request parks",
		]) {
			assert.ok(crossReview.includes(token), `the one-use recovery bound dropped: ${token}`);
		}
	});

	it("keeps the recovery record closed and outside the acting author's control", () => {
		for (const token of [
			"allowance state `available | claimed | consumed`",
			"terminal `continue | park`",
			"The acting author cannot write, clear, or satisfy this record",
			"Missing, unknown, duplicate, or misaligned fields park",
		]) {
			assert.ok(crossReview.includes(token), `the recovery-record contract dropped: ${token}`);
		}
	});

	it("gives each non-NONE diagnosis its bounded intervention", () => {
		assert.ok(crossReview.includes("**STAGNATION** runs a mutually blind §1.8-shaped contest over methods"));
		assert.ok(crossReview.includes("**OSCILLATION** uses the diagnosis only to identify the opposed adjudications"));
		assert.ok(crossReview.includes("a semantic rereading is not §1.9 new evidence"));
		assert.ok(crossReview.includes("exactly one non-mutating discriminating measurement"));
		assert.ok(
			crossReview.includes("**INDETERMINATE** independently selects and runs one bounded non-mutating measurement"),
		);
		assert.ok(crossReview.includes("then re-dispatches the history Judge once"));
	});

	it("admits only one fresh diagnosis and only NONE returns to ordinary flow", () => {
		assert.ok(crossReview.includes("exactly one fresh independent diagnosis"));
		assert.ok(crossReview.includes("NONE returns to ordinary flow under the unchanged execution ceiling"));
		assert.ok(crossReview.includes("every non-NONE, incomplete, invalid, or unavailable result parks"));
	});

	it("keeps invalidation as the sole re-entry selector", () => {
		assert.ok(
			crossReview.includes(
				"Which gate** the change re-enters is decided by the ruling's invalidation finding and by nothing else",
			),
		);
		for (const route of [
			"**Nothing invalidated**",
			"**The selected plan is invalidated**",
			"**The authorization is invalidated**",
		])
			assert.ok(crossReview.includes(route), `the planning boundary dropped ${route}`);
	});

	it("does not stack the unattended soft budget or cross non-substitutable boundaries", () => {
		assert.ok(unattended.includes("one intervention spends both rather than stacking attempts"));
		for (const boundary of [
			"Trusted-account attribution",
			"genuinely new authorization",
			"credentials",
			"server configuration",
			"another repository",
			"public or unretractable acts",
		]) {
			assert.ok(unattended.includes(boundary), `the all-mode hard boundary dropped ${boundary}`);
		}
		assert.ok(
			unattended.includes("Autonomous decision mode changes the eligible gate's independent consumer, never the gate"),
		);
	});
});

/**
 * The exit-inside-the-flush-grace race, staged directly (issue #119).
 *
 * The geometry the race needs — a child exit landing inside the
 * (bound − grace, bound) window while an orphan holds the pipes — gives a
 * suite arm at most `grace / 2` of real-time margin, and against the
 * production numbers (10s bound, 2s grace) that is 1s, which machine load
 * consumes: the overnight failure #119 records, reproduced on demand by
 * running the integration suite beside a CPU-saturating load. So the race
 * is proven here instead, through the executor's injected `ChildBounds`
 * seam with margins load cannot plausibly eat (window 1.5s..6s, exit
 * staged at 3s), while the sibling integration suite's orphan-late arm
 * keeps proving the end-to-end grace-path publish through a real session
 * with its child exiting early and its bound margin wide.
 *
 * The mutant this arm exists to redden at: an executor whose kill timer
 * stays armed across the flush grace — `clearTimeout(killTimer)` absent
 * from the exit handler — marks the in-bound exit timed out when the
 * grace outlives the bound, a refusal for a send that landed (§5.6's
 * forbidden false-withholding direction). No harness runs mutants;
 * per §3.12 the kill is verified by hand in a throwaway copy.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runPublishChild } from "../.pi/extensions/gitjig/publish/executor.ts";

const URL_LINE = "https://example.invalid/gitjig/race#issuecomment-119";
const SHAPE = /^https:\/\/[^\s]+#issuecomment-\d+$/;

// Exit at 3s into a 6s bound with a 4.5s grace: the exit sits inside the
// (1.5s, 6s) race window with no edge nearer than 1.5s — against measured
// load jitter of ≤0.35s for this child shape (issue #119's record), where
// the retired 9s-against-10s staging held 1s and flaked.
const BOUNDS = { timeoutMs: 6_000, graceMs: 4_500 };

let shimRoot: string;
let savedPath: string | undefined;

before(() => {
	shimRoot = mkdtempSync(join(tmpdir(), "gitjig-race-"));
	const shim = join(shimRoot, "gh");
	// The orphan (`sleep 15 &`) inherits the pipes and outlives the grace
	// decision at ~7.5s, so "close" cannot decide; only the grace can.
	writeFileSync(shim, `#!/bin/sh\nsleep 15 &\nsleep 3\nprintf '%s\\n' '${URL_LINE}'\nexit 0\n`);
	chmodSync(shim, 0o755);
	mkdirSync(join(shimRoot, "cwd"));
	savedPath = process.env.PATH;
	process.env.PATH = `${shimRoot}:${savedPath ?? ""}`;
});

after(() => {
	if (savedPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = savedPath;
	}
	rmSync(shimRoot, { recursive: true, force: true });
});

describe("a late in-bound exit behind an orphan-held pipe is published, staged at the seam (issue #119)", () => {
	it("the grace decides published; the cleared kill timer never converts the exit into a bound refusal", async () => {
		const backstop = new Promise<never>((_, reject) => {
			const timer = setTimeout(
				() => reject(new Error("race arm: no outcome within 20s — the executor wedged behind the orphan")),
				20_000,
			);
			timer.unref();
		});
		const started = Date.now();
		const outcome = await Promise.race([
			runPublishChild([], "race-arm body", join(shimRoot, "cwd"), SHAPE, BOUNDS),
			backstop,
		]);
		const elapsedMs = Date.now() - started;
		assert.equal(
			outcome.outcome,
			"published",
			`race arm: an exit inside the bound behind an orphan-held pipe was not published — a kill timer left ` +
				`armed across the flush grace refuses a send that landed (§5.6): ${JSON.stringify(outcome)}`,
		);
		assert.equal(outcome.outcome === "published" ? outcome.url : "", URL_LINE);
		// The decision must have come from the grace timer (exit ≈3s plus
		// grace 4.5s), not from an early "close": an orphan that failed to
		// hold the pipes would decide at ~3s and prove nothing about the
		// armed-across-the-grace window.
		assert.ok(
			elapsedMs >= 6_000,
			`race arm: decided at ${elapsedMs}ms — before the bound elapsed, so the pipes were not held across ` +
				`the race window and the arm measured the close path, not the grace path`,
		);
	});
});

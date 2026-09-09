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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
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

describe("the seam's default is the production constants, pinned (issue #119)", () => {
	it("STRUCTURAL: the bounds parameter defaults to CHILD_TIMEOUT_MS and STREAM_GRACE_MS by name", () => {
		// STRUCTURAL, and recorded as such (§1.5), naming what it substitutes
		// for: a behavioral arm observing the default from outside the module.
		// A parameter default is not runtime-observable — the one production
		// caller passes no bounds and its 10s/2s timing is what the retired
		// staging flaked on — so what is pinned is the initializer's spelling:
		// the default reads the two module constants by name, never its own
		// literals, which is the tie the module's doc sentence ("production
		// callers pass nothing and run the constants") claims and a diverged
		// default (measured green at 20s/8s across the whole suite) breaks.
		const executor = readFileSync(
			fileURLToPath(new URL("../.pi/extensions/gitjig/publish/executor.ts", import.meta.url)),
			"utf8",
		);
		const body = executor
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("//"))
			.join("\n");
		assert.match(
			body,
			/bounds:\s*ChildBounds\s*=\s*\{\s*timeoutMs:\s*CHILD_TIMEOUT_MS,\s*graceMs:\s*STREAM_GRACE_MS\s*\}/,
			"the bounds default no longer spells the production constants by name — a second spelling of the " +
				"production bound can drift with the whole suite green, against the module's own claim that " +
				"production callers run the constants",
		);
	});
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
			`race arm: decided at ${elapsedMs}ms — sooner than the exit-plus-grace the grace path decides at, so ` +
				`the pipes were not held across the race window and the arm measured the close path, not the grace path`,
		);
	});
});

describe("the injected timeoutMs is the bound the kill timer arms (issue #119)", () => {
	it("a never-exiting child under a 1s injected bound is refused near 1s, never at the production bound", async () => {
		// The other half of the seam. The structural arm above pins the
		// DEFAULT's spelling; this arm pins the USE SITE: a kill timer armed
		// from the production constant instead of `bounds.timeoutMs` is
		// behaviorally identical for every production caller, so only an
		// injected divergence can see it — and with it unseen, the grace-path
		// arm above stages nothing (its 3s exit falls out of the effective
		// window and the target mutant escapes). The refusal cause cannot
		// discriminate — it is composed from `bounds.timeoutMs` either way —
		// so the elapsed ceiling is the load-bearing check: at 8s it sits 7s
		// above the ~1s refusal this arm stages and 2s below the 10s
		// production bound a diverged use site would arm, and load moves a
		// diverged run only further past it. The cause substring stays for
		// the class it does catch: a cause spelled from the constant.
		const boundShim = mkdtempSync(join(tmpdir(), "gitjig-bound-"));
		writeFileSync(join(boundShim, "gh"), "#!/bin/sh\nsleep 30\n");
		chmodSync(join(boundShim, "gh"), 0o755);
		const pathBefore = process.env.PATH;
		process.env.PATH = `${boundShim}:${pathBefore ?? ""}`;
		try {
			const started = Date.now();
			const outcome = await runPublishChild([], "bound-arm body", join(shimRoot, "cwd"), SHAPE, {
				timeoutMs: 1_000,
				graceMs: 200,
			});
			const elapsedMs = Date.now() - started;
			assert.equal(
				outcome.outcome,
				"refused",
				`bound arm: a never-exiting child under a 1s injected bound was not refused: ${JSON.stringify(outcome)}`,
			);
			assert.ok(
				outcome.outcome === "refused" && outcome.cause.includes("1000 ms"),
				`bound arm: the refusal cause does not name the injected bound — a cause spelled from the production ` +
					`constant misreports what was enforced: ${JSON.stringify(outcome)}`,
			);
			assert.ok(
				elapsedMs < 8_000,
				`bound arm: refused only at ${elapsedMs}ms — the kill timer armed a bound other than the injected ` +
					`timeoutMs, so the seam's bound half is decoration and the grace-path arm above stages nothing`,
			);
		} finally {
			if (pathBefore === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = pathBefore;
			}
			rmSync(boundShim, { recursive: true, force: true });
		}
	});
});

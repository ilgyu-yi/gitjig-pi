/**
 * The platform half of §3.3's `merge-review` gate (issue #190, Directive
 * #28) — structure over the workflow, and behaviour over the script it
 * runs.
 *
 * Round-1 finding E-F8: the platform half shipped with zero arms while
 * the predicate beside it carried four hundred lines of them, and §3.12
 * makes "the landing verifies structure only" an obligation a landing
 * discharges rather than a permission to ship none.
 * `changelog-workflow.structure.test.ts` is the committed idiom for this
 * file class and this suite follows it.
 *
 * NO LIVE PLATFORM CALLS (issue #190 AC8). Every behavioural arm drives
 * the script's exported pieces with an injected `fetch`, so what is
 * measured is this file's I/O handling, never the network.
 *
 * Arm method, carried from issue #190 and from PR #187's §1.4 STAGNATION
 * ruling: closed domains ITERATED not sampled; unbounded domains at
 * cardinality >= 2 with needles distinct by construction; structured
 * values asserted WHOLE.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./harness/run-pi.ts";

const WORKFLOW = join(repoRoot(), ".github", "workflows", "check-merge-review.yml");
const SCRIPT = join(repoRoot(), ".github", "workflows", "check-merge-review.mjs");

type RunResult = { code: number; lines: string[] };
type ScriptModule = {
	PAGE_BUDGET: number;
	resolveHead(input: Record<string, unknown>): Promise<{ ok: true; head: string } | { ok: false; cause: string }>;
	fetchComments(input: Record<string, unknown>): Promise<{ ok: true; bodies: string[] } | { ok: false; cause: string }>;
	run(env: Record<string, string | undefined>, fetchImpl: unknown): Promise<RunResult>;
};

async function load(): Promise<{ mod?: ScriptModule; error: string }> {
	try {
		return { mod: (await import(pathToFileURL(SCRIPT).href)) as ScriptModule, error: "" };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
const scriptLoad = await load();
function script(): ScriptModule {
	assert.ok(
		scriptLoad.mod,
		`check-merge-review.mjs did not load — the gate's platform half is absent: ${scriptLoad.error}`,
	);
	return scriptLoad.mod;
}

const workflow = readFileSync(WORKFLOW, "utf8");
const HEAD = `7c4e1b9a02d53f86${"e".repeat(23)}1`;
const TOKEN = "zq-the-token";
const ENV = { GITHUB_TOKEN: TOKEN, GITJIG_REPO: "owner/name", GITJIG_PR: "190", GITJIG_HEAD: HEAD };

/** A fetch that answers each URL from a script, and records what it saw. */
function stubFetch(answers: ((url: string) => unknown)[]) {
	const seen: string[] = [];
	let call = 0;
	const impl = (url: string) => {
		seen.push(url);
		const answer = answers[Math.min(call, answers.length - 1)] as (url: string) => unknown;
		call += 1;
		return Promise.resolve(answer(url));
	};
	return { impl, seen };
}
const ok = (value: unknown) => () => ({ ok: true, status: 200, json: () => Promise.resolve(value) });
const status = (code: number) => () => ({ ok: false, status: code, json: () => Promise.resolve(null) });
const comment = (body: string) => ({ body });

describe("§3.3 merge-review workflow — structure (issue #190 AC1, round-1 E-F8)", () => {
	it("wakes on BOTH the head-producing and the evidence-producing events", () => {
		// Round-1 finding E-F7: the record is a comment posted AFTER the
		// head exists, so a push-shaped trigger set alone decides its last
		// verdict before the evidence can arrive. Both are required.
		for (const [event, why] of [
			["pull_request", "the event that produces the head under review"],
			["issue_comment", "the event that produces the evidence the predicate reads (§3.7(a))"],
		] as const) {
			assert.ok(
				new RegExp(`^\\s{2}${event}:\\s*$`, "m").test(workflow),
				`the workflow does not trigger on ${event} — ${why}`,
			);
		}
	});

	it("guards the issue_comment path against plain issues, which carry no pull request", () => {
		assert.ok(
			/if:\s*github\.event_name == 'pull_request' \|\| github\.event\.issue\.pull_request != null/.test(workflow),
			"the job does not discriminate a PR comment from a plain issue comment — the pull_request key is the " +
				"documented discriminator, and without it the job runs on every issue comment in the repository",
		);
	});

	it("grants issues: read — the scope governing the collection the script actually reads", () => {
		// Round-1 finding E-F1: a PR's conversation comments live in the
		// ISSUES collection, which the platform governs under this scope
		// rather than under pull-requests.
		assert.ok(/^\s{2}issues:\s*read\s*$/m.test(workflow), "the workflow does not grant issues: read");
		assert.ok(
			!/^\s{2}(contents|pull-requests|issues):\s*write\s*$/m.test(workflow),
			"the workflow grants a write scope — this job reads and reports and needs none",
		);
	});

	it("passes every value through env:, never through argv or run: interpolation", () => {
		// Round-1 finding E-F2: a token in argv is visible in the runner's
		// process table for the life of the call.
		const runBlock = workflow.slice(workflow.indexOf("run: |"));
		assert.ok(
			!runBlock.includes("${{"),
			"the run: block interpolates a platform expression directly — every value rides env:, the spelling " +
				"check-changelog.yml commits to",
		);
		assert.ok(
			!/check-merge-review\.mjs\s+\S/.test(runBlock),
			"the script is invoked with arguments — the token and the event values must reach it through env:",
		);
		for (const key of ["GITHUB_TOKEN", "GITJIG_REPO", "GITJIG_PR", "GITJIG_HEAD"]) {
			assert.ok(new RegExp(`^\\s+${key}:`, "m").test(workflow), `the workflow does not set ${key} in env:`);
		}
	});

	it("bounds the job and uses only GitHub-shipped actions", () => {
		assert.ok(/^\s{4}timeout-minutes:\s*\d+\s*$/m.test(workflow), "the job carries no timeout-minutes");
		const actions = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1] as string);
		assert.deepEqual(
			actions.filter((action) => !action.startsWith("actions/")),
			[],
			"the workflow uses a third-party Action — this repository uses only GitHub-shipped actions",
		);
	});

	it("declares its development-and-CI-only class, the ground for importing the shell", () => {
		assert.ok(
			workflow.includes("DEVELOPMENT AND CI ONLY"),
			"the workflow does not declare its substrate class — a .github/ asset that imports .pi/ is not " +
				"handed-over, and #134's excision test is what says so",
		);
	});
});

describe("§3.7(c) merge-review script — every failure is a VALUE (issue #190 AC4, round-1 E-F8)", () => {
	it("refuses on EVERY lookup failure shape, iterated not sampled, and never passes", async () => {
		// The closed set of I/O failure shapes this reader can meet.
		const shapes: [string, ((url: string) => unknown)[]][] = [
			[
				"the fetch throwing",
				[
					() => {
						throw new Error("zq transport died");
					},
				],
			],
			["a non-2xx answer", [status(503)]],
			[
				"an answer that is not JSON",
				[() => ({ ok: true, status: 200, json: () => Promise.reject(new Error("zq not json")) })],
			],
			["an answer that is not an array", [ok({ notAnArray: true })]],
		];
		for (const [shape, answers] of shapes) {
			const { impl } = stubFetch(answers);
			const result = await script().run(ENV, impl);
			assert.equal(result.code, 0, `${shape} exited non-zero — the job is advisory and reports rather than blocking`);
			assert.ok(
				result.lines.some((line) => line.includes("::notice::merge-review (ADVISORY): lookup-failed")),
				`${shape} did not render a lookup-failed advisory notice — §3.7(c) makes lookup failure a refusal`,
			);
			assert.ok(
				!result.lines.some((line) => line.includes("PASS")),
				`${shape} was read as a PASS — an unreadable platform is never an approval`,
			);
		}
	});

	it("refuses when the page budget is exhausted rather than judging a truncated list", async () => {
		// Cardinality by construction: every page is full, so no short page
		// ever ends the walk. A reader that stopped early and gated on what
		// it had would approve on evidence it did not finish reading.
		const full = Array.from({ length: 100 }, () => comment("prose"));
		const { impl, seen } = stubFetch([ok(full)]);
		const result = await script().run(ENV, impl);
		assert.equal(seen.length, script().PAGE_BUDGET, "the reader did not walk exactly its page budget before refusing");
		assert.ok(
			result.lines.some((line) => line.includes("lookup-failed") && line.includes(String(script().PAGE_BUDGET))),
			"the truncation refusal does not name the budget it exhausted — it is indistinguishable from a transport failure",
		);
		assert.equal(result.code, 0, "the truncation refusal exited non-zero");
	});

	it("stops at the first short page, and returns the platform's order oldest-first", async () => {
		// The predicate's last-record-wins collapse rests on this order,
		// and the predicate cannot see this call site — so it is pinned here.
		const { impl, seen } = stubFetch([ok([comment("zq first"), comment("zq second")])]);
		const read = await script().fetchComments({ repo: "owner/name", pr: "190", token: TOKEN, fetchImpl: impl });
		assert.equal(seen.length, 1, "a short page did not end the walk");
		assert.deepEqual(
			read.ok ? read.bodies : undefined,
			["zq first", "zq second"],
			"the bodies are not returned in the platform's own order — the predicate's last-record-wins collapse " +
				"rests on this ordering",
		);
	});

	it("substitutes an empty body for a comment carrying none, rather than dropping it", async () => {
		const { impl } = stubFetch([ok([{ body: null }, comment("zq real")])]);
		const read = await script().fetchComments({ repo: "owner/name", pr: "190", token: TOKEN, fetchImpl: impl });
		assert.deepEqual(
			read.ok ? read.bodies : undefined,
			["", "zq real"],
			"a body-less comment changed the list's shape — the predicate selects by position among the records at " +
				"the head, so silently dropping entries is a selection change",
		);
	});
});

describe("§3.3 merge-review script — head resolution (issue #190 AC1, round-1 E-F7)", () => {
	it("uses the supplied head without a platform read", async () => {
		const { impl, seen } = stubFetch([ok(null)]);
		assert.deepEqual(
			await script().resolveHead({ repo: "owner/name", pr: "190", head: HEAD, token: TOKEN, fetchImpl: impl }),
			{ ok: true, head: HEAD },
			"a supplied head was not used as-is",
		);
		assert.deepEqual(seen, [], "the script read the platform despite already holding the head");
	});

	it("resolves the head from the pull request when the event carries none", async () => {
		// The issue_comment path: the payload has no head, so it is read.
		const { impl, seen } = stubFetch([ok({ head: { sha: HEAD } })]);
		assert.deepEqual(
			await script().resolveHead({ repo: "owner/name", pr: "190", head: "", token: TOKEN, fetchImpl: impl }),
			{ ok: true, head: HEAD },
			"the head was not resolved from the pull request on the evidence-event path",
		);
		assert.ok(seen[0]?.includes("/pulls/190"), "the head was resolved from the wrong endpoint");
	});

	it("refuses on EVERY unresolvable-head shape, iterated, and never invents a head", async () => {
		const shapes: [string, unknown][] = [
			["the PR read failing", undefined],
			["a pull request carrying no head", { head: {} }],
			["a head sha that is not a string", { head: { sha: 42 } }],
			["an empty head sha", { head: { sha: "" } }],
		];
		for (const [shape, payload] of shapes) {
			const { impl } = stubFetch([payload === undefined ? status(404) : ok(payload)]);
			const resolved = await script().resolveHead({
				repo: "owner/name",
				pr: "190",
				head: "",
				token: TOKEN,
				fetchImpl: impl,
			});
			assert.equal(resolved.ok, false, `${shape} yielded a head — an unresolvable head must refuse, not be invented`);
			assert.ok(
				resolved.ok === false && resolved.cause.length > 0,
				`${shape} refused with no cause — a silent refusal is the no-silent-skip defect (§3.7(b))`,
			);
		}
	});
});

describe("§3.3 merge-review script — the advisory contract (issue #190 decision 6)", () => {
	it("exits 1 on missing configuration, iterated over every required variable", async () => {
		for (const missing of ["GITHUB_TOKEN", "GITJIG_REPO", "GITJIG_PR"]) {
			const result = await script().run({ ...ENV, [missing]: undefined }, stubFetch([ok([])]).impl);
			assert.equal(
				result.code,
				1,
				`a run missing ${missing} did not exit non-zero — misconfiguration is not a verdict`,
			);
			assert.ok(
				result.lines.some((line) => line.includes("::error::")),
				`a run missing ${missing} did not render an error annotation`,
			);
		}
	});

	it("never leaks the token into any rendered line, across every outcome", async () => {
		const outcomes: [string, ((url: string) => unknown)[]][] = [
			["a clean absent-record refusal", [ok([])]],
			[
				"a transport failure",
				[
					() => {
						throw new Error(`zq died using ${TOKEN}`);
					},
				],
			],
			["a non-2xx", [status(401)]],
		];
		for (const [shape, answers] of outcomes) {
			const result = await script().run(ENV, stubFetch(answers).impl);
			assert.ok(
				!result.lines.join("\n").includes(TOKEN),
				`${shape} rendered a line carrying the token — a credential must not reach the run log`,
			);
		}
	});

	it("renders the hardening owner on every refusal, so the advisory posture names its exit", async () => {
		const result = await script().run(ENV, stubFetch([ok([])]).impl);
		assert.ok(
			result.lines.some((line) => line.includes("#192")),
			"an advisory refusal does not name the issue that owns the hardening — §3.6 owes a deferral its named owner",
		);
	});
});

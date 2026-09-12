/**
 * The platform half of §3.3's `merge-review` gate (issue #190, Directive
 * #28) — structure over the workflow, and behaviour over the script it
 * runs.
 *
 * Round-1 finding E-F8: the platform half shipped with zero arms while
 * the predicate beside it carried four hundred lines of them, and §3.12
 * makes "the landing verifies structure only" an obligation a landing
 * discharges rather than a permission to ship none.
 *
 * NO LIVE PLATFORM CALLS (issue #190 AC8). Every behavioural arm drives
 * the script's exported pieces with an injected `fetch`.
 *
 * Arm method, carried from issue #190 and from PR #187's §1.4 STAGNATION
 * ruling: closed domains ITERATED not sampled; unbounded domains at
 * cardinality >= 2 with needles distinct by construction; structured
 * values asserted WHOLE — no bare flag, no bare substring, in any arm
 * whose title states a general property.
 *
 * Round-2 findings this file is rebuilt against, because the first
 * version of it re-instantiated the very class it was written under:
 *   E5  a general title over a one-point fixture (the owner arm, the leak arm)
 *   E6  `cause.length > 0` — the bare flag round 1 condemned, returning
 *   E7  a YAML regex that matched a COMMENT, so the setting could be deleted
 *   E8  the request itself unmeasured — the stub ignored `init`
 *   E9  `run`'s PASS limb unarmed
 *   E10 the write-scope negative blind to a job-level block
 *   E21 nothing asserted the escaping the script header commits to
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
type RecordModule = {
	composeReviewRecord(record: Record<string, unknown>): string;
};

async function load<T>(href: string, what: string): Promise<{ mod?: T; error: string }> {
	try {
		return { mod: (await import(href)) as T, error: "" };
	} catch (error) {
		return { error: `${what}: ${error instanceof Error ? error.message : String(error)}` };
	}
}
const scriptLoad = await load<ScriptModule>(pathToFileURL(SCRIPT).href, "check-merge-review.mjs");
const recordLoad = await load<RecordModule>(
	pathToFileURL(join(repoRoot(), ".pi", "extensions", "gitjig", "review", "record.ts")).href,
	"record.ts",
);
function script(): ScriptModule {
	assert.ok(scriptLoad.mod, `the gate's platform half is absent or broken — ${scriptLoad.error}`);
	return scriptLoad.mod;
}
function records(): RecordModule {
	assert.ok(recordLoad.mod, `the durable review record is absent — ${recordLoad.error}`);
	return recordLoad.mod;
}

const RAW = readFileSync(WORKFLOW, "utf8");

/**
 * The workflow with every comment removed (round-2 finding E7).
 *
 * A structure arm that matches the raw text cannot tell a live setting
 * from a commented-out one, so deleting the setting and leaving the same
 * words in a `#` comment passed the arm that existed to forbid it. Every
 * assertion about a SETTING runs against this; assertions about the
 * file's prose run against RAW and say so.
 */
const stripComments = (text: string): string =>
	text
		.split("\n")
		.map((line) => (/^\s*#/.test(line) ? "" : line.replace(/\s+#\s.*$/, "")))
		.join("\n");

const LIVE = stripComments(RAW);

const HEAD = `7c4e1b9a02d53f86${"e".repeat(23)}1`;
const TOKEN = "zq-the-token";
const ENV = { GITHUB_TOKEN: TOKEN, GITJIG_REPO: "owner/name", GITJIG_PR: "190", GITJIG_HEAD: HEAD };
const SLOT = { lens: "runtime", surface: "the shell's runtime extensions" };

/** A fetch stub that records the FULL request, not only the URL (E8). */
function stubFetch(answers: ((url: string) => unknown)[]) {
	const seen: { url: string; init: { headers?: Record<string, string> } }[] = [];
	let call = 0;
	const impl = (url: string, init: { headers?: Record<string, string> } = {}) => {
		seen.push({ url, init });
		const answer = answers[Math.min(call, answers.length - 1)] as (url: string) => unknown;
		call += 1;
		return Promise.resolve(answer(url));
	};
	return { impl, seen };
}
const ok = (value: unknown) => () => ({ ok: true, status: 200, json: () => Promise.resolve(value) });
const status = (code: number) => () => ({ ok: false, status: code, json: () => Promise.resolve(null) });
const comment = (body: string) => ({ body });

/** A real, parseable, passing record body at HEAD. */
function passingBody(head = HEAD): string {
	return records().composeReviewRecord({
		head,
		slots: [{ slot: SLOT, valid: true }],
		bundle: [],
		adjudication: null,
		review: { state: "approved" },
	});
}

describe("§3.3 merge-review workflow — structure, over LIVE settings only (issue #190 AC1)", () => {
	it("every named setting is LIVE — deleting it and leaving the words in a comment must not satisfy any arm", () => {
		// The meta-arm for round-2 finding E7: it pins the comment-stripping
		// itself, so a later edit that reverts to matching RAW reds here
		// rather than silently re-admitting a commented-out setting.
		//
		// ROUND 3's EF4: it used to rebuild the stripping expression
		// locally, which is a SECOND HOME for it (§3.11) — so it pinned a
		// copy, not the helper every other arm runs through. Measured at
		// that head: mutating the helper to strip nothing red ONE arm, a
		// consumer ("bounds the job, pins the toolchain..."), while this
		// arm — the one authored to guard that helper — stayed GREEN. It
		// now calls `stripComments`, so the helper is what it exercises.
		//
		// ROUND 4's S-F1: that repair was real and its prose still
		// overstated it. The comment claimed the arm reds on "a later edit
		// that reverts to matching RAW", and measured, rebinding
		// `const LIVE = stripComments(RAW)` to `const LIVE = RAW` — exactly
		// that edit — left this arm GREEN, because it never read LIVE. The
		// binding is now what the third limb asserts, so the claim and the
		// assertion are the same statement.
		//
		// The helper has TWO branches and each is pinned below by its own
		// limb with its own message. Both are load-bearing: a setting
		// deleted and its words left behind satisfies an arm matching LIVE
		// for it, whether the words were left on their own line or after a
		// live setting on the same one.
		const commented = `${RAW}\n# if: github.event_name == 'pull_request'\n# issues: read\n# timeout-minutes: 99\n`;
		const stripped = stripComments(commented);
		assert.equal(
			stripped.includes("timeout-minutes: 99"),
			false,
			"the comment-stripping does not remove a WHOLE-LINE commented-out setting — an arm matching the raw " +
				"text cannot tell a live setting from a deleted one, which is how the discriminator arm became " +
				"decoration",
		);
		// The INLINE branch, pinned on its own. A setting deleted and its
		// words left after a live setting on the same line is the same
		// wrong-allow: the needle survives in LIVE and every arm matching
		// for it passes over a workflow that no longer carries it.
		assert.equal(
			stripComments("timeout-minutes: 10  # node-version: 20").includes("node-version: 20"),
			false,
			"the comment-stripping does not remove an INLINE trailing comment — a setting deleted and its words " +
				"left after a live setting on the same line then satisfies any arm matching LIVE for it, which is " +
				"round-2's E7 wrong-allow through the other door (round 4's S-F2)",
		);
		// The BINDING, which is the half this arm's prose used to claim and
		// not measure. `LIVE` must be the helper's output over RAW, not RAW.
		assert.equal(
			LIVE,
			stripComments(RAW),
			"LIVE is not the stripped RAW — an edit that reverts the binding to RAW leaves every other arm in this " +
				"file matching raw text again, which is the state the helper exists to end (round 4's S-F1)",
		);
	});

	it("wakes on BOTH the head-producing and the evidence-producing events", () => {
		for (const [event, why] of [
			["pull_request", "the event that produces the head under review"],
			["issue_comment", "the event that produces the evidence the predicate reads (§3.7(a))"],
		] as const) {
			assert.ok(
				new RegExp(`^\\s{2}${event}:\\s*$`, "m").test(LIVE),
				`the workflow does not trigger on ${event} — ${why}`,
			);
		}
	});

	it("discriminates a PR comment from a plain issue comment, on a LIVE if: mapping", () => {
		const jobIf = /^\s{4}if:\s*(.+)$/m.exec(LIVE);
		assert.ok(jobIf, "the job carries no live if: — without it the job runs on every issue comment in the repository");
		assert.ok(
			(jobIf[1] as string).includes("github.event.issue.pull_request"),
			"the job's if: does not test the pull_request key — that key is the documented discriminator between a " +
				"pull request's comment and a plain issue's",
		);
	});

	it("grants issues: read and NO write scope, quantified over EVERY permissions block", () => {
		// Round-2 finding E10: the negative was anchored to workflow-level
		// indentation and could not see a JOB-level block, which overrides
		// the workflow default wholesale and is the grant that takes effect.
		assert.ok(/^\s+issues:\s*read\s*$/m.test(LIVE), "the workflow does not grant issues: read");
		const grants = [
			...LIVE.matchAll(/^\s+(contents|pull-requests|issues|actions|checks|packages|id-token):\s*(\S+)\s*$/gm),
		];
		assert.ok(grants.length >= 3, "no permissions grants found — the arm would pass vacuously");
		assert.deepEqual(
			grants.filter((grant) => grant[2] !== "read" && grant[2] !== "none").map((grant) => `${grant[1]}: ${grant[2]}`),
			[],
			"a permissions grant is not read-only, at some indentation — this job reads and reports and needs none, " +
				"and a job-level block overrides the workflow default wholesale",
		);
	});

	it("bounds the job, pins the toolchain, and uses only GitHub-shipped actions", () => {
		assert.ok(/^\s+timeout-minutes:\s*\d+\s*$/m.test(LIVE), "the job carries no timeout-minutes");
		assert.ok(/^\s+concurrency:\s*$/m.test(LIVE), "the workflow declares no concurrency group");
		// Round-2 finding E13: this is the one workflow here that invokes
		// `node`, and its entry point imports TypeScript through native type
		// stripping — a version-gated capability.
		assert.ok(
			/^\s+node-version:\s*\d+\s*$/m.test(LIVE),
			"the workflow does not pin a Node version, while its script imports TypeScript resolved by native type " +
				"stripping — unpinned, the runner image decides whether the gate can evaluate at all",
		);
		assert.deepEqual(
			[...LIVE.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1] as string).filter((a) => !a.startsWith("actions/")),
			[],
			"the workflow uses a third-party Action — this repository uses only GitHub-shipped actions",
		);
	});

	it("passes every value through env:, never through argv or run: interpolation", () => {
		const runBlock = LIVE.slice(LIVE.indexOf("run: |"));
		assert.ok(!runBlock.includes("${{"), "the run: block interpolates a platform expression directly");
		// Only INVOCATION lines are examined. The recovery text inside the
		// ::error:: annotation names the script too, and an arm that could not
		// tell a command from a message would forbid documenting the recovery.
		const invocations = runBlock
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /^(if\s+!\s+)?node\s/.test(line));
		assert.ok(invocations.length > 0, "the run: block never invokes node — the arm would pass vacuously");
		for (const invocation of invocations) {
			assert.ok(
				/check-merge-review\.mjs(;|$)/.test(invocation),
				`the script is invoked with arguments (${invocation}) — the token and the event values must reach it ` +
					"through env:, since argv is visible in the runner's process table",
			);
		}
		for (const key of ["GITHUB_TOKEN", "GITJIG_REPO", "GITJIG_PR", "GITJIG_HEAD"]) {
			assert.ok(new RegExp(`^\\s+${key}:`, "m").test(LIVE), `the workflow does not set ${key} in env:`);
		}
	});

	it("maps a machinery failure to an authored annotation, not a raw stack (§3.9)", () => {
		assert.ok(
			LIVE.includes("::error::") && /NOT a merge-review refusal/i.test(RAW),
			"a non-zero exit of the script renders no authored annotation distinguishing machinery from a verdict — " +
				"every sibling workflow maps a machinery failure to an ::error:: naming a recovery act",
		);
	});

	it("declares its development-and-CI-only class and enumerates its residuals PER TRIGGER PATH", () => {
		// Prose assertions run against RAW: these ARE comments.
		assert.ok(RAW.includes("DEVELOPMENT AND CI ONLY"), "the workflow does not declare its substrate class");
		for (const [needle, why] of [
			["MERGE REF", "the push path's self-grading residual"],
			["DEFAULT BRANCH", "the comment path checks out the default branch, not the merge ref (round-2 E12)"],
		] as const) {
			assert.ok(
				RAW.includes(needle),
				`the header does not enumerate ${why} — the two trigger paths check out different trees, and an ` +
					"enumeration that says otherwise is worse than none",
			);
		}
	});
});

describe("§3.7(c) merge-review script — lookup failures, ITERATED, asserted WHOLE (AC4)", () => {
	// Round-2 finding E6: `cause.length > 0` is a bare flag that a constant
	// survives. Every shape below asserts the cause's own content.
	const shapes: [string, ((url: string) => unknown)[], string][] = [
		[
			"the fetch throwing",
			[
				() => {
					throw new Error("zq transport died");
				},
			],
			"zq transport died",
		],
		["a non-2xx answer", [status(503)], "503"],
		[
			"an answer that is not JSON",
			[() => ({ ok: true, status: 200, json: () => Promise.reject(new Error("zq not json")) })],
			"zq not json",
		],
		["an answer that is not an array", [ok({ notAnArray: true })], "not a comment array"],
	];

	for (const [shape, answers, needle] of shapes) {
		it(`refuses on ${shape}, names it distinctly, and never passes`, () => {
			return script()
				.run(ENV, stubFetch(answers).impl)
				.then((result) => {
					assert.equal(result.code, 0, `${shape} exited non-zero — the job is advisory and reports`);
					const notice = result.lines.find((line) => line.includes("::notice::merge-review"));
					assert.ok(notice, `${shape} rendered no advisory notice`);
					assert.ok(
						(notice as string).includes("lookup-failed"),
						`${shape} did not refuse as lookup-failed — §3.7(c) makes lookup failure a refusal`,
					);
					assert.ok(
						(notice as string).includes(needle),
						`${shape}'s refusal does not carry its own cause (${JSON.stringify(needle)}) — a constant ` +
							"detail is indistinguishable from a correct one, and an operator cannot act on it",
					);
					assert.ok(!result.lines.some((line) => line.includes("PASS")), `${shape} was read as a PASS`);
				});
		});
	}

	it("refuses when the page budget is exhausted rather than judging a truncated list", async () => {
		const full = Array.from({ length: 100 }, () => comment("prose"));
		const { impl, seen } = stubFetch([ok(full)]);
		const result = await script().run(ENV, impl);
		assert.equal(seen.length, script().PAGE_BUDGET, "the reader did not walk exactly its page budget before refusing");
		assert.ok(
			result.lines.some((line) => line.includes("lookup-failed") && line.includes(String(script().PAGE_BUDGET))),
			"the truncation refusal does not name the budget it exhausted",
		);
		assert.equal(result.code, 0, "the truncation refusal exited non-zero");
	});
});

describe("§3.3 merge-review script — the REQUEST itself (round-2 finding E8)", () => {
	// The stub now records `init`, so the credential-bearing header, the
	// collection read, and the page parameters are all measurable. Before
	// this, mutants moving the read to another collection or gutting the
	// authorization header survived every arm.
	it("reads the ISSUES comment collection, authorized, paged — asserted over EVERY page walked", async () => {
		const full = Array.from({ length: 100 }, () => comment("prose"));
		const { impl, seen } = stubFetch([ok(full), ok(full), ok([comment("done")])]);
		await script().fetchComments({ repo: "owner/name", pr: "190", token: TOKEN, fetchImpl: impl });
		assert.equal(seen.length, 3, "the reader did not walk until a short page");
		seen.forEach((request, index) => {
			assert.ok(
				request.url.includes("/repos/owner/name/issues/190/comments"),
				`page ${index + 1} did not read the ISSUES comment collection — a PR's conversation comments live ` +
					"there, which is the collection the workflow's issues: read grant is justified by",
			);
			assert.equal(
				request.init.headers?.authorization,
				`Bearer ${TOKEN}`,
				`page ${index + 1} carried no bearer credential — an unauthenticated read sees a different list`,
			);
			assert.ok(
				request.url.includes("per_page=100") && request.url.includes(`page=${index + 1}`),
				`page ${index + 1} did not request its own page at the full page size — the short-page termination ` +
					"and the budget both rest on the page size being what the reader assumes",
			);
		});
	});

	it("reads the PULLS collection to resolve a head, authorized", async () => {
		const { impl, seen } = stubFetch([ok({ head: { sha: HEAD } })]);
		await script().resolveHead({ repo: "owner/name", pr: "190", head: "", token: TOKEN, fetchImpl: impl });
		assert.equal(seen.length, 1, "the head resolution did not make exactly one read");
		assert.ok(
			(seen[0] as { url: string }).url.includes("/repos/owner/name/pulls/190"),
			"the head was read from the wrong collection",
		);
		assert.equal(
			(seen[0] as { init: { headers?: Record<string, string> } }).init.headers?.authorization,
			`Bearer ${TOKEN}`,
			"the head-resolution read carried no bearer credential",
		);
	});

	it("stops at the first short page, oldest-first — the collapse the predicate performs rests on this order", async () => {
		const { impl, seen } = stubFetch([ok([comment("zq first"), comment("zq second")])]);
		const read = await script().fetchComments({ repo: "owner/name", pr: "190", token: TOKEN, fetchImpl: impl });
		assert.equal(seen.length, 1, "a short page did not end the walk");
		assert.deepEqual(
			read.ok ? read.bodies : undefined,
			["zq first", "zq second"],
			"the platform's order was not preserved",
		);
	});

	it("substitutes an empty body for a comment carrying none, rather than dropping it", async () => {
		const { impl } = stubFetch([ok([{ body: null }, comment("zq real")])]);
		const read = await script().fetchComments({ repo: "owner/name", pr: "190", token: TOKEN, fetchImpl: impl });
		assert.deepEqual(
			read.ok ? read.bodies : undefined,
			["", "zq real"],
			"a body-less comment changed the list's shape",
		);
	});
});

describe("§3.3 merge-review script — head resolution (AC1, round-1 E-F7)", () => {
	it("uses the supplied head without a platform read", async () => {
		const { impl, seen } = stubFetch([ok(null)]);
		assert.deepEqual(
			await script().resolveHead({ repo: "owner/name", pr: "190", head: HEAD, token: TOKEN, fetchImpl: impl }),
			{ ok: true, head: HEAD },
			"a supplied head was not used as-is",
		);
		assert.deepEqual(seen, [], "the script read the platform despite already holding the head");
	});

	it("refuses on EVERY unresolvable-head shape, iterated, naming each distinctly", async () => {
		const shapes: [string, unknown, string][] = [
			["the PR read failing", undefined, "404"],
			["a pull request carrying no head", { head: {} }, "no head sha"],
			["a head sha that is not a string", { head: { sha: 42 } }, "no head sha"],
			["an empty head sha", { head: { sha: "" } }, "no head sha"],
			["a body that is not JSON", null, "not JSON"],
		];
		for (const [shape, payload, needle] of shapes) {
			const answers =
				payload === undefined
					? [status(404)]
					: payload === null
						? [() => ({ ok: true, status: 200, json: () => Promise.reject(new Error("not JSON")) })]
						: [ok(payload)];
			const { impl } = stubFetch(answers);
			const resolved = await script().resolveHead({
				repo: "owner/name",
				pr: "190",
				head: "",
				token: TOKEN,
				fetchImpl: impl,
			});
			assert.equal(resolved.ok, false, `${shape} yielded a head — an unresolvable head must refuse, not be invented`);
			assert.ok(
				resolved.ok === false && resolved.cause.includes(needle),
				`${shape} refused with a cause that does not name it (${JSON.stringify(needle)}) — a constant cause ` +
					"is indistinguishable from a correct one",
			);
		}
	});
});

describe("§3.3 merge-review script — the PASS limb, through the instrument (round-2 finding E9)", () => {
	// The passing arm was demonstrated at the predicate and never through
	// the thing the platform actually runs, so mutants making PASS exit 1,
	// render nothing, or ask about the wrong head all survived.
	it("renders the PASS line and exits 0, on BOTH the supplied-head and the resolved-head paths", async () => {
		const paths: [string, Record<string, string | undefined>, ((url: string) => unknown)[]][] = [
			["the supplied-head path", ENV, [ok([comment(passingBody())])]],
			[
				"the resolved-head path",
				{ ...ENV, GITJIG_HEAD: "" },
				[ok({ head: { sha: HEAD } }), ok([comment(passingBody())])],
			],
		];
		for (const [shape, env, answers] of paths) {
			const result = await script().run(env, stubFetch(answers).impl);
			assert.deepEqual(
				result,
				{ code: 0, lines: [`merge-review: PASS — a complete, adjudicated review is pinned at ${HEAD}.`] },
				`${shape} did not render exactly the PASS line and exit 0 — asserted WHOLE, so a pass that renders ` +
					"nothing, exits non-zero, or names a head other than the one it resolved all red here",
			);
		}
	});

	it("asks the predicate about the RESOLVED head, not an empty one", async () => {
		// A record at HEAD must pass on the resolved path; a record at a
		// different head must not. Both directions, so a gate asking about
		// the empty string cannot satisfy either.
		const other = `${HEAD.slice(0, -1)}2`;
		for (const [shape, recordHead, expected] of [
			["a record at the resolved head", HEAD, true],
			["a record at a different head", other, false],
		] as const) {
			const answers = [ok({ head: { sha: HEAD } }), ok([comment(passingBody(recordHead))])];
			const result = await script().run({ ...ENV, GITJIG_HEAD: "" }, stubFetch(answers).impl);
			assert.equal(
				result.lines.some((line) => line.includes("PASS")),
				expected,
				`${shape} gave the wrong verdict on the resolved-head path`,
			);
		}
	});
});

describe("§3.3 merge-review script — the advisory contract and the rendered line (decision 6)", () => {
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
				`a run missing ${missing} rendered no error`,
			);
		}
	});

	it("renders the advisory disclaimer and the hardening owner on EVERY refusal reason (round-2 E5)", async () => {
		// Iterated over the refusal set the run can actually produce, not
		// over one shape: a mutant rendering the owner for one reason only
		// survived the single-shape version of this arm.
		const refusals: [string, Record<string, string | undefined>, ((url: string) => unknown)[]][] = [
			["a head-resolution failure", { ...ENV, GITJIG_HEAD: "" }, [status(404)]],
			["a comment-list failure", ENV, [status(503)]],
			["an absent record", ENV, [ok([comment("prose only")])]],
			["a relayed record", ENV, [ok([comment(`quoting:\n${passingBody()}`)])]],
			[
				"an unreadable record",
				ENV,
				[ok([comment(`<!-- gitjig-review-record: ${HEAD} -->\n\n\`\`\`json\n{ not json\n\`\`\`\n`)])],
			],
		];
		for (const [shape, env, answers] of refusals) {
			const result = await script().run(env, stubFetch(answers).impl);
			assert.equal(result.code, 0, `${shape} exited non-zero`);
			assert.ok(
				result.lines.some((line) => line.includes("(ADVISORY)")),
				`${shape} did not mark its refusal ADVISORY — a reader must not take it for a block`,
			);
			assert.ok(
				result.lines.some((line) => line.includes("#192")),
				`${shape} did not name the issue that owns the hardening — §3.6 owes a deferral its named owner, and ` +
					"a disclaimer rendered for only some refusals is the title-versus-fixture defect in the artifact",
			);
		}
	});

	it("never leaks the token, across EVERY outcome the run can produce (round-2 E5)", async () => {
		const outcomes: [string, Record<string, string | undefined>, ((url: string) => unknown)[]][] = [
			["a PASS", ENV, [ok([comment(passingBody())])]],
			["a misconfiguration", { ...ENV, GITJIG_REPO: undefined }, [ok([])]],
			[
				"a head-resolution throw",
				{ ...ENV, GITJIG_HEAD: "" },
				[
					() => {
						throw new Error(`zq died using ${TOKEN}`);
					},
				],
			],
			[
				"a comment-list throw",
				ENV,
				[
					() => {
						throw new Error(`zq died using ${TOKEN}`);
					},
				],
			],
			["a non-2xx", ENV, [status(401)]],
			["an absent record", ENV, [ok([comment("prose")])]],
		];
		for (const [shape, env, answers] of outcomes) {
			const result = await script().run(env, stubFetch(answers).impl);
			assert.ok(
				!result.lines.join("\n").includes(TOKEN),
				`${shape} rendered a line carrying the token — a credential must not reach the run log`,
			);
		}
	});

	it("ESCAPES a platform error before rendering it — no input can add a line (round-2 E21)", async () => {
		// The script header commits to wrapping every raw error through the
		// shell's escaper. Nothing asserted it, so removing the wrap left
		// the suite green. This arm is that assertion.
		const { impl } = stubFetch([
			() => {
				throw new Error("zq boom\n::error::FORGED\nmerge-review: PASS");
			},
		]);
		const result = await script().run(ENV, impl);
		// Split on PHYSICAL line boundaries, not on array elements: an
		// unescaped newline lives INSIDE one element, and an arm iterating
		// elements cannot see the second line it renders. That is the same
		// defect class this file was rebuilt against, met in its own arm.
		const physical = result.lines.join("\n").split(/\r?\n|\u2028|\u2029/);
		assert.ok(physical.length >= 1, "no lines rendered");
		for (const line of physical) {
			assert.ok(
				!/^(::[a-z]+::)?(FORGED|merge-review: PASS)/.test(line),
				`a platform error forged a rendered line (${JSON.stringify(line)}) — §3.10 forbids an input that can ` +
					"forge the guard's own decisions, and an unescaped newline is how a second line becomes renderable",
			);
		}
		assert.equal(
			physical.length,
			result.lines.length,
			"a platform error added a PHYSICAL line — the escaping the header commits to is not being applied, and " +
				"the line count is what measures it",
		);
		assert.ok(
			result.lines.some((line) => line.includes("zq boom")),
			"the escaping dropped the platform's cause instead of neutralising it — the refusal must still say what failed",
		);
	});
});

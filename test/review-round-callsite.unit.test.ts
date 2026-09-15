import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	driveReviewRound,
	parseReviewRoundSpec,
	type ReviewRoundSeams,
	type ReviewRoundSpec,
	registerReviewRoundCommand,
	terminalText,
} from "../.pi/extensions/gitjig/commands/review-round.ts";
import { readRepositoryInput } from "../.pi/extensions/gitjig/commands/review-round-input.ts";
import { runPlatformRead } from "../.pi/extensions/gitjig/platform/read.ts";
import { neutralizeForDestination } from "../.pi/extensions/gitjig/publish/neutralize.ts";
import { scanBody } from "../.pi/extensions/gitjig/publish/scan.ts";
import {
	fetchAttestedReviewComments,
	fetchReviewComments,
	recordsFromAttestedComments,
	recordsFromComments,
} from "../.pi/extensions/gitjig/review/comments.ts";
import { DIAGNOSIS_VALUES, INVALIDATIONS } from "../.pi/extensions/gitjig/review/history.ts";
import { reviewRound } from "../.pi/extensions/gitjig/review/orchestrate.ts";
import { composeReviewRecord, parseReviewRecord, type ReviewRecord } from "../.pi/extensions/gitjig/review/record.ts";
import { resolveRepositoryHead } from "../.pi/extensions/gitjig/review/repository.ts";
import type { PlatformReviewContext } from "../.pi/extensions/gitjig/review/subject.ts";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const SLOT = { lens: "runtime", surface: "the shell's runtime extensions" };
const FENCES = { outOfScope: [], forbiddenRemedies: [], deferralHomes: [], priorFindings: [] };
const REFUSE_SPEC_FOR_TEST =
	"review-round refused: the argument must name one readable, in-repository JSON spec of the closed shape; see README.md, Driving a review round";

function repo(): { root: string; base: string; head: string } {
	const root = mkdtempSync(join(tmpdir(), "gitjig-review-callsite-"));
	dirs.push(root);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	git("init", "-q");
	git("config", "user.name", "zq");
	git("config", "user.email", "zq@example.invalid");
	git("config", "commit.gpgsign", "false");
	mkdirSync(join(root, ".pi"));
	writeFileSync(join(root, ".pi", "seed.ts"), "export {};\n");
	git("add", "-A");
	git("commit", "-qm", "seed");
	const base = git("rev-parse", "HEAD");
	writeFileSync(join(root, ".pi", "seed.ts"), "export const changed = true;\n");
	git("add", "-A");
	git("commit", "-qm", "change");
	return { root, base, head: git("rev-parse", "HEAD") };
}

function spec(base = HEAD_A, head = HEAD_B): ReviewRoundSpec {
	return {
		pr: 212,
		baseRef: base,
		headRef: head,
		manifest: { state: "present", criteria: ["the round completes"] },
		fences: FENCES,
		changeDescription: "review-round call site",
		delegateArgv: ["delegate"],
	};
}

function platformContext(): PlatformReviewContext {
	return {
		repository: { id: "R_repo", host: "github.example", nameWithOwner: "owner/repo" },
		pullRequest: {
			id: "PR_node",
			number: 212,
			url: "https://github.example/owner/repo/pull/212",
			authorId: "U_author",
			base: { repositoryId: "R_repo", name: "main", oid: HEAD_A },
			head: { repositoryId: "R_repo", name: "feature", oid: HEAD_B },
			closingIssues: [],
		},
	};
}

function repairRecord(head: string): ReviewRecord {
	const finding = "the same repair remains open";
	return {
		head,
		slots: [{ slot: SLOT, valid: true }],
		bundle: [{ finding, slot: SLOT }],
		adjudication: {
			dedupAttested: true,
			rulings: [
				{ finding, provenance: [SLOT], validity: "CONFIRMED", severity: "SUBSTANTIVE", evidence: "inspection" },
			],
		},
		review: {
			state: "resolved",
			resolution: { outcome: "repair", dispositions: [{ finding, disposition: "repair" }] },
		},
	};
}

function publishResult() {
	return { content: [{ type: "text" as const, text: "published" }], details: { disposition: "published" } };
}

describe("review-round production call site", () => {
	it("normalizes omitted deadlines inside one finite outer bound and rejects misalignment", () => {
		const normalized = parseReviewRoundSpec(spec());
		assert.ok(normalized !== undefined);
		assert.equal(normalized.timeoutMs, 30 * 60 * 1_000);
		assert.deepEqual(normalized.timing, { firstReturnSeconds: 600, finalReturnSeconds: 900 });

		assert.equal(
			parseReviewRoundSpec({
				...spec(),
				timeoutMs: 2_000,
				timing: { firstReturnSeconds: 1, finalReturnSeconds: 2 },
			}),
			undefined,
		);
	});

	it("projects every terminal class visibly without diagnosis evidence", () => {
		assert.equal(
			terminalText({ disposition: "refused", cause: "fixed refusal" }),
			'review-round: refused — "fixed refusal"',
		);
		assert.equal(
			terminalText({
				disposition: "hand-off",
				cause: "fixed handoff",
				reentry: "authorization",
				diagnosis: { value: "OSCILLATION", invalidation: "authorization", evidence: "untrusted evidence" },
			}),
			'review-round: hand-off (authorization) — "fixed handoff"; diagnosis OSCILLATION/authorization',
		);
		assert.equal(
			terminalText({ disposition: "posted", review: { state: "approved" } }),
			"review-round: posted approved",
		);
	});
	it("reads paginated platform comments through the bounded child seam", async () => {
		let seen: { argv: string[]; repoRoot: string } | undefined;
		const lookup = await fetchReviewComments("/repo", 212, async (argv, repoRoot) => {
			seen = { argv, repoRoot };
			return JSON.stringify([[{ body: "first" }], [{ body: "second" }]]);
		});
		assert.deepEqual(lookup, { ok: true, bodies: ["first", "second"] });
		assert.deepEqual(seen, {
			argv: ["api", "--paginate", "--slurp", "repos/{owner}/{repo}/issues/212/comments"],
			repoRoot: "/repo",
		});
	});

	it("retries one transient platform comment-read failure", async () => {
		let attempts = 0;
		const lookup = await fetchReviewComments("/repo", 212, async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("transient");
			return "[[]]";
		});
		assert.deepEqual(lookup, { ok: true, bodies: [] });
		assert.equal(attempts, 2);
	});

	it("stops after two failed platform comment-read attempts", async () => {
		let attempts = 0;
		const lookup = await fetchReviewComments("/repo", 212, async () => {
			attempts += 1;
			throw new Error("persistent");
		});
		assert.deepEqual(lookup, { ok: false, cause: "the bounded platform comment read failed" });
		assert.equal(attempts, 2);
	});

	it("hard-kills a comment child that ignores TERM", async () => {
		const root = mkdtempSync(join(tmpdir(), "gitjig-comment-bound-"));
		dirs.push(root);
		const shim = join(root, "gh");
		writeFileSync(shim, "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n");
		chmodSync(shim, 0o755);
		const savedPath = process.env.PATH;
		process.env.PATH = `${root}:${savedPath ?? ""}`;
		const started = Date.now();
		try {
			const output = await runPlatformRead([], root, { timeoutMs: 100, graceMs: 100, maxBytes: 1024 });
			assert.equal(output, undefined);
			assert.ok(Date.now() - started < 2_000, "the hard bound did not settle promptly");
		} finally {
			if (savedPath === undefined) delete process.env.PATH;
			else process.env.PATH = savedPath;
		}
	});

	it("reads an explicit repository and admits records only from the attested writer", async () => {
		const recordBody = composeReviewRecord(repairRecord(HEAD_A));
		let argv: string[] | undefined;
		const population = await fetchAttestedReviewComments("/repo", platformContext(), async (seen) => {
			argv = seen;
			return JSON.stringify([
				[
					{ id: 1, body: "ordinary", user: { node_id: "U_other" } },
					{ id: 2, body: recordBody, user: { node_id: "U_forged" } },
					{ id: 3, body: recordBody, user: { node_id: "U_writer" } },
				],
			]);
		});
		assert.deepEqual(argv, [
			"api",
			"--hostname",
			"github.example",
			"--paginate",
			"--slurp",
			"repos/owner/repo/issues/212/comments",
		]);
		assert.deepEqual(recordsFromAttestedComments(population, "U_writer"), [repairRecord(HEAD_A)]);
		assert.deepEqual(recordsFromAttestedComments(population, "U_absent"), []);
	});

	it("fails closed on malformed provenance from the explicit comment population", async () => {
		const population = await fetchAttestedReviewComments("/repo", platformContext(), async () =>
			JSON.stringify([[{ id: 1, body: "record", user: {} }]]),
		);
		assert.deepEqual(population, {
			ok: false,
			cause: "the platform comment response carried unreadable provenance",
		});
		assert.equal(recordsFromAttestedComments(population, "U_writer"), undefined);

		let called = false;
		const malformedSubject = platformContext();
		malformedSubject.repository.host = "-option.example";
		const wrongHost = await fetchAttestedReviewComments("/repo", malformedSubject, async () => {
			called = true;
			return "[]";
		});
		assert.equal(called, false);
		assert.equal(wrongHost.ok, false);
	});

	it("scans the semantic record before reversible punctuation encoding", () => {
		const record = repairRecord(HEAD_A);
		record.bundle = [
			{
				finding: ["Author", "ization: Bearer ", "abcdefghijklmnopqrstuvwx"].join(""),
				slot: SLOT,
			},
		];
		const scan = scanBody(composeReviewRecord(record));
		assert.deepEqual(scan, { disposition: "refuse-match", patternIds: ["bearer-token"], lines: [17] });
	});

	it("preserves record strings across the egress neutralizer", () => {
		const record = repairRecord(HEAD_A);
		const finding = "notify @alice; fixes #12; GH-4; owner/repo#5; https://example.invalid/issues/6";
		record.bundle = [{ finding, slot: SLOT }];
		const body = composeReviewRecord(record);
		const published = neutralizeForDestination(body, "pr-comment");
		assert.equal(published.neutralized, 0);
		assert.equal(published.text, body);
		assert.equal(parseReviewRecord(published.text)?.bundle[0].finding, finding);
	});

	it("drives the registered handler through the composed round and posts its machine record", async () => {
		const fixture = repo();
		const input = spec(fixture.base, fixture.head);
		writeFileSync(join(fixture.root, "round.json"), JSON.stringify(input));
		const briefs: string[] = [];
		const posted: string[] = [];
		const entries: unknown[] = [];
		let handler: ((args: string, ctx: { waitForIdle(): Promise<void> }) => Promise<void>) | undefined;
		const pi = {
			registerCommand(name: string, command: { handler: typeof handler }) {
				assert.equal(name, "review-round");
				handler = command.handler;
			},
			appendEntry(type: string, data: unknown) {
				entries.push({ type, data });
			},
			sendMessage() {},
		} as unknown as ExtensionAPI;
		registerReviewRoundCommand(pi, fixture.root, join(fixture.root, "state"), {
			readComments: async () => ({ ok: true, bodies: [] }),
			recordsFromComments,
			resolveHead: () => fixture.head,
			makeDispatch: () => async (brief) => {
				briefs.push(brief);
				return {
					disposition: "admitted",
					ok: true,
					summary: "",
					compare: "confirmed",
					payload: JSON.stringify({ token: "APPROVED", findings: [] }),
				};
			},
			runRound: reviewRound,
			publish: async (body) => {
				posted.push(body);
				return publishResult();
			},
		});
		assert.ok(handler, "the review-round command did not register a handler");
		await handler("round.json", { waitForIdle: async () => {} });
		assert.equal(briefs.length, 1, "one routed runtime slot must dispatch through the registered handler");
		assert.match(briefs[0], /You are one reviewer slot/);
		assert.equal(posted.length, 1, "the registered handler must post exactly one composed record");
		const parsed = recordsFromComments({ ok: true, bodies: posted });
		assert.ok(parsed, "a later clone must read the posted record population");
		assert.equal(parsed.length, 1, "a later clone must parse the posted record");
		assert.deepEqual(entries, [
			{ type: "gitjig-review-round", data: { disposition: "posted", review: { state: "approved" } } },
		]);

		const outside = mkdtempSync(join(tmpdir(), "gitjig-review-outside-"));
		dirs.push(outside);
		writeFileSync(join(outside, "round.json"), JSON.stringify(input));
		symlinkSync(join(outside, "round.json"), join(fixture.root, "linked.json"));
		await handler("linked.json", { waitForIdle: async () => {} });
		assert.deepEqual(entries.at(-1), {
			type: "gitjig-review-round",
			data: {
				disposition: "refused",
				cause:
					"review-round refused: the argument must name one readable, in-repository JSON spec of the closed shape; see README.md, Driving a review round",
			},
		});
		assert.equal(briefs.length, 1, "a symlinked spec must refuse before dispatch");

		mkdirSync(join(fixture.root, "actual"));
		writeFileSync(join(fixture.root, "actual", "round.json"), JSON.stringify(input));
		symlinkSync(join(fixture.root, "actual"), join(fixture.root, "linked-dir"));
		await handler("linked-dir/round.json", { waitForIdle: async () => {} });
		assert.deepEqual(entries.at(-1), {
			type: "gitjig-review-round",
			data: { disposition: "refused", cause: REFUSE_SPEC_FOR_TEST },
		});
		assert.equal(briefs.length, 1, "an intermediate symlink must refuse before dispatch");

		writeFileSync(join(fixture.root, "bad-base.json"), JSON.stringify(spec("missing-base", fixture.head)));
		await handler("bad-base.json", { waitForIdle: async () => {} });
		assert.deepEqual(entries.at(-1), {
			type: "gitjig-review-round",
			data: {
				disposition: "hand-off",
				cause: "review-round handed off: the composed round could not produce a terminal result",
				reentry: "none",
			},
		});
	});

	it("hands off when a marked record is unreadable instead of shortening history", async () => {
		let ran = false;
		const seams = {
			readComments: async () => ({ ok: true as const, bodies: ["<!-- gitjig-review-record: broken -->"] }),
			recordsFromComments,
			resolveHead: () => HEAD_B,
			makeDispatch: () => async () => {
				throw new Error("diagnosis must not run");
			},
			runRound: async () => {
				ran = true;
				throw new Error("round must not run");
			},
			publish: async () => publishResult(),
		} as ReviewRoundSeams;
		const outcome = await driveReviewRound(spec(), "/unused", seams);
		assert.equal(outcome.disposition, "hand-off");
		assert.equal(ran, false);
	});

	it("dispatches the §1.4 diagnosis and parks before a new round on STAGNATION", async () => {
		let rounds = 0;
		let diagnosisBrief = "";
		const bodies = [composeReviewRecord(repairRecord(HEAD_A)), composeReviewRecord(repairRecord(HEAD_B))];
		const seams = {
			readComments: async () => ({ ok: true as const, bodies }),
			recordsFromComments,
			resolveHead: () => HEAD_B,
			makeDispatch: () => async (brief: string) => {
				diagnosisBrief = brief;
				return {
					disposition: "admitted" as const,
					ok: true,
					summary: "",
					compare: "confirmed" as const,
					payload: JSON.stringify({
						value: "STAGNATION",
						invalidation: "nothing",
						evidence: "two recorded repair states",
					}),
				};
			},
			runRound: async () => {
				rounds += 1;
				throw new Error("parked diagnosis must stop the round");
			},
			publish: async () => publishResult(),
		} as ReviewRoundSeams;
		const outcome = await driveReviewRound(spec(), "/unused", seams);
		assert.match(diagnosisBrief, /repair-history diagnosis/);
		assert.deepEqual(outcome, {
			disposition: "hand-off",
			cause: "review-round handed off: the required history diagnosis was unavailable or required parking",
			reentry: "none",
			diagnosis: {
				value: "STAGNATION",
				invalidation: "nothing",
				evidence: "two recorded repair states",
			},
		});
		assert.equal(rounds, 0);
	});

	it("binds every diagnosis taxonomy × invalidation cell before downstream acts", async () => {
		const bodies = [composeReviewRecord(repairRecord(HEAD_A)), composeReviewRecord(repairRecord(HEAD_B))];
		for (const value of DIAGNOSIS_VALUES) {
			for (const invalidation of INVALIDATIONS) {
				let rounds = 0;
				let publishes = 0;
				const outcome = await driveReviewRound(spec(), "/unused", {
					readComments: async () => ({ ok: true, bodies }),
					recordsFromComments,
					resolveHead: () => HEAD_B,
					makeDispatch: () => async () => ({
						disposition: "admitted",
						ok: true,
						summary: "",
						compare: "confirmed",
						payload: JSON.stringify({ value, invalidation, evidence: "measured" }),
					}),
					runRound: async () => {
						rounds += 1;
						return { record: repairRecord(HEAD_B), recordBody: "record", review: { state: "approved" } };
					},
					publish: async () => {
						publishes += 1;
						return publishResult();
					},
				});
				const continues = value === "NONE" && invalidation === "nothing";
				assert.equal(rounds, continues ? 1 : 0, `${value}/${invalidation}: round count`);
				assert.equal(publishes, continues ? 1 : 0, `${value}/${invalidation}: publish count`);
				assert.ok("diagnosis" in outcome, `${value}/${invalidation}: diagnosis absent`);
				if ("diagnosis" in outcome) assert.deepEqual(outcome.diagnosis, { value, invalidation, evidence: "measured" });
				if (!continues) {
					assert.equal(outcome.disposition, "hand-off", `${value}/${invalidation}`);
					if (outcome.disposition === "hand-off")
						assert.equal(outcome.reentry, invalidation === "nothing" ? "none" : invalidation);
				}
			}
		}
	});

	it("retains a NONE diagnosis in the posted terminal disposition", async () => {
		const bodies = [composeReviewRecord(repairRecord(HEAD_A)), composeReviewRecord(repairRecord(HEAD_B))];
		const diagnosis = { value: "NONE" as const, invalidation: "nothing" as const, evidence: "new ground" };
		const seams = {
			readComments: async () => ({ ok: true as const, bodies }),
			recordsFromComments,
			resolveHead: () => HEAD_B,
			makeDispatch: () => async () => ({
				disposition: "admitted" as const,
				ok: true,
				summary: "",
				compare: "confirmed" as const,
				payload: JSON.stringify(diagnosis),
			}),
			runRound: async () => ({
				review: { state: "approved" as const },
				record: repairRecord(HEAD_B),
				recordBody: "record",
			}),
			publish: async () => publishResult(),
		} as ReviewRoundSeams;
		assert.deepEqual(await driveReviewRound(spec(), "/unused", seams), {
			disposition: "posted",
			review: { state: "approved" },
			diagnosis,
		});
	});

	it("projects an admitted diagnosis through every later failure class", async () => {
		const bodies = [composeReviewRecord(repairRecord(HEAD_A)), composeReviewRecord(repairRecord(HEAD_B))];
		const diagnosis = { value: "NONE" as const, invalidation: "nothing" as const, evidence: "retained" };
		const round = {
			review: { state: "approved" as const },
			record: repairRecord(HEAD_B),
			recordBody: "record",
		};
		const base = {
			readComments: async () => ({ ok: true as const, bodies }),
			recordsFromComments,
			resolveHead: () => HEAD_B,
			makeDispatch: () => async () => ({
				disposition: "admitted" as const,
				ok: true,
				summary: "",
				compare: "confirmed" as const,
				payload: JSON.stringify(diagnosis),
			}),
		} as Pick<ReviewRoundSeams, "readComments" | "recordsFromComments" | "resolveHead" | "makeDispatch">;
		const cases: Array<{ name: string; seams: ReviewRoundSeams; cause: string }> = [
			{
				name: "round throw",
				seams: {
					...base,
					runRound: async () => {
						throw new Error("round");
					},
					publish: async () => publishResult(),
				},
				cause: "review-round handed off: the composed round could not produce a terminal result",
			},
			{
				name: "publish throw",
				seams: {
					...base,
					runRound: async () => round,
					publish: async () => {
						throw new Error("publish");
					},
				},
				cause: "review-round handed off: the composed round could not produce a terminal result",
			},
			{
				name: "publish not confirmed",
				seams: {
					...base,
					runRound: async () => round,
					publish: async () => ({ content: [], details: { disposition: "refused" } }),
				},
				cause: "review-round handed off: the durable review record was not confirmed published",
			},
		];
		for (const item of cases) {
			assert.deepEqual(
				await driveReviewRound(spec(), "/unused", item.seams),
				{
					disposition: "hand-off",
					cause: item.cause,
					reentry: "none",
					diagnosis,
				},
				item.name,
			);
		}

		const beforeAdmission = await driveReviewRound(spec(), "/unused", {
			...base,
			readComments: async () => {
				throw new Error("history");
			},
			runRound: async () => round,
			publish: async () => publishResult(),
		});
		assert.deepEqual(beforeAdmission, {
			disposition: "hand-off",
			cause: "review-round handed off: the composed round could not produce a terminal result",
			reentry: "none",
		});
	});

	it("refuses every linked path component, including one later cancelled by dot-dot", () => {
		const fixture = repo();
		writeFileSync(join(fixture.root, "round.json"), "root");
		mkdirSync(join(fixture.root, "actual"));
		mkdirSync(join(fixture.root, "actual", "deep"));
		writeFileSync(join(fixture.root, "actual", "deep", "round.json"), "nested");
		assert.equal(readRepositoryInput(fixture.root, "actual/deep/round.json"), "nested");
		assert.equal(readRepositoryInput(fixture.root, "../round.json"), undefined);
		assert.equal(readRepositoryInput(fixture.root, "actual/deep/round.json/child"), undefined);

		symlinkSync(join(fixture.root, "actual"), join(fixture.root, "alias"));
		assert.equal(readRepositoryInput(fixture.root, "alias/deep/round.json"), undefined);
		assert.equal(readRepositoryInput(fixture.root, "alias/../round.json"), undefined);
		symlinkSync(join(fixture.root, "actual", "deep"), join(fixture.root, "actual", "linked-deep"));
		assert.equal(readRepositoryInput(fixture.root, "actual/linked-deep/round.json"), undefined);
		symlinkSync(join(fixture.root, "missing"), join(fixture.root, "dangling.json"));
		assert.equal(readRepositoryInput(fixture.root, "dangling.json"), undefined);
		symlinkSync(join(fixture.root, "loop.json"), join(fixture.root, "loop.json"));
		assert.equal(readRepositoryInput(fixture.root, "loop.json"), undefined);
	});

	it("refuses a FIFO input without blocking on a writer", () => {
		const fixture = repo();
		const fifo = join(fixture.root, "round.json");
		execFileSync("mkfifo", [fifo]);
		const started = Date.now();
		assert.equal(readRepositoryInput(fixture.root, "round.json"), undefined);
		assert.ok(Date.now() - started < 1_000, "the FIFO read blocked before descriptor validation");
	});

	it("keeps Git execution behind the one quiet repository capability", () => {
		const consumers = [
			"../.pi/extensions/gitjig/commands/review-round.ts",
			"../.pi/extensions/gitjig/review/orchestrate.ts",
			"../.pi/extensions/gitjig/review/panel.ts",
		];
		for (const name of consumers) {
			const source = readFileSync(new URL(name, import.meta.url), "utf8");
			assert.doesNotMatch(source, /from\s+["']node:child_process["']/, name);
		}
		const owner = readFileSync(new URL("../.pi/extensions/gitjig/review/repository.ts", import.meta.url), "utf8");
		assert.equal(owner.match(/execFileSync\s*\(/g)?.length, 1);
		assert.match(owner, /stdio:\s*\["ignore",\s*"pipe",\s*"pipe"\]/);
		assert.match(owner, /withoutRepoLocatingGitEnv\(process\.env\)/);
		assert.match(owner, /"--end-of-options"/);
		assert.ok(owner.includes("return /^[0-9a-f]{40}$/.test(head) ? head : undefined;"));

		const fileOwner = readFileSync(
			new URL("../.pi/extensions/gitjig/commands/review-round-input.ts", import.meta.url),
			"utf8",
		);
		assert.match(fileOwner, /constants\.O_RDONLY\s*\|\s*constants\.O_NOFOLLOW\s*\|\s*constants\.O_NONBLOCK/);
		assert.match(fileOwner, /opened\.dev !== leaf\.dev \|\| opened\.ino !== leaf\.ino/);
		assert.match(fileOwner, /readFileSync\(fd,\s*"utf8"\)/);
		assert.match(fileOwner, /finally\s*{\s*closeSync\(fd\);\s*}/);
	});

	it("resolves invalid and dash-leading refs without emitting child diagnostics", () => {
		const fixture = repo();
		assert.equal(resolveRepositoryHead(fixture.root, "missing-ref"), undefined);
		const moduleUrl = new URL("../.pi/extensions/gitjig/review/repository.ts", import.meta.url).href;
		for (const ref of ["missing-ref", "--output=forbidden"]) {
			const child = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					`import { resolveRepositoryHead } from ${JSON.stringify(moduleUrl)}; if (resolveRepositoryHead(${JSON.stringify(fixture.root)}, ${JSON.stringify(ref)}) !== undefined) process.exit(2);`,
				],
				{ encoding: "utf8" },
			);
			assert.equal(child.status, 0, ref);
			assert.equal(child.stderr, "", ref);
		}
	});
});

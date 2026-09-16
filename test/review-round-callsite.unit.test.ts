import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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
	type AttestedCommentPopulation,
	fetchAttestedReviewComments,
	recordsFromAttestedComments,
} from "../.pi/extensions/gitjig/review/comments.ts";
import { DIAGNOSIS_VALUES, type DiagnosisInput, INVALIDATIONS } from "../.pi/extensions/gitjig/review/history.ts";
import { type RoundOptions, reviewRound } from "../.pi/extensions/gitjig/review/orchestrate.ts";
import type { ReviewPublicationOutcome } from "../.pi/extensions/gitjig/review/publication.ts";
import { composeReviewRecord, parseReviewRecord, type ReviewRecord } from "../.pi/extensions/gitjig/review/record.ts";
import type { PlatformReviewContext, ReviewSubject } from "../.pi/extensions/gitjig/review/subject.ts";

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

/**
 * A `gh` shim that writes `payload`, hands its stdout to a detached holder
 * process, and exits. The holder outlives the shim by design — that is the
 * interleaving these arms exist to reach — so the shim records its pid and
 * `cleanup` reaps it; nothing is left running past the arm. The holder is a
 * Node script, so the arms need no interpreter beyond the one running them.
 */
function napMs(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function holderShim(
	prefix: string,
	holderBody: string,
): { root: string; holderPid: () => number | undefined; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(root);
	const pidFile = join(root, "holder.pid");
	writeFileSync(
		join(root, "holder.js"),
		[
			"const parent = Number(process.argv[2]);",
			"const alive = () => { try { process.kill(parent, 0); return true; } catch { return false; } };",
			"const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);",
			"const awaitParentExit = () => { while (alive()) nap(20); };",
			"const hold = () => setTimeout(() => {}, 60000);",
			holderBody,
		].join("\n"),
	);
	const shim = join(root, "gh");
	writeFileSync(
		shim,
		[
			`#!${process.execPath}`,
			'const { spawn } = require("node:child_process");',
			'const { writeFileSync } = require("node:fs");',
			'process.stdout.write("payload");',
			`const holder = spawn(process.execPath, [${JSON.stringify(join(root, "holder.js"))}, String(process.pid)], {`,
			"\tdetached: true,",
			'\tstdio: ["ignore", 1, "ignore"],',
			"});",
			`writeFileSync(${JSON.stringify(pidFile)}, String(holder.pid));`,
			"holder.unref();",
		].join("\n"),
	);
	chmodSync(shim, 0o755);
	const savedPath = process.env.PATH;
	process.env.PATH = `${root}:${savedPath ?? ""}`;
	const recordedPid = (): number | undefined => {
		let recorded: string;
		try {
			recorded = readFileSync(pidFile, "utf8");
		} catch {
			return undefined;
		}
		const pid = Number(recorded);
		return Number.isSafeInteger(pid) && pid > 0 ? pid : Number.NaN;
	};
	return {
		root,
		holderPid: () => {
			const pid = recordedPid();
			return pid === undefined || Number.isNaN(pid) ? undefined : pid;
		},
		cleanup: () => {
			if (savedPath === undefined) delete process.env.PATH;
			else process.env.PATH = savedPath;
			const pid = recordedPid();
			if (pid === undefined || Number.isNaN(pid)) throw new Error("the holder pid was not recorded");
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				return;
			}
			// A signal delivered is not a process gone: wait for the holder to
			// leave the table, so the shared apparatus invariant is observable.
			for (let attempt = 0; attempt < 500; attempt += 1) {
				try {
					process.kill(pid, 0);
				} catch {
					return;
				}
				napMs(10);
			}
			throw new Error("the holder survived its own reaping");
		},
	};
}

function spec(): ReviewRoundSpec {
	return {
		pr: 212,
		fences: FENCES,
		changeDescription: "review-round call site",
		delegateArgv: ["delegate"],
	};
}

function platformContext(base = HEAD_A, head = HEAD_B): PlatformReviewContext {
	return {
		repository: { id: "R_repo", host: "github.example", nameWithOwner: "owner/repo" },
		pullRequest: {
			id: "PR_node",
			number: 212,
			url: "https://github.example/owner/repo/pull/212",
			authorId: "U_author",
			base: { repositoryId: "R_repo", name: "main", oid: base },
			head: { repositoryId: "R_repo", name: "feature", oid: head },
			closingIssues: [],
		},
	};
}

function subject(base = HEAD_A, head = HEAD_B): ReviewSubject {
	return { context: platformContext(base, head), writerId: "U_writer", activation: [], criteria: [] };
}

/** The attested population a writer's own records are read back from. */
function population(bodies: readonly string[], receiptBody?: string): AttestedCommentPopulation {
	return {
		ok: true,
		comments: [
			...bodies.map((body, index) => ({ id: index + 1, authorId: "U_writer", body })),
			...(receiptBody === undefined ? [] : [{ id: 99, authorId: "U_writer", body: receiptBody }]),
		],
	};
}

function receipt(body: string): ReviewPublicationOutcome {
	return {
		ok: true,
		receipt: {
			repositoryId: "R_repo",
			pullRequestId: "PR_node",
			headOid: HEAD_B,
			commentId: 99,
			authorId: "U_writer",
			body,
		},
	};
}

const ROUND: RoundResultShape = {
	review: { state: "approved" },
	record: repairRecord(HEAD_B),
	recordBody: "record",
};
type RoundResultShape = Awaited<ReturnType<typeof reviewRound>>;

/** Every seam defaults to the quiet success path; each arm names what it moves. */
function seams(overrides: Partial<ReviewRoundSeams> = {}): ReviewRoundSeams {
	let publishedBody: string | undefined;
	return {
		fetchSubject: async () => subject(),
		refetchSubject: async (_root, current) => current,
		readComments: async () => population([], publishedBody),
		recordsFromComments: recordsFromAttestedComments,
		resolveHead: () => HEAD_B,
		makeDispatch: () => async () => {
			throw new Error("no dispatch was expected");
		},
		runRound: async () => ROUND,
		publishRecord: async (body) => {
			publishedBody = body;
			return receipt(body);
		},
		...overrides,
	};
}

function diagnosisDispatch(payload: DiagnosisInput, seen: string[] = []) {
	return () => async (brief: string) => {
		seen.push(brief);
		return {
			disposition: "admitted" as const,
			ok: true,
			summary: "",
			compare: "confirmed" as const,
			payload: JSON.stringify(payload),
		};
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
	it("retries one transient platform comment-read failure", async () => {
		let attempts = 0;
		const read = await fetchAttestedReviewComments("/repo", platformContext(), async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("transient");
			return "[[]]";
		});
		assert.deepEqual(read, { ok: true, comments: [] });
		assert.equal(attempts, 2);
	});

	it("stops after two failed platform comment-read attempts", async () => {
		let attempts = 0;
		const read = await fetchAttestedReviewComments("/repo", platformContext(), async () => {
			attempts += 1;
			throw new Error("persistent");
		});
		assert.deepEqual(read, { ok: false, cause: "the bounded platform comment read failed" });
		assert.equal(attempts, 2);
	});

	it("combines every page of a paginated attested read, in order", async () => {
		const population = await fetchAttestedReviewComments("/repo", platformContext(), async () =>
			JSON.stringify([
				[
					{ id: 1, body: "first", user: { node_id: "U_writer" } },
					{ id: 2, body: "second", user: { node_id: "U_other" } },
				],
				[{ id: 3, body: "third", user: { node_id: "U_writer" } }],
				[{ id: 4, body: "fourth", user: { node_id: "U_writer" } }],
			]),
		);
		assert.deepEqual(population, {
			ok: true,
			comments: [
				{ id: 1, authorId: "U_writer", body: "first" },
				{ id: 2, authorId: "U_other", body: "second" },
				{ id: 3, authorId: "U_writer", body: "third" },
				{ id: 4, authorId: "U_writer", body: "fourth" },
			],
		});
	});

	it("assembles history from records spread across pages", async () => {
		const first = composeReviewRecord(repairRecord(HEAD_A));
		const last = composeReviewRecord(repairRecord(HEAD_B));
		const population = await fetchAttestedReviewComments("/repo", platformContext(), async () =>
			JSON.stringify([
				[{ id: 1, body: first, user: { node_id: "U_writer" } }],
				[{ id: 2, body: "ordinary", user: { node_id: "U_writer" } }],
				[{ id: 3, body: last, user: { node_id: "U_writer" } }],
			]),
		);
		assert.deepEqual(recordsFromAttestedComments(population, "U_writer"), [repairRecord(HEAD_A), repairRecord(HEAD_B)]);
	});

	it("refuses a duplicated comment identity in the attested population", async () => {
		const read = await fetchAttestedReviewComments("/repo", platformContext(), async () =>
			JSON.stringify([
				[
					{ id: 7, body: "one", user: { node_id: "U_writer" } },
					{ id: 7, body: "two", user: { node_id: "U_writer" } },
				],
			]),
		);
		assert.deepEqual(read, { ok: false, cause: "the platform comment response carried unreadable provenance" });
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

	it("refuses a read that exceeds the byte cap instead of returning it truncated", async () => {
		const root = mkdtempSync(join(tmpdir(), "gitjig-comment-cap-"));
		dirs.push(root);
		const shim = join(root, "gh");
		writeFileSync(shim, "#!/bin/sh\nprintf '0123456789abcdef'\n");
		chmodSync(shim, 0o755);
		const savedPath = process.env.PATH;
		process.env.PATH = `${root}:${savedPath ?? ""}`;
		try {
			assert.equal(await runPlatformRead([], root, { timeoutMs: 5_000, graceMs: 200, maxBytes: 8 }), undefined);
			assert.equal(
				await runPlatformRead([], root, { timeoutMs: 5_000, graceMs: 200, maxBytes: 16 }),
				"0123456789abcdef",
			);
		} finally {
			if (savedPath === undefined) delete process.env.PATH;
			else process.env.PATH = savedPath;
		}
	});

	it("reaps the holder it started", async () => {
		const fixture = holderShim("gitjig-comment-reap-", "hold();");
		assert.equal(
			await runPlatformRead([], fixture.root, { timeoutMs: 30_000, graceMs: 300, maxBytes: 1024 }),
			"payload",
		);
		const pid = fixture.holderPid();
		assert.ok(pid !== undefined, "the shim recorded no holder pid");
		assert.doesNotThrow(() => process.kill(pid as number, 0), "the holder was not running before cleanup");
		fixture.cleanup();
		assert.throws(() => process.kill(pid as number, 0), "the holder outlived the cleanup that claims to reap it");
	});

	it("refuses an over-cap read that arrives after the child already exited", async () => {
		const fixture = holderShim(
			"gitjig-comment-late-cap-",
			// The writer waits for its own parent to be gone before writing, so the
			// ordering this arm needs — child exits, grace timer arms, over-cap bytes
			// arrive after it — is causal rather than raced against a clock.
			"awaitParentExit(); process.stdout.write('0123456789abcdef'); hold();",
		);
		try {
			assert.equal(
				await runPlatformRead([], fixture.root, { timeoutMs: 30_000, graceMs: 3_000, maxBytes: 8 }),
				undefined,
			);
		} finally {
			fixture.cleanup();
		}
	});

	it("settles a finished child whose pipe an orphan holds open", async () => {
		const fixture = holderShim("gitjig-comment-orphan-", "hold();");
		const started = Date.now();
		try {
			assert.equal(
				await runPlatformRead([], fixture.root, { timeoutMs: 30_000, graceMs: 300, maxBytes: 1024 }),
				"payload",
			);
			assert.ok(Date.now() - started < 10_000, "the read waited on the orphan rather than settling at exit");
		} finally {
			fixture.cleanup();
		}
	});

	it("carries a multi-byte character split across two stdout chunks", async () => {
		const root = mkdtempSync(join(tmpdir(), "gitjig-comment-split-"));
		dirs.push(root);
		const shim = join(root, "gh");
		// The two-byte encoding of the accented character is written either side
		// of a pause, so the reader sees it as two separate `data` events.
		writeFileSync(shim, "#!/bin/sh\nprintf 'caf\\303'\nsleep 0.2\nprintf '\\251 h\\303\\251llo'\n");
		chmodSync(shim, 0o755);
		const savedPath = process.env.PATH;
		process.env.PATH = `${root}:${savedPath ?? ""}`;
		try {
			const output = await runPlatformRead([], root, { timeoutMs: 5_000, graceMs: 200, maxBytes: 1024 });
			assert.equal(output, "caf\u00e9 h\u00e9llo");
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

	it("scans semantic lines introduced by reversible encoding", () => {
		const escapedToken = ["g", "h", "p", "_", "a".repeat(36)]
			.join("")
			.replace(/./g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
		assert.deepEqual(scanBody(`safe\\u000a${escapedToken}`), {
			disposition: "refuse-match",
			patternIds: ["github-token"],
			lines: [2],
		});
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
		const input = spec();
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
			fetchSubject: async () => subject(fixture.base, fixture.head),
			refetchSubject: async (_root, current) => current,
			readComments: async () => population([], posted.at(-1)),
			recordsFromComments: recordsFromAttestedComments,
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
			publishRecord: async (body) => {
				posted.push(body);
				return receipt(body);
			},
		});
		assert.ok(handler, "the review-round command did not register a handler");
		await handler("round.json", { waitForIdle: async () => {} });
		assert.equal(briefs.length, 1, "one routed runtime slot must dispatch through the registered handler");
		assert.match(briefs[0], /You are one reviewer slot/);
		assert.equal(posted.length, 1, "the registered handler must post exactly one composed record");
		const parsed = recordsFromAttestedComments(population(posted), "U_writer");
		assert.ok(parsed, "a later clone must read the posted record population");
		assert.equal(parsed.length, 1, "a later clone must parse the posted record");
		assert.equal(parsed[0].head, fixture.head, "the read-back record must pin the attested head");
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

		writeFileSync(join(fixture.root, "bad-shape.json"), JSON.stringify({ ...input, baseRef: fixture.base }));
		await handler("bad-shape.json", { waitForIdle: async () => {} });
		assert.deepEqual(entries.at(-1), {
			type: "gitjig-review-round",
			data: { disposition: "refused", cause: REFUSE_SPEC_FOR_TEST },
		});
		assert.equal(briefs.length, 1, "a caller-supplied review target must refuse before dispatch");
	});

	it("reads the prior durable record into history across a clone boundary", async () => {
		const first = repo();
		const secondRoot = mkdtempSync(join(tmpdir(), "gitjig-review-next-clone-"));
		dirs.push(secondRoot);
		execFileSync("git", ["clone", "-q", first.root, secondRoot]);
		const comments: { id: number; authorId: string; body: string }[] = [];
		const readRoots: string[] = [];
		let diagnoses = 0;

		const run = async (root: string, current: ReviewSubject, record: ReviewRecord) =>
			driveReviewRound(
				spec(),
				root,
				seams({
					fetchSubject: async () => current,
					refetchSubject: async () => current,
					resolveHead: () => current.context.pullRequest.head.oid,
					readComments: async (seenRoot) => {
						readRoots.push(seenRoot);
						return { ok: true, comments: [...comments] };
					},
					runRound: async () => ({
						review: record.review,
						record,
						recordBody: composeReviewRecord(record),
					}),
					publishRecord: async (body) => {
						const commentId = comments.length + 1;
						comments.push({ id: commentId, authorId: current.writerId, body });
						return {
							ok: true,
							receipt: {
								repositoryId: current.context.repository.id,
								pullRequestId: current.context.pullRequest.id,
								headOid: current.context.pullRequest.head.oid,
								commentId,
								authorId: current.writerId,
								body,
							},
						};
					},
					makeDispatch: diagnosisDispatch({ value: "NONE", invalidation: "nothing", evidence: "cross-clone" }),
				}),
			);

		assert.equal(
			(await run(first.root, subject(first.base, first.base), repairRecord(first.base))).disposition,
			"posted",
		);
		const second = await run(secondRoot, subject(first.base, first.head), repairRecord(first.head));
		if ("diagnosis" in second && second.diagnosis !== undefined) diagnoses += 1;
		assert.equal(second.disposition, "posted");
		assert.equal(diagnoses, 1, "the second clone must diagnose the two-record history");
		assert.ok(readRoots.includes(first.root));
		assert.ok(readRoots.includes(secondRoot));
	});

	it("takes repository, base, head and criteria from the subject alone", async () => {
		let options: RoundOptions | undefined;
		const sealed = subject(HEAD_A, HEAD_B);
		sealed.context.pullRequest.closingIssues = [
			{
				id: "I_node",
				repositoryId: "R_repo",
				number: 212,
				title: "task",
				body: "## Acceptance criteria\n- the round completes",
			},
		];
		sealed.criteria = ["#212: the round completes"];
		const outcome = await driveReviewRound(
			spec(),
			"/unused",
			seams({
				fetchSubject: async () => sealed,
				runRound: async (given) => {
					options = given;
					return ROUND;
				},
			}),
		);
		assert.deepEqual(outcome, { disposition: "posted", review: { state: "approved" } });
		assert.equal(options?.baseRef, HEAD_A);
		assert.equal(options?.headRef, HEAD_B);
		assert.deepEqual(options?.manifest, { state: "present", criteria: ["#212: the round completes"] });
	});

	it("hands off before any dispatch when the subject is unavailable or the clone disagrees", async () => {
		let ran = 0;
		const guard = {
			runRound: async () => {
				ran += 1;
				return ROUND;
			},
		};
		assert.deepEqual(
			await driveReviewRound(spec(), "/unused", seams({ ...guard, fetchSubject: async () => undefined })),
			{
				disposition: "hand-off",
				cause: "review-round handed off: the platform-attested review subject could not be established",
				reentry: "none",
			},
		);
		for (const resolved of [undefined, HEAD_A]) {
			assert.deepEqual(
				await driveReviewRound(spec(), "/unused", seams({ ...guard, resolveHead: () => resolved })),
				{
					disposition: "hand-off",
					cause: "review-round handed off: the attested head is not the head this clone resolves",
					reentry: "none",
				},
				String(resolved),
			);
		}
		assert.equal(ran, 0);
	});

	it("hands off before opening the panel when history-read time changes the subject", async () => {
		let rounds = 0;
		assert.deepEqual(
			await driveReviewRound(
				spec(),
				"/unused",
				seams({
					refetchSubject: async () => undefined,
					runRound: async () => {
						rounds += 1;
						return ROUND;
					},
				}),
			),
			{
				disposition: "hand-off",
				cause: "review-round handed off: the review subject changed while the round ran",
				reentry: "none",
			},
		);
		assert.equal(rounds, 0);
	});

	it("refuses to post a record after the subject drifted under the round", async () => {
		let checks = 0;
		let rounds = 0;
		let posts = 0;
		assert.deepEqual(
			await driveReviewRound(
				spec(),
				"/unused",
				seams({
					refetchSubject: async (_root, current) => (++checks === 1 ? current : undefined),
					runRound: async () => {
						rounds += 1;
						return ROUND;
					},
					publishRecord: async (body) => {
						posts += 1;
						return receipt(body);
					},
				}),
			),
			{
				disposition: "hand-off",
				cause: "review-round handed off: the review subject changed while the round ran",
				reentry: "none",
			},
		);
		assert.equal(rounds, 1);
		assert.equal(posts, 0);
	});

	it("hands off when the subject drifts after publication", async () => {
		let checks = 0;
		let posts = 0;
		assert.deepEqual(
			await driveReviewRound(
				spec(),
				"/unused",
				seams({
					refetchSubject: async (_root, current) => (++checks <= 2 ? current : undefined),
					publishRecord: async (body) => {
						posts += 1;
						return receipt(body);
					},
				}),
			),
			{
				disposition: "hand-off",
				cause: "review-round handed off: the review subject changed while the round ran",
				reentry: "none",
			},
		);
		assert.equal(checks, 3);
		assert.equal(posts, 1);
	});

	it("does not dispatch a triggered diagnosis after the subject drifts", async () => {
		let dispatched = 0;
		const bodies = [composeReviewRecord(repairRecord(HEAD_A)), composeReviewRecord(repairRecord(HEAD_B))];
		const outcome = await driveReviewRound(
			spec(),
			"/unused",
			seams({
				readComments: async () => population(bodies),
				refetchSubject: async () => undefined,
				makeDispatch: () => async () => {
					dispatched += 1;
					throw new Error("stale diagnosis must not dispatch");
				},
			}),
		);
		assert.equal(outcome.disposition, "hand-off");
		assert.equal(dispatched, 0);
	});

	it("requires the next history population to contain the exact publication receipt", async () => {
		const outcome = await driveReviewRound(spec(), "/unused", seams({ readComments: async () => population([]) }));
		assert.deepEqual(outcome, {
			disposition: "hand-off",
			cause: "review-round handed off: installed review history could not be read",
			reentry: "none",
		});
	});

	it("hands off when a marked record is unreadable instead of shortening history", async () => {
		let ran = false;
		const outcome = await driveReviewRound(
			spec(),
			"/unused",
			seams({
				readComments: async () => population(["<!-- gitjig-review-record: broken -->"]),
				runRound: async () => {
					ran = true;
					return ROUND;
				},
			}),
		);
		assert.deepEqual(outcome, {
			disposition: "hand-off",
			cause: "review-round handed off: installed review history could not be read",
			reentry: "none",
		});
		assert.equal(ran, false, "an unreadable history must not spend a round");
	});

	it("parks after the triggering record is durable, and never before the round", async () => {
		const briefs: string[] = [];
		const order: string[] = [];
		const bodies = [composeReviewRecord(repairRecord(HEAD_A)), composeReviewRecord(repairRecord(HEAD_B))];
		const diagnosis = {
			value: "STAGNATION" as const,
			invalidation: "nothing" as const,
			evidence: "two recorded repair states",
		};
		const outcome = await driveReviewRound(
			spec(),
			"/unused",
			seams({
				readComments: async () =>
					population(
						order.includes("publish") ? bodies : bodies.slice(0, 1),
						order.includes("publish") ? "record" : undefined,
					),
				makeDispatch: diagnosisDispatch(diagnosis, briefs),
				runRound: async () => {
					order.push("round");
					return ROUND;
				},
				publishRecord: async (body) => {
					order.push("publish");
					return receipt(body);
				},
			}),
		);
		assert.deepEqual(order, ["round", "publish"]);
		assert.equal(briefs.length, 1);
		assert.match(briefs[0], /repair-history diagnosis/);
		assert.equal(briefs[0].includes(HEAD_B), false, "the round's own head stays withheld from the diagnosis brief");
		assert.deepEqual(outcome, {
			disposition: "hand-off",
			cause: "review-round handed off: the required history diagnosis was unavailable or required parking",
			reentry: "none",
			diagnosis,
		});
	});

	it("binds every diagnosis taxonomy × invalidation cell after one durable round", async () => {
		const bodies = [composeReviewRecord(repairRecord(HEAD_A)), composeReviewRecord(repairRecord(HEAD_B))];
		for (const value of DIAGNOSIS_VALUES) {
			for (const invalidation of INVALIDATIONS) {
				let rounds = 0;
				let publishes = 0;
				const outcome = await driveReviewRound(
					spec(),
					"/unused",
					seams({
						readComments: async () => population(bodies, publishes > 0 ? "record" : undefined),
						makeDispatch: diagnosisDispatch({ value, invalidation, evidence: "measured" }),
						runRound: async () => {
							rounds += 1;
							return ROUND;
						},
						publishRecord: async (body) => {
							publishes += 1;
							return receipt(body);
						},
					}),
				);
				const continues = value === "NONE" && invalidation === "nothing";
				assert.equal(rounds, continues ? 1 : 0, `${value}/${invalidation}: round count`);
				assert.equal(publishes, continues ? 1 : 0, `${value}/${invalidation}: publish count`);
				assert.ok("diagnosis" in outcome, `${value}/${invalidation}: diagnosis absent`);
				if ("diagnosis" in outcome) assert.deepEqual(outcome.diagnosis, { value, invalidation, evidence: "measured" });
				if (continues) {
					assert.equal(outcome.disposition, "posted", `${value}/${invalidation}`);
				} else {
					assert.equal(outcome.disposition, "hand-off", `${value}/${invalidation}`);
					if (outcome.disposition === "hand-off")
						assert.equal(outcome.reentry, invalidation === "nothing" ? "none" : invalidation);
				}
			}
		}
	});

	it("occasions no diagnosis where the trigger does not fire", async () => {
		let dispatched = 0;
		let publishedBody: string | undefined;
		const outcome = await driveReviewRound(
			spec(),
			"/unused",
			seams({
				readComments: async () => population([composeReviewRecord(repairRecord(HEAD_B))], publishedBody),
				publishRecord: async (body) => {
					publishedBody = body;
					return receipt(body);
				},
				makeDispatch: () => async () => {
					dispatched += 1;
					throw new Error("no diagnosis is occasioned");
				},
			}),
		);
		assert.deepEqual(outcome, { disposition: "posted", review: { state: "approved" } });
		assert.equal(dispatched, 0);
	});

	it("projects an admitted diagnosis through every later failure class", async () => {
		const bodies = [composeReviewRecord(repairRecord(HEAD_A)), composeReviewRecord(repairRecord(HEAD_B))];
		const diagnosis = { value: "NONE" as const, invalidation: "nothing" as const, evidence: "retained" };
		const base = {
			readComments: async () => population(bodies),
			makeDispatch: diagnosisDispatch(diagnosis),
		};
		for (const item of [
			{
				name: "round throw",
				seams: seams({
					...base,
					runRound: async () => {
						throw new Error("round");
					},
				}),
				cause: "review-round handed off: the composed round could not produce a terminal result",
			},
			{
				name: "publish throw",
				seams: seams({
					...base,
					publishRecord: async () => {
						throw new Error("publish");
					},
				}),
				cause: "review-round handed off: the composed round could not produce a terminal result",
			},
			{
				name: "publish not confirmed",
				seams: seams({ ...base, publishRecord: async () => ({ ok: false, cause: "refused" }) }),
				cause: "review-round handed off: the durable review record was not confirmed published",
			},
			{
				name: "history unreadable after publication",
				seams: (() => {
					let reads = 0;
					return seams({
						...base,
						readComments: async () => {
							reads += 1;
							return reads === 1 ? population(bodies) : { ok: false, cause: "unreadable" };
						},
					});
				})(),
				cause: "review-round handed off: installed review history could not be read",
			},
		]) {
			assert.deepEqual(
				await driveReviewRound(spec(), "/unused", item.seams),
				{ disposition: "hand-off", cause: item.cause, reentry: "none", diagnosis },
				item.name,
			);
		}
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

	it("refuses an ancestor replaced after the repository walk", () => {
		const fixture = repo();
		mkdirSync(join(fixture.root, "inside"));
		writeFileSync(join(fixture.root, "inside", "round.json"), "inside");
		const moved = join(fixture.root, "moved");
		assert.equal(
			readRepositoryInput(fixture.root, "inside/round.json", () => {
				renameSync(join(fixture.root, "inside"), moved);
				symlinkSync(moved, join(fixture.root, "inside"));
			}),
			undefined,
		);
	});

	it("refuses a FIFO input without blocking on a writer", () => {
		const fixture = repo();
		const fifo = join(fixture.root, "round.json");
		execFileSync("mkfifo", [fifo]);
		const started = Date.now();
		assert.equal(readRepositoryInput(fixture.root, "round.json"), undefined);
		assert.ok(Date.now() - started < 1_000, "the FIFO read blocked before descriptor validation");
	});

	it("bounds repository input before JSON admission", () => {
		const fixture = repo();
		writeFileSync(join(fixture.root, "round.json"), Buffer.alloc(1024 * 1024 + 1, 0x20));
		assert.equal(readRepositoryInput(fixture.root, "round.json"), undefined);
	});

	it("pins the repository-input descriptor and byte bound structurally", () => {
		const fileOwner = readFileSync(
			new URL("../.pi/extensions/gitjig/commands/review-round-input.ts", import.meta.url),
			"utf8",
		);
		assert.match(fileOwner, /constants\.O_RDONLY\s*\|\s*constants\.O_NOFOLLOW\s*\|\s*constants\.O_NONBLOCK/);
		assert.match(fileOwner, /opened\.dev !== leaf\.dev/);
		assert.match(fileOwner, /opened\.ino !== leaf\.ino/);
		assert.match(fileOwner, /MAX_REVIEW_ROUND_SPEC_BYTES \+ 1/);
		assert.match(fileOwner, /readSync\(fd,/);
		assert.match(fileOwner, /finally\s*{\s*closeSync\(fd\);\s*}/);

		const commandOwner = readFileSync(
			new URL("../.pi/extensions/gitjig/commands/review-round.ts", import.meta.url),
			"utf8",
		);
		assert.match(commandOwner, /timeout:\s*10_000/);
		assert.match(commandOwner, /killSignal:\s*"SIGKILL"/);
	});
});

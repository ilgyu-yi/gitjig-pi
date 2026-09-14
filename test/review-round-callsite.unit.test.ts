import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	driveReviewRound,
	type ReviewRoundSeams,
	type ReviewRoundSpec,
	registerReviewRoundCommand,
} from "../.pi/extensions/gitjig/commands/review-round.ts";
import { fetchReviewComments, recordsFromComments } from "../.pi/extensions/gitjig/review/comments.ts";
import { reviewRound } from "../.pi/extensions/gitjig/review/orchestrate.ts";
import { composeReviewRecord, type ReviewRecord } from "../.pi/extensions/gitjig/review/record.ts";

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
	it("reads paginated platform comments through the bounded child seam", () => {
		let seen: { argv: string[]; timeout: number; maxBuffer: number } | undefined;
		const lookup = fetchReviewComments("/repo", 212, (argv, options) => {
			seen = { argv, timeout: options.timeout, maxBuffer: options.maxBuffer };
			return JSON.stringify([[{ body: "first" }], [{ body: "second" }]]);
		});
		assert.deepEqual(lookup, { ok: true, bodies: ["first", "second"] });
		assert.deepEqual(seen, {
			argv: ["api", "--paginate", "--slurp", "repos/{owner}/{repo}/issues/212/comments"],
			timeout: 10_000,
			maxBuffer: 4 * 1024 * 1024,
		});
	});

	it("retries one transient platform comment-read failure", () => {
		let attempts = 0;
		const lookup = fetchReviewComments("/repo", 212, () => {
			attempts += 1;
			if (attempts === 1) throw new Error("transient");
			return "[[]]";
		});
		assert.deepEqual(lookup, { ok: true, bodies: [] });
		assert.equal(attempts, 2);
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
			readComments: () => ({ ok: true, bodies: [] }),
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
	});

	it("hands off when a marked record is unreadable instead of shortening history", async () => {
		let ran = false;
		const seams = {
			readComments: () => ({ ok: true as const, bodies: ["<!-- gitjig-review-record: broken -->"] }),
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
			readComments: () => ({ ok: true as const, bodies }),
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
		});
		assert.equal(rounds, 0);
	});
});

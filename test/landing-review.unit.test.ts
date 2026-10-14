import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { landingReview, loadPlatformLanding } from "../.pi/extensions/gitjig/landing/platform.ts";
import { composeReviewRecord, parseReviewRecord, type ReviewRecord } from "../.pi/extensions/gitjig/review/record.ts";

/* #442: which review record at the current head decides Tier-1 landing (SPEC §3.8). */
const HEAD = "a".repeat(40);
const slot = { lens: "suite", surface: "the test suite" };
const record = (review: unknown, findings = 0, head = HEAD): ReviewRecord =>
	({
		head,
		slots: [],
		bundle: Array.from({ length: findings }, (_, index) => ({ finding: `f${index}`, slot })),
		adjudication: null,
		review,
	}) as unknown as ReviewRecord;
const approved = record({ state: "approved" });
const repair = record({ state: "resolved", resolution: { outcome: "repair", dispositions: [] } });
const escalate = record({ state: "resolved", resolution: { outcome: "measure-escalate", dispositions: [] } });
const resolvedClear = record({ state: "resolved", resolution: { outcome: "clear", dispositions: [] } }, 1);
const emptyIncomplete = record({ state: "incomplete", cause: "panel" });
const foundIncomplete = record({ state: "incomplete", cause: "panel" }, 1);
// The runtime also writes findings-carrying incomplete records whose Judge did not finish.
const judgeIncomplete = record({ state: "incomplete", cause: "adjudication-incomplete", gaps: ["g"] }, 1);
const judgeMissing = record({ state: "incomplete", cause: "adjudication-missing" }, 1);
const elsewhereFound = record({ state: "incomplete", cause: "panel" }, 1, "b".repeat(40));

type Select = typeof landingReview;
/** The arm or resolver token, and which record landing reads (its review fields derive from it). */
const outcome = (select: Select, records: ReviewRecord[]) => {
	const result = select(records, HEAD);
	return "arm" in result ? [result.arm, undefined] : [result.resolver, result.record];
};
const ARMS: ReadonlyArray<readonly [string, ReviewRecord[], string, ReviewRecord | undefined]> = [
	[
		"an empty incomplete record beside an approval lands",
		[emptyIncomplete, emptyIncomplete, approved],
		"clear",
		approved,
	],
	[
		"an incomplete record carrying findings leaves the review non-clear",
		[foundIncomplete, approved],
		"blocked",
		foundIncomplete,
	],
	["an incomplete record carrying findings at another head is not read", [elsewhereFound, approved], "clear", approved],
	["only empty incomplete records leave the review missing", [emptyIncomplete], "missing", undefined],
	["an approval beside a repair refuses as ambiguous", [repair, approved], "review-record-ambiguous", undefined],
	["two approvals refuse as ambiguous", [approved, approved], "review-record-ambiguous", undefined],
	["a single repair blocks", [repair], "blocked", repair],
	["a single measure-escalate blocks", [escalate], "blocked", escalate],
	[
		"two complete records refuse even beside findings on an incomplete one",
		[foundIncomplete, repair, approved],
		"review-record-ambiguous",
		undefined,
	],
	[
		"a resolved record with a clear Resolver outcome is clear",
		[emptyIncomplete, resolvedClear],
		"clear",
		resolvedClear,
	],
	["a record for another head is not read", [record({ state: "approved" }, 0, "b".repeat(40))], "missing", undefined],
];

describe("#442 landing reads the current head's complete review", () => {
	for (const [label, records, expected, read] of ARMS)
		it(label, () => {
			const [token, chosen] = outcome(landingReview, records);
			assert.equal(token, expected);
			assert.equal(chosen, read, "landing reads another record");
		});
});

/*
 * Every population of up to three records drawn from the kinds below, checked
 * against an oracle written from SPEC §3.8's sentence alone, so no pairing is
 * left to a hand-picked arm: other heads are not read; more than one complete
 * record refuses as ambiguous; an incomplete record carrying findings blocks,
 * reading that record; otherwise the single complete record decides (approved
 * or a clear Resolver outcome is clear, any other outcome blocks) and none is
 * missing.
 */
const KINDS: ReadonlyArray<ReviewRecord> = [
	emptyIncomplete,
	foundIncomplete,
	judgeIncomplete,
	judgeMissing,
	elsewhereFound,
	record({ state: "approved" }, 0, "b".repeat(40)),
	approved,
	repair,
	escalate,
	resolvedClear,
];
function oracle(records: readonly ReviewRecord[]): [string, ReviewRecord | undefined] {
	const here = records.filter((item) => item.head === HEAD);
	const done = here.filter((item) => item.review.state !== "incomplete");
	if (done.length > 1) return ["review-record-ambiguous", undefined];
	const found = here.find((item) => item.review.state === "incomplete" && item.bundle.length > 0);
	if (found) return ["blocked", found];
	const only = done[0];
	if (!only) return ["missing", undefined];
	const review = only.review as { state: string; resolution?: { outcome: string } };
	const clear = review.state === "approved" || review.resolution?.outcome === "clear";
	return [clear ? "clear" : "blocked", only];
}
const POPULATIONS: ReviewRecord[][] = [];
for (const first of KINDS) {
	POPULATIONS.push([first]);
	for (const second of KINDS) {
		POPULATIONS.push([first, second]);
		for (const third of KINDS) POPULATIONS.push([first, second, third]);
	}
}
const agrees = (select: Select) =>
	POPULATIONS.every((records) => {
		const [token, chosen] = outcome(select, records);
		const [expected, read] = oracle(records);
		return token === expected && chosen === read;
	});

describe("#442 every small population agrees with SPEC §3.8's rule", () => {
	it(`agrees on all ${POPULATIONS.length} populations of up to three records`, () => {
		for (const records of POPULATIONS)
			assert.deepEqual(
				outcome(landingReview, records),
				oracle(records),
				records.map((item) => JSON.stringify(item.review)).join(" + "),
			);
	});
});

const repository = fileURLToPath(new URL("..", import.meta.url));
const box = mkdtempSync(join(tmpdir(), "gitjig-442-"));
after(() => rmSync(box, { recursive: true, force: true }));
const PLATFORM = ".pi/extensions/gitjig/landing/platform.ts";
const MUTANTS: ReadonlyArray<readonly [string, string, string]> = [
	["incomplete records counted", 'atHead.filter((item) => item.review.state !== "incomplete")', "atHead"],
	[
		"findings on an incomplete record ignored",
		'if (withFindings !== undefined) return { resolver: "blocked"',
		'if (false) return { resolver: "blocked"',
	],
	[
		"an incomplete record read at another head",
		"const withFindings = atHead.find(",
		"const withFindings = records.find(",
	],
	["the latest complete record taken", 'if (complete.length > 1) return { arm: "review-record-ambiguous" };', ""],
	["another head read", "const atHead = records.filter((item) => item.head === headSha);", "const atHead = records;"],
	[
		"a resolved clear read as blocked",
		'reviewRecord.review.resolution.outcome === "clear" ? "clear" : "blocked"',
		'"blocked"',
	],
	[
		"the findings record dropped",
		'return { resolver: "blocked", record: withFindings };',
		'return { resolver: "blocked", record: undefined };',
	],
	["the resolved record dropped", "\t\t\trecord: reviewRecord,\n\t\t};", "\t\t\trecord: undefined,\n\t\t};"],
	[
		"any record with findings read as an incomplete one",
		'item.review.state === "incomplete" && item.bundle.length > 0',
		"item.bundle.length > 0",
	],
	[
		"findings ignored beside a resolved record",
		'if (withFindings !== undefined) return { resolver: "blocked"',
		'if (withFindings !== undefined && complete[0]?.review.state !== "resolved") return { resolver: "blocked"',
	],
	[
		"only a panel-cause incomplete record read for findings",
		'item.review.state === "incomplete" && item.bundle.length > 0',
		'item.review.state === "incomplete" && (item.review as { cause?: string }).cause === "panel" && item.bundle.length > 0',
	],
	[
		"a resolved non-clear outcome read as clear",
		'reviewRecord.review.resolution.outcome === "clear" ? "clear" : "blocked"',
		'reviewRecord.review.resolution.outcome !== "repair" ? "clear" : "blocked"',
	],
	[
		"findings checked before ambiguity",
		'\tif (complete.length > 1) return { arm: "review-record-ambiguous" };\n\tconst withFindings = atHead.find((item) => item.review.state === "incomplete" && item.bundle.length > 0);\n\tif (withFindings !== undefined) return { resolver: "blocked", record: withFindings };',
		'\tconst withFindings = atHead.find((item) => item.review.state === "incomplete" && item.bundle.length > 0);\n\tif (withFindings !== undefined) return { resolver: "blocked", record: withFindings };\n\tif (complete.length > 1) return { arm: "review-record-ambiguous" };',
	],
];

describe("#442 owned mutants", () => {
	for (const [label, from, to] of MUTANTS)
		it(`kills: ${label}`, async () => {
			const dir = mkdtempSync(join(box, "m-"));
			cpSync(join(repository, ".pi"), join(dir, ".pi"), { recursive: true });
			symlinkSync(join(repository, "node_modules"), join(dir, "node_modules"), "dir");
			const target = join(dir, PLATFORM);
			const source = readFileSync(target, "utf8");
			assert.ok(source.indexOf(from) >= 0 && source.indexOf(from) === source.lastIndexOf(from), `${label}: anchor`);
			writeFileSync(
				target,
				source.replace(from, () => to),
			);
			const mutated = (await import(pathToFileURL(target).href)) as { landingReview: Select };
			assert.ok(!agrees(mutated.landingReview), `${label} survived the exhaustive populations`);
		});
});

/*
 * The call site: loadPlatformLanding over a fake platform whose comments are
 * PR #441's three published records at one head (two incomplete, one
 * approved), the population that stranded that head before this change.
 */
const FIXTURES = new URL("./fixtures/landing-442/", import.meta.url);
const published = [0, 1, 2].map((index) => readFileSync(new URL(`record-${index}.txt`, FIXTURES), "utf8"));
const PUBLISHED_HEAD = "545bd07e91c017fa7e88be98442ee945dae9fc9f";
function platform(bodies: readonly string[]) {
	const viewer = { node_id: "VIEWER", login: "operator" };
	const responses: Record<string, unknown> = {
		"repos/o/r": {
			node_id: "REPO",
			default_branch: "main",
			allow_merge_commit: true,
			allow_squash_merge: true,
			allow_rebase_merge: true,
		},
		"repos/o/r/pulls/7": {
			node_id: "PR",
			head: { sha: PUBLISHED_HEAD },
			base: { sha: "b".repeat(40), ref: "main" },
			user: { node_id: "AUTHOR" },
			labels: [],
			mergeable_state: "clean",
		},
		user: viewer,
		"repos/o/r/rulesets?includes_parents=true&per_page=100&page=1": [{ id: 1 }],
		"repos/o/r/rulesets/1": {
			target: "branch",
			enforcement: "active",
			conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
			source_type: "Repository",
			rules: [],
		},
		"repos/o/r/pulls/7/reviews?per_page=100&page=1": [],
		"repos/o/r/issues/7/comments?per_page=100&page=1": bodies.map((body, id) => ({ id, user: viewer, body })),
		[`repos/o/r/commits/${PUBLISHED_HEAD}/check-runs?per_page=100&page=1`]: { total_count: 0, check_runs: [] },
		"repos/o/r/branches/main": { commit: { sha: "b".repeat(40) } },
		"repos/o/r/collaborators/operator/permission": { role_name: "admin" },
	};
	return async (argv: string[]) => {
		if (argv.includes("graphql"))
			return JSON.stringify({
				data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } },
			});
		const key = argv.at(-1) as string;
		return key in responses ? JSON.stringify(responses[key]) : undefined;
	};
}
const load = (bodies: readonly string[]) =>
	loadPlatformLanding("github.com", "o/r", 7, "/nonexistent", "now", platform(bodies));

describe("#442 the landing load reads the head's review through landingReview", () => {
	it("loads PR #441's stranded head as clear: two empty incomplete records and one approval", async () => {
		const loaded = await load(published);
		assert.equal(loaded.arm, "loaded", JSON.stringify(loaded));
		assert.equal(loaded.snapshot?.resolver, "clear");
		assert.equal(loaded.snapshot?.reviewHeadSha, PUBLISHED_HEAD);
	});
	it("loads a findings-carrying incomplete record as non-clear, reading that record", async () => {
		// PR #441's first incomplete record, with one finding from a valid slot.
		const base = parseReviewRecord(published[0] as string) as ReviewRecord;
		const valid = base.slots.find((item) => item.valid) as ReviewRecord["slots"][number];
		const found = composeReviewRecord({ ...base, bundle: [{ rawOrdinal: 0, finding: "a finding", slot: valid.slot }] });
		const loaded = await load([found, published[2] as string]);
		assert.equal(loaded.arm, "loaded", JSON.stringify(loaded));
		assert.equal(loaded.snapshot?.resolver, "blocked");
		assert.equal(loaded.snapshot?.reviewHeadSha, PUBLISHED_HEAD);
		assert.equal(loaded.snapshot?.reviewComplete, true);
		assert.equal(loaded.snapshot?.judgeComplete, false, "the snapshot reads the incomplete record, not the approval");
	});
	it("refuses two approvals at the head as ambiguous", async () => {
		assert.equal((await load([published[2] as string, published[2] as string])).arm, "review-record-ambiguous");
	});
	it("refuses a malformed review record", async () => {
		const malformed = "<!-- gitjig-review-record: x -->\nnot a record";
		assert.equal((await load([...published, malformed])).arm, "review-record-malformed");
	});
});

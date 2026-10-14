import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { landingReview } from "../.pi/extensions/gitjig/landing/platform.ts";
import type { ReviewRecord } from "../.pi/extensions/gitjig/review/record.ts";

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
const emptyIncomplete = record({ state: "incomplete", cause: "panel" });
const foundIncomplete = record({ state: "incomplete", cause: "panel" }, 1);

type Select = typeof landingReview;
const outcome = (select: Select, records: ReviewRecord[]) => {
	const result = select(records, HEAD);
	return "arm" in result ? result.arm : result.resolver;
};
const ARMS: ReadonlyArray<readonly [string, ReviewRecord[], string]> = [
	["an empty incomplete record beside an approval lands", [emptyIncomplete, emptyIncomplete, approved], "clear"],
	["an incomplete record carrying findings refuses", [foundIncomplete, approved], "review-record-incomplete-findings"],
	["only empty incomplete records leave the review missing", [emptyIncomplete], "missing"],
	["an approval beside a repair refuses as ambiguous", [repair, approved], "review-record-ambiguous"],
	["two approvals refuse as ambiguous", [approved, approved], "review-record-ambiguous"],
	["a single repair blocks", [repair], "blocked"],
	["a record for another head is not read", [record({ state: "approved" }, 0, "b".repeat(40))], "missing"],
];

describe("#442 landing reads the current head's complete review", () => {
	for (const [label, records, expected] of ARMS)
		it(label, () => assert.equal(outcome(landingReview, records), expected));
});

const repository = fileURLToPath(new URL("..", import.meta.url));
const box = mkdtempSync(join(tmpdir(), "gitjig-442-"));
after(() => rmSync(box, { recursive: true, force: true }));
const PLATFORM = ".pi/extensions/gitjig/landing/platform.ts";
const MUTANTS: ReadonlyArray<readonly [string, string, string]> = [
	[
		"incomplete records counted",
		'\tconst complete = atHead.filter((item) => item.review.state !== "incomplete");',
		"\tconst complete = atHead;",
	],
	[
		"findings on an incomplete record ignored",
		' && item.bundle.length > 0))\n\t\treturn { arm: "review-record-incomplete-findings" };',
		' && false))\n\t\treturn { arm: "review-record-incomplete-findings" };',
	],
	[
		"the latest complete record taken",
		'\tif (complete.length > 1) return { arm: "review-record-ambiguous" };\n\tconst reviewRecord = complete[0];',
		"\tconst reviewRecord = complete.at(-1);",
	],
	["another head read", "const atHead = records.filter((item) => item.head === headSha);", "const atHead = records;"],
];

describe("#442 owned mutants", () => {
	for (const [label, from, to] of MUTANTS)
		it(`kills: ${label}`, async () => {
			const dir = mkdtempSync(join(box, "m-"));
			cpSync(join(repository, ".pi"), join(dir, ".pi"), { recursive: true });
			symlinkSync(join(repository, "node_modules"), join(dir, "node_modules"), "dir");
			const target = join(dir, PLATFORM);
			const source = readFileSync(target, "utf8");
			assert.ok(
				source.indexOf(from) >= 0 && source.indexOf(from) === source.lastIndexOf(from),
				`${label}: anchor must exist once`,
			);
			writeFileSync(
				target,
				source.replace(from, () => to),
			);
			const mutated = (await import(pathToFileURL(target).href)) as { landingReview: Select };
			assert.ok(
				ARMS.some(([, records, expected]) => outcome(mutated.landingReview, records) !== expected),
				`${label} survived`,
			);
		});
});

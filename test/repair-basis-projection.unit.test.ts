import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { deriveRepairBasis, type StateSummary } from "../.pi/extensions/gitjig/review/history.ts";
import { readCorrectionInterval } from "../.pi/extensions/gitjig/review/interval.ts";
import type { ReviewRecord } from "../.pi/extensions/gitjig/review/record.ts";

const roots: string[] = [];
const env = {
	...process.env,
	GIT_AUTHOR_NAME: "A",
	GIT_AUTHOR_EMAIL: "a@example.test",
	GIT_COMMITTER_NAME: "A",
	GIT_COMMITTER_EMAIL: "a@example.test",
};
function git(root: string, args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env }).trim();
}
function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "gitjig-basis-"));
	roots.push(root);
	git(root, ["init", "-q"]);
	git(root, ["config", "commit.gpgsign", "false"]);
	return root;
}
function commit(root: string, name: string, bytes: string | Buffer): string {
	writeFileSync(join(root, name), bytes);
	git(root, ["add", "--", name]);
	git(root, ["commit", "-qm", name]);
	return git(root, ["rev-parse", "HEAD"]);
}
type Finding = {
	finding: string;
	validity: "CONFIRMED" | "REFUTED";
	severity?: "SUBSTANTIVE" | "NIT";
	disposition: "repair" | "none" | "defer" | "measure-escalate";
};
function record(head: string, findings: Finding[], outcome: "repair" | "clear" = "repair"): ReviewRecord {
	return {
		head,
		slots: [],
		bundle: findings.map(({ finding }) => ({ finding, slot: { lens: "runtime", surface: "tree" } })),
		adjudication: {
			dedupAttested: true,
			rulings: findings.map(({ finding, validity, severity }) => ({
				finding,
				provenance: [{ lens: "runtime", surface: "tree" }],
				validity,
				...(severity === undefined ? {} : { severity }),
				evidence: `evidence ${finding}`,
			})),
		},
		review: {
			state: "resolved",
			resolution: {
				outcome,
				dispositions: findings.map(({ finding, disposition }) => ({ finding, disposition })),
			},
		},
	} as ReviewRecord;
}
function state(source: ReviewRecord): StateSummary {
	const outcome = source.review.state === "resolved" ? source.review.resolution.outcome : "approved";
	return {
		head: source.head,
		outcome,
		findings: source.bundle.map(({ finding }) => finding),
		rulings:
			source.adjudication?.rulings.map(({ finding, validity, severity, evidence }) => ({
				finding,
				validity,
				severity,
				evidence,
			})) ?? [],
		record: source,
	};
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("issue #238 repair-basis projection", () => {
	it("selects only the trailing repair run and exact confirmed substantive repair joins", async () => {
		const root = repo();
		const h1 = commit(root, "a.txt", "old\n");
		const h2 = commit(root, "reset.txt", "reset\n");
		const h3 = commit(root, "method.txt", "first\n");
		const h4 = commit(root, "method.txt", "second\n");
		const malformedBeforeReset = record(h1, [
			{ finding: "duplicate", validity: "CONFIRMED", severity: "SUBSTANTIVE", disposition: "repair" },
			{ finding: "duplicate", validity: "CONFIRMED", severity: "SUBSTANTIVE", disposition: "repair" },
		]);
		const included: Finding = {
			finding: "included",
			validity: "CONFIRMED",
			severity: "SUBSTANTIVE",
			disposition: "repair",
		};
		const excluded: Finding[] = [
			{ finding: "nit", validity: "CONFIRMED", severity: "NIT", disposition: "repair" },
			{ finding: "refuted", validity: "REFUTED", severity: "SUBSTANTIVE", disposition: "repair" },
			{ finding: "none", validity: "CONFIRMED", severity: "SUBSTANTIVE", disposition: "none" },
			{ finding: "defer", validity: "CONFIRMED", severity: "SUBSTANTIVE", disposition: "defer" },
			{ finding: "measure", validity: "CONFIRMED", severity: "SUBSTANTIVE", disposition: "measure-escalate" },
		];
		const basis = await deriveRepairBasis(root, [
			state(malformedBeforeReset),
			state(record(h2, [], "clear")),
			state(record(h3, [included, ...excluded])),
			state(record(h4, [included, ...excluded])),
		]);
		assert.ok(basis);
		assert.deepEqual(
			basis.states.map(({ head }) => head),
			[h3, h4],
		);
		assert.deepEqual(
			basis.states.map(({ findings }) => findings.map(({ finding }) => finding)),
			[["included"], ["included"]],
		);
		assert.equal(basis.intervals.length, 1);
		assert.deepEqual([basis.intervals[0].earlierHead, basis.intervals[0].laterHead], [h3, h4]);
		assert.ok(
			basis.intervals[0].entries.some((entry) => Buffer.from(entry.pathBase64, "base64").toString() === "method.txt"),
		);
	});

	it("applies the finite byte budget independently to every adjacent interval", async () => {
		const root = repo();
		const finding: Finding = {
			finding: "bounded",
			validity: "CONFIRMED",
			severity: "SUBSTANTIVE",
			disposition: "repair",
		};
		const a = commit(root, "large", Buffer.alloc(3 * 1024 * 1024, 1));
		const b = commit(root, "large", Buffer.alloc(6 * 1024 * 1024, 2));
		const c = commit(root, "large", Buffer.alloc(9 * 1024 * 1024, 3));
		const basis = await deriveRepairBasis(root, [
			state(record(a, [finding])),
			state(record(b, [finding])),
			state(record(c, [finding])),
		]);
		assert.equal(basis?.intervals.length, 2);
	});

	it("refuses reordered ruling and disposition populations", async () => {
		const root = repo();
		const a = commit(root, "a", "1");
		const b = commit(root, "a", "2");
		const findings: Finding[] = [
			{ finding: "first", validity: "CONFIRMED", severity: "SUBSTANTIVE", disposition: "repair" },
			{ finding: "second", validity: "CONFIRMED", severity: "SUBSTANTIVE", disposition: "repair" },
		];
		for (const mutate of [
			(record: ReviewRecord) => record.adjudication?.rulings.reverse(),
			(record: ReviewRecord) => record.review.state === "resolved" && record.review.resolution.dispositions.reverse(),
		]) {
			const first = record(a, findings);
			mutate(first);
			assert.equal(await deriveRepairBasis(root, [state(first), state(record(b, findings))]), undefined);
		}
	});

	it("refuses duplicate, missing, and cardinality-misaligned joins without a partial basis", async () => {
		const root = repo();
		const a = commit(root, "a", "1");
		const b = commit(root, "a", "2");
		const finding: Finding = { finding: "f", validity: "CONFIRMED", severity: "SUBSTANTIVE", disposition: "repair" };
		for (const mutate of [
			(record: ReviewRecord) => record.bundle.push(record.bundle[0]),
			(record: ReviewRecord) => record.adjudication?.rulings.pop(),
			(record: ReviewRecord) => record.review.state === "resolved" && record.review.resolution.dispositions.pop(),
		]) {
			const first = record(a, [finding]);
			mutate(first);
			assert.equal(await deriveRepairBasis(root, [state(first), state(record(b, [finding]))]), undefined);
		}
	});
});

describe("issue #238 canonical correction interval", () => {
	it("is independent of replace/graft metadata and retains binary bytes, rename delete/add, and gitlinks", async () => {
		const root = repo();
		const a = commit(root, "old.bin", Buffer.from([0, 255, 1]));
		git(root, ["mv", "old.bin", "new.bin"]);
		writeFileSync(join(root, "new.bin"), Buffer.from([2, 254, 3]));
		git(root, ["add", "-A"]);
		git(root, ["update-index", "--add", "--cacheinfo", `160000,${a},sub`]);
		git(root, ["commit", "-qm", "rename"]);
		const b = git(root, ["rev-parse", "HEAD"]);
		const replacement = commit(root, "other", "replacement");
		git(root, ["replace", b, replacement]);
		git(root, ["config", "diff.hostile.command", "false"]);
		mkdirSync(join(root, ".git", "info"), { recursive: true });
		writeFileSync(join(root, ".git", "info", "attributes"), "* diff=hostile\n");
		writeFileSync(join(root, ".git", "info", "grafts"), `${b} ${replacement}\n`);
		const interval = await readCorrectionInterval(root, a, b);
		assert.ok(interval);
		const paths = interval.entries.map((entry) => Buffer.from(entry.pathBase64, "base64").toString());
		assert.ok(paths.includes("old.bin") && paths.includes("new.bin") && paths.includes("sub"));
		const gitlink = interval.entries.find((entry) => Buffer.from(entry.pathBase64, "base64").toString() === "sub");
		assert.deepEqual(gitlink?.after, { mode: "160000", type: "commit", oid: a, bytesBase64: null });
		const added = interval.entries.find((entry) => Buffer.from(entry.pathBase64, "base64").toString() === "new.bin");
		assert.equal(added?.after?.bytesBase64, Buffer.from([2, 254, 3]).toString("base64"));
	});

	it("reads a merge endpoint as one complete tree rather than selecting a parent", async () => {
		const root = repo();
		const base = commit(root, "base", "base");
		const trunk = git(root, ["symbolic-ref", "--short", "HEAD"]);
		git(root, ["checkout", "-qb", "left"]);
		commit(root, "left", "left");
		git(root, ["checkout", "-q", trunk]);
		commit(root, "right", "right");
		git(root, ["merge", "--no-ff", "--no-gpg-sign", "-qm", "merge", "left"]);
		const merged = git(root, ["rev-parse", "HEAD"]);
		const interval = await readCorrectionInterval(root, base, merged);
		assert.ok(interval);
		assert.deepEqual(
			interval.entries.map((entry) => Buffer.from(entry.pathBase64, "base64").toString()),
			["left", "right"],
		);
	});

	it("admits a successful empty endpoint delta", async () => {
		const root = repo();
		const a = commit(root, "same", "value");
		git(root, ["commit", "--allow-empty", "-qm", "empty"]);
		const b = git(root, ["rev-parse", "HEAD"]);
		assert.deepEqual(await readCorrectionInterval(root, a, b), { earlierHead: a, laterHead: b, entries: [] });
	});

	it("refuses duplicate heads, non-commits, and non-ancestor endpoints", async () => {
		const root = repo();
		const base = commit(root, "base", "base");
		const a = commit(root, "a", "a");
		const blob = git(root, ["hash-object", "a"]);
		assert.equal(await readCorrectionInterval(root, a, a), undefined);
		assert.equal(await readCorrectionInterval(root, blob, a), undefined);
		git(root, ["checkout", "-qb", "other", base]);
		const other = commit(root, "other", "x");
		assert.equal(await readCorrectionInterval(root, a, other), undefined);
	});
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DispatchOutcome } from "../.pi/extensions/gitjig/dispatch/index.ts";
import { freshDiagnosisBrief } from "../.pi/extensions/gitjig/recovery/briefs.ts";
import {
	admitBasisDiagnosis,
	composeDiagnosisBrief,
	type DiagnosisInput,
	type RepairBasis,
} from "../.pi/extensions/gitjig/review/history.ts";
import {
	type CorrectionInterval,
	readCorrectionInterval,
	readCorrectionIntervals,
} from "../.pi/extensions/gitjig/review/interval.ts";

const roots: string[] = [];
const env = {
	...process.env,
	GIT_AUTHOR_NAME: "A",
	GIT_AUTHOR_EMAIL: "a@example.test",
	GIT_COMMITTER_NAME: "A",
	GIT_COMMITTER_EMAIL: "a@example.test",
};
function git(root: string, args: string[], input?: string): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env, input }).trim();
}
function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "gitjig-marker-"));
	roots.push(root);
	git(root, ["init", "-q", "-b", "main"]);
	git(root, ["config", "commit.gpgsign", "false"]);
	git(root, ["config", "maintenance.auto", "false"]);
	return root;
}
function commit(root: string, name: string, bytes: string): string {
	writeFileSync(join(root, name), bytes);
	git(root, ["add", "--", name]);
	git(root, ["commit", "-qm", name]);
	return git(root, ["rev-parse", "HEAD"]);
}
function marker(earlierHead: string, laterHead: string): CorrectionInterval {
	return { kind: "rewrite-marker", earlierHead, laterHead };
}
/** A chain of `count` commits on `main`, written in one fast-import. */
function longChain(root: string, count: number): string {
	const stream: string[] = [];
	for (let index = 1; index <= count; index += 1)
		stream.push(
			"commit refs/heads/main",
			`mark :${String(index)}`,
			"committer A <a@example.test> 0 +0000",
			"data 1",
			"c",
			...(index === 1 ? [] : [`from :${String(index - 1)}`]),
			`M 100644 inline f`,
			`data ${String(String(index).length)}`,
			String(index),
			"",
		);
	git(root, ["fast-import", "--quiet"], `${stream.join("\n")}\n`);
	return git(root, ["rev-parse", "main"]);
}
const basis = (intervals: CorrectionInterval[]): RepairBasis =>
	({
		states: [
			{ head: "a".repeat(40), findings: [] },
			{ head: "b".repeat(40), findings: [] },
		],
		intervals,
	}) as unknown as RepairBasis;
const admitted = (input: DiagnosisInput): DispatchOutcome =>
	({
		disposition: "admitted",
		ok: true,
		summary: "RESULT",
		payload: JSON.stringify(input),
		compare: "confirmed",
	}) as DispatchOutcome;
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("issue #437 the walk decides each pair (§1.4)", () => {
	it("marks a rebase pair: the walk completes without reaching the earlier head", async () => {
		const root = repo();
		const base = commit(root, "base", "0");
		git(root, ["checkout", "-qb", "topic"]);
		const before = commit(root, "topic", "repair");
		git(root, ["checkout", "-q", "main"]);
		commit(root, "base", "1");
		git(root, ["checkout", "-q", "topic"]);
		git(root, ["rebase", "-q", "main"]);
		const after = git(root, ["rev-parse", "HEAD"]);
		assert.notEqual(base, after);
		assert.deepEqual(await readCorrectionInterval(root, before, after), marker(before, after));
	});

	it("marks an ancestral pair whose range contains a base merge, never its tree delta", async () => {
		const root = repo();
		commit(root, "base", "0");
		git(root, ["checkout", "-qb", "topic"]);
		const before = commit(root, "topic", "first");
		git(root, ["checkout", "-q", "main"]);
		commit(root, "base", "base change");
		git(root, ["checkout", "-q", "topic"]);
		git(root, ["merge", "--no-ff", "--no-gpg-sign", "-qm", "merge main", "main"]);
		const after = commit(root, "topic", "second");
		assert.equal(git(root, ["merge-base", "--is-ancestor", before, after]), "");
		assert.deepEqual(await readCorrectionInterval(root, before, after), marker(before, after));
	});

	it("keeps the tree delta for a linear pair, including one whose earlier head is a merge", async () => {
		const root = repo();
		commit(root, "base", "0");
		git(root, ["checkout", "-qb", "side"]);
		commit(root, "side", "s");
		git(root, ["checkout", "-q", "main"]);
		git(root, ["merge", "--no-ff", "--no-gpg-sign", "-qm", "merge side", "side"]);
		const before = git(root, ["rev-parse", "HEAD"]);
		const after = commit(root, "topic", "t");
		const blob = git(root, ["rev-parse", `${after}:topic`]);
		assert.deepEqual(await readCorrectionInterval(root, before, after), {
			earlierHead: before,
			laterHead: after,
			entries: [
				{
					pathBase64: Buffer.from("topic").toString("base64"),
					before: null,
					after: { mode: "100644", type: "blob", oid: blob, bytesBase64: Buffer.from("t").toString("base64") },
				},
			],
		});
	});

	it("marks a pair whose earlier head is absent: the walk from the later head completes", async () => {
		const root = repo();
		commit(root, "a", "1");
		const later = commit(root, "a", "2");
		const absent = "e".repeat(40);
		assert.deepEqual(await readCorrectionInterval(root, absent, later), marker(absent, later));
	});

	it("withholds when the later head is absent: the walk cannot start", async () => {
		const root = repo();
		const earlier = commit(root, "a", "1");
		assert.equal(await readCorrectionInterval(root, earlier, "f".repeat(40)), undefined);
	});

	it("withholds, never marks, when a commit the walk must read is missing", async () => {
		const root = repo();
		const first = commit(root, "a", "1");
		const middle = commit(root, "a", "2");
		const last = commit(root, "a", "3");
		git(root, ["checkout", "-q", "--orphan", "other"]);
		const unrelated = commit(root, "b", "x");
		unlinkSync(join(root, ".git", "objects", middle.slice(0, 2), middle.slice(2)));
		assert.equal(await readCorrectionInterval(root, first, last), undefined, "linear chain broken");
		assert.equal(await readCorrectionInterval(root, unrelated, last), undefined, "non-ancestral walk broken");
	});

	it("withholds, never marks, when the completing walk past a merge meets a missing commit", async () => {
		const root = repo();
		commit(root, "base", "0");
		git(root, ["checkout", "-qb", "side"]);
		const lost = commit(root, "side", "1");
		commit(root, "side", "2");
		git(root, ["checkout", "-q", "main"]);
		commit(root, "main", "m");
		git(root, ["merge", "--no-ff", "--no-gpg-sign", "-qm", "merge side", "side"]);
		const merged = git(root, ["rev-parse", "HEAD"]);
		const absent = "e".repeat(40);
		assert.deepEqual(await readCorrectionInterval(root, absent, merged), marker(absent, merged));
		unlinkSync(join(root, ".git", "objects", lost.slice(0, 2), lost.slice(2)));
		assert.equal(await readCorrectionInterval(root, absent, merged), undefined);
	});

	it("withholds, never marks, at the commit cap and the deadline", async () => {
		const root = repo();
		const later = longChain(root, 3000);
		const absent = "e".repeat(40);
		const pairs = [{ earlierHead: absent, laterHead: later }];
		assert.deepEqual(await readCorrectionIntervals(root, pairs), [marker(absent, later)]);
		assert.equal(await readCorrectionIntervals(root, pairs, { runMs: 30_000, commitCap: 2999 }), undefined);
		assert.deepEqual(await readCorrectionIntervals(root, pairs, { runMs: 30_000, commitCap: 3000 }), [
			marker(absent, later),
		]);
		assert.equal(await readCorrectionIntervals(root, pairs, { runMs: 5, commitCap: 100_000 }), undefined);
	});
});

describe("issue #437 a marker run is never NONE (§1.4)", () => {
	const delta: CorrectionInterval = { earlierHead: "a".repeat(40), laterHead: "b".repeat(40), entries: [] };
	const marked = marker("a".repeat(40), "b".repeat(40));

	it("refuses NONE over a basis containing a marker and admits every other value", () => {
		const none = { value: "NONE", invalidation: "nothing", evidence: "e" } as const;
		const refused = admitBasisDiagnosis(basis([marked]), admitted(none));
		assert.ok(!refused.available && refused.disposition === "hand-off" && /never NONE/.test(refused.reason));
		assert.deepEqual(admitBasisDiagnosis(basis([delta]), admitted(none)), { available: true, diagnosis: none });
		for (const value of ["STAGNATION", "OSCILLATION", "INDETERMINATE"] as const) {
			const input = { value, invalidation: "nothing", evidence: "e" } as const;
			assert.deepEqual(admitBasisDiagnosis(basis([marked]), admitted(input)), { available: true, diagnosis: input });
		}
	});

	it("renders a marker and states the marker rule only over a basis containing one", () => {
		const context = { changeDescription: "change" };
		const markedBrief = composeDiagnosisBrief(basis([marked]), context);
		assert.match(markedBrief, /REWRITE MARKER: a rewrite or a merge lies between these heads/);
		assert.match(markedBrief, /a run containing a marker is never NONE/);
		assert.match(markedBrief, /INDETERMINATE otherwise/);
		assert.doesNotMatch(composeDiagnosisBrief(basis([delta]), context), /REWRITE MARKER/);
	});

	it("states the marker rule in the fresh recovery diagnosis brief over a marker basis", () => {
		const original = { value: "INDETERMINATE", invalidation: "nothing", evidence: "o" } as const;
		const spec = {
			kind: "measurement",
			question: "q",
			method: "m",
			expectedDiscriminator: "d",
			evidence: "e",
			nonMutating: true,
			notPreviouslyPresent: true,
		} as const;
		const result = { kind: "measurement-result", specDigest: "0".repeat(64), result: "r", evidence: "e" } as const;
		assert.match(
			freshDiagnosisBrief(original, basis([marked]), spec, result),
			/a run containing a marker is never NONE/,
		);
		assert.doesNotMatch(freshDiagnosisBrief(original, basis([delta]), spec, result), /REWRITE MARKER/);
	});
});

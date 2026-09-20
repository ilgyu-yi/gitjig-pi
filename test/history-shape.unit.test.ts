import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { evaluateHistoryShape, HistoryShapeRefusal } from "../.github/workflows/history-shape.mjs";

function command(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}
function commit(cwd: string, name: string): string {
	writeFileSync(join(cwd, name), name);
	command(cwd, "add", name);
	command(cwd, "commit", "-m", name);
	return command(cwd, "rev-parse", "HEAD");
}
function repository() {
	const cwd = mkdtempSync(join(tmpdir(), "history-shape-"));
	command(cwd, "init", "-b", "main");
	command(cwd, "config", "user.email", "test@example.invalid");
	command(cwd, "config", "user.name", "Test");
	command(cwd, "config", "commit.gpgsign", "false");
	const root = commit(cwd, "root");
	return { cwd, root };
}

describe("history-shape graph predicate", () => {
	it("passes a rebased topic", () => {
		const { cwd, root } = repository();
		command(cwd, "checkout", "-b", "topic");
		const head = commit(cwd, "topic");
		assert.deepEqual(evaluateHistoryShape({ baseSha: root, headSha: head, cwd }), {
			mergeBase: root,
			mergeCommits: [],
			pass: true,
		});
	});

	it("rejects a target backmerge", () => {
		const { cwd, root } = repository();
		command(cwd, "checkout", "-b", "topic");
		commit(cwd, "topic");
		command(cwd, "checkout", "main");
		const base = commit(cwd, "base");
		command(cwd, "checkout", "topic");
		command(cwd, "merge", "--no-ff", "main", "-m", "backmerge");
		const head = command(cwd, "rev-parse", "HEAD");
		const result = evaluateHistoryShape({ baseSha: base, headSha: head, cwd });
		assert.equal(result.mergeBase, base);
		assert.equal(result.pass, false);
		assert.deepEqual(result.mergeCommits, [head]);
		assert.notEqual(root, base);
	});

	it("rejects an internal topic merge regardless of its parents", () => {
		const { cwd, root } = repository();
		command(cwd, "checkout", "-b", "side");
		commit(cwd, "side");
		command(cwd, "checkout", "-b", "topic", root);
		commit(cwd, "topic");
		command(cwd, "merge", "--no-ff", "side", "-m", "internal");
		const head = command(cwd, "rev-parse", "HEAD");
		assert.equal(evaluateHistoryShape({ baseSha: root, headSha: head, cwd }).pass, false);
	});

	it("ignores a target-side landing merge already in base ancestry", () => {
		const { cwd, root } = repository();
		command(cwd, "checkout", "-b", "landed");
		commit(cwd, "landed");
		command(cwd, "checkout", "main");
		command(cwd, "merge", "--no-ff", "landed", "-m", "landing merge");
		const base = command(cwd, "rev-parse", "HEAD");
		command(cwd, "checkout", "-b", "topic");
		const head = commit(cwd, "next");
		const result = evaluateHistoryShape({ baseSha: base, headSha: head, cwd });
		assert.equal(result.pass, true);
		assert.deepEqual(result.mergeCommits, []);
		assert.notEqual(root, base);
	});

	it("refuses invalid operands and shallow history", () => {
		const { cwd, root } = repository();
		assert.throws(() => evaluateHistoryShape({ baseSha: "main", headSha: root, cwd }), HistoryShapeRefusal);
		const shallow = mkdtempSync(join(tmpdir(), "history-shape-shallow-"));
		command(shallow, "clone", "--depth=1", `file://${cwd}`, ".");
		const head = command(shallow, "rev-parse", "HEAD");
		assert.throws(() => evaluateHistoryShape({ baseSha: head, headSha: head, cwd: shallow }), /history is shallow/);
	});
});

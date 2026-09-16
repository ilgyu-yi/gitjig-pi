import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runPlatformRead } from "../.pi/extensions/gitjig/platform/read.ts";

const roots: string[] = [];
const originalPath = process.env.PATH;

function installGh(source: string): string {
	const root = mkdtempSync(join(tmpdir(), "gitjig-platform-read-"));
	roots.push(root);
	const executable = join(root, "gh");
	writeFileSync(executable, `#!${process.execPath}\n${source}\n`);
	chmodSync(executable, 0o755);
	process.env.PATH = `${root}:${originalPath ?? ""}`;
	return root;
}

afterEach(() => {
	process.env.PATH = originalPath;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bounded platform reader", () => {
	it("preserves a UTF-8 code point split across stdout chunks", async () => {
		const root = installGh(`
const bytes = Buffer.from("café", "utf8");
process.stdout.write(bytes.subarray(0, 4));
setTimeout(() => {
  process.stdout.write(bytes.subarray(4));
  process.exit(0);
}, 20);
`);
		assert.equal(await runPlatformRead([], root, { timeoutMs: 2_000, graceMs: 200, maxBytes: 1024 }), "café");
	});

	it("refuses output beyond the byte cap", async () => {
		const root = installGh('process.stdout.write("12345");');
		assert.equal(await runPlatformRead([], root, { timeoutMs: 2_000, graceMs: 200, maxBytes: 4 }), undefined);
	});

	it("kills a child that outlives the run bound", async () => {
		const root = installGh("setInterval(() => {}, 1000);");
		const started = Date.now();
		assert.equal(await runPlatformRead([], root, { timeoutMs: 30, graceMs: 200, maxBytes: 1024 }), undefined);
		assert.ok(Date.now() - started < 1000, "the hard-bound read must settle promptly");
	});

	it("admits stdout only from a successful child", async () => {
		const root = installGh('process.stdout.write("untrusted"); process.exit(2);');
		assert.equal(await runPlatformRead([], root, { timeoutMs: 2_000, graceMs: 200, maxBytes: 1024 }), undefined);
	});
});

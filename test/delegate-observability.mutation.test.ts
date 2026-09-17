import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "gitjig-observe-mutants-"));
after(() => rmSync(root, { recursive: true, force: true }));

function kill(name: string, from: string, to: string, probe: string): void {
	for (const variant of ["baseline", "mutant"] as const) {
		const box = mkdtempSync(join(root, `${name}-${variant}-`));
		cpSync(join(repository, ".pi/extensions/gitjig"), join(box, "gitjig"), { recursive: true });
		const target = join(box, "gitjig/dispatch/trace.ts");
		const source = readFileSync(target, "utf8");
		assert.equal(source.split(from).length, 2, `${name}: target must be unique`);
		if (variant === "mutant") writeFileSync(target, source.replace(from, to));
		writeFileSync(join(box, "probe.mjs"), probe);
		const result = spawnSync(process.execPath, [join(box, "probe.mjs")], { encoding: "utf8" });
		if (variant === "baseline") assert.equal(result.status, 0, `${name}: baseline failed\n${result.stderr}`);
		else assert.notEqual(result.status, 0, `${name}: mutant survived`);
	}
}

const imported = `import assert from "node:assert/strict"; import {BoundedDelegateTrace,TRACE_LINE_BYTES} from "./gitjig/dispatch/trace.ts";`;

describe("#132 named isolated observability mutants", () => {
	it("kills line-byte, ring-eviction, and stream-separation guard mutants", () => {
		kill(
			"line-byte-bound",
			"export const TRACE_LINE_BYTES = 8 * 1024;",
			"export const TRACE_LINE_BYTES = 80 * 1024;",
			`${imported} assert.equal(TRACE_LINE_BYTES,8192); const t=new BoundedDelegateTrace(); t.consume("stdout",Buffer.from("x".repeat(9000)+"\\n")); t.finish(); assert.equal(t.snapshot().counters.truncatedLines,1);`,
		);
		kill(
			"newest-twenty-lines",
			"export const TRACE_LINES = 20;",
			"export const TRACE_LINES = 200;",
			`${imported} const t=new BoundedDelegateTrace(); for(let i=0;i<21;i++)t.consume("stdout",Buffer.from(i+"\\n")); t.finish(); assert.equal(t.snapshot().lines.length,20);`,
		);
		kill(
			"stderr-attribution",
			"const line = { stream, text, truncated:",
			'const line = { stream: "stdout" as const, text, truncated:',
			`${imported} const t=new BoundedDelegateTrace(); t.consume("stderr",Buffer.from("marker\\n")); t.finish(); assert.equal(t.snapshot().lines[0].stream,"stderr");`,
		);
	});
});

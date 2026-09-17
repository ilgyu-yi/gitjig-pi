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

function kill(name: string, file: string, from: string, to: string, probe: string): void {
	for (const variant of ["baseline", "mutant"] as const) {
		const box = mkdtempSync(join(root, `${name}-${variant}-`));
		cpSync(join(repository, ".pi/extensions/gitjig"), join(box, "gitjig"), { recursive: true });
		const target = join(box, "gitjig/dispatch", file);
		const source = readFileSync(target, "utf8");
		assert.equal(source.split(from).length, 2, `${name}: target must be unique`);
		if (variant === "mutant") writeFileSync(target, source.replace(from, to));
		writeFileSync(join(box, "probe.mjs"), probe);
		const result = spawnSync(process.execPath, [join(box, "probe.mjs")], { encoding: "utf8", timeout: 10_000 });
		if (variant === "baseline") assert.equal(result.status, 0, `${name}: baseline failed\n${result.stderr}`);
		else assert.notEqual(result.status, 0, `${name}: mutant survived`);
	}
}

const imported = `import assert from "node:assert/strict"; import {BoundedDelegateTrace,TRACE_LINE_BYTES} from "./gitjig/dispatch/trace.ts";`;

describe("#132 named isolated observability mutants", () => {
	it("kills the bounded trace reduction mutants", () => {
		kill(
			"line-byte-bound",
			"trace.ts",
			"export const TRACE_LINE_BYTES = 8 * 1024;",
			"export const TRACE_LINE_BYTES = 80 * 1024;",
			`${imported} assert.equal(TRACE_LINE_BYTES,8192); const t=new BoundedDelegateTrace(); t.consume("stdout",Buffer.from("x".repeat(9000)+"\\n")); t.finish(); assert.equal(t.snapshot().counters.truncatedLines,1);`,
		);
		kill(
			"newest-twenty-lines",
			"trace.ts",
			"export const TRACE_LINES = 20;",
			"export const TRACE_LINES = 200;",
			`${imported} const t=new BoundedDelegateTrace(); for(let i=0;i<21;i++)t.consume("stdout",Buffer.from(i+"\\n")); t.finish(); assert.equal(t.snapshot().lines.length,20);`,
		);
		kill(
			"render-codepoint-bound",
			"trace.ts",
			"export const TRACE_RENDER_CODEPOINTS = 512;",
			"export const TRACE_RENDER_CODEPOINTS = 5_120;",
			`${imported} const t=new BoundedDelegateTrace(); t.consume("stdout",Buffer.from("🙂".repeat(513)+"\\n")); t.finish(); assert.equal([...t.snapshot().lines[0].text].length,512);`,
		);
		const retentionImport = `import assert from "node:assert/strict"; import {mkdtempSync,readdirSync} from "node:fs"; import {tmpdir} from "node:os"; import {join} from "node:path"; import {BoundedDelegateTrace,retainTrace,TRACE_DIRECTORY} from "./gitjig/dispatch/trace.ts"; const state=mkdtempSync(join(tmpdir(),"zq-retain-")); const snapshot=new BoundedDelegateTrace().snapshot("completed");`;
		kill(
			"retention-age-bound",
			"trace.ts",
			"export const TRACE_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;",
			"export const TRACE_RETAIN_MS = 70 * 24 * 60 * 60 * 1000;",
			`${retentionImport} assert.equal(retainTrace(state,snapshot,1),true); assert.equal(retainTrace(state,snapshot,604800002),true); assert.equal(readdirSync(join(state,TRACE_DIRECTORY)).length,1);`,
		);
		kill(
			"retention-count-bound",
			"trace.ts",
			"export const TRACE_RETAIN_COUNT = 50;",
			"export const TRACE_RETAIN_COUNT = 5;",
			`${retentionImport} for(let i=0;i<6;i++)assert.equal(retainTrace(state,snapshot,i),true); assert.equal(readdirSync(join(state,TRACE_DIRECTORY)).length,6);`,
		);
		kill(
			"stderr-attribution",
			"trace.ts",
			"const line = { stream, text, truncated:",
			'const line = { stream: "stdout" as const, text, truncated:',
			`${imported} const t=new BoundedDelegateTrace(); t.consume("stderr",Buffer.from("marker\\n")); t.finish(); assert.equal(t.snapshot().lines[0].stream,"stderr");`,
		);
	});

	it("kills start-update and update-coalescing mutants", () => {
		const executorImport = `import assert from "node:assert/strict"; import {mkdtempSync,mkdirSync} from "node:fs"; import {tmpdir} from "node:os"; import {join} from "node:path"; import {runDelegate} from "./gitjig/dispatch/executor.ts"; const tree=mkdtempSync(join(tmpdir(),"zq-observe-")); const stateDir=join(tree,"state"); mkdirSync(stateDir);`;
		kill(
			"start-update",
			"executor.ts",
			'emitTrace("running");',
			"void 0;",
			`${executorImport} const seen=[]; await runDelegate({treeDir:tree,stateDir},["sh","-c","sleep 0.2"],{timeoutMs:1000,onTrace:s=>seen.push(s)}); assert.equal(seen[0].lifecycle,"running"); assert.ok(seen.length>=2);`,
		);
		kill(
			"coalesced-update-bound",
			"trace.ts",
			"export const TRACE_UPDATE_MS = 100;",
			"export const TRACE_UPDATE_MS = 10_000;",
			`${executorImport} const seen=[]; await runDelegate({treeDir:tree,stateDir},["sh","-c","echo marker; sleep 0.3"],{timeoutMs:1000,onTrace:s=>seen.push(s)}); assert.ok(seen.some(s=>s.lifecycle==="running"&&s.lines.some(l=>l.text==="marker")));`,
		);
	});

	it("kills the child-only abort mutant", () => {
		kill(
			"abort-process-group",
			"executor.ts",
			"process.kill(-child.pid, signal);",
			"child.kill(signal);",
			`import assert from "node:assert/strict"; import {existsSync,mkdtempSync,mkdirSync,readFileSync} from "node:fs"; import {tmpdir} from "node:os"; import {join} from "node:path"; import {runDelegate} from "./gitjig/dispatch/executor.ts"; const tree=mkdtempSync(join(tmpdir(),"zq-group-")); const stateDir=join(tree,"state"); mkdirSync(stateDir); const c=new AbortController(); const run=runDelegate({treeDir:tree,stateDir},["sh","-c",'trap "" TERM; sleep 30 & echo $! > child.pid; wait'],{timeoutMs:10000,signal:c.signal}); for(let i=0;i<100&&!existsSync(join(tree,"child.pid"));i++)await new Promise(r=>setTimeout(r,10)); const pid=Number(readFileSync(join(tree,"child.pid"),"utf8")); c.abort(); await run; let alive=true; try{process.kill(pid,0)}catch{alive=false} if(alive)process.kill(pid,"SIGKILL"); assert.equal(alive,false);`,
		);
	});
});

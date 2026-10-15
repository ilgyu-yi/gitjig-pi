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
			`${retentionImport} assert.equal(typeof retainTrace(state,snapshot,1),"string"); assert.equal(typeof retainTrace(state,snapshot,604800002),"string"); assert.equal(readdirSync(join(state,TRACE_DIRECTORY)).length,1);`,
		);
		kill(
			"retention-count-bound",
			"trace.ts",
			"export const TRACE_RETAIN_COUNT = 50;",
			"export const TRACE_RETAIN_COUNT = 5;",
			`${retentionImport} for(let i=0;i<6;i++)assert.equal(typeof retainTrace(state,snapshot,i),"string"); assert.equal(readdirSync(join(state,TRACE_DIRECTORY)).length,6);`,
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

	it("kills the child-only abort mutant at the TERM/KILL arm's reap wait, every other assertion passing", () => {
		// The arm itself runs against a private copy, unmutated then mutated: the
		// mutant must fail on the reap wait's own message alone (#426).
		const ARM = "propagates TERM then KILL to the child group without misclassifying abort as timeout";
		const TEST = "test/delegate-observability.unit.test.ts";
		for (const variant of ["baseline", "mutant"] as const) {
			const box = mkdtempSync(join(root, `abort-process-group-${variant}-`));
			cpSync(join(repository, ".pi/extensions/gitjig"), join(box, ".pi/extensions/gitjig"), { recursive: true });
			cpSync(join(repository, TEST), join(box, TEST));
			const target = join(box, ".pi/extensions/gitjig/dispatch/executor.ts");
			const source = readFileSync(target, "utf8");
			const groupSignal = "process.kill(-child.pid, signal);";
			assert.notEqual(source.indexOf(groupSignal), -1, "the group signal must exist");
			assert.equal(source.indexOf(groupSignal), source.lastIndexOf(groupSignal), "the group signal must be unique");
			if (variant === "mutant")
				writeFileSync(
					target,
					source.replace(groupSignal, () => "child.kill(signal);"),
				);
			const env = { ...process.env };
			delete env.NODE_TEST_CONTEXT;
			const result = spawnSync(process.execPath, ["--test", "--test-name-pattern", ARM, TEST], {
				cwd: box,
				encoding: "utf8",
				timeout: 30_000,
				env,
			});
			const output = `${result.stdout}${result.stderr}`;
			assert.match(output, /^ℹ tests 1$/m, `${variant}: the arm alone runs\n${output}`);
			if (variant === "baseline") {
				assert.equal(result.status, 0, `baseline failed\n${output}`);
				continue;
			}
			assert.notEqual(result.status, 0, "the child-only abort mutant survived");
			assert.match(output, /^ℹ fail 1$/m, output);
			assert.match(
				output,
				/grandchild \d+ outlived the \d+ms reap bound/,
				`the mutant failed before the reap wait\n${output}`,
			);
		}
	});
	it("kills the escalation-cancelled-at-settlement mutant at the pipe-less descendant arm's last assertion, every other assertion passing", () => {
		// #448: the arm itself runs against a private copy, unmutated then mutated;
		// the mutant must fail on the escalation assertion's own message alone.
		const ARM =
			"ends a SIGTERM-ignoring, pipe-less descendant by the abort's SIGKILL after the grace, even once the run has settled";
		const TEST = "test/delegate-observability.unit.test.ts";
		const escalation = 'setTimeout(() => killGroup("SIGKILL"), STREAM_GRACE_MS);';
		for (const variant of ["baseline", "mutant"] as const) {
			const box = mkdtempSync(join(root, `abort-escalation-${variant}-`));
			cpSync(join(repository, ".pi/extensions/gitjig"), join(box, ".pi/extensions/gitjig"), { recursive: true });
			cpSync(join(repository, TEST), join(box, TEST));
			const target = join(box, ".pi/extensions/gitjig/dispatch/executor.ts");
			const source = readFileSync(target, "utf8");
			assert.notEqual(source.indexOf(escalation), -1, "the escalation must exist");
			assert.equal(source.indexOf(escalation), source.lastIndexOf(escalation), "the escalation must be unique");
			if (variant === "mutant")
				writeFileSync(
					target,
					source.replace(
						escalation,
						() => 'setTimeout(() => { if (!settled) killGroup("SIGKILL"); }, STREAM_GRACE_MS);',
					),
				);
			const env = { ...process.env };
			delete env.NODE_TEST_CONTEXT;
			const result = spawnSync(process.execPath, ["--test", "--test-name-pattern", ARM, TEST], {
				cwd: box,
				encoding: "utf8",
				timeout: 30_000,
				env,
			});
			const output = `${result.stdout}${result.stderr}`;
			assert.match(output, /^ℹ tests 1$/m, `${variant}: the arm alone runs\n${output}`);
			if (variant === "baseline") {
				assert.equal(result.status, 0, `baseline failed\n${output}`);
				continue;
			}
			assert.notEqual(result.status, 0, "the escalation-cancelled-at-settlement mutant survived");
			assert.match(output, /^ℹ fail 1$/m, output);
			assert.match(
				output,
				/descendant \d+ outlived the abort's SIGKILL escalation/,
				`the mutant failed elsewhere\n${output}`,
			);
		}
	});
	it("kills the unref'd-escalation mutant at the idle-host arm's last assertion, every other assertion passing", () => {
		// #448 R3: an unref'd escalation lets an otherwise idle host exit before
		// the SIGKILL; the host arm itself runs against a private copy.
		const ARM = "keeps an otherwise idle host alive until the abort's SIGKILL, so the descendant does not outlive it";
		const TEST = "test/delegate-observability.unit.test.ts";
		const escalation = 'setTimeout(() => killGroup("SIGKILL"), STREAM_GRACE_MS);';
		for (const variant of ["baseline", "mutant"] as const) {
			const box = mkdtempSync(join(root, `unref-escalation-${variant}-`));
			cpSync(join(repository, ".pi/extensions/gitjig"), join(box, ".pi/extensions/gitjig"), { recursive: true });
			cpSync(join(repository, TEST), join(box, TEST));
			const target = join(box, ".pi/extensions/gitjig/dispatch/executor.ts");
			const code = readFileSync(target, "utf8");
			assert.notEqual(code.indexOf(escalation), -1, "the escalation must exist");
			assert.equal(code.indexOf(escalation), code.lastIndexOf(escalation), "the escalation must be unique");
			if (variant === "mutant")
				writeFileSync(
					target,
					code.replace(escalation, () => 'setTimeout(() => killGroup("SIGKILL"), STREAM_GRACE_MS).unref();'),
				);
			const env = { ...process.env };
			delete env.NODE_TEST_CONTEXT;
			const result = spawnSync(process.execPath, ["--test", "--test-name-pattern", ARM, TEST], {
				cwd: box,
				encoding: "utf8",
				timeout: 30_000,
				env,
			});
			const output = `${result.stdout}${result.stderr}`;
			assert.match(output, /^ℹ tests 1$/m, `${variant}: the arm alone runs\n${output}`);
			if (variant === "baseline") {
				assert.equal(result.status, 0, `baseline failed\n${output}`);
				continue;
			}
			assert.notEqual(result.status, 0, "the unref'd-escalation mutant survived");
			assert.match(output, /^ℹ fail 1$/m, output);
			assert.match(output, /descendant \d+ outlived the host/, `the mutant failed elsewhere\n${output}`);
		}
	});
});

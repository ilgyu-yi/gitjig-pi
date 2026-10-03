/**
 * #416 (part 4 of #370): the Pi RPC subprocess supervisor SPEC §4.9's Pi
 * clause requires. Every arm drives a fake Pi written here, so nothing in
 * this file needs an installed Pi, a provider credential or a network.
 *
 * The supervisor has no caller in this part. What is measured is therefore
 * the module's own surface: the spawn shape it gives the child, the
 * parameters it refuses before any child exists, which terminal wins when
 * several are available, that a terminal settles every pending correlated
 * request, and that nothing the child writes reaches a value the caller
 * reads. The four scenario functions near the bottom are shared by the
 * baseline arms and the private-copy mutants, so each mutant is measured
 * against the same observation the baseline pinned, not against a second
 * description of it.
 */
import assert from "node:assert/strict";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startPiRpc } from "../.pi/extensions/gitjig/dispatch/pi-rpc.ts";
import type { DispatchContext } from "../.pi/extensions/gitjig/dispatch/provision.ts";

type Start = typeof startPiRpc;

const MODULE_RELATIVE = ".pi/extensions/gitjig/dispatch/pi-rpc.ts";
const modulePath = fileURLToPath(new URL(`../${MODULE_RELATIVE}`, import.meta.url));
const extensionsRoot = fileURLToPath(new URL("../.pi", import.meta.url));

/** A DispatchContext over a scratch whose tree and state directories exist. */
function supervisorContext(scratch: string): DispatchContext {
	const tree = join(scratch, "tree");
	const state = join(scratch, "state");
	mkdirSync(tree, { recursive: true });
	mkdirSync(state, { recursive: true });
	return {
		scratchRoot: scratch,
		treeDir: tree,
		stateDir: state,
		briefPath: join(scratch, "brief.md"),
		returnPath: join(scratch, "return.json"),
		heldHash: "a".repeat(40),
	};
}

/** A trusted extension path: a regular file in the scratch, outside the clone. */
function trustedExtensionFile(scratch: string): string {
	const path = join(scratch, "trusted.ts");
	writeFileSync(path, "// trusted scratch placeholder\n");
	return path;
}

function fakePi(path: string, body: string): string {
	writeFileSync(path, `#!/usr/bin/env node\n${body}`, { mode: 0o700 });
	chmodSync(path, 0o700);
	return path;
}

/** The parameter set every arm starts from; each arm overrides what it tests. */
function parameters(context: DispatchContext, extension: string, executable: string) {
	return {
		context,
		extensionPath: extension,
		piExecutable: executable,
		provider: "scripted",
		model: "scripted-model",
		prompt: "test",
		timeoutMs: 4000,
	};
}

/** Wait, bounded, for a predicate; returns whether it became true. */
async function settled(predicate: () => boolean, attempts = 200): Promise<boolean> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return predicate();
}

/** Wait, bounded, for one pid to stop existing; returns whether it is gone. */
async function reaped(pid: number): Promise<boolean> {
	return settled(() => {
		try {
			process.kill(pid, 0);
			return false;
		} catch {
			return true;
		}
	}, 160);
}

function kill(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {}
}

/**
 * Run `scenario` against a private copy of the whole `.pi` subtree in which
 * one exact statement of the supervisor is replaced. The subtree is copied
 * whole because the module imports its siblings relatively; a single-file
 * copy would not resolve `./provision.ts`.
 */
async function withMutant<T>(
	edits: ReadonlyArray<readonly [string, string]>,
	scenario: (start: Start) => Promise<T>,
): Promise<T> {
	const source = readFileSync(modulePath, "utf8");
	let mutated = source;
	for (const [anchor, replacement] of edits) {
		assert.notEqual(source.indexOf(anchor), -1, `mutation anchor must exist: ${anchor}`);
		assert.equal(source.indexOf(anchor), source.lastIndexOf(anchor), `mutation anchor must be unique: ${anchor}`);
		mutated = mutated.replace(anchor, () => replacement);
	}
	assert.notEqual(mutated, source, "the mutation changed nothing");
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-mutant-"));
	try {
		const root = join(scratch, ".pi");
		cpSync(extensionsRoot, root, { recursive: true });
		const mutant = join(root, "extensions/gitjig/dispatch/pi-rpc.ts");
		writeFileSync(mutant, mutated);
		const imported: { startPiRpc: Start } = await import(pathToFileURL(mutant).href);
		return await scenario(imported.startPiRpc);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/*
 * The four shared scenarios. Each returns observations only — no assertion
 * inside, so the baseline arm and the mutant arm read the same measurement.
 */

/**
 * A fake that puts a grandchild in its own process group's reach, answers
 * every correlated request so nothing refuses the protocol, and then hangs.
 * The grandchild installs a SIGTERM handler and records receiving one.
 */
async function abortGroupScenario(
	start: Start,
): Promise<{ outcome: string; grandchildGone: boolean; grandchildSawSigterm: boolean }> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-abort-group-"));
	const pidFile = join(scratch, "grandchild.pid");
	const termFile = join(scratch, "grandchild.sigterm");
	const readyFile = join(scratch, "grandchild.ready");
	let pid = 0;
	try {
		const context = supervisorContext(scratch);
		const grandchild =
			'const fs = require("node:fs");' +
			`process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(termFile)}, "sigterm"); process.exit(0); });` +
			// The readiness marker is written only once the handler is installed,
			// so the abort below can never race the grandchild's startup.
			`fs.writeFileSync(${JSON.stringify(readyFile)}, "ready");` +
			"setInterval(() => {}, 1000);";
		const executable = fakePi(
			join(scratch, "fake-pi"),
			'const cp = require("node:child_process"), fs = require("node:fs");\n' +
				`const kid = cp.spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });\n` +
				`fs.writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid));\n` +
				'let buffer = "";\n' +
				'process.stdin.on("data", (chunk) => {\n' +
				"	buffer += chunk;\n" +
				'	for (let end = buffer.indexOf("\\n"); end >= 0; end = buffer.indexOf("\\n")) {\n' +
				"		const line = buffer.slice(0, end);\n" +
				"		buffer = buffer.slice(end + 1);\n" +
				"		let request;\n" +
				"		try {\n" +
				"			request = JSON.parse(line);\n" +
				"		} catch {\n" +
				"			continue;\n" +
				"		}\n" +
				"		if (request && request.id !== undefined)\n" +
				'			process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, success: true })}\\n`);\n' +
				"	}\n" +
				"});\n" +
				"setInterval(() => {}, 1000);\n",
		);
		const controller = new AbortController();
		const session = start({
			...parameters(context, trustedExtensionFile(scratch), executable),
			timeoutMs: 15_000,
			signal: controller.signal,
		});
		await settled(() => existsSync(pidFile) && existsSync(readyFile));
		assert.equal(existsSync(pidFile), true, "the fake never recorded a grandchild");
		assert.equal(existsSync(readyFile), true, "the grandchild never installed its SIGTERM handler");
		pid = Number(readFileSync(pidFile, "utf8"));
		assert.ok(Number.isInteger(pid) && pid > 1, `no grandchild pid recorded: ${pid}`);
		controller.abort();
		const outcome = await session.done;
		return { outcome, grandchildGone: await reaped(pid), grandchildSawSigterm: existsSync(termFile) };
	} finally {
		if (pid > 1) kill(pid);
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * A fake that answers the prompt, leaves an orphan holding the stdout pipe
 * open past its own exit, and exits 17. An operator abort arrives while the
 * pipe is still held, after the numeric exit was observed.
 */
async function exitOwnsLifecycleScenario(start: Start): Promise<{ outcome: string; exitCode: number | null }> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-exit-owns-"));
	try {
		const context = supervisorContext(scratch);
		const executable = fakePi(
			join(scratch, "fake-pi"),
			`const cp=require('node:child_process');let received='';
process.stdin.on('data',chunk=>{
 received+=chunk;let at;while((at=received.indexOf('\\n'))!==-1){
  const item=JSON.parse(received.slice(0,at));received=received.slice(at+1);
  if(item.type==='prompt'){
   process.stdout.write(JSON.stringify({type:'response',id:item.id,success:true})+'\\n',()=>{
    const orphan=cp.spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),1600)'],{detached:true,stdio:['ignore',1,'ignore']});
    orphan.unref();process.exit(17);
   });
  }
 }
});
`,
		);
		const controller = new AbortController();
		const laterAbort = setTimeout(() => controller.abort(), 1000);
		try {
			const session = start({
				...parameters(context, trustedExtensionFile(scratch), executable),
				timeoutMs: 800,
				signal: controller.signal,
			});
			const outcome = await session.done;
			return { outcome, exitCode: session.exitCode };
		} finally {
			clearTimeout(laterAbort);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * Every extension path the gate must refuse, plus the sanctioned shape, so
 * the refusals fail for their own reason rather than because nothing starts.
 */
async function extensionGateScenario(
	start: Start,
): Promise<{ refusedPaths: number; refusedProviderPaths: number; candidates: number; sanctionedStarted: boolean }> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-gate-"));
	const outside = mkdtempSync(join(tmpdir(), "gitjig-416-outside-"));
	try {
		const context = supervisorContext(scratch);
		const good = trustedExtensionFile(scratch);
		const cloneOwned = join(context.treeDir, "clone-extension.ts");
		writeFileSync(cloneOwned, "// the reviewed clone's own file\n");
		const outsideFile = join(outside, "outside-extension.ts");
		writeFileSync(outsideFile, "// outside the scratch\n");
		const directory = join(scratch, "extension-directory");
		mkdirSync(directory);
		const link = join(scratch, "link-to-clone.ts");
		symlinkSync(cloneOwned, link);
		const escaping = join(scratch, "link-to-outside.ts");
		symlinkSync(outsideFile, escaping);
		const refused = [cloneOwned, outsideFile, directory, link, escaping, join(scratch, "absent.ts")];
		const refuses = (extension: string, provider?: string): boolean => {
			try {
				start({
					...parameters(context, extension, join(scratch, "never-spawned")),
					...(provider === undefined ? {} : { providerExtensionPath: provider }),
					timeoutMs: 1000,
				}).abort();
				return false;
			} catch (error) {
				return error instanceof Error && error.message === "Pi RPC parameters refused";
			}
		};
		// The provider extension rides the same gate, so each path is offered twice.
		const refusedPaths = refused.filter((path) => refuses(path)).length;
		const refusedProviderPaths = refused.filter((path) => refuses(good, path)).length;
		let sanctionedStarted = false;
		try {
			// The executable does not exist, which the session reports as a
			// refusal terminal rather than as a parameter throw.
			const session = start(parameters(context, good, join(scratch, "never-spawned")));
			sanctionedStarted = typeof session.done.then === "function";
			session.abort();
			await session.done;
		} catch {
			sanctionedStarted = false;
		}
		return { refusedPaths, refusedProviderPaths, candidates: refused.length, sanctionedStarted };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
}

/**
 * A silent but live fake: the initial prompt is never answered, so a command
 * issued after it is still pending when the operator aborts. The bound below
 * is what separates "the terminal settled it" from "its own 5 s command
 * timeout settled it".
 */
async function pendingSettleScenario(start: Start): Promise<{ resolution: boolean | "unresolved"; outcome: string }> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-pending-"));
	try {
		const context = supervisorContext(scratch);
		const executable = fakePi(join(scratch, "fake-pi"), "process.stdin.resume();\nsetInterval(() => {}, 1000);\n");
		const controller = new AbortController();
		const session = start({
			...parameters(context, trustedExtensionFile(scratch), executable),
			timeoutMs: 15_000,
			signal: controller.signal,
		});
		const command = session.command("steer", "unanswered");
		await new Promise((resolve) => setTimeout(resolve, 100));
		controller.abort();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const resolution = await Promise.race([
			command,
			new Promise<"unresolved">((resolve) => {
				timer = setTimeout(() => resolve("unresolved"), 2500);
			}),
		]);
		if (timer !== undefined) clearTimeout(timer);
		return { resolution, outcome: await session.done };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * Every repository-locating variable `withoutRepoLocatingGitEnv` removes. The
 * arm injects all of them and the child reports all of them, so a scrub that
 * drops only the obvious one is not admitted.
 */
const REPOSITORY_LOCATING = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_COMMON_DIR",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
] as const;

async function spawnShapeScenario(start: Start): Promise<{
	argv: string[];
	cwd: string;
	pid: number;
	pgid: number;
	stateRoot?: string;
	git: Record<string, string>;
	extension: string;
	treeDir: string;
	stateDir: string;
}> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-spawn-"));
	const before = Object.fromEntries(REPOSITORY_LOCATING.map((name) => [name, process.env[name]]));
	try {
		const context = supervisorContext(scratch);
		const report = join(scratch, "spawn.json");
		const executable = fakePi(
			join(scratch, "fake-pi"),
			'const fs = require("node:fs");\n' +
				`fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({\n` +
				"	argv: process.argv.slice(2),\n" +
				"	cwd: process.cwd(),\n" +
				"	pid: process.pid,\n" +
				// Node exposes no getpgid, so the child asks the platform for its own
				// group id; a detached child is the leader of its own group.
				'	pgid: Number(require("node:child_process").execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim()),\n' +
				"	stateRoot: process.env.GITJIG_TEST_STATE_ROOT,\n" +
				`	git: Object.fromEntries(${JSON.stringify(REPOSITORY_LOCATING)}.map((name) => [name, process.env[name] ?? "absent"])),\n` +
				"}));\n" +
				"process.exit(0);\n",
		);
		// Every ambient repository-locating variable the scrub must not pass on.
		for (const name of REPOSITORY_LOCATING) process.env[name] = `ambient-${name}`;
		const extension = trustedExtensionFile(scratch);
		const session = start({ ...parameters(context, extension, executable), timeoutMs: 6000 });
		await session.done;
		await settled(() => existsSync(report));
		const observed = JSON.parse(readFileSync(report, "utf8")) as {
			argv: string[];
			cwd: string;
			pid: number;
			pgid: number;
			stateRoot?: string;
			git: Record<string, string>;
		};
		// Resolved here, before the scratch is removed below: a scratch under
		// /tmp reaches the child through a symlink on this platform, so the two
		// spellings are compared after realpath on both sides.
		return {
			...observed,
			cwd: realpathSync(observed.cwd),
			extension,
			treeDir: realpathSync(context.treeDir),
			stateDir: context.stateDir,
		};
	} finally {
		for (const [name, value] of Object.entries(before))
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		rmSync(scratch, { recursive: true, force: true });
	}
}

test("the child is spawned detached in the clone with a scrubbed env and no project extension discovery", async () => {
	const observed = await spawnShapeScenario(startPiRpc);
	assert.deepEqual(observed.argv, [
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-approve",
		"--extension",
		observed.extension,
		"--provider",
		"scripted",
		"--model",
		"scripted-model",
	]);
	assert.equal(observed.cwd, observed.treeDir, "the child did not run in the clone");
	// Detached: the child leads its own group, which is what makes the
	// group signals in the abort and bound arms reach its descendants.
	assert.equal(observed.pgid, observed.pid, "the child did not lead its own process group");
	assert.equal(observed.stateRoot, observed.stateDir, "the state seam was not set for the child");
	// Not one of them reaches the child, not just the obvious one.
	assert.deepEqual(
		observed.git,
		Object.fromEntries(REPOSITORY_LOCATING.map((name) => [name, "absent"])),
		"an ambient repository-locating variable reached the child",
	);
});

test("baseline-first private-copy mutant: a partial environment scrub passes one of them through", async () => {
	const baseline = await spawnShapeScenario(startPiRpc);
	assert.equal(
		Object.values(baseline.git).every((value) => value === "absent"),
		true,
	);
	// The scrub replaced by a copy that deletes only the obvious variable: the
	// arm must see the other six arrive.
	const mutant = await withMutant(
		[["const env = withoutRepoLocatingGitEnv(process.env);", "const env = { ...process.env };\n\tdelete env.GIT_DIR;"]],
		spawnShapeScenario,
	);
	assert.deepEqual(
		Object.entries(mutant.git)
			.filter(([, value]) => value !== "absent")
			.map(([name]) => name),
		REPOSITORY_LOCATING.filter((name) => name !== "GIT_DIR"),
		"the mutant scrubbed more than GIT_DIR, so the arm measures nothing",
	);
});

test("the parameter preflight throws before any child exists for every refused shape", () => {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-params-"));
	try {
		const context = supervisorContext(scratch);
		const extension = trustedExtensionFile(scratch);
		const executable = join(scratch, "never-spawned");
		const base = parameters(context, extension, executable);
		const refused: ReadonlyArray<readonly [string, Partial<Parameters<Start>[0]>]> = [
			["timeout NaN", { timeoutMs: Number.NaN }],
			["timeout infinite", { timeoutMs: Number.POSITIVE_INFINITY }],
			["timeout zero", { timeoutMs: 0 }],
			["timeout negative", { timeoutMs: -1 }],
			["timeout past int32", { timeoutMs: 2_147_483_648 }],
			["empty prompt", { prompt: "" }],
			["empty provider", { provider: "" }],
			["provider with a path separator", { provider: "scripted/evil" }],
			["provider with a space", { provider: "scripted provider" }],
			["provider starting with a dot", { provider: ".scripted" }],
			["overlong provider", { provider: `a${"b".repeat(128)}` }],
			["empty model", { model: "" }],
			["model with a newline", { model: "scripted\nmodel" }],
			["overlong model", { model: `a${"b".repeat(128)}` }],
		];
		for (const [label, override] of refused)
			assert.throws(() => startPiRpc({ ...base, ...override }), /^Error: Pi RPC parameters refused$/, label);
		// The bounds themselves are inclusive at their admitted edge, so the
		// arms above refuse for the stated reason and not for an off-by-one.
		for (const [label, override] of [
			["timeout at the int32 ceiling", { timeoutMs: 2_147_483_647 }],
			["provider at 128 characters", { provider: `a${"b".repeat(127)}` }],
			["model at 128 characters", { model: `a${"b".repeat(127)}` }],
		] as ReadonlyArray<readonly [string, Partial<Parameters<Start>[0]>]>) {
			const session = startPiRpc({ ...base, ...override });
			assert.equal(typeof session.done.then, "function", label);
			session.abort();
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("the trusted extension path must be a scratch-local regular file outside the clone", async () => {
	const observed = await extensionGateScenario(startPiRpc);
	assert.equal(observed.refusedPaths, observed.candidates, "an extension path the gate must refuse was accepted");
	assert.equal(
		observed.refusedProviderPaths,
		observed.candidates,
		"a provider extension path the gate must refuse was accepted",
	);
	assert.equal(observed.sanctionedStarted, true, "the sanctioned shape did not start");
});

test("an observed numeric exit owns the terminal through an orphan-held pipe flush and a later abort", async () => {
	const observed = await exitOwnsLifecycleScenario(startPiRpc);
	assert.deepEqual(observed, { outcome: "exited", exitCode: 17 });
});

test("framing validity outranks the exit: an orphan's malformed frame during the flush refuses the run", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-late-frame-"));
	try {
		const context = supervisorContext(scratch);
		// The same shape as the exit-ownership arm — answer, orphan the stdout
		// pipe, exit 17 — except that the orphan writes a malformed frame while
		// the flush grace runs. §4.9 makes malformed framing refuse the run, so
		// the recorded numeric exit takes precedence over the still-armed bound
		// and a later abort but never over the stream's own validity.
		const executable = fakePi(
			join(scratch, "fake-pi"),
			`const cp=require('node:child_process');let received='';
process.stdin.on('data',chunk=>{
 received+=chunk;let at;while((at=received.indexOf('\\n'))!==-1){
  const item=JSON.parse(received.slice(0,at));received=received.slice(at+1);
  if(item.type==='prompt'){
   process.stdout.write(JSON.stringify({type:'response',id:item.id,success:true})+'\\n',()=>{
    const orphan=cp.spawn(process.execPath,['-e','setTimeout(()=>{process.stdout.write("{invalid\\\\n");process.exit(0)},300)'],{detached:true,stdio:['ignore',1,'ignore']});
    orphan.unref();process.exit(17);
   });
  }
 }
});
`,
		);
		const session = startPiRpc({
			...parameters(context, trustedExtensionFile(scratch), executable),
			timeoutMs: 15_000,
		});
		assert.equal(await session.done, "protocol-invalid");
		// The exit itself is still reported; what the frame changes is the outcome.
		assert.equal(session.exitCode, 17);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

/**
 * A child that writes a record no LF ever framed and then exits numerically.
 * §4.9 refuses malformed *or unfinished* framing, and the two reach the
 * outcome by different paths: malformed data refuses as it is read, while an
 * unfinished tail is only discovered when the stream is finished at the end.
 */
async function unfinishedFrameScenario(start: Start): Promise<{ outcome: string; exitCode: number | null }> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-unfinished-"));
	try {
		const context = supervisorContext(scratch);
		const executable = fakePi(
			join(scratch, "fake-pi"),
			`let received='';
process.stdin.on('data',chunk=>{
 received+=chunk;let at;while((at=received.indexOf('\\n'))!==-1){
  const item=JSON.parse(received.slice(0,at));received=received.slice(at+1);
  if(item.type==='prompt'){
   process.stdout.write(JSON.stringify({type:'response',id:item.id,success:true})+'\\n');
   // A whole, parseable record that no terminator ever framed.
   process.stdout.write(JSON.stringify({type:'agent_settled'}),()=>process.exit(5));
  }
 }
});
`,
		);
		const session = start({
			...parameters(context, trustedExtensionFile(scratch), executable),
			timeoutMs: 15_000,
		});
		return { outcome: await session.done, exitCode: session.exitCode };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * §4.9: "A settled agent or successful RPC response is not a return." The
 * settle half is the arm below; this is the response half. A correlated
 * success answers its own command and nothing else — it is not a terminal, not
 * a result, and installs no return slot.
 */
async function successResponseScenario(
	start: Start,
): Promise<{ accepted: boolean; settleCount: number; returnInstalled: boolean; state: string }> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-success-"));
	try {
		const context = supervisorContext(scratch);
		const executable = fakePi(
			join(scratch, "fake-pi"),
			`let data='';
process.stdin.on('data',chunk=>{data+=chunk;let at;
 while((at=data.indexOf('\\n'))!==-1){
  const command=JSON.parse(data.slice(0,at));data=data.slice(at+1);
  // Every command succeeds, and the child keeps running: a success is an
  // answer to one request, never a statement about the run.
  process.stdout.write(JSON.stringify({type:'response',id:command.id,success:true})+'\\n');
 }
});
setInterval(() => {}, 1000);
`,
		);
		const session = start({
			...parameters(context, trustedExtensionFile(scratch), executable),
			timeoutMs: 15_000,
		});
		const accepted = await session.command("steer", "answered");
		let timer: ReturnType<typeof setTimeout> | undefined;
		const state = await Promise.race([
			session.done,
			new Promise<"pending">((resolve) => {
				timer = setTimeout(() => resolve("pending"), 500);
			}),
		]);
		if (timer !== undefined) clearTimeout(timer);
		const observed = {
			accepted,
			settleCount: session.settleCount,
			returnInstalled: existsSync(context.returnPath),
			state,
		};
		session.abort();
		await session.done;
		return observed;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * §4.9 requires explicit steer, follow-up and queue-clear to operate on the
 * child. What reaches the child is the only place that is observable, so this
 * scenario records every frame the child actually received: nothing else in
 * this file would notice a command routed to the wrong type.
 */
async function commandRoutingScenario(
	start: Start,
): Promise<{ frames: { id?: unknown; type?: unknown; message?: unknown }[]; accepted: boolean[] }> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-routing-"));
	try {
		const context = supervisorContext(scratch);
		const received = join(scratch, "received.jsonl");
		const executable = fakePi(
			join(scratch, "fake-pi"),
			`const fs=require('node:fs');let data='';
process.stdin.on('data',chunk=>{data+=chunk;let at;
 while((at=data.indexOf('\\n'))!==-1){
  const command=JSON.parse(data.slice(0,at));data=data.slice(at+1);
  fs.appendFileSync(${JSON.stringify(received)}, JSON.stringify(command)+'\\n');
  process.stdout.write(JSON.stringify({type:'response',id:command.id,success:true})+'\\n');
 }
});
setInterval(() => {}, 1000);
`,
		);
		const session = start({
			...parameters(context, trustedExtensionFile(scratch), executable),
			prompt: "the initial brief",
			timeoutMs: 15_000,
		});
		const accepted = [
			await session.command("steer", "steer message"),
			await session.command("follow_up", "follow up message"),
			await session.clearQueue(),
			await session.prompt("a later prompt"),
		];
		await settled(() => existsSync(received) && readFileSync(received, "utf8").split("\n").length >= 6);
		const frames = readFileSync(received, "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { id?: unknown; type?: unknown; message?: unknown });
		session.abort();
		await session.done;
		return { frames, accepted };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

test("every command reaches the child as its own type, message and correlated id", async () => {
	const { frames, accepted } = await commandRoutingScenario(startPiRpc);
	assert.deepEqual(accepted, [true, true, true, true], "a command the child answered was reported undelivered");
	assert.deepEqual(
		frames.map(({ type, message }) => ({ type, message })),
		[
			{ type: "prompt", message: "the initial brief" },
			{ type: "steer", message: "steer message" },
			{ type: "follow_up", message: "follow up message" },
			// Queue clear carries no message of its own.
			{ type: "clear_queue", message: undefined },
			{ type: "prompt", message: "a later prompt" },
		],
	);
	// Each request is correlated by its own id, in issue order.
	assert.deepEqual(
		frames.map(({ id }) => id),
		["rpc-1", "rpc-2", "rpc-3", "rpc-4", "rpc-5"],
	);
});

test("baseline-first private-copy mutants: a misrouted command keeps every other arm green", async () => {
	const baseline = await commandRoutingScenario(startPiRpc);
	const types = (observed: { frames: { type?: unknown }[] }) => observed.frames.map(({ type }) => type);
	assert.deepEqual(types(baseline), ["prompt", "steer", "follow_up", "clear_queue", "prompt"]);

	// Queue clear sent as a prompt: it still correlates and still returns true,
	// so only the recorded frame tells the difference.
	const misroutedClear = await withMutant(
		[['clearQueue: () => write("clear_queue"),', 'clearQueue: () => write("prompt"),']],
		commandRoutingScenario,
	);
	assert.deepEqual(misroutedClear.accepted, baseline.accepted, "the mutant changed what the caller was told");
	assert.deepEqual(types(misroutedClear), ["prompt", "steer", "follow_up", "prompt", "prompt"]);

	// Steer and follow-up collapsed into one type: likewise invisible except
	// in what the child received.
	const collapsedType = await withMutant(
		[["? write(type, { message })", '? write("steer", { message })']],
		commandRoutingScenario,
	);
	assert.deepEqual(types(collapsedType), ["prompt", "steer", "steer", "clear_queue", "prompt"]);

	const control = await withMutant(
		[["? write(type, { message })", "? write(`${type}`, { message })"]],
		commandRoutingScenario,
	);
	assert.deepEqual(types(control), types(baseline), "a behaviour-preserving control changed the observation");
});

test("a successful RPC response answers its command and is not a settle, a terminal or a return", async () => {
	assert.deepEqual(await successResponseScenario(startPiRpc), {
		accepted: true,
		settleCount: 0,
		returnInstalled: false,
		state: "pending",
	});
});

test("baseline-first private-copy mutant: a success response promoted to a terminal ends the session", async () => {
	const baseline = await successResponseScenario(startPiRpc);
	assert.equal(baseline.state, "pending");
	const mutant = await withMutant(
		[
			[
				"\t\t\t\trequest.resolve(record.success === true);",
				'\t\t\t\trequest.resolve(record.success === true);\n\t\t\t\tif (record.success === true) {\n\t\t\t\t\tsettleCount++;\n\t\t\t\t\tend("settled");\n\t\t\t\t}',
			],
		],
		successResponseScenario,
	);
	assert.equal(mutant.state, "settled", "the mutant did not promote the response, so the arm measures nothing");
	const control = await withMutant(
		[
			[
				"\t\t\t\trequest.resolve(record.success === true);",
				"\t\t\t\tconst succeeded = record.success === true;\n\t\t\t\trequest.resolve(succeeded);",
			],
		],
		successResponseScenario,
	);
	assert.deepEqual(control, baseline, "a behaviour-preserving control changed the observation");
});

/**
 * No child ever starts. Both ways that can happen reach the same outcome:
 * the spawn call throwing synchronously, and the child process reporting an
 * error asynchronously after the call returned.
 */
async function startFailureScenario(
	start: Start,
	kind: "synchronous" | "asynchronous",
): Promise<{ outcome: string; exitCode: number | null; exitSignal: string | null }> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-spawn-failed-"));
	try {
		const context = supervisorContext(scratch);
		const session = start({
			...parameters(
				context,
				trustedExtensionFile(scratch),
				// A NUL byte makes the spawn call itself throw; an absent path is
				// accepted by the call and fails on the child's error event.
				kind === "synchronous" ? join(scratch, "fake\u0000pi") : join(scratch, "absent-pi"),
			),
			timeoutMs: 6000,
		});
		return { outcome: await session.done, exitCode: session.exitCode, exitSignal: session.exitSignal };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

test("a child that never starts reports spawn-failed, by either path, with no exit metadata", async () => {
	for (const kind of ["synchronous", "asynchronous"] as const)
		assert.deepEqual(
			await startFailureScenario(startPiRpc, kind),
			{ outcome: "spawn-failed", exitCode: null, exitSignal: null },
			kind,
		);
});

test("baseline-first private-copy mutants: either start-failure path could report an ordinary end", async () => {
	for (const [kind, edit] of [
		["synchronous", ['\t} catch {\n\t\tend("spawn-failed");', '\t} catch {\n\t\tend("exited");']],
		[
			"asynchronous",
			[
				'child.on("error", () => end(stopping ?? "spawn-failed"));',
				'child.on("error", () => end(stopping ?? "exited"));',
			],
		],
	] as ReadonlyArray<readonly ["synchronous" | "asynchronous", readonly [string, string]]>) {
		const baseline = await startFailureScenario(startPiRpc, kind);
		assert.equal(baseline.outcome, "spawn-failed", kind);
		const mutant = await withMutant([edit], (start) => startFailureScenario(start, kind));
		assert.equal(mutant.outcome, "exited", `${kind}: the mutant kept the branch, so the arm measures nothing`);
	}
});

/**
 * A child that ends by signal rather than by code, with nobody having asked
 * it to stop. The outcome vocabulary keeps that case distinct from an
 * operator abort and from a protocol refusal, and the exit code is null.
 */
async function naturalSignalScenario(
	start: Start,
	framing: "complete" | "unfinished" = "complete",
): Promise<{ outcome: string; exitCode: number | null; exitSignal: string | null; settleCount: number }> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-signal-"));
	try {
		const context = supervisorContext(scratch);
		// The unfinished variant adds a whole parseable record that no terminator
		// ever framed before killing itself, composing the two states.
		const trailing =
			framing === "complete" ? "" : `process.stdout.write(JSON.stringify({type:'agent_settled'}));\n    `;
		const executable = fakePi(
			join(scratch, "fake-pi"),
			`let received='';
process.stdin.on('data',chunk=>{
 received+=chunk;let at;while((at=received.indexOf('\\n'))!==-1){
  const item=JSON.parse(received.slice(0,at));received=received.slice(at+1);
  if(item.type==='prompt'){
   process.stdout.write(JSON.stringify({type:'response',id:item.id,success:true})+'\\n',()=>{
    ${trailing}// Its own end, by signal: no bound expired and no operator aborted.
    process.kill(process.pid,'SIGKILL');
   });
  }
 }
});
setInterval(() => {}, 1000);
`,
		);
		const session = start({
			...parameters(context, trustedExtensionFile(scratch), executable),
			timeoutMs: 15_000,
		});
		const outcome = await session.done;
		return {
			outcome,
			exitCode: session.exitCode,
			exitSignal: session.exitSignal,
			settleCount: session.settleCount,
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

test("a child that ends by signal reports signaled, with a null exit code and the signal", async () => {
	assert.deepEqual(await naturalSignalScenario(startPiRpc), {
		outcome: "signaled",
		exitCode: null,
		exitSignal: "SIGKILL",
		settleCount: 0,
	});
});

test("an unfinished frame outranks the signal that truncated it", async () => {
	// §4.9 refuses malformed or unfinished framing, and malformed data already
	// refuses as it is read, so the two halves must reach the same outcome
	// however the stream ended. Only how a COMPLETE stream ended classifies a
	// run; the signal is still reported alongside.
	assert.deepEqual(await naturalSignalScenario(startPiRpc, "unfinished"), {
		outcome: "protocol-invalid",
		exitCode: null,
		exitSignal: "SIGKILL",
		settleCount: 0,
	});
});

test("baseline-first private-copy mutant: classifying by how the child ended before reading validity", async () => {
	const baseline = await naturalSignalScenario(startPiRpc, "unfinished");
	assert.equal(baseline.outcome, "protocol-invalid");
	// The order this module had before #416: the signal branch read first, so an
	// unfinished tail was reported as the death that truncated it.
	const mutant = await withMutant(
		[
			[
				'(!valid\n\t\t\t\t? "protocol-invalid"\n\t\t\t\t: exitedSignal !== null',
				'(exitedSignal !== null\n\t\t\t\t? "signaled"\n\t\t\t\t: !valid',
			],
			[
				'\t\t\t\t\t? "signaled"\n\t\t\t\t\t: exitedCode !== null',
				'\t\t\t\t\t? "protocol-invalid"\n\t\t\t\t\t: exitedCode !== null',
			],
		],
		(start) => naturalSignalScenario(start, "unfinished"),
	);
	assert.equal(mutant.outcome, "signaled", "the mutant kept the order, so the arm measures nothing");
	// The same mutant leaves a COMPLETE stream's signal classification alone,
	// which is why only the composed arm above can measure this.
	assert.equal(
		(
			await withMutant(
				[
					[
						'(!valid\n\t\t\t\t? "protocol-invalid"\n\t\t\t\t: exitedSignal !== null',
						'(exitedSignal !== null\n\t\t\t\t? "signaled"\n\t\t\t\t: !valid',
					],
					[
						'\t\t\t\t\t? "signaled"\n\t\t\t\t\t: exitedCode !== null',
						'\t\t\t\t\t? "protocol-invalid"\n\t\t\t\t\t: exitedCode !== null',
					],
				],
				(start) => naturalSignalScenario(start, "complete"),
			)
		).outcome,
		"signaled",
	);
});

test("baseline-first private-copy mutant: collapsing the signal branch hides an unasked-for death", async () => {
	const baseline = await naturalSignalScenario(startPiRpc);
	assert.equal(baseline.outcome, "signaled");
	// The stream is complete and nothing refused it, so without this branch the
	// run reports a protocol refusal for a child that simply died.
	const mutant = await withMutant(
		[['exitedSignal !== null\n\t\t\t\t\t? "signaled"', 'exitedSignal !== null\n\t\t\t\t\t? "protocol-invalid"']],
		naturalSignalScenario,
	);
	assert.equal(mutant.outcome, "protocol-invalid", "the mutant kept the signal branch, so the arm measures nothing");
	const control = await withMutant(
		[['exitedSignal !== null\n\t\t\t\t\t? "signaled"', 'exitedSignal != null\n\t\t\t\t\t? "signaled"']],
		naturalSignalScenario,
	);
	assert.deepEqual(control, baseline, "a behaviour-preserving control changed the observation");
});

/**
 * A child group that refuses to stop on SIGTERM, with an orphan holding its
 * stdout open long after. Two bounds are measured at once, and both are
 * finite by design rather than by the child's cooperation: the abort escalates
 * to SIGKILL when SIGTERM is ignored, and the run ends on its own flush bound
 * rather than waiting for a pipe nobody will close.
 */
async function stubbornAbortScenario(
	start: Start,
): Promise<{ outcome: string; elapsedMs: number; childGone: boolean; sawSigterm: boolean }> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-stubborn-"));
	const pidFile = join(scratch, "child.pid");
	const termFile = join(scratch, "child.sigterm");
	const readyFile = join(scratch, "child.ready");
	const orphanPidFile = join(scratch, "orphan.pid");
	let orphanPid = 0;
	// Declared out here because a mutant that drops the escalation deliberately
	// leaves this child alive: the finally below must still be able to kill it.
	let childPid = 0;
	try {
		const context = supervisorContext(scratch);
		const executable = fakePi(
			join(scratch, "fake-pi"),
			'const cp = require("node:child_process"), fs = require("node:fs");\n' +
				// An orphan in its own group, holding this child's stdout far past
				// any bound here, so stdout never ends on its own.
				`const orphan = cp.spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 30000)"], { detached: true, stdio: ["ignore", 1, "ignore"] });\n` +
				"orphan.unref();\n" +
				`fs.writeFileSync(${JSON.stringify(orphanPidFile)}, String(orphan.pid));\n` +
				`fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
				// SIGTERM is recorded and refused: only an escalation can end this.
				`process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(termFile)}, "sigterm"));\n` +
				`fs.writeFileSync(${JSON.stringify(readyFile)}, "ready");\n` +
				"setInterval(() => {}, 1000);\n",
		);
		const controller = new AbortController();
		const session = start({
			...parameters(context, trustedExtensionFile(scratch), executable),
			timeoutMs: 120_000,
			signal: controller.signal,
		});
		await settled(() => existsSync(readyFile) && existsSync(pidFile) && existsSync(orphanPidFile));
		childPid = Number(readFileSync(pidFile, "utf8"));
		orphanPid = Number(readFileSync(orphanPidFile, "utf8"));
		assert.ok(Number.isInteger(childPid) && childPid > 1, `no child pid recorded: ${childPid}`);
		const startedAt = Date.now();
		controller.abort();
		const outcome = await session.done;
		return {
			outcome,
			elapsedMs: Date.now() - startedAt,
			childGone: await reaped(childPid),
			sawSigterm: existsSync(termFile),
		};
	} finally {
		for (const pid of [orphanPid, childPid]) if (pid > 1) kill(pid);
		rmSync(scratch, { recursive: true, force: true });
	}
}

test("abort escalates to SIGKILL and ends on its own flush bound, whatever the child does", async () => {
	const observed = await stubbornAbortScenario(startPiRpc);
	assert.equal(observed.outcome, "abort");
	assert.equal(observed.sawSigterm, true, "the child was never sent SIGTERM first");
	// SIGTERM was refused, so only the escalation can have ended it.
	assert.equal(observed.childGone, true, "a child that ignored SIGTERM survived the abort");
	// The orphan holds stdout for 30 s and the deadline is 120 s, so anything
	// near either would mean the run waited on the child rather than on its own
	// bound. The flush fallback is twice the 2 s grace.
	assert.ok(observed.elapsedMs < 15_000, `the run waited past its own flush bound: ${observed.elapsedMs} ms`);
});

test("baseline-first private-copy mutants: without escalation or a finite flush the run waits on the child", async () => {
	const baseline = await stubbornAbortScenario(startPiRpc);
	assert.equal(baseline.childGone, true);

	// No escalation: SIGTERM is ignored, so the child outlives the abort, while
	// the outcome the caller sees is unchanged.
	const unescalated = await withMutant(
		[['escalate = setTimeout(() => group("SIGKILL"), FLUSH_GRACE_MS);', "void 0;"]],
		stubbornAbortScenario,
	);
	assert.equal(unescalated.outcome, "abort", "the mutant changed what the caller was told");
	assert.equal(unescalated.childGone, false, "the mutant still killed the stubborn child");

	// No finite flush: the run waits on a pipe the orphan holds for 30 s.
	const unbounded = await withMutant(
		[
			[
				"flush = setTimeout(() => end(outcome), FLUSH_GRACE_MS * 2);",
				"flush = setTimeout(() => end(outcome), 60_000);",
			],
		],
		stubbornAbortScenario,
	);
	assert.ok(
		unbounded.elapsedMs > 15_000,
		`the mutant still ended within the baseline bound: ${unbounded.elapsedMs} ms`,
	);

	const control = await withMutant(
		[
			[
				"flush = setTimeout(() => end(outcome), FLUSH_GRACE_MS * 2);",
				"flush = setTimeout(() => end(outcome), 2 * FLUSH_GRACE_MS);",
			],
		],
		stubbornAbortScenario,
	);
	assert.equal(control.outcome, baseline.outcome, "a behaviour-preserving control changed the observation");
	assert.equal(control.childGone, true, "a behaviour-preserving control changed the observation");
});

test("an unfinished frame held to the end refuses the run even after a numeric exit", async () => {
	// The record parses and the exit is clean: only the missing terminator
	// refuses it, which is the half of §4.9's sentence the malformed arms
	// above cannot reach. The settle it carries is never counted either.
	assert.deepEqual(await unfinishedFrameScenario(startPiRpc), { outcome: "protocol-invalid", exitCode: 5 });
});

test("baseline-first private-copy mutant: skipping end-of-stream validation admits an unfinished frame", async () => {
	const baseline = await unfinishedFrameScenario(startPiRpc);
	assert.deepEqual(baseline, { outcome: "protocol-invalid", exitCode: 5 });
	// Unconditional validity at the end of the stream: the malformed arms stay
	// green, because data refused while reading sets the terminal before this
	// point, so this is the one statement only an unfinished frame measures.
	const mutant = await withMutant(
		[['const valid = parser.finish() === "complete";', "const valid = (parser.finish(), true);"]],
		unfinishedFrameScenario,
	);
	assert.equal(mutant.outcome, "exited", "the mutant still refused the unfinished frame, so the arm measures nothing");
	const control = await withMutant(
		[['const valid = parser.finish() === "complete";', 'const valid = "complete" === parser.finish();']],
		unfinishedFrameScenario,
	);
	assert.deepEqual(control, baseline, "a behaviour-preserving control changed the observation");
});

test("abort signals the whole child process group, SIGTERM first", async () => {
	const observed = await abortGroupScenario(startPiRpc);
	assert.deepEqual(observed, { outcome: "abort", grandchildGone: true, grandchildSawSigterm: true });
});

test("malformed framing and an exhausted bound each kill the child group and install no return", async () => {
	for (const [label, stdout, timeoutMs, expected] of [
		["malformed framing", "{invalid\n", 4000, "protocol-invalid"],
		// Silent and never exiting: the bound is the only terminal available.
		["an exhausted bound", "", 1500, "timeout"],
	] as ReadonlyArray<readonly [string, string, number, string]>) {
		const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-group-"));
		const pidFile = join(scratch, "grandchild.pid");
		let pid = 0;
		try {
			const context = supervisorContext(scratch);
			const executable = fakePi(
				join(scratch, "fake-pi"),
				'const cp = require("node:child_process"), fs = require("node:fs");\n' +
					'const kid = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });\n' +
					`fs.writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid));\n` +
					(stdout === "" ? "" : `process.stdout.write(${JSON.stringify(stdout)});\n`) +
					"setInterval(() => {}, 1000);\n",
			);
			const session = startPiRpc({
				...parameters(context, trustedExtensionFile(scratch), executable),
				timeoutMs,
			});
			assert.equal(await session.done, expected, label);
			assert.equal(existsSync(context.returnPath), false, `${label}: a return file was installed`);
			await settled(() => existsSync(pidFile));
			pid = Number(readFileSync(pidFile, "utf8"));
			assert.ok(Number.isInteger(pid) && pid > 1, `${label}: no grandchild pid recorded: ${pid}`);
			assert.equal(await reaped(pid), true, `${label}: the grandchild outlived it, so no group was killed`);
		} finally {
			if (pid > 1) kill(pid);
			rmSync(scratch, { recursive: true, force: true });
		}
	}
});

test("an asynchronously reported stdin EPIPE ends protocol-invalid without crashing the host", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-epipe-"));
	try {
		const context = supervisorContext(scratch);
		const executable = fakePi(
			join(scratch, "peer-close"),
			"process.stdin.destroy();setTimeout(()=>process.exit(0),500);\n",
		);
		const session = startPiRpc({
			...parameters(context, trustedExtensionFile(scratch), executable),
			prompt: "x".repeat(8192),
			timeoutMs: 3000,
		});
		await new Promise((resolve) => setTimeout(resolve, 80));
		const commands = await Promise.all(Array.from({ length: 16 }, () => session.command("steer", "x".repeat(8192))));
		assert.ok(
			commands.every((accepted) => !accepted),
			"a command was reported delivered over a broken stdin",
		);
		assert.equal(await session.done, "protocol-invalid");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("every terminal settles each pending correlated request, and sooner than its own command timeout", async () => {
	const observed = await pendingSettleScenario(startPiRpc);
	assert.deepEqual(observed, { resolution: false, outcome: "abort" });

	// The same property on the other two terminals: an exhausted bound, and
	// the child's own exit. Each fake leaves the command unanswered.
	for (const [label, body, timeoutMs, expected] of [
		["an exhausted bound", "process.stdin.resume();\nsetInterval(() => {}, 1000);\n", 600, "timeout"],
		// A silent child that exits numerically is `exited`, not a protocol
		// refusal: an empty stream finishes complete and no settle was counted.
		["the child's own exit", "process.stdin.resume();\nsetTimeout(() => process.exit(3), 150);\n", 15_000, "exited"],
	] as ReadonlyArray<readonly [string, string, number, string]>) {
		const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-pending-terminal-"));
		try {
			const context = supervisorContext(scratch);
			const executable = fakePi(join(scratch, "fake-pi"), body);
			const session = startPiRpc({
				...parameters(context, trustedExtensionFile(scratch), executable),
				timeoutMs,
			});
			const command = session.command("steer", "unanswered");
			let timer: ReturnType<typeof setTimeout> | undefined;
			const resolution = await Promise.race([
				command,
				new Promise<"unresolved">((resolve) => {
					timer = setTimeout(() => resolve("unresolved"), 3000);
				}),
			]);
			if (timer !== undefined) clearTimeout(timer);
			assert.equal(resolution, false, label);
			assert.equal(await session.done, expected, label);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}
});

/**
 * The settle-then-clean-exit run, whose terminal is `settled` rather than
 * `exited` precisely because a settle was counted over a stream that
 * finished complete. The scenario is shared with the mutant below.
 */
async function settledScenario(start: Start): Promise<{
	firstWake: number | undefined;
	settleCount: number;
	secondWake: number | undefined;
	liveAfterSettles: string;
	afterCloseSteer: boolean;
	afterClosePrompt: boolean;
	outcome: string;
	wakeAfterTerminal: number | undefined;
}> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-settled-"));
	try {
		const context = supervisorContext(scratch);
		// Two settles for the prompt, then the child stays alive: settled is
		// not a terminal, so the supervisor must still be running after both.
		const executable = fakePi(
			join(scratch, "fake-pi"),
			`let data='';
process.stdin.on('data',chunk=>{data+=chunk;let at;
 while((at=data.indexOf('\\n'))!==-1){
  const command=JSON.parse(data.slice(0,at));data=data.slice(at+1);
  if(command.type==='prompt'){
   process.stdout.write(JSON.stringify({type:'response',id:command.id,success:true})+'\\n');
   process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');
   process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');
  }
 }
});
// Exits only when its stdin ends, so the close() below is what stops it.
process.stdin.on('end',()=>process.exit(0));
setInterval(() => {}, 1000);
`,
		);
		const session = start({
			...parameters(context, trustedExtensionFile(scratch), executable),
			timeoutMs: 15_000,
		});
		const firstWake = await session.waitForSettle(0);
		await settled(() => session.settleCount === 2);
		const settleCount = session.settleCount;
		const secondWake = await session.waitForSettle(1);
		// Still running? No result is authorized and the child was not stopped.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const liveAfterSettles = await Promise.race([
			session.done,
			new Promise<"running">((resolve) => {
				timer = setTimeout(() => resolve("running"), 400);
			}),
		]);
		if (timer !== undefined) clearTimeout(timer);
		session.close();
		return {
			firstWake,
			settleCount,
			secondWake,
			liveAfterSettles,
			afterCloseSteer: await session.command("steer", "after close"),
			afterClosePrompt: await session.prompt("after close"),
			outcome: await session.done,
			wakeAfterTerminal: await session.waitForSettle(99),
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

test("agent_settled counts and wakes waiters without authorizing a result or stopping the child", async () => {
	assert.deepEqual(await settledScenario(startPiRpc), {
		firstWake: 1,
		settleCount: 2,
		secondWake: 2,
		// agent_settled is not a terminal: the child ran on until close().
		liveAfterSettles: "running",
		// close() wins against a later command rather than reporting it delivered.
		afterCloseSteer: false,
		afterClosePrompt: false,
		// `settled`, not `exited`: a counted settle over a stream that finished
		// complete is the only difference between those two outcomes.
		outcome: "settled",
		// A terminal session reports no further settle to a new waiter.
		wakeAfterTerminal: undefined,
	});
});

test("baseline-first private-copy mutant: a settled run collapsed into an ordinary exit", async () => {
	const baseline = await settledScenario(startPiRpc);
	assert.equal(baseline.outcome, "settled");
	const mutant = await withMutant(
		[['settleCount > 0\n\t\t\t\t\t\t\t? "settled"', 'settleCount > 0\n\t\t\t\t\t\t\t? "exited"']],
		settledScenario,
	);
	assert.equal(mutant.outcome, "exited", "the mutant kept the branch, so the arm measures nothing");
	const control = await withMutant(
		[['settleCount > 0\n\t\t\t\t\t\t\t? "settled"', 'settleCount >= 1\n\t\t\t\t\t\t\t? "settled"']],
		settledScenario,
	);
	assert.deepEqual(control, baseline, "a behaviour-preserving control changed the observation");
});

test("the operator sink is detachable, a throwing sink is dropped, and no child text reaches an outcome", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-sink-"));
	const marker = "private-child-content";
	try {
		const context = supervisorContext(scratch);
		// Three records, each carrying the marker, then an exit.
		const executable = fakePi(
			join(scratch, "fake-pi"),
			`let data='';
process.stdin.on('data',chunk=>{data+=chunk;let at;
 while((at=data.indexOf('\\n'))!==-1){
  const command=JSON.parse(data.slice(0,at));data=data.slice(at+1);
  if(command.type==='prompt'){
   process.stdout.write(JSON.stringify({type:'response',id:command.id,success:true,text:${JSON.stringify(marker)}})+'\\n');
   for (const index of [1,2,3]) process.stdout.write(JSON.stringify({type:'event',index,text:${JSON.stringify(marker)}})+'\\n');
   process.stderr.write(${JSON.stringify(marker)}.repeat(2000));
   setTimeout(()=>process.exit(0),120);
  }
 }
});
`,
		);
		const thrown: Record<string, unknown>[] = [];
		const session = startPiRpc({
			...parameters(context, trustedExtensionFile(scratch), executable),
			timeoutMs: 15_000,
			onOperatorEvent: (event) => {
				thrown.push(event);
				throw Error("operator sink refuses");
			},
		});
		const outcome = await session.done;
		// A throwing sink is dropped at its first throw, so it sees exactly one
		// record however many the child sent; the supervisor itself continues.
		assert.equal(thrown.length, 1, `a dropped sink kept receiving records: ${thrown.length}`);
		assert.equal(outcome, "exited");
		// The outcome vocabulary is fixed, and no value a caller can read here
		// carries the child's text — not the outcome, exit code or signal.
		const readable = JSON.stringify({
			outcome,
			exitCode: session.exitCode,
			exitSignal: session.exitSignal,
			settleCount: session.settleCount,
		});
		assert.equal(readable.includes(marker), false, `a caller-readable value carried child text: ${readable}`);
		// A sink attached to a terminal session is refused.
		session.attach(() => assert.fail("a sink attached after the terminal received a record"));
		session.detach();
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

/**
 * Attach, detach and reattach while the session is live. The arm above cannot
 * establish this: its sink is dropped by its own throw, and a session that has
 * reached its terminal refuses every sink anyway, so detaching there changes
 * nothing. Here each step is separated by a record the child sends on demand.
 */
async function liveAttachmentScenario(start: Start): Promise<{ first: number[]; second: number[]; outcome: string }> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-416-attach-"));
	try {
		const context = supervisorContext(scratch);
		// One event per steer, numbered, so each sink's record set is exact.
		const executable = fakePi(
			join(scratch, "fake-pi"),
			`let data='',index=0;
process.stdin.on('data',chunk=>{data+=chunk;let at;
 while((at=data.indexOf('\\n'))!==-1){
  const command=JSON.parse(data.slice(0,at));data=data.slice(at+1);
  if(command.type==='steer') process.stdout.write(JSON.stringify({type:'event',index:++index})+'\\n');
  process.stdout.write(JSON.stringify({type:'response',id:command.id,success:true})+'\\n');
 }
});
process.stdin.on('end',()=>process.exit(0));
setInterval(() => {}, 1000);
`,
		);
		const first: number[] = [];
		const second: number[] = [];
		const record = (into: number[]) => (event: Readonly<Record<string, unknown>>) => {
			if (event.type === "event") into.push(Number(event.index));
		};
		const session = start({
			...parameters(context, trustedExtensionFile(scratch), executable),
			timeoutMs: 15_000,
			onOperatorEvent: record(first),
		});
		await session.command("steer", "one");
		await settled(() => first.length === 1);
		// Detached: the next event reaches nobody, and draining continues.
		session.detach();
		await session.command("steer", "two");
		await new Promise((resolve) => setTimeout(resolve, 150));
		// Reattached, to a different sink.
		session.attach(record(second));
		await session.command("steer", "three");
		await settled(() => second.length === 1);
		session.close();
		return { first: [...first], second: [...second], outcome: await session.done };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

test("a live sink can be detached and another attached, without interrupting the drain", async () => {
	// The second event is drained while nobody is attached: it reaches neither
	// sink, and the third still arrives, so detaching stopped delivery and not
	// the reader.
	assert.deepEqual(await liveAttachmentScenario(startPiRpc), { first: [1], second: [3], outcome: "exited" });
});

test("baseline-first private-copy mutant: a detach that keeps delivering", async () => {
	const baseline = await liveAttachmentScenario(startPiRpc);
	assert.deepEqual(baseline.first, [1]);
	const mutant = await withMutant(
		[["\t\tdetach: () => {\n\t\t\tobserver = undefined;\n\t\t},", "\t\tdetach: () => {\n\t\t\tvoid 0;\n\t\t},"]],
		liveAttachmentScenario,
	);
	// The detached sink keeps receiving until the reattach replaces it.
	assert.deepEqual(mutant.first, [1, 2], "the mutant still detached, so the arm measures nothing");
});

test("baseline-first private-copy mutant: signalling the child alone leaves its group running", async () => {
	const baseline = await abortGroupScenario(startPiRpc);
	assert.deepEqual(baseline, { outcome: "abort", grandchildGone: true, grandchildSawSigterm: true });
	const mutant = await withMutant(
		[
			[
				"if (child?.pid !== undefined) process.kill(-child.pid, signal);",
				"if (child?.pid !== undefined) child.kill(signal);",
			],
		],
		abortGroupScenario,
	);
	assert.equal(mutant.grandchildSawSigterm, false, "the mutant still reached the grandchild");
	assert.equal(mutant.grandchildGone, false, "the mutant still reaped the grandchild");
	// A behaviour-preserving control of the same statement keeps the baseline.
	const control = await withMutant(
		[
			[
				"if (child?.pid !== undefined) process.kill(-child.pid, signal);",
				"const target = child?.pid;\n\t\t\tif (target !== undefined) process.kill(-target, signal);",
			],
		],
		abortGroupScenario,
	);
	assert.deepEqual(control, baseline, "a behaviour-preserving control changed the observation");
});

/*
 * The four statements by which an observed numeric exit keeps the terminal.
 * They are TWO independent pairs: the exit handler defuses the still-armed
 * bound and the abort listener, and the bound and abort callbacks each also
 * refuse once `exited` is set. Within a pair either member suffices, so a
 * single-statement mutant on this property is equivalent by construction.
 * That is measured below rather than asserted: each of the four alone is
 * shown to change nothing observable, and one mutant per pair — removing
 * both of that pair's members — lets the bound and then the later abort
 * actually steal the terminal. Reporting a single-statement mutant as dead
 * here would claim a measurement no run made.
 */
const DEFUSE_BOUND: readonly [string, string] = ["if (timeout !== undefined) clearTimeout(timeout);", "void 0;"];
const DEFUSE_ABORT: readonly [string, string] = [
	'\t\t\t\toptions.signal?.removeEventListener("abort", abort);',
	"\t\t\t\tvoid 0;",
];
const BOUND_EXITED_CHECK: readonly [string, string] = ['if (!exited) stop("timeout");', 'stop("timeout");'];
const ABORT_EXITED_CHECK: readonly [string, string] = ['if (!exited) stop("abort");', 'stop("abort");'];

test("baseline-first private-copy mutants: the observed exit owns the terminal against bound and abort", async () => {
	const baseline = await exitOwnsLifecycleScenario(startPiRpc);
	assert.deepEqual(baseline, { outcome: "exited", exitCode: 17 });

	// Each statement alone: redundant with its partner, so the observation holds.
	for (const [label, edit] of [
		["only the bound's defusing", DEFUSE_BOUND],
		["only the abort listener's removal", DEFUSE_ABORT],
		["only the bound's exited check", BOUND_EXITED_CHECK],
		["only the abort's exited check", ABORT_EXITED_CHECK],
	] as ReadonlyArray<readonly [string, readonly [string, string]]>)
		assert.deepEqual(
			await withMutant([edit], exitOwnsLifecycleScenario),
			baseline,
			`${label}: expected redundancy with its partner statement`,
		);

	// One mutant per pair: with both members gone, that terminal is stolen.
	const boundSteals = await withMutant([DEFUSE_BOUND, BOUND_EXITED_CHECK], exitOwnsLifecycleScenario);
	assert.equal(boundSteals.outcome, "timeout", "the still-armed bound did not take the terminal");
	const abortSteals = await withMutant([DEFUSE_ABORT, ABORT_EXITED_CHECK], exitOwnsLifecycleScenario);
	assert.equal(abortSteals.outcome, "abort", "the later abort did not take the terminal");

	// A behaviour-preserving control over the same exit handler keeps the baseline.
	const control = await withMutant(
		[["\t\t\texited = true;\n\t\t\texitedCode = code;", "\t\t\texitedCode = code;\n\t\t\texited = true;"]],
		exitOwnsLifecycleScenario,
	);
	assert.deepEqual(control, baseline, "a behaviour-preserving control changed the observation");
});

test("baseline-first private-copy mutant: a trusting extension gate accepts every refused path", async () => {
	const baseline = await extensionGateScenario(startPiRpc);
	assert.equal(baseline.refusedPaths, baseline.candidates);
	const mutant = await withMutant(
		[
			[
				"function trustedExtension(context: DispatchContext, path: string): boolean {",
				"function trustedExtension(context: DispatchContext, path: string): boolean {\n\tif (path.length > 0) return true;",
			],
		],
		extensionGateScenario,
	);
	assert.equal(mutant.refusedPaths, 0, "the mutant still refused an extension path");
	assert.equal(mutant.refusedProviderPaths, 0, "the mutant still refused a provider extension path");
});

test("baseline-first private-copy mutant: a terminal that leaves a request pending waits out its own timeout", async () => {
	const baseline = await pendingSettleScenario(startPiRpc);
	assert.deepEqual(baseline, { resolution: false, outcome: "abort" });
	const mutant = await withMutant(
		[
			[
				"for (const request of pending.values()) {\n\t\t\tclearTimeout(request.timer);\n\t\t\trequest.resolve(false);\n\t\t}",
				"for (const request of pending.values()) {\n\t\t\tvoid request;\n\t\t}",
			],
		],
		pendingSettleScenario,
	);
	assert.equal(mutant.resolution, "unresolved", "the mutant settled the request anyway, so the bound measures nothing");
});

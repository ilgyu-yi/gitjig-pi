/**
 * #420 (part 6 of #370): the Pi runner, the operator event hub it reports to,
 * and the internal dispatcher option that carries an explicit Pi selection.
 *
 * This is where parts 3 to 5 first compose, so the risk is in the seams rather
 * than in any one module: what the runner hands the provisioner and the
 * supervisor, in what order, with what left behind. A final outcome cannot
 * show most of that — a runner can provision the right profile and launch with
 * another extension, mint its own abort signal, or leave its hub session in
 * the registry, and still return exactly the right shape. So the seams are
 * INSTRUMENTED: a private copy of the `.pi` subtree has the runner's three
 * imports redirected through a recorder that notes each call and its
 * observable arguments, and the arms read that record.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DelegateRunOutcome } from "../.pi/extensions/gitjig/dispatch/executor.ts";
import {
	provisionalCheckpointApplies,
	runDispatch as runDispatchReal,
} from "../.pi/extensions/gitjig/dispatch/index.ts";
import {
	beginPiOperatorSession,
	livePiOperatorSessions,
	MAX_ROW_POINTS,
	MAX_VIEW_ROWS,
	piOperatorView,
} from "../.pi/extensions/gitjig/dispatch/pi-operator.ts";
import type { PiInvocation } from "../.pi/extensions/gitjig/dispatch/pi-run.ts";
import type { DispatchContext } from "../.pi/extensions/gitjig/dispatch/provision.ts";

const extensionsRoot = fileURLToPath(new URL("../.pi", import.meta.url));
const RUN_RELATIVE = "extensions/gitjig/dispatch/pi-run.ts";
const HELD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

type Call = Record<string, unknown> & { call: string };
type Runner = (
	context: DispatchContext,
	invocation: PiInvocation,
	options: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<DelegateRunOutcome>;

/** A fake Pi that answers the prompt, optionally settles, and records frames. */
function fakePi(path: string, options: { settleAfterMs?: number; exitCode?: number; silent?: boolean }): string {
	const received = `${path}.frames`;
	writeFileSync(
		path,
		`#!/usr/bin/env node
const fs = require("node:fs");
let data = "";
let settled = false;
process.stdin.on("data", (chunk) => {
	data += chunk;
	let at;
	while ((at = data.indexOf("\\n")) !== -1) {
		const command = JSON.parse(data.slice(0, at));
		data = data.slice(at + 1);
		fs.appendFileSync(${JSON.stringify(received)}, JSON.stringify({ at: Date.now(), ...command }) + "\\n");
		${options.silent === true ? "continue;" : ""}
		process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true }) + "\\n");
		if (!settled) {
			settled = true;
			setTimeout(() => process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n"), ${options.settleAfterMs ?? 120});
		}
	}
});
// Stdin ending is the runner's close; it is recorded with its own time so an
// arm can tell a close taken BEFORE the settle wait from one taken after.
process.stdin.on("end", () => {
	fs.appendFileSync(${JSON.stringify(received)}, JSON.stringify({ at: Date.now(), type: "stdin-end" }) + "\\n");
	process.exit(${options.exitCode ?? 0});
});
setInterval(() => {}, 1000);
`,
		{ mode: 0o700 },
	);
	chmodSync(path, 0o700);
	return path;
}

function frames(executable: string): Record<string, unknown>[] {
	try {
		return readFileSync(`${executable}.frames`, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

function dispatchContext(scratch: string, brief = "review the change"): DispatchContext {
	const tree = join(scratch, "tree");
	mkdirSync(tree, { recursive: true });
	const context: DispatchContext = {
		scratchRoot: scratch,
		treeDir: tree,
		stateDir: join(scratch, "state"),
		briefPath: join(scratch, "brief.md"),
		returnPath: join(scratch, "return.json"),
		heldHash: HELD,
	};
	mkdirSync(context.stateDir, { recursive: true });
	writeFileSync(context.briefPath, brief);
	return context;
}

/**
 * The runner from a private copy whose seams are recorded. The three modules
 * it composes are re-exported through one recorder, so the arms can see the
 * context each seam received, the extension path that travelled between them,
 * the order of the calls, and each hub session's begin and end by id.
 */
async function withRunner<T>(
	edits: ReadonlyArray<readonly [string, string, string]>,
	scenario: (run: Runner, trace: () => Call[], scratch: string) => Promise<T>,
): Promise<T> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-420-"));
	try {
		const root = join(scratch, "pi-copy");
		cpSync(extensionsRoot, root, { recursive: true });
		const tracePath = join(scratch, "seams.jsonl");
		writeFileSync(
			join(root, "extensions/gitjig/dispatch/seam-trace.ts"),
			`import { appendFileSync } from "node:fs";
import { beginPiOperatorSession as beginReal } from "./pi-operator.ts";
import { startPiRpc as startReal } from "./pi-rpc.ts";
import { provisionPiSubmitTool as provisionReal } from "./pi-submit.ts";
const note = (entry: Record<string, unknown>) =>
	appendFileSync(${JSON.stringify(tracePath)}, \`\${JSON.stringify(entry)}\\n\`);
export const provisionPiSubmitTool: typeof provisionReal = (context, profile) => {
	note({ call: "provision", role: profile.role, scratchRoot: context.scratchRoot, treeDir: context.treeDir, heldHash: context.heldHash });
	const path = provisionReal(context, profile);
	note({ call: "provisioned", path });
	return path;
};
export const startPiRpc: typeof startReal = (options) => {
	note({
		call: "startPiRpc",
		scratchRoot: options.context.scratchRoot,
		treeDir: options.context.treeDir,
		heldHash: options.context.heldHash,
		extensionPath: options.extensionPath,
		piExecutable: options.piExecutable,
		provider: options.provider,
		model: options.model,
		prompt: options.prompt,
		timeoutMs: options.timeoutMs,
		hasSignal: options.signal !== undefined,
	});
	return startReal(options);
};
export const beginPiOperatorSession: typeof beginReal = () => {
	const session = beginReal();
	const id = session.id;
	note({ call: "hub-begin", id });
	return {
		...session,
		end: () => {
			note({ call: "hub-end", id });
			session.end();
		},
	};
};
`,
		);
		const runPath = join(root, RUN_RELATIVE);
		let source = readFileSync(runPath, "utf8");
		for (const [anchor, replacement] of [
			['import { beginPiOperatorSession } from "./pi-operator.ts";', ""],
			['import { startPiRpc } from "./pi-rpc.ts";', ""],
			[
				'import { provisionPiSubmitTool } from "./pi-submit.ts";',
				'import { beginPiOperatorSession, provisionPiSubmitTool, startPiRpc } from "./seam-trace.ts";',
			],
		] as const) {
			assert.notEqual(source.indexOf(anchor), -1, `seam anchor must exist: ${anchor}`);
			source = source.replace(anchor, () => replacement);
		}
		// Written before the arm's own edits, so an edit that targets this same
		// file is not clobbered by the seam rewrite.
		writeFileSync(runPath, source);
		for (const [relative, anchor, replacement] of edits) {
			const path = join(root, relative);
			const current = readFileSync(path, "utf8");
			assert.notEqual(current.indexOf(anchor), -1, `mutation anchor must exist in ${relative}: ${anchor}`);
			assert.equal(current.indexOf(anchor), current.lastIndexOf(anchor), `anchor must be unique in ${relative}`);
			writeFileSync(
				path,
				current.replace(anchor, () => replacement),
			);
		}
		const { runPiDelegate }: { runPiDelegate: Runner } = await import(pathToFileURL(runPath).href);
		const trace = () => {
			try {
				return readFileSync(tracePath, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Call);
			} catch {
				return [];
			}
		};
		return await scenario(runPiDelegate, trace, scratch);
	} finally {
		try {
			for (const line of readFileSync(join(scratch, "seams.jsonl"), "utf8").split("\n")) void line;
		} catch {}
		rmSync(scratch, { recursive: true, force: true });
	}
}

const invocation = (executable: string, over: Partial<PiInvocation> = {}): PiInvocation => ({
	piExecutable: executable,
	provider: "scripted",
	model: "scripted-model",
	role: "reviewer",
	...over,
});

test("the held operand never reaches the child: redacted whole, and refused at the ruled bound", async () => {
	// A whole head in the brief is replaced in place, and the run proceeds.
	await withRunner([], async (run, trace, scratch) => {
		const context = dispatchContext(scratch, `compare against ${HELD} before judging`);
		const executable = fakePi(join(scratch, "fake-pi"), {});
		const outcome = await run(context, invocation(executable), { timeoutMs: 15_000 });
		assert.equal(outcome.exitCode, 0);
		const brief = readFileSync(context.briefPath, "utf8");
		assert.equal(brief.includes(HELD), false, "the whole head survived in the brief");
		assert.match(brief, /\[clone head withheld\]/);
		assert.equal(
			trace().some((entry) => entry.call === "startPiRpc"),
			true,
		);
	});

	// A contained run at the ruled bound refuses before anything is provisioned
	// or started — the prefix branch alone would miss it. One character shorter
	// is admitted, so the arm measures the bound and not the presence of hex.
	for (const [label, run6, refused] of [
		["at the bound", HELD.slice(10, 16), true],
		["one shorter", HELD.slice(10, 15), false],
	] as ReadonlyArray<readonly [string, string, boolean]>) {
		await withRunner([], async (runPi, trace, scratch) => {
			const context = dispatchContext(scratch, `a prior run mentioned ${run6} in passing`);
			const executable = fakePi(join(scratch, "fake-pi"), {});
			const outcome = await runPi(context, invocation(executable), { timeoutMs: 15_000 });
			assert.equal(outcome.protocolInvalid === true, refused, label);
			assert.equal(
				trace().some((entry) => entry.call === "provision" || entry.call === "startPiRpc"),
				!refused,
				`${label}: a refusal must precede provisioning and any child`,
			);
		});
	}
});

test("an invalid role or role/digest pairing refuses before provisioning and before any child", async () => {
	for (const [label, over] of [
		["an unknown role", { role: "auditor" as PiInvocation["role"] }],
		["a digest with a role that must not receive one", { role: "reviewer" as const, specDigest: "b".repeat(64) }],
		["the measurement role without its digest", { role: "measurement" as const }],
	] as ReadonlyArray<readonly [string, Partial<PiInvocation>]>) {
		await withRunner([], async (run, trace, scratch) => {
			const context = dispatchContext(scratch);
			const executable = fakePi(join(scratch, "fake-pi"), {});
			const outcome = await run(context, invocation(executable, over), { timeoutMs: 15_000 });
			assert.equal(outcome.protocolInvalid, true, label);
			assert.deepEqual(trace(), [], `${label}: a refusal provisioned or started something`);
			assert.equal(existsSync(join(context.scratchRoot, "trusted-pi")), false, `${label}: scratch`);
			assert.deepEqual(frames(executable), [], `${label}: a child received a frame`);
		});
	}
	// Every admitted role resolves to its own profile, named in the trace.
	for (const [role, expected] of [
		["reviewer", "reviewer"],
		["judge", "judge"],
		["history", "history"],
		["challenger", "recovery-challenger"],
		["selector-contest", "recovery-selector-contest"],
		["selector-measurement", "recovery-selector-measurement"],
		["diagnosis", "recovery-diagnosis"],
	] as ReadonlyArray<readonly [string, string]>)
		await withRunner([], async (run, trace, scratch) => {
			const context = dispatchContext(scratch);
			const executable = fakePi(join(scratch, "fake-pi"), {});
			await run(context, invocation(executable, { role: role as PiInvocation["role"] }), { timeoutMs: 15_000 });
			assert.equal(trace().find((entry) => entry.call === "provision")?.role, expected, role);
		});
	// Including the one role that must receive the caller's digest.
	await withRunner([], async (run, trace, scratch) => {
		const context = dispatchContext(scratch);
		const executable = fakePi(join(scratch, "fake-pi"), {});
		await run(context, invocation(executable, { role: "measurement", specDigest: "b".repeat(64) }), {
			timeoutMs: 15_000,
		});
		assert.equal(trace().find((entry) => entry.call === "provision")?.role, "recovery-measurement");
	});
});

test("the provisioned context and the extension it returned travel to the supervisor, in order", async () => {
	await withRunner([], async (run, trace, scratch) => {
		const context = dispatchContext(scratch);
		const executable = fakePi(join(scratch, "fake-pi"), {});
		await run(context, invocation(executable), { timeoutMs: 15_000 });
		const calls = trace();
		const order = calls.map((entry) => entry.call);
		// Provisioning completes before any child starts, and the hub session
		// opens before either — asserted as an order, not as three facts.
		assert.deepEqual(order.slice(0, 4), ["hub-begin", "provision", "provisioned", "startPiRpc"]);
		const provision = calls.find((entry) => entry.call === "provision");
		const start = calls.find((entry) => entry.call === "startPiRpc");
		const provisioned = calls.find((entry) => entry.call === "provisioned");
		// The same pinned, route-severed context reaches both seams.
		for (const key of ["scratchRoot", "treeDir", "heldHash"] as const) {
			assert.equal(provision?.[key], context[key], `provisioner ${key}`);
			assert.equal(start?.[key], context[key], `supervisor ${key}`);
		}
		// And the extension the supervisor is given is the one it returned.
		assert.equal(start?.extensionPath, provisioned?.path, "the supervisor was given another extension");
	});
});

test("the caller's selection, bound and signal reach the child rather than constants of the runner's", async () => {
	await withRunner([], async (run, trace, scratch) => {
		const context = dispatchContext(scratch);
		const executable = fakePi(join(scratch, "fake-pi"), {});
		await run(context, invocation(executable, { provider: "chosen-provider", model: "chosen-model" }), {
			timeoutMs: 4321,
		});
		const start = trace().find((entry) => entry.call === "startPiRpc");
		assert.equal(start?.piExecutable, executable);
		assert.equal(start?.provider, "chosen-provider");
		assert.equal(start?.model, "chosen-model");
		assert.equal(start?.timeoutMs, 4321, "the caller's run bound was not the child's");
		assert.equal(start?.hasSignal, false, "a signal appeared that the caller did not pass");
	});

	// The caller's own signal, not a fresh one: aborting it ends this run.
	await withRunner([], async (run, _trace, scratch) => {
		const context = dispatchContext(scratch);
		const executable = fakePi(join(scratch, "fake-pi"), { settleAfterMs: 60_000 });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const outcome = await run(context, invocation(executable), { timeoutMs: 60_000, signal: controller.signal });
		assert.equal(outcome.aborted, true, "the caller's abort did not reach the run");
	});
});

test("one purposeful prompt, then settle, close and terminal — and no second send", async () => {
	await withRunner([], async (run, _trace, scratch) => {
		const context = dispatchContext(scratch);
		const executable = fakePi(join(scratch, "fake-pi"), { settleAfterMs: 150 });
		const outcome = await run(context, invocation(executable), { timeoutMs: 15_000 });
		assert.equal(outcome.exitCode, 0);
		const received = frames(executable);
		const prompts = received.filter((frame) => frame.type === "prompt");
		assert.equal(prompts.length, 1, `the runner sent ${prompts.length} prompts`);
		// The one prompt has a job: the provisioned brief and the tool that
		// submits. An empty or generic instruction would satisfy a count alone.
		assert.match(String(prompts[0].message), /brief/i);
		assert.match(String(prompts[0].message), /submit_result/);
		assert.equal(
			received.some((frame) => frame.type === "steer" || frame.type === "follow_up"),
			false,
			"this transport added a second send",
		);
		// The close follows the settle wait: the fake records its stdin ending
		// with its own clock, and the settle it emitted precedes that.
		const end = received.find((frame) => frame.type === "stdin-end");
		assert.ok(end, "the runner never closed the child's stdin");
		assert.ok(
			Number(end.at) - Number(prompts[0].at) >= 150,
			`the close preceded the settle wait: ${Number(end.at) - Number(prompts[0].at)} ms`,
		);
	});

	// A child that never settles still gets exactly one prompt: the runner owes
	// no missing-submission continuation of its own.
	await withRunner([], async (run, _trace, scratch) => {
		const context = dispatchContext(scratch);
		const executable = fakePi(join(scratch, "fake-pi"), { settleAfterMs: 60_000 });
		const outcome = await run(context, invocation(executable), { timeoutMs: 1200 });
		assert.equal(outcome.timedOut, true);
		assert.equal(frames(executable).filter((frame) => frame.type === "prompt").length, 1);
	});
});

test("every hub session the runner begins is ended exactly once, and only its own", async () => {
	// A concurrent session stays live throughout, so the arm cannot pass by
	// emptying the registry, and the count returns to the baseline it started at.
	const concurrent = beginPiOperatorSession();
	try {
		const baseline = livePiOperatorSessions();
		await withRunner([], async (run, trace, scratch) => {
			const context = dispatchContext(scratch);
			const executable = fakePi(join(scratch, "fake-pi"), {});
			await run(context, invocation(executable), { timeoutMs: 15_000 });
			const calls = trace().filter((entry) => entry.call === "hub-begin" || entry.call === "hub-end");
			assert.equal(calls.length, 2, `begin/end pairs: ${JSON.stringify(calls)}`);
			assert.deepEqual(
				calls.map((entry) => entry.call),
				["hub-begin", "hub-end"],
			);
			// By identity, not by count: a second idempotent end would leave the
			// same count, and an end against the concurrent session would too.
			assert.equal(typeof calls[0].id, "string");
			assert.ok(String(calls[0].id).length > 0, "the hub session carried no identity");
			assert.equal(calls[0].id, calls[1].id, "the runner ended a session that was not its own");
			assert.notEqual(calls[0].id, concurrent.id, "the runner took over the concurrent session");
			assert.equal(livePiOperatorSessions(), baseline, "the run did not return to its baseline");
		});
		// A refusal that precedes the begin leaves the baseline untouched.
		await withRunner([], async (run, trace, scratch) => {
			const context = dispatchContext(scratch);
			await run(context, invocation(join(scratch, "absent"), { role: "auditor" as PiInvocation["role"] }), {
				timeoutMs: 15_000,
			});
			assert.deepEqual(trace(), []);
			assert.equal(livePiOperatorSessions(), baseline);
		});
		// A failed start is after the begin, and still returns to the baseline.
		await withRunner([], async (run, trace, scratch) => {
			const context = dispatchContext(scratch);
			const outcome = await run(context, invocation(join(scratch, "no-such-executable\u0000")), { timeoutMs: 15_000 });
			assert.equal(outcome.spawnFailed, true);
			const calls = trace().filter((entry) => entry.call === "hub-begin" || entry.call === "hub-end");
			assert.deepEqual(
				calls.map((entry) => entry.call),
				["hub-begin", "hub-end"],
			);
			assert.equal(livePiOperatorSessions(), baseline);
		});
		assert.equal(livePiOperatorSessions(), baseline, "a concurrent session was ended by the runner");
	} finally {
		concurrent.end();
	}
});

test("each supervisor terminal maps onto exactly one run outcome", async () => {
	const shape = (over: Partial<DelegateRunOutcome>): DelegateRunOutcome => ({
		exitCode: null,
		signal: null,
		timedOut: false,
		aborted: false,
		spawnFailed: false,
		protocolInvalid: false,
		...over,
	});
	// settled → a numeric exit, reported as itself.
	await withRunner([], async (run, _trace, scratch) => {
		const context = dispatchContext(scratch);
		const executable = fakePi(join(scratch, "fake-pi"), { exitCode: 0 });
		assert.deepEqual(await run(context, invocation(executable), { timeoutMs: 15_000 }), shape({ exitCode: 0 }));
	});
	// A nonzero numeric exit is still the child's own, not a refusal.
	await withRunner([], async (run, _trace, scratch) => {
		const context = dispatchContext(scratch);
		const executable = fakePi(join(scratch, "fake-pi"), { exitCode: 9 });
		assert.deepEqual(await run(context, invocation(executable), { timeoutMs: 15_000 }), shape({ exitCode: 9 }));
	});
	// timeout.
	await withRunner([], async (run, _trace, scratch) => {
		const context = dispatchContext(scratch);
		const executable = fakePi(join(scratch, "fake-pi"), { settleAfterMs: 60_000 });
		assert.deepEqual(await run(context, invocation(executable), { timeoutMs: 900 }), shape({ timedOut: true }));
	});
	// abort.
	await withRunner([], async (run, _trace, scratch) => {
		const context = dispatchContext(scratch);
		const executable = fakePi(join(scratch, "fake-pi"), { settleAfterMs: 60_000 });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		assert.deepEqual(
			await run(context, invocation(executable), { timeoutMs: 60_000, signal: controller.signal }),
			shape({ aborted: true }),
		);
	});
	// spawn failure.
	await withRunner([], async (run, _trace, scratch) => {
		const context = dispatchContext(scratch);
		assert.deepEqual(
			await run(context, invocation(join(scratch, "absent-pi")), { timeoutMs: 15_000 }),
			shape({ spawnFailed: true }),
		);
	});
	// protocol invalidity: a child whose stdout is not framed JSONL.
	await withRunner([], async (run, _trace, scratch) => {
		const context = dispatchContext(scratch);
		const executable = join(scratch, "fake-pi");
		writeFileSync(
			executable,
			'#!/usr/bin/env node\nprocess.stdout.write("{invalid\\n");\nsetInterval(()=>{},1000);\n',
			{
				mode: 0o700,
			},
		);
		assert.deepEqual(
			await run(context, invocation(executable), { timeoutMs: 15_000 }),
			shape({ protocolInvalid: true }),
		);
	});
	// an unasked-for signal: reported as the signal, with no exit code.
	await withRunner([], async (run, _trace, scratch) => {
		const context = dispatchContext(scratch);
		const executable = join(scratch, "fake-pi");
		writeFileSync(
			executable,
			`#!/usr/bin/env node
let data = "";
process.stdin.on("data", (chunk) => {
	data += chunk;
	if (data.includes("\\n")) process.kill(process.pid, "SIGKILL");
});
setInterval(() => {}, 1000);
`,
			{ mode: 0o700 },
		);
		assert.deepEqual(
			await run(context, invocation(executable), { timeoutMs: 15_000 }),
			shape({ signal: "SIGKILL" as NodeJS.Signals }),
		);
	});
});

test("the hub's bounds hold over the row an operator would see, at each boundary", () => {
	// Rows: the partial row is one of them, so twenty completed rows plus a
	// partial must render twenty, not twenty-one.
	const session = beginPiOperatorSession();
	try {
		for (let index = 0; index < MAX_VIEW_ROWS; index++)
			session.onEvent({ type: "tool_execution_end", toolName: `tool-${index}` });
		assert.equal(piOperatorView(session.id).length, MAX_VIEW_ROWS, "the completed rows alone exceed the cap");
		session.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "drafting" } });
		const rows = piOperatorView(session.id);
		assert.equal(rows.length, MAX_VIEW_ROWS, "the partial row rode beside a full view");
		assert.match(rows[rows.length - 1], /^partial: /);
		// The oldest completed row is the one that gave way.
		assert.equal(
			rows.some((row) => row.includes("tool-0")),
			false,
		);
	} finally {
		session.end();
	}

	// Code points: the bound covers this module's own prefix. An assistant
	// message exactly at the bound renders at the bound; one code point more
	// renders at the bound too, with the overflow dropped rather than carried.
	for (const [label, length, expected] of [
		["at the bound", MAX_ROW_POINTS - "assistant: ".length, MAX_ROW_POINTS],
		["one past it", MAX_ROW_POINTS - "assistant: ".length + 1, MAX_ROW_POINTS],
	] as ReadonlyArray<readonly [string, number, number]>) {
		const item = beginPiOperatorSession();
		try {
			item.onEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "x".repeat(length) }] },
			});
			assert.equal([...piOperatorView(item.id)[0]].length, expected, label);
		} finally {
			item.end();
		}
	}

	// A partial row obeys the same bound once its own prefix is counted.
	const partial = beginPiOperatorSession();
	try {
		partial.onEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "y".repeat(MAX_ROW_POINTS + 50) },
		});
		assert.equal([...piOperatorView(partial.id)[0]].length, MAX_ROW_POINTS);
	} finally {
		partial.end();
	}
});

test("the hub renders delegate text inertly, supersedes deltas, and keeps nothing after end", () => {
	const session = beginPiOperatorSession();
	try {
		// Control characters are replaced rather than rendered.
		session.onEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "before\u0007\u001b[31mafter" }] },
		});
		const [rendered] = piOperatorView(session.id);
		assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(rendered), false, `control bytes survived: ${rendered}`);
		assert.match(rendered, /^assistant: before {2}\[31mafter$/);
		// A tool name is delegate text under a fixed local label.
		session.onEvent({ type: "tool_execution_start", toolName: "read\u0007file" });
		assert.equal(piOperatorView(session.id)[1], "tool started: read file");
		// A completed message supersedes the deltas that preceded it.
		session.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "draft text" } });
		assert.ok(piOperatorView(session.id).some((row) => row.startsWith("partial: ")));
		session.onEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "the completed message" }] },
		});
		assert.equal(
			piOperatorView(session.id).some((row) => row.startsWith("partial: ")),
			false,
			"a delta survived its completion",
		);
	} finally {
		session.end();
	}
	// end() leaves nothing: no rows, and no live session.
	const after = beginPiOperatorSession();
	after.onEvent({ type: "tool_execution_start", toolName: "t" });
	const live = livePiOperatorSessions();
	after.end();
	assert.deepEqual(piOperatorView(after.id), []);
	assert.equal(livePiOperatorSessions(), live - 1);
});

test("no delegate text and no claim of absent intervention leaves this part's modules", async () => {
	// What a caller can read of a Pi run is the outcome shape alone. The child
	// writes a marker to every surface it controls; none of it may appear.
	const marker = "operator-visible-marker";
	await withRunner([], async (run, _trace, scratch) => {
		const context = dispatchContext(scratch);
		const executable = join(scratch, "fake-pi");
		writeFileSync(
			executable,
			`#!/usr/bin/env node
let data = "";
process.stdin.on("data", (chunk) => {
	data += chunk;
	let at;
	while ((at = data.indexOf("\\n")) !== -1) {
		const command = JSON.parse(data.slice(0, at));
		data = data.slice(at + 1);
		process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true, text: ${JSON.stringify(marker)} }) + "\\n");
		process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: ${JSON.stringify(marker)} }] } }) + "\\n");
		process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
		process.stderr.write(${JSON.stringify(marker)});
	}
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);
`,
			{ mode: 0o700 },
		);
		const outcome = await run(context, invocation(executable), { timeoutMs: 15_000 });
		assert.equal(
			JSON.stringify(outcome).includes(marker),
			false,
			`the outcome carried child text: ${JSON.stringify(outcome)}`,
		);
		assert.equal(existsSync(context.returnPath), false, "this part installed a return of its own");
	});

	// And no artifact of these modules claims the delegate was unsteered: the
	// absence is asserted over their source, because an attestation is a thing
	// a module would have to compose in order to emit it.
	const sources = [".pi/extensions/gitjig/dispatch/pi-run.ts", ".pi/extensions/gitjig/dispatch/pi-operator.ts"].map(
		(relative) => readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), relative), "utf8"),
	);
	for (const source of sources) {
		const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
		assert.equal(
			/unsteered|not steered|no operator (?:input|intervention)|without (?:operator )?intervention/i.test(code),
			false,
			"a module composes a claim of absent intervention",
		);
	}
});

/** A repository the dispatcher can clone, as the existing dispatch arms build one. */
function repository(): string {
	const root = mkdtempSync(join(tmpdir(), "gitjig-420-repo-"));
	execFileSync("git", ["init", "-q", root]);
	execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
	execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
	execFileSync("git", ["-C", root, "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-qm", "base"]);
	mkdirSync(join(root, "state"));
	return root;
}

/** The dispatcher from a private copy, so a mutant can be dispatched through. */
async function withDispatcher<T>(
	edits: ReadonlyArray<readonly [string, string, string]>,
	scenario: (dispatch: typeof runDispatchReal, scratch: string) => Promise<T>,
): Promise<T> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-420-dispatch-"));
	try {
		const root = join(scratch, "pi-copy");
		cpSync(extensionsRoot, root, { recursive: true });
		// The dispatcher imports packages at runtime, so the copy needs the
		// installed tree to resolve them.
		symlinkSync(
			join(fileURLToPath(new URL("..", import.meta.url)), "node_modules"),
			join(scratch, "node_modules"),
			"dir",
		);
		for (const [relative, anchor, replacement] of edits) {
			const path = join(root, relative);
			const source = readFileSync(path, "utf8");
			assert.notEqual(source.indexOf(anchor), -1, `mutation anchor must exist in ${relative}: ${anchor}`);
			assert.equal(source.indexOf(anchor), source.lastIndexOf(anchor), `anchor must be unique in ${relative}`);
			writeFileSync(
				path,
				source.replace(anchor, () => replacement),
			);
		}
		const imported = await import(pathToFileURL(join(root, "extensions/gitjig/dispatch/index.ts")).href);
		return await scenario(imported.runDispatch, scratch);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

test("the dispatcher's Pi option is internal, exact, and leaves the generic path alone", async () => {
	// The model-facing surface carries no Pi field. The tool's parameter block
	// is private to its module, so this reads it where it is declared; the
	// behavioural half is below, where only an internal caller can select Pi.
	const dispatchSource = readFileSync(
		join(fileURLToPath(new URL("..", import.meta.url)), ".pi/extensions/gitjig/dispatch/index.ts"),
		"utf8",
	);
	const declared = dispatchSource.indexOf("const DISPATCH_PARAMS = {");
	assert.notEqual(declared, -1, "the parameter block moved");
	// The object literal alone: anything past its closing brace is another
	// declaration, and reading into one would measure the wrong text.
	const params = dispatchSource.slice(declared, dispatchSource.indexOf("\n};", declared));
	assert.ok(params.includes("delegateArgv"), "the parameter block was not the one read");
	assert.equal(/\bpi\b\s*:/.test(params), false, "the model-facing surface exposes a Pi selection");

	// An empty argv is refused — unless a Pi selection brings its own child.
	const repo = repository();
	try {
		const generic = await runDispatchReal({
			callerRepoRoot: repo,
			stateRoot: join(repo, "state"),
			delegateArgv: [],
			brief: "brief",
			expectedRef: "HEAD",
			enteredAt: performance.now(),
		});
		assert.equal(generic.disposition, "refused");

		const scratch = mkdtempSync(join(tmpdir(), "gitjig-420-pi-"));
		try {
			const executable = fakePi(join(scratch, "fake-pi"), {});
			const outcome = await runDispatchReal({
				callerRepoRoot: repo,
				stateRoot: join(repo, "state"),
				delegateArgv: [],
				brief: "brief",
				expectedRef: "HEAD",
				timeoutMs: 20_000,
				enteredAt: performance.now(),
				pi: { piExecutable: executable, provider: "scripted", model: "scripted-model", role: "reviewer" },
			});
			// The child that ran is the Pi one: it received the runner's prompt.
			assert.equal(frames(executable).filter((frame) => frame.type === "prompt").length, 1);
			// No return was submitted, so the dispatch refuses on the missing
			// slot rather than on the transport — the generic admission rules.
			assert.equal(outcome.disposition, "refused");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}

		// Malformed framing reaches exactly the existing internal-failure class.
		const invalidScratch = mkdtempSync(join(tmpdir(), "gitjig-420-invalid-"));
		try {
			const executable = join(invalidScratch, "fake-pi");
			writeFileSync(
				executable,
				'#!/usr/bin/env node\nprocess.stdout.write("{invalid\\n");\nsetInterval(()=>{},1000);\n',
				{
					mode: 0o700,
				},
			);
			const outcome = await runDispatchReal({
				callerRepoRoot: repo,
				stateRoot: join(repo, "state"),
				delegateArgv: [],
				brief: "brief",
				expectedRef: "HEAD",
				timeoutMs: 20_000,
				enteredAt: performance.now(),
				pi: { piExecutable: executable, provider: "scripted", model: "scripted-model", role: "reviewer" },
			});
			assert.equal(outcome.disposition, "refused");
			if (outcome.disposition === "refused") assert.equal(outcome.diagnostic.code, "INTERNAL_FAILED");
		} finally {
			rmSync(invalidScratch, { recursive: true, force: true });
		}
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("the provisional checkpoint is the generic contract's, and never arms under a Pi selection", () => {
	// SPEC §1.7 owes a provisional return from the generic argv child alone, so
	// the gate is exactly "bounded operation AND generic transport".
	const pi = { piExecutable: "/bin/true", provider: "p", model: "m", role: "reviewer" as const };
	assert.equal(provisionalCheckpointApplies({ operationDeadline: 1 }), true);
	assert.equal(provisionalCheckpointApplies({}), false);
	assert.equal(provisionalCheckpointApplies({ operationDeadline: 1, pi }), false);
	assert.equal(provisionalCheckpointApplies({ pi }), false);
});

const RUN = RUN_RELATIVE;
const HUB = "extensions/gitjig/dispatch/pi-operator.ts";
const DISPATCH = "extensions/gitjig/dispatch/index.ts";

test("baseline-first private-copy mutants: the runner's seams", async () => {
	// Each mutant runs the same scenario its arm uses, and must change exactly
	// the observation that arm asserts.

	// The redaction itself: without it the head reaches the child's brief.
	await withRunner(
		[[RUN, "if (redacted !== original) writeFileSync(context.briefPath, redacted);", "void redacted;"]],
		async (run, _trace, scratch) => {
			const context = dispatchContext(scratch, `compare against ${HELD} before judging`);
			const executable = fakePi(join(scratch, "fake-pi"), {});
			await run(context, invocation(executable), { timeoutMs: 15_000 });
			assert.equal(readFileSync(context.briefPath, "utf8").includes(HELD), true, "the mutant still redacted");
		},
	);

	// The ruled predicate, replaced by the prefix branch alone: a contained run
	// at the bound then reaches a child, which is the case #104 ruled on.
	await withRunner(
		[
			[
				RUN,
				'if (namesHeldOperand(redacted, context.heldHash)) return refusal("invalid");',
				'if (redacted.includes(context.heldHash.slice(0, 7))) return refusal("invalid");',
			],
		],
		async (run, trace, scratch) => {
			const context = dispatchContext(scratch, `a prior run mentioned ${HELD.slice(10, 16)} in passing`);
			const executable = fakePi(join(scratch, "fake-pi"), {});
			await run(context, invocation(executable), { timeoutMs: 15_000 });
			assert.equal(
				trace().some((entry) => entry.call === "startPiRpc"),
				true,
				"the mutant still refused the contained run",
			);
		},
	);

	// The role/digest pairing: without it a digest rides a role that must not
	// receive one, and the run provisions.
	await withRunner(
		[[RUN, '(invocation.role !== "measurement" && invocation.specDigest !== undefined)', "false"]],
		async (run, trace, scratch) => {
			const context = dispatchContext(scratch);
			const executable = fakePi(join(scratch, "fake-pi"), {});
			await run(context, invocation(executable, { specDigest: "b".repeat(64) }), { timeoutMs: 15_000 });
			assert.equal(
				trace().some((entry) => entry.call === "provision"),
				true,
				"the mutant still refused",
			);
		},
	);

	// The extension handed on: a runner that provisions and then launches with
	// another file in the scratch passes every outcome assertion.
	await withRunner(
		[[RUN, "\t\t\textensionPath,", "\t\t\textensionPath: context.briefPath,"]],
		async (run, trace, scratch) => {
			const context = dispatchContext(scratch);
			const executable = fakePi(join(scratch, "fake-pi"), {});
			await run(context, invocation(executable), { timeoutMs: 15_000 });
			const calls = trace();
			assert.notEqual(
				calls.find((entry) => entry.call === "startPiRpc")?.extensionPath,
				calls.find((entry) => entry.call === "provisioned")?.path,
				"the mutant still handed on the provisioned extension",
			);
		},
	);

	// The caller's bound, dropped for a constant.
	await withRunner(
		[[RUN, "timeoutMs: options.timeoutMs ?? DEFAULT_RUN_BOUND_MS,", "timeoutMs: DEFAULT_RUN_BOUND_MS,"]],
		async (run, trace, scratch) => {
			const context = dispatchContext(scratch);
			const executable = fakePi(join(scratch, "fake-pi"), {});
			await run(context, invocation(executable), { timeoutMs: 4321 });
			assert.notEqual(
				trace().find((entry) => entry.call === "startPiRpc")?.timeoutMs,
				4321,
				"the mutant still carried the caller's bound",
			);
		},
	);

	// A second send: one more prompt after the settle.
	await withRunner(
		[[RUN, "\t\tsession.close();", '\t\tawait session.prompt("submit now");\n\t\tsession.close();']],
		async (run, _trace, scratch) => {
			const context = dispatchContext(scratch);
			const executable = fakePi(join(scratch, "fake-pi"), { settleAfterMs: 100 });
			await run(context, invocation(executable), { timeoutMs: 15_000 });
			assert.equal(frames(executable).filter((frame) => frame.type === "prompt").length, 2, "the mutant sent once");
		},
	);

	// A close taken before the settle wait: the counts are unchanged, only the
	// order moves, which is what the timing assertion exists to catch.
	await withRunner(
		[
			[
				RUN,
				"\t\tawait session.waitForSettle(0);\n\t\tsession.close();",
				"\t\tsession.close();\n\t\tawait session.waitForSettle(0);",
			],
		],
		async (run, _trace, scratch) => {
			const context = dispatchContext(scratch);
			const executable = fakePi(join(scratch, "fake-pi"), { settleAfterMs: 400 });
			await run(context, invocation(executable), { timeoutMs: 15_000 });
			const received = frames(executable);
			const prompt = received.find((frame) => frame.type === "prompt");
			const end = received.find((frame) => frame.type === "stdin-end");
			assert.ok(prompt && end);
			assert.ok(Number(end.at) - Number(prompt.at) < 400, "the mutant still waited for the settle before closing");
		},
	);

	// Teardown, deleted: the outcome is identical and the session survives.
	await withRunner([[RUN, "\t\toperator.end();\n\t}", "\t}"]], async (run, trace, scratch) => {
		const context = dispatchContext(scratch);
		const executable = fakePi(join(scratch, "fake-pi"), {});
		const outcome = await run(context, invocation(executable), { timeoutMs: 15_000 });
		assert.equal(outcome.exitCode, 0, "the mutant changed the outcome, so the arm would not need the trace");
		assert.equal(
			trace().some((entry) => entry.call === "hub-end"),
			false,
			"the mutant still ended its session",
		);
	});

	// Teardown, duplicated: a count cannot see this; the identity trace can.
	await withRunner(
		[[RUN, "\t\toperator.end();\n\t}", "\t\toperator.end();\n\t\toperator.end();\n\t}"]],
		async (run, trace, scratch) => {
			const context = dispatchContext(scratch);
			const executable = fakePi(join(scratch, "fake-pi"), {});
			await run(context, invocation(executable), { timeoutMs: 15_000 });
			assert.equal(trace().filter((entry) => entry.call === "hub-end").length, 2, "the mutant ended once");
		},
	);

	// Teardown of the wrong session: the hub ends whichever session is oldest,
	// so a concurrently live one would die instead of this run's own.
	await withRunner(
		[[HUB, "\t\t\tactive.delete(item.id);", "\t\t\tactive.delete([...active.keys()][0] ?? item.id);"]],
		async (run, _trace, scratch) => {
			const hub = pathToFileURL(join(scratch, "pi-copy", HUB)).href;
			const { beginPiOperatorSession: begin, livePiOperatorSessions: live } = await import(hub);
			const other = begin();
			const context = dispatchContext(scratch);
			const executable = fakePi(join(scratch, "fake-pi"), {});
			await run(context, invocation(executable), { timeoutMs: 15_000 });
			// The concurrent session is the one the mutant removed, and this
			// run's own session is the survivor — the inverse of the rule.
			assert.equal(live(), 1, "the mutant ended its own session after all");
			other.end();
		},
	);
});

test("baseline-first private-copy mutants: the hub's bounds and the dispatcher's gates", async () => {
	// The row cap applied to completed rows alone: a twenty-first row rides
	// beside twenty, which only a bound over the composed view catches.
	const rows = await withRunner(
		// The composed cap itself: the completed rows are already bounded, so
		// only this statement keeps the partial row from riding beside twenty.
		[[HUB, "\treturn rows.slice(-MAX_VIEW_ROWS);", "\treturn rows;"]],
		async (_run, _trace, scratch) => {
			const { beginPiOperatorSession: begin, piOperatorView: view } = await import(
				pathToFileURL(join(scratch, "pi-copy", HUB)).href
			);
			const session = begin();
			for (let index = 0; index < MAX_VIEW_ROWS; index++)
				session.onEvent({ type: "tool_execution_end", toolName: `tool-${index}` });
			session.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "drafting" } });
			const seen = view(session.id).length;
			session.end();
			return seen;
		},
	);
	assert.equal(rows, MAX_VIEW_ROWS + 1, "the mutant still bounded the composed view");

	// The row clipped before its prefix is composed, as the basis did: the
	// rendered row then exceeds the bound by the prefix's length.
	const points = await withRunner(
		[
			[HUB, "\t\t\t\t\tline = `assistant: ${text}`;", "\t\t\t\t\tline = `assistant: ${clip(text)}`;"],
			[HUB, "\t\t\t\titem.lines.push(clip(line));", "\t\t\t\titem.lines.push(line);"],
		],
		async (_run, _trace, scratch) => {
			const { beginPiOperatorSession: begin, piOperatorView: view } = await import(
				pathToFileURL(join(scratch, "pi-copy", HUB)).href
			);
			const session = begin();
			session.onEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "x".repeat(MAX_ROW_POINTS) }] },
			});
			const seen = [...view(session.id)[0]].length;
			session.end();
			return seen;
		},
	);
	assert.equal(points, MAX_ROW_POINTS + "assistant: ".length, "the mutant still bounded the composed row");

	// A module that composes a claim of absent intervention.
	await withRunner(
		[
			[
				HUB,
				"\t\t\t\t\tline = `assistant: ${text}`;",
				"\t\t\t\t\tline = `assistant (unsteered by any operator): ${text}`;",
			],
		],
		async (_run, _trace, scratch) => {
			const source = readFileSync(join(scratch, "pi-copy", HUB), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
			assert.equal(/unsteered/i.test(source), true, "the mutant composed no attestation");
		},
	);

	// The checkpoint gate, with its transport condition dropped: it would then
	// arm under Pi, cancelling a conforming child before its one submission.
	const gate = await withDispatcher(
		[
			[
				DISPATCH,
				"return options.operationDeadline !== undefined && options.pi === undefined;",
				"return options.operationDeadline !== undefined;",
			],
		],
		async (_dispatch, scratch) => {
			const { provisionalCheckpointApplies: applies } = await import(
				pathToFileURL(join(scratch, "pi-copy", DISPATCH)).href
			);
			return applies({
				operationDeadline: 1,
				pi: { piExecutable: "/bin/true", provider: "p", model: "m", role: "reviewer" },
			});
		},
	);
	assert.equal(gate, true, "the mutant still excluded the Pi transport");

	const repo = repository();
	try {
		// The empty-argv relaxation, without its Pi condition: a generic
		// dispatch with no delegate would then pass the preflight.
		const admitted = await withDispatcher(
			[[DISPATCH, "(options.pi === undefined && options.delegateArgv.length === 0)", "false"]],
			async (dispatch) => {
				const outcome = await dispatch({
					callerRepoRoot: repo,
					stateRoot: join(repo, "state"),
					delegateArgv: [],
					brief: "brief",
					expectedRef: "HEAD",
					timeoutMs: 5_000,
					enteredAt: performance.now(),
				});
				return outcome.disposition === "refused" ? outcome.diagnostic.code : "admitted";
			},
		);
		assert.notEqual(admitted, "PARAMETER_REFUSED", "the mutant still refused an empty generic argv at preflight");

		// The transport branch, forced to the generic executor: the Pi child
		// never starts, so no frame reaches it.
		const scratch = mkdtempSync(join(tmpdir(), "gitjig-420-branch-"));
		try {
			const executable = fakePi(join(scratch, "fake-pi"), {});
			await withDispatcher([[DISPATCH, "\t\t\t\toptions.pi === undefined\n", "\t\t\t\ttrue\n"]], async (dispatch) =>
				dispatch({
					callerRepoRoot: repo,
					stateRoot: join(repo, "state"),
					delegateArgv: [],
					brief: "brief",
					expectedRef: "HEAD",
					timeoutMs: 5_000,
					enteredAt: performance.now(),
					pi: { piExecutable: executable, provider: "scripted", model: "scripted-model", role: "reviewer" },
				}),
			);
			assert.deepEqual(frames(executable), [], "the mutant still ran the Pi delegate");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

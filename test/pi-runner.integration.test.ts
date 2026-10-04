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
 *
 * Every arm below is a named function used twice: once by the test that
 * asserts it holds, and once by the mutant that must make THAT ARM fail. A
 * mutant test therefore runs the owner arm and requires it to throw, rather
 * than asserting the mutant's behaviour in its own words — which would report
 * a kill no arm ever observed.
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
	registerDispatchTool,
	runDispatch as runDispatchReal,
} from "../.pi/extensions/gitjig/dispatch/index.ts";
import { namesHeldOperand } from "../.pi/extensions/gitjig/dispatch/operand.ts";
import * as hubReal from "../.pi/extensions/gitjig/dispatch/pi-operator.ts";
import type { PiInvocation } from "../.pi/extensions/gitjig/dispatch/pi-run.ts";
import type { Profile } from "../.pi/extensions/gitjig/dispatch/pi-submit-extension.ts";
import type { DispatchContext } from "../.pi/extensions/gitjig/dispatch/provision.ts";
import { quoted } from "../.pi/extensions/gitjig/quote.ts";
import { recoveryPiProfile } from "../.pi/extensions/gitjig/recovery/pi-profile.ts";
import { REVIEW_PI_PROFILES } from "../.pi/extensions/gitjig/review/pi-profile.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const extensionsRoot = join(repoRoot, ".pi");
const RUN = "extensions/gitjig/dispatch/pi-run.ts";
const HUB = "extensions/gitjig/dispatch/pi-operator.ts";
const DISPATCH = "extensions/gitjig/dispatch/index.ts";
const HELD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

type Call = Record<string, unknown> & { call: string };
/** What the dispatcher handed the runner, as values rather than as timing. */
type DispatchSeam = {
	at: number;
	timeoutMs?: number;
	context: DispatchContext;
	invocation: PiInvocation;
};
type Runner = (
	context: DispatchContext,
	invocation: PiInvocation,
	options: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<DelegateRunOutcome>;
type Hub = typeof hubReal;
type RunnerArm = (run: Runner, trace: () => Call[], scratch: string) => Promise<void>;
type Edits = ReadonlyArray<readonly [string, string, string]>;

/** A fake Pi that answers the prompt, optionally settles, and records frames. */
function fakePi(
	path: string,
	options: { settleAfterMs?: number; exitCode?: number; settles?: boolean; exitAfterMs?: number },
): string {
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
		// The child's own argv rides with the first frame, and with it the
		// profile written beside its trusted extension: together they are the
		// whole selection as the child received it, not merely that one ran.
		let profile = null;
		let provisioned = null;
		try {
			const path = require("node:path");
			const argv = process.argv.slice(2);
			const extension = argv[argv.indexOf("--extension") + 1];
			profile = JSON.parse(fs.readFileSync(path.join(path.dirname(extension), "profile.json"), "utf8"));
			// The scratch the extension sits in IS the context's scratch root, and
			// the brief beside it is the one that context names, so the child can
			// report the context it was actually run under.
			// Resolved here, while the dispatcher's scratch still exists: it is
			// removed when the run ends, so the arm cannot resolve it afterwards.
			const scratchRoot = path.dirname(path.dirname(extension));
			provisioned = {
				tree: fs.realpathSync(path.join(scratchRoot, "tree")),
				cwd: fs.realpathSync(process.cwd()),
				brief: fs.readFileSync(path.join(scratchRoot, "brief.md"), "utf8"),
			};
		} catch {}
		fs.appendFileSync(${JSON.stringify(received)}, JSON.stringify({ at: Date.now(), argv: process.argv.slice(2), profile, provisioned, ...command }) + "\\n");
		process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true }) + "\\n");
		if (${options.settles === false ? "false" : "true"} && !settled) {
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
${options.exitAfterMs === undefined ? "" : `setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.exitAfterMs});`}
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

const invocation = (executable: string, over: Partial<PiInvocation> = {}): PiInvocation => ({
	piExecutable: executable,
	provider: "scripted",
	model: "scripted-model",
	role: "reviewer",
	...over,
});

/**
 * Any class the repository's escaper treats as live, found without a regex the
 * style rules refuse: the C0 and C1 controls, the line and paragraph
 * separators, and the bidi controls.
 */
function hasInertBreach(value: string): boolean {
	return [...value].some((character) => {
		const point = character.codePointAt(0) ?? 0;
		return (
			point < 32 ||
			(point >= 127 && point <= 159) ||
			point === 0x061c ||
			point === 0x200e ||
			point === 0x200f ||
			(point >= 0x202a && point <= 0x202e) ||
			(point >= 0x2066 && point <= 0x2069) ||
			point === 0x2028 ||
			point === 0x2029
		);
	});
}

/** Wait, bounded, for a predicate; returns whether it became true. */
async function settled(predicate: () => boolean, attempts = 200): Promise<boolean> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return predicate();
}

function applyEdits(root: string, edits: Edits): void {
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
}

function copyExtensions(scratch: string): string {
	const root = join(scratch, "pi-copy");
	cpSync(extensionsRoot, root, { recursive: true });
	// The dispatcher imports packages at runtime, so a copy needs the
	// installed tree beside it to resolve them.
	symlinkSync(join(repoRoot, "node_modules"), join(scratch, "node_modules"), "dir");
	return root;
}

/**
 * The runner from a private copy whose seams are recorded. The three modules
 * it composes are re-exported through one recorder, so an arm can see the
 * context each seam received, the extension path that travelled between them,
 * the order of the calls, each hub session's begin and end by id, and whether
 * the signal the caller passed is the one the supervisor got.
 */
async function withRunner<T>(
	edits: Edits,
	scenario: (run: Runner, trace: () => Call[], scratch: string) => Promise<T>,
): Promise<T> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-420-"));
	try {
		const root = copyExtensions(scratch);
		const tracePath = join(scratch, "seams.jsonl");
		writeFileSync(
			join(root, "extensions/gitjig/dispatch/seam-trace.ts"),
			`import { appendFileSync } from "node:fs";
import { beginPiOperatorSession as beginReal } from "./pi-operator.ts";
import { startPiRpc as startReal } from "./pi-rpc.ts";
import { provisionPiSubmitTool as provisionReal } from "./pi-submit.ts";
const note = (entry: Record<string, unknown>) => {
	// A run the arm aborts can settle after its scratch is gone; a recorder
	// must not turn its own teardown into an unhandled failure.
	try {
		appendFileSync(${JSON.stringify(tracePath)}, \`\${JSON.stringify(entry)}\\n\`);
	} catch {}
};
export const provisionPiSubmitTool: typeof provisionReal = (context, profile) => {
	// The profile's fixed fields carry the caller's measurement digest, so a
	// substituted one is visible here and not only in the role.
	// The WHOLE profile: its schema and summary are as much the consumer's
	// choice as its role, and a substituted schema would admit another shape.
	note({ call: "provision", profile: { ...profile }, context: { ...context } });
	const path = provisionReal(context, profile);
	note({ call: "provisioned", path });
	return path;
};
export const startPiRpc: typeof startReal = (options) => {
	note({
		call: "startPiRpc",
		context: { ...options.context },
		extensionPath: options.extensionPath,
		piExecutable: options.piExecutable,
		provider: options.provider,
		model: options.model,
		prompt: options.prompt,
		timeoutMs: options.timeoutMs,
		// The caller marks its own signal, so identity is read rather than
		// presence: a freshly minted signal carries no mark.
		signalMark: (options.signal as { gitjigArmMark?: unknown } | undefined)?.gitjigArmMark,
		// Likewise for the operator sink: the hub marks its own callback, so a
		// supervisor started without one, or with someone else's, is visible.
		eventSinkMark: (options.onOperatorEvent as { gitjigHubSession?: unknown } | undefined)?.gitjigHubSession,
	});
	return startReal(options);
};
export const beginPiOperatorSession: typeof beginReal = () => {
	const session = beginReal();
	note({ call: "hub-begin", id: session.id });
	const onEvent = (event: Parameters<typeof session.onEvent>[0]) => session.onEvent(event);
	Object.defineProperty(onEvent, "gitjigHubSession", { value: session.id });
	return {
		...session,
		onEvent,
		bind: (rpc: Parameters<typeof session.bind>[0]) => {
			note({ call: "hub-bind", id: session.id, bound: rpc !== undefined });
			session.bind(rpc);
		},
		end: () => {
			note({ call: "hub-end", id: session.id });
			session.end();
		},
	};
};
`,
		);
		const runPath = join(root, RUN);
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
		// Written before the arm's own edits, so an edit targeting this file is
		// not clobbered by the seam rewrite.
		writeFileSync(runPath, source);
		applyEdits(root, edits);
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
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** The hub from a private copy, so a mutant of it can be measured. */
async function withHub<T>(edits: Edits, scenario: (hub: Hub) => Promise<T> | T): Promise<T> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-420-hub-"));
	try {
		const root = copyExtensions(scratch);
		applyEdits(root, edits);
		return await scenario(await import(pathToFileURL(join(root, HUB)).href));
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** The dispatcher from a private copy, with its own checkpoint predicate. */
async function withDispatcher<T>(
	edits: Edits,
	scenario: (
		dispatch: typeof runDispatchReal,
		applies: typeof provisionalCheckpointApplies,
		source: string,
		parameterKeys: () => string[],
		handedToRunner: () => DispatchSeam[],
	) => Promise<T>,
): Promise<T> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-420-dispatch-"));
	try {
		const root = copyExtensions(scratch);
		// The dispatcher's own seam is recorded the way the runner's are. What
		// it hands the runner is a VALUE, and a value can be compared; inferring
		// it from when a run ended is what this suite did before, and a timing
		// window admits a materially different bound however tight it is drawn.
		const tracePath = join(scratch, "dispatch-seam.jsonl");
		writeFileSync(
			join(root, "extensions/gitjig/dispatch/run-trace.ts"),
			`import { appendFileSync } from "node:fs";
import { runPiDelegate as runReal } from "./pi-run.ts";
export type { PiInvocation } from "./pi-run.ts";
export const runPiDelegate: typeof runReal = (context, invocation, options) => {
	appendFileSync(
		${JSON.stringify(tracePath)},
		\`\${JSON.stringify({ at: performance.now(), timeoutMs: options.timeoutMs, context, invocation })}\\n\`,
	);
	return runReal(context, invocation, options);
};
`,
		);
		applyEdits(root, [
			[
				DISPATCH,
				'import { type PiInvocation, runPiDelegate } from "./pi-run.ts";',
				'import { type PiInvocation, runPiDelegate } from "./run-trace.ts";',
			],
			...edits,
		]);
		const imported = await import(pathToFileURL(join(root, DISPATCH)).href);
		return await scenario(
			imported.runDispatch,
			imported.provisionalCheckpointApplies,
			readFileSync(join(root, DISPATCH), "utf8"),
			() => registeredDispatchParameterKeys(imported.registerDispatchTool),
			() => {
				try {
					return readFileSync(tracePath, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line) as DispatchSeam);
				} catch {
					return [];
				}
			},
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * The dispatcher derives the child's bound from its own timeout and the
 * caller's operation deadline, and hands THAT to the runner. A child that
 * never settles ends on whichever bound reached it, so a deadline far below
 * the timeout separates the derived bound from the raw one.
 */
async function armDerivesTheRunBound(
	dispatch: typeof runDispatchReal,
	repo: string,
	handedToRunner: () => DispatchSeam[],
): Promise<void> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-420-bound-"));
	try {
		const executable = fakePi(join(scratch, "fake-pi"), { settleAfterMs: 60_000 });
		// The deadline is ABSOLUTE, so the run must end at it however long the
		// provisioning before it took — which makes the expectation exact rather
		// than a window wide enough to admit a materially different bound.
		const deadline = performance.now() + 1_500;
		const outcome = await dispatch({
			callerRepoRoot: repo,
			stateRoot: join(repo, "state"),
			delegateArgv: [],
			brief: "brief",
			expectedRef: "HEAD",
			// Twenty seconds the caller allows, one and a half the operation has.
			timeoutMs: 20_000,
			operationDeadline: deadline,
			enteredAt: performance.now(),
			pi: { piExecutable: executable, provider: "scripted", model: "scripted-model", role: "reviewer" },
		});
		assert.equal(outcome.disposition, "refused");
		// The bound is READ, not inferred from when the run ended. Two earlier
		// corrections tightened a timing window and a later mutant walked through
		// it anyway; a value handed across a seam is a value, so it is compared.
		const handed = handedToRunner();
		assert.equal(handed.length, 1, `the dispatcher called the runner ${handed.length} times`);
		const [seam] = handed;
		// What the caller's deadline left at the moment of that call, which is
		// what the dispatcher must have derived and passed on. The two are taken
		// microseconds apart, so they agree within a small scheduling slack — and
		// any bound that is not the derived one is seconds away, not milliseconds.
		const remaining = deadline - seam.at;
		assert.ok(
			seam.timeoutMs !== undefined && Math.abs(seam.timeoutMs - remaining) < 50,
			`the runner was given ${seam.timeoutMs} ms where the deadline left ${Math.round(remaining)} ms`,
		);
		// And it is the deadline that bounded it, not the caller's own timeout.
		assert.ok((seam.timeoutMs ?? 0) < 20_000, `the runner was given the caller's raw timeout: ${seam.timeoutMs} ms`);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** The property keys of the parameters the dispatch tool really registers. */
function registeredDispatchParameterKeys(register: typeof registerDispatchTool = registerDispatchTool): string[] {
	let parameters: { properties?: Record<string, unknown> } | undefined;
	register(
		{
			registerTool: (tool: { name: string; parameters: { properties?: Record<string, unknown> } }) => {
				if (tool.name === "gitjig_dispatch") parameters = tool.parameters;
			},
		} as unknown as Parameters<typeof registerDispatchTool>[0],
		repoRoot,
		join(tmpdir(), "gitjig-420-unused-state"),
	);
	assert.ok(parameters, "the dispatch tool registered no parameters");
	return Object.keys(parameters.properties ?? {}).sort();
}

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

/*
 * The arms. Each is the whole measurement — scenario and assertions — so the
 * mutant that claims it can run exactly this and require it to fail.
 */

const armRedactsWholeHead: RunnerArm = async (run, trace, scratch) => {
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
	// What the child was actually GIVEN, judged by part 1's ruled predicate
	// rather than by a substring search: the brief it reads, the prompt it was
	// sent, and every other frame that reached it. A redaction that left the
	// operand in the prompt would satisfy the brief assertions above.
	// The caller's own context carries the held hash by design — the runner
	// needs it to redact with — so what is scanned is what CROSSES to the
	// child, not the parameters the supervisor was given.
	for (const [what, text] of [
		["the brief it reads", brief],
		["the frames it received", JSON.stringify(frames(executable))],
	] as ReadonlyArray<readonly [string, string]>)
		assert.equal(namesHeldOperand(text, HELD), false, `${what} names the held operand`);
};

const armRefusesContainedRun: RunnerArm = async (run, trace, scratch) => {
	// A contained run at the ruled bound: the prefix branch alone would miss
	// it, and a child must not start.
	const context = dispatchContext(scratch, `a prior run mentioned ${HELD.slice(10, 16)} in passing`);
	const executable = fakePi(join(scratch, "fake-pi"), {});
	const outcome = await run(context, invocation(executable), { timeoutMs: 15_000 });
	assert.equal(outcome.protocolInvalid, true, "a brief naming the held operand was admitted");
	assert.equal(
		trace().some((entry) => entry.call === "provision" || entry.call === "startPiRpc"),
		false,
		"the refusal came after provisioning or a child",
	);
};

const armAdmitsShorterRun: RunnerArm = async (run, trace, scratch) => {
	// One character below the bound is admitted, so the arm above measures the
	// bound rather than the presence of hex.
	const context = dispatchContext(scratch, `a prior run mentioned ${HELD.slice(10, 15)} in passing`);
	const executable = fakePi(join(scratch, "fake-pi"), {});
	const outcome = await run(context, invocation(executable), { timeoutMs: 15_000 });
	assert.equal(outcome.protocolInvalid === true, false);
	assert.equal(
		trace().some((entry) => entry.call === "startPiRpc"),
		true,
	);
};

const armRefusalCostsNothing: RunnerArm = async (run, trace, scratch) => {
	for (const [label, over] of [
		["an unknown role", { role: "auditor" as PiInvocation["role"] }],
		["a digest with a role that must not receive one", { role: "reviewer" as const, specDigest: "b".repeat(64) }],
		["the measurement role without its digest", { role: "measurement" as const }],
	] as ReadonlyArray<readonly [string, Partial<PiInvocation>]>) {
		const context = dispatchContext(join(scratch, label.replace(/\W+/g, "-")));
		const executable = fakePi(join(context.scratchRoot, "fake-pi"), {});
		const outcome = await run(context, invocation(executable, over), { timeoutMs: 15_000 });
		assert.equal(outcome.protocolInvalid, true, label);
		assert.equal(
			trace().some((entry) => entry.call === "provision" || entry.call === "startPiRpc"),
			false,
			`${label}: a refusal provisioned or started something`,
		);
		assert.equal(existsSync(join(context.scratchRoot, "trusted-pi")), false, `${label}: scratch`);
		assert.deepEqual(frames(executable), [], `${label}: a child received a frame`);
	}
};

const armSelectsEachRole: RunnerArm = async (run, trace, scratch) => {
	for (const [role, expected, digest] of [
		["reviewer", "reviewer", undefined],
		["judge", "judge", undefined],
		["history", "history", undefined],
		["challenger", "recovery-challenger", undefined],
		["selector-contest", "recovery-selector-contest", undefined],
		["selector-measurement", "recovery-selector-measurement", undefined],
		["diagnosis", "recovery-diagnosis", undefined],
		["measurement", "recovery-measurement", "b".repeat(64)],
	] as ReadonlyArray<readonly [string, string, string | undefined]>) {
		const context = dispatchContext(join(scratch, role));
		const executable = fakePi(join(context.scratchRoot, "fake-pi"), {});
		await run(
			context,
			invocation(executable, {
				role: role as PiInvocation["role"],
				...(digest === undefined ? {} : { specDigest: digest }),
			}),
			{ timeoutMs: 15_000 },
		);
		const provisioned = trace().filter((entry) => entry.call === "provision");
		const last = provisioned[provisioned.length - 1]?.profile as Profile | undefined;
		assert.equal(last?.role, expected, role);
		// The caller's digest reaches the profile unchanged, or no digest does.
		assert.equal(last?.fixed?.specDigest, digest, `${role}: the profile carried another digest`);
		// And the profile is the consumer's OWN, whole: the same schema and
		// summary that module owns, not merely something with the right role.
		// Compared before exposure, which the provisioner applies itself when it
		// writes the profile beside the tool.
		const owned =
			role in REVIEW_PI_PROFILES
				? REVIEW_PI_PROFILES[role as keyof typeof REVIEW_PI_PROFILES]
				: (recoveryPiProfile(role as Parameters<typeof recoveryPiProfile>[0], digest) as Profile);
		assert.deepEqual(last, owned, `${role}: the provisioned profile is not the consumer's own`);
	}
};

const armSeamsCarryTheSameContext: RunnerArm = async (run, trace, scratch) => {
	const context = dispatchContext(scratch);
	const executable = fakePi(join(scratch, "fake-pi"), {});
	await run(context, invocation(executable), { timeoutMs: 15_000 });
	const calls = trace();
	// Provisioning completes before any child starts, and the hub session
	// opens before either — asserted as an order, not as three facts.
	assert.deepEqual(calls.map((entry) => entry.call).slice(0, 4), [
		"hub-begin",
		"provision",
		"provisioned",
		"startPiRpc",
	]);
	const provision = calls.find((entry) => entry.call === "provision");
	const start = calls.find((entry) => entry.call === "startPiRpc");
	const provisioned = calls.find((entry) => entry.call === "provisioned");
	// The WHOLE context, not a sample of it: a substituted state root, brief
	// path or return path is as much a different run as a substituted tree.
	assert.deepEqual(provision?.context, { ...context }, "the provisioner received another context");
	assert.deepEqual(start?.context, { ...context }, "the supervisor received another context");
	assert.equal(start?.extensionPath, provisioned?.path, "the supervisor was given another extension");
	// The hub is wired to the session it opened, in both directions: the
	// supervisor drains into THIS session's sink, and the session is bound to
	// the running child so a view can reach it. Draining is wired before the
	// child starts and waits on nobody attaching.
	const begun = calls.find((entry) => entry.call === "hub-begin")?.id;
	assert.equal(start?.eventSinkMark, begun, "the supervisor was started without this session's sink");
	const bind = calls.find((entry) => entry.call === "hub-bind");
	assert.equal(bind?.id, begun, "the session was never bound to its running child");
	assert.equal(bind?.bound, true);
	assert.ok(calls.indexOf(start as Call) < calls.indexOf(bind as Call), "the session was bound before a child existed");
};

const armCarriesTheCallersSelection: RunnerArm = async (run, trace, scratch) => {
	const context = dispatchContext(scratch);
	const executable = fakePi(join(scratch, "fake-pi"), { settleAfterMs: 50 });
	const controller = new AbortController();
	// The caller marks its own signal, so the arm reads identity rather than
	// presence: a mirrored fresh signal would carry no mark.
	Object.defineProperty(controller.signal, "gitjigArmMark", { value: "the caller's own signal" });
	await run(context, invocation(executable, { provider: "chosen-provider", model: "chosen-model" }), {
		timeoutMs: 4321,
		signal: controller.signal,
	});
	const start = trace().find((entry) => entry.call === "startPiRpc");
	assert.equal(start?.piExecutable, executable);
	assert.equal(start?.provider, "chosen-provider");
	assert.equal(start?.model, "chosen-model");
	assert.equal(start?.timeoutMs, 4321, "the caller's run bound was not the child's");
	assert.equal(start?.signalMark, "the caller's own signal", "the child was given another signal");
};

const armSendsOnePurposefulPrompt: RunnerArm = async (run, _trace, scratch) => {
	const context = dispatchContext(scratch);
	const executable = fakePi(join(scratch, "fake-pi"), { settleAfterMs: 400 });
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
	// The close follows the settle wait: the fake records its stdin ending with
	// its own clock, and the settle it emitted precedes that.
	const end = received.find((frame) => frame.type === "stdin-end");
	assert.ok(end, "the runner never closed the child's stdin");
	assert.ok(
		Number(end.at) - Number(prompts[0].at) >= 400,
		`the close preceded the settle wait: ${Number(end.at) - Number(prompts[0].at)} ms`,
	);
};

const armEndsItsOwnSessionOnce: RunnerArm = async (run, trace, scratch) => {
	// Every exit after the begin, not only the ordinary one: a session opened
	// and then abandoned on a provisioning failure or a failed start is as
	// attachable afterwards as one abandoned on success.
	for (const [label, prepare] of [
		["an ordinary terminal", (context: DispatchContext) => fakePi(join(context.scratchRoot, "fake-pi"), {})],
		[
			"a provisioning failure",
			(context: DispatchContext) => {
				// The scratch the provisioner will try to make already exists, so its
				// first non-recursive mkdir throws after the session was begun.
				mkdirSync(join(context.scratchRoot, "trusted-pi"));
				return fakePi(join(context.scratchRoot, "fake-pi"), {});
			},
		],
		["a failed start", (context: DispatchContext) => join(context.scratchRoot, "absent-pi")],
	] as ReadonlyArray<readonly [string, (context: DispatchContext) => string]>) {
		const before = trace().filter((entry) => entry.call === "hub-begin" || entry.call === "hub-end").length;
		const context = dispatchContext(join(scratch, label.replace(/\W+/g, "-")));
		await run(context, invocation(prepare(context)), { timeoutMs: 15_000 });
		const calls = trace()
			.filter((entry) => entry.call === "hub-begin" || entry.call === "hub-end")
			.slice(before);
		assert.deepEqual(
			calls.map((entry) => entry.call),
			["hub-begin", "hub-end"],
			`${label}: begin/end pairs: ${JSON.stringify(calls)}`,
		);
		// By identity, not by count: a second idempotent end leaves the same
		// count, and so does an end taken against someone else's session.
		assert.equal(typeof calls[0].id, "string", label);
		assert.ok(String(calls[0].id).length > 0, `${label}: the hub session carried no identity`);
		assert.equal(calls[0].id, calls[1].id, `${label}: the runner ended a session that was not its own`);
	}
};

/**
 * The supervisor has one observer slot and this hub holds it for the child's
 * whole life. A view gets controls, never the subscription: if it could take
 * that slot, the rows would stop growing exactly while someone was watching.
 */
const armKeepsTheObserverSlot: RunnerArm = async (run, trace, scratch) => {
	const hub: Hub = await import(pathToFileURL(join(scratch, "pi-copy", HUB)).href);
	const context = dispatchContext(scratch);
	// A child that emits one event, waits, then emits another: a view opens in
	// between, and the second event must still reach the hub.
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
		process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true }) + "\\n");
		process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "first" }) + "\\n");
		// The second event arrives after a view has opened, and the child never
		// settles, so the rows stay readable until the view ends the run itself.
		setTimeout(() => {
			process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "second" }) + "\\n");
		}, 400);
	}
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);
`,
		{ mode: 0o700 },
	);
	chmodSync(executable, 0o700);
	const running = run(context, invocation(executable), { timeoutMs: 15_000 });
	// While it runs, a view does what a view may do: read rows and take the
	// controls. The controls it is given cannot touch the observer slot.
	await settled(() => trace().some((entry) => entry.call === "hub-bind"));
	const id = String(trace().find((entry) => entry.call === "hub-begin")?.id);
	await settled(() => hub.piOperatorView(id).length > 0);
	const controls = hub.piOperatorControls(id);
	assert.ok(controls, "a live session offered a view no controls");
	assert.equal("attach" in controls, false, "a view can take the observer slot");
	assert.equal("detach" in controls, false, "a view can drop the observer slot");
	assert.equal(typeof controls.command, "function", "a view cannot steer");
	// The event the child emits AFTER the view took its controls still reaches
	// the hub, which is the whole of "draining does not depend on attachment".
	await settled(() => hub.piOperatorView(id).length >= 2);
	assert.deepEqual(hub.piOperatorView(id), [`tool started: ${quoted("first")}`, `tool started: ${quoted("second")}`]);
	// And the controls a view does get reach the child: this one ends the run.
	controls.abort();
	assert.equal((await running).aborted, true, "the view's abort never reached the child");
};

const armLeavesTheConcurrentSessionAlone: RunnerArm = async (run, trace, scratch) => {
	// The copy has its own registry, so a concurrent session is opened inside
	// it and must be the survivor: a count alone cannot tell which entry went.
	const hub: Hub = await import(pathToFileURL(join(scratch, "pi-copy", HUB)).href);
	const other = hub.beginPiOperatorSession();
	other.onEvent({ type: "tool_execution_start", toolName: "concurrent" });
	try {
		const context = dispatchContext(scratch);
		const executable = fakePi(join(scratch, "fake-pi"), {});
		const before = hub.livePiOperatorSessions();
		await run(context, invocation(executable), { timeoutMs: 15_000 });
		const own = trace().find((entry) => entry.call === "hub-begin")?.id;
		assert.equal(typeof own, "string");
		// The run returns to the baseline it started at, with another delegate
		// legitimately live — and the row the concurrent session holds proves
		// it is that session which survived, not merely that one did.
		assert.equal(hub.livePiOperatorSessions(), before, "the run did not return to its baseline");
		assert.deepEqual(
			hub.piOperatorView(other.id),
			[`tool started: ${quoted("concurrent")}`],
			"the concurrent session was ended",
		);
		assert.deepEqual(hub.piOperatorView(String(own)), [], "the run's own session outlived it");
	} finally {
		other.end();
	}
};

const armMapsEachTerminal: RunnerArm = async (run, _trace, scratch) => {
	const shape = (over: Partial<DelegateRunOutcome>): DelegateRunOutcome => ({
		exitCode: null,
		signal: null,
		timedOut: false,
		aborted: false,
		spawnFailed: false,
		protocolInvalid: false,
		...over,
	});
	const at = (name: string) => {
		const context = dispatchContext(join(scratch, name));
		return { context, executable: join(context.scratchRoot, "fake-pi") };
	};
	// settled → the child's own numeric exit, zero or not.
	for (const code of [0, 9]) {
		const { context, executable } = at(`exit-${code}`);
		fakePi(executable, { exitCode: code });
		assert.deepEqual(
			await run(context, invocation(executable), { timeoutMs: 15_000 }),
			shape({ exitCode: code }),
			`exit ${code}`,
		);
	}
	// `exited` — a numeric exit with no settle at all — is its OWN terminal and
	// is admitted too: §4.9 leaves admission to output validity, so a child
	// that never settles still has its exit reported rather than refused.
	// Without this case both arms above reach the mapping through `settled`.
	{
		const { context, executable } = at("exited-without-settle");
		// It answers, never settles, and ends on its own before any bound.
		fakePi(executable, { exitCode: 3, settles: false, exitAfterMs: 300 });
		assert.deepEqual(
			await run(context, invocation(executable), { timeoutMs: 8_000 }),
			shape({ exitCode: 3 }),
			"a numeric exit without a settle",
		);
	}
	// timeout.
	{
		const { context, executable } = at("timeout");
		fakePi(executable, { settleAfterMs: 60_000 });
		assert.deepEqual(await run(context, invocation(executable), { timeoutMs: 900 }), shape({ timedOut: true }));
	}
	// abort.
	{
		const { context, executable } = at("abort");
		fakePi(executable, { settleAfterMs: 60_000 });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		assert.deepEqual(
			await run(context, invocation(executable), { timeoutMs: 60_000, signal: controller.signal }),
			shape({ aborted: true }),
		);
	}
	// spawn failure.
	{
		const { context, executable } = at("spawn");
		assert.deepEqual(await run(context, invocation(executable), { timeoutMs: 15_000 }), shape({ spawnFailed: true }));
	}
	// protocol invalidity: stdout that is not framed JSONL.
	{
		const { context, executable } = at("protocol");
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
	}
	// an unasked-for signal: reported as the signal, with no exit code.
	{
		const { context, executable } = at("signal");
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
	}
};

const armKeepsNoChildTextInTheOutcome: RunnerArm = async (run, _trace, scratch) => {
	const marker = "operator-visible-marker";
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
	assert.equal(JSON.stringify(outcome).includes(marker), false, "the outcome carried child text");
	assert.equal(existsSync(context.returnPath), false, "this part installed a return of its own");
};

/*
 * Hub arms. Each takes the module namespace, so the mutant can hand it a copy.
 */

function armBoundsTheComposedView(hub: Hub): void {
	// Rows: the partial row is one of them, so twenty completed rows plus a
	// partial must render twenty, not twenty-one.
	const session = hub.beginPiOperatorSession();
	try {
		for (let index = 0; index < hub.MAX_VIEW_ROWS; index++)
			session.onEvent({ type: "tool_execution_end", toolName: `tool-${index}` });
		assert.equal(hub.piOperatorView(session.id).length, hub.MAX_VIEW_ROWS, "the completed rows exceed the cap");
		session.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "drafting" } });
		const rows = hub.piOperatorView(session.id);
		assert.equal(rows.length, hub.MAX_VIEW_ROWS, "the partial row rode beside a full view");
		assert.match(rows[rows.length - 1], /^partial: /);
		assert.equal(
			rows.some((row) => row.includes("tool-0")),
			false,
			"the oldest row was not the one that gave way",
		);
	} finally {
		session.end();
	}
}

function armBoundsTheComposedRow(hub: Hub): void {
	// Code points: the bound covers this module's own prefix, and the delegate's
	// share is what gives way — a bound applied from the right would drop the
	// label and leave delegate text standing where a trusted one is read.
	for (const [label, length] of [
		["at the bound", hub.MAX_ROW_POINTS - "assistant: ".length],
		["one past it", hub.MAX_ROW_POINTS - "assistant: ".length + 1],
		["far past it", hub.MAX_ROW_POINTS * 3],
	] as ReadonlyArray<readonly [string, number]>) {
		const session = hub.beginPiOperatorSession();
		try {
			session.onEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "x".repeat(length) }] },
			});
			const [row] = hub.piOperatorView(session.id);
			assert.equal([...row].length, hub.MAX_ROW_POINTS, label);
			assert.ok(row.startsWith("assistant: "), `${label}: the local label was clipped away`);
		} finally {
			session.end();
		}
	}
	// A tool row keeps its label the same way, and the partial row obeys the
	// same bound once its own prefix is counted.
	for (const [type, label] of [
		["tool_execution_start", "tool started: "],
		["tool_execution_end", "tool ended: "],
	] as ReadonlyArray<readonly [string, string]>) {
		const tool = hub.beginPiOperatorSession();
		try {
			tool.onEvent({ type, toolName: "t".repeat(hub.MAX_ROW_POINTS * 2) });
			const [row] = hub.piOperatorView(tool.id);
			assert.equal([...row].length, hub.MAX_ROW_POINTS, label);
			assert.ok(row.startsWith(label), `${label}: the local label was clipped away`);
		} finally {
			tool.end();
		}
	}
	const partial = hub.beginPiOperatorSession();
	try {
		partial.onEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "y".repeat(hub.MAX_ROW_POINTS + 50) },
		});
		const [row] = hub.piOperatorView(partial.id);
		assert.equal([...row].length, hub.MAX_ROW_POINTS);
		assert.ok(row.startsWith("partial: "));
	} finally {
		partial.end();
	}
}

function armRendersInertly(hub: Hub): void {
	const session = hub.beginPiOperatorSession();
	try {
		// Every class the repository's own escaper treats as live, not just the
		// C0 controls: a line separator would let a delegate push text onto a row
		// of its own, and a bidi control would reverse what an operator reads.
		const hostile = "before\u0007\u001b[31m\u2028FORGED\u202emalicious";
		session.onEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: hostile }] },
		});
		const [rendered] = hub.piOperatorView(session.id);
		assert.equal(hasInertBreach(rendered), false, `a live class survived: ${JSON.stringify(rendered)}`);
		assert.equal(rendered, `assistant: ${quoted(hostile)}`);
		// BOTH tool events: a composer used for starts and bypassed for ends
		// would leave half the rows live.
		session.onEvent({ type: "tool_execution_start", toolName: "read\u0007file" });
		assert.equal(hub.piOperatorView(session.id)[1], `tool started: ${quoted("read\u0007file")}`);
		session.onEvent({ type: "tool_execution_end", toolName: "write\u0007 file" });
		assert.equal(hub.piOperatorView(session.id)[2], `tool ended: ${quoted("write\u0007 file")}`);
		// The SAME hostile text through the partial path, which arrives as deltas
		// and is held raw until a row is rendered: a row composed by concatenation
		// rather than through the one composer would show it live, and the
		// structural lock's interpolation scan cannot see a concatenation.
		for (const delta of [...hostile])
			session.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
		const live = hub.piOperatorView(session.id).find((candidate) => candidate.startsWith("partial: "));
		assert.ok(live, "the deltas rendered no partial row");
		assert.equal(hasInertBreach(live), false, `a live class survived the partial row: ${JSON.stringify(live)}`);
		assert.equal(live, `partial: ${quoted(hostile)}`);
		// A completed message supersedes the deltas that preceded it.
		session.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "draft text" } });
		assert.ok(hub.piOperatorView(session.id).some((row) => row.startsWith("partial: ")));
		session.onEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "the completed message" }] },
		});
		assert.equal(
			hub.piOperatorView(session.id).some((row) => row.startsWith("partial: ")),
			false,
			"a delta survived its completion",
		);
	} finally {
		session.end();
	}
	// end() leaves nothing: no rows, and one fewer live session.
	const after = hub.beginPiOperatorSession();
	after.onEvent({ type: "tool_execution_start", toolName: "t" });
	const live = hub.livePiOperatorSessions();
	after.end();
	assert.deepEqual(hub.piOperatorView(after.id), []);
	assert.equal(hub.livePiOperatorSessions(), live - 1);
}

/**
 * No artifact claims the delegate went unsteered. The check is a pattern over
 * the enumerated ways such a claim is worded, and that is its limit, stated
 * rather than discovered: prose can always be worded otherwise, so this
 * establishes that the named forms are absent, not that no sentence could
 * ever carry the meaning.
 */
function armComposesNoAttestation(sources: readonly string[]): void {
	const claims =
		/unsteered|(?:not|never|n't|without)[\s\w]{0,24}steer|no (?:operator )?steering|no operator (?:input|intervention|message)|without (?:operator )?intervention/i;
	for (const source of sources) {
		const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
		assert.equal(claims.test(code), false, "a module composes a claim of absent intervention");
	}
}

/**
 * The gate, measured by what the timer does rather than by where it stands.
 * The provisional checkpoint's own window is six minutes, which no test can
 * wait out, so every run below uses a copy whose window alone is shortened —
 * a test-local scaling of one constant, stated here so it is not mistaken for
 * the shipped bound. What is under test is the GATE: with the window short
 * enough to fire inside a run, a generic dispatch that writes no provisional
 * return must be cut off by it, and a Pi dispatch must not be.
 */
const SHORT_CHECKPOINT: readonly [string, string, string] = [DISPATCH, "}, 360_000),", "}, 250),"];

async function armArmsTheCheckpointOnlyForGeneric(dispatch: typeof runDispatchReal, repo: string): Promise<void> {
	// Generic: no provisional return is ever written, so the checkpoint aborts
	// the run long before its own deadline. This is the half that shows the
	// timer is armed at all, so a gate that never arms cannot pass either.
	{
		const started = performance.now();
		const outcome = await dispatch({
			callerRepoRoot: repo,
			stateRoot: join(repo, "state"),
			delegateArgv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
			brief: "brief",
			expectedRef: "HEAD",
			timeoutMs: 20_000,
			operationDeadline: performance.now() + 8_000,
			enteredAt: performance.now(),
		});
		const elapsed = performance.now() - started;
		assert.equal(outcome.disposition, "refused");
		assert.ok(elapsed < 5_000, `the generic checkpoint never fired: ${Math.round(elapsed)} ms`);
	}
	// Pi: SPEC §1.7 owes no provisional file from this child, so the same
	// checkpoint must not be armed — the run ends on its own deadline instead.
	{
		const scratch = mkdtempSync(join(tmpdir(), "gitjig-420-checkpoint-"));
		try {
			const executable = fakePi(join(scratch, "fake-pi"), { settleAfterMs: 60_000 });
			const deadline = performance.now() + 3_000;
			const started = performance.now();
			const outcome = await dispatch({
				callerRepoRoot: repo,
				stateRoot: join(repo, "state"),
				delegateArgv: [],
				brief: "brief",
				expectedRef: "HEAD",
				timeoutMs: 20_000,
				operationDeadline: deadline,
				enteredAt: performance.now(),
				pi: { piExecutable: executable, provider: "scripted", model: "scripted-model", role: "reviewer" },
			});
			const elapsed = performance.now() - started;
			assert.equal(outcome.disposition, "refused");
			assert.ok(
				elapsed > 2_000,
				`a conforming Pi child was cut off by the provisional checkpoint after ${Math.round(elapsed)} ms`,
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}
}

function armGatesTheCheckpoint(applies: typeof provisionalCheckpointApplies, dispatchSource: string): void {
	// SPEC §1.7 owes a provisional return from the generic argv child alone, so
	// the gate is exactly "bounded operation AND generic transport".
	const pi = { piExecutable: "/bin/true", provider: "p", model: "m", role: "reviewer" as const };
	assert.equal(applies({ operationDeadline: 1 }), true);
	assert.equal(applies({}), false);
	assert.equal(applies({ operationDeadline: 1, pi }), false, "the checkpoint armed under a Pi selection");
	assert.equal(applies({ pi }), false);
	// The predicate alone proves nothing about the timer it governs, and that
	// timer's own window is six minutes, which no test drives. So the call site
	// is read instead, and this arm says plainly that it is a lexical check:
	// the provisional arming must stand inside the gate, and nowhere else.
	const armings =
		dispatchSource.split("if (!admitReturn(context.returnPath).admitted) checkpointAbort.abort();").length - 1;
	assert.equal(armings, 1, "the provisional arming moved or multiplied; re-read this arm");
	const gated = dispatchSource.indexOf("if (provisionalCheckpointApplies(options))");
	assert.notEqual(gated, -1, "the provisional arming is not behind the gate");
	const provisional = dispatchSource.indexOf("if (!admitReturn(context.returnPath).admitted) checkpointAbort.abort();");
	assert.notEqual(provisional, -1, "the provisional arming moved; re-read this arm");
	assert.ok(gated < provisional, "the provisional arming does not follow its gate");
	assert.ok(provisional - gated < 200, "the provisional arming is no longer the statement the gate guards");
}

async function armRefusesEmptyGenericArgv(dispatch: typeof runDispatchReal, repo: string): Promise<void> {
	const outcome = await dispatch({
		callerRepoRoot: repo,
		stateRoot: join(repo, "state"),
		delegateArgv: [],
		brief: "brief",
		expectedRef: "HEAD",
		timeoutMs: 5_000,
		enteredAt: performance.now(),
	});
	assert.equal(outcome.disposition, "refused");
	if (outcome.disposition === "refused")
		assert.equal(outcome.diagnostic.code, "PARAMETER_REFUSED", "an empty generic argv passed the preflight");
}

async function armRunsThePiDelegate(dispatch: typeof runDispatchReal, repo: string): Promise<void> {
	// Two selections, so the whole invocation is observed rather than the two
	// fields that happen to appear in argv: the role and the caller's digest
	// reach the child only through the profile written beside its extension.
	for (const [label, pi, expected] of [
		[
			"a reviewer selection",
			{ provider: "scripted", model: "scripted-model", role: "reviewer" as const },
			{ role: "reviewer", specDigest: undefined },
		],
		[
			"a measurement selection with its digest",
			{
				provider: "other-provider",
				model: "other-model",
				role: "measurement" as const,
				specDigest: "d".repeat(64),
			},
			{ role: "recovery-measurement", specDigest: "d".repeat(64) },
		],
	] as ReadonlyArray<readonly [string, Omit<PiInvocation, "piExecutable">, { role: string; specDigest?: string }]>) {
		const scratch = mkdtempSync(join(tmpdir(), "gitjig-420-branch-"));
		try {
			const executable = fakePi(join(scratch, "fake-pi"), {});
			const outcome = await dispatch({
				callerRepoRoot: repo,
				stateRoot: join(repo, "state"),
				delegateArgv: [],
				brief: "brief",
				expectedRef: "HEAD",
				timeoutMs: 20_000,
				enteredAt: performance.now(),
				pi: { piExecutable: executable, ...pi },
			});
			// The child that ran is the Pi one: it received the runner's prompt.
			const prompts = frames(executable).filter((frame) => frame.type === "prompt");
			assert.equal(prompts.length, 1, `${label}: the Pi delegate never ran`);
			// And the selection the caller gave the DISPATCHER is the one that
			// reached the child: a provider, model, role or digest substituted on
			// the way through is a different run under the same name.
			const argv = prompts[0].argv as string[];
			assert.deepEqual(
				[argv[argv.indexOf("--provider") + 1], argv[argv.indexOf("--model") + 1]],
				[pi.provider, pi.model],
				`${label}: the dispatcher changed the provider or model on the way through`,
			);
			const profile = prompts[0].profile as { role?: string; fixed?: Record<string, unknown> } | null;
			assert.equal(profile?.role, expected.role, `${label}: the child was given another role`);
			assert.equal(profile?.fixed?.specDigest, expected.specDigest, `${label}: the child was given another digest`);
			// The context the DISPATCHER provisioned is the one the run used: the
			// child's trusted extension sits in that scratch, it runs in that
			// scratch's clone, and the brief beside it is the caller's own.
			const ran = prompts[0].provisioned as { tree: string; cwd: string; brief: string } | null;
			assert.ok(ran, `${label}: the child could not read the context it ran under`);
			assert.equal(ran.cwd, ran.tree, `${label}: the child did not run in the clone of its own scratch`);
			assert.equal(ran.brief, "brief", `${label}: the child was given another brief`);
			// No return was submitted, so the dispatch refuses on the missing slot
			// rather than on the transport — the generic admission still rules.
			assert.equal(outcome.disposition, "refused");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}
}

/* The arms, asserted to hold. */

test("the held operand never reaches the child: redacted whole, refused at the ruled bound", async () => {
	await withRunner([], armRedactsWholeHead);
	await withRunner([], armRefusesContainedRun);
	await withRunner([], armAdmitsShorterRun);
});

test("a refusal costs nothing, and every admitted role resolves to its own profile", async () => {
	await withRunner([], armRefusalCostsNothing);
	await withRunner([], armSelectsEachRole);
});

test("the provisioned context and the extension it returned travel to the supervisor, in order", async () => {
	await withRunner([], armSeamsCarryTheSameContext);
});

test("the caller's selection, bound and own signal reach the child", async () => {
	await withRunner([], armCarriesTheCallersSelection);
});

test("one purposeful prompt, then settle, close and terminal — and no second send", async () => {
	await withRunner([], armSendsOnePurposefulPrompt);
});

test("every hub session the runner begins is ended exactly once, and only its own", async () => {
	await withRunner([], armEndsItsOwnSessionOnce);
	await withRunner([], armLeavesTheConcurrentSessionAlone);
});

test("the hub keeps the supervisor's one observer slot, and a view only gets controls", async () => {
	await withRunner([], armKeepsTheObserverSlot);
});

test("each supervisor terminal maps onto exactly one run outcome", async () => {
	await withRunner([], armMapsEachTerminal);
});

test("no delegate text and no claim of absent intervention leaves this part's modules", async () => {
	await withRunner([], armKeepsNoChildTextInTheOutcome);
	// The dispatcher is in this list too: it is the surface that writes audit
	// records for a Pi run, so it is where such a claim would be emitted.
	armComposesNoAttestation(
		[RUN, HUB, DISPATCH].map((relative) => readFileSync(join(extensionsRoot, relative), "utf8")),
	);
});

test("the hub bounds what an operator would see, at each boundary and without losing its label", () => {
	armBoundsTheComposedView(hubReal);
	armBoundsTheComposedRow(hubReal);
	armRendersInertly(hubReal);
});

test("the dispatcher's Pi option is internal, exact, and leaves the generic path alone", async () => {
	// The model-facing surface carries no Pi field. This reads the parameters
	// the tool actually registers rather than their source text, so a key
	// spelled any way a model could still send is covered.
	assert.deepEqual(registeredDispatchParameterKeys(), ["brief", "delegateArgv", "expectedRef", "timeoutMs"]);

	armGatesTheCheckpoint(provisionalCheckpointApplies, readFileSync(join(extensionsRoot, DISPATCH), "utf8"));
	const repo = repository();
	try {
		await armRefusesEmptyGenericArgv(runDispatchReal, repo);
		await armRunsThePiDelegate(runDispatchReal, repo);
		await withDispatcher([], async (dispatch, _applies, _source, _keys, handed) =>
			armDerivesTheRunBound(dispatch, repo, handed),
		);
		// The gate, measured through a copy whose checkpoint window alone is
		// shortened: the shipped window is six minutes and no test waits it out.
		await withDispatcher([SHORT_CHECKPOINT], async (dispatch) => armArmsTheCheckpointOnlyForGeneric(dispatch, repo));
		// Malformed framing reaches exactly the existing internal-failure class.
		const scratch = mkdtempSync(join(tmpdir(), "gitjig-420-invalid-"));
		try {
			const executable = join(scratch, "fake-pi");
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
			rmSync(scratch, { recursive: true, force: true });
		}
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

/*
 * The mutants. Each runs the arm that owns the property and requires THAT ARM
 * to fail — a mutant asserted in its own words would report a kill no arm
 * observed.
 */

async function armFails(arm: RunnerArm, edits: Edits, named: string): Promise<void> {
	await assert.rejects(
		() => withRunner(edits, arm),
		(error: unknown) => {
			assert.ok(error instanceof assert.AssertionError, `${named}: the arm failed for another reason: ${error}`);
			return true;
		},
		`${named}: the owner arm still passed`,
	);
}

test("baseline-first private-copy mutants: the runner's seams", async () => {
	await armFails(
		armRedactsWholeHead,
		[[RUN, "if (redacted !== original) writeFileSync(context.briefPath, redacted);", "void redacted;"]],
		"the redaction removed",
	);
	// The brief is redacted and the operand rides in the PROMPT instead: every
	// assertion about the brief still holds, and only what the child received
	// shows it.
	await armFails(
		armRedactsWholeHead,
		[
			[
				RUN,
				'prompt: "Read ../brief.md; submit your final result with the available submit_result tool.",',
				"prompt: `Read ../brief.md at ${context.heldHash}; submit your final result with the available submit_result tool.`,",
			],
		],
		"the held operand carried in the prompt",
	);
	await armFails(
		armRefusesContainedRun,
		[
			[
				RUN,
				'if (namesHeldOperand(redacted, context.heldHash)) return refusal("invalid");',
				'if (redacted.includes(context.heldHash.slice(0, 7))) return refusal("invalid");',
			],
		],
		"the ruled predicate narrowed to its prefix branch",
	);
	await armFails(
		armRefusalCostsNothing,
		[[RUN, '(invocation.role !== "measurement" && invocation.specDigest !== undefined)', "false"]],
		"the role/digest pairing dropped",
	);
	await armFails(
		armSeamsCarryTheSameContext,
		[[RUN, "\t\t\textensionPath,", "\t\t\textensionPath: context.briefPath,"]],
		"another extension handed to the supervisor",
	);
	await armFails(
		armCarriesTheCallersSelection,
		[[RUN, "timeoutMs: options.timeoutMs ?? DEFAULT_RUN_BOUND_MS,", "timeoutMs: DEFAULT_RUN_BOUND_MS,"]],
		"the caller's bound dropped",
	);
	await armFails(
		armCarriesTheCallersSelection,
		[
			[
				RUN,
				"\t\t\tsignal: options.signal,",
				'\t\t\tsignal: (() => {\n\t\t\t\tconst mirror = new AbortController();\n\t\t\t\toptions.signal?.addEventListener("abort", () => mirror.abort(), { once: true });\n\t\t\t\treturn mirror.signal;\n\t\t\t})(),',
			],
		],
		"a mirrored signal of the runner's own",
	);
	await armFails(
		armSendsOnePurposefulPrompt,
		[[RUN, "\t\tsession.close();", '\t\tawait session.prompt("submit now");\n\t\tsession.close();']],
		"a second send",
	);
	await armFails(
		armSendsOnePurposefulPrompt,
		[
			[
				RUN,
				"\t\tawait session.waitForSettle(0);\n\t\tsession.close();",
				"\t\tsession.close();\n\t\tawait session.waitForSettle(0);",
			],
		],
		"a close taken before the settle wait",
	);
	await armFails(
		armSendsOnePurposefulPrompt,
		[
			[
				RUN,
				'prompt: "Read ../brief.md; submit your final result with the available submit_result tool.",',
				'prompt: "Proceed.",',
			],
		],
		"an empty-purpose prompt",
	);
	await armFails(
		armEndsItsOwnSessionOnce,
		[[RUN, "\t\toperator.end();\n\t}", "\t}"]],
		"the normal-terminal teardown deleted",
	);
	// The other teardown: the one that runs when provisioning or the start
	// itself fails, which the ordinary path never reaches.
	await armFails(
		armEndsItsOwnSessionOnce,
		[[RUN, '\t\toperator.end();\n\t\treturn refusal("spawn");', '\t\treturn refusal("spawn");']],
		"the failed-start teardown deleted",
	);
	await armFails(
		armEndsItsOwnSessionOnce,
		[[RUN, "\t\toperator.end();\n\t}", "\t\toperator.end();\n\t\toperator.end();\n\t}"]],
		"the teardown duplicated",
	);
	// The raw session bound instead of controls: a view could then take the
	// observer slot, and the hub would stop seeing the child it is draining.
	await armFails(
		armKeepsTheObserverSlot,
		[
			[
				HUB,
				"\t\t\tconst { attach: _attach, detach: _detach, ...controls } = session;",
				"\t\t\tconst controls = session;",
			],
		],
		"the raw session bound to the hub",
	);
	await armFails(
		armLeavesTheConcurrentSessionAlone,
		[[HUB, "\t\t\tactive.delete(item.id);", "\t\t\tactive.delete([...active.keys()][0] ?? item.id);"]],
		"a teardown that ends the oldest session instead of its own",
	);
	await armFails(
		armMapsEachTerminal,
		[
			[
				RUN,
				'if (terminal === "timeout") return refusal("timeout");',
				'if (terminal === "timeout") return refusal("abort");',
			],
		],
		"a terminal mapped onto another",
	);
	await armFails(
		armSeamsCarryTheSameContext,
		[[RUN, "\t\t\tonOperatorEvent: operator.onEvent,", ""]],
		"a supervisor started with no operator sink",
	);
	await armFails(
		armSeamsCarryTheSameContext,
		[[RUN, "\t\t\tcontext,", "\t\t\tcontext: { ...context, stateDir: context.returnPath },"]],
		"a context whose state root the runner substituted",
	);
	// A substituted schema: the role and the digest are right, and only the
	// shape the child may submit moves.
	await armFails(
		armSelectsEachRole,
		[
			[
				RUN,
				"const extensionPath = provisionPiSubmitTool(context, profile);",
				"const extensionPath = provisionPiSubmitTool(context, { ...profile, schema: REVIEW_PI_PROFILES.reviewer.schema });",
			],
		],
		"another consumer's schema under the right role",
	);
	// A different VALID digest: the role is right and only the fixed field moves.
	await armFails(
		armSelectsEachRole,
		[
			[
				RUN,
				": recoveryPiProfile(invocation.role as RecoveryPiRole, invocation.specDigest);",
				': recoveryPiProfile(invocation.role as RecoveryPiRole, invocation.specDigest === undefined ? undefined : "c".repeat(64));',
			],
		],
		"another digest reaching the profile",
	);
	// The numeric terminal narrowed to `settled`: a child that never settles is
	// then refused, which only the no-settle case can see.
	await armFails(
		armMapsEachTerminal,
		[
			[
				RUN,
				'if ((terminal !== "settled" && terminal !== "exited") || session.exitCode === null) return refusal("invalid");',
				'if (terminal !== "settled" || session.exitCode === null) return refusal("invalid");',
			],
		],
		"a numeric exit without a settle refused",
	);
	await armFails(
		armSeamsCarryTheSameContext,
		[[RUN, "\toperator.bind(session);", ""]],
		"a session never bound to its child",
	);
});

test("baseline-first private-copy mutants: the hub's bounds and the dispatcher's gates", async () => {
	// The composed row cap: without it the partial row rides beside a full view.
	await assert.rejects(
		() => withHub([[HUB, "\treturn rows.slice(-MAX_VIEW_ROWS);", "\treturn rows;"]], armBoundsTheComposedView),
		assert.AssertionError,
		"the row cap mutant left the arm passing",
	);
	// The row composed by clipping from the right, as a bound stated over the
	// whole row would: the delegate's text survives and the label does not.
	await assert.rejects(
		() =>
			withHub(
				[
					[
						HUB,
						"\treturn `${prefix}${clip(text, MAX_ROW_POINTS - [...prefix].length)}`;",
						"\treturn clip(`${prefix}${text}`, MAX_ROW_POINTS);",
					],
				],
				armBoundsTheComposedRow,
			),
		assert.AssertionError,
		"the prefix-erasing mutant left the arm passing",
	);
	// The partial row composed by concatenation instead of through the one
	// composer. The structural lock scans `${…}` interpolations, so it cannot
	// see a concatenation at all; only this behavioural arm catches it.
	await assert.rejects(
		() => withHub([[HUB, "[row(PARTIAL_PREFIX, item.partial)]", "[PARTIAL_PREFIX + item.partial]"]], armRendersInertly),
		assert.AssertionError,
		"the raw partial-row mutant left the arm passing",
	);
	// Delegate text rendered through a narrower class than the shared escaper
	// owns: C0 alone leaves a line separator and a bidi control standing.
	await assert.rejects(
		() =>
			withHub(
				[
					[
						HUB,
						'\treturn [...quoted(value)].slice(-Math.max(0, points)).join("");',
						'\treturn [...value]\n\t\t.slice(-Math.max(0, points))\n\t\t.map((character) => ((character.codePointAt(0) ?? 0) < 32 ? " " : character))\n\t\t.join("");',
					],
				],
				armRendersInertly,
			),
		assert.AssertionError,
		"the inert-rendering mutant left the arm passing",
	);
	// A module that composes a claim of absent intervention, in each of the
	// wordings the arm enumerates — including an audit line that says it
	// plainly rather than using the word the first pattern was written for.
	for (const composed of [
		"const line = `assistant (unsteered by any operator): ${text}`;",
		'record("run-started", "dispatch run started: operator did not steer the delegate");',
		'record("run-started", "no operator intervention occurred");',
	])
		assert.throws(
			() => armComposesNoAttestation([composed]),
			assert.AssertionError,
			`the attestation mutant left the arm passing: ${composed}`,
		);

	// The checkpoint gate, with its transport condition dropped.
	await assert.rejects(
		() =>
			withDispatcher(
				[
					[
						DISPATCH,
						"return options.operationDeadline !== undefined && options.pi === undefined;",
						"return options.operationDeadline !== undefined;",
					],
				],
				async (_dispatch, applies, source) => armGatesTheCheckpoint(applies, source),
			),
		assert.AssertionError,
		"the checkpoint-gate mutant left the arm passing",
	);
	// And the gate removed from the arming itself, leaving the predicate right.
	// This one is measured by what the timer does: with the window shortened,
	// an ungated checkpoint cuts off a conforming Pi child.
	const repoForGate = repository();
	try {
		await assert.rejects(
			() =>
				withDispatcher(
					[SHORT_CHECKPOINT, [DISPATCH, "if (provisionalCheckpointApplies(options))", "if (true)"]],
					async (dispatch) => armArmsTheCheckpointOnlyForGeneric(dispatch, repoForGate),
				),
			assert.AssertionError,
			"the ungated-arming mutant left the arm passing",
		);
		// The predicate widened to admit Pi reaches the same place.
		await assert.rejects(
			() =>
				withDispatcher(
					[
						SHORT_CHECKPOINT,
						[
							DISPATCH,
							"return options.operationDeadline !== undefined && options.pi === undefined;",
							"return options.operationDeadline !== undefined;",
						],
					],
					async (dispatch) => armArmsTheCheckpointOnlyForGeneric(dispatch, repoForGate),
				),
			assert.AssertionError,
			"the widened-predicate mutant left the behavioural arm passing",
		);
		// And the arming deleted outright: the generic half then never fires,
		// so an arm that only watched the Pi side could not tell the difference.
		await assert.rejects(
			() =>
				withDispatcher([[DISPATCH, "if (provisionalCheckpointApplies(options))", "if (false)"]], async (dispatch) =>
					armArmsTheCheckpointOnlyForGeneric(dispatch, repoForGate),
				),
			assert.AssertionError,
			"the deleted-arming mutant left the arm passing",
		);
	} finally {
		rmSync(repoForGate, { recursive: true, force: true });
	}

	// A Pi selection exposed on the model-facing surface, spelled as a computed
	// key — which is why the arm reads the registered parameters, not the text.
	await assert.rejects(
		() =>
			withDispatcher(
				[
					[
						DISPATCH,
						'const DISPATCH_PARAMS = {\n\ttype: "object",\n\tproperties: {',
						'const DISPATCH_PARAMS = {\n\ttype: "object",\n\tproperties: {\n\t\t["pi"]: { type: "object" },',
					],
				],
				async (_dispatch, _applies, _source, keys) => {
					assert.deepEqual(keys(), ["brief", "delegateArgv", "expectedRef", "timeoutMs"]);
				},
			),
		assert.AssertionError,
		"the exposed-Pi-field mutant left the arm passing",
	);

	const repo = repository();
	try {
		// The empty-argv relaxation, without its Pi condition.
		await assert.rejects(
			() =>
				withDispatcher(
					[[DISPATCH, "(options.pi === undefined && options.delegateArgv.length === 0)", "false"]],
					async (dispatch) => armRefusesEmptyGenericArgv(dispatch, repo),
				),
			assert.AssertionError,
			"the empty-argv mutant left the arm passing",
		);
		// The transport branch, forced to the generic executor.
		await assert.rejects(
			() =>
				withDispatcher([[DISPATCH, "\t\t\t\toptions.pi === undefined\n", "\t\t\t\ttrue\n"]], async (dispatch) =>
					armRunsThePiDelegate(dispatch, repo),
				),
			assert.AssertionError,
			"the transport-branch mutant left the arm passing",
		);
		// The caller's selection substituted on the way through the dispatcher.
		await assert.rejects(
			() =>
				withDispatcher(
					[
						[
							DISPATCH,
							": await runPiDelegate(context, options.pi, {",
							': await runPiDelegate(context, { ...options.pi, provider: "substituted" }, {',
						],
					],
					async (dispatch) => armRunsThePiDelegate(dispatch, repo),
				),
			assert.AssertionError,
			"the substituted-provider mutant left the arm passing",
		);
		// The context the dispatcher provisioned, substituted on the way through.
		await assert.rejects(
			() =>
				withDispatcher(
					[
						[
							DISPATCH,
							": await runPiDelegate(context, options.pi, {",
							": await runPiDelegate({ ...context, treeDir: context.scratchRoot }, options.pi, {",
						],
					],
					async (dispatch) => armRunsThePiDelegate(dispatch, repo),
				),
			assert.AssertionError,
			"the substituted-context mutant left the arm passing",
		);
		// A bound three times the derived one: the run still ends, so only an
		// expectation tied to the deadline itself can see it.
		await assert.rejects(
			() =>
				withDispatcher(
					[
						[
							DISPATCH,
							": await runPiDelegate(context, options.pi, {\n\t\t\t\t\t\t\ttimeoutMs: runBound,",
							": await runPiDelegate(context, options.pi, {\n\t\t\t\t\t\t\ttimeoutMs: (runBound ?? 0) * 3,",
						],
					],
					async (dispatch, _applies, _source, _keys, handed) => armDerivesTheRunBound(dispatch, repo, handed),
				),
			assert.AssertionError,
			"the widened-bound mutant left the arm passing",
		);
		// The derived bound, replaced by the caller's raw timeout.
		await assert.rejects(
			() =>
				withDispatcher(
					[
						[
							DISPATCH,
							": await runPiDelegate(context, options.pi, {\n\t\t\t\t\t\t\ttimeoutMs: runBound,",
							": await runPiDelegate(context, options.pi, {\n\t\t\t\t\t\t\ttimeoutMs: options.timeoutMs,",
						],
					],
					async (dispatch, _applies, _source, _keys, handed) => armDerivesTheRunBound(dispatch, repo, handed),
				),
			assert.AssertionError,
			"the raw-timeout mutant left the arm passing",
		);
		// The role, likewise: it reaches the child only through the profile.
		await assert.rejects(
			() =>
				withDispatcher(
					[
						[
							DISPATCH,
							": await runPiDelegate(context, options.pi, {",
							': await runPiDelegate(context, { ...options.pi, role: "judge" }, {',
						],
					],
					async (dispatch) => armRunsThePiDelegate(dispatch, repo),
				),
			assert.AssertionError,
			"the substituted-provider mutant left the arm passing",
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

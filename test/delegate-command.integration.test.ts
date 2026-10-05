/**
 * #424, part 8 of #370: the `/delegate` operator command over part 6's event
 * hub, and the two #370 seventh-criterion arms no earlier part carried.
 *
 * Every arm is a named function used twice: by the test that asserts it holds,
 * and by its baseline-first mutants, which run it against an edited private
 * copy of the `.pi` subtree and require it to fail with an assertion. A copy
 * laid out like the repository loads every module the arm touches, so the
 * command, the hub and the dispatcher it drives are one registry. A stale
 * anchor throws a plain Error, so a harness fault can never read as a kill.
 *
 * Seams are instrumented rather than inferred: the extension API is a proxy
 * that records every channel it is asked for, a hub session is bound to a
 * recorder that notes every control call, and where a property lives only in
 * a session's lifetime (its rows at its end), the copy's hub records it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const COMMAND = "commands/delegate.ts";
const HUB = "dispatch/pi-operator.ts";
const SPINE = "commands/index.ts";
const DISPATCH = "dispatch/index.ts";
const SUPERVISOR = "dispatch/pi-rpc.ts";
const RUNNER = "dispatch/pi-run.ts";
const ACTIONS = ["Refresh", "Steer", "Follow up", "Clear queue", "Abort", "Detach"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// biome-ignore lint/suspicious/noExplicitAny: modules loaded from a private copy have no static type
type Load = (relative: string) => Promise<any>;
type Edits = ReadonlyArray<readonly [string, string, string]>;
type Handler = (args: string, ctx: unknown) => Promise<void>;
type Act = readonly unknown[];

/*
 * The harness: a private copy of the extension tree in the repository's own
 * layout, edited, with every module loaded from it.
 */
async function withCopy<T>(edits: Edits, scenario: (load: Load, scratch: string) => Promise<T>): Promise<T> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-424-"));
	try {
		const root = join(scratch, ".pi/extensions/gitjig");
		cpSync(join(repoRoot, ".pi/extensions/gitjig"), root, { recursive: true });
		symlinkSync(join(repoRoot, "node_modules"), join(scratch, "node_modules"), "dir");
		symlinkSync(join(repoRoot, ".github"), join(scratch, ".github"), "dir");
		for (const [relative, from, to] of edits) {
			const path = join(root, relative);
			const source = readFileSync(path, "utf8");
			if (source.indexOf(from) === -1 || source.indexOf(from) !== source.lastIndexOf(from))
				throw new Error(`anchor must exist once in ${relative}: ${from}`);
			writeFileSync(
				path,
				source.replace(from, () => to),
			);
		}
		return await scenario((relative) => import(pathToFileURL(join(root, relative)).href), scratch);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

type Arm = (load: Load, scratch: string) => Promise<void>;

async function armFails(arm: Arm, edits: Edits, named: string): Promise<void> {
	await assert.rejects(
		() => withCopy(edits, arm),
		(error: unknown) => {
			assert.ok(error instanceof assert.AssertionError, `${named}: the arm failed for another reason: ${error}`);
			return true;
		},
		`${named}: the owner arm still passed`,
	);
}

/** The extension API as a recorder: `registerCommand` captures; every other channel is a write. */
function api(): { pi: unknown; handler: () => Handler; registered: string[]; writes: string[] } {
	const registered: string[] = [];
	const writes: string[] = [];
	let handler: Handler | undefined;
	const pi = new Proxy(
		{},
		{
			get: (_target, name) =>
				name === "registerCommand"
					? (command: string, definition: { handler: Handler }) => {
							registered.push(command);
							handler = definition.handler;
						}
					: (..._args: unknown[]) => {
							writes.push(String(name));
						},
		},
	);
	return {
		pi,
		handler: () => {
			assert.ok(handler, "no command was registered");
			return handler;
		},
		registered,
		writes,
	};
}

/**
 * The operator's terminal, scripted. Each select answers from its script; a
 * select past the script answers Detach and is recorded, so an arm can tell an
 * extra round from the one it scripted.
 */
type Answer = string | undefined | ((options: string[]) => string | undefined | Promise<string | undefined>);
function terminal(selects: Answer[], inputs: Answer[] = [], mode = "tui") {
	const seen = {
		selects: [] as { title: string; options: string[] }[],
		inputs: [] as string[],
		notices: [] as string[],
		exhausted: false,
	};
	const ui = {
		select: async (title: string, options: string[]) => {
			seen.selects.push({ title, options: [...options] });
			if (selects.length === 0) {
				seen.exhausted = true;
				return "Detach";
			}
			const next = selects.shift();
			return typeof next === "function" ? await next(options) : next;
		},
		input: async (title: string) => {
			seen.inputs.push(title);
			const next = inputs.shift();
			return typeof next === "function" ? await next([]) : next;
		},
		notify: (text: string) => {
			seen.notices.push(text);
		},
	};
	return { ctx: { mode, hasUI: true, ui }, seen };
}

/** A hub session bound to a recorder that notes every call, the forbidden ones included. */
function liveSession(hub: { beginPiOperatorSession: () => HubSession }, acts: Act[], bind = true) {
	const session = hub.beginPiOperatorSession();
	const record =
		(name: string) =>
		(...args: unknown[]) => {
			acts.push([name, ...args]);
			return Promise.resolve(true);
		};
	if (bind)
		session.bind({
			command: (type: string, message: string) => {
				acts.push([type, message]);
				return Promise.resolve(true);
			},
			clearQueue: record("clearQueue"),
			abort: () => {
				acts.push(["abort"]);
			},
			waitForSettle: record("waitForSettle"),
			attach: record("attach"),
			detach: record("detach"),
			prompt: record("prompt"),
			close: record("close"),
			done: new Promise(() => {}),
			exitCode: null,
			exitSignal: null,
			settleCount: 0,
		} as never);
	return session;
}
type HubSession = {
	id: string;
	onEvent: (event: unknown) => void;
	bind: (session: never) => void;
	end: () => void;
};

const toolStart = (name: string) => ({ type: "tool_execution_start", toolName: name });
const FORBIDDEN = new Set(["waitForSettle", "attach", "detach", "prompt", "close"]);
const noForbiddenAct = (acts: Act[], label: string) =>
	assert.deepEqual(
		acts.filter((act) => FORBIDDEN.has(String(act[0]))),
		[],
		`${label}: a capability outside the operator acts was used`,
	);

/** Ends every session an arm leaves open, so no copy's registry outlives its arm. */
function endAll(sessions: HubSession[]): void {
	for (const session of sessions) session.end();
}

// ---------------------------------------------------------------------------
// Criterion 1: registration, and the terminal-only gate.

const armRegistersOnce: Arm = async (load) => {
	const { registerSpineCommands } = await load(SPINE);
	const spine = api();
	registerSpineCommands(spine.pi, "/r", "/s", undefined, {
		mergeMode: "off",
		mergeSource: "default",
		decisionMode: "handoff",
		decisionSource: "default",
		refusals: [],
	});
	assert.equal(spine.registered.filter((name) => name === "delegate").length, 1, "delegate is not registered once");
	assert.equal(new Set(spine.registered).size, spine.registered.length, "a command name registers twice");
	const source = readFileSync(join(repoRoot, ".pi/extensions/gitjig", SPINE), "utf8");
	assert.match(source, /`delegate`\)\. Phase 6/, "the spine's own statement of what registers there omits delegate");
};

const armIsTerminalOnly: Arm = async (load) => {
	const hub = await load(HUB);
	const { registerDelegateCommand } = await load(COMMAND);
	const acts: Act[] = [];
	const session = liveSession(hub, acts);
	session.onEvent(toolStart("visible"));
	try {
		for (const mode of ["rpc", "json", "print"])
			for (const hasUI of [true, false]) {
				const command = api();
				registerDelegateCommand(command.pi);
				const operator = terminal(["Abort"], [], mode);
				await command.handler()("", { ...operator.ctx, hasUI });
				assert.deepEqual(operator.seen.selects, [], `${mode}: a view was offered outside the terminal UI`);
				assert.deepEqual(operator.seen.notices, [], `${mode}: something was shown outside the terminal UI`);
				assert.deepEqual(operator.seen.inputs, [], `${mode}: input was asked outside the terminal UI`);
				assert.deepEqual(command.writes, [], `${mode}: the command wrote to the session`);
			}
		assert.deepEqual(acts, [], "a control was used outside the terminal UI");
		// The control: in the terminal UI the same session is offered.
		const command = api();
		registerDelegateCommand(command.pi);
		const operator = terminal(["Detach"]);
		await command.handler()("", operator.ctx);
		assert.equal(operator.seen.selects.length, 1, "the terminal UI offered no view");
	} finally {
		session.end();
	}
};

// ---------------------------------------------------------------------------
// Criterion 2: the hub's own rows, the narrowed controls, the listing.

const armReadsOnlyTheHub: Arm = async (load) => {
	const hub = await load(HUB);
	const { registerDelegateCommand } = await load(COMMAND);
	const acts: Act[] = [];
	// The listing's membership, exactly.
	const unbound = liveSession(hub, acts, false);
	assert.deepEqual(hub.livePiOperatorIds(), [], "a session not yet bound is listed");
	const first = liveSession(hub, acts);
	const second = liveSession(hub, acts);
	assert.deepEqual(hub.livePiOperatorIds(), [first.id, second.id], "the bound live sessions are not listed once each");
	for (const id of hub.livePiOperatorIds()) assert.match(id, UUID, "a listed value is not the hub's identifier");
	second.end();
	assert.deepEqual(hub.livePiOperatorIds(), [first.id], "an ended session is still listed");
	// The control set a view receives is the operator acts and nothing else.
	assert.deepEqual(Object.keys(hub.piOperatorControls(first.id)).sort(), ["abort", "clearQueue", "command"]);
	// The rows rendered are exactly the hub's own, each marked as a row.
	first.onEvent(toolStart("alpha"));
	first.onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "said" }] } });
	const command = api();
	registerDelegateCommand(command.pi);
	const operator = terminal(["Detach"]);
	await command.handler()("", operator.ctx);
	assert.deepEqual(
		operator.seen.selects[0]?.options,
		[...ACTIONS, ...hub.piOperatorView(first.id).map((row: string) => `· ${row}`)],
		"the view is not the hub's own rows",
	);
	// And the command imports nothing of the hub but its exported surface.
	const source = readFileSync(join(repoRoot, ".pi/extensions/gitjig", COMMAND), "utf8");
	const imported = [...source.matchAll(/^import[^;]*from "([^"]+)";$/gm)].map((match) => match[0]);
	assert.deepEqual(
		imported.filter((line) => line.includes("../dispatch/")),
		['import { livePiOperatorIds, piOperatorControls, piOperatorView } from "../dispatch/pi-operator.ts";'],
		"the command reaches past the hub's exported surface",
	);
	noForbiddenAct(acts, "reads");
	endAll([unbound, first]);
};

// ---------------------------------------------------------------------------
// Criterion 3: attachment, by how many are live.

const armAttaches: Arm = async (load) => {
	const hub = await load(HUB);
	const { registerDelegateCommand } = await load(COMMAND);
	const run = async (operator: ReturnType<typeof terminal>) => {
		const command = api();
		registerDelegateCommand(command.pi);
		await command.handler()("", operator.ctx);
		return operator.seen;
	};
	// None live: a notice, and no control offered.
	const none = await run(terminal(["Abort"]));
	assert.deepEqual(none.selects, [], "a view was offered with nothing live");
	assert.deepEqual(none.notices, ["No running Pi delegate"]);
	// One live: attached directly, no chooser.
	const acts: Act[] = [];
	const only = liveSession(hub, acts);
	const one = await run(terminal(["Abort"]));
	assert.equal(one.selects[0]?.title, "Pi delegate (events are operator-only)", "one live session was not attached");
	assert.deepEqual(acts, [["abort"]]);
	only.end();
	// Several: the operator names one, and only that one is acted on.
	const firstActs: Act[] = [];
	const secondActs: Act[] = [];
	const first = liveSession(hub, firstActs);
	const second = liveSession(hub, secondActs);
	const several = await run(terminal([second.id, "Abort"]));
	assert.deepEqual(several.selects[0], { title: "Attach to delegate", options: [first.id, second.id] });
	assert.deepEqual(secondActs, [["abort"]], "the selected session was not the one acted on");
	assert.deepEqual(firstActs, [], "an unselected session was acted on");
	// A cancelled choice of session, and an identifier the hub never listed.
	for (const [label, answer] of [
		["cancelled", undefined],
		["unlisted", "00000000-0000-4000-8000-000000000000"],
	] as const) {
		const seen = await run(terminal([answer, "Abort"]));
		assert.equal(seen.selects.length, 1, `${label}: a view followed a ${label} selection`);
		assert.deepEqual(seen.notices, [], `${label}: a ${label} selection reached a session`);
	}
	assert.deepEqual([...firstActs, ...secondActs], [["abort"]], "a cancelled or unlisted selection was acted on");
	endAll([first, second]);
};

// ---------------------------------------------------------------------------
// Criterion 4: each action, one control.

const armMapsEachAction: Arm = async (load) => {
	const hub = await load(HUB);
	const { registerDelegateCommand } = await load(COMMAND);
	for (const [label, selects, inputs, expected, rounds] of [
		["steer", ["Steer"], ["steer text"], [["steer", "steer text"]], 2],
		["follow up", ["Follow up"], ["follow text"], [["follow_up", "follow text"]], 2],
		["clear queue", ["Clear queue"], [], [["clearQueue"]], 2],
		["abort", ["Abort"], [], [["abort"]], 1],
		["detach", ["Detach"], [], [], 1],
		["refresh", ["Refresh"], [], [], 2],
		["a row", [(options: string[]) => options[ACTIONS.length]], [], [], 2],
		["empty steer", ["Steer"], [""], [], 2],
		["cancelled steer", ["Steer"], [undefined], [], 2],
		["empty follow up", ["Follow up"], [""], [], 2],
	] as ReadonlyArray<readonly [string, Answer[], Answer[], Act[], number]>) {
		const acts: Act[] = [];
		const session = liveSession(hub, acts);
		session.onEvent(toolStart("row"));
		const command = api();
		registerDelegateCommand(command.pi);
		const operator = terminal([...selects], [...inputs]);
		await command.handler()("", operator.ctx);
		assert.deepEqual(acts, expected, `${label}: the controls used`);
		// Abort and Detach leave; every other choice returns to the view once.
		assert.equal(operator.seen.selects.length, rounds, `${label}: the rounds`);
		assert.equal(operator.seen.exhausted, rounds === 2, `${label}: whether the view was offered again`);
		noForbiddenAct(acts, label);
		session.end();
	}
};

// ---------------------------------------------------------------------------
// Criterion 5: detach and a cancelled choice leave, and the draining goes on.

const armLeavesTheChildRunning: Arm = async (load) => {
	const hub = await load(HUB);
	const { registerDelegateCommand } = await load(COMMAND);
	const acts: Act[] = [];
	const session = liveSession(hub, acts);
	session.onEvent(toolStart("before"));
	for (const [label, answer] of [
		["detach", "Detach"],
		["cancel", undefined],
	] as const) {
		const command = api();
		registerDelegateCommand(command.pi);
		const leaving = terminal([answer]);
		await command.handler()("", leaving.ctx);
		assert.deepEqual(acts, [], `${label}: leaving acted on the child`);
		// It left at once: the view was not offered again.
		assert.equal(leaving.seen.selects.length, 1, `${label}: the view was offered again`);
		assert.equal(leaving.seen.exhausted, false, `${label}: the view was offered again`);
		// Events after the operator left still reach the hub, and a reattach shows them.
		session.onEvent(toolStart(`after-${label}`));
		const again = api();
		registerDelegateCommand(again.pi);
		const reattached = terminal([undefined]);
		await again.handler()("", reattached.ctx);
		assert.ok(
			reattached.seen.selects[0]?.options.some((option) => option.includes(`after-${label}`)),
			`${label}: rows produced while detached were not shown on reattach`,
		);
	}
	assert.deepEqual(acts, [], "a leaving path acted on the child");
	session.end();
};

// ---------------------------------------------------------------------------
// Criterion 6: the controls are fetched again for every act.

const armRefetchesBeforeEachAct: Arm = async (load) => {
	const hub = await load(HUB);
	const { registerDelegateCommand } = await load(COMMAND);
	for (const [label, selects, inputs] of [
		[
			"ended while typing a steer",
			["Steer"],
			[
				() => {
					current?.end();
					return "late";
				},
			],
		],
		[
			"ended while choosing abort",
			[
				() => {
					current?.end();
					return "Abort";
				},
			],
			[],
		],
		[
			"ended while choosing to clear",
			[
				() => {
					current?.end();
					return "Clear queue";
				},
			],
			[],
		],
	] as ReadonlyArray<readonly [string, Answer[], Answer[]]>) {
		const acts: Act[] = [];
		current = liveSession(hub, acts);
		const command = api();
		registerDelegateCommand(command.pi);
		const operator = terminal([...selects], [...inputs]);
		await command.handler()("", operator.ctx);
		assert.deepEqual(acts, [], `${label}: an ended session received an act`);
		assert.deepEqual(operator.seen.notices, ["That Pi delegate has ended"], `${label}: the notice`);
	}
	current = undefined;
};
let current: HubSession | undefined;

// ---------------------------------------------------------------------------
// Real runs: a fixture repository, fake or real Pi children, the real dispatcher.

function fixtureRepository(scratch: string): string {
	const fixture = join(scratch, "fixture");
	mkdirSync(fixture);
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@t",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@t",
	};
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: fixture, env });
	git("init", "-q");
	writeFileSync(join(fixture, "README.md"), "fixture\n");
	git("add", "README.md");
	git("commit", "-q", "-m", "fixture");
	mkdirSync(join(scratch, "state"), { recursive: true });
	return fixture;
}

/** A fake Pi child from a body of JavaScript; it records what reached it and exits on stdin's end. */
function fakeChild(path: string, body: string): string {
	writeFileSync(path, `#!/usr/bin/env node\nconst fs = require("node:fs");\n${body}\n`, { mode: 0o700 });
	chmodSync(path, 0o700);
	return path;
}

async function until(condition: () => boolean, label: string, bound = 20_000): Promise<void> {
	const deadline = Date.now() + bound;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

// Criterion 7: the run's deadline runs while an operator is attached.

const armKeepsTheDeadline: Arm = async (load, scratch) => {
	const hub = await load(HUB);
	const { registerDelegateCommand } = await load(COMMAND);
	const { runDispatch } = await load(DISPATCH);
	const fixture = fixtureRepository(scratch);
	// It answers each request and never settles, so only the bound can end it.
	const executable = fakeChild(
		join(scratch, "fake-pi"),
		`let data = "";
process.stdin.on("data", (chunk) => {
	data += chunk;
	let at;
	while ((at = data.indexOf("\\n")) !== -1) {
		const command = JSON.parse(data.slice(0, at));
		data = data.slice(at + 1);
		process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true }) + "\\n");
		process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "working" }) + "\\n");
	}
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);`,
	);
	const started = Date.now();
	const dispatch = runDispatch({
		callerRepoRoot: fixture,
		stateRoot: join(scratch, "state"),
		delegateArgv: [],
		brief: "brief",
		expectedRef: "HEAD",
		timeoutMs: 1500,
		pi: { piExecutable: executable, provider: "scripted", model: "scripted-model", role: "reviewer" },
	});
	await until(() => hub.livePiOperatorIds().length === 1, "the delegate to go live");
	let ended = false;
	void dispatch.then(() => {
		ended = true;
	});
	const command = api();
	registerDelegateCommand(command.pi);
	// The operator is attached and deciding while the bound runs out.
	const operator = terminal(
		[
			async () => {
				await dispatch;
				return "Steer";
			},
		],
		["too late"],
	);
	await command.handler()("", operator.ctx);
	const outcome = await dispatch;
	assert.ok(ended, "the run had not ended");
	assert.equal(outcome.diagnostic.code, "TIMED_OUT", "the run did not end at its bound");
	assert.ok(Date.now() - started < 1500 + 8000, "the run outlived its bound by more than its cleanup");
	assert.deepEqual(operator.seen.notices, ["That Pi delegate has ended"], "the attached command did not find it gone");
};

// Criterion 8: the submit/abort race, in a real session.

/** The installed `pi` behind a wrapper that adds a scripted provider whose second turn waits. */
function realPi(scratch: string, script: unknown[]): string {
	const provider = join(scratch, "provider");
	mkdirSync(join(provider, ".pi/extensions"), { recursive: true });
	let source = readFileSync(join(repoRoot, "test/harness/scripted-provider.ts"), "utf8");
	const anchor = '\t\t\tif (current.kind === "toolCall") {';
	if (!source.includes(anchor)) throw new Error("the scripted provider's anchor moved");
	// One added turn kind: wait, then answer as text. It holds the child
	// unsettled after its submission, which is the race's window.
	source = source.replace(
		anchor,
		() =>
			'\t\t\tif ((current as { kind: string }).kind === "wait")\n' +
			"\t\t\t\tawait new Promise((resolve) => setTimeout(resolve, (current as unknown as { ms: number }).ms));\n" +
			anchor,
	);
	writeFileSync(join(provider, ".pi/extensions/provider.ts"), source);
	writeFileSync(join(provider, "script.json"), JSON.stringify(script));
	for (const directory of ["home", "agent"]) mkdirSync(join(scratch, directory));
	const wrapper = join(scratch, "pi-wrapper");
	writeFileSync(
		wrapper,
		[
			"#!/bin/sh",
			`export HOME=${JSON.stringify(join(scratch, "home"))}`,
			`export PI_CODING_AGENT_DIR=${JSON.stringify(join(scratch, "agent"))}`,
			"export PI_OFFLINE=1",
			`exec ${JSON.stringify(join(repoRoot, "node_modules/.bin/pi"))} "$@" --extension ${JSON.stringify(join(provider, ".pi/extensions/provider.ts"))}`,
			"",
		].join("\n"),
		{ mode: 0o700 },
	);
	chmodSync(wrapper, 0o700);
	return wrapper;
}

const SUBMIT_THEN_WAIT = [
	{ kind: "toolCall", name: "submit_result", arguments: { token: "APPROVED", findings: [] } },
	{ kind: "wait", ms: 15_000, text: "done" },
];

const armAbortWinsTheRace: Arm = async (load, scratch) => {
	const hub = await load(HUB);
	const { registerDelegateCommand } = await load(COMMAND);
	const { runDispatch } = await load(DISPATCH);
	const { quoted } = await load("quote.ts");
	const fixture = fixtureRepository(scratch);
	const dispatch = runDispatch({
		callerRepoRoot: fixture,
		stateRoot: join(scratch, "state"),
		delegateArgv: [],
		brief: "Submit the result",
		expectedRef: "HEAD",
		timeoutMs: 60_000,
		pi: {
			piExecutable: realPi(scratch, SUBMIT_THEN_WAIT),
			provider: "scripted",
			model: "scripted-model",
			role: "reviewer",
		},
	});
	await until(() => hub.livePiOperatorIds().length === 1, "the real delegate to go live");
	const [id] = hub.livePiOperatorIds();
	const submitted = `tool ended: ${quoted("submit_result")}`;
	let seen = false;
	const command = api();
	registerDelegateCommand(command.pi);
	// The operator watches for the submission and aborts on that row.
	const operator = terminal([
		async () => {
			await until(() => hub.piOperatorView(id).includes(submitted), "the submission row");
			seen = true;
			return "Abort";
		},
	]);
	await command.handler()("", operator.ctx);
	const outcome = await dispatch;
	assert.ok(seen, "the submission was never shown");
	assert.equal(outcome.disposition, "refused", "an aborted run admitted its submitted slot");
	assert.equal(outcome.diagnostic.code, "ABORTED", "the abort did not decide the run");
};

/** The same race at the supervisor: the installed slot is admissible on its own. */
const armTheSlotWasAdmissible: Arm = async (load, scratch) => {
	const { startPiRpc } = await load(SUPERVISOR);
	const { provisionPiSubmitTool } = await load("dispatch/pi-submit.ts");
	const { REVIEW_PI_PROFILES } = await load("review/pi-profile.ts");
	const { admitReturn } = await load("dispatch/admit.ts");
	const fixture = fixtureRepository(scratch);
	const tree = join(scratch, "tree");
	execFileSync("git", ["clone", "-q", "--no-hardlinks", fixture, tree]);
	execFileSync("git", ["-C", tree, "remote", "remove", "origin"]);
	const context = {
		scratchRoot: scratch,
		treeDir: tree,
		stateDir: join(scratch, "state"),
		briefPath: join(scratch, "brief.md"),
		returnPath: join(scratch, "return.json"),
		heldHash: execFileSync("git", ["-C", tree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
	};
	writeFileSync(context.briefPath, "Submit the result");
	const wrapper = realPi(scratch, SUBMIT_THEN_WAIT);
	let admissible: boolean | undefined;
	let session: { abort: () => void; done: Promise<string> } | undefined;
	const started: { abort: () => void; done: Promise<string> } = startPiRpc({
		context,
		extensionPath: provisionPiSubmitTool(context, REVIEW_PI_PROFILES.reviewer),
		piExecutable: wrapper,
		provider: "scripted",
		model: "scripted-model",
		prompt: "Submit the result",
		timeoutMs: 60_000,
		onOperatorEvent: (event: { type: string; toolName?: string; isError?: boolean }) => {
			if (event.type === "tool_execution_end" && event.toolName === "submit_result" && event.isError === false) {
				admissible = admitReturn(context.returnPath).admitted;
				session?.abort();
			}
		},
	});
	session = started;
	assert.equal(await started.done, "abort", "the abort did not decide the supervisor's terminal");
	assert.equal(admissible, true, "the race's slot was not admissible on its own");
};

// Criterion 9: fast events. The copy's hub records a session's rows at its end.

const RECORD_ROWS = (trace: string): Edits => [
	[
		HUB,
		'import { randomUUID } from "node:crypto";',
		'import { randomUUID } from "node:crypto";\nimport { appendFileSync as recordRows } from "node:fs";',
	],
	[
		HUB,
		"\t\tend(): void {\n\t\t\tactive.delete(item.id);",
		`\t\tend(): void {\n\t\t\trecordRows(${JSON.stringify(trace)}, \`\${JSON.stringify(piOperatorView(item.id))}\\n\`);\n\t\t\tactive.delete(item.id);`,
	],
];

async function armLosesNoFastEvent(load: Load, scratch: string, trace: string): Promise<void> {
	const { runDispatch } = await load(DISPATCH);
	const { quoted } = await load("quote.ts");
	const fixture = fixtureRepository(scratch);
	// Every event at once, before reading a byte, and then gone.
	const names = ["e0", "e1", "e2", "e3", "e4"];
	const executable = fakeChild(
		join(scratch, "fast-pi"),
		`for (const name of ${JSON.stringify(names)}) process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: name }) + "\\n");
process.exit(0);`,
	);
	await runDispatch({
		callerRepoRoot: fixture,
		stateRoot: join(scratch, "state"),
		delegateArgv: [],
		brief: "brief",
		expectedRef: "HEAD",
		timeoutMs: 10_000,
		pi: { piExecutable: executable, provider: "scripted", model: "scripted-model", role: "reviewer" },
	});
	assert.ok(existsSync(trace), "the hub never ended the session");
	const [rows] = readFileSync(trace, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as string[]);
	assert.deepEqual(
		rows,
		names.map((name) => `tool started: ${quoted(name)}`),
		"an event the child sent at once never reached the hub",
	);
}
/** The fast-events arm in its own instrumented copy, with any further edits. */
async function fastEventsIn(edits: Edits): Promise<void> {
	const records = mkdtempSync(join(tmpdir(), "gitjig-424-rows-"));
	try {
		const trace = join(records, "rows.jsonl");
		await withCopy([...RECORD_ROWS(trace), ...edits], (load, scratch) => armLosesNoFastEvent(load, scratch, trace));
	} finally {
		rmSync(records, { recursive: true, force: true });
	}
}

// Criterion 10: nothing observed or received is published.

const armPublishesNothing: Arm = async (load, scratch) => {
	const hub = await load(HUB);
	const { registerDelegateCommand } = await load(COMMAND);
	const { runDispatch } = await load(DISPATCH);
	const fixture = fixtureRepository(scratch);
	const received = join(scratch, "received.jsonl");
	const DELEGATE_MARK = "DELEGATE-MARK-424";
	const OPERATOR_MARK = "OPERATOR-MARK-424";
	// It shows the operator a marked message, records what it is sent, and runs on.
	const executable = fakeChild(
		join(scratch, "marked-pi"),
		`let data = "";
process.stdin.on("data", (chunk) => {
	data += chunk;
	let at;
	while ((at = data.indexOf("\\n")) !== -1) {
		const command = JSON.parse(data.slice(0, at));
		data = data.slice(at + 1);
		fs.appendFileSync(${JSON.stringify(received)}, JSON.stringify(command) + "\\n");
		process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true }) + "\\n");
		process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: ${JSON.stringify(DELEGATE_MARK)} }] } }) + "\\n");
	}
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);`,
	);
	const dispatch = runDispatch({
		callerRepoRoot: fixture,
		stateRoot: join(scratch, "state"),
		delegateArgv: [],
		brief: "brief",
		expectedRef: "HEAD",
		timeoutMs: 30_000,
		pi: { piExecutable: executable, provider: "scripted", model: "scripted-model", role: "reviewer" },
	});
	await until(() => hub.livePiOperatorIds().length === 1, "the delegate to go live");
	const [id] = hub.livePiOperatorIds();
	await until(() => hub.piOperatorView(id).some((row: string) => row.includes(DELEGATE_MARK)), "the marked row");
	const command = api();
	registerDelegateCommand(command.pi);
	const operator = terminal(
		["Steer", "Follow up", "Clear queue", "Refresh", "Abort"],
		[`steer ${OPERATOR_MARK}`, `follow ${OPERATOR_MARK}`],
	);
	await command.handler()("", operator.ctx);
	const outcome = await dispatch;
	assert.equal(outcome.diagnostic.code, "ABORTED", "the operator's abort did not end the run");
	// The command itself called no publication writer.
	assert.deepEqual(command.writes, [], "the command wrote to the session");
	// The child received exactly what the operator sent, as the acts that
	// carry it, and nothing the view observed: no delegate row goes back in,
	// appended to an operator's message or in a frame of its own.
	const frames = readFileSync(received, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type: string; message?: string });
	assert.deepEqual(
		frames.filter((frame) => frame.type !== "prompt").map((frame) => [frame.type, frame.message]),
		[
			["steer", `steer ${OPERATOR_MARK}`],
			["follow_up", `follow ${OPERATOR_MARK}`],
			["clear_queue", undefined],
		],
		"the child did not receive exactly the operator's acts",
	);
	for (const frame of frames)
		assert.equal(
			JSON.stringify(frame).includes(DELEGATE_MARK),
			false,
			"an observed delegate row was sent back to the child",
		);
	// Neither mark appears in what crosses to the parent, or in any record the
	// dispatcher keeps; its content-free writes after the abort are allowed.
	const kept = (directory: string): string[] =>
		existsSync(directory)
			? readdirSync(directory, { recursive: true, withFileTypes: true })
					.filter((entry) => entry.isFile())
					.map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
			: [];
	for (const [channel, text] of [
		["the dispatch outcome", JSON.stringify(outcome)],
		...kept(join(scratch, "state")).map((text, index) => [`state record ${index}`, text] as const),
	] as ReadonlyArray<readonly [string, string]>)
		for (const mark of [DELEGATE_MARK, OPERATOR_MARK])
			assert.equal(text.includes(mark), false, `${channel} carries ${mark}`);
	assert.ok(kept(join(scratch, "state")).length > 0, "the dispatcher kept no record to search");
};

// ---------------------------------------------------------------------------
// The tests, each arm once against the tree.

test("the command registers once through the spine and is terminal-only", async () => {
	await withCopy([], armRegistersOnce);
	await withCopy([], armIsTerminalOnly);
});

test("the command reads only the hub's exported surface, and the listing is exact", async () => {
	await withCopy([], armReadsOnlyTheHub);
});

test("attachment follows how many delegates are live, and acts only on the one named", async () => {
	await withCopy([], armAttaches);
});

test("each action maps to exactly one control, and empty input sends nothing", async () => {
	await withCopy([], armMapsEachAction);
});

test("detach and a cancelled choice leave the child running and the hub draining", async () => {
	await withCopy([], armLeavesTheChildRunning);
});

test("the controls are fetched again for every act, so an ended session receives nothing", async () => {
	await withCopy([], armRefetchesBeforeEachAct);
});

test("the run's deadline runs while an operator is attached", { timeout: 60_000 }, async () => {
	await withCopy([], armKeepsTheDeadline);
});

test("#370's submit/abort race: an operator abort outranks a submitted slot", { timeout: 120_000 }, async () => {
	await withCopy([], armAbortWinsTheRace);
	await withCopy([], armTheSlotWasAdmissible);
});

test("#370's fast events: a child that emits at once and exits loses none", { timeout: 60_000 }, async () => {
	await fastEventsIn([]);
});

test("nothing the command observes or receives is published", { timeout: 60_000 }, async () => {
	await withCopy([], armPublishesNothing);
});

// ---------------------------------------------------------------------------
// Baseline-first private-copy mutants, each run against the arm that owns it.

test("baseline-first private-copy mutants: the command's selections and gates", { timeout: 300_000 }, async () => {
	const killed = (arm: Arm, edits: Edits, named: string) => armFails(arm, edits, named);
	// The terminal-only gate.
	await killed(
		armIsTerminalOnly,
		[[COMMAND, '\t\t\tif (ctx.mode !== "tui") return;\n', ""]],
		"a view outside the terminal UI",
	);
	// Attachment, by how many are live, and the guard on what was named. The
	// guard's `id === undefined` half is equivalent alone (an undefined
	// identifier is never listed), so the guard is killed as a whole.
	await killed(armAttaches, [[COMMAND, "if (ids.length === 0) {", "if (false) {"]], "no notice with nothing live");
	await killed(
		armAttaches,
		[[COMMAND, "ids.length === 1 ? ids[0] :", "false ? ids[0] :"]],
		"a chooser for one live session",
	);
	await killed(
		armAttaches,
		[[COMMAND, 'await ctx.ui.select("Attach to delegate", ids)', "ids[0]"]],
		"the first session for any choice",
	);
	await killed(
		armAttaches,
		[[COMMAND, "\t\t\tif (id === undefined || !ids.includes(id)) return;\n", ""]],
		"acting past a cancelled or unlisted choice",
	);
	await killed(
		armAttaches,
		[[COMMAND, " || !ids.includes(id)) return;", ") return;"]],
		"acting on an identifier the hub never listed",
	);
	// Each action, and the empty-input guard.
	await killed(
		armMapsEachAction,
		[[COMMAND, 'action === "Steer" ? "steer" : "follow_up"', 'action === "Steer" ? "follow_up" : "steer"']],
		"steer and follow-up swapped",
	);
	await killed(
		armMapsEachAction,
		[[COMMAND, '\t\t\t\tif (action === "Clear queue") await controls.clearQueue();\n\t\t\t\telse if', "\t\t\t\tif"]],
		"clear queue sending nothing",
	);
	await killed(armMapsEachAction, [[COMMAND, "\t\t\t\t\tcontrols.abort();\n", ""]], "abort sending nothing");
	await killed(
		armMapsEachAction,
		[
			[
				COMMAND,
				"\t\t\t\t\t// Refresh, or a row: read the view again.\n\t\t\t\t\tcontinue;\n",
				"\t\t\t\t\tpiOperatorControls(id)?.abort();\n\t\t\t\t\tcontinue;\n",
			],
		],
		"a refresh that acts",
	);
	await killed(
		armMapsEachAction,
		[[COMMAND, "if (text === undefined || text.length === 0) continue;", "if (text === undefined) continue;"]],
		"empty input sent",
	);
	// Leaving: a cancelled choice, and detach, act on nothing.
	await killed(
		armLeavesTheChildRunning,
		[[COMMAND, 'if (action === undefined || action === "Detach") return;', 'if (action === "Detach") return;']],
		"a cancelled choice that stays",
	);
	await killed(
		armLeavesTheChildRunning,
		[
			[
				COMMAND,
				'if (action === undefined || action === "Detach") return;',
				'if (action === undefined || action === "Detach") {\n\t\t\t\t\tpiOperatorControls(id)?.abort();\n\t\t\t\t\treturn;\n\t\t\t\t}',
			],
		],
		"a detach that aborts",
	);
	// The controls fetched once, not for every act.
	await killed(
		armRefetchesBeforeEachAct,
		[
			[COMMAND, "\t\t\tfor (;;) {\n", "\t\t\tconst attached = piOperatorControls(id);\n\t\t\tfor (;;) {\n"],
			[COMMAND, "\t\t\t\tconst controls = piOperatorControls(id);\n", "\t\t\t\tconst controls = attached;\n"],
		],
		"controls held across acts",
	);
	// A write channel the command could use.
	for (const channel of ["appendEntry", "sendMessage", "sendUserMessage"])
		await killed(
			armPublishesNothing,
			[
				[
					COMMAND,
					'\t\t\tif (ctx.mode !== "tui") return;\n',
					`\t\t\tif (ctx.mode !== "tui") return;\n\t\t\t(pi as unknown as Record<string, (...a: unknown[]) => void>).${channel}("delegate");\n`,
				],
			],
			`the command writing through ${channel}`,
		);
	// Registration.
	await killed(armRegistersOnce, [[SPINE, "\tregisterDelegateCommand(pi);\n", ""]], "the command unregistered");
	await killed(
		armRegistersOnce,
		[[SPINE, "\tregisterDelegateCommand(pi);\n", "\tregisterDelegateCommand(pi);\n\tregisterDelegateCommand(pi);\n"]],
		"the command registered twice",
	);
});

test("baseline-first private-copy mutants: the hub's narrowed controls and its listing", async () => {
	await armFails(
		armReadsOnlyTheHub,
		[
			[
				HUB,
				"\t\t\t\tabort: () => session.abort(),\n",
				"\t\t\t\tabort: () => session.abort(),\n\t\t\t\twaitForSettle: (after) => session.waitForSettle(after),\n",
			],
		],
		"a lifecycle member restored to the view's controls",
	);
	await armFails(
		armReadsOnlyTheHub,
		[[HUB, "(item.session === undefined ? [] : [item.id])", "[item.id]"]],
		"an unbound session listed",
	);
	// An observed row republished into what the child receives (round 1's mutant).
	await armFails(
		armPublishesNothing,
		[
			[
				HUB,
				"\t\t\t\tcommand: (type, message) => session.command(type, message),\n",
				'\t\t\t\tcommand: (type, message) => session.command(type, `${message} ${item.lines[0] ?? ""}`),\n',
			],
		],
		"an observed delegate row sent back to the child",
	);
	// An ended session leaves the listing through two statements, so the pair is
	// the mutant: each alone is inert, because either one excludes it.
	await armFails(
		armReadsOnlyTheHub,
		[
			[HUB, "\t\tend(): void {\n\t\t\tactive.delete(item.id);\n", "\t\tend(): void {\n"],
			[HUB, '\t\t\titem.partial = "";\n\t\t\titem.session = undefined;\n', '\t\t\titem.partial = "";\n'],
		],
		"an ended session still listed",
	);
});

test(
	"baseline-first private-copy mutants: the race's precedence and the observer's timing",
	{ timeout: 300_000 },
	async () => {
		await armFails(
			armAbortWinsTheRace,
			[[RUNNER, '\tif (terminal === "abort") return refusal("abort");\n', ""]],
			"the runner not mapping an abort to refusal",
		);
		await armFails(
			armAbortWinsTheRace,
			[[DISPATCH, '\t\tif (run.aborted) return refuse("refuse-aborted", "ABORTED", "run", "aborted");\n', ""]],
			"the dispatcher reading the slot past an abort",
		);
		await assert.rejects(
			() =>
				fastEventsIn([
					[
						SUPERVISOR,
						"\tlet observer = options.onOperatorEvent;\n",
						"\tlet observer: typeof options.onOperatorEvent;\n\tsetTimeout(() => {\n\t\tobserver = options.onOperatorEvent;\n\t}, 500);\n",
					],
				]),
			(error: unknown) => {
				assert.ok(
					error instanceof assert.AssertionError,
					`a late observer: the arm failed for another reason: ${error}`,
				);
				return true;
			},
			"a late observer: the owner arm still passed",
		);
	},
);

/**
 * #362: the handed first-clone acquisition launcher, against SPEC §§4.1–4.2
 * and §§4.6–4.7's acquisition relations.
 *
 * Every arm runs the real launcher as a child process on a hermetic fixture:
 * a local source repository standing in for `https://github.com/o/r`, a target
 * repository carrying the launcher and its committed pin, and a caller-selected
 * `git` on PATH. That selection is the very residual §4.7 assigns to the
 * caller, and here it is the test's seam: it rewrites the projected URL to the
 * local source for `fetch` alone and logs what it was asked. Nothing reaches a
 * network, a credential, the host's global configuration or a foreign
 * repository.
 *
 * Bounds that take minutes in production are narrowed through the launcher's
 * own exported seams, by a harness that imports the launcher and calls `main`.
 * The command line cannot reach those seams, and the arm that reads
 * `defaultSeams` pins their production values.
 *
 * Each arm is a named function used twice: by the test that asserts it holds,
 * and by baseline-first private-copy mutants of the launcher, which must fail
 * it with an assertion. A harness fault is never a kill.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const LAUNCHER = join(repository, ".github/bin/gitjig-bootstrap.mjs");
const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
};
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

type Fixture = {
	root: string;
	target: string;
	revision: string;
	record: string;
	bin: string;
	log: string;
	launcher: string;
	work: string;
	scratch: string;
};

/** A provision entry that records exactly what reached it. */
const recordingProvision = (record: string) =>
	`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }));\nprocess.stdout.write("provision: done\\n");\n`;

/**
 * The fixture. `source` may add or replace files in the source before it is
 * committed; `pin` may replace the committed pin's bytes; `wrapper` may add
 * shell lines run for a fetch before it is forwarded.
 */
function fixture(
	launcher: string,
	options: {
		source?: (work: string, record: string) => void;
		pin?: (revision: string) => string | Buffer;
		wrapper?: string;
	} = {},
): Fixture {
	const root = mkdtempSync(join(tmpdir(), "gitjig-362-"));
	roots.push(root);
	const work = join(root, "source-work");
	mkdirSync(join(work, ".pi/extensions/gitjig/install"), { recursive: true });
	const record = join(root, "provision.json");
	writeFileSync(join(work, ".pi/extensions/gitjig.ts"), "// entry\n");
	writeFileSync(join(work, ".pi/extensions/gitjig/install/provision-cli.ts"), recordingProvision(record));
	writeFileSync(join(work, "README.md"), "source\n");
	options.source?.(work, record);
	git(root, "init", "-q", work);
	git(work, "add", "-A");
	git(work, "commit", "-qm", "source");
	const revision = git(work, "rev-parse", "HEAD");
	const bare = join(root, "source.git");
	git(root, "clone", "-q", "--bare", work, bare);
	const target = join(root, "target");
	mkdirSync(join(target, ".github/bin"), { recursive: true });
	mkdirSync(join(target, ".pi"), { recursive: true });
	copyFileSync(launcher, join(target, ".github/bin/gitjig-bootstrap.mjs"));
	const pin =
		options.pin?.(revision) ??
		`${JSON.stringify({ schemaVersion: 1, source: { provider: "github", host: "github.com", owner: "o", repository: "r" }, revision, payload: [] })}\n`;
	writeFileSync(join(target, ".pi/gitjig.pin.json"), pin);
	git(root, "init", "-q", target);
	git(target, "add", "-A");
	git(target, "commit", "-qm", "target");
	const bin = join(root, "bin");
	mkdirSync(bin);
	const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const log = join(root, "git.log");
	writeFileSync(
		join(bin, "git"),
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
			`env | sort > ${JSON.stringify(join(root, "git-env.last"))}`,
			`case " $* " in *" fetch "*) ${options.wrapper ?? ":"}; export GIT_ALLOW_PROTOCOL=file; exec ${JSON.stringify(real)} -c "url.file://${bare}.insteadOf=https://github.com/o/r" "$@";; esac`,
			`exec ${JSON.stringify(real)} "$@"`,
			"",
		].join("\n"),
	);
	chmodSync(join(bin, "git"), 0o755);
	const scratch = join(root, "tmp");
	mkdirSync(scratch);
	return {
		root,
		target,
		revision,
		record,
		bin,
		log,
		launcher: join(target, ".github/bin/gitjig-bootstrap.mjs"),
		work,
		scratch,
	};
}

type Run = { status: number | null; stdout: string; stderr: string };

/** The command line, exactly: `node .github/bin/gitjig-bootstrap.mjs`, with the caller's own environment. */
function launch(f: Fixture, extra: Record<string, string> = {}, argv: string[] = []): Run {
	const run = spawnSync(process.execPath, [f.launcher, ...argv], {
		encoding: "utf8",
		env: { PATH: `${f.bin}:${process.env.PATH ?? ""}`, HOME: f.root, LC_ALL: "C", TMPDIR: f.scratch, ...extra },
		timeout: 60_000,
	});
	return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** The same launcher, imported, with some of its seams narrowed. */
function launchWith(f: Fixture, seams: string): Run {
	const harness = [
		`import { main, defaultSeams } from ${JSON.stringify(f.launcher)};`,
		"process.umask(0o077);",
		`const seams = { ...defaultSeams(), ${seams} };`,
		"process.exitCode = await main([], { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: process.env.LC_ALL }, seams);",
	].join("\n");
	const run = spawnSync(process.execPath, ["--input-type=module", "-e", harness], {
		encoding: "utf8",
		env: { PATH: `${f.bin}:${process.env.PATH ?? ""}`, HOME: f.root, LC_ALL: "C", TMPDIR: f.scratch },
		timeout: 60_000,
	});
	return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

const refused = (run: Run, cause: string, status: number, label: string) => {
	assert.equal(run.status, status, `${label}: status (stderr ${JSON.stringify(run.stderr)})`);
	assert.equal(run.stdout, "", `${label}: a refusal wrote to stdout`);
	assert.equal(run.stderr, `gitjig-bootstrap: ${cause}\n`, `${label}: the cause line`);
};

/** The target as it stands: every tracked and untracked byte, and Git's view of it. */
function snapshot(target: string): string {
	const files = git(target, "ls-files", "-c", "-o", "-z").split("\0").filter(Boolean).sort();
	return JSON.stringify({
		status: git(target, "status", "--porcelain=v1", "--untracked-files=all", "--ignored"),
		head: git(target, "rev-parse", "HEAD"),
		bytes: files.map((path) => [path, readFileSync(join(target, path)).toString("base64")]),
		gitjig: existsSync(join(target, ".gitjig")),
	});
}

/** A pre-transition refusal leaves the target exactly as it was and never reaches provision. */
function invariant(f: Fixture, before: string, label: string) {
	assert.equal(snapshot(f.target), before, `${label}: the target changed`);
	assert.equal(existsSync(f.record), false, `${label}: provision ran`);
	assert.deepEqual(readdirSync(f.scratch), [], `${label}: an acquisition artifact was left`);
}

// ---------------------------------------------------------------------------
// Criterion 2/6: exact success, in order, reaching only the fixed entry.

async function armSucceedsExactly(launcher: string): Promise<void> {
	const f = fixture(launcher);
	const run = launch(f);
	assert.equal(run.status, 0, `success status (stderr ${JSON.stringify(run.stderr)})`);
	assert.equal(run.stdout, "", "success wrote to stdout");
	assert.equal(run.stderr, "", "success wrote to stderr");
	const reached = JSON.parse(readFileSync(f.record, "utf8")) as { argv: string[]; cwd: string };
	assert.deepEqual(reached.argv, [
		"--target",
		realpathSync(f.target),
		"--source",
		"https://github.com/o/r",
		"--revision",
		f.revision,
	]);
	assert.match(reached.cwd, /gitjig-acquire-[^/]+\/snapshot$/, "provision did not run from the confirmed snapshot");
	assert.deepEqual(readdirSync(f.scratch), [], "the acquisition child was not removed");
	// The process order: admission reads before any fetch, the fetch before the snapshot checks.
	const asked = readFileSync(f.log, "utf8").split("\n").filter(Boolean);
	const at = (pattern: RegExp) => asked.findIndex((line) => pattern.test(line));
	assert.ok(at(/ cat-file blob HEAD:\.pi\/gitjig\.pin\.json/) < at(/ fetch /), "the pin was not read before the fetch");
	assert.ok(at(/ fetch /) < at(/ hash-object /), "the closure was not checked after the fetch");
	assert.equal(asked.filter((line) => / fetch /.test(line)).length, 1, "more than one fetch");
	assert.ok(
		asked.every((line) => !/--depth=1 origin (?![0-9a-f]{40}$)/.test(line)),
		"a fetch named something but the revision",
	);
}

// ---------------------------------------------------------------------------
// Criterion 2/3: admission. Each refusal leaves the target invariant.

async function armAdmitsOnlyTheCommittedPin(launcher: string): Promise<void> {
	// An operand of any kind.
	const operands = fixture(launcher);
	const operandsBefore = snapshot(operands.target);
	refused(launch(operands, {}, ["--source"]), "invalid-input", 64, "an operand");
	invariant(operands, operandsBefore, "an operand");
	// The pin as committed, and nothing else.
	for (const [label, mutate] of [
		[
			// Valid and naming the same source and revision: only its bytes differ from HEAD's.
			"a dirty pin",
			(f: Fixture) => {
				const pin = join(f.target, ".pi/gitjig.pin.json");
				writeFileSync(pin, `${JSON.stringify(JSON.parse(readFileSync(pin, "utf8")), null, 2)}\n`);
			},
		],
		[
			"a linked pin",
			(f: Fixture) => {
				const pin = join(f.target, ".pi/gitjig.pin.json");
				const copy = join(f.root, "pin-copy.json");
				copyFileSync(pin, copy);
				unlinkSync(pin);
				symlinkSync(copy, pin);
			},
		],
		["an untracked pin", (f: Fixture) => git(f.target, "rm", "-q", "--cached", ".pi/gitjig.pin.json")],
	] as const) {
		const f = fixture(launcher);
		mutate(f);
		const before = snapshot(f.target);
		refused(launch(f), "invalid-input", 64, label);
		invariant(f, before, label);
	}
	// The routing projection, closed.
	const source = (over: object) => ({ provider: "github", host: "github.com", owner: "o", repository: "r", ...over });
	for (const [label, pin] of [
		["a second schema", (revision: string) => JSON.stringify({ schemaVersion: 2, source: source({}), revision })],
		[
			"an extra source key",
			(revision: string) => JSON.stringify({ schemaVersion: 1, source: source({ branch: "main" }), revision }),
		],
		[
			"another provider",
			(revision: string) => JSON.stringify({ schemaVersion: 1, source: source({ provider: "gitlab" }), revision }),
		],
		[
			"another host",
			(revision: string) => JSON.stringify({ schemaVersion: 1, source: source({ host: "example.com" }), revision }),
		],
		[
			"a slash in the owner",
			(revision: string) => JSON.stringify({ schemaVersion: 1, source: source({ owner: "o/x" }), revision }),
		],
		[
			"a percent in the repository",
			(revision: string) => JSON.stringify({ schemaVersion: 1, source: source({ repository: "r%2f" }), revision }),
		],
		[
			"a control in the owner",
			(revision: string) => JSON.stringify({ schemaVersion: 1, source: source({ owner: "o\u0007" }), revision }),
		],
		[
			"a decomposed owner",
			(revision: string) => JSON.stringify({ schemaVersion: 1, source: source({ owner: "e\u0301" }), revision }),
		],
		[
			"an uppercase revision",
			(revision: string) => JSON.stringify({ schemaVersion: 1, source: source({}), revision: revision.toUpperCase() }),
		],
		[
			"a short revision",
			(revision: string) => JSON.stringify({ schemaVersion: 1, source: source({}), revision: revision.slice(1) }),
		],
		["not an object", () => "[]"],
		["not UTF-8", () => Buffer.from([0x7b, 0xff, 0x7d])],
		["an oversized pin", () => `${" ".repeat(1048576)}{}`],
	] as const) {
		const f = fixture(launcher, { pin });
		const before = snapshot(f.target);
		refused(launch(f), "invalid-input", 64, label);
		invariant(f, before, label);
	}
}

// ---------------------------------------------------------------------------
// Criterion 3/4: the source and its bounds.

async function armSourcesOnlyTheProjection(launcher: string): Promise<void> {
	// A pin naming a source the caller's network does not serve.
	const elsewhere = fixture(launcher, {
		pin: (revision) =>
			`${JSON.stringify({ schemaVersion: 1, source: { provider: "github", host: "github.com", owner: "x", repository: "y" }, revision })}\n`,
	});
	const elsewhereBefore = snapshot(elsewhere.target);
	refused(launch(elsewhere), "source-unavailable", 69, "an unserved source");
	invariant(elsewhere, elsewhereBefore, "an unserved source");
	// A revision the source does not have.
	const absent = fixture(launcher, {
		pin: () =>
			`${JSON.stringify({ schemaVersion: 1, source: { provider: "github", host: "github.com", owner: "o", repository: "r" }, revision: "0".repeat(40) })}\n`,
	});
	const absentBefore = snapshot(absent.target);
	refused(launch(absent), "source-unavailable", 69, "an absent revision");
	invariant(absent, absentBefore, "an absent revision");
	// A Git child that signals, overflows or outlives its bound.
	for (const [label, wrapper, seams] of [
		["a signalled fetch", "kill -TERM $$", ""],
		["an overflowing fetch", "head -c 4096 /dev/zero", "streamBytes: 1024"],
		["a fetch past its bound", "sleep 5", "gitTimeoutMs: 500"],
	] as const) {
		const f = fixture(launcher, { wrapper });
		const before = snapshot(f.target);
		refused(seams === "" ? launch(f) : launchWith(f, seams), "source-unavailable", 69, label);
		invariant(f, before, label);
	}
}

// ---------------------------------------------------------------------------
// Criterion 4: the children's environments are built, not inherited.

async function armBuildsEachChildEnvironment(launcher: string): Promise<void> {
	const hostileConfig = join(mkdtempSync(join(tmpdir(), "gitjig-362-hostile-")), "gitconfig");
	roots.push(join(hostileConfig, ".."));
	writeFileSync(
		hostileConfig,
		'[url "file:///nowhere"]\n\tinsteadOf = https://github.com/o/r\n[core]\n\thooksPath = /tmp\n',
	);
	const f = fixture(launcher);
	const run = launch(f, {
		GIT_DIR: "/hostile",
		GIT_CONFIG_GLOBAL: hostileConfig,
		GIT_ALTERNATE_OBJECT_DIRECTORIES: "/hostile",
		NODE_PATH: "/hostile",
		HOSTILE_MARK: "1",
	});
	assert.equal(run.status, 0, `the hostile ambient broke acquisition (stderr ${JSON.stringify(run.stderr)})`);
	// The platform's own additions, measured with an empty-environment control child.
	const control = spawnSync(
		process.execPath,
		["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"],
		{
			encoding: "utf8",
			env: {},
		},
	);
	const platform = new Set(JSON.parse(control.stdout) as string[]);
	const reached = JSON.parse(readFileSync(f.record, "utf8")) as { env: Record<string, string> };
	assert.deepEqual(
		Object.keys(reached.env)
			.filter((key) => !platform.has(key))
			.sort(),
		["HOME", "LC_ALL", "PATH"],
		"the provision child's environment is not its profile",
	);
	assert.equal(reached.env.HOME, f.root, "the provision child's HOME is not the launcher's own read");
	assert.equal(reached.env.LC_ALL, "C");
	const gitEnv = readFileSync(join(f.root, "git-env.last"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => line.slice(0, line.indexOf("=")))
		.filter((key) => !platform.has(key) && !["PWD", "SHLVL", "_", "OLDPWD"].includes(key))
		.sort();
	assert.deepEqual(
		gitEnv,
		["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "LC_ALL", "PATH"],
		"the Git child's environment is not its profile",
	);
}

// ---------------------------------------------------------------------------
// Criterion 3: the confirmed snapshot's closure.

async function armConfirmsTheClosure(launcher: string): Promise<void> {
	for (const [label, source] of [
		[
			"a linked module file",
			(work: string) => {
				rmSync(join(work, ".pi/extensions/gitjig.ts"));
				symlinkSync("../README.md", join(work, ".pi/extensions/gitjig.ts"));
			},
		],
		[
			"a linked file outside the module population",
			(work: string) => {
				mkdirSync(join(work, "docs"));
				symlinkSync("../README.md", join(work, "docs/link.md"));
			},
		],
		[
			"a missing fixed entry",
			(work: string) => {
				rmSync(join(work, ".pi/extensions/gitjig/install/provision-cli.ts"));
				writeFileSync(join(work, ".pi/extensions/gitjig/install/other.ts"), "// other\n");
			},
		],
	] as const) {
		const f = fixture(launcher, { source });
		const before = snapshot(f.target);
		refused(launch(f), "snapshot-identity-mismatch", 65, label);
		invariant(f, before, label);
	}
}

// ---------------------------------------------------------------------------
// Criterion 5/6: the provision child, cleanup, and their precedence.

async function armOrdersTheTerminals(launcher: string): Promise<void> {
	// The provision child refusing, overflowing and outliving its bound.
	for (const [label, body, seams] of [
		["a refused provision", "process.exit(2);\n", ""],
		["an overflowing provision", 'process.stdout.write("x".repeat(4096));\n', "streamBytes: 1024"],
		[
			"a provision past its bound",
			"await new Promise((resolve) => setTimeout(resolve, 5000));\n",
			"nodeTimeoutMs: 500",
		],
	] as const) {
		const f = fixture(launcher, {
			source: (work) => writeFileSync(join(work, ".pi/extensions/gitjig/install/provision-cli.ts"), body),
		});
		refused(seams === "" ? launch(f) : launchWith(f, seams), "provision-refused", 70, label);
		assert.deepEqual(readdirSync(f.scratch), [], `${label}: the child was not removed`);
	}
	// Cleanup that cannot confirm absence overrides success and every other cause.
	const kept = fixture(launcher);
	refused(launchWith(kept, "remove: () => {}"), "cleanup-failed", 74, "a success whose cleanup failed");
	const both = fixture(launcher, {
		source: (work) => writeFileSync(join(work, ".pi/extensions/gitjig/install/provision-cli.ts"), "process.exit(2);\n"),
	});
	refused(launchWith(both, "remove: () => {}"), "cleanup-failed", 74, "a refusal whose cleanup failed");
	// A temporary base that is not a directory.
	const nowhere = fixture(launcher);
	const before = snapshot(nowhere.target);
	refused(
		launchWith(nowhere, `temporaryBase: () => ${JSON.stringify(join(nowhere.root, "absent"))}`),
		"temporary-storage-unavailable",
		73,
		"an absent temporary base",
	);
	invariant(nowhere, before, "an absent temporary base");
}

// ---------------------------------------------------------------------------
// Criterion 4: the production bounds and the terminal algebra, by value.

async function armPinsTheBounds(launcher: string): Promise<void> {
	const module = (await import(`${launcher}?bounds=${Date.now()}`)) as {
		LIMITS: Record<string, number>;
		STATUS: Record<string, number>;
		defaultSeams: () => Record<string, unknown>;
	};
	assert.deepEqual({ ...module.LIMITS }, { gitTimeoutMs: 120000, nodeTimeoutMs: 300000, streamBytes: 1048576 });
	const seams = module.defaultSeams();
	assert.deepEqual(
		[seams.gitTimeoutMs, seams.nodeTimeoutMs, seams.streamBytes],
		[120000, 300000, 1048576],
		"the command line does not run at the production bounds",
	);
	assert.deepEqual(
		{ ...module.STATUS },
		{
			"invalid-input": 64,
			"snapshot-identity-mismatch": 65,
			"source-unavailable": 69,
			"provision-refused": 70,
			"temporary-storage-unavailable": 73,
			"cleanup-failed": 74,
		},
	);
}

// ---------------------------------------------------------------------------

const ARMS = {
	armSucceedsExactly,
	armAdmitsOnlyTheCommittedPin,
	armSourcesOnlyTheProjection,
	armBuildsEachChildEnvironment,
	armConfirmsTheClosure,
	armOrdersTheTerminals,
	armPinsTheBounds,
} as const;

for (const [name, arm] of Object.entries(ARMS))
	test(`#362: ${name}`, { timeout: 300_000 }, async () => {
		await arm(LAUNCHER);
	});

/** A private copy of the launcher with one exact edit; a stale anchor is a harness fault. */
function mutant(from: string, to: string): string {
	const source = readFileSync(LAUNCHER, "utf8");
	if (source.indexOf(from) === -1 || source.indexOf(from) !== source.lastIndexOf(from))
		throw new Error(`anchor must exist once: ${from}`);
	const dir = mkdtempSync(join(tmpdir(), "gitjig-362-mutant-"));
	roots.push(dir);
	const path = join(dir, "gitjig-bootstrap.mjs");
	writeFileSync(
		path,
		source.replace(from, () => to),
	);
	return path;
}

async function killed(arm: (launcher: string) => Promise<void>, from: string, to: string, named: string) {
	await assert.rejects(
		() => arm(mutant(from, to)),
		(error: unknown) => {
			assert.ok(error instanceof assert.AssertionError, `${named}: the arm failed for another reason: ${error}`);
			return true;
		},
		`${named}: the owner arm still passed`,
	);
}

test(
	"#362: baseline-first private-copy mutants, each killed by the arm that owns it",
	{ timeout: 900_000 },
	async () => {
		// Pre-reread execution: provision before the closure is confirmed.
		await killed(
			armConfirmsTheClosure,
			'\tif (!head.has(ENTRY)) refuse("snapshot-identity-mismatch");\n',
			"",
			"execution without the fixed entry",
		);
		await killed(
			armConfirmsTheClosure,
			'\t\t\t// A link, or anything else, is neither: the artifact relation admits none.\n\t\t} else refuse("snapshot-identity-mismatch");',
			"\t\t}",
			"a linked created entry admitted",
		);
		// Argv and pin overrides.
		await killed(
			armAdmitsOnlyTheCommittedPin,
			'\tif (argv.length !== 0) refuse("invalid-input");\n',
			"",
			"an operand admitted",
		);
		await killed(
			armAdmitsOnlyTheCommittedPin,
			'\t\tif (!read.equals(headBlob)) refuse("invalid-input");\n',
			"",
			"a dirty pin admitted",
		);
		await killed(
			armAdmitsOnlyTheCommittedPin,
			'if (Object.keys(source).sort().join(",") !== "host,owner,provider,repository") refuse("invalid-input");',
			"",
			"an extra source key admitted",
		);
		// Ambient rewrite and loader injection: the caller's environment forwarded.
		await killed(
			armBuildsEachChildEnvironment,
			'\tconst git = (globalConfig) => ({\n\t\tPATH: read.PATH ?? "",',
			'\tconst git = (globalConfig) => ({\n\t\t...process.env,\n\t\tPATH: read.PATH ?? "",',
			"the caller's environment forwarded to Git",
		);
		await killed(
			armBuildsEachChildEnvironment,
			'\t\tnode: { PATH: read.PATH ?? "", LC_ALL: "C", HOME: read.HOME ?? "" },',
			'\t\tnode: { ...process.env, PATH: read.PATH ?? "", LC_ALL: "C", HOME: read.HOME ?? "" },',
			"the caller's environment forwarded to provision",
		);
		// Cause and status collapse.
		await killed(
			armOrdersTheTerminals,
			'\t"provision-refused": 70,',
			'\t"provision-refused": 64,',
			"a provision status collapsed",
		);
		await killed(
			armSourcesOnlyTheProjection,
			'"--depth=1", "origin", pin.revision], "source-unavailable");',
			'"--depth=1", "origin", pin.revision], "invalid-input");',
			"a fetch failure collapsed into admission",
		);
		// Omitted cleanup, and success before cleanup.
		await killed(
			armOrdersTheTerminals,
			'\t\tif (!cleanup(state.child, seams)) cause = "cleanup-failed";\n',
			"\t\tcleanup(state.child, seams);\n",
			"cleanup not confirmed",
		);
		await killed(
			armSucceedsExactly,
			'\t\tif (!cleanup(state.child, seams)) cause = "cleanup-failed";\n',
			"",
			"cleanup omitted",
		);
		// The bounds.
		await killed(armPinsTheBounds, "gitTimeoutMs: 120000", "gitTimeoutMs: 1200000", "a widened Git bound");
	},
);

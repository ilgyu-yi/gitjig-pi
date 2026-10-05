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
	[
		'import { lstatSync, readdirSync, writeFileSync } from "node:fs";',
		'import { join } from "node:path";',
		"const modes = [];",
		"const visit = (path, relative) => {",
		"\tconst stats = lstatSync(path);",
		'\tmodes.push([relative, stats.isDirectory() ? "dir" : stats.isFile() ? "file" : "other", stats.mode & 0o777]);',
		"\tif (stats.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name), `${relative}/${name}`);",
		"};",
		'visit(process.cwd(), ".");',
		`writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), modes }));`,
		'process.stdout.write("provision: done\\n");',
		"",
	].join("\n");

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
		plan?: GitPlan;
		targetName?: string;
		targetFormat?: "sha1" | "sha256";
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
	const target = join(root, options.targetName ?? "target");
	mkdirSync(join(target, ".github/bin"), { recursive: true });
	mkdirSync(join(target, ".pi"), { recursive: true });
	copyFileSync(launcher, join(target, ".github/bin/gitjig-bootstrap.mjs"));
	const pin =
		options.pin?.(revision) ??
		`${JSON.stringify({ schemaVersion: 1, source: { provider: "github", host: "github.com", owner: "o", repository: "r" }, revision, payload: [] })}\n`;
	writeFileSync(join(target, ".pi/gitjig.pin.json"), pin);
	git(root, "init", "-q", `--object-format=${options.targetFormat ?? "sha1"}`, target);
	git(target, "add", "-A");
	git(target, "commit", "-qm", "target");
	const bin = join(root, "bin");
	mkdirSync(bin);
	const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const log = join(root, "git.log");
	writeFileSync(
		join(bin, "git"),
		gitSeam({ real, bare, log, envLog: join(root, "git-env.log"), plan: options.plan ?? {} }),
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

/**
 * What the caller-selected `git` does besides forwarding: serve the projected
 * URL from the local source for a fetch, and, per test, misbehave in one
 * named way. It logs every invocation and that invocation's own environment.
 */
type GitPlan = {
	fetch?: "signal" | "overflow" | "sleep";
	origin?: string;
	attached?: boolean;
};

function gitSeam({
	real,
	bare,
	log,
	envLog,
	plan,
}: {
	real: string;
	bare: string;
	log: string;
	envLog: string;
	plan: GitPlan;
}) {
	return `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const plan = ${JSON.stringify(plan)};
let args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
appendFileSync(${JSON.stringify(envLog)}, "== " + args.join(" ") + "\\n" + Object.keys(process.env).sort().map((key) => key + "=" + process.env[key]).join("\\n") + "\\n");
let env = process.env;
if (args.includes("fetch")) {
	if (plan.fetch === "signal") process.kill(process.pid, "SIGTERM");
	if (plan.fetch === "overflow") process.stdout.write("x".repeat(4096));
	if (plan.fetch === "sleep") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
	env = { ...env, GIT_ALLOW_PROTOCOL: "file" };
	args = ["-c", "url.file://${bare}.insteadOf=https://github.com/o/r", ...args];
}
// After the fetch, so the snapshot exists: the repository's origin is changed before the checkout.
if (plan.origin && args.includes("checkout"))
	spawnSync(${JSON.stringify(real)}, ["-C", args[args.indexOf("-C") + 1], "remote", "set-url", "origin", plan.origin], { env });
if (plan.attached && args.includes("checkout"))
	args = args.flatMap((arg) => (arg === "--detach" ? ["-B", "main"] : [arg]));
const run = spawnSync(${JSON.stringify(real)}, args, { stdio: "inherit", env });
if (run.signal) process.kill(process.pid, run.signal);
process.exit(run.status ?? 1);
`;
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
function launchWith(f: Fixture, seams: string, prelude = ""): Run {
	const harness = [
		`import { main, defaultSeams } from ${JSON.stringify(f.launcher)};`,
		'import fs, { chmodSync } from "node:fs";',
		'import { syncBuiltinESMExports } from "node:module";',
		'import { dirname } from "node:path";',
		"process.umask(0o077);",
		prelude,
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
	assert.ok(at(/ fetch /) < at(/ ls-tree -r /), "the closure was not listed after the fetch");
	// The closure check is the launcher's own node: it hashes in-process and spawns no Git.
	assert.equal(asked.filter((line) => / hash-object /.test(line)).length, 0, "the closure check spawned a Git child");
	assert.equal(asked.filter((line) => / fetch /.test(line)).length, 1, "more than one fetch");
	// A target in the longer object format admits its pin the same way.
	const sha256 = fixture(launcher, { targetFormat: "sha256" });
	const sha256Run = launch(sha256);
	assert.equal(sha256Run.status, 0, `a SHA-256 target was refused (stderr ${JSON.stringify(sha256Run.stderr)})`);
	// A physical path that ends in a space is still the target the launcher derives.
	const spaced = fixture(launcher, { targetName: "target " });
	const spacedRun = launch(spaced);
	assert.equal(
		spacedRun.status,
		0,
		`a target ending in a space was refused (stderr ${JSON.stringify(spacedRun.stderr)})`,
	);
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
		[
			// HEAD does not track it: the removal is committed and the file restored beside.
			"an untracked pin",
			(f: Fixture) => {
				const pin = join(f.target, ".pi/gitjig.pin.json");
				const bytes = readFileSync(pin);
				git(f.target, "rm", "-q", ".pi/gitjig.pin.json");
				git(f.target, "commit", "-qm", "drop the pin");
				mkdirSync(join(f.target, ".pi"), { recursive: true });
				writeFileSync(pin, bytes);
			},
		],
		[
			// HEAD holds a link; the index and the working tree hold a regular file.
			"a HEAD symlink staged as a file",
			(f: Fixture) => {
				// The link's target text is the pin's exact bytes, so HEAD's blob equals
				// the working file byte for byte: only HEAD's entry mode can refuse it.
				const pin = join(f.target, ".pi/gitjig.pin.json");
				const bytes = readFileSync(pin);
				unlinkSync(pin);
				symlinkSync(bytes.toString("utf8"), pin);
				git(f.target, "add", "-A");
				git(f.target, "commit", "-qm", "link the pin");
				unlinkSync(pin);
				writeFileSync(pin, bytes);
				git(f.target, "add", ".pi/gitjig.pin.json");
			},
		],
	] as const) {
		const f = fixture(launcher);
		mutate(f);
		const before = snapshot(f.target);
		refused(launch(f), "invalid-input", 64, label);
		invariant(f, before, label);
	}
	// The pin's path exchanged between the open and the post-read check, for a
	// byte-identical file: only the pathname and descriptor identity can refuse it.
	const exchanged = fixture(launcher);
	const exchangedPin = join(exchanged.target, ".pi/gitjig.pin.json");
	writeFileSync(join(exchanged.target, ".pi/swap.json"), readFileSync(exchangedPin));
	refused(
		launchWith(
			exchanged,
			"",
			`const readSync = fs.readSync; let swapped = false; fs.readSync = (...args) => { if (!swapped) { swapped = true; fs.renameSync(${JSON.stringify(join(exchanged.target, ".pi/swap.json"))}, ${JSON.stringify(exchangedPin)}); } return readSync(...args); }; syncBuiltinESMExports();`,
		),
		"invalid-input",
		64,
		"a pin exchanged during its read",
	);
	assert.equal(snapshot(exchanged.target).includes("swap.json"), false, "the exchange did not happen");
	assert.equal(existsSync(exchanged.record), false, "an exchanged pin reached provision");
	// A pin that is not the caller's own: the harness reports another uid.
	const foreign = fixture(launcher);
	const foreignBefore = snapshot(foreign.target);
	refused(
		launchWith(foreign, "", "process.getuid = () => 4242424;"),
		"invalid-input",
		64,
		"a pin owned by another user",
	);
	invariant(foreign, foreignBefore, "a pin owned by another user");
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
	for (const [label, fetch, seams] of [
		["a signalled fetch", "signal", ""],
		["an overflowing fetch", "overflow", "streamBytes: 1024"],
		["a fetch past its bound", "sleep", "gitTimeoutMs: 500"],
	] as const) {
		const f = fixture(launcher, { plan: { fetch } });
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
	// Each Git child's own environment, read where it ran.
	const blocks = readFileSync(join(f.root, "git-env.log"), "utf8")
		.split(/^== /m)
		.filter(Boolean)
		.map((block) => {
			const [args, ...lines] = block.split("\n").filter(Boolean);
			return {
				args,
				env: Object.fromEntries(
					lines.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
				),
			};
		});
	const shellOwn = new Set(["PWD", "SHLVL", "_", "OLDPWD"]);
	const keysOf = (env: Record<string, string>) =>
		Object.keys(env)
			.filter((key) => !platform.has(key) && !shellOwn.has(key))
			.sort();
	const profile = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "LC_ALL", "PATH"];
	const admission = blocks.filter(
		({ args }) => /cat-file blob HEAD:|rev-parse --show-toplevel$|ls-tree -z HEAD/.test(args) && !/snapshot/.test(args),
	);
	const acquisition = blocks.filter(({ args }) => / fetch /.test(args));
	assert.ok(admission.length >= 3 && acquisition.length === 1, "the Git children were not all observed");
	for (const { args, env } of admission) {
		assert.deepEqual(keysOf(env), profile, `the admission child's environment is not its profile: ${args}`);
		assert.equal(
			env.GIT_CONFIG_GLOBAL,
			"/dev/null",
			`the admission child's global config is not the null device: ${args}`,
		);
	}
	// Every other Git child, source, snapshot and closure alike, gets the git profile exactly.
	const others = blocks.filter((block) => !admission.includes(block));
	assert.ok(others.length >= 8, "the acquisition Git children were not all observed");
	for (const { args, env } of others) {
		assert.deepEqual(keysOf(env), profile, `a Git child's environment is not its profile: ${args}`);
		assert.match(
			env.GIT_CONFIG_GLOBAL,
			/gitjig-acquire-[^/]+\/gitconfig$/,
			`a Git child's global config is not the owned file: ${args}`,
		);
	}
	// And every Git invocation opens with the profile's config rows, exactly.
	const rows =
		"-c credential.helper= -c core.hooksPath=/dev/null -c http.followRedirects=false -c protocol.file.allow=never -c core.fileMode=false --no-replace-objects ";
	for (const { args } of blocks)
		assert.ok(args.startsWith(rows), `a Git child lacks the profile's config rows: ${args}`);
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
			// Status calls the checkout clean, but its bytes are not HEAD's blobs.
			"CRLF-smudged module bytes",
			(work: string) => writeFileSync(join(work, ".gitattributes"), "*.ts text eol=crlf\n"),
		],
		[
			"the entry file as a directory",
			(work: string) => {
				rmSync(join(work, ".pi/extensions/gitjig.ts"));
				mkdirSync(join(work, ".pi/extensions/gitjig.ts"));
				writeFileSync(join(work, ".pi/extensions/gitjig.ts/inner.ts"), "// inner\n");
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
	// The snapshot check: one of the two origin spellings, and a detached HEAD.
	for (const [label, plan] of [
		["another origin", { origin: "https://github.com/o/r2" }],
		["an attached checkout", { attached: true }],
	] as const) {
		const f = fixture(launcher, { plan });
		const before = snapshot(f.target);
		refused(launch(f), "snapshot-identity-mismatch", 65, label);
		invariant(f, before, label);
	}
	const suffixed = fixture(launcher, { plan: { origin: "https://github.com/o/r.git" } });
	const suffixedRun = launch(suffixed);
	assert.equal(
		suffixedRun.status,
		0,
		`the .git origin spelling was refused (stderr ${JSON.stringify(suffixedRun.stderr)})`,
	);
	// A member whose name holds a newline is still a member: admitted, not refused.
	const newline = fixture(launcher, {
		source: (work) => writeFileSync(join(work, ".pi/extensions/gitjig/odd\nname.ts"), "// odd\n"),
	});
	const admitted = launch(newline);
	assert.equal(admitted.status, 0, `a newline-named member was refused (stderr ${JSON.stringify(admitted.stderr)})`);
}

// ---------------------------------------------------------------------------
// The artifact relation: everything created is owner-private, executables included.

async function armOwnsEveryArtifact(launcher: string): Promise<void> {
	const f = fixture(launcher, {
		source: (work) => {
			mkdirSync(join(work, "tools/nested"), { recursive: true });
			writeFileSync(join(work, "tools/run.sh"), "#!/bin/sh\n");
			chmodSync(join(work, "tools/run.sh"), 0o755);
			writeFileSync(join(work, "tools/nested/data.txt"), "data\n");
		},
	});
	const run = launch(f);
	assert.equal(run.status, 0, `acquisition failed (stderr ${JSON.stringify(run.stderr)})`);
	const { modes } = JSON.parse(readFileSync(f.record, "utf8")) as { modes: [string, string, number][] };
	assert.ok(
		modes.some(([path]) => path === "./tools/run.sh"),
		"the executable was not acquired",
	);
	const wrong = modes.filter(([, kind, mode]) =>
		kind === "dir" ? mode !== 0o700 : kind === "file" ? mode !== 0o600 : true,
	);
	assert.deepEqual(wrong, [], "a created entry is not owner-private at the relation's mode");
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
	// Cleanup that cannot even look at the child: still the cause line and its status.
	const locked = fixture(launcher);
	try {
		refused(
			launchWith(locked, "remove: (path) => chmodSync(dirname(path), 0)"),
			"cleanup-failed",
			74,
			"an unreadable cleanup",
		);
	} finally {
		chmodSync(locked.scratch, 0o700);
	}
	// A base that resolves but cannot be inspected: the pre-creation temporary error.
	const opaque = fixture(launcher);
	const opaqueBase = join(opaque.root, "opaque-base");
	mkdirSync(opaqueBase);
	const opaqueBefore = snapshot(opaque.target);
	refused(
		launchWith(
			opaque,
			`temporaryBase: () => ${JSON.stringify(opaqueBase)}`,
			'const lstat = fs.lstatSync; fs.lstatSync = (path, ...rest) => { if (String(path).endsWith("/opaque-base")) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return lstat(path, ...rest); }; syncBuiltinESMExports();',
		),
		"temporary-storage-unavailable",
		73,
		"an uninspectable temporary base",
	);
	invariant(opaque, opaqueBefore, "an uninspectable temporary base");
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
	armOwnsEveryArtifact,
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
		// Round 1's boundaries, each by the arm that now owns it.
		await killed(
			armConfirmsTheClosure,
			'\t\tif (hashed !== oid) refuse("snapshot-identity-mismatch");\n',
			"",
			"closure without byte equality",
		);
		await killed(
			armConfirmsTheClosure,
			"([0-9a-f]{40}|[0-9a-f]{64})\\t(.+)$/s.exec(line);",
			"([0-9a-f]{40}|[0-9a-f]{64})\\t(.+)$/.exec(line);",
			"a newline-named member refused",
		);
		await killed(
			armConfirmsTheClosure,
			'\tif (!head.has(SCOPE_FILE) || !entryFile?.isFile() || entryFile.isSymbolicLink()) refuse("snapshot-identity-mismatch");\n\tworking.add(SCOPE_FILE);\n\twalk(SCOPE_DIR);',
			"\twalk(SCOPE_FILE);\n\twalk(SCOPE_DIR);",
			"the entry admitted as a directory (both statements, which each decide it alone)",
		);
		await killed(
			armAdmitsOnlyTheCommittedPin,
			"/^100(644|755) blob (?:[0-9a-f]{40}|[0-9a-f]{64})\\t(.+)$/s.exec(tracked)",
			"/^1[02]0(644|755|000) blob (?:[0-9a-f]{40}|[0-9a-f]{64})\\t(.+)$/s.exec(tracked)",
			"a HEAD link admitted as the pin",
		);
		await killed(
			armBuildsEachChildEnvironment,
			'\t\t"git-admission": git(devNull),',
			'\t\t"git-admission": git(join(tmpdir(), "hostile-config")),',
			"the admission child given another global config",
		);
		await killed(
			armOwnsEveryArtifact,
			"\t\t\tif ((stats.mode & 0o777) !== 0o600) chmodSync(path, 0o600);\n",
			"",
			"an executable left at its checkout mode",
		);
		// Round 2's boundaries.
		await killed(
			armConfirmsTheClosure,
			'\tif (origin !== sourceUrl && origin !== `${sourceUrl}.git`) refuse("snapshot-identity-mismatch");\n',
			"",
			"any origin admitted",
		);
		await killed(
			armConfirmsTheClosure,
			"origin !== sourceUrl && origin !== `${sourceUrl}.git`",
			"origin !== sourceUrl",
			"the .git origin spelling refused",
		);
		await killed(
			armConfirmsTheClosure,
			'\tif ((await shown(["rev-parse", "--symbolic-full-name", "HEAD"])) !== "HEAD") refuse("snapshot-identity-mismatch");\n',
			"",
			"an attached HEAD admitted",
		);
		await killed(
			armSucceedsExactly,
			'.toString("utf8").replace(/\\n$/, "");',
			'.toString("utf8").trim();',
			"a path's trailing space trimmed",
		);
		await killed(
			armOrdersTheTerminals,
			"\ttry {\n\t\treturn lstatSync(child, { throwIfNoEntry: false }) === undefined;\n\t} catch {\n\t\treturn false;\n\t}",
			"\treturn lstatSync(child, { throwIfNoEntry: false }) === undefined;",
			"a cleanup confirmation that throws",
		);
		await killed(
			armBuildsEachChildEnvironment,
			'line(await git(["-C", destination, ...args], "snapshot-identity-mismatch"))',
			'line(await bounded(seams, "git", [...GIT_CONFIG, "-C", destination, ...args], { env: { ...env.git, EXTRA_ENV: "1" }, cwd: child, timeoutMs: seams.gitTimeoutMs, cause: "snapshot-identity-mismatch" }))',
			"a snapshot child given an extra variable",
		);
		// Round 3's boundaries.
		await killed(
			armBuildsEachChildEnvironment,
			'\t"-c",\n\t"credential.helper=",\n',
			"",
			"a Git child left a credential helper",
		);
		await killed(
			armAdmitsOnlyTheCommittedPin,
			" || (uid !== undefined && opened.uid !== uid)",
			"",
			"a foreign pin admitted",
		);
		// Round 4's boundaries.
		await killed(
			armOrdersTheTerminals,
			'\t} catch {\n\t\trefuse("temporary-storage-unavailable");\n\t}\n\treturn { child,',
			'\t} catch (error) {\n\t\tif (error instanceof Refusal) throw error;\n\t\tthrow new Error("unmapped");\n\t}\n\treturn { child,',
			"a temporary-base error left to the admission fallback",
		);
		await killed(
			armSucceedsExactly,
			"blob (?:[0-9a-f]{40}|[0-9a-f]{64})\\t(.+)$/s.exec(tracked)",
			"blob [0-9a-f]{40}\\t(.+)$/s.exec(tracked)",
			"a SHA-256 pin entry refused",
		);
		// Either identity comparison refuses the exchange alone, so the pair is the mutant.
		await killed(
			armAdmitsOnlyTheCommittedPin,
			'\t\tif (after.dev !== before.dev || after.ino !== before.ino) refuse("invalid-input");\n\t\tif (descriptorAfter.dev !== after.dev || descriptorAfter.ino !== after.ino) refuse("invalid-input");\n',
			"",
			"a pin exchanged during its read admitted",
		);
		// The bounds.
		await killed(armPinsTheBounds, "gitTimeoutMs: 120000", "gitTimeoutMs: 1200000", "a widened Git bound");
	},
);

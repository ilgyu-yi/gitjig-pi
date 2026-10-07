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
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
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

/**
 * Every Git seam's own failures, in one file shared by all fixtures. The corpus
 * claims each named mutant is killed by its owner arm's property; a seam that
 * cannot observe what it was asked to observe records it here, so `killed` can
 * refuse to count a harness fault as a kill.
 */
const FAULTS = join(mkdtempSync(join(tmpdir(), "gitjig-362-faults-")), "faults.jsonl");
roots.push(join(FAULTS, ".."));
writeFileSync(FAULTS, "");

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_OPTIONAL_LOCKS: "0",
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
		"const snapshotModes = modes.splice(0);",
		'visit(join(process.cwd(), ".."), ".");',
		`writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), modes: snapshotModes, artifactModes: modes }));`,
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
		repository?: string;
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
		`${JSON.stringify({ schemaVersion: 1, source: { provider: "github", host: "github.com", owner: "o", repository: options.repository ?? "r" }, revision, payload: [] })}\n`;
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
		gitSeam({
			real,
			bare,
			log,
			envLog: join(root, "git-env.log"),
			plan: options.plan ?? {},
			sourceUrl: `https://github.com/o/${options.repository ?? "r"}`,
		}),
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
	dirty?: boolean;
	// Git's answer replaced, for an invocation whose arguments end so.
	say?: Record<string, string>;
	// Every invocation reads its stdin to end of file before it runs.
	readsStdin?: boolean;
	omittedMember?: string;
	// An external object store the snapshot declares once its checkout exists.
	alternates?: string;
	// The invocation whose arguments end so fails, so a node's own child can fail.
	failAt?: string;
};

function gitSeam({
	real,
	bare,
	log,
	envLog,
	plan,
	sourceUrl,
}: {
	real: string;
	bare: string;
	log: string;
	envLog: string;
	plan: GitPlan;
	sourceUrl: string;
}) {
	return `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const plan = ${JSON.stringify(plan)};
let args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
appendFileSync(${JSON.stringify(envLog)}, "== " + args.join(" ") + "\\n" + Object.keys(process.env).sort().map((key) => key + "=" + process.env[key]).join("\\n") + "\\n");
// Real Git reads an absent or unset global config as empty rather than failing,
// so this observer does too: only another failure is the harness's own, and it
// is recorded as a fault instead of breaking the child under observation.
let bytes = null;
let fault = null;
if (typeof process.env.GIT_CONFIG_GLOBAL === "string") {
	try {
		bytes = require("node:fs").readFileSync(process.env.GIT_CONFIG_GLOBAL).toString("base64");
	} catch (error) {
		if (error.code !== "ENOENT") fault = String(error);
	}
}
appendFileSync(${JSON.stringify(`${envLog}.config.jsonl`)}, JSON.stringify({ args: args.join(" "), bytes, fault }) + "\\n");
if (fault !== null) appendFileSync(${JSON.stringify(FAULTS)}, JSON.stringify({ args: args.join(" "), fault }) + "\\n");
if (plan.readsStdin) require("node:fs").readFileSync(0);
for (const [tail, text] of Object.entries(plan.say ?? {}))
	if (args.join(" ").endsWith(tail)) {
		process.stdout.write(text + "\\n");
		process.exit(0);
	}
if (plan.failAt && args.join(" ").endsWith(plan.failAt)) {
	process.stderr.write("the seam refused this invocation\\n");
	process.exit(3);
}
let env = process.env;
if (args.includes("fetch")) {
	if (plan.fetch === "signal") process.kill(process.pid, "SIGTERM");
	if (plan.fetch === "overflow") process.stdout.write("x".repeat(4096));
	if (plan.fetch === "sleep") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
	env = { ...env, GIT_ALLOW_PROTOCOL: "file" };
	args = ["-c", ${JSON.stringify(`url.file://${bare}.insteadOf=${sourceUrl}`)}, ...args];
}
// After the fetch, so the snapshot exists: the repository's origin is changed before the checkout.
if (plan.origin && args.includes("checkout"))
	spawnSync(${JSON.stringify(real)}, ["-C", args[args.indexOf("-C") + 1], "remote", "set-url", "origin", plan.origin], { env });
if (plan.attached && args.includes("checkout"))
	args = args.flatMap((arg) => (arg === "--detach" ? ["-B", "main"] : [arg]));
if (plan.omittedMember && args.includes("ls-tree") && args.includes("-r")) {
	const listed = spawnSync(${JSON.stringify(real)}, args, { env });
	process.stdout.write(listed.stdout.toString("utf8").split("\\0").filter((entry) => !entry.endsWith("\\t" + plan.omittedMember)).join("\\0"));
	process.stderr.write(listed.stderr);
	process.exit(listed.status ?? 1);
}
const run = spawnSync(${JSON.stringify(real)}, args, { stdio: "inherit", env });
// The modes each Git child creates, read where it creates them, before anything
// normalizes them. The artifacts relation holds from the first created child
// onward: a git-child's own file may be read-only or executable, but nothing it
// creates is group- or world-accessible, and a created directory is 0700.
if (run.status === 0) {
	const fsm = require("node:fs");
	const pathm = require("node:path");
	const named = args.includes("-C") ? args[args.indexOf("-C") + 1] : args[args.length - 1];
	// The whole acquisition child, not only the snapshot: the launcher's own
	// gitconfig is a created file in that subtree too.
	const owned = typeof named === "string" ? /^(.*gitjig-acquire-[^/]+)/.exec(named) : null;
	const at = owned ? owned[1] : named;
	if (owned && fsm.existsSync(at)) {
		const offenders = [];
		// Entries that are owner-only but not yet at the relation's exact modes: the
		// latitude a git-child has until the launcher normalizes within its node.
		const loose = [];
		let files = 0;
		let dirs = 0;
		// The subtree's own root counts: it is a created directory too.
		const rootMode = fsm.lstatSync(at).mode & 0o777;
		dirs++;
		if (rootMode !== 0o700) offenders.push([".", "dir", rootMode]);
		const walk = (p) => {
			for (const name of fsm.readdirSync(p)) {
				const full = pathm.join(p, name);
				const stats = fsm.lstatSync(full);
				const mode = stats.mode & 0o777;
				const rel = pathm.relative(at, full);
				if (stats.isDirectory()) {
					dirs++;
					if (mode !== 0o700) offenders.push([rel, "dir", mode]);
					walk(full);
				} else if (stats.isFile()) {
					files++;
					if ((mode & 0o077) !== 0) offenders.push([rel, "file", mode]);
					else if (mode !== 0o600) loose.push([rel, "file", mode]);
				} else offenders.push([rel, "other", mode]);
			}
		};
		walk(at);
		const mode = (p) => { try { return fsm.lstatSync(p).mode & 0o777; } catch { return null; } };
		appendFileSync(${JSON.stringify(`${envLog}.modes.jsonl`)}, JSON.stringify({ args: args.join(" "), gitDir: mode(pathm.join(named, ".git")), config: mode(pathm.join(named, ".git/config")), offenders, loose, files, dirs }) + "\\n");
	}
}
// After the checkout: the created store declares an object store outside itself.
if (plan.alternates && args.includes("checkout") && run.status === 0) {
	const info = require("node:path").join(args[args.indexOf("-C") + 1], ".git/objects/info");
	require("node:fs").mkdirSync(info, { recursive: true });
	require("node:fs").writeFileSync(require("node:path").join(info, "alternates"), plan.alternates + "\\n");
}
// After the checkout: an untracked file outside the module population.
if (plan.dirty && args.includes("checkout") && run.status === 0)
	require("node:fs").writeFileSync(require("node:path").join(args[args.indexOf("-C") + 1], "untracked.txt"), "x\\n");
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
	// Include the complete fixture tree, especially .git/config and the index;
	// path/type/mode/bytes are observed without following links. Git probes use
	// GIT_OPTIONAL_LOCKS=0 so the observer does not refresh target metadata.
	const tree: unknown[] = [];
	const walk = (relative: string) => {
		const at = join(target, relative);
		const stats = lstatSync(at);
		if (stats.isSymbolicLink()) tree.push([relative, "link", stats.mode & 0o777, readlinkSync(at)]);
		else if (stats.isDirectory()) {
			tree.push([relative, "dir", stats.mode & 0o777]);
			for (const name of readdirSync(at).sort()) walk(relative === "." ? name : `${relative}/${name}`);
		} else tree.push([relative, "file", stats.mode & 0o777, readFileSync(at).toString("base64")]);
	};
	walk(".");
	return JSON.stringify({
		tree,
		status: git(target, "status", "--porcelain=v1", "--untracked-files=all", "--ignored"),
		head: git(target, "rev-parse", "HEAD"),
		// A link is recorded as its own target text, never followed.
		bytes: files.map((path) => {
			const at = join(target, path);
			return [path, lstatSync(at).isSymbolicLink() ? `link:${readlinkSync(at)}` : readFileSync(at).toString("base64")];
		}),
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
	// The whole closed Git-child sequence: no unowned call may hide behind a
	// different command name in the launcher's closure node.
	const rows =
		"-c credential.helper= -c core.hooksPath=/dev/null -c http.followRedirects=false -c protocol.file.allow=never -c core.fileMode=false -c core.symlinks=false --no-replace-objects ";
	const init = asked.find((line) => / init /.test(line));
	assert.ok(init, "init was not observed");
	const destination = init.slice(init.indexOf(" init -q --template= -- ") + " init -q --template= -- ".length);
	assert.deepEqual(
		asked,
		[
			`${rows}-C ${realpathSync(f.target)} rev-parse --show-toplevel`,
			`${rows}-C ${realpathSync(f.target)} ls-tree -z HEAD -- .pi/gitjig.pin.json`,
			`${rows}-C ${realpathSync(f.target)} cat-file blob HEAD:.pi/gitjig.pin.json`,
			`${rows}init -q --template= -- ${destination}`,
			`${rows}-C ${destination} remote add origin https://github.com/o/r`,
			`${rows}-C ${destination} fetch -q --no-tags --depth=1 origin ${f.revision}`,
			`${rows}-C ${destination} checkout -q --detach ${f.revision}`,
			...[
				"rev-parse --git-common-dir",
				"rev-parse --show-toplevel",
				"rev-parse HEAD",
				"rev-parse --symbolic-full-name HEAD",
				"remote get-url origin",
				"status --porcelain=v1 --untracked-files=all --ignored=matching",
				"rev-parse --show-object-format",
				"ls-tree -r -z --full-tree HEAD -- .pi/extensions/gitjig.ts .pi/extensions/gitjig",
			].map((args) => `${rows}-C ${destination} ${args}`),
		],
		"the acquisition spawned a child outside its closed node-owned sequence",
	);
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
	// The same byte-identical replacement, but in the window between the pathname's
	// own stat and the open: only the two before-anchored identity comparisons can
	// refuse it, and either of them does.
	const preOpen = fixture(launcher);
	const preOpenPin = join(preOpen.target, ".pi/gitjig.pin.json");
	writeFileSync(join(preOpen.target, ".pi/swap.json"), readFileSync(preOpenPin));
	refused(
		launchWith(
			preOpen,
			"",
			`const openSync = fs.openSync; let swapped = false; fs.openSync = (...args) => { if (!swapped && String(args[0]).endsWith("gitjig.pin.json")) { swapped = true; fs.renameSync(${JSON.stringify(join(preOpen.target, ".pi/swap.json"))}, ${JSON.stringify(preOpenPin)}); } return openSync(...args); }; syncBuiltinESMExports();`,
		),
		"invalid-input",
		64,
		"a pin exchanged before its open",
	);
	assert.equal(snapshot(preOpen.target).includes("swap.json"), false, "the pre-open exchange did not happen");
	assert.equal(existsSync(preOpen.record), false, "a pin exchanged before its open reached provision");
	// Git names another toplevel than the one the launcher derives.
	const elsewhere = fixture(launcher, { plan: { say: { "target rev-parse --show-toplevel": "/" } } });
	const elsewhereBefore = snapshot(elsewhere.target);
	refused(launch(elsewhere), "invalid-input", 64, "another toplevel");
	invariant(elsewhere, elsewhereBefore, "another toplevel");
	// The pin reached through a linked `.pi`: its bytes are HEAD's, its ancestor is not a directory.
	const linked = fixture(launcher);
	renameSync(join(linked.target, ".pi"), join(linked.target, "pi-real"));
	symlinkSync("pi-real", join(linked.target, ".pi"));
	const linkedBefore = snapshot(linked.target);
	refused(launch(linked), "invalid-input", 64, "a linked .pi");
	invariant(linked, linkedBefore, "a linked .pi");
	// The launcher located through a link beside it: the same target, but not its own physical path.
	const viaLink = fixture(launcher);
	symlinkSync("gitjig-bootstrap.mjs", join(viaLink.target, ".github/bin/link.mjs"));
	const viaLinkBefore = snapshot(viaLink.target);
	refused(
		launchWith(viaLink, `launcherPath: ${JSON.stringify(join(viaLink.target, ".github/bin/link.mjs"))}`),
		"invalid-input",
		64,
		"a linked launcher path",
	);
	invariant(viaLink, viaLinkBefore, "a linked launcher path");
	// Byte-identical and HEAD-tracked, but not one-link: the extra link is outside the target.
	const multiplyLinked = fixture(launcher);
	linkSync(join(multiplyLinked.target, ".pi/gitjig.pin.json"), join(multiplyLinked.root, "pin-hardlink"));
	const multiplyLinkedBefore = snapshot(multiplyLinked.target);
	refused(launch(multiplyLinked), "invalid-input", 64, "a multiply-linked pin");
	invariant(multiplyLinked, multiplyLinkedBefore, "a multiply-linked pin");
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
		// An empty name is refused by its own predicate: no other one decides it,
		// and without it the acquisition reaches the network for a nameless URL.
		[
			"an empty owner",
			(revision: string) => JSON.stringify({ schemaVersion: 1, source: source({ owner: "" }), revision }),
		],
		[
			"an empty repository",
			(revision: string) => JSON.stringify({ schemaVersion: 1, source: source({ repository: "" }), revision }),
		],
		[
			"an uppercase revision",
			(revision: string) => JSON.stringify({ schemaVersion: 1, source: source({}), revision: revision.toUpperCase() }),
		],
		[
			"a short revision",
			(revision: string) => JSON.stringify({ schemaVersion: 1, source: source({}), revision: revision.slice(1) }),
		],
		[
			// The pattern test coerces, so a one-element array of the exact revision
			// matches it: only the type itself refuses this shape.
			"a revision that is not a string",
			(revision: string) => JSON.stringify({ schemaVersion: 1, source: source({}), revision: [revision] }),
		],
		["not an object", () => "[]"],
		// These bytes are not UTF-8 and not JSON either, so they measure the parse,
		// not the decoder.
		["neither UTF-8 nor JSON", () => Buffer.from([0x7b, 0xff, 0x7d])],
		// The decoder alone: one invalid byte inside a string the projection ignores.
		// Decoded with replacement these bytes are valid JSON naming a valid source,
		// so only a fatal decode refuses them.
		[
			"an invalid byte inside an ignored string",
			(revision: string) => {
				const bytes = Buffer.from(
					`${JSON.stringify({ schemaVersion: 1, source: source({}), revision, payload: ["x"] })}\n`,
					"utf8",
				);
				bytes[bytes.lastIndexOf(0x78)] = 0xff;
				return bytes;
			},
		],
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
		const started = Date.now();
		refused(seams === "" ? launch(f) : launchWith(f, seams), "source-unavailable", 69, label);
		// The sleeping child outlives any bound this suite sets, so what ended it is
		// the deadline that was applied, not the child finishing: a widened deadline
		// shows up here as elapsed time, where a status alone cannot see it.
		if (fetch === "sleep")
			assert.ok(
				Date.now() - started < 4000,
				`${label}: the applied deadline was not the narrowed one (${Date.now() - started} ms)`,
			);
		invariant(f, before, label);
	}
	// A snapshot-check Git child that fails is that node's cause, not another's.
	const failing = fixture(launcher, { plan: { failAt: "rev-parse --git-common-dir" } });
	const failingBefore = snapshot(failing.target);
	refused(launch(failing), "snapshot-identity-mismatch", 65, "a failing snapshot-check child");
	invariant(failing, failingBefore, "a failing snapshot-check child");
	// Repository spelling is literal: .git belongs to the name, not an optional suffix.
	const literalSuffix = fixture(launcher, { repository: "r.git" });
	const suffixRun = launch(literalSuffix);
	assert.equal(suffixRun.status, 0, `literal .git repository was refused: ${suffixRun.stderr}`);
	const suffixReached = JSON.parse(readFileSync(literalSuffix.record, "utf8")) as { argv: string[] };
	assert.equal(suffixReached.argv[suffixReached.argv.indexOf("--source") + 1], "https://github.com/o/r.git");
	assert.ok(readFileSync(literalSuffix.log, "utf8").includes("remote add origin https://github.com/o/r.git\n"));
	// The source children, argument for argument: an empty template, one revision, no tags.
	const exact = fixture(launcher);
	assert.equal(launch(exact).status, 0, "the exact source run failed");
	const asked = readFileSync(exact.log, "utf8").split("\n");
	const rows =
		"-c credential.helper= -c core.hooksPath=/dev/null -c http.followRedirects=false -c protocol.file.allow=never -c core.fileMode=false -c core.symlinks=false --no-replace-objects";
	const snapshotDir =
		asked
			.find((line) => / init /.test(line))
			?.split(" ")
			.at(-1) ?? "";
	assert.match(snapshotDir, /gitjig-acquire-[^/]+\/snapshot$/, "the init child was not observed");
	for (const expected of [
		`${rows} init -q --template= -- ${snapshotDir}`,
		`${rows} -C ${snapshotDir} remote add origin https://github.com/o/r`,
		`${rows} -C ${snapshotDir} fetch -q --no-tags --depth=1 origin ${exact.revision}`,
		`${rows} -C ${snapshotDir} checkout -q --detach ${exact.revision}`,
	])
		assert.equal(asked.filter((line) => line === expected).length, 1, `the source child was not exactly: ${expected}`);
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
		// Never the value the profiles fix, so forwarding the caller's own locale
		// cannot satisfy the assertions below by coincidence.
		LC_ALL: "tr_TR.UTF-8",
	});
	assert.equal(run.status, 0, `the hostile ambient broke acquisition (stderr ${JSON.stringify(run.stderr)})`);
	// The platform's own additions, measured with an empty-environment control child.
	// Names alone are not enough: a variable the platform also adds, carrying another
	// value, would be invisible to a name-only subtraction. So the control's exact
	// name and value pairs are subtracted, and nothing else is.
	const control = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
		encoding: "utf8",
		env: {},
	});
	const added = JSON.parse(control.stdout) as Record<string, string>;
	const platform = { has: (key: string, value: string) => added[key] === value };
	const reached = JSON.parse(readFileSync(f.record, "utf8")) as { env: Record<string, string> };
	assert.deepEqual(
		Object.keys(reached.env)
			.filter((key) => !platform.has(key, reached.env[key] as string))
			.sort(),
		["HOME", "LC_ALL", "PATH"],
		"the provision child's environment is not its profile",
	);
	assert.equal(reached.env.HOME, f.root, "the provision child's HOME is not the launcher's own read");
	const callerPath = `${f.bin}:${process.env.PATH ?? ""}`;
	assert.equal(reached.env.PATH, callerPath, "the provision child's PATH is not the launcher's own read");
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
	const keysOf = (env: Record<string, string>) =>
		Object.keys(env)
			.filter((key) => !platform.has(key, env[key] as string))
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
	// Observe the config's bytes at every Git-child invocation, before cleanup.
	const configs = readFileSync(join(f.root, "git-env.log.config.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { args: string; bytes: string | null; fault: string | null });
	assert.deepEqual(
		configs.map(({ args }) => args),
		blocks.map(({ args }) => args),
		"a config observation is missing",
	);
	for (const { args, bytes, fault } of configs) {
		assert.equal(fault, null, `the seam could not observe a Git child's config: ${args}`);
		// Absent and unset are both recorded as no bytes, exactly as Git reads them.
		assert.equal(bytes, "", `a Git child's owned config is not empty: ${args}`);
	}
	// Every Git child's values, row by row.
	for (const { args, env } of blocks) {
		assert.equal(env.PATH, `${f.bin}:${process.env.PATH ?? ""}`, `a Git child's PATH: ${args}`);
		assert.equal(env.LC_ALL, "C", `a Git child's LC_ALL: ${args}`);
		assert.equal(env.GIT_CONFIG_NOSYSTEM, "1", `a Git child's GIT_CONFIG_NOSYSTEM: ${args}`);
		assert.equal(env.GIT_TERMINAL_PROMPT, "0", `a Git child's GIT_TERMINAL_PROMPT: ${args}`);
	}
	// And every Git invocation opens with the profile's config rows, exactly.
	const rows =
		"-c credential.helper= -c core.hooksPath=/dev/null -c http.followRedirects=false -c protocol.file.allow=never -c core.fileMode=false -c core.symlinks=false --no-replace-objects ";
	for (const { args } of blocks)
		assert.ok(args.startsWith(rows), `a Git child lacks the profile's config rows: ${args}`);
	// Last, because it writes to the logs just read: the seam and real Git agree
	// that an absent global config is empty rather than a failure. When they
	// disagreed, a mutant that only moved this path red this arm on the seam's own
	// error, before any profile assertion could decide anything.
	const absent = join(f.root, "no-such-gitconfig");
	for (const command of [join(f.bin, "git"), execFileSync("which", ["git"], { encoding: "utf8" }).trim()]) {
		const probe = spawnSync(command, ["-C", f.target, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			env: {
				PATH: process.env.PATH ?? "",
				LC_ALL: "C",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: absent,
				GIT_TERMINAL_PROMPT: "0",
			},
		});
		assert.equal(probe.status, 0, `an absent global config broke ${command}: ${probe.stderr}`);
	}
	assert.equal(readFileSync(FAULTS, "utf8"), "", "the seam recorded a fault of its own");
}

/**
 * Criterion 4: the exclusions relation's `alternates` row, for both Git profiles.
 * Git honours an object database's own `objects/info/alternates` whatever its
 * environment holds, so no profile row can exclude it: the launcher reads the
 * declaration itself, for the target it admits and for the store it creates.
 */
async function armExcludesAlternateObjectStores(launcher: string): Promise<void> {
	// The target's entire object database moved outside the target, reachable only
	// through the declaration left behind.
	const external = fixture(launcher);
	const externalHead = git(external.target, "rev-parse", "HEAD");
	const store = join(external.root, "external-objects");
	renameSync(join(external.target, ".git/objects"), store);
	mkdirSync(join(external.target, ".git/objects/info"), { recursive: true });
	writeFileSync(join(external.target, ".git/objects/info/alternates"), `${store}\n`);
	// The objects really are outside the target, so what follows is the
	// declaration's refusal and not an absent-object accident: Git itself still
	// names HEAD here, and only through that store.
	assert.equal(git(external.target, "rev-parse", "HEAD"), externalHead, "the external store is not serving HEAD");
	assert.deepEqual(readdirSync(join(external.target, ".git/objects")), ["info"], "an object stayed in the target");
	const externalBefore = snapshot(external.target);
	refused(launch(external), "invalid-input", 64, "a target declaring an alternate store");
	invariant(external, externalBefore, "a target declaring an alternate store");
	// The store this acquisition creates, declaring an alternate after its checkout
	// and before the closure check reads one object.
	const created = fixture(launcher, { plan: { alternates: "/nowhere/objects" } });
	const createdBefore = snapshot(created.target);
	refused(launch(created), "snapshot-identity-mismatch", 65, "a snapshot declaring an alternate store");
	invariant(created, createdBefore, "a snapshot declaring an alternate store");
	// A target whose `.git` is a gitdir pointer keeps its object database
	// elsewhere, so this process cannot read the declaration at all: the row is
	// unproven, and an unproven row refuses.
	const pointer = fixture(launcher);
	const pointerHead = git(pointer.target, "rev-parse", "HEAD");
	const elsewhere = join(pointer.root, "target-gitdir");
	renameSync(join(pointer.target, ".git"), elsewhere);
	writeFileSync(join(pointer.target, ".git"), `gitdir: ${elsewhere}\n`);
	assert.equal(git(pointer.target, "rev-parse", "HEAD"), pointerHead, "the pointer does not resolve");
	const pointerBefore = snapshot(pointer.target);
	refused(launch(pointer), "invalid-input", 64, "a target whose object database is elsewhere");
	invariant(pointer, pointerBefore, "a target whose object database is elsewhere");
	// The same database elsewhere, reached through a link rather than a pointer
	// file: reading the declaration through the link would find none and admit the
	// external store, so the link itself refuses.
	const linkedDir = fixture(launcher);
	const linkedHead = git(linkedDir.target, "rev-parse", "HEAD");
	const moved = join(linkedDir.root, "linked-gitdir");
	renameSync(join(linkedDir.target, ".git"), moved);
	symlinkSync(moved, join(linkedDir.target, ".git"));
	assert.equal(git(linkedDir.target, "rev-parse", "HEAD"), linkedHead, "the linked database does not resolve");
	assert.equal(
		existsSync(join(linkedDir.target, ".git/objects/info/alternates")),
		false,
		"the linked database declares an alternate, so this measures the leaf instead",
	);
	const linkedDirBefore = snapshot(linkedDir.target);
	refused(launch(linkedDir), "invalid-input", 64, "a target whose database is reached through a link");
	invariant(linkedDir, linkedDirBefore, "a target whose database is reached through a link");
	// A declaration that cannot be read is not an absent one. The harness refuses the
	// read itself, because a target whose `.git` is a real directory can still hold
	// an unreadable `objects/info`, and reading nothing there must not admit the
	// store it might have named.
	const unreadable = fixture(launcher);
	const unreadableBefore = snapshot(unreadable.target);
	refused(
		launchWith(
			unreadable,
			"",
			'const lstat = fs.lstatSync; fs.lstatSync = (path, ...rest) => { if (String(path).endsWith("objects/info/alternates")) { const error = new Error("EACCES: permission denied"); error.code = "EACCES"; throw error; } return lstat(path, ...rest); }; syncBuiltinESMExports();',
		),
		"invalid-input",
		64,
		"an unreadable alternates declaration",
	);
	invariant(unreadable, unreadableBefore, "an unreadable alternates declaration");
}

// ---------------------------------------------------------------------------
// Criterion 3: the confirmed snapshot's closure.

async function armConfirmsTheClosure(launcher: string): Promise<void> {
	// Git's listing omits a tracked module while the clean checkout retains it:
	// only working-population equality can distinguish this from a valid closure.
	const omitted = fixture(launcher, {
		source: (work) => writeFileSync(join(work, ".pi/extensions/gitjig/extra.ts"), "// member\n"),
		plan: { omittedMember: ".pi/extensions/gitjig/extra.ts" },
	});
	const omittedBefore = snapshot(omitted.target);
	refused(launch(omitted), "snapshot-identity-mismatch", 65, "a listed population missing a working member");
	invariant(omitted, omittedBefore, "a listed population missing a working member");
	for (const [label, source] of [
		[
			"a linked module file",
			(work: string) => {
				rmSync(join(work, ".pi/extensions/gitjig.ts"));
				symlinkSync("../README.md", join(work, ".pi/extensions/gitjig.ts"));
			},
		],
		// A tracked link outside the module population no longer refuses: the git
		// profile checks one out as a regular file holding its link text, so nothing
		// outside the population is a link to walk. `armOwnsEveryArtifact` owns that
		// property now, with the mutant that drops the config row.
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
		["another common directory", { say: { "snapshot rev-parse --git-common-dir": "/" } }],
		["another work tree", { say: { "snapshot rev-parse --show-toplevel": "/" } }],
		["another revision", { say: { "snapshot rev-parse HEAD": "0".repeat(40) } }],
		// Clean everywhere the closure looks, dirty only to status.
		["an untracked file in the snapshot", { dirty: true }],
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
	const { artifactModes: modes } = JSON.parse(readFileSync(f.record, "utf8")) as {
		artifactModes: [string, string, number][];
	};
	assert.ok(
		modes.some(([path]) => path === "./gitconfig"),
		"the owned config was not observed",
	);
	assert.ok(
		modes.some(([path]) => path === "./snapshot/tools/run.sh"),
		"the executable was not acquired",
	);
	const wrong = modes.filter(([, kind, mode]) =>
		kind === "dir" ? mode !== 0o700 : kind === "file" ? mode !== 0o600 : true,
	);
	assert.deepEqual(wrong, [], "a created entry is not owner-private at the relation's mode");
	// Those modes are read at provision, after normalization. The relation holds from
	// the first created child onward, so every Git child's own creations are read
	// where they were made, after each invocation and before the launcher normalizes
	// anything: `git-child-created-file` admits a read-only or executable file and
	// nothing group- or world-accessible, and a created directory is 0700.
	const created = readFileSync(join(f.root, "git-env.log.modes.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map(
			(line) =>
				JSON.parse(line) as {
					args: string;
					gitDir: number | null;
					config: number | null;
					offenders: [string, string, number][];
					loose: [string, string, number][];
					files: number;
					dirs: number;
				},
		);
	// Every child that writes in the acquisition child is observed: the snapshot's
	// creation, its origin, the fetch that writes the object store, and the checkout
	// that writes the working files.
	for (const stage of [" init ", "remote add origin", " fetch ", " checkout "])
		assert.ok(
			created.some(({ args }) => args.includes(stage)),
			`no creation-time observation for${stage}`,
		);
	for (const { args, offenders } of created)
		assert.deepEqual(offenders, [], `a Git child created an entry outside the artifacts relation: ${args}`);
	// The latitude ends with the node that used it: by the time the snapshot check's
	// own children run, the source-fetch node's successor, every entry is already at
	// the relation's exact modes.
	const sourceFetch = /( init | remote add | fetch | checkout )/;
	for (const { args, loose } of created.filter(({ args }) => !sourceFetch.test(` ${args} `)))
		assert.deepEqual(loose, [], `the successor node observed an unnormalized entry: ${args}`);
	// And the latitude was really used, so the assertion above is not vacuous.
	assert.ok(
		created.some(({ args, loose }) => sourceFetch.test(` ${args} `) && loose.length > 0),
		"no Git child used the read-only or executable latitude, so normalization proves nothing",
	);
	// The fetch really did write an object store, and the checkout really did write
	// files, so an empty observation cannot pass as a clean one.
	const fetched = created.find(({ args }) => args.includes(" fetch "));
	const checked = created.find(({ args }) => args.includes(" checkout "));
	assert.ok((fetched?.files ?? 0) > 0 && (fetched?.dirs ?? 0) > 0, "the fetch observation saw no created entries");
	assert.ok((checked?.files ?? 0) > (fetched?.files ?? 0), "the checkout observation saw no new files");
	const initial = created.find(({ args }) => args.includes(" init "));
	assert.deepEqual(
		[initial?.gitDir, initial?.config],
		[0o700, 0o600],
		"Git created the snapshot repository outside the relation's modes",
	);
	// The launcher's own gitconfig is created at the relation's mode, observed where
	// it is created rather than at provision: a write at another mode, normalized
	// before the first Git child, is invisible to every later observer.
	const configModes = join(f.root, "config-creation.log");
	const observed = fixture(launcher);
	const observedRun = launchWith(
		observed,
		"",
		`const write = fs.writeFileSync; fs.writeFileSync = (path, ...rest) => { const out = write(path, ...rest); if (String(path).endsWith("/gitconfig")) fs.appendFileSync(${JSON.stringify(configModes)}, "file " + (fs.lstatSync(path).mode & 0o777).toString(8) + "\\n"); return out; }; const mkdir = fs.mkdirSync; fs.mkdirSync = (path, ...rest) => { const out = mkdir(path, ...rest); try { fs.appendFileSync(${JSON.stringify(configModes)}, "dir " + (fs.lstatSync(path).mode & 0o777).toString(8) + "\\n"); } catch {} return out; }; const mkdtemp = fs.mkdtempSync; fs.mkdtempSync = (...rest) => { const made = mkdtemp(...rest); fs.appendFileSync(${JSON.stringify(configModes)}, "dir " + (fs.lstatSync(made).mode & 0o777).toString(8) + "\\n"); return made; }; syncBuiltinESMExports();`,
	);
	assert.equal(observedRun.status, 0, `the observed acquisition failed (stderr ${JSON.stringify(observedRun.stderr)})`);
	// Read in the launcher's own process, at the moment of creation: a mode set
	// after the fact, before any Git child runs, is invisible everywhere else.
	const atCreation = readFileSync(configModes, "utf8").trim().split("\n");
	assert.ok(
		atCreation.includes("file 600") && atCreation.includes("dir 700"),
		`the launcher's own creations were not observed: ${JSON.stringify(atCreation)}`,
	);
	assert.deepEqual(
		[...new Set(atCreation)].sort(),
		["dir 700", "file 600"],
		"the launcher created an entry outside the relation's modes",
	);
	// A tracked link is never created, at any moment: outside the module population
	// the acquisition still succeeds and the child holds no link, and inside it the
	// entry's own mode refuses the closure.
	const linked = fixture(launcher, {
		source: (work) => {
			symlinkSync("README.md", join(work, "tracked-link"));
		},
	});
	const linkedRun = launch(linked);
	assert.equal(
		linkedRun.status,
		0,
		`a tracked link outside the module refused (stderr ${JSON.stringify(linkedRun.stderr)})`,
	);
	for (const { args, offenders } of readFileSync(join(linked.root, "git-env.log.modes.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { args: string; offenders: [string, string, number][] }))
		assert.deepEqual(offenders, [], `a tracked link was created in the acquisition child: ${args}`);
	const insideModule = fixture(launcher, {
		source: (work) => {
			symlinkSync("../../../README.md", join(work, ".pi/extensions/gitjig/linked.ts"));
		},
	});
	const insideBefore = snapshot(insideModule.target);
	refused(launch(insideModule), "snapshot-identity-mismatch", 65, "a tracked link inside the module population");
	invariant(insideModule, insideBefore, "a tracked link inside the module population");
	for (const { args, offenders } of readFileSync(join(insideModule.root, "git-env.log.modes.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { args: string; offenders: [string, string, number][] }))
		assert.deepEqual(offenders, [], `a tracked link was created before the refusal: ${args}`);
	// An acquired entry another user owns: the harness reports another owner for the snapshot.
	const foreign = fixture(launcher);
	const foreignBefore = snapshot(foreign.target);
	refused(
		launchWith(
			foreign,
			"",
			"const lstat = fs.lstatSync; fs.lstatSync = (path, ...rest) => { const stats = lstat(path, ...rest); return stats && /gitjig-acquire-[^/]+\\/snapshot\\//.test(String(path)) ? Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid: stats.uid + 1 }) : stats; }; syncBuiltinESMExports();",
		),
		"snapshot-identity-mismatch",
		65,
		"a foreign-owned artifact",
	);
	invariant(foreign, foreignBefore, "a foreign-owned artifact");
	// The child created at another mode than the relation's.
	const loose = fixture(launcher);
	const looseBefore = snapshot(loose.target);
	refused(
		launchWith(
			loose,
			"",
			"const mkdtemp = fs.mkdtempSync; fs.mkdtempSync = (...args) => { const made = mkdtemp(...args); fs.chmodSync(made, 0o755); return made; }; syncBuiltinESMExports();",
		),
		"temporary-storage-unavailable",
		73,
		"a child created at another mode",
	);
	invariant(loose, looseBefore, "a child created at another mode");
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
			"await new Promise((resolve) => setTimeout(resolve, 30000));\n",
			"nodeTimeoutMs: 500",
		],
	] as const) {
		const f = fixture(launcher, {
			source: (work) => writeFileSync(join(work, ".pi/extensions/gitjig/install/provision-cli.ts"), body),
		});
		const started = Date.now();
		refused(seams === "" ? launch(f) : launchWith(f, seams), "provision-refused", 70, label);
		// As with the Git bound: this child never ends on its own, so the elapsed time
		// is the deadline that was actually applied.
		if (label === "a provision past its bound")
			assert.ok(
				Date.now() - started < 4000,
				`${label}: the applied deadline was not the narrowed one (${Date.now() - started} ms)`,
			);
		assert.deepEqual(readdirSync(f.scratch), [], `${label}: the child was not removed`);
	}
	// Cleanup that cannot confirm absence overrides success and every other cause.
	const kept = fixture(launcher);
	refused(launchWith(kept, "remove: () => {}"), "cleanup-failed", 74, "a success whose cleanup failed");
	const both = fixture(launcher, {
		source: (work) => writeFileSync(join(work, ".pi/extensions/gitjig/install/provision-cli.ts"), "process.exit(2);\n"),
	});
	refused(launchWith(both, "remove: () => {}"), "cleanup-failed", 74, "a refusal whose cleanup failed");
	// Exercise every other post-creation cause with cleanup deliberately failing,
	// not just success and provision-refused. These cases retain artifacts by design.
	for (const [label, options, prelude] of [
		["source-unavailable", { plan: { fetch: "signal" as const } }, ""],
		["snapshot-identity-mismatch", { plan: { attached: true } }, ""],
		[
			"temporary-storage-unavailable",
			{},
			"const mkdtemp = fs.mkdtempSync; fs.mkdtempSync = (...args) => { const made = mkdtemp(...args); fs.chmodSync(made, 0o755); return made; }; syncBuiltinESMExports();",
		],
	] as const) {
		const simultaneous = fixture(launcher, options);
		const before = snapshot(simultaneous.target);
		refused(launchWith(simultaneous, "remove: () => {}", prelude), "cleanup-failed", 74, `cleanup overriding ${label}`);
		assert.equal(snapshot(simultaneous.target), before, `cleanup overriding ${label}: the target changed`);
		assert.equal(existsSync(simultaneous.record), false, `cleanup overriding ${label}: provision ran`);
		assert.equal(
			readdirSync(simultaneous.scratch).length,
			1,
			`cleanup overriding ${label}: the retained artifact was not observed`,
		);
	}
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
	// The fallback relation, row by row: an error no node names, at each stage.
	const unknown = fixture(launcher);
	const unknownBefore = snapshot(unknown.target);
	refused(
		launchWith(unknown, `launcherPath: ${JSON.stringify(join(unknown.target, ".github/bin/absent.mjs"))}`),
		"invalid-input",
		64,
		"an unknown admission error",
	);
	invariant(unknown, unknownBefore, "an unknown admission error");
	// After creation, before identity: the owned config already exists, so its exclusive create throws.
	const preIdentity = fixture(launcher);
	const preIdentityBefore = snapshot(preIdentity.target);
	refused(
		launchWith(
			preIdentity,
			"",
			'const mkdtemp = fs.mkdtempSync; fs.mkdtempSync = (...args) => { const made = mkdtemp(...args); fs.writeFileSync(`${made}/gitconfig`, "[core]\\n"); return made; }; syncBuiltinESMExports();',
		),
		"snapshot-identity-mismatch",
		65,
		"a pre-identity error",
	);
	invariant(preIdentity, preIdentityBefore, "a pre-identity error");
	// After identity: the provision spawn returns something that is not a child.
	const postIdentity = fixture(launcher);
	refused(
		launchWith(
			postIdentity,
			"nodeTimeoutMs: 2000, spawn: (file, args, options) => (file === process.execPath ? {} : realSpawn(file, args, options))",
			FAKE_CHILD,
		),
		"provision-refused",
		70,
		"a post-identity error",
	);
	assert.deepEqual(readdirSync(postIdentity.scratch), [], "a post-identity error: the child was not removed");
	// A removal that throws is still a cleanup that did not confirm absence.
	const throwingRemove = fixture(launcher);
	refused(
		launchWith(throwingRemove, 'remove: () => { throw new Error("EBUSY"); }'),
		"cleanup-failed",
		74,
		"a removal that threw",
	);
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

// ---------------------------------------------------------------------------
// The child-outcome relation: every way a bounded child ends, at its node's cause.

/**
 * A child that never ran a process: it reports exactly the events given. Its
 * pid is above any platform's pid range, so a group signal to it reaches nothing.
 */
const FAKE_CHILD = [
	'const { spawn: realSpawn } = await import("node:child_process");',
	'const { EventEmitter } = await import("node:events");',
	'const { PassThrough, Writable } = await import("node:stream");',
	"const fake = (events) => { const child = new EventEmitter(); child.pid = 2 ** 22 + 7; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new Writable({ write: (_c, _e, done) => done() }); child.kill = () => true; setImmediate(() => events(child)); return child; };",
].join("\n");

/** The provision child replaced by a fake that plays `events`; every Git child is real. */
const provisionPlays = (events: string) =>
	`spawn: (file, args, options) => (file === process.execPath ? fake(${events}) : realSpawn(file, args, options))`;

async function armMapsEveryChildOutcome(launcher: string): Promise<void> {
	// Output past the bound fails the child even when it then exits 0, on either stream.
	for (const stream of ["stdout", "stderr"] as const) {
		const f = fixture(launcher);
		refused(
			launchWith(
				f,
				`streamBytes: 1024, ${provisionPlays(`(child) => { child.${stream}.write("x".repeat(2048)); setTimeout(() => child.emit("close", 0, null), 100); }`)}`,
				FAKE_CHILD,
			),
			"provision-refused",
			70,
			`an overflowing ${stream} that exits 0`,
		);
		assert.deepEqual(readdirSync(f.scratch), [], `an overflowing ${stream}: the child was not removed`);
	}
	// A spawn that fails asynchronously: its error event, at the node's cause.
	const erring = fixture(launcher);
	refused(
		launchWith(
			erring,
			provisionPlays(
				'(child) => { child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })); child.emit("close", -2, null); }',
			),
			FAKE_CHILD,
		),
		"provision-refused",
		70,
		"a provision that failed to spawn",
	);
	// And for real: no Git on the caller's PATH fails the first admission child.
	const gitless = fixture(launcher);
	const gitlessBefore = snapshot(gitless.target);
	refused(launch(gitless, { PATH: gitless.scratch }), "invalid-input", 64, "no Git on PATH");
	invariant(gitless, gitlessBefore, "no Git on PATH");
	// A spawn that throws synchronously: still the node's own cause.
	const throwing = fixture(launcher);
	refused(
		launchWith(
			throwing,
			'spawn: (file, args, options) => { if (args.includes("init")) throw new Error("spawn EAGAIN"); return realSpawn(file, args, options); }',
			FAKE_CHILD,
		),
		"source-unavailable",
		69,
		"a Git spawn that threw",
	);
	// A child holding a grandchild: the bound ends the whole group, not just the child.
	let pidFile = "";
	const holding = fixture(launcher, {
		source: (work) => {
			pidFile = join(work, "..", "grandchild.pid");
			writeFileSync(
				join(work, ".pi/extensions/gitjig/install/provision-cli.ts"),
				[
					'import { spawn } from "node:child_process";',
					'import { writeFileSync } from "node:fs";',
					'const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "inherit" });',
					`writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
					"setInterval(() => {}, 1000);",
					"",
				].join("\n"),
			);
		},
	});
	assert.equal(
		realpathSync(join(pidFile, "..")),
		realpathSync(holding.root),
		"the PID artifact must belong to the fixture root",
	);
	const started = Date.now();
	try {
		refused(launchWith(holding, "nodeTimeoutMs: 1500"), "provision-refused", 70, "a provision holding a grandchild");
		assert.ok(Date.now() - started < 20_000, "the grandchild outlived the bound: the group was not ended");
		const grandchild = Number(readFileSync(pidFile, "utf8"));
		// The grandchild was killed with its group; its reaping by init may trail briefly.
		let alive = true;
		for (let tries = 0; alive && tries < 50; tries++) {
			try {
				process.kill(grandchild, 0);
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
			} catch {
				alive = false;
			}
		}
		assert.equal(alive, false, "the grandchild survived the bound");
	} finally {
		rmSync(pidFile, { force: true });
	}
	// Each child's stdin is closed, so a child that reads it reaches end of file.
	const reading = fixture(launcher, { plan: { readsStdin: true } });
	const readingRun = launchWith(reading, "gitTimeoutMs: 10000");
	assert.equal(
		readingRun.status,
		0,
		`a child reading its stdin did not end (stderr ${JSON.stringify(readingRun.stderr)})`,
	);
}

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
	armExcludesAlternateObjectStores,
	armConfirmsTheClosure,
	armOrdersTheTerminals,
	armOwnsEveryArtifact,
	armMapsEveryChildOutcome,
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
	const before = readFileSync(FAULTS, "utf8");
	await assert.rejects(
		() => arm(mutant(from, to)),
		(error: unknown) => {
			assert.ok(error instanceof assert.AssertionError, `${named}: the arm failed for another reason: ${error}`);
			// A seam that broke under the mutant proves nothing about the property.
			assert.equal(
				readFileSync(FAULTS, "utf8"),
				before,
				`${named}: the arm red on a harness fault, not on its own property`,
			);
			return true;
		},
		`${named}: the owner arm still passed`,
	);
}

test(
	"#362: baseline-first private-copy mutants, each killed by the arm that owns it",
	{ timeout: 1_800_000 },
	async () => {
		// Pre-reread execution: provision before the closure is confirmed.
		await killed(
			armConfirmsTheClosure,
			'\tif (!head.has(ENTRY)) refuse("snapshot-identity-mismatch");\n',
			"",
			"execution without the fixed entry",
		);
		// The subtree walk's final branch — an entry that is neither a regular file
		// nor a directory — has no mutant, and that is a measured statement rather than
		// an omission: with `core.symlinks=false` on every Git invocation, no child of
		// this contract can create such an entry, so removing the branch changes no
		// observable outcome and any reported kill would be one no arm witnessed. It
		// stays as a fail-closed residual over a creator the relation does not admit.
		assert.ok(
			readFileSync(LAUNCHER, "utf8").includes('\t\t} else refuse("snapshot-identity-mismatch");'),
			"the subtree walk's fail-closed branch is gone, so its residual statement is stale",
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
			'\tconst git = (/** @type {string} */ globalConfig) => ({\n\t\tPATH: read.PATH ?? "",',
			'\tconst git = (/** @type {string} */ globalConfig) => ({\n\t\t...process.env,\n\t\tPATH: read.PATH ?? "",',
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
			'\t\tif (!cleanup(acquired.child, seams)) cause = "cleanup-failed";\n',
			"\t\tcleanup(acquired.child, seams);\n",
			"cleanup not confirmed",
		);
		await killed(
			armSucceedsExactly,
			'\t\tif (!cleanup(acquired.child, seams)) cause = "cleanup-failed";\n',
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
		// Round 12c's alternates row: each call site, and each of the helper's two
		// decisions, refuses something no other statement does.
		await killed(armAdmitsOnlyTheCommittedPin, "name.length === 0 || ", "", "an empty routing name admitted");
		await killed(
			armAdmitsOnlyTheCommittedPin,
			'\t\tif (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_PIN_BYTES) refuse("invalid-input");\n\t\tconst bytes = Buffer.alloc(MAX_PIN_BYTES + 1);\n\t\tlet length = 0;\n\t\tfor (;;) {\n\t\t\tconst read = readSync(descriptor, bytes, length, bytes.length - length, null);\n\t\t\tif (read === 0) break;\n\t\t\tlength += read;\n\t\t\tif (length > MAX_PIN_BYTES) refuse("invalid-input");\n\t\t}\n\t\tconst after = lstatSync(pathname);\n\t\tconst descriptorAfter = fstatSync(descriptor);\n\t\tif (after.dev !== before.dev || after.ino !== before.ino) refuse("invalid-input");\n',
			'\t\tif (opened.size > MAX_PIN_BYTES) refuse("invalid-input");\n\t\tconst bytes = Buffer.alloc(MAX_PIN_BYTES + 1);\n\t\tlet length = 0;\n\t\tfor (;;) {\n\t\t\tconst read = readSync(descriptor, bytes, length, bytes.length - length, null);\n\t\t\tif (read === 0) break;\n\t\t\tlength += read;\n\t\t\tif (length > MAX_PIN_BYTES) refuse("invalid-input");\n\t\t}\n\t\tconst after = lstatSync(pathname);\n\t\tconst descriptorAfter = fstatSync(descriptor);\n',
			"both before-open identity comparisons removed (each decides the pre-open swap alone)",
		);
		await killed(
			armAdmitsOnlyTheCommittedPin,
			'new TextDecoder("utf-8", { fatal: true })',
			'new TextDecoder("utf-8", { fatal: false })',
			"invalid pin bytes decoded with replacement",
		);
		// Governed round 2's locale: each profile fixes LC_ALL rather than forwarding it.
		// The mask the created children inherit, read where they are created.
		await killed(
			armOwnsEveryArtifact,
			"\tprocess.umask(0o077);\n",
			"\tprocess.umask(0o022);\n",
			"a child created under a group- and world-readable mask",
		);
		// A tracked link materialized as a link, and the owned config created at
		// another mode and normalized before any Git child could observe it.
		await killed(
			armOwnsEveryArtifact,
			'\t"-c",\n\t"core.symlinks=false",\n',
			"",
			"a tracked link checked out as a link",
		);
		await killed(
			armOwnsEveryArtifact,
			'\twriteFileSync(config, "", { mode: 0o600, flag: "wx" });\n',
			'\tprocess.umask(0o022);\n\twriteFileSync(config, "", { mode: 0o644, flag: "wx" });\n\tchmodSync(config, 0o600);\n\tprocess.umask(0o077);\n',
			"the owned config created readable and normalized before Git",
		);
		await killed(
			armAdmitsOnlyTheCommittedPin,
			'typeof value.revision !== "string" || ',
			"",
			"a revision admitted by its pattern alone",
		);
		// Normalization belongs to the node whose child created the entry, before its
		// successor runs: moved past the snapshot check's first call, everything is
		// still normalized, and only an observation taken at that call can see it.
		await killed(
			armOwnsEveryArtifact,
			'\townedSubtree(child, uid);\n\t// snapshot-check\n\tconst shown = async (/** @type {string[]} */ args) =>\n\t\tline(await git(["-C", destination, ...args], "snapshot-identity-mismatch"));\n\tconst real = realpathSync(destination);\n\tconst commonDir = realpathSync(resolve(destination, await shown(["rev-parse", "--git-common-dir"])));\n',
			'\t// snapshot-check\n\tconst shown = async (/** @type {string[]} */ args) =>\n\t\tline(await git(["-C", destination, ...args], "snapshot-identity-mismatch"));\n\tconst real = realpathSync(destination);\n\tconst commonDir = realpathSync(resolve(destination, await shown(["rev-parse", "--git-common-dir"])));\n\townedSubtree(child, uid);\n',
			"normalization deferred past the node's first successor call",
		);
		// A database reached through a linked `.git`, and a directory created public
		// and normalized before any Git child could observe it.
		await killed(
			armExcludesAlternateObjectStores,
			"\tif (!own || !own.isDirectory() || own.isSymbolicLink()) refuse(cause);\n",
			"",
			"a target database reached through a link",
		);
		await killed(
			armOwnsEveryArtifact,
			'\tawait git(["init", "-q", "--template=", "--", destination], "source-unavailable");\n',
			'\tconst { mkdirSync } = await import("node:fs");\n\tprocess.umask(0o022);\n\tmkdirSync(destination, { mode: 0o755 });\n\tchmodSync(destination, 0o700);\n\tprocess.umask(0o077);\n\tawait git(["init", "-q", "--template=", "--", destination], "source-unavailable");\n',
			"a directory created public and normalized before Git",
		);
		// The snapshot subtree's own root is a created directory too.
		await killed(
			armOwnsEveryArtifact,
			'\tawait git(["init", "-q", "--template=", "--", destination], "source-unavailable");\n',
			'\tawait git(["init", "-q", "--template=", "--", destination], "source-unavailable");\n\tchmodSync(destination, 0o755);\n',
			"the snapshot root left group- and world-readable",
		);
		// Every snapshot-check Git child carries that node's own cause.
		await killed(
			armSourcesOnlyTheProjection,
			'line(await git(["-C", destination, ...args], "snapshot-identity-mismatch"));',
			'line(await git(["-C", destination, ...args], "source-unavailable"));',
			"a failing snapshot-check child misnamed as an unavailable source",
		);
		// The deadline that is applied, not merely the one exported.
		await killed(
			armSourcesOnlyTheProjection,
			"const timer = setTimeout(kill, timeoutMs);",
			"const timer = setTimeout(kill, timeoutMs * 10);",
			"a Git child's applied deadline widened tenfold",
		);
		await killed(
			armOrdersTheTerminals,
			"const timer = setTimeout(kill, timeoutMs);",
			"const timer = setTimeout(kill, timeoutMs * 10);",
			"the provision child's applied deadline widened tenfold",
		);
		// The same mask loosened around one child only, and restored before the
		// normalization: every provision-time mode is still exact, so only an
		// observation taken at the creating child can refuse it.
		await killed(
			armOwnsEveryArtifact,
			'\tawait git(["-C", destination, "fetch", "-q", "--no-tags", "--depth=1", "origin", pin.revision], "source-unavailable");\n',
			'\tprocess.umask(0o022);\n\tawait git(["-C", destination, "fetch", "-q", "--no-tags", "--depth=1", "origin", pin.revision], "source-unavailable");\n\tprocess.umask(0o077);\n',
			"the mask loosened for the fetch alone",
		);
		// A variable the platform adds too, with another value: a name-only
		// subtraction hides it on a host that adds that name, and a host that does
		// not add it refuses the extra name instead. Either way the arm decides.
		await killed(
			armBuildsEachChildEnvironment,
			'\t\tGIT_TERMINAL_PROMPT: "0",\n\t});',
			'\t\tGIT_TERMINAL_PROMPT: "0",\n\t\t__CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",\n\t});',
			"a Git child given a platform-named variable of another value",
		);
		await killed(
			armBuildsEachChildEnvironment,
			'\t\tLC_ALL: "C",\n\t\tGIT_CONFIG_NOSYSTEM: "1",',
			'\t\tLC_ALL: read.LC_ALL ?? "C",\n\t\tGIT_CONFIG_NOSYSTEM: "1",',
			"a Git child given the caller's locale",
		);
		await killed(
			armBuildsEachChildEnvironment,
			'node: { PATH: read.PATH ?? "", LC_ALL: "C", HOME: read.HOME ?? "" },',
			'node: { PATH: read.PATH ?? "", LC_ALL: read.LC_ALL ?? "C", HOME: read.HOME ?? "" },',
			"the provision child given the caller's locale",
		);
		await killed(
			armExcludesAlternateObjectStores,
			'\trefuseAlternates(join(top, ".git"), "invalid-input");\n',
			"",
			"the target's own declaration never read",
		);
		await killed(
			armExcludesAlternateObjectStores,
			'\trefuseAlternates(commonDir, "snapshot-identity-mismatch");\n',
			"",
			"the created store's declaration never read",
		);
		await killed(
			armExcludesAlternateObjectStores,
			"\tif (declared !== undefined) refuse(cause);\n",
			"",
			"a declared alternate store admitted",
		);
		await killed(
			armExcludesAlternateObjectStores,
			"\t\trefuse(cause);\n\t}\n\tif (declared !== undefined) refuse(cause);",
			"\t\tdeclared = undefined;\n\t}\n\tif (declared !== undefined) refuse(cause);",
			"an unreadable declaration taken as an absent one",
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
		// The refusal sweep's distinct survivors, each by its owning arm.
		await killed(
			armAdmitsOnlyTheCommittedPin,
			'\tif (realpathSync(shownTop) !== realpathSync(top)) refuse("invalid-input");\n',
			"",
			"another toplevel admitted",
		);
		await killed(
			armAdmitsOnlyTheCommittedPin,
			'\t\tif (!parent.isDirectory() || parent.isSymbolicLink()) refuse("invalid-input");\n',
			"",
			"a linked .pi admitted",
		);
		await killed(
			armAdmitsOnlyTheCommittedPin,
			'\tif (!launcherStats.isFile() || launcherStats.isSymbolicLink()) refuse("invalid-input");\n',
			"",
			"a linked launcher path admitted",
		);
		await killed(armConfirmsTheClosure, "!isInside(commonDir, real) || ", "", "another common directory admitted");
		await killed(armConfirmsTheClosure, " || workTree !== real) refuse", ") refuse", "another work tree admitted");
		await killed(
			armConfirmsTheClosure,
			'\tif ((await shown(["rev-parse", "HEAD"])) !== pin.revision) refuse("snapshot-identity-mismatch");\n',
			"",
			"another revision admitted",
		);
		await killed(
			armOwnsEveryArtifact,
			'\t\tif (uid !== undefined && stats.uid !== uid) refuse("snapshot-identity-mismatch");\n',
			"",
			"a foreign-owned artifact admitted",
		);
		await killed(
			armOwnsEveryArtifact,
			"\t\t(created.mode & 0o777) !== 0o700\n",
			"\t\tfalse\n",
			"a child at another mode admitted",
		);
		// Round 11: all artifacts, including the config sibling, and each cleanup cause.
		await killed(
			armOwnsEveryArtifact,
			"\townedSubtree(child, uid);",
			"\townedSubtree(child, uid);\n\tchmodSync(config, 0o644);",
			"a non-private owned config",
		);
		for (const cause of [
			"source-unavailable",
			"snapshot-identity-mismatch",
			"temporary-storage-unavailable",
			"provision-refused",
		])
			await killed(
				armOrdersTheTerminals,
				'\t\tif (!cleanup(acquired.child, seams)) cause = "cleanup-failed";',
				`\t\tif (!cleanup(acquired.child, seams) && cause !== "${cause}") cause = "cleanup-failed";`,
				`cleanup failed to override ${cause}`,
			);
		// Round 10: population, owned-empty config and Git metadata invariance.
		await killed(
			armConfirmsTheClosure,
			'\tif (working.size !== head.size || ![...working].every((path) => head.has(path))) refuse("snapshot-identity-mismatch");\n',
			"",
			"a working member omitted from HEAD's listed population",
		);
		await killed(
			armBuildsEachChildEnvironment,
			'writeFileSync(config, "",',
			'writeFileSync(config, "[user]\\nname=intruder\\n",',
			"a nonempty owned global config",
		);
		await killed(
			armSourcesOnlyTheProjection,
			"\tconst pin = projection(admitPin(top, headBlob));",
			'\tconst pin = projection(admitPin(top, headBlob));\n\twriteFileSync(join(top, ".git/config"), "\\n# unintended write\\n", { flag: "a" });',
			"target Git metadata changed on refusal",
		);
		// Round 9: closed child ownership and literal source spelling.
		await killed(
			armSucceedsExactly,
			"\tconst head = new Map();",
			'\tawait shown(["rev-parse", "HEAD"]);\n\tconst head = new Map();',
			"an unowned closure Git child",
		);
		await killed(
			armSourcesOnlyTheProjection,
			"${pin.owner}/${pin.repository}",
			'${pin.owner}/${pin.repository.replace(/\\.git$/, "")}',
			"a literal repository suffix stripped",
		);
		// No historical shell-key exceptions: the seam is Node, not a shell.
		for (const key of ["PWD", "SHLVL", "_", "OLDPWD"])
			await killed(
				armBuildsEachChildEnvironment,
				'\tconst git = (/** @type {string} */ globalConfig) => ({\n\t\tPATH: read.PATH ?? "",',
				`\tconst git = (/** @type {string} */ globalConfig) => ({\n\t\t${key}: "injected",\n\t\tPATH: read.PATH ?? "",`,
				`an unlisted ${key} given to Git`,
			);
		// Round 7: pin-open's one-link requirement stands independently.
		await killed(armAdmitsOnlyTheCommittedPin, "opened.nlink !== 1 || ", "", "a multiply-linked pin admitted");
		// Round 6: the child-outcome relation, row by row.
		await killed(
			armMapsEveryChildOutcome,
			'\t\tchild.on("error", () => {\n\t\t\tclearTimeout(timer);\n\t\t\trejectRun(new Refusal(cause));\n\t\t});\n',
			"",
			"a spawn error left unhandled",
		);
		await killed(
			armMapsEveryChildOutcome,
			"\t\t} catch {\n\t\t\trejectRun(new Refusal(cause));\n\t\t\treturn;\n\t\t}",
			"\t\t} catch {}",
			"a synchronous spawn failure left to the fallback",
		);
		await killed(
			armMapsEveryChildOutcome,
			"if (failed || signal",
			"if (signal",
			"an overflow forgiven by a clean exit",
		);
		await killed(
			armMapsEveryChildOutcome,
			"if (counts[name] > seams.streamBytes) kill();",
			'if (name === "stdout" && counts[name] > seams.streamBytes) kill();',
			"stderr left unbounded",
		);
		await killed(
			armMapsEveryChildOutcome,
			'process.kill(-(/** @type {number} */ (child.pid)), "SIGKILL");',
			'child.kill("SIGKILL");',
			"only the child ended",
		);
		await killed(armMapsEveryChildOutcome, "detached: true", "detached: false", "a child in the launcher's own group");
		await killed(armMapsEveryChildOutcome, "\t\tchild.stdin.end();\n", "", "a child's stdin left open");
		// The second sweep: fallbacks, cleanup, profile values and exact source argv.
		await killed(
			armOrdersTheTerminals,
			'cause = error instanceof Refusal ? error.refusal : "invalid-input";',
			'cause = error instanceof Refusal ? error.refusal : "temporary-storage-unavailable";',
			"an unknown admission error misnamed",
		);
		await killed(
			armOrdersTheTerminals,
			'acquired.confirmed\n\t\t\t\t\t\t? "provision-refused"\n\t\t\t\t\t\t: "snapshot-identity-mismatch"',
			'"provision-refused"',
			"a pre-identity error misnamed",
		);
		await killed(
			armOrdersTheTerminals,
			'acquired.confirmed\n\t\t\t\t\t\t? "provision-refused"\n\t\t\t\t\t\t: "snapshot-identity-mismatch"',
			'"snapshot-identity-mismatch"',
			"a post-identity error misnamed",
		);
		await killed(armOrdersTheTerminals, "\tstate.confirmed = true;\n", "", "identity never recorded");
		await killed(armOrdersTheTerminals, 'flag: "wx"', 'flag: "w"', "an existing owned config reused");
		await killed(
			armOrdersTheTerminals,
			"\t\tseams.remove(child);\n\t} catch {}",
			"\t\tseams.remove(child);\n\t} finally {}",
			"a throwing removal escaped",
		);
		await killed(
			armBuildsEachChildEnvironment,
			'node: { PATH: read.PATH ?? ""',
			'node: { PATH: "/usr/bin:/bin"',
			"the provision child's PATH replaced",
		);
		await killed(
			armBuildsEachChildEnvironment,
			'GIT_TERMINAL_PROMPT: "0"',
			'GIT_TERMINAL_PROMPT: "1"',
			"Git allowed to prompt",
		);
		await killed(
			armBuildsEachChildEnvironment,
			'GIT_CONFIG_NOSYSTEM: "1"',
			'GIT_CONFIG_NOSYSTEM: "0"',
			"the system config read",
		);
		await killed(armSourcesOnlyTheProjection, '"--depth=1",', "", "the whole history fetched");
		await killed(armSourcesOnlyTheProjection, '"--no-tags",', "", "tags fetched");
		await killed(armSourcesOnlyTheProjection, '"--template=",', "", "a template installed");
		// Round 5's boundary.
		await killed(
			armConfirmsTheClosure,
			'\tif ((await shown(["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"])) !== "")\n\t\trefuse("snapshot-identity-mismatch");\n',
			"",
			"a dirty snapshot admitted",
		);
		// The bounds.
		await killed(armPinsTheBounds, "gitTimeoutMs: 120000", "gitTimeoutMs: 1200000", "a widened Git bound");
	},
);

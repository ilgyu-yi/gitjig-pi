#!/usr/bin/env node
/**
 * The handed first-clone acquisition launcher (#362).
 *
 * It implements the product contract's closed acquisition relations (#363),
 * node by node, in their process order: argv admission,
 * self-location, the target-admission pin read and pin admission, the one
 * temporary child, the source fetch, the snapshot check, the closure check,
 * the provision run, cleanup, and the terminal. Every refusal is the cause of
 * the node it occurs at (the node relation), or the fallback relation's
 * cause where no node owns an error, and a cleanup that cannot confirm absence
 * overrides every post-creation cause.
 *
 * It is self-standing: Node's built-ins only, so it runs from target history
 * before any carried runtime exists, invoked as the activation relation names
 * it. What the caller's invocation does before or beneath these bytes is the
 * residual relation's caller-held part, not guaranteed here.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The limits relation's values. */
export const LIMITS = Object.freeze({ gitTimeoutMs: 120000, nodeTimeoutMs: 300000, streamBytes: 1048576 });
/** The terminal relation. */
export const STATUS = Object.freeze({
	"invalid-input": 64,
	"snapshot-identity-mismatch": 65,
	"source-unavailable": 69,
	"provision-refused": 70,
	"temporary-storage-unavailable": 73,
	"cleanup-failed": 74,
});
const PIN = ".pi/gitjig.pin.json";
const ENTRY = ".pi/extensions/gitjig/install/provision-cli.ts";
const SCOPE_FILE = ".pi/extensions/gitjig.ts";
const SCOPE_DIR = ".pi/extensions/gitjig";
const MAX_PIN_BYTES = 1048576;

class Refusal extends Error {
	/** @param {keyof typeof STATUS} cause */
	constructor(cause) {
		super(cause);
		this.refusal = cause;
	}
}
/** @param {keyof typeof STATUS} cause @returns {never} */
const refuse = (cause) => {
	throw new Refusal(cause);
};

/**
 * One child under its limits-relation row, in its own process group. Every
 * outcome the child-outcome relation names is the calling node's cause, and
 * the child's output stays with the launcher, never reaching the terminal.
 */
function bounded(seams, executable, args, { env, cwd, timeoutMs, cause }) {
	return new Promise((resolveRun, rejectRun) => {
		let child;
		try {
			child = seams.spawn(executable, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
		} catch {
			rejectRun(new Refusal(cause));
			return;
		}
		const chunks = [];
		const counts = { stdout: 0, stderr: 0 };
		let failed = false;
		const kill = () => {
			failed = true;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				try {
					child.kill("SIGKILL");
				} catch {}
			}
		};
		const timer = setTimeout(kill, timeoutMs);
		const take = (stream, name) =>
			stream.on("data", (chunk) => {
				counts[name] += chunk.length;
				if (counts[name] > seams.streamBytes) kill();
				else if (name === "stdout") chunks.push(chunk);
			});
		take(child.stdout, "stdout");
		take(child.stderr, "stderr");
		child.stdin.on("error", () => {});
		child.stdin.end();
		child.on("error", () => {
			clearTimeout(timer);
			rejectRun(new Refusal(cause));
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (failed || signal !== null || code !== 0) rejectRun(new Refusal(cause));
			else resolveRun(Buffer.concat(chunks));
		});
	});
}

/** The environment relation's profiles, built from their rows alone. */
function profiles(read, ownedConfig) {
	const git = (globalConfig) => ({
		PATH: read.PATH ?? "",
		LC_ALL: "C",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: globalConfig,
		GIT_TERMINAL_PROMPT: "0",
	});
	return {
		"git-admission": git(devNull),
		git: git(ownedConfig),
		node: { PATH: read.PATH ?? "", LC_ALL: "C", HOME: read.HOME ?? "" },
	};
}

/** The git profile's config rows, plus the exclusions it can state per command. */
const GIT_CONFIG = [
	"-c",
	"credential.helper=",
	"-c",
	`core.hooksPath=${devNull}`,
	"-c",
	"http.followRedirects=false",
	"-c",
	"protocol.file.allow=never",
	"-c",
	"core.fileMode=false",
	"--no-replace-objects",
];

const isInside = (child, parent) => child === parent || child.startsWith(parent + sep);

/** Git's own output with its one line terminator removed: a path may end in a space. */
const line = (bytes) => bytes.toString("utf8").replace(/\n$/, "");

/** @param {Buffer} bytes */
function projection(bytes) {
	let value;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		refuse("invalid-input");
	}
	const own = (object, key) => Object.hasOwn(object, key);
	if (typeof value !== "object" || value === null || Array.isArray(value)) refuse("invalid-input");
	if (!own(value, "schemaVersion") || value.schemaVersion !== 1) refuse("invalid-input");
	const source = own(value, "source") ? value.source : undefined;
	if (typeof source !== "object" || source === null || Array.isArray(source)) refuse("invalid-input");
	if (Object.keys(source).sort().join(",") !== "host,owner,provider,repository") refuse("invalid-input");
	if (source.provider !== "github" || source.host !== "github.com") refuse("invalid-input");
	for (const name of [source.owner, source.repository])
		if (typeof name !== "string" || name.length === 0 || name.normalize("NFC") !== name || /[\p{Cc}/%]/u.test(name))
			refuse("invalid-input");
	if (!own(value, "revision") || typeof value.revision !== "string" || !/^[0-9a-f]{40}$/.test(value.revision))
		refuse("invalid-input");
	return { owner: source.owner, repository: source.repository, revision: value.revision };
}

/** Pin admission: the committed pin's bytes, read once under identity checks. */
function admitPin(top, headBlob) {
	const ancestor = join(top, ".pi");
	const pathname = join(top, PIN);
	let before;
	try {
		const parent = lstatSync(ancestor);
		if (!parent.isDirectory() || parent.isSymbolicLink()) refuse("invalid-input");
		before = lstatSync(pathname);
	} catch (error) {
		if (error instanceof Refusal) throw error;
		refuse("invalid-input");
	}
	if (!before.isFile() || before.isSymbolicLink()) refuse("invalid-input");
	let descriptor;
	try {
		descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		refuse("invalid-input");
	}
	try {
		const opened = fstatSync(descriptor);
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		if (!opened.isFile() || opened.nlink !== 1 || (uid !== undefined && opened.uid !== uid)) refuse("invalid-input");
		if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_PIN_BYTES) refuse("invalid-input");
		const bytes = Buffer.alloc(MAX_PIN_BYTES + 1);
		let length = 0;
		for (;;) {
			const read = readSync(descriptor, bytes, length, bytes.length - length, null);
			if (read === 0) break;
			length += read;
			if (length > MAX_PIN_BYTES) refuse("invalid-input");
		}
		const after = lstatSync(pathname);
		const descriptorAfter = fstatSync(descriptor);
		if (after.dev !== before.dev || after.ino !== before.ino) refuse("invalid-input");
		if (descriptorAfter.dev !== after.dev || descriptorAfter.ino !== after.ino) refuse("invalid-input");
		const read = bytes.subarray(0, length);
		if (!read.equals(headBlob)) refuse("invalid-input");
		return read;
	} finally {
		closeSync(descriptor);
	}
}

/** Normalize every created entry to the artifact relation's modes; any link refuses. */
function ownedSubtree(root, uid) {
	const visit = (path) => {
		const stats = lstatSync(path);
		if (uid !== undefined && stats.uid !== uid) refuse("snapshot-identity-mismatch");
		if (stats.isDirectory()) {
			if ((stats.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
			for (const name of readdirSync(path)) visit(join(path, name));
		} else if (stats.isFile()) {
			if ((stats.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
			// A link, or anything else, is neither: the artifact relation admits none.
		} else refuse("snapshot-identity-mismatch");
	};
	visit(root);
}

/**
 * The acquisition, node by node. `seams` carries the limits relation's values
 * and the spawn and temporary-base primitives; the command line always passes
 * the defaults, and a test imports this module to narrow them.
 */
export async function acquire(argv, read, seams) {
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	// argv-admission
	if (argv.length !== 0) refuse("invalid-input");
	// self-location: the target top is derived from the launcher's own physical path.
	const launcher = seams.launcherPath;
	const launcherStats = lstatSync(launcher);
	if (!launcherStats.isFile() || launcherStats.isSymbolicLink()) refuse("invalid-input");
	const top = resolve(dirname(launcher), "..", "..");
	const admission = profiles(read, devNull)["git-admission"];
	const admissionGit = (args) =>
		bounded(seams, "git", [...GIT_CONFIG, "-C", top, ...args], {
			env: admission,
			cwd: top,
			timeoutMs: seams.gitTimeoutMs,
			cause: "invalid-input",
		});
	// pin-read
	const shownTop = line(await admissionGit(["rev-parse", "--show-toplevel"]));
	if (realpathSync(shownTop) !== realpathSync(top)) refuse("invalid-input");
	// HEAD's own tree entry: the committed pin, whatever the index now holds.
	const tracked = (await admissionGit(["ls-tree", "-z", "HEAD", "--", PIN])).toString("utf8").replace(/\0$/, "");
	const trackedEntry = /^100(644|755) blob (?:[0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/s.exec(tracked);
	if (trackedEntry === null || trackedEntry[2] !== PIN) refuse("invalid-input");
	const headBlob = await admissionGit(["cat-file", "blob", `HEAD:${PIN}`]);
	// pin-admission
	const pin = projection(admitPin(top, headBlob));
	const sourceUrl = `https://github.com/${pin.owner}/${pin.repository}`;
	// temporary-create
	// Every error before the child exists is the fallback relation's
	// pre-creation temporary error, whichever step raised it.
	let child;
	try {
		const base = realpathSync(seams.temporaryBase());
		const baseStats = lstatSync(base, { throwIfNoEntry: false });
		if (!isAbsolute(base) || !baseStats || !baseStats.isDirectory() || baseStats.isSymbolicLink())
			refuse("temporary-storage-unavailable");
		child = mkdtempSync(join(base, "gitjig-acquire-"));
	} catch {
		refuse("temporary-storage-unavailable");
	}
	return { child, top, pin, sourceUrl, uid, read, confirmed: false };
}

/** The post-creation nodes, run with cleanup owed from the first artifact. */
export async function acquireIn(state, seams) {
	const { child, top, pin, sourceUrl, uid, read } = state;
	// The created child itself, against the artifact relation's acquisition-child row.
	const created = lstatSync(child);
	if (
		!created.isDirectory() ||
		created.isSymbolicLink() ||
		(uid !== undefined && created.uid !== uid) ||
		(created.mode & 0o777) !== 0o700
	)
		refuse("temporary-storage-unavailable");
	const config = join(child, "gitconfig");
	writeFileSync(config, "", { mode: 0o600, flag: "wx" });
	const env = profiles(read, config);
	const destination = join(child, "snapshot");
	const git = (args, cause, cwd = child) =>
		bounded(seams, "git", [...GIT_CONFIG, ...args], { env: env.git, cwd, timeoutMs: seams.gitTimeoutMs, cause });
	// source-fetch: the projected source at the exact revision, nothing else.
	await git(["init", "-q", "--template=", "--", destination], "source-unavailable");
	await git(["-C", destination, "remote", "add", "origin", sourceUrl], "source-unavailable");
	await git(["-C", destination, "fetch", "-q", "--no-tags", "--depth=1", "origin", pin.revision], "source-unavailable");
	await git(["-C", destination, "checkout", "-q", "--detach", pin.revision], "source-unavailable");
	ownedSubtree(child, uid);
	// snapshot-check
	const shown = async (args) => line(await git(["-C", destination, ...args], "snapshot-identity-mismatch"));
	const real = realpathSync(destination);
	const commonDir = realpathSync(resolve(destination, await shown(["rev-parse", "--git-common-dir"])));
	const workTree = realpathSync(await shown(["rev-parse", "--show-toplevel"]));
	if (!isInside(commonDir, real) || workTree !== real) refuse("snapshot-identity-mismatch");
	if ((await shown(["rev-parse", "HEAD"])) !== pin.revision) refuse("snapshot-identity-mismatch");
	// Detached: `rev-parse --symbolic-full-name HEAD` prints `HEAD` itself only then.
	if ((await shown(["rev-parse", "--symbolic-full-name", "HEAD"])) !== "HEAD") refuse("snapshot-identity-mismatch");
	const origin = await shown(["remote", "get-url", "origin"]);
	if (origin !== sourceUrl && origin !== `${sourceUrl}.git`) refuse("snapshot-identity-mismatch");
	if ((await shown(["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"])) !== "")
		refuse("snapshot-identity-mismatch");
	// Still the snapshot check's Git children: HEAD's module population and the
	// repository's object format, which the closure check hashes against.
	const format = await shown(["rev-parse", "--show-object-format"]);
	if (format !== "sha1" && format !== "sha256") refuse("snapshot-identity-mismatch");
	const listed = (
		await git(
			["-C", destination, "ls-tree", "-r", "-z", "--full-tree", "HEAD", "--", SCOPE_FILE, SCOPE_DIR],
			"snapshot-identity-mismatch",
		)
	)
		.toString("utf8")
		.split("\0")
		.filter(Boolean);
	// closure-check: the launcher's own node, spawning nothing. The complete
	// module population, HEAD against working, byte for byte.
	const head = new Map();
	for (const line of listed) {
		const match = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/s.exec(line);
		if (match === null) refuse("snapshot-identity-mismatch");
		head.set(match[3], match[2]);
	}
	const working = new Set();
	const walk = (relative) => {
		const absolute = join(real, relative);
		const stats = lstatSync(absolute, { throwIfNoEntry: false });
		if (!stats || stats.isSymbolicLink()) refuse("snapshot-identity-mismatch");
		if (stats.isDirectory()) for (const name of readdirSync(absolute)) walk(`${relative}/${name}`);
		else if (stats.isFile()) working.add(relative);
		else refuse("snapshot-identity-mismatch");
	};
	if (lstatSync(join(real, ".pi"), { throwIfNoEntry: false })?.isSymbolicLink()) refuse("snapshot-identity-mismatch");
	if (lstatSync(join(real, ".pi/extensions"), { throwIfNoEntry: false })?.isSymbolicLink())
		refuse("snapshot-identity-mismatch");
	// The entry is one regular blob in HEAD and one regular file here, never a directory.
	const entryFile = lstatSync(join(real, SCOPE_FILE), { throwIfNoEntry: false });
	if (!head.has(SCOPE_FILE) || !entryFile?.isFile() || entryFile.isSymbolicLink()) refuse("snapshot-identity-mismatch");
	working.add(SCOPE_FILE);
	walk(SCOPE_DIR);
	if (working.size !== head.size || ![...working].every((path) => head.has(path))) refuse("snapshot-identity-mismatch");
	// Each working file's own bytes, hashed as Git names a blob: no filter, no conversion.
	for (const [path, oid] of head) {
		const bytes = readFileSync(join(real, path));
		const hashed = createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
		if (hashed !== oid) refuse("snapshot-identity-mismatch");
	}
	if (!head.has(ENTRY)) refuse("snapshot-identity-mismatch");
	state.confirmed = true;
	// provision-run: the confirmed fixed entry, under the existing verifier.
	await bounded(
		seams,
		process.execPath,
		[
			"--experimental-strip-types",
			join(real, ENTRY),
			"--target",
			top,
			"--source",
			sourceUrl,
			"--revision",
			pin.revision,
		],
		{ env: env.node, cwd: real, timeoutMs: seams.nodeTimeoutMs, cause: "provision-refused" },
	);
}

/** Cleanup: remove every owned artifact and confirm its absence. */
function cleanup(child, seams) {
	try {
		seams.remove(child);
	} catch {}
	// Absence is confirmed only by a clean ENOENT; an unreadable parent is not absence.
	try {
		return lstatSync(child, { throwIfNoEntry: false }) === undefined;
	} catch {
		return false;
	}
}

/** The whole launcher: nodes, cleanup, and the terminal algebra. Returns the exit status. */
export async function main(argv, read, seams) {
	let cause;
	let state;
	try {
		state = await acquire(argv, read, seams);
	} catch (error) {
		// The fallback relation, before creation.
		cause = error instanceof Refusal ? error.refusal : "invalid-input";
	}
	if (cause === undefined) {
		try {
			await acquireIn(state, seams);
		} catch (error) {
			// The fallback relation, after creation: identity confirmed or not.
			cause =
				error instanceof Refusal ? error.refusal : state.confirmed ? "provision-refused" : "snapshot-identity-mismatch";
		}
		if (!cleanup(state.child, seams)) cause = "cleanup-failed";
	}
	if (cause === undefined) return 0;
	seams.stderr(`gitjig-bootstrap: ${cause}\n`);
	return STATUS[cause];
}

/** The command line's seams: the limits relation's values and the real primitives. */
export function defaultSeams() {
	return {
		...LIMITS,
		launcherPath: fileURLToPath(import.meta.url),
		spawn,
		temporaryBase: tmpdir,
		remove: (path) => rmSync(path, { recursive: true, force: true }),
		stderr: (text) => process.stderr.write(text),
	};
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
	// Children inherit an owner-private creation mask (the artifact relation's modes).
	process.umask(0o077);
	const read = { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: process.env.LC_ALL };
	process.exitCode = await main(process.argv.slice(2), read, defaultSeams());
}

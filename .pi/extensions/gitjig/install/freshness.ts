/**
 * Installed-asset freshness (SPEC §4.5), the on-demand measuring stage §5.9
 * asks of a new signal (#365). It reads the committed pin, the verified
 * installed-pin record and the target's complete carried projection, and
 * returns one closed state with one fixed recovery token. Every digest and
 * membership rule stays with the pin codec and the classifier: the carried
 * projection is compared through the pin's own carried aggregate, never a
 * second one.
 *
 * Warning-surface roster: EXEMPT — states and recovery tokens are fixed
 * strings; no operand, path, pin byte or raw error is rendered.
 */
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { type CarriedMember, type CarriedObservation, observeCarried } from "./classifier.ts";
import { buildPin, GENERATED_PIN_PATH, type PinV1, parsePin, sourceEqual } from "./pin.ts";

export const FRESHNESS_STATES = ["current", "placement-mismatch", "session-stale", "cannot-measure"] as const;
export type FreshnessState = (typeof FRESHNESS_STATES)[number];
/** The landed zero-operand launcher (#362): its provision run is the placement recovery. */
export const PROVISION_COMMAND = "node .github/bin/gitjig-bootstrap.mjs";
/** The restart remedy for a running session behind already-correct bytes. */
export const RELOAD_COMMAND = "/reload";
export type FreshnessRecovery = typeof PROVISION_COMMAND | typeof RELOAD_COMMAND | null;
export interface FreshnessResult {
	readonly state: FreshnessState;
	readonly recovery: FreshnessRecovery;
}
export const INSTALLED_PIN_PATH = ".gitjig/installed-pin.json";
/** The read budget of one measurement; past it the projection reads unobservable, so the result is never `current`. */
export const READ_BOUND_MS = 2000;

/** A pin file as read: its bytes, absent, a link or non-regular entry, or unreadable. */
export type PinRead =
	| { kind: "bytes"; bytes: Buffer }
	| { kind: "absent" }
	| { kind: "differs" }
	| { kind: "unreadable" };
export interface FreshnessInputs {
	committedPin: PinRead;
	installedPin: PinRead;
	projection: CarriedObservation;
	/** The projection captured when the extension loaded; undefined if none was taken. */
	capture: CarriedObservation | undefined;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const result = (state: FreshnessState, recovery: FreshnessRecovery): FreshnessResult =>
	Object.freeze({ state, recovery });

function parsed(read: PinRead): PinV1 | undefined {
	if (read.kind !== "bytes") return undefined;
	try {
		return parsePin(utf8.decode(read.bytes));
	} catch {
		return undefined;
	}
}

/** The pin's own carried aggregate over the observed members, or undefined when they cannot form a pin. */
function carriedAggregate(committed: PinV1, members: readonly CarriedMember[]): string | undefined {
	try {
		return buildPin(
			committed.source,
			committed.revision,
			members.map(({ path, bytes }) => ({ path, class: "carried" as const, bytes })),
		).carriedDigest;
	} catch {
		return undefined;
	}
}

function agrees(committed: PinV1, observation: CarriedObservation): boolean {
	return (
		observation.kind === "observed" && carriedAggregate(committed, observation.members) === committed.carriedDigest
	);
}

/**
 * The total precedence, first match wins; no failure ever yields `current`:
 * 1. a committed pin that cannot be read or parsed: cannot-measure;
 * 2. an installed-pin record absent, a link, malformed, or not the committed
 *    pin (behind, ahead or another): placement-mismatch, and one that cannot
 *    be read: cannot-measure;
 * 3. a carried projection that cannot be observed: cannot-measure;
 * 4. a carried projection that differs (a link or non-regular entry, or any
 *    missing, additional, renamed or byte-different member): placement-mismatch;
 * 5. a load-time capture that is unavailable: cannot-measure, advising /reload;
 * 6. a load-time capture that differs: session-stale;
 * 7. otherwise: current.
 */
export function evaluateFreshness(inputs: FreshnessInputs): FreshnessResult {
	const committed = parsed(inputs.committedPin);
	if (committed === undefined) return result("cannot-measure", PROVISION_COMMAND);
	if (inputs.installedPin.kind === "unreadable") return result("cannot-measure", PROVISION_COMMAND);
	const installed = parsed(inputs.installedPin);
	if (
		installed === undefined ||
		!sourceEqual(installed.source, committed.source) ||
		installed.revision !== committed.revision ||
		installed.payloadDigest !== committed.payloadDigest
	)
		return result("placement-mismatch", PROVISION_COMMAND);
	if (inputs.projection.kind === "unreadable") return result("cannot-measure", PROVISION_COMMAND);
	if (!agrees(committed, inputs.projection)) return result("placement-mismatch", PROVISION_COMMAND);
	if (inputs.capture === undefined || inputs.capture.kind === "unreadable")
		return result("cannot-measure", RELOAD_COMMAND);
	if (!agrees(committed, inputs.capture)) return result("session-stale", RELOAD_COMMAND);
	return result("current", null);
}

function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function sameObject(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

/** Read one target-rooted file without following a link at any component. */
export function readPinFile(
	targetRoot: string,
	relative: string,
	/** Test seams at the exact phases a replacement could slip in. */
	seams: { afterContainers?: () => void; afterLstat?: () => void; afterRead?: () => void } = {},
): PinRead {
	const parts = relative.split("/");
	let current = resolve(targetRoot);
	const containers: Array<{ path: string; stats: Stats }> = [];
	for (const part of parts.slice(0, -1)) {
		current = join(current, part);
		try {
			const stats = lstatSync(current);
			if (!stats.isDirectory() || stats.isSymbolicLink()) return { kind: "differs" };
			containers.push({ path: current, stats });
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" };
		}
	}
	// O_NOFOLLOW guards the last component only: a container replaced by a
	// link after its check would be followed, so every container is checked
	// again once the read is done.
	const containersHeld = () => containers.every(({ path, stats }) => sameObject(stats, lstatSync(path)));
	seams.afterContainers?.();
	const absolute = join(current, parts.at(-1) as string);
	let before: Stats;
	try {
		before = lstatSync(absolute);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" };
	}
	if (!before.isFile() || before.isSymbolicLink()) return { kind: "differs" };
	seams.afterLstat?.();
	let descriptor: number | undefined;
	try {
		// Non-blocking: a FIFO swapped in after the lstat opens at once and fails the identity check.
		descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = fstatSync(descriptor);
		if (!opened.isFile() || !sameObject(before, opened)) return { kind: "unreadable" };
		const bytes = readFileSync(descriptor);
		seams.afterRead?.();
		if (!sameObject(opened, lstatSync(absolute)) || !containersHeld()) return { kind: "unreadable" };
		return { kind: "bytes", bytes };
	} catch {
		return { kind: "unreadable" };
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

/**
 * The extension code is imported once per module instance: Pi's /new,
 * /resume and fork re-run the factory over the cached module, which still
 * runs the code it first loaded, so the capture is kept for the module
 * instance, and a fresh module instance captures anew. Only the extension
 * tree is captured, imported or not: a file the runtime reads from disk at
 * each use is captured as first loaded too (a stated false positive). RESIDUAL, stated: Pi reads prompt templates after the extension
 * factories and may read them again later, at a moment no capture here can
 * meet, so prompts take no part in session-stale; a prompt edited and
 * restored while a session runs is not seen.
 */
const CODE_ROOTS = [".pi/extensions/gitjig.ts", ".pi/extensions/gitjig"] as const;
const PROMPT_PREFIX = ".pi/prompts/";
const codeCaptures = new Map<string, CarriedObservation>();

/**
 * Capture the extension code this process runs, at its first factory run.
 * RESIDUAL, stated: this observes the files on disk at that load, not the
 * bytes the extension's static imports already evaluated, so a carried file
 * corrected between those imports and this capture is invisible to
 * `session-stale`.
 */
export function captureCarriedProjection(targetRoot: string): CarriedObservation {
	const root = resolve(targetRoot);
	const held = codeCaptures.get(root);
	if (held !== undefined) return held;
	const capture = Object.freeze(observeCarried(root, Date.now() + READ_BOUND_MS, { roots: CODE_ROOTS }));
	codeCaptures.set(root, capture);
	return capture;
}

/** The capture completed with the projection's own prompts, which take no part in session-stale. */
function withCurrentPrompts(capture: CarriedObservation, projection: CarriedObservation): CarriedObservation {
	if (capture.kind !== "observed" || projection.kind !== "observed") return capture;
	return {
		kind: "observed",
		members: [
			...capture.members.filter(({ path }) => !path.startsWith(PROMPT_PREFIX)),
			...projection.members.filter(({ path }) => path.startsWith(PROMPT_PREFIX)),
		].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))),
	};
}

/**
 * The clone a session runs in, found lexically from its working directory:
 * the nearest ancestor holding a `.pi` entry, link or not. It is never a
 * resolution input (the extension still self-locates, §4.6); it is compared
 * with the self-located root only, so a session whose `.pi` or
 * `.pi/extensions` links into another tree cannot read that tree as its own.
 */
export function sessionClone(cwd: string): string | undefined {
	let current = resolve(cwd);
	for (;;) {
		try {
			lstatSync(join(current, ".pi"));
			return current;
		} catch {}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/**
 * The committed pin: HEAD's entry, never the working tree's file, which may
 * be edited or untracked. Read with the system Git, replace objects ignored
 * and lazy fetching refused, so a partial clone missing the blob fetches
 * nothing and runs no program it configures, under what remains of the
 * budget; anything but HEAD's exact blob is unreadable.
 */
export function readCommittedPin(targetRoot: string, timeoutMs: number): PinRead {
	if (timeoutMs <= 0) return { kind: "unreadable" };
	const run = spawnSync(
		"git",
		// The target's own repository or none: an explicit git directory means no
		// discovery, so Git never climbs into an enclosing repository, whose root
		// pin is not this target's committed pin, whatever the path holds (a
		// ceiling list would split on a ":" in it). A linked worktree's .git file
		// is followed to its own HEAD.
		[
			"--no-lazy-fetch",
			"-C",
			resolve(targetRoot),
			`--git-dir=${join(resolve(targetRoot), ".git")}`,
			"cat-file",
			"blob",
			`HEAD:${GENERATED_PIN_PATH}`,
		],
		{
			env: {
				PATH: process.env.PATH ?? "",
				HOME: process.env.HOME ?? "",
				LC_ALL: "C",
				GIT_NO_REPLACE_OBJECTS: "1",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_TERMINAL_PROMPT: "0",
			},
			timeout: timeoutMs,
			maxBuffer: 16 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	return run.status === 0 && run.signal === null && run.error === undefined
		? { kind: "bytes", bytes: run.stdout }
		: { kind: "unreadable" };
}

/** One on-demand measurement: every read under one budget, then the pure evaluation. */
export function measureFreshness(
	targetRoot: string,
	capture: CarriedObservation | undefined,
	clock: () => number = Date.now,
	/** The clone the session runs in (`sessionClone`), when one was found. */
	session?: string,
): FreshnessResult {
	const deadline = clock() + READ_BOUND_MS;
	const committedPin = readCommittedPin(targetRoot, deadline - clock());
	const installedPin = readPinFile(targetRoot, INSTALLED_PIN_PATH);
	let projection = observeCarried(targetRoot, deadline);
	// A session in another clone runs this tree's carried files through a link:
	// its own projection differs, whatever this tree holds.
	if (session !== undefined && realpathOrSelf(session) !== realpathOrSelf(targetRoot)) projection = { kind: "differs" };
	// The pin reads and the walk share one budget; past it the projection is unobservable.
	if (clock() > deadline) projection = { kind: "unreadable" };
	return evaluateFreshness({
		committedPin,
		installedPin,
		projection,
		capture: capture === undefined ? undefined : withCurrentPrompts(capture, projection),
	});
}

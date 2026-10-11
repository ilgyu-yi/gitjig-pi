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
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
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
/** The read budget of one measurement; past it the result is `cannot-measure`. */
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

function sameObject(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

/** Read one target-rooted file without following a link at any component. */
export function readPinFile(
	targetRoot: string,
	relative: string,
	/** Test seams at the exact phases a replacement could slip in. */
	seams: { afterLstat?: () => void; afterRead?: () => void } = {},
): PinRead {
	const parts = relative.split("/");
	let current = resolve(targetRoot);
	for (const part of parts.slice(0, -1)) {
		current = join(current, part);
		try {
			const stats = lstatSync(current);
			if (!stats.isDirectory() || stats.isSymbolicLink()) return { kind: "differs" };
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" };
		}
	}
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
		descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
		const opened = fstatSync(descriptor);
		if (!opened.isFile() || !sameObject(before, opened)) return { kind: "unreadable" };
		const bytes = readFileSync(descriptor);
		seams.afterRead?.();
		if (!sameObject(opened, lstatSync(absolute))) return { kind: "unreadable" };
		return { kind: "bytes", bytes };
	} catch {
		return { kind: "unreadable" };
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

/**
 * The capture belongs to this module instance: Pi's /new, /resume and fork
 * re-run the extension factory over the cached module, which still runs the
 * code it first loaded, so a re-run keeps the first capture rather than
 * retaking it from corrected files. A fresh module instance captures anew.
 */
const captures = new Map<string, CarriedObservation>();

/**
 * Capture the target's carried projection as the extension first loads in
 * this module instance. RESIDUAL, stated: this observes the files on disk at
 * that load, not the bytes the extension's static imports already evaluated,
 * so a carried file corrected between those imports and this capture is
 * invisible to `session-stale`.
 */
export function captureCarriedProjection(targetRoot: string): CarriedObservation {
	const root = resolve(targetRoot);
	const held = captures.get(root);
	if (held !== undefined) return held;
	const capture = Object.freeze(observeCarried(root, Date.now() + READ_BOUND_MS));
	captures.set(root, capture);
	return capture;
}

/** One on-demand measurement: every read under one budget, then the pure evaluation. */
export function measureFreshness(
	targetRoot: string,
	capture: CarriedObservation | undefined,
	clock: () => number = Date.now,
): FreshnessResult {
	const deadline = clock() + READ_BOUND_MS;
	const committedPin = readPinFile(targetRoot, GENERATED_PIN_PATH);
	const installedPin = readPinFile(targetRoot, INSTALLED_PIN_PATH);
	let projection = observeCarried(targetRoot, deadline);
	// The pin reads and the walk share one budget; past it nothing read decides.
	if (clock() > deadline) projection = { kind: "unreadable" };
	return evaluateFreshness({ committedPin, installedPin, projection, capture });
}

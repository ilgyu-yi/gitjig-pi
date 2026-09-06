/**
 * Adopter substrate composition — DECIDES, never acts (SPEC §4.1
 * namespaces, §4.2 target-parameterization, §4.7's installer boundary).
 *
 * This module answers three questions and stops:
 *   1. Which committed bytes constitute the shell's substrate?
 *   2. Where does each land in an adopting repository?
 *   3. What does the instrument refuse to do?
 *
 * It performs NO filesystem mutation. Composition returns a decision per
 * member and the delivery layer acts on it — a split that is a ceiling
 * decision rather than a style one: delivery publishes into a repository
 * this shell does not govern (§4.3), which is past the merge ceiling
 * (§5.6), so it lives behind `SubstrateDelivery` and lands with its own
 * change. Keeping the decision pure is also what lets every refusal be
 * tested without a repository to refuse against.
 *
 * THE ONE THING NOT DERIVED FROM THE TREE is the namespace set itself,
 * because §4.1 states it: the shell owns `.pi/` and `.gitjig/` as
 * working-tree namespaces, and places repository-visible substrate in the
 * standard locations `.github/`, `.githooks/` and `changelog_unreleased/`.
 * `.gitjig/` is per-clone untracked state and is never committed, so it is
 * never substrate. Everything WITHIN a namespace is walked, so a file
 * added to one tomorrow is substrate the day it lands and cannot drift out
 * of a roster (§2.4's rule-over-roster, §6.1's inventory rule).
 *
 * Warning-surface roster: EXEMPT — this module writes no warning surface
 * and interpolates nothing. It returns data; every `reason` it carries is a
 * FIXED literal with no operand in it, which is §3.9's content-free refusal
 * shape, so there is no point of interpolation for a hostile path component
 * to forge a line into. The member path it decides about travels in a
 * structured field (`source`), never inside a message. Should a message
 * here ever carry a path, this exemption is void and the module joins the
 * escaping roster.
 *
 * MECHANISM VERSUS INSTANCE STATE. One namespace holds both. The fragment
 * tree's `TEMPLATE.md` is the authoring contract an adopter needs; the
 * fragments beneath it are THIS repository's own unreleased history and
 * would land in an adopter as false history. The split is stated as a rule
 * — within `changelog_unreleased/`, only the top-level contract ships —
 * never as a list of the fragments that happen to exist today.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

/**
 * The namespaces §4.1 states, minus `.gitjig/` which is never committed.
 * A fifth namespace joins this set by being named in §4.1 first.
 */
export const SHELL_NAMESPACES = [".pi", ".github", ".githooks", "changelog_unreleased"] as const;

/** What the composition decided for one member. */
export type ComposeAction = "land" | "converged" | "skip" | "refuse";

export interface ComposedMember {
	/** Repository-relative source path, POSIX-separated. */
	source: string;
	/** Repository-relative destination path, or `null` where refused. */
	dest: string | null;
	action: ComposeAction;
	/** Why — carried on every non-`land` decision, never empty. */
	reason: string;
}

export interface ComposeInput {
	sourceRoot: string;
	destRoot: string;
	members: readonly string[];
}

/**
 * The delivery seam (§4.3). Composition never calls the network or the
 * platform; a delivery implementation takes the composed set and opens the
 * reviewed PR that carries it. Named here so the delivery change
 * implements an interface rather than inventing one, and so this module
 * has exactly one egress point rather than none-and-then-several.
 */
export interface SubstrateDelivery {
	deliver(members: readonly ComposedMember[]): Promise<void>;
}

function toPosix(p: string): string {
	return p.split(sep).join("/");
}

/** Every file under `dir`, as paths relative to `rootForRelative`. */
function walk(dir: string, rootForRelative: string, out: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const abs = join(dir, entry);
		let st;
		try {
			st = lstatSync(abs);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			walk(abs, rootForRelative, out);
		} else if (st.isFile()) {
			out.push(toPosix(relative(rootForRelative, abs)));
		}
	}
}

/**
 * Within `changelog_unreleased/`, only the top-level authoring contract is
 * substrate; anything nested is this repository's own pending history.
 * Stated as a rule over the path shape, never as a list.
 */
function isInstanceState(rel: string): boolean {
	if (!rel.startsWith("changelog_unreleased/")) {
		return false;
	}
	return rel.slice("changelog_unreleased/".length).includes("/");
}

/** Walk the shell-owned namespaces of `sourceRoot`. Sorted, so callers see a stable set. */
export function deriveSubstrateSet(sourceRoot: string): string[] {
	const found: string[] = [];
	for (const ns of SHELL_NAMESPACES) {
		const abs = join(sourceRoot, ns);
		if (existsSync(abs)) {
			walk(abs, sourceRoot, found);
		}
	}
	return found.filter((rel) => !isInstanceState(rel)).sort();
}

/**
 * True when `rel` is a normalized, relative path inside a shell-owned
 * namespace.
 *
 * WHICH TEST IS LOAD-BEARING, measured rather than assumed. The final
 * namespace-prefix test carries the containment on its own: with BOTH
 * early returns neutered, `../escaped.sh` and `/etc/passwd` are still
 * refused, because neither begins with a namespace after normalization.
 * That mutant was run and SURVIVED, and it is recorded here rather than
 * read as dead code — the early returns are redundant defense in depth
 * that no input on the supported platforms distinguishes. They are kept
 * deliberately: this is a containment check on an install path, the cost
 * of the redundancy is two comparisons, and a later edit that loosens the
 * prefix test should still meet a closed door. The prefix test is the one
 * pinned by a mutant that reds.
 *
 * Normalization runs BEFORE the prefix test on purpose, so containment is
 * decided on where a path actually lands rather than on how it is spelled:
 * `.pi/../.github/x` normalizes into a namespace and is allowed, while
 * `.githooks/../../x` normalizes out of the tree and is refused. Both
 * directions are pinned.
 */
function insideNamespace(rel: string): boolean {
	if (isAbsolute(rel)) {
		return false;
	}
	const normalized = toPosix(normalize(rel));
	if (normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) {
		return false;
	}
	return SHELL_NAMESPACES.some((ns) => normalized === ns || normalized.startsWith(`${ns}/`));
}

/**
 * Does any existing container of `destRoot/rel` resolve through a symlink?
 * `lstat` judges the link itself, so a symlinked container is caught rather
 * than followed — the same write-through-link refusal §5.5 binds on every
 * record producer, asked here of the containers a landing would traverse.
 * Absent containers are not a fault: they are what a landing creates.
 */
function containerIsLink(destRoot: string, rel: string): boolean {
	const parts = rel.split("/").slice(0, -1);
	let cursor = destRoot;
	for (const part of parts) {
		cursor = join(cursor, part);
		try {
			if (lstatSync(cursor).isSymbolicLink()) {
				return true;
			}
		} catch {
			return false; // absent from here down — nothing to traverse
		}
	}
	return false;
}

function sameBytes(a: string, b: string): boolean {
	try {
		return readFileSync(a).equals(readFileSync(b));
	} catch {
		return false;
	}
}

/**
 * Decide, per member, what an install would do. Pure: reads both trees and
 * writes nothing. Refusal is per MEMBER — one hostile path does not
 * refuse a whole run, and each refusal names its own subject, so an
 * operator can repair one member rather than bisecting a batch.
 */
export function composeSubstrate(input: ComposeInput): ComposedMember[] {
	const { sourceRoot, destRoot, members } = input;
	return members.map((rel) => {
		if (!insideNamespace(rel)) {
			return {
				source: rel,
				dest: null,
				action: "refuse" as const,
				reason: "destination falls outside the shell-owned namespaces §4.1 states; nothing is landed for this member",
			};
		}
		if (containerIsLink(destRoot, rel)) {
			return {
				source: rel,
				dest: null,
				action: "refuse" as const,
				reason: "a destination container is a symbolic link; a landing would write through it to wherever it points",
			};
		}

		const destAbs = join(destRoot, rel);
		if (!existsSync(destAbs)) {
			return { source: rel, dest: rel, action: "land" as const, reason: "" };
		}
		if (!statSync(destAbs).isFile()) {
			return {
				source: rel,
				dest: null,
				action: "refuse" as const,
				reason: "the destination exists and is not a regular file; it is not a same-named asset this instrument may reason about",
			};
		}
		if (sameBytes(join(sourceRoot, rel), destAbs)) {
			return {
				source: rel,
				dest: rel,
				action: "converged" as const,
				reason: "the destination already holds identical bytes; left unchanged (no-op)",
			};
		}
		return {
			source: rel,
			dest: rel,
			action: "skip" as const,
			reason: "a pre-existing same-named asset differs from the substrate; skipped with a warning and left untouched (§4.7 never overwrites)",
		};
	});
}

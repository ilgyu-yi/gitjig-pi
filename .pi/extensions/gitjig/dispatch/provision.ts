/**
 * Dispatch provision — the isolated execution context, pinned at provision
 * (SPEC §4.9 pin-at-provision; §1.5 tree isolation; §1.6).
 *
 * Provision resolves the expected ref EXACTLY ONCE, in the caller's
 * repository — `expectedRef` when given, the caller's HEAD otherwise —
 * and holds the hash. The isolated tree is a `git clone --no-hardlinks`
 * of the caller repository into a `mkdtempSync` scratch, detached at the
 * held hash, so the provisioned tree equals the held operand by
 * construction and nothing at run time can re-resolve the ref (§4.9).
 * Scratch layout: `tree/` (the delegate's cwd and its whole local
 * writable world — the delegate runs in the caller's trust domain and
 * inherits its environment, credentials included),
 * `brief.md` (the dispatched brief's bytes, §1.5's dispatch-facts
 * carrier), `state/` (the delegate's rebound state seam, §5.5), and the
 * `return.json` slot — the sole crossing, reached by the delegate as
 * `../return.json` from its tree cwd, layout-derived with no second
 * locator surface.
 *
 * A worktree (`git worktree add`) is REJECTED as the isolation form: a
 * worktree shares the caller's object and ref store, so a delegate
 * commit would land in the caller's `.git` — the clone is what makes the
 * delegate's every write invisible to the caller (§1.5), once the two
 * routes the clone itself plants back are severed at provision: the
 * origin remote is removed, and `.git/logs` is deleted whole because the
 * reflog records `clone: from <caller-path>`, a mineable address for a
 * by-path push. What remains is the trust-domain residual — a same-uid
 * delegate can still discover the caller path from inherited environment
 * or a filesystem scan; the trace provision itself plants is removed.
 * An expected ref
 * naming no object in the caller repository fails LOUD with a fixed
 * content-free cause, never a silently-provisioned tree (§3.9): an
 * unresolvable expected head is ambiguity, and the thrown cause names no
 * caller-held operand (§4.9's content-free channels).
 *
 * Named residual (§3.11): a dispatcher killed uncleanly orphans its
 * scratch. The scratch's own parent is the boundary that contains the
 * orphan — the ambient temporary root, or the shell-owned fallback
 * `scratchParent()` selects when that root lies inside a repository; no
 * TTL reap runs, an unfired contingency earning no code. Under the
 * fallback that boundary sits inside the governed repository, where the
 * ordinary reclamation act does not reach it: `git clean -xdf` SKIPS a
 * nested repository and reports doing so, and `-xdff` is what removes it.
 * The boundary is
 * named that way rather than as "the OS temp root" because the temporary
 * root is an ambient VALUE and can be pointed anywhere, which is the whole
 * subject of `scratchParent()` below (issue #127).
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR_MODE } from "../audit.ts";
import { quoted } from "../quote.ts";
import { resolveStateRoot } from "../state-root.ts";

/**
 * A copy of `base` with two GIT_* families deleted, the members git
 * resolves ahead of both cwd and `-C` (§1.5): the repo-locating family —
 * `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
 * `GIT_COMMON_DIR` — retargets a git child's reads and writes at whatever
 * repository the variable names; the config-injection channel —
 * `GIT_CONFIG_PARAMETERS` plus `GIT_CONFIG_COUNT` (deleting COUNT
 * neutralizes the indexed `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`
 * family, which git reads only up to COUNT) — injects arbitrary config
 * into that child, e.g. a `core.hooksPath` or `core.fsmonitor` git honors
 * from this channel and runs as a program inside provision's own clone
 * and checkout. `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` are the
 * file-indirection members left PASSING: they redirect where git reads
 * user/system config, and deleting them un-isolates config reads — a
 * harness that sets `GIT_CONFIG_GLOBAL=/dev/null` to keep user config out
 * of provision's children would, on deletion, leak `~/.gitconfig` back in.
 * One hazard, one spelling: provision's own git children and the
 * executor's delegate both build their env from this helper, never from a
 * copied list.
 */
export function withoutRepoLocatingGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...base };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;
	delete env.GIT_OBJECT_DIRECTORY;
	delete env.GIT_COMMON_DIR;
	delete env.GIT_CONFIG_PARAMETERS;
	delete env.GIT_CONFIG_COUNT;
	return env;
}

/** The provisioned context: path-pinned layout plus the held operand. */
export interface DispatchContext {
	scratchRoot: string;
	treeDir: string;
	briefPath: string;
	returnPath: string;
	stateDir: string;
	/** The once-resolved commit hash the tree is detached at (§4.9). */
	heldHash: string;
}

/** Fixed loud-refusal causes — content-free, naming no operand (§3.9);
 * exported so the composed pipeline can pass a known cause through. */
/**
 * The nearest repository at or above `path`, or `undefined` where the walk
 * reaches the filesystem root without finding one.
 *
 * A `.git` ENTRY, not a `.git` directory: a linked worktree and a
 * submodule both carry `.git` as a FILE, and each is as much a repository
 * the shell does not govern as an ordinary clone is. Asking only for a
 * directory would answer "no repository" for both and place the scratch
 * inside exactly the shapes this walk exists to avoid.
 *
 * A BARE repository is not reported, because it carries no `.git` entry to
 * find. That is the answer this walk wants rather than a gap in it: a bare
 * repository has no work tree, so nothing written beside it can become
 * that repository's committable content, which is the outcome the walk
 * exists to prevent.
 *
 * The walk is filesystem-only and spawns no child. `git rev-parse` would
 * answer the same question, but it reads the ambient git environment,
 * and this runs to decide where the shell may WRITE — a decision that
 * must not itself be redirectable by the environment whose reach is the
 * subject (§4.6's ambient-never-on-the-hot-path rule). It is the same
 * upward-walk shape `locate.ts` uses for the repository root.
 */
export function containingRepository(path: string): string | undefined {
	let current: string;
	try {
		current = realpathSync(path);
	} catch {
		return undefined;
	}
	for (;;) {
		if (existsSync(join(current, ".git"))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

/**
 * Where the scratch is minted: the ambient temporary root, unless that
 * root lies inside a repository — in which case the scratch falls through
 * to shell-owned storage (§5.5, issue #127).
 *
 * `os.tmpdir()` returns `TMPDIR`, an ambient value with no guard, so the
 * temporary root can sit inside a repository the shell does not govern.
 * A scratch minted there is an unexcluded shell-written tree in a
 * repository the shell does not control — the outcome §5.5 names as the
 * defect, reached through neither of that section's two limbs.
 *
 * The disposition is §5.5's own, applied rather than invented:
 * FALL-THROUGH to shell-owned storage. Exclusion-at-creation is the limb
 * that section decided against, and it would mean writing to a foreign
 * repository's metadata to make a write into that repository safe.
 * Refusing was rejected on cost: a repository-internal temporary root is
 * an ordinary environment, not an attack, and wedging the whole delegation
 * layer over it fails an aid closed in the direction §5.2 forbids.
 *
 * The fallback is the shell's own state root, whose namespace §4.1 gives
 * it — so the bytes land somewhere the shell owns. Its exclusion from
 * version control is a per-clone fact and not a property of this write:
 * the bind instrument writes that exclusion, and this repository also
 * commits a root-anchored ignore for it. In a clone that has never been
 * bound and carries no such ignore, the namespace this creates is
 * untracked-and-unignored like any other new path — a residual inherited
 * from the record writers that already materialise that directory, not one
 * this branch introduces, and stated here rather than claimed away. The
 * fallback is announced, because a silently relocated scratch is a
 * degraded state a reader cannot see (§5.2's surfaced-signal rule): the
 * temporary root an operator configured is not the one in use.
 *
 * Where the shell-owned home is unusable the ambient root is taken anyway,
 * and the fall-back-from-the-fallback is ANNOUNCED too: this function
 * chooses between two homes and is not an enforcement gate, so it degrades
 * open rather than wedging dispatch on a second failure (§5.2) — but a
 * relocation that silently did NOT happen ends in the very state this
 * branch exists to prevent, which is worse than the surprising directory
 * the first warning is about. Unusable covers two shapes: the home cannot
 * be created, and the home is REDIRECTED. A symlink at a directory
 * component this write creates or traverses is another writer's target,
 * because `mkdirSync(…, {recursive: true})` follows both — the same hazard
 * `bind-state.ts` lstats for before its own recursive mkdir, one component
 * shallower. Writing through such a link would clone the caller repository
 * to wherever it points, which is how a branch installed to keep bytes out
 * of an ungoverned repository would put them there instead. Both shapes
 * take one posture rather than two, because for this writer they have one
 * remedy and one consequence: the shell-owned home is not available, so
 * say so and use the ambient root.
 */
export function scratchParent(): string {
	const ambient = tmpdir();
	const enclosing = containingRepository(ambient);
	if (enclosing === undefined) {
		return ambient;
	}
	let fallback: string;
	try {
		const stateRoot = resolveStateRoot().root;
		fallback = join(stateRoot, "dispatch");
		// The link probe covers every component this writer would create or
		// traverse, leaf included — unlike the sibling's, which stops above
		// its leaf because its leaf is opened under `O_NOFOLLOW` and refuses
		// there. This writer's leaf is a DIRECTORY handed to `git clone`, so
		// no descriptor-level refusal stands behind it.
		//
		// Two residuals, stated because §5.5 asks each writer to state them
		// and both siblings do. A link ABOVE these components is followed:
		// those components are not this writer's to own, the same posture
		// `bind-state.ts` takes and says it takes. And the lstat-then-mkdir
		// pair leaves a check/use window at the leaf, which this writer cannot
		// close the way the sibling's leaf-open does — its leaf must BE a
		// directory, so there is no descriptor to carry the refusal.
		for (const component of [dirname(stateRoot), stateRoot, fallback]) {
			let linked = false;
			try {
				linked = lstatSync(component).isSymbolicLink();
			} catch {
				// Absent — nothing to refuse; the create below makes it.
			}
			if (linked) {
				throw new Error(`refusing the redirected component ${quoted(component)}`);
			}
		}
		mkdirSync(fallback, { recursive: true, mode: STATE_DIR_MODE });
	} catch (error) {
		console.warn(
			`[gitjig] the temporary root ${quoted(ambient)} lies inside the repository ${quoted(enclosing)}, and ` +
				`the shell-owned home this dispatch would fall through to is unavailable, so the scratch is being ` +
				`provisioned under that temporary root after all — an unexcluded shell-written tree in a ` +
				`repository this shell does not govern (§5.5). Cause: ` +
				`${quoted(error instanceof Error ? error.message : String(error))}. Recovery: point TMPDIR at a ` +
				`directory outside every repository, or make the shell's state namespace writable and unlinked.`,
		);
		return ambient;
	}
	console.warn(
		`[gitjig] the temporary root ${quoted(ambient)} lies inside the repository ${quoted(enclosing)}, so a ` +
			`dispatch scratch there would be an unexcluded shell-written tree in a repository this shell does ` +
			`not govern (§5.5). Provisioning under ${quoted(fallback)} instead. Recovery: point TMPDIR at a ` +
			`directory outside every repository to use the ordinary temporary root.`,
	);
	return fallback;
}

export const PROVISION_REFUSAL_CAUSES = {
	unresolvable:
		"dispatch provision refused: the expected ref resolves to no commit in the caller repository — " +
		"an unresolvable expected head is ambiguity, never a provisioned tree (SPEC §4.9, §3.9)",
	clone:
		"dispatch provision refused: the isolated tree could not be cloned and detached at the held hash (SPEC §4.9, §1.5)",
} as const;

export function provisionDispatchContext(
	callerRepoRoot: string,
	options: { brief: string; expectedRef?: string },
): DispatchContext {
	// Every git child below runs with the repo-locating and
	// config-injection GIT_* families scrubbed: an inherited GIT_DIR would
	// retarget these very children — the resolve, the detach, the origin
	// sever — at another repository despite their -C target, and an
	// inherited GIT_CONFIG_COUNT could inject a core.hooksPath that runs a
	// program inside them (§1.5).
	const env = withoutRepoLocatingGitEnv(process.env);
	// Resolved once, here, in the caller's repository; the hash is held and
	// every later act binds to it (§4.9 pin-at-provision).
	let heldHash: string;
	try {
		heldHash = execFileSync(
			"git",
			[
				"-C",
				callerRepoRoot,
				"rev-parse",
				"--verify",
				"--quiet",
				"--end-of-options",
				`${options.expectedRef ?? "HEAD"}^{commit}`,
			],
			{ encoding: "utf8", env },
		).trim();
	} catch {
		throw new Error(PROVISION_REFUSAL_CAUSES.unresolvable);
	}
	if (!/^[0-9a-f]{40}$/.test(heldHash)) {
		throw new Error(PROVISION_REFUSAL_CAUSES.unresolvable);
	}
	// mkdtemp's exclusive creation is the isolation floor two racing
	// dispatches stand on (§1.5).
	const scratchRoot = mkdtempSync(join(scratchParent(), "gitjig-dispatch-"));
	const treeDir = join(scratchRoot, "tree");
	try {
		execFileSync("git", ["clone", "-q", "--no-hardlinks", callerRepoRoot, treeDir], { encoding: "utf8", env });
		execFileSync("git", ["-C", treeDir, "checkout", "-q", "--detach", heldHash], { encoding: "utf8", env });
		// The clone's origin remote is a route back to the caller repository —
		// push and fetch both — and is severed here (§1.5).
		execFileSync("git", ["-C", treeDir, "remote", "remove", "origin"], { encoding: "utf8", env });
		// The clone's reflog is the second planted route back: `.git/logs`
		// records `clone: from <caller-path>`, and a by-path push needs no
		// remote. Removed whole (§1.5).
		rmSync(join(treeDir, ".git", "logs"), { recursive: true, force: true });
		writeFileSync(join(scratchRoot, "brief.md"), options.brief);
		mkdirSync(join(scratchRoot, "state"));
	} catch {
		// A half-provisioned scratch is removed before the loud refusal: the
		// caller holds no context to clean (§3.9).
		rmSync(scratchRoot, { recursive: true, force: true });
		throw new Error(PROVISION_REFUSAL_CAUSES.clone);
	}
	return {
		scratchRoot,
		treeDir,
		briefPath: join(scratchRoot, "brief.md"),
		returnPath: join(scratchRoot, "return.json"),
		stateDir: join(scratchRoot, "state"),
		heldHash,
	};
}

/** Removes the scratch whole — the dispatch leaves nothing behind (§1.5). */
export function cleanupDispatchContext(context: DispatchContext): void {
	rmSync(context.scratchRoot, { recursive: true, force: true });
}

/**
 * Integration suite for the session-start bind advisory's HYGIENE (issue #68
 * AC5/AC6; SPEC §5.2 advisory surface, §5.9 read-only detector rule + TTL and
 * stamp-after-success, §4.6 detector-placement).
 *
 * Drives real `pi` sessions through the hermetic harness (seam-rooted state,
 * §5.5) against the gitjig runtime linked from THIS repository's tree. Each
 * fixture root is made a git repository carrying a copy of the committed
 * `.githooks/` tree, shaped into one binding state; the suite then reads the
 * session JSONL for `customType: "gitjig-bind-advisory"` entries — the
 * pinned, harness-readable advisory surface.
 *
 * The advisory's STATE SET — which configurations are loud and which silent
 * — is the sibling suite's subject
 * (`derived-bind-advisory.integration.test.ts`). What is here is what that
 * suite does not measure: the detector's placement, its read-only rule, its
 * child bound, the TTL stamp's own write guards, and the `unbound` state's
 * advisory shape, whose fixture the sibling does not carry.
 *
 * ANTI-VACUITY (per-arm, stated in place):
 *   - silence is the advisory's contract for one state and its failure
 *     mode everywhere else, so no arm may read silence without proving the
 *     runtime ran. The PI-SESSION arms discharge that with
 *     `requireRuntimeLoaded`, which demands the fixture's session carry the
 *     extension's registration entry. The DIRECT-CALL arms cannot use it,
 *     since no session exists to carry that entry — they are the four
 *     entry-point arms of the issue #125 block plus the umask arm, and each
 *     discharges it with an in-arm positive control that makes the runtime
 *     speak against the same state root before any absence is read. The
 *     population is stated by enumeration because reading it off the block
 *     boundary gets it wrong in both directions: the umask arm drives the
 *     entry point from OUTSIDE that block, and the block's own pure-path
 *     arm drives no entry point, reads no absence, and stands outside this
 *     rule rather than under it. Both devices are required, never assumed:
 *     an arm reading only absences and holding no control passes against an
 *     entry point replaced by an immediate return;
 *   - arms that hold whatever the detector does — the reaped-child
 *     completion — are declared BOUNDARY PINS in place and state what
 *     mutation reddens them;
 *   - the stamp arms import `.pi/extensions/gitjig/bind-state.ts` and CALL
 *     its exported `bindAdvisoryStampPath`, so the stamp's location is the
 *     module's to name and this suite cannot drift from it — the location
 *     is keyed, so a name spelled here would be a second copy of the rule.
 *
 * PINNED SURFACES (what the runtime and this suite agree on):
 *   - advisory entry type: `gitjig-bind-advisory`; each degraded-state entry
 *     names its state token (`unbound` / `foreign-bound`) and the exact
 *     re-arm command `bash .githooks/bind_local_tier.sh` somewhere in its
 *     serialized form;
 *   - stamp-after-success has two limbs since issue #125, because the
 *     repository resolve that names the stamp now runs BEFORE the compute.
 *     The COMPUTE limb is pinned by the erroring-child arm, whose shim
 *     leaves `rev-parse` working. The two guards sit in SERIES, so neither
 *     is killable by THE HUNG-RESOLVE ARM alone — defense in depth, and
 *     declared rather than mistaken for coverage. (The compute guard IS
 *     killed by a single-point mutant: removing it reddens the
 *     erroring-child arm. It is this fixture that cannot reach either.)
 *     What holds the pair is
 *     the issue #125 block's stampless arm: it reads the WHOLE state root
 *     rather than one keyed path, so it reddens when both guards go, and
 *     it is the only arm here that can observe a stamp written under a key
 *     it did not ask for;
 *   - the TTL stamp lives where `bindAdvisoryStampPath(stateRoot, repoTop)`
 *     puts it: under the state root, keyed by the repository the advisory
 *     classified, so one shell-owned root debounces each repository
 *     separately (§5.5's fall-through disposition; issue #125).
 *
 * POSIX substrate only: the suite skips on win32.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
	buildFixture,
	type Fixture,
	type PiRunResult,
	readAuditLines,
	readSessionEntries,
	removeFixture,
	repoRoot,
	runPi,
	type ScriptTurn,
} from "./harness/run-pi.ts";

const IS_WINDOWS = process.platform === "win32";

const ADVISORY_TYPE = "gitjig-bind-advisory";
const REARM = "bash .githooks/bind_local_tier.sh";
const INSTRUMENT_REL = join(".githooks", "bind_local_tier.sh");
/** The retired per-clone binding path — a file no surface reads. */
const RETIRED_BINDING_REL = join(".gitjig", "shell-adapter.sh");
/** Diagnostic hint: what must hold for a per-state arm to find its entry. */
const OWES_ADVISORY = "the session-start advisory owes exactly one entry per degraded state";

const SCRIPT: ScriptTurn[] = [
	{ kind: "toolCall", name: "bash", arguments: { command: "echo GITJIG_BIND_IT_RAN" } },
	{ kind: "text", text: "GITJIG_BIND_IT_DONE" },
];

// ---------------------------------------------------------------------------
// Substrate helpers.
// ---------------------------------------------------------------------------

function envFor(home: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: home,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		LANG: "en_US.UTF-8",
		LC_ALL: "en_US.UTF-8",
	};
}

/** Run one setup git command that must succeed (substrate, never a measurement). */
function runGit(root: string, home: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd: root, env: envFor(home), timeout: 30_000 });
	if (result.status !== 0) {
		throw new Error(`substrate: git ${args.join(" ")} exited ${result.status}: ${result.stderr?.toString("utf8")}`);
	}
}

/** Make the fixture root a git repository carrying the committed `.githooks/` copy. */
function armGitRepo(fixture: Fixture): void {
	runGit(fixture.root, fixture.homeDir, ["-c", "init.defaultBranch=zqadvmain", "init", "-q"]);
	runGit(fixture.root, fixture.homeDir, ["config", "user.name", "fixture"]);
	runGit(fixture.root, fixture.homeDir, ["config", "user.email", "fixture@invalid"]);
	runGit(fixture.root, fixture.homeDir, ["config", "commit.gpgsign", "false"]);
	cpSync(join(repoRoot(), ".githooks"), join(fixture.root, ".githooks"), { recursive: true });
}

/**
 * A PATH shim directory whose `git` diverts the subcommand `match` names and
 * execs the real interpreter for everything else, so the session itself runs
 * normally while the detector's own child takes the diverted outcome.
 */
function gitShimDir(root: string, name: string, match: string, divert: string): string {
	const dir = join(root, name);
	mkdirSync(dir);
	const realGit = spawnSync("sh", ["-c", "command -v git"], { timeout: 10_000 })
		.stdout.toString("utf8")
		.trim();
	writeFileSync(
		join(dir, "git"),
		`#!/bin/sh\nif [ "$1" = "${match}" ]; then ${divert}; fi\nexec '${realGit}' "$@"\n`,
	);
	chmodSync(join(dir, "git"), 0o755);
	return dir;
}

function advisoryEntries(fixture: Fixture): Array<Record<string, unknown>> {
	return readSessionEntries(fixture).filter(
		(entry) => entry.type === "custom" && entry.customType === ADVISORY_TYPE,
	);
}

function diagnostics(result: PiRunResult): string {
	return `pi ${result.piVersion} exit=${result.exitCode} timedOut=${result.timedOut}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
}

/**
 * Positive control for every advisory and silence claim: the gitjig runtime
 * demonstrably LOADED in this fixture's session(s) (its registration entry
 * exists). Without it, a silence pin would also pass on a session where the
 * extension never ran, and a per-state arm's red could hide a broken
 * fixture transplant rather than a detector that answered wrongly.
 */
function requireRuntimeLoaded(fixture: Fixture, run: PiRunResult, arm: string): void {
	const registrations = readSessionEntries(fixture).filter(
		(entry) => entry.type === "custom" && entry.customType === "gitjig-registration",
	);
	assert.ok(
		registrations.length >= 1,
		`${arm}: no gitjig-registration entry — the runtime never loaded, so every advisory/silence claim ` +
			`here is vacuous\n${diagnostics(run)}`,
	);
}

/**
 * Every string in the entry that carries the re-arm command and something
 * else — the advisory line itself, whether the harness stores the payload
 * nested or serialized. The bare `rearm` field is exactly the command, so it
 * is excluded rather than measured as a message.
 */
function advisoryLines(entry: Record<string, unknown>): string[] {
	const found: string[] = [];
	const walk = (value: unknown): void => {
		if (typeof value === "string") {
			if (value.includes(REARM) && value !== REARM) {
				found.push(value);
			}
		} else if (Array.isArray(value)) {
			for (const item of value) {
				walk(item);
			}
		} else if (value !== null && typeof value === "object") {
			for (const item of Object.values(value as Record<string, unknown>)) {
				walk(item);
			}
		}
	};
	walk(entry);
	return found;
}

/**
 * A degraded-state line names its state and the re-arm command. What it may
 * NOT do is assert a CONSEQUENCE — what is or is not armed, what is or is not
 * recorded: the same clause is true of some shapes behind a token and false of
 * others, and an operator who checks one and finds it false retires the
 * surface (§3.11's dead-recovery rule).
 */
const CONSEQUENCE_CLAIM = /\barmed\b|\brecords?\b|\brecorded\b|\bdropped\b|\bfires?\b/i;

function assertOneAdvisory(fixture: Fixture, run: PiRunResult, state: string, redNote: string): void {
	requireRuntimeLoaded(fixture, run, `${state} advisory`);
	const entries = advisoryEntries(fixture);
	assert.equal(
		entries.length,
		1,
		`expected exactly one ${ADVISORY_TYPE} entry for the ${state} state (${redNote}); ` +
			`got ${JSON.stringify(entries)}\n${diagnostics(run)}`,
	);
	const text = JSON.stringify(entries[0]);
	assert.equal(
		text.includes(state),
		true,
		`the advisory does not name its state "${state}" (§5.2 names the degraded capability): ${text}`,
	);
	assert.equal(
		text.includes(REARM),
		true,
		`the advisory does not name the exact re-arm command "${REARM}" (§5.2): ${text}`,
	);
	const lines = advisoryLines(entries[0] as Record<string, unknown>);
	assert.ok(
		lines.length > 0,
		`the ${state} advisory carries no line naming the re-arm command, so the check below measures ` +
			`nothing: ${text}`,
	);
	for (const line of lines) {
		assert.doesNotMatch(
			line,
			CONSEQUENCE_CLAIM,
			`the ${state} advisory asserts a consequence beside its state and re-arm command — the clause ` +
				`holds for some shapes behind this token and not others, and the operator who checks it and ` +
				`finds it false retires the surface (§3.11)`,
		);
	}
}

function assertSilent(fixture: Fixture, run: PiRunResult, arm: string): void {
	requireRuntimeLoaded(fixture, run, arm);
	assert.equal(run.exitCode, 0, `${arm}: the session did not complete\n${diagnostics(run)}`);
	assert.deepEqual(
		advisoryEntries(fixture),
		[],
		`${arm}: an advisory surfaced on a state the §5.2 contract keeps silent`,
	);
}

/** The detector module's surface this suite binds to (header note). */
interface BindStateModule {
	bindAdvisoryStampPath: (stateRoot: string, repoTop: string) => string;
	maybeAdviseBindState: (pi: { appendEntry: (type: string, payload: unknown) => void }, stateRoot: string) => void;
}

/**
 * The detector module, loaded from THIS repository's tree. The stamp's
 * location is the module's to name, so the suite reads the exported name
 * rather than spelling it — a rename cannot leave these arms measuring a
 * path nothing writes.
 */
async function bindStateModule(): Promise<BindStateModule> {
	const modulePath = join(repoRoot(), ".pi", "extensions", "gitjig", "bind-state.ts");
	assert.equal(existsSync(modulePath), true, `${modulePath} is missing — the detector under test is not there`);
	const module = (await import(pathToFileURL(modulePath).href)) as {
		bindAdvisoryStampPath?: unknown;
		maybeAdviseBindState?: unknown;
	};
	assert.equal(
		typeof module.bindAdvisoryStampPath === "function",
		true,
		"bind-state.ts must export bindAdvisoryStampPath — the debounce stamp's location is keyed by the " +
			"repository the advisory classified (§5.5, issue #125), and this suite calls that rule rather " +
			"than spelling a second copy of it",
	);
	assert.equal(
		typeof module.maybeAdviseBindState === "function",
		true,
		"bind-state.ts must export maybeAdviseBindState — the session_start entry point",
	);
	return module as unknown as BindStateModule;
}

/**
 * The stamp path a session standing in `repoRoot` writes under `dir` — the
 * module's own keying rule, called rather than spelled a second time here.
 * `dir` is the fixture's state root, except in the arms that measure what a
 * REFUSED write did not create, where it is the planted victim directory.
 */
async function stampPathFor(dir: string, repoRoot: string): Promise<string> {
	return (await bindStateModule()).bindAdvisoryStampPath(dir, realpathSync(repoRoot));
}

// ---------------------------------------------------------------------------
// Fixtures and runs (built once; sequential — real pi sessions).
// ---------------------------------------------------------------------------

let unboundFixture: Fixture;
let unboundRun1: PiRunResult;
let unboundRun2: PiRunResult;
let advisoriesAfterRun1: Array<Record<string, unknown>>;
let canaryFixture: Fixture;
let canaryRun: PiRunResult;
let canaryPath: string;
let retiredPathFixture: Fixture;
let retiredPathRun: PiRunResult;
let worktreeFixture: Fixture;
let worktreeRun: PiRunResult;
let worktreeTmp: string;
let erroringFixture: Fixture;
let erroringRun: PiRunResult;
let hangingGitFixture: Fixture;
let hangingGitRun: PiRunResult;
let fifoStampFixture: Fixture;
let fifoStampRun: PiRunResult;
let fifoStampPath: string;
let fifoStampTarget: string;
let bareFifoStampFixture: Fixture;
let bareFifoStampRun: PiRunResult;
let bareFifoStampPath: string;
let linkedStateRootFixture: Fixture;
let linkedStateRootRun: PiRunResult;
let stateRootVictim: string;
let hardLinkedStampFixture: Fixture;
let hardLinkedStampRun: PiRunResult;
let hardLinkedStampPath: string;
let hardLinkedStampVictim: string;
let looseModeStampFixture: Fixture;
let looseModeStampRun: PiRunResult;
let looseModeStampPath: string;

/** The bytes a refused stamp write must leave exactly where it found them. */
const STAMP_VICTIM_BYTES = "zqstampvictim\n";
/** The action the stamp writer records when a stamp write is refused. */
const STAMP_REFUSAL_ACTION = "bind-advisory-stamp-refused";

/**
 * Exactly one refusal record for a stamp write that did not happen, naming
 * the path it did not happen at. The consequence is the same whichever half
 * of the write refused — the stamp stays unwritten, every later session
 * refuses it again, and the TTL debounce is dead — so the record is owed at
 * both halves, and §5.2 forbids the silently degraded state that dropping it
 * leaves. `readAuditLines` throws where the sink was never created at all,
 * which is itself the shape this helper exists to redden: a refusal composed
 * nowhere writes nothing anywhere.
 */
function assertOneStampRefusal(fixture: Fixture, stampPath: string, arm: string): void {
	const lines = readAuditLines(fixture);
	const records = lines
		.map((line) => JSON.parse(line) as { action?: unknown; text?: unknown })
		.filter((record) => record.action === STAMP_REFUSAL_ACTION);
	assert.equal(
		records.length,
		1,
		`${arm}: expected exactly one "${STAMP_REFUSAL_ACTION}" audit record for the refused stamp write; ` +
			`got ${JSON.stringify(records)} out of ${JSON.stringify(lines)}`,
	);
	const text = String(records[0]?.text ?? "");
	assert.equal(
		text.includes(stampPath),
		true,
		`${arm}: the refusal record does not name the stamp path ${stampPath} — a record that omits the ` +
			`object leaves the operator the consequence and no place to act (§3.11): ${text}`,
	);
}

before(async () => {
	// 1) Unbound clone — doubles as the TTL-debounce fixture (two sessions
	// against ONE seam root; entries snapshotted between runs).
	unboundFixture = buildFixture({ script: SCRIPT, linkGitjigRuntime: true });
	armGitRepo(unboundFixture);
	unboundRun1 = await runPi(unboundFixture);
	advisoriesAfterRun1 = advisoryEntries(unboundFixture);
	unboundRun2 = await runPi(unboundFixture);

	// 2) Zero-execution canary: the committed instrument at the session top is
	// replaced by an executable script that drops a canary file and prints a
	// `bound` token. The detector answers from the configuration git resolves
	// and runs no program of the repository it classifies (§5.9), so the
	// canary must stay absent AND the fixture's real state (unbound) must
	// still surface — a forged token must reach no verdict.
	canaryFixture = buildFixture({ script: SCRIPT, linkGitjigRuntime: true });
	armGitRepo(canaryFixture);
	canaryPath = join(canaryFixture.root, "zqcanary-instrument");
	writeFileSync(
		join(canaryFixture.root, INSTRUMENT_REL),
		`#!/bin/sh\n: > '${canaryPath}'\nprintf 'bound\\n'\n`,
	);
	chmodSync(join(canaryFixture.root, INSTRUMENT_REL), 0o755);
	canaryRun = await runPi(canaryFixture);

	// 3) A file at the RETIRED per-clone binding path with `core.hooksPath`
	// unset: no configured hooks path means git fires nothing, whatever sits
	// under `.gitjig/`, so the state is unbound and loud.
	retiredPathFixture = buildFixture({ script: SCRIPT, linkGitjigRuntime: true });
	armGitRepo(retiredPathFixture);
	mkdirSync(join(retiredPathFixture.root, ".gitjig"));
	writeFileSync(
		join(retiredPathFixture.root, RETIRED_BINDING_REL),
		"# zqretired file at the retired binding path\n",
	);
	retiredPathRun = await runPi(retiredPathFixture);

	// 4) A linked worktree of a bound clone, checked out at a commit that
	// PREDATES `.githooks`: the shared `core.hooksPath=.githooks` resolves
	// against each worktree's own top, and at this one there is nothing to
	// resolve. Classifying the main clone would answer `bound` and stay
	// silent, so the loud answer here is what separates the two placements
	// (§4.6). The pi fixture's runtime assets are transplanted into the
	// worktree; sessions, state seam and HOME stay at the original fixture's
	// absolute paths.
	worktreeTmp = mkdtempSync(join(tmpdir(), "gitjig-bindadv-wt-"));
	const mainRoot = join(worktreeTmp, "mainclone");
	mkdirSync(join(mainRoot, "home"), { recursive: true });
	const mainHome = join(mainRoot, "home");
	runGit(mainRoot, mainHome, ["-c", "init.defaultBranch=zqadvmain", "init", "-q"]);
	runGit(mainRoot, mainHome, ["config", "user.name", "fixture"]);
	runGit(mainRoot, mainHome, ["config", "user.email", "fixture@invalid"]);
	runGit(mainRoot, mainHome, ["config", "commit.gpgsign", "false"]);
	writeFileSync(join(mainRoot, "zqseed.txt"), "zqseed\n");
	runGit(mainRoot, mainHome, ["add", "--", "zqseed.txt"]);
	runGit(mainRoot, mainHome, ["commit", "--no-verify", "-q", "-m", "chore: seed a tree without the hooks"]);
	const preHooks = spawnSync("git", ["rev-parse", "HEAD"], { cwd: mainRoot, env: envFor(mainHome), timeout: 30_000 })
		.stdout.toString("utf8")
		.trim();
	cpSync(join(repoRoot(), ".githooks"), join(mainRoot, ".githooks"), { recursive: true });
	runGit(mainRoot, mainHome, ["add", "--", ".githooks"]);
	runGit(mainRoot, mainHome, ["commit", "--no-verify", "-q", "-m", "chore: seed the worktree checkout tree"]);
	runGit(mainRoot, mainHome, ["config", "core.hooksPath", ".githooks"]);
	const wtRoot = join(worktreeTmp, "zqworktree");
	runGit(mainRoot, mainHome, ["worktree", "add", "-q", "--detach", wtRoot, preHooks]);
	worktreeFixture = buildFixture({ script: SCRIPT, linkGitjigRuntime: true });
	cpSync(join(worktreeFixture.root, ".pi"), join(wtRoot, ".pi"), { recursive: true });
	copyFileSync(join(worktreeFixture.root, "script.json"), join(wtRoot, "script.json"));
	worktreeRun = await runPi({ ...worktreeFixture, root: wtRoot });

	// 5) Erroring detector child: a PATH shim whose `git config` exits 3 —
	// neither a resolved value nor git's own "unset" status. A compute that
	// never answered owes silence and, having earned no TTL, no stamp.
	erroringFixture = buildFixture({ script: SCRIPT, linkGitjigRuntime: true });
	armGitRepo(erroringFixture);
	erroringRun = await runPi(erroringFixture, {
		env: { PATH: `${gitShimDir(erroringFixture.root, "zqerrshim", "config", "exit 3")}:${process.env.PATH ?? ""}` },
	});

	// 6) Hanging detector child (§5.9's child bound, measured live): a PATH
	// shim whose `git rev-parse --show-toplevel` sleeps past every bound in
	// play. The timeout must reap it and the session completes, silent and
	// stampless.
	hangingGitFixture = buildFixture({ script: SCRIPT, linkGitjigRuntime: true });
	armGitRepo(hangingGitFixture);
	hangingGitRun = await runPi(hangingGitFixture, {
		env: {
			PATH: `${gitShimDir(hangingGitFixture.root, "zqgitshim", "rev-parse", "sleep 600")}:${process.env.PATH ?? ""}`,
		},
	});

	// 7) a symlink to a reader-less FIFO at the TTL stamp path: the child
	// timeout bounds only SPAWNED children, so an in-process `readFileSync`
	// on the stamp parks session start with nothing to reap. Every read the
	// detector performs before or during session_start must be lstat-gated
	// to a plain regular file under a size cap first.
	fifoStampFixture = buildFixture({ script: SCRIPT, linkGitjigRuntime: true });
	armGitRepo(fifoStampFixture);
	fifoStampTarget = join(fifoStampFixture.root, "zqstampfifo");
	spawnSync("mkfifo", [fifoStampTarget], { timeout: 30_000 });
	fifoStampPath = await stampPathFor(fifoStampFixture.stateDir, fifoStampFixture.root);
	symlinkSync(fifoStampTarget, fifoStampPath);
	fifoStampRun = await runPi(fifoStampFixture, { timeoutMs: 60_000 });

	// 8) a symlinked STATE ROOT: `mkdirSync(…, {recursive:true})` and
	// `writeFileSync` both follow a directory-level link, so the stamp
	// writer must refuse every component it would create or write through,
	// not the leaf alone.
	linkedStateRootFixture = buildFixture({ script: SCRIPT, linkGitjigRuntime: true });
	armGitRepo(linkedStateRootFixture);
	stateRootVictim = join(linkedStateRootFixture.root, "zqstaterootvictim");
	mkdirSync(stateRootVictim);
	rmSync(linkedStateRootFixture.stateDir, { recursive: true, force: true });
	symlinkSync(stateRootVictim, linkedStateRootFixture.stateDir);
	linkedStateRootRun = await runPi(linkedStateRootFixture);

	// 9) a BARE reader-less FIFO at the TTL stamp path — no link anywhere on
	// it. The write-through refusal above asks whether a component is a
	// SYMLINK and the read gate asks for a plain regular file; a FIFO is
	// neither, so it reaches the stamp WRITE, where an open on a reader-less
	// FIFO blocks with nothing for the child timeout to reap. The write must
	// be gated on file TYPE at the descriptor it opened — the shape `audit.ts`
	// already holds its own sink to.
	bareFifoStampFixture = buildFixture({ script: SCRIPT, linkGitjigRuntime: true });
	armGitRepo(bareFifoStampFixture);
	bareFifoStampPath = await stampPathFor(bareFifoStampFixture.stateDir, bareFifoStampFixture.root);
	spawnSync("mkfifo", [bareFifoStampPath], { timeout: 30_000 });
	bareFifoStampRun = await runPi(bareFifoStampFixture, { timeoutMs: 60_000 });

	// 10) a HARD-LINKED stamp carrying content — a plain regular file at the
	// stamp path, owner-only, whose inode simply carries a second name. The
	// FIFO arms above measure victim survival only on a shape the open itself
	// cannot write to; this one the open CAN write to, so it is the shape that
	// says whether the refusal really precedes the destruction. `O_TRUNC` on
	// the open empties the victim inside `open(2)` and the verdict then
	// refuses a file it has already destroyed — the whole point of holding a
	// descriptor to a verdict is that the refusal arrives BEFORE the write.
	hardLinkedStampFixture = buildFixture({ script: SCRIPT, linkGitjigRuntime: true });
	armGitRepo(hardLinkedStampFixture);
	hardLinkedStampVictim = join(hardLinkedStampFixture.root, "zqstamphardlinkvictim");
	writeFileSync(hardLinkedStampVictim, STAMP_VICTIM_BYTES);
	chmodSync(hardLinkedStampVictim, 0o600);
	hardLinkedStampPath = await stampPathFor(hardLinkedStampFixture.stateDir, hardLinkedStampFixture.root);
	linkSync(hardLinkedStampVictim, hardLinkedStampPath);
	hardLinkedStampRun = await runPi(hardLinkedStampFixture, { timeoutMs: 60_000 });

	// 11) a stamp pre-created 0644 — the honest-mistake shape, and the one the
	// sink verdict answers with a LIVE recovery (`chmod 600`). Nothing here is
	// hostile: the mode is all that fails, the write is refused, and the
	// debounce is then dead for every later session. A refusal discarded on
	// this path leaves a silently degraded state, which §5.2 forbids.
	looseModeStampFixture = buildFixture({ script: SCRIPT, linkGitjigRuntime: true });
	armGitRepo(looseModeStampFixture);
	looseModeStampPath = await stampPathFor(looseModeStampFixture.stateDir, looseModeStampFixture.root);
	writeFileSync(looseModeStampPath, STAMP_VICTIM_BYTES);
	chmodSync(looseModeStampPath, 0o644);
	looseModeStampRun = await runPi(looseModeStampFixture, { timeoutMs: 60_000 });
});

after(() => {
	for (const fixture of [
		unboundFixture,
		canaryFixture,
		retiredPathFixture,
		worktreeFixture,
		erroringFixture,
		hangingGitFixture,
		fifoStampFixture,
		linkedStateRootFixture,
		bareFifoStampFixture,
		hardLinkedStampFixture,
		looseModeStampFixture,
	]) {
		if (fixture !== undefined) {
			removeFixture(fixture);
		}
	}
	if (worktreeTmp !== undefined) {
		rmSync(worktreeTmp, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// The unbound advisory's own shape (AC5) — the state the sibling suite's
// fixtures do not carry.
// ---------------------------------------------------------------------------

describe("an unbound clone surfaces one actionable advisory (issue #68 AC5, SPEC §5.2)", { skip: IS_WINDOWS }, () => {
	it("unbound: one advisory naming the state and the re-arm command, and no consequence claim", () => {
		requireRuntimeLoaded(unboundFixture, unboundRun1, "unbound advisory");
		assert.equal(
			advisoriesAfterRun1.length,
			1,
			`expected exactly one ${ADVISORY_TYPE} entry after the first unbound session (${OWES_ADVISORY}); ` +
				`got ${JSON.stringify(advisoriesAfterRun1)}\n${diagnostics(unboundRun1)}`,
		);
		const text = JSON.stringify(advisoriesAfterRun1[0]);
		assert.equal(text.includes("unbound"), true, `the advisory does not name "unbound": ${text}`);
		assert.equal(text.includes(REARM), true, `the advisory does not name "${REARM}": ${text}`);
		const lines = advisoryLines(advisoriesAfterRun1[0] as Record<string, unknown>);
		assert.ok(
			lines.length > 0,
			`the unbound advisory carries no line naming the re-arm command, so the check below measures ` +
				`nothing: ${text}`,
		);
		for (const line of lines) {
			assert.doesNotMatch(
				line,
				CONSEQUENCE_CLAIM,
				`the unbound advisory asserts a consequence beside its state and re-arm command — the clause ` +
					`holds for some shapes behind this token and not others, and the operator who checks it and ` +
					`finds it false retires the surface (§3.11)`,
			);
		}
	});

	it("a file at the retired binding path does not make an unconfigured hooks path anything else", () => {
		// With no configured hooks path git fires nothing, whatever sits under
		// the shell's own namespace — and nothing under it is read by any
		// surface any more.
		assertOneAdvisory(
			retiredPathFixture,
			retiredPathRun,
			"unbound",
			"an unset activation is the whole verdict; no file under .gitjig/ enters it",
		);
	});
});

// ---------------------------------------------------------------------------
// The read-only detector rule (§5.9).
// ---------------------------------------------------------------------------

describe("the detector runs no program of the repository it classifies (SPEC §5.9)", { skip: IS_WINDOWS }, () => {
	it("an executable instrument planted at the session top is never run, and its forged token reaches no verdict", () => {
		// The canary file appears only if some session surface executes the
		// file at the instrument path; the forged `bound` token it prints would
		// buy permanent silence if any surface read it. A detector that
		// classified by running the repository's own bytes reddens on both.
		requireRuntimeLoaded(canaryFixture, canaryRun, "zero-execution canary");
		assert.equal(
			existsSync(canaryPath),
			false,
			"the planted instrument EXECUTED at session start — the detector answers from the configuration " +
				"git resolves and runs no program of the repository it classifies (§5.9)",
		);
		assertOneAdvisory(
			canaryFixture,
			canaryRun,
			"unbound",
			"the fixture's real state must still surface; a forged token must reach no verdict",
		);
	});

	it("BOUNDARY PIN: a hanging git child is reaped inside the bound", () => {
		// Declared pin (header note): the session COMPLETED (runPi returned),
		// which is the bound's live observable; silence and stamplessness pin
		// the degrade direction. What reddens it is a detector child spawned
		// without a timeout.
		assert.equal(
			hangingGitRun.timedOut,
			false,
			`the session did not complete while the detector's own child hung — session-start work must be ` +
				`timeout-wrapped (§5.9)\n${diagnostics(hangingGitRun)}`,
		);
		assertSilent(hangingGitFixture, hangingGitRun, "hanging git child");
	});
});

// ---------------------------------------------------------------------------
// Detector placement (§4.6): the repository the SESSION stands in.
// ---------------------------------------------------------------------------

describe("a session inside a linked worktree is classified at that worktree's own top (issue #68, SPEC §4.6)", { skip: IS_WINDOWS }, () => {
	it("a worktree checked out before the committed adapters existed surfaces one advisory, though the main clone is bound", () => {
		// The consumer resolves `core.hooksPath=.githooks` against each
		// worktree's own top. The main clone resolves it and is silent; this
		// worktree has nothing there, so a detector reading the session cwd's
		// top must be loud — the answer that separates the two placements.
		assertOneAdvisory(
			worktreeFixture,
			worktreeRun,
			"foreign-bound",
			"the detector must mirror the consumer's per-worktree resolution, not the main clone's state",
		);
	});
});

// ---------------------------------------------------------------------------
// Advisory hygiene: TTL debounce, stamp-after-success, degrade-to-silence
// (AC6, §5.9). The stamp arms read the stamp's name from the module itself.
// ---------------------------------------------------------------------------

describe("advisory hygiene: TTL, stamp-after-success, degrade-to-silence (issue #68 AC6, SPEC §5.9)", { skip: IS_WINDOWS }, () => {
	it("a second degraded session inside the TTL is debounced: still exactly one advisory in total", () => {
		requireRuntimeLoaded(unboundFixture, unboundRun2, "TTL debounce");
		const total = advisoryEntries(unboundFixture);
		assert.equal(
			advisoriesAfterRun1.length,
			1,
			`positive control: the FIRST unbound session must surface the advisory before a debounce can mean ` +
				`anything (${OWES_ADVISORY}); got ${JSON.stringify(advisoriesAfterRun1)}\n${diagnostics(unboundRun1)}`,
		);
		assert.equal(
			total.length,
			1,
			`the second session inside the TTL re-surfaced the advisory (or the first surfaced more than one); ` +
				`entries across both sessions: ${JSON.stringify(total)}\n${diagnostics(unboundRun2)}`,
		);
	});

	it("a successful compute stamps under the seam-resolved state root (never the operational root)", async () => {
		const stampPath = await stampPathFor(unboundFixture.stateDir, unboundFixture.root);
		assert.equal(
			existsSync(stampPath),
			true,
			`no TTL stamp at ${stampPath} after a successful advisory compute (stamp-after-success, §5.9)`,
		);
	});

	it("an erroring detector child degrades to silence and leaves NO stamp", async () => {
		assertSilent(erroringFixture, erroringRun, "erroring detector");
		assert.equal(
			existsSync(await stampPathFor(erroringFixture.stateDir, erroringFixture.root)),
			false,
			"an erroring compute left a stamp — the stamp may follow only a SUCCESSFUL compute (§5.9)",
		);
	});

	it("a hung, reaped repo-resolve child leaves NO stamp", async () => {
		// BOUNDARY PIN. This fixture's shim hangs `git rev-parse`, which since
		// issue #125 is the repository resolve that NAMES the stamp: it runs
		// before the compute and returns at the unresolved-top guard, so this
		// arm no longer measures stamp-after-success on the compute limb.
		// What mutation reddens it: none of the three tried, and that is the
		// declaration rather than an omission. Measured — compute guard removed,
		// this arm stays green while the erroring arm reddens; resolve guard
		// neutralized alone, both stay green, because the compute guard behind
		// it still returns; BOTH neutralized, this arm STILL stays green, since
		// the stamp is then written under a fallback key and this arm reads
		// only the classified repository's own path. It holds whatever the
		// detector does on this fixture. The compute limb is pinned by the
		// erroring arm below; the both-guards case and the wrong-key write are
		// caught by the issue #125 block's stampless arm, which reads the whole
		// state root and is the only arm here that can see a stamp filed under
		// a key it did not ask for.
		assert.equal(
			existsSync(await stampPathFor(hangingGitFixture.stateDir, hangingGitFixture.root)),
			false,
			"a hung, reaped repo-resolve child earned a TTL stamp — a session that could not name the " +
				"repository it stands in cannot key a stamp for it (§5.9, issue #125)",
		);
	});

	it("a symlink-to-FIFO at the stamp path does not park session start: the session completes and still advises", () => {
		// The stamp READ is on the session-start path, where the child
		// timeout bound reaches nothing: `readFileSync` on a FIFO with no
		// writer blocks forever inside the handler. The gate is lstat, require
		// a plain regular file, cap the size — and the surrounding try/catch
		// turns the refusal into "no fresh stamp", so the advisory for the
		// fixture's real state (unbound) still surfaces.
		assert.equal(
			fifoStampRun.timedOut,
			false,
			`the session did not complete with a FIFO at the stamp path — an in-process read on the ` +
				`session-start path must be lstat-gated before it is attempted (§5.9)\n${diagnostics(fifoStampRun)}`,
		);
		assertOneAdvisory(
			fifoStampFixture,
			fifoStampRun,
			"unbound",
			"every session-start read must be lstat-gated: an ungated stamp read parks the session",
		);
	});

	it("a SYMLINK at the stamp path is refused loudly: the link survives and one record names it", () => {
		// `O_NOFOLLOW` decides this shape inside `open(2)` — `ELOOP` — so no
		// descriptor ever reaches the sink verdict, and a refusal composed only
		// from that verdict composes nothing here. The consequence is the
		// verdict's own: the stamp stays unwritten, every later session refuses
		// it again, and the debounce is permanently dead — the silently degraded
		// state §5.2 forbids. Same consequence, same record, whichever half of
		// the write refused.
		assertOneStampRefusal(fifoStampFixture, fifoStampPath, "symlinked stamp path");
		assert.equal(
			lstatSync(fifoStampPath).isSymbolicLink(),
			true,
			"the planted symlink at the stamp path is gone — the writer replaced another writer's object " +
				"instead of refusing it (§5.5)",
		);
		assert.equal(
			lstatSync(fifoStampTarget).isFIFO(),
			true,
			"the link's target is no longer the planted FIFO — the refusal must leave another writer's " +
				"object exactly as it found it (§5.5)",
		);
	});

	it("a symlinked state root leaves the victim directory stampless: the writer guards every component it owns", async () => {
		// Positive control: the compute succeeded and the advisory surfaced,
		// so the stamp is one the writer WANTED to write and refused — not
		// one that never came up.
		assertOneAdvisory(
			linkedStateRootFixture,
			linkedStateRootRun,
			"unbound",
			"the advisory itself must still surface; only the stamp is refused",
		);
		assert.equal(
			existsSync(await stampPathFor(stateRootVictim, linkedStateRootFixture.root)),
			false,
			"the TTL stamp was written THROUGH the linked state root into the victim directory — the " +
				"write-through refusal must cover the state root and its container, not the stamp leaf alone (§5.5)",
		);
	});

	it("a BARE FIFO at the stamp path does not park session start: the session completes and still advises", () => {
		// The link guard and the read gate both miss this shape: a FIFO is not
		// a symlink, and the stamp READ refuses it (not a regular file) without
		// ever reaching the WRITE. The write is where it parks — an open on a
		// reader-less FIFO blocks, and the child-timeout bound covers only
		// spawned children, so nothing reaps this. The write must decide on the
		// descriptor's own type, which is what `O_NONBLOCK` + the `fstat`
		// verdict `audit.ts` already applies to its sink deliver.
		assert.equal(
			bareFifoStampRun.timedOut,
			false,
			`the session did not complete with a bare FIFO at the stamp path — the stamp WRITE must be ` +
				`gated on the opened descriptor's type, not on link-ness (§5.9)\n${diagnostics(bareFifoStampRun)}`,
		);
		assertOneAdvisory(
			bareFifoStampFixture,
			bareFifoStampRun,
			"unbound",
			"a refused stamp write is not a refused advisory: only the debounce is lost",
		);
		assert.equal(
			lstatSync(bareFifoStampPath).isFIFO(),
			true,
			"the planted FIFO at the stamp path is gone — the writer replaced another writer's object " +
				"instead of refusing it (§5.5)",
		);
	});

	it("a bare FIFO at the stamp path is refused loudly: one record names the path", () => {
		// The sibling arm above measures that the session does not park; this
		// one measures that the refusal is not swallowed. `O_NONBLOCK` turns the
		// reader-less open into an immediate `ENXIO` INSIDE `open(2)`, so this
		// refusal too arrives as an error rather than as a verdict on a
		// descriptor — and the debounce it leaves dead is just as permanent
		// (§5.2: no silently degraded state).
		assertOneStampRefusal(bareFifoStampFixture, bareFifoStampPath, "bare FIFO stamp path");
	});

	it("a hard-linked stamp carrying content survives the refused write byte-for-byte", () => {
		// The FIFO arms above cannot measure this: a reader-less FIFO refuses
		// the open outright, so nothing at that path could have been destroyed
		// whatever the flags said. A plain regular file the open ACCEPTS is the
		// shape that separates "refused before the write" from "emptied, then
		// refused" — and `O_TRUNC` on the open produces the second, because it
		// acts inside `open(2)`, before any `fstat` verdict can run. The victim
		// here fails exactly one dimension (its inode carries two names), so the
		// verdict refuses, and the bytes must be exactly where they were.
		assert.equal(
			hardLinkedStampRun.timedOut,
			false,
			`the session did not complete with a hard-linked stamp\n${diagnostics(hardLinkedStampRun)}`,
		);
		assertOneAdvisory(
			hardLinkedStampFixture,
			hardLinkedStampRun,
			"unbound",
			"a refused stamp write is not a refused advisory: only the debounce is lost",
		);
		assert.equal(
			readFileSync(hardLinkedStampPath, "utf8"),
			STAMP_VICTIM_BYTES,
			"the hard-linked stamp was emptied and only THEN refused — the destructive act must sit AFTER " +
				"the sink verdict, never inside the open that the verdict judges (§5.5)",
		);
		assert.equal(
			readFileSync(hardLinkedStampVictim, "utf8"),
			STAMP_VICTIM_BYTES,
			"the other name on the refused stamp's inode lost its content — the refusal is supposed to leave " +
				"another writer's object byte-identical (§5.5)",
		);
	});

	it("a stamp refused for a loose mode is RECORDED once, with the live chmod recovery (SPEC §5.2)", () => {
		// The consequence of discarding this refusal is not a lost line: the
		// stamp never becomes readable, so every later session refuses it again
		// and the TTL debounce is permanently dead — with nothing on any
		// surface to say so. §5.2 forbids exactly that silent degradation, and
		// `sinkRefusal` already composes the cause and the one live act
		// (`chmod 600`) for this, the honest-mistake shape.
		assertOneAdvisory(
			looseModeStampFixture,
			looseModeStampRun,
			"unbound",
			"a refused stamp write is not a refused advisory: only the debounce is lost",
		);
		const records = readAuditLines(looseModeStampFixture)
			.map((line) => JSON.parse(line) as { action?: unknown; text?: unknown })
			.filter((record) => record.action === STAMP_REFUSAL_ACTION);
		assert.equal(
			records.length,
			1,
			`expected exactly one "${STAMP_REFUSAL_ACTION}" audit record for the refused stamp write; got ` +
				`${JSON.stringify(records)} out of ${JSON.stringify(readAuditLines(looseModeStampFixture))}`,
		);
		const text = String(records[0]?.text ?? "");
		assert.match(
			text,
			/opened and refused before the write/,
			`the refusal record does not carry the verdict's composed cause: ${text}`,
		);
		assert.match(
			text,
			/chmod 600/,
			`the refusal record does not name the live recovery for a loose-mode stamp — a message that ` +
				`omits the one act that repairs it leaves the operator with the consequence and no fix: ${text}`,
		);
		assert.equal(
			(statSync(looseModeStampPath).mode & 0o777).toString(8),
			"644",
			"the writer changed the planted stamp's mode instead of refusing it — the advisory reports, it " +
				"does not repair another writer's object (§4.5)",
		);
	});

	it("the stamp writer mints the shell's own namespace owner-only, whatever the ambient umask (SPEC §5.5)", async () => {
		// The advisory is the FIRST creator of the state root on a clone that
		// has never written a record, so the modes it mints are the modes the
		// shell's namespace keeps: no later run tightens them. §5.5 binds
		// state at rest to the account that writes it, and a mode passed at
		// creation is a CEILING under any umask — a umask only removes bits —
		// so the permissive end is the direction that has to be pinned.
		// Driven through the module rather than a session: the harness's state
		// seam must already exist for the run to resolve at all (§5.5's
		// disposable root), so no session can measure the creation.
		const { maybeAdviseBindState } = await bindStateModule();
		const base = mkdtempSync(join(tmpdir(), "gitjig-bindumask-"));
		try {
			const container = join(base, "zqperm", ".gitjig");
			const stateRoot = join(container, "state");
			const previousUmask = process.umask(0o000);
			try {
				maybeAdviseBindState({ appendEntry: () => {} }, stateRoot);
			} finally {
				process.umask(previousUmask);
			}
			const stamp = await stampPathFor(stateRoot, repoRoot());
			assert.equal(
				existsSync(stamp),
				true,
				`positive control: no stamp under ${stateRoot} — the compute did not succeed, so every mode ` +
					`claim below would hold vacuously`,
			);
			for (const created of [join(base, "zqperm"), container, stateRoot]) {
				assert.equal(
					(statSync(created).mode & 0o777).toString(8),
					"700",
					`the advisory created ${created} under the ambient umask — every directory of the shell's ` +
						`own namespace is owner-only at creation (§5.5)`,
				);
			}
			assert.equal(
				(statSync(stamp).mode & 0o777).toString(8),
				"600",
				"the TTL stamp is readable by accounts other than the one that wrote it (§5.5)",
			);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Debounce scope (issue #125, SPEC §5.5): the stamp keys on the repository the
// advisory CLASSIFIED, never on the state root alone.
// ---------------------------------------------------------------------------

describe("the TTL debounce is scoped per classified repository (issue #125, SPEC §5.5, §5.2)", { skip: IS_WINDOWS }, () => {
	/**
	 * §5.5's fall-through disposition puts ONE shell-owned state root behind
	 * every repository a checkout is invoked against, and the obligation it
	 * incurs is that a per-repository datum carries its repository in its own
	 * key. The debounce stamp is exactly such a datum: the classification is
	 * per-cwd-repository (§4.6's detector placement, issue #68 — and that read
	 * is correct, not the defect), while the state root is per-install. Keyed
	 * on the root alone, a session in a repository the shell does not govern
	 * spends the debounce belonging to one it does, and §5.2's obligation to
	 * surface a degraded state at the next session start is not discharged.
	 *
	 * The population is the two classified repositories and the reading unit
	 * is one advisory instance per repository — never one line, never one
	 * file. No arm here re-implements the keying rule: each reads the
	 * advisories the module actually emitted, and the one arm that names the
	 * rule calls the module's own exported path function.
	 */
	function repo(base: string, name: string, hooksPath?: string): string {
		const root = join(base, name);
		mkdirSync(root);
		const opts = { cwd: root, timeout: 30_000 } as const;
		spawnSync("git", ["-c", "init.defaultBranch=zqdebmain", "init", "-q"], opts);
		if (hooksPath !== undefined) {
			mkdirSync(join(root, hooksPath));
			spawnSync("git", ["config", "core.hooksPath", hooksPath], opts);
		}
		return realpathSync(root);
	}

	/** Run one session_start in `cwd` against `stateRoot`; return the states advised. */
	async function advise(cwd: string, stateRoot: string): Promise<string[]> {
		const { maybeAdviseBindState } = await bindStateModule();
		const seen: string[] = [];
		const previousCwd = process.cwd();
		try {
			process.chdir(cwd);
			maybeAdviseBindState({ appendEntry: (_t, p) => seen.push((p as { state: string }).state) }, stateRoot);
		} finally {
			process.chdir(previousCwd);
		}
		return seen;
	}

	function scratch(): string {
		return mkdtempSync(join(tmpdir(), "gitjig-debouncescope-"));
	}

	it("a session in an UNADOPTED repository does not spend the governed repository's debounce", async () => {
		const base = scratch();
		try {
			// `unadopted`: an ordinary git repository that never adopted the
			// shell — no hooks path at all, so `unbound`. `governed`: a clone
			// whose effective hooks path does not resolve to this repository's
			// committed adapters, so `foreign-bound`. Two DIFFERENT degraded
			// tokens, so the assertion below cannot be satisfied by counting
			// the unadopted repository's own advisory twice.
			const unadopted = repo(base, "zqunadopted");
			const governed = repo(base, "zqgoverned", "zqforeignhooks");
			const stateRoot = join(base, "state");

			const controlBase = scratch();
			try {
				// Positive control, on a FRESH root: the governed repository
				// owes an advisory on its own. Without this, the arm's real
				// assertion would hold vacuously if that repository were
				// silent for some reason having nothing to do with the stamp.
				assert.deepEqual(
					await advise(governed, join(controlBase, "state")),
					["foreign-bound"],
					"positive control: the governed repository must surface foreign-bound against a state root " +
						"no other repository has stamped — every claim below is vacuous if it does not",
				);
			} finally {
				rmSync(controlBase, { recursive: true, force: true });
			}

			const first = await advise(unadopted, stateRoot);
			const second = await advise(governed, stateRoot);

			assert.deepEqual(
				first,
				["unbound"],
				`positive control: the unadopted repository must surface first for its stamp to suppress ` +
					`anything; got ${JSON.stringify(first)}`,
			);
			assert.deepEqual(
				second,
				["foreign-bound"],
				`a session in a repository the shell does not govern spent the debounce belonging to one it ` +
					`does: the governed clone is degraded and surfaced ${JSON.stringify(second)} instead of its ` +
					`own advisory. One shell-owned state root serves every repository (§5.5's fall-through ` +
					`disposition), so the stamp must carry the repository it classified (§5.2, issue #125)`,
			);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("keying the stamp does not disable the debounce: a REPEAT session in one repository stays silent", async () => {
		// Discrimination, not detection. Deleting the stamp read altogether
		// passes the arm above and breaks the TTL contract §5.9 sets; this is
		// the arm that separates a scoped debounce from an absent one.
		const base = scratch();
		try {
			const governed = repo(base, "zqrepeat", "zqforeignhooks");
			const stateRoot = join(base, "state");
			assert.deepEqual(
				await advise(governed, stateRoot),
				["foreign-bound"],
				"positive control: the first session must advise before a debounce can mean anything",
			);
			assert.deepEqual(
				await advise(governed, stateRoot),
				[],
				"the SAME repository re-surfaced its advisory inside the TTL — the debounce is scoped away " +
					"rather than scoped correctly (§5.9's cadence)",
			);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("a session whose repository cannot be resolved writes NO stamp anywhere under the state root", async () => {
		// The RESOLVE limb of stamp-after-success, and the reason this arm
		// reads the whole state root instead of one keyed path: a keyed read
		// cannot see a stamp written under the WRONG key, which is precisely
		// how this limb fails. The sibling hung-child arm is keyed and is
		// declared a boundary pin for exactly that reason.
		//
		// The cwd is a scratch directory under the system temp root and so is
		// inside no git repository: `rev-parse --show-toplevel` fails, the top
		// is unresolvable, and a session that cannot name the repository it
		// stands in must not key a stamp for it (§5.9, issue #125).
		const base = scratch();
		try {
			const stateRoot = join(base, "state");
			mkdirSync(stateRoot, { recursive: true });
			// Positive control, and this arm needs one more than its siblings do:
			// its own two assertions are both ABSENCES, which an entry point that
			// did nothing at all would satisfy. Measured — with the entry point
			// replaced by an immediate return, 17 of this file's arms redden and
			// this one stayed green until this control was added. So one
			// resolvable repository in a degraded state advises and stamps first,
			// against this same state root: the absences below then mean the
			// unresolvable session was refused, not that nothing ran.
			const live = repo(base, "zqcontrol", "zqforeignhooks");
			assert.deepEqual(
				await advise(live, stateRoot),
				["foreign-bound"],
				"positive control: the entry point must advise for a repository it CAN resolve, or the " +
					"absences this arm asserts hold for a runtime that never ran",
			);
			assert.deepEqual(
				readdirSync(stateRoot).length,
				1,
				"positive control: the resolvable session must leave exactly one stamp, so the emptiness " +
					"asserted below is a refusal to stamp and not a state root nothing ever reached",
			);
			const afterControl = readdirSync(stateRoot);
			assert.deepEqual(
				await advise(base, stateRoot),
				[],
				"a session standing outside any repository surfaced an advisory about one",
			);
			assert.deepEqual(
				readdirSync(stateRoot),
				afterControl,
				`an unresolvable repository earned a TTL stamp: the state root gained ` +
					`${JSON.stringify(readdirSync(stateRoot).filter((e) => !afterControl.includes(e)))}. ` +
					`Only a SUCCESSFUL compute stamps (§5.9), and a stamp under any key at all here is one ` +
					`written for a repository the session could not name (issue #125)`,
			);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("the key is repository-granular, not directory-granular: a subdirectory shares the debounce", async () => {
		// GRANULARITY, which is a different property from the separation the
		// first arm measures. Those arms discriminate BETWEEN repositories and
		// stay green if the key is the raw cwd, because two repositories have
		// two cwds as surely as they have two tops. What only this arm sees is
		// keying one repository under several names: `BIND_ADVISORY_TTL_MS`
		// promises at most one compute per classified repository per hour, and
		// §5.5 asks the datum to carry "the repository it concerns" — a
		// subdirectory is the same repository, so it must not earn a second
		// advisory.
		//
		// A symlinked spelling was tried here and REMOVED as inert rather than
		// left as decoration: this arm reaches the module through
		// `process.chdir`, and `getcwd(3)` answers with the physical path, so
		// the module is handed bytes identical to the first session's and no
		// keying function whatever could be discriminated by it. Measured —
		// `process.chdir("…/linkdir"); process.cwd()` yields `…/realdir`; and
		// with the subdirectory limb dropped, the raw-cwd mutant this arm
		// exists to kill survives the whole suite. The subdirectory limb
		// carries all of this arm's teeth.
		const base = scratch();
		try {
			const top = repo(base, "zqgranular", "zqforeignhooks");
			const sub = join(top, "zqsubdir");
			mkdirSync(sub);
			const stateRoot = join(base, "state");

			assert.deepEqual(
				await advise(top, stateRoot),
				["foreign-bound"],
				"positive control: the repository must advise from its own top before a shared debounce can " +
					"mean anything",
			);
			assert.deepEqual(
				await advise(sub, stateRoot),
				[],
				`a session in a subdirectory of it earned a second advisory inside the TTL: the key is ` +
					`granular per DIRECTORY rather than per repository, so one repository debounces under as ` +
					`many keys as it has directories (§5.5's "the repository it concerns"; §5.9's cadence)`,
			);
			assert.deepEqual(
				readdirSync(stateRoot).length,
				1,
				`two sessions in ONE repository left ${JSON.stringify(readdirSync(stateRoot))} — one ` +
					`repository owns one stamp, whatever directory within it reached the advisory`,
			);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("the module's own stamp path separates two repositories under one state root", async () => {
		// The rule this suite binds to is the module's, called — never a
		// second copy of the keying spelled here (§3.11's converged-readers
		// argument, applied to an arm).
		const base = scratch();
		try {
			const { bindAdvisoryStampPath } = await bindStateModule();
			const stateRoot = join(base, "state");
			const a = bindAdvisoryStampPath(stateRoot, join(base, "zqalpha"));
			const b = bindAdvisoryStampPath(stateRoot, join(base, "zqbeta"));
			assert.notEqual(a, b, `two repositories share one stamp path under ${stateRoot}: ${a}`);
			for (const [label, path] of [["alpha", a], ["beta", b]] as const) {
				assert.equal(
					dirname(path),
					stateRoot,
					`the ${label} stamp escaped the state root it was keyed under: ${path}`,
				);
			}
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

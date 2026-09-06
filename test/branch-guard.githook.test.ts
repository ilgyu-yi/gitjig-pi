/**
 * Behavioral suite for the protected-branch class at the pre-push adapter
 * (issue #59 ACs; SPEC §3.3 ref-identity semantics, §3.9, §3.11).
 *
 * Subject under test: the COMMITTED local-tier chain — this repository's
 * `.githooks/pre-push` + `.githooks/_lib.sh`, copied byte-for-byte into a
 * disposable git repository by `harness/githook-fixture.ts` and driven only
 * through `git push` against a fixture-local bare remote (the arms measure
 * the chain an operator runs, never a predicate called directly).
 *
 * ARMED-CHAIN ASSERTIONS. Every refuse- and record-shaped arm below asserts
 * the armed contract: while `.githooks/helpers/branch_guard.sh` is absent
 * from the tree, the chain falls through `githook_source`'s fail-open branch
 * to `exit 0` and every guarded push SUCCEEDS with no block record — those
 * arms are red by design until the helper lands (§1.2 failing-first). The
 * allow-shaped and degradation-shaped arms are boundary pins, green in BOTH
 * tree states: they pin the floor the fix must not break, never the fix.
 *
 * Environment constraints stated in place:
 *   - The protected identity uses a DISTINCTIVE branch name (never `main`):
 *     the content-free assertions check that the refname's bytes reach no
 *     refusal surface, and a common word would collide with incidental git
 *     output (paths, unrelated stderr) instead of measuring the chain.
 *   - The case-variant arm asserts on block-record presence and cause
 *     shape, NEVER on the push exit status: on a case-insensitive local
 *     filesystem the bare remote's own ref storage can reject the variant
 *     inside git itself, so the exit status does not separate the hook's
 *     refusal from the transport's.
 *   - The multi-ref arm's stdin shape is a constraint on git, stated at the
 *     arm: existing-ref updates reach pre-push stdin ordered by remote
 *     refname bytes (creations arrive after updates), so a companion ref
 *     that byte-sorts before the protected name puts the protected name
 *     beyond line 1 — the line a single-read adapter would never inspect.
 *   - Causes and audit records are compared by decimal-normalized shape,
 *     never by string: the helper is free to word its causes, but the
 *     ambiguous-destination refusal must stay distinguishable at the
 *     observable from the byte-equal refusal (§3.9).
 *   - `refs/remotes/origin/HEAD` is the derivation's stage-1 source; the
 *     fixture omits it (`omitHeadPointer`) for the stage-2 arms and dangles
 *     the remote's own HEAD (`danglingRemoteHead`) for the both-stages-fail
 *     arm, where `ls-remote --symref origin HEAD` yields empty output with
 *     exit 0.
 *   - POSIX bytes and bash are required throughout: the suite skips on
 *     win32.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	buildGithookFixture,
	type CommitAttempt,
	commitWithMessage,
	removeDelegatedHelpers,
	fixtureGit,
	type GithookFixture,
	pushRefs,
	removeGithookFixture,
	seedLocalCommit,
} from "./harness/githook-fixture.ts";
import { repoRoot } from "./harness/run-pi.ts";

const IS_WINDOWS = process.platform === "win32";

/** The derived protected identity P — distinctive on purpose (header note). */
const PROTECTED = "zqtrunkzq";
/** ASCII-case-fold-equal to P, byte-unequal — the ambiguous destination. */
const PROTECTED_VARIANT = "ZQTRUNKZQ";
/** Byte-sorts before PROTECTED — holds stdin line 1 in the multi-ref arm. */
const COMPANION = "aacompanionzq";

/**
 * Decimal-normalized cause shape: two causes that differ only in a measured
 * number are the SAME shape (mirrors the sibling commit-format suite).
 */
function causeShape(cause: string): string {
	return cause.trim().replace(/\d+/g, "N");
}

/**
 * The refusal observable (§3.3 byte-equal arm): a block audit record naming
 * the branch class, the adapter's live recovery line on stderr, and — unless
 * the caller opts out (case-variant arm, header note) — a non-zero push.
 * While the helper is absent these arms fail HERE, at the record assertion:
 * the push falls through fail-open and appends no block record.
 */
function assertPushRefused(
	attempt: CommitAttempt,
	arm: string,
	opts: { checkExit?: boolean } = {},
): void {
	assert.match(
		attempt.auditDelta,
		/\bblock\b.*\bbranch\b/,
		`${arm}: no block record naming the branch class was appended — the push fell through the ` +
			`fail-open chain (red until .githooks/helpers/branch_guard.sh lands and is_protected_branch ` +
			`refuses this target); delta: ${JSON.stringify(attempt.auditDelta)}`,
	);
	if (opts.checkExit !== false) {
		assert.notEqual(attempt.status, 0, `${arm}: the guarded push SUCCEEDED through the chain`);
	}
	assert.match(
		attempt.stderr,
		/\[dev-shell\]/,
		`${arm}: the refusal reached the operator without the adapter's live recovery line (§3.11 arm-scoped remediation)`,
	);
}

/**
 * Content-free surfaces (§3.9): a refusal names its arm, never the actor's
 * refname bytes — neither on stderr nor in the audit record.
 */
function assertRefnameContentFree(attempt: CommitAttempt, refname: string, arm: string): void {
	const bytes = Buffer.from(refname, "utf8");
	assert.equal(
		attempt.stderrBytes.includes(bytes),
		false,
		`${arm}: the target refname's bytes reached stderr — causes are content-free constants (§3.9)`,
	);
	assert.equal(
		Buffer.from(attempt.auditDelta, "utf8").includes(bytes),
		false,
		`${arm}: the target refname's bytes reached the audit record — records are content-free (§3.9)`,
	);
}

/**
 * The ordinary-allow observable (§3.3 "anything else" arm): push succeeds,
 * no block record, no disarmed-gate ("not enforced") record. A
 * `helper-missing` warn from `safe_source`'s fail-open is OUT of this arm's
 * scope: it is the sourcing tier's own degradation record, present exactly
 * while the helper file is absent, and pinning total record silence would
 * falsely bind this boundary pin to one tree state.
 */
function assertPushAllowedOrdinarily(attempt: CommitAttempt, arm: string): void {
	assert.equal(attempt.status, 0, `${arm}: ${attempt.stderr}`);
	assert.doesNotMatch(
		attempt.auditDelta,
		/\bblock\b/,
		`${arm}: an ordinary allow appended a block record; delta: ${JSON.stringify(attempt.auditDelta)}`,
	);
	assert.equal(
		attempt.auditDelta.includes("not enforced"),
		false,
		`${arm}: an ordinary allow carried the disarmed-gate signal — the two allows must stay separable (§3.9)`,
	);
}

describe("pushes targeting the derived protected identity refuse (issue #59)", { skip: IS_WINDOWS }, () => {
	it("a push to the protected identity is refused, content-free", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			seedLocalCommit(fixture);
			const attempt = pushRefs(fixture, [PROTECTED]);
			assertPushRefused(attempt, "push to P");
			assertRefnameContentFree(attempt, PROTECTED, "push to P");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a deletion push of the protected identity is refused (the remote-ref column carries the real refname)", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			const attempt = pushRefs(fixture, [`:${PROTECTED}`]);
			assertPushRefused(attempt, "delete P");
			assertRefnameContentFree(attempt, PROTECTED, "delete P");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a multi-ref push carrying the protected identity beyond stdin line 1 is refused (the while-read loop is load-bearing)", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			// Create the companion first — its target is not P, so this push is
			// allowed in both tree states and turns the guarded push below into
			// two EXISTING-ref updates, the shape whose stdin lines git orders
			// by remote refname bytes (header note): COMPANION on line 1, the
			// protected name beyond it.
			const companionCreate = pushRefs(fixture, [`${PROTECTED}:${COMPANION}`]);
			assert.equal(companionCreate.status, 0, companionCreate.stderr);
			seedLocalCommit(fixture);
			const attempt = pushRefs(fixture, [`${PROTECTED}:${COMPANION}`, PROTECTED]);
			assertPushRefused(attempt, "multi-ref with P beyond line 1");
			assertRefnameContentFree(attempt, PROTECTED, "multi-ref with P beyond line 1");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a force-push to the protected identity is refused by subsumption (the ref is protected; --force changes nothing)", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			seedLocalCommit(fixture);
			const attempt = pushRefs(fixture, [PROTECTED], { gitArgs: ["--force"] });
			assertPushRefused(attempt, "force-push to P");
			assertRefnameContentFree(attempt, PROTECTED, "force-push to P");
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

describe("a case-variant of the protected identity refuses as ambiguous (issue #59, SPEC §3.9)", { skip: IS_WINDOWS }, () => {
	let fixture: GithookFixture;
	let byteEqualRefusal: CommitAttempt;
	let variantRefusal: CommitAttempt;

	before(() => {
		fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		seedLocalCommit(fixture);
		byteEqualRefusal = pushRefs(fixture, [PROTECTED]);
		variantRefusal = pushRefs(fixture, [`${PROTECTED}:${PROTECTED_VARIANT}`]);
	});
	after(() => removeGithookFixture(fixture));

	it("the case-variant push lands a block record (exit status is not the observable — header note)", () => {
		assertPushRefused(variantRefusal, "case-variant of P", { checkExit: false });
	});

	it("the ambiguous-destination cause is distinct from the byte-equal cause", () => {
		// The refusal preconditions repeat on purpose: on a tree where the
		// pushes still fall through fail-open, git's own transport lines would
		// green a bare shape comparison vacuously.
		assertPushRefused(byteEqualRefusal, "push to P (reference refusal)");
		assertPushRefused(variantRefusal, "case-variant of P", { checkExit: false });
		assert.notEqual(variantRefusal.cause, "", "an ambiguity refusal owes its own cause line");
		assert.notEqual(
			causeShape(variantRefusal.cause),
			causeShape(byteEqualRefusal.cause),
			"the ambiguous-destination cause reuses the byte-equal shape — the two §3.3 arms must stay " +
				"distinguishable at the observable",
		);
	});

	it("neither spelling's bytes surface on the refusal record", () => {
		assertPushRefused(variantRefusal, "case-variant of P", { checkExit: false });
		assertRefnameContentFree(variantRefusal, PROTECTED_VARIANT, "case-variant of P");
		assertRefnameContentFree(variantRefusal, PROTECTED, "case-variant of P");
	});
});

describe("derivation of the protected identity (issue #59, SPEC §3.3 stage 2, §3.9)", { skip: IS_WINDOWS }, () => {
	it("pointer absent, remote reachable: stage 2 derives P and the push is still refused", () => {
		const fixture = buildGithookFixture({
			remote: { defaultBranch: PROTECTED, omitHeadPointer: true },
		});
		try {
			seedLocalCommit(fixture);
			const attempt = pushRefs(fixture, [PROTECTED]);
			assertPushRefused(attempt, "stage-2 derivation");
			assertRefnameContentFree(attempt, PROTECTED, "stage-2 derivation");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("both stages fail: the push is allowed and ONE warn record says the gate is not enforced", () => {
		const fixture = buildGithookFixture({
			remote: { defaultBranch: PROTECTED, omitHeadPointer: true, danglingRemoteHead: true },
		});
		try {
			seedLocalCommit(fixture);
			const attempt = pushRefs(fixture, [PROTECTED]);
			// The allow itself holds in both tree states; the SIGNAL is what
			// separates this disarmed allow from an ordinary allow (§3.9's
			// degradation-signal rule) and is red until the helper lands.
			assert.equal(attempt.status, 0, `disarmed gate must fail open, never block: ${attempt.stderr}`);
			const notEnforced = attempt.auditDelta.split("\n").filter((line) => line.includes("not enforced"));
			assert.equal(
				notEnforced.length,
				1,
				`disarmed allow: expected exactly one audit record stating the gate is not enforced; ` +
					`delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
			assert.match(notEnforced[0], /\bwarn\b/, "the disarmed-gate record is a warn, never a block");
			assert.doesNotMatch(
				attempt.auditDelta,
				/\bblock\b/,
				`P underivable is machinery degradation, never a refusal of the actor's input (§3.9); ` +
					`delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

// ---------------------------------------------------------------------------
// The gate's own repairs, pinned (issue #63, SPEC §3.12 — a surviving mutant
// means no assertion pins that guard).
//
// These three arms are GREEN on the landed tree by construction: each pins a
// repair that is already correct here, so none is red-first. Each is a
// regression check whose teeth are demonstrated against a named mutant, and
// the mutant is recorded beside the arm so a later reader can re-run it
// rather than trust this sentence.
// ---------------------------------------------------------------------------

describe("the push gate's own repairs are pinned (issue #63, SPEC §3.12)", { skip: IS_WINDOWS }, () => {
	it("a pre-seeded derivation cache in the push environment cannot decide the verdict", () => {
		// git hands the PUSHER's environment to hooks, so an exported
		// _GITJIG_BG_* pair would otherwise pre-seed the verdict three ways:
		// a traceless disarm (state=disarmed, no warn record emitted), a decoy
		// identity (P set to something that is not the protected ref), and a
		// set -u abort. The helper's source-time `unset -v` discards them.
		// MUTANT: delete that line from branch_guard.sh — the decoy P is then
		// consulted, the push to the real P is allowed, and this arm reds.
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			seedLocalCommit(fixture);
			const attempt = pushRefs(fixture, [PROTECTED], {
				env: { _GITJIG_BG_STATE: "armed", _GITJIG_BG_P: "aadecoyzq" },
			});
			assertPushRefused(attempt, "pre-seeded decoy identity");
			assertRefnameContentFree(attempt, PROTECTED, "pre-seeded decoy identity");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a pre-seeded disarmed state cannot disarm the gate tracelessly", () => {
		// The seed's other direction: state=disarmed short-circuits derivation
		// on the cache branch, which returns non-zero WITHOUT emitting the warn
		// record — an allow indistinguishable from an ordinary one, which is
		// exactly the observable §3.9 requires a disarmed gate to produce.
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			seedLocalCommit(fixture);
			const attempt = pushRefs(fixture, [PROTECTED], {
				env: { _GITJIG_BG_STATE: "disarmed" },
			});
			assertPushRefused(attempt, "pre-seeded traceless disarm");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("the disarmed gate lands exactly one not-enforced record for a MULTI-ref push", () => {
		// The record count was asserted on single-ref pushes only, where a
		// record-per-ref mutant is invisible: one ref, one record either way.
		// The adapter calls its predicate once per ref line, so the cached
		// disarmed state is what keeps the count at one across refs.
		// MUTANT: emit the warn from the per-ref path instead of the cache
		// miss — the count becomes two here while every single-ref arm stays
		// green.
		const fixture = buildGithookFixture({
			remote: { defaultBranch: PROTECTED, omitHeadPointer: true, danglingRemoteHead: true },
		});
		try {
			const companionCreate = pushRefs(fixture, [`${PROTECTED}:${COMPANION}`]);
			assert.equal(companionCreate.status, 0, companionCreate.stderr);
			seedLocalCommit(fixture);
			const attempt = pushRefs(fixture, [`${PROTECTED}:${COMPANION}`, PROTECTED]);
			assert.equal(attempt.status, 0, `disarmed gate must fail open, never block: ${attempt.stderr}`);
			// The arm's own premise, asserted rather than assumed: TWO refs
			// reached the hook. If a fixture change ever made either refspec
			// up to date, this would silently become a single-ref arm — green
			// for a reason other than the one it names, with the record-per-ref
			// mutant surviving it.
			const refLines = attempt.stderr.split("\n").filter((line) => /^ [ *+=!-]\s/.test(line));
			assert.equal(
				refLines.length,
				2,
				`the push carried ${refLines.length} ref update(s), not 2 — this arm measures a MULTI-ref push ` +
					`and cannot discriminate per-run from per-ref on one ref: ${JSON.stringify(attempt.stderr)}`,
			);
			const notEnforced = attempt.auditDelta.split("\n").filter((line) => line.includes("not enforced"));
			assert.equal(
				notEnforced.length,
				1,
				`a multi-ref push through the disarmed gate landed ${notEnforced.length} not-enforced records; ` +
					`the signal is one per RUN, not one per ref, or a reader counts machinery degradation by how ` +
					`many refs a push happened to carry (§3.9): ${JSON.stringify(attempt.auditDelta)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("the block helper's audit subshell is stdin-starved on the ref-iterating path", () => {
		// STRUCTURAL, same instrument and same reason as the prompt-guard arm
		// below: the property is unobservable today because nothing inside
		// that subshell reads stdin, so a behavioural arm would pass with and
		// without the redirect. Pinned here rather than left unpinned, so the
		// token cannot be dropped silently the moment some binding's audit_log
		// grows a stdin read (issue #63 item 6).
		const lib = readFileSync(join(repoRoot(), ".githooks", "_lib.sh"), "utf8");
		const blockAudit = lib
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("#"))
			.filter((line) => line.includes("audit_log block"));
		assert.equal(blockAudit.length, 1, `expected exactly one block audit site: ${JSON.stringify(blockAudit)}`);
		assert.match(
			blockAudit[0],
			/<\/dev\/null/,
			`githook_block's audit subshell inherits the hook's stdin — on the push surface that stream is the ` +
				`ref lines the adapter iterates, so a child reading it removes refs from the iteration and the ` +
				`arm measures fewer than the push carries: ${JSON.stringify(blockAudit[0])}`,
		);
	});

	it("the stage-2 remote measurement disables terminal prompting on its own call", () => {
		// STRUCTURAL, and recorded as such (§1.5), naming what it substitutes
		// for: a behavioural arm observing that no prompt appears. Nothing
		// this fixture can reach prompts — the remote is a local path with no
		// authentication — so no push through this harness distinguishes a
		// helper that disables prompting from one that does not. (A prompting
		// remote is constructible without network egress, so the ground is
		// this fixture's shape, not offline-ness; what disqualifies building
		// one here is that the negative branch reads the operator's terminal
		// and can wedge the suite.) What CAN be pinned is
		// that the one remote-touching call carries the guard on itself rather
		// than inheriting it from an ambient environment, which is the property
		// the fixture's own base env was masking.
		// MUTANT: delete GIT_TERMINAL_PROMPT=0 from the ls-remote call — this
		// arm reds; before this arm existed, no arm did.
		const helper = readFileSync(join(repoRoot(), ".githooks", "helpers", "branch_guard.sh"), "utf8");
		const lsRemote = helper
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("#"))
			.filter((line) => line.includes("ls-remote"));
		assert.equal(lsRemote.length, 1, `expected exactly one ls-remote call site: ${JSON.stringify(lsRemote)}`);
		assert.match(
			lsRemote[0],
			/GIT_TERMINAL_PROMPT=0 git ls-remote/,
			`the stage-2 measurement does not disable terminal prompting on its own call, so it prompts wherever ` +
				`the invoking environment did not already disable it — and a hook that blocks on a prompt wedges ` +
				`the push it was meant to decide (§3.3's stage-2 statement): ${JSON.stringify(lsRemote[0])}`,
		);
	});

	it("CONTROL: the verdict is unchanged when the base stops supplying the prompt guard", () => {
		// A CONTROL, not a pin. The fixture's base env set GIT_TERMINAL_PROMPT
		// itself, masking the helper's copy; this shows the strip works and the
		// hook path runs unchanged on the helper's own guard. It reds under no
		// mutant of that guard — the fixture's remote is a local path, so the
		// deletion mutant leaves this green — and it adds no discrimination
		// over the stage-2 arm above. The pin is the structural arm; this arm
		// exists so the mask's removal is itself exercised.
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED, omitHeadPointer: true } });
		try {
			seedLocalCommit(fixture);
			const attempt = pushRefs(fixture, [PROTECTED], { stripEnv: ["GIT_TERMINAL_PROMPT"] });
			assertPushRefused(attempt, "unmasked prompt guard");
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

describe("boundary pins — green in both tree states (issue #59)", { skip: IS_WINDOWS }, () => {
	// Every arm here pins the floor the armed helper must not break: they
	// hold while `.githooks/helpers/branch_guard.sh` is absent (fail-open
	// chain) AND after it lands (the §3.3 allow/degradation dispositions).
	// None of them is a red-first claim.

	it("a feature-branch push is allowed with no block and no disarmed-gate record", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			const attempt = pushRefs(fixture, [`${PROTECTED}:aafeaturezq`]);
			assertPushAllowedOrdinarily(attempt, "feature push");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a force-push to a feature ref is allowed (subsumption's other half)", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			const attempt = pushRefs(fixture, [`${PROTECTED}:aaforcedzq`], { gitArgs: ["--force"] });
			assertPushAllowedOrdinarily(attempt, "force-push to a feature ref");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a tag push is allowed: a non-branch ref arrives unstripped and can never equal a branch name", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			fixtureGit(fixture, ["tag", "v1zq"]);
			const attempt = pushRefs(fixture, ["v1zq"]);
			assertPushAllowedOrdinarily(attempt, "tag push");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("helper file absent: the push no-ops open, even to the protected identity", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		removeDelegatedHelpers(fixture);
		try {
			seedLocalCommit(fixture);
			const attempt = pushRefs(fixture, [PROTECTED]);
			assert.equal(
				attempt.status,
				0,
				`an absent helper must degrade to allow, never to a false block (githook_source fail-open): ${attempt.stderr}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("helper present without is_protected_branch: the push no-ops open via githook_require", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		removeDelegatedHelpers(fixture);
		try {
			writeFileSync(
				join(fixture.helpersDir, "branch_guard.sh"),
				"# stub helper: sources cleanly, defines everything except the delegated function\nunrelated_helper_function() { :; }\n",
			);
			seedLocalCommit(fixture);
			const attempt = pushRefs(fixture, [PROTECTED]);
			assert.equal(
				attempt.status,
				0,
				`a helper without the delegated function must degrade to allow via githook_require: ${attempt.stderr}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

});

describe("current_branch detached-HEAD contract (issue #59, SPEC §3.9)", { skip: IS_WINDOWS }, () => {
	it("on a detached HEAD, current_branch prints nothing and exits non-zero (direct source)", () => {
		// Direct-source is deliberate and stated: through the live adapter a
		// detached HEAD reaches is_protected_branch as an empty identity and
		// resolves to an ordinary allow, indistinguishable at the commit
		// observable from any feature-branch commit — the function's own
		// contract (prints nothing, exits non-zero) is reachable only by
		// calling it. The existence gate below keeps the arm vacuous only
		// while the helper file is absent.
		const helperPath = join(repoRoot(), ".githooks", "helpers", "branch_guard.sh");
		if (!existsSync(helperPath)) {
			return;
		}
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			fixtureGit(fixture, ["checkout", "-q", "--detach"]);
			const probe = spawnSync(
				"bash",
				[
					"-c",
					'set -u; . "$1" || exit 97; _gb_out="$(current_branch)"; _gb_rc=$?; printf \'%s\' "$_gb_out"; exit "$_gb_rc"',
					"bash",
					helperPath,
				],
				{
					cwd: fixture.root,
					env: {
						PATH: process.env.PATH ?? "",
						HOME: join(fixture.root, "home"),
						GIT_CONFIG_NOSYSTEM: "1",
					},
				},
			);
			assert.notEqual(probe.status, 97, "branch_guard.sh failed to source in isolation");
			assert.notEqual(
				probe.status,
				0,
				"current_branch claimed success on a detached HEAD — a total function owes the failure outcome (§3.9)",
			);
			assert.equal(
				(probe.stdout ?? Buffer.alloc(0)).toString("utf8"),
				"",
				"current_branch printed output on a detached HEAD — no consumer may read an unvalidated value (§3.9)",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

/**
 * The COMMIT surface's subject (issue #113; SPEC §3.3's commit-arm
 * paragraph, §3.9's total-function rule, §5.9's disarm bar).
 *
 * Subject under test: `.githooks/pre-commit`'s protected-branch arm driven
 * through `git commit`, never by calling the predicate. The axis these arms
 * hold that the sibling describe above does not: what the ADAPTER does with
 * a total function that failed. A detached `HEAD` has no branch, so the arm
 * has no subject; the scope decision is that it allows, and §5.9's bar is
 * discharged by ONE audit record — audit-only, since a scope boundary must
 * not borrow §3.9's degradation wording and misattribute a cause.
 *
 * ARMED-CHAIN ASSERTIONS: red by design until the adapter observes
 * `current_branch`'s status.
 */
describe("the commit arm's subject and the detached-HEAD scope (issue #113)", { skip: IS_WINDOWS }, () => {
	/** Records this arm writes when it has no subject — the §5.9 observable. */
	function unevaluatedRecords(attempt: CommitAttempt): string[] {
		return attempt.auditDelta
			.split("\n")
			.filter((line) => line.includes("not evaluated") && line.includes("branch"));
	}

	function blockRecords(attempt: CommitAttempt): string[] {
		return attempt.auditDelta.split("\n").filter((line) => line.includes('"block"'));
	}

	function unevaluatedIn(delta: string): string[] {
		return delta.split("\n").filter((line) => line.includes("not evaluated") && line.includes("branch"));
	}

	function auditLength(fixture: GithookFixture): number {
		return existsSync(fixture.auditFile) ? readFileSync(fixture.auditFile, "utf8").length : 0;
	}

	function auditSince(fixture: GithookFixture, before: number): string {
		return existsSync(fixture.auditFile) ? readFileSync(fixture.auditFile, "utf8").slice(before) : "";
	}

	function revParse(fixture: GithookFixture, ref: string): string {
		const out = spawnSync("git", ["rev-parse", ref], {
			cwd: fixture.root,
			env: { PATH: process.env.PATH ?? "", HOME: join(fixture.root, "home"), GIT_CONFIG_NOSYSTEM: "1" },
		});
		return (out.stdout ?? Buffer.alloc(0)).toString("utf8").trim();
	}

	/** Two commits on P, made with the tier unbound so the seeding writes no records. */
	function seedReplayableHistory(fixture: GithookFixture): void {
		for (let i = 0; i < 2; i += 1) {
			writeFileSync(join(fixture.root, `r${i}.txt`), `r${i}\n`);
			fixtureGit(fixture, ["add", `r${i}.txt`]);
			fixtureGit(fixture, ["-c", "core.hooksPath=", "commit", "-q", "-m", `feat(#113): r${i}`]);
		}
	}

	function rebaseWithExec(fixture: GithookFixture, exec: string) {
		return spawnSync("git", ["rebase", "-f", "HEAD~2", "--exec", exec], {
			cwd: fixture.root,
			env: { PATH: process.env.PATH ?? "", HOME: join(fixture.root, "home"), GIT_CONFIG_NOSYSTEM: "1" },
		});
	}

	it("a commit ON the protected identity refuses — the arm has its subject", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			const attempt = commitWithMessage(fixture, `feat(#113): on ${PROTECTED}\n`);
			assert.notEqual(attempt.status, 0, "a commit on the protected identity was created");
			assert.equal(
				blockRecords(attempt).length,
				1,
				`expected one block record; delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
			assert.equal(
				unevaluatedRecords(attempt).length,
				0,
				"an arm that evaluated its subject wrote a not-evaluated record",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a commit on a FEATURE branch allows with no record — the ordinary allow", () => {
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			fixtureGit(fixture, ["checkout", "-q", "-b", "zqfeaturezq"]);
			const attempt = commitWithMessage(fixture, "feat(#113): on a feature branch\n");
			assert.equal(attempt.status, 0, `an ordinary feature-branch commit was refused: ${attempt.stderr}`);
			assert.equal(blockRecords(attempt).length, 0, "an ordinary allow wrote a block record");
			assert.equal(
				unevaluatedRecords(attempt).length,
				0,
				"an ordinary allow wrote a not-evaluated record — the two must stay distinct",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a commit on a DETACHED HEAD allows and writes exactly one not-evaluated record", () => {
		// The three-way separation this describe exists for: refusal, ordinary
		// allow, and an allow the arm never evaluated are distinguishable at
		// the observable. Without the record the third collapses into the
		// second, which is the state §5.9's bar refuses to leave traceless.
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			fixtureGit(fixture, ["checkout", "-q", "--detach"]);
			const attempt = commitWithMessage(fixture, "feat(#113): detached\n");
			assert.equal(attempt.status, 0, `the scope decision is to allow; the commit was refused: ${attempt.stderr}`);
			assert.equal(
				unevaluatedRecords(attempt).length,
				1,
				`expected exactly one not-evaluated record; delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
			assert.equal(blockRecords(attempt).length, 0, "the scope fold wrote a block record");
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("the detached fold is audit-only: no stderr line borrows the degradation wording", () => {
		// A scope boundary is not machinery degradation. Printing §3.9's
		// "not enforced" line here would misattribute a cause the tier did not
		// suffer, and a rebase would print once per replayed commit.
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			fixtureGit(fixture, ["checkout", "-q", "--detach"]);
			const attempt = commitWithMessage(fixture, "feat(#113): detached, quiet\n");
			assert.equal(attempt.cause, "", `the scope fold spoke on stderr: ${JSON.stringify(attempt.cause)}`);
			assert.ok(
				!attempt.stderr.includes("not enforced"),
				"the scope fold borrowed §3.9's degradation wording",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a commit MADE during a rebase of P (an --exec commit) is recorded as unevaluated", () => {
		// What this arm measures, named exactly: commits the rebase's own
		// `--exec` CREATES, which run pre-commit on a detached HEAD. It does
		// NOT measure the commits the rebase REPLAYS — git runs no pre-commit
		// for those, which the residual arm below drives separately.
		//
		// The count is pinned to exactly 2, one per exec invocation, and the
		// arm is held honest by varying ONLY the exec payload against a fixed
		// rebase in the sibling arm below.
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			seedReplayableHistory(fixture);
			const before = auditLength(fixture);
			const rebase = rebaseWithExec(fixture, "git commit -q --allow-empty -m 'feat(#113): made during rebase'");
			assert.equal(rebase.status, 0, `the rebase itself failed: ${(rebase.stderr ?? Buffer.alloc(0)).toString()}`);
			assert.equal(
				unevaluatedIn(auditSince(fixture, before)).length,
				2,
				"expected one not-evaluated record per exec-created commit",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("CONTROL: the same rebase with an exec that creates no commit records nothing", () => {
		// The discriminator for the arm above. Fixture and rebase are held
		// fixed and ONLY the exec payload varies, so the records above are
		// attributable to the created commits and to nothing else. Without
		// this control the arm above would pass while measuring the replayed
		// commits it does not in fact measure.
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			seedReplayableHistory(fixture);
			const before = auditLength(fixture);
			const rebase = rebaseWithExec(fixture, "true");
			assert.equal(rebase.status, 0, `the rebase itself failed: ${(rebase.stderr ?? Buffer.alloc(0)).toString()}`);
			assert.equal(
				unevaluatedIn(auditSince(fixture, before)).length,
				0,
				"records appeared with no exec-created commit — the sibling arm is measuring something else",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("the enumerated residual: REPLAYED commits reach P with the tier never running", () => {
		// SPEC §3.3's rebase residual, driven rather than asserted. git runs no
		// pre-commit for a commit a rebase replays, so the arm does not fold —
		// it is never reached. P moves and the trail is silent. This arm exists
		// so the residual's SHAPE is pinned: if a future git or a future
		// adapter made the tier see replayed commits, this arm reds and the
		// residual is re-adjudicated rather than silently outliving its ground.
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			seedReplayableHistory(fixture);
			// Rebase ONTO a divergent base rather than `-f` in place: replaying
			// onto the same parent within the same committer second reproduces
			// identical hashes and P would not move, making the arm vacuous.
			// A different parent forces different commits deterministically.
			fixtureGit(fixture, ["branch", "zqbase", "HEAD~2"]);
			fixtureGit(fixture, ["-c", "core.hooksPath=", "checkout", "-q", "zqbase"]);
			writeFileSync(join(fixture.root, "base.txt"), "divergent\n");
			fixtureGit(fixture, ["add", "base.txt"]);
			fixtureGit(fixture, ["-c", "core.hooksPath=", "commit", "-q", "-m", "feat(#113): divergent base"]);
			fixtureGit(fixture, ["-c", "core.hooksPath=", "checkout", "-q", PROTECTED]);
			const headBefore = revParse(fixture, PROTECTED);
			const before = auditLength(fixture);
			const rebase = spawnSync("git", ["rebase", "--onto", "zqbase", "HEAD~2"], {
				cwd: fixture.root,
				env: { PATH: process.env.PATH ?? "", HOME: join(fixture.root, "home"), GIT_CONFIG_NOSYSTEM: "1" },
			});
			assert.equal(rebase.status, 0, `the rebase itself failed: ${(rebase.stderr ?? Buffer.alloc(0)).toString()}`);
			assert.notEqual(revParse(fixture, PROTECTED), headBefore, "the rebase did not move P; the arm proves nothing");
			const delta = auditSince(fixture, before);
			assert.equal(
				unevaluatedIn(delta).length,
				0,
				`the tier spoke for a replayed commit — SPEC §3.3's residual describes the wrong shape; delta: ${JSON.stringify(delta)}`,
			);
			assert.equal(
				delta.split("\n").filter((l) => l.includes('"block"')).length,
				0,
				"a replayed commit produced a block record",
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a tag shadowing P does not disarm the arm: the branch's own name is read", () => {
		// The axis the first round's arms held fixed: what else lives under
		// `refs/`. `git symbolic-ref --short HEAD` prints the shortest
		// UNAMBIGUOUS spelling, so `git tag <P>` makes it print `heads/<P>`,
		// which misses both comparison arms and answers not-P — a traceless
		// disarm one innocuous command away. The predicate reads the full
		// refname instead, so the tag changes nothing.
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			const control = commitWithMessage(fixture, `feat(#113): control on ${PROTECTED}\n`);
			assert.notEqual(control.status, 0, "control: a commit on P was created");

			fixtureGit(fixture, ["tag", PROTECTED, "HEAD"]);
			const headBefore = revParse(fixture, `refs/heads/${PROTECTED}`);
			const attempt = commitWithMessage(fixture, `feat(#113): shadowed by a tag\n`);
			assert.notEqual(
				attempt.status,
				0,
				"a tag named P disarmed the commit arm: the commit was created on the protected branch",
			);
			assert.equal(
				revParse(fixture, `refs/heads/${PROTECTED}`),
				headBefore,
				"the protected branch moved while a tag shadowed its name",
			);
			assert.equal(
				blockRecords(attempt).length,
				1,
				`expected the ordinary block record; delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});

	it("a HEAD resolving outside refs/heads/ has no branch name and folds to the no-subject arm", () => {
		// The other half of reading the full refname: a symbolic HEAD pointing
		// somewhere other than refs/heads/ is not a branch, so it must reach
		// the no-subject fold rather than be reported under a spelling that is
		// not a branch identity.
		const fixture = buildGithookFixture({ remote: { defaultBranch: PROTECTED } });
		try {
			fixtureGit(fixture, ["update-ref", "refs/other/zqodd", "HEAD"]);
			fixtureGit(fixture, ["symbolic-ref", "HEAD", "refs/other/zqodd"]);
			const attempt = commitWithMessage(fixture, "feat(#113): head outside refs/heads\n");
			assert.equal(attempt.status, 0, `the advice tier refused: ${attempt.stderr}`);
			assert.equal(
				unevaluatedRecords(attempt).length,
				1,
				`expected one not-evaluated record; delta: ${JSON.stringify(attempt.auditDelta)}`,
			);
		} finally {
			removeGithookFixture(fixture);
		}
	});
});

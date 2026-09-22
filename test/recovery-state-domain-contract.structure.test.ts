import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const ROOT = repoRoot();
const SPEC = readFileSync(join(ROOT, "SPEC.md"), "utf8");
const POSTURES = readFileSync(join(ROOT, ".pi/extensions/gitjig/postures.ts"), "utf8");
const README = readFileSync(join(ROOT, "README.md"), "utf8");

const REACH_TRAILERS = [
	"autonomous-recovery-allowance@SPEC-1.4=re-role-durable-record",
	"not-per-clone@SPEC-1.4=narrow-same-resolved-domain",
	"per-project-shell-state@SPEC-5.5=narrow-allowance-exception",
	"shell-state-domain@SPEC-1.4+5.5=introduce",
	"state-domain-recovery-allowance@SPEC-1.4=introduce-replacement-record",
	"ambient-never-enforcement-input@SPEC-4.6=narrow-recovery-placement-only",
	"host-untouched-outside-repositories@SPEC-4.7=narrow-recovery-state-domain-only",
] as const;

function section(source: string, start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	assert.ok(from >= 0 && to > from, `missing bounded section ${start}`);
	return source.slice(from, to);
}

const REPAIR = section(SPEC, "### 1.4 Cross-review repair", "### 1.5 Delegated work");
const BINDING = section(SPEC, "### 4.6 Binding and resolution", "### 4.7 Host boundary");
const HOST = section(SPEC, "### 4.7 Host boundary", "### 4.8 The command layer");
const STATE = section(SPEC, "### 5.5 State boundary", "### 5.6 Operating modes");
const PUBLIC = section(SPEC, "### 5.7 Run conduct", "### 5.8 Context lifecycle");

const repairNeedles = [
	"state-domain recovery allowance",
	"shell state domain",
	"not per clone",
	"Different domains — on one host or different hosts — can each claim",
	"observed recovering from multiple domains",
	"#240 or its explicit successor",
	"change key** remains the sole canonical lineage identity",
	"non-empty Unicode scalar string",
	"at most 1,024 bytes",
	"unsigned 32-bit big-endian UTF-8 byte length",
	"gitjig-recovery-repository-path:v2",
	"gitjig-recovery-change-path:v2",
	"one NUL byte",
	"byte `0x01`",
	"unsigned 32-bit big-endian issue count",
	"sorted by unsigned UTF-8 byte order",
	"byte `0x02`",
	"No locale, JSON serialization, delimiter join, issue number, URL",
	"r2-<repoHash>-<keyHash>.json",
	"137 bytes, never a repository directory",
	"not identifiers that can authorize or distinguish a lineage",
] as const;

const stateNeedles = [
	"`XDG_STATE_HOME/gitjig/recovery/`",
	"`HOME/.local/state/gitjig/recovery/`",
	"no group/other write bits",
	"retain ordinary read/execute bits",
	"Runtime-owned `gitjig` and `recovery` directories are exact mode `0700`",
	"lstat by path",
	"`O_RDONLY|O_DIRECTORY|O_NOFOLLOW`",
	"fstat identity, type, effective uid, and mode to equal the lstat",
	"parent descriptor identity revalidated before and after creation",
	"For every traversed component, whether pre-existing or newly created",
	"fsynced successfully before descending to the next component or attempting the final-leaf claim",
	"repeated barrier covers a component left visible by an earlier failed or outcome-ambiguous creation fsync",
	"Any parent fsync failure or ambiguity refuses on the preclaim, unconsumed side",
	"deepest existing ancestor to filesystem root",
	"On every resolution and before every use",
	"immediately after creation",
	"`.git` entry of any lstat type",
	"file, directory, symlink, or other",
	"conjunction of sibling entries `HEAD`, `objects`, and `refs`",
	"each present by lstat regardless of type",
	"excludes intrinsically discoverable ordinary and bare Git layouts",
	"cannot detect an arbitrary directory designated as a work tree only by externally located metadata",
	"`git --git-dir=… --work-tree=…` or external `core.worktree`",
	"neither enumerates foreign metadata nor reads global Git configuration",
	"explicit operator-placement residual, not a never-committable guarantee",
	"must not select an XDG/HOME domain inside such an externally designated work tree",
	"observing allowance state become committable through external metadata reopens #334 or its explicit successor",
	"unrelated ancestor that coincidentally carries the bare-marker trio",
	"relocate the XDG/HOME state domain outside that ancestor and begin a new invocation",
	"because exclusion precedes exclusive leaf creation, the refusal consumes no allowance",
	"regular, single-link exact-mode-`0600`",
	"`O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`",
	"writable descriptor receives the complete `claimed` tombstone",
	"file and parent directory are fsynced before any semantic dispatch",
	"No delete, edit, clear, reset, repair, or stale-lock recovery API exists",
	"Partial, torn, malformed, linked, loose-mode, or wrong-owner",
	"verifies the exact claimed bytes",
	"atomically renames it over the claim",
	"Any write, rename, fsync, or outcome ambiguity remains consumed",
	"Exclusive final-leaf creation is the consumption boundary",
	"before successful exclusive final-leaf creation creates no tombstone and leaves the allowance available",
	"only a newly initiated invocation after repair may attempt the claim",
	"Once exclusive creation may have succeeded",
	"handoff record is interruption evidence, never asserted as durable consumption",
	"sole zero-argument export `resolveRecoveryStateDomain()`",
	"fails closed if `GITJIG_TEST_STATE_ROOT` is present at all, including empty",
	"subprocess with an existing absolute disposable",
	"production `XDG_STATE_HOME` branch or the absent-XDG `HOME` branch",
	"cannot select or override production resolution",
	"No verification token, wrapper, alternate resolver, or factory is exported",
	"No comment, label, ref, repository variable, workflow artifact or cache, platform setting",
	"no state-domain, key, claim, reset, or finalize capability",
] as const;

const bindingNeedles = [
	"sole enforcement-input exception",
	"zero-argument resolver reads only whether `XDG_STATE_HOME` is present",
	"only when absent whether `HOME` is present",
	"Those values select placement and authorize no act",
	"Every other ambient variable remains excluded",
	"creates no second override seam",
] as const;

const hostNeedles = [
	"sole exception is §1.4's state-domain recovery allowance",
	"only §5.5's exact owner-only `gitjig/recovery` directory chain and direct allowance leaves",
	"no configuration, registration, service, repository metadata, or other host path",
] as const;

function settlementHolds(
	repair: string,
	state: string,
	publicContract = PUBLIC,
	binding = BINDING,
	host = HOST,
): boolean {
	return (
		repairNeedles.every((needle) => repair.includes(needle)) &&
		stateNeedles.every((needle) => state.includes(needle)) &&
		bindingNeedles.every((needle) => binding.includes(needle)) &&
		hostNeedles.every((needle) => host.includes(needle)) &&
		publicContract.includes("public or unretractable acts remain non-substitutable") &&
		POSTURES.includes('dependency: "recovery-shell-state-domain"') &&
		POSTURES.includes("without consuming the allowance") &&
		POSTURES.includes("start a new invocation") &&
		POSTURES.includes("Once creation may have succeeded") &&
		POSTURES.includes("only future distinct leaves") &&
		README.includes("a present-but-invalid value refuses with no fallback") &&
		README.includes("Only when it is unset") &&
		README.includes("marker-free work tree designated only by externally located Git metadata") &&
		README.includes("operators must not select such a domain")
	);
}

function killNeedle(source: string, needle: string): string {
	assert.ok(source.includes(needle), `fixture missing ${needle}`);
	return source.replaceAll(needle, "MUTATED");
}

describe("issue #335 recovery state-domain contract", () => {
	it("pins the complete bounded settlement and unchanged public/private boundary", () => {
		assert.equal(settlementHolds(REPAIR, STATE), true);
	});

	it("kills every named private contract mutant independently", () => {
		for (const needle of repairNeedles) assert.equal(settlementHolds(killNeedle(REPAIR, needle), STATE), false);
		for (const needle of stateNeedles) assert.equal(settlementHolds(REPAIR, killNeedle(STATE, needle)), false);
		for (const needle of bindingNeedles)
			assert.equal(settlementHolds(REPAIR, STATE, PUBLIC, killNeedle(BINDING, needle), HOST), false);
		for (const needle of hostNeedles)
			assert.equal(settlementHolds(REPAIR, STATE, PUBLIC, BINDING, killNeedle(HOST, needle)), false);
		assert.equal(
			settlementHolds(
				REPAIR,
				STATE,
				PUBLIC.replace("public or unretractable acts remain non-substitutable", "public acts may proceed"),
			),
			false,
		);
	});

	it("kills the two-invocation retry that treats a visible prior mkdir as already durable", () => {
		const missingOnly = STATE.replace(
			"For every traversed component, whether pre-existing or newly created",
			"Only for a newly created component",
		);
		assert.equal(settlementHolds(REPAIR, missingOnly), false);
		assert.match(
			STATE,
			/repeated barrier covers a component left visible by an earlier failed or outcome-ambiguous creation fsync/,
		);
	});

	it("pins the seven exact reach trailer values without querying checkout history", () => {
		assert.deepEqual(REACH_TRAILERS, [
			"autonomous-recovery-allowance@SPEC-1.4=re-role-durable-record",
			"not-per-clone@SPEC-1.4=narrow-same-resolved-domain",
			"per-project-shell-state@SPEC-5.5=narrow-allowance-exception",
			"shell-state-domain@SPEC-1.4+5.5=introduce",
			"state-domain-recovery-allowance@SPEC-1.4=introduce-replacement-record",
			"ambient-never-enforcement-input@SPEC-4.6=narrow-recovery-placement-only",
			"host-untouched-outside-repositories@SPEC-4.7=narrow-recovery-state-domain-only",
		]);
	});

	it("does not admit clone-local, raw-key, repository-directory, public-CAS, or reset alternatives", () => {
		assert.doesNotMatch(
			REPAIR,
			/one allowance exists per checkout|r1-<repoHash>-<changeKey>|repository-key directory is used/,
		);
		assert.doesNotMatch(STATE, /issue comment.*compare-and-swap|delete.*allowance.*retry|reset.*allowance.*retry/i);
		assert.match(STATE, /No exclusion file or repository metadata is mutated/);
		assert.doesNotMatch(STATE, /`HEAD`, `objects`, or `refs`|regular `HEAD`|directory `objects`/);
	});
});

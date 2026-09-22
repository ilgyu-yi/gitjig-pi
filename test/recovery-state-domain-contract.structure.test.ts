import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const ROOT = repoRoot();
const SPEC = readFileSync(join(ROOT, "SPEC.md"), "utf8");
const POSTURES = readFileSync(join(ROOT, ".pi/extensions/gitjig/postures.ts"), "utf8");

function section(source: string, start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	assert.ok(from >= 0 && to > from, `missing bounded section ${start}`);
	return source.slice(from, to);
}

const REPAIR = section(SPEC, "### 1.4 Cross-review repair", "### 1.5 Delegated work");
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
	"gitjig-recovery-repository-path:v1",
	"r1-<repoHash>-<changeKey>.json",
	"no repository-key directory exists",
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
	"deepest existing ancestor to filesystem root",
	"On every resolution and before every use",
	"immediately after creation",
	"`.git` entry of any lstat type",
	"file, directory, symlink, or other",
	"regular, single-link exact-mode-`0600`",
	"`O_CREAT|O_EXCL|O_NOFOLLOW`",
	"file and parent directory are fsynced before any semantic dispatch",
	"No delete, edit, clear, reset, repair, or stale-lock recovery API exists",
	"Partial, torn, malformed, linked, loose-mode, or wrong-owner",
	"verifies the exact claimed bytes",
	"atomically renames it over the claim",
	"Any write, rename, fsync, or outcome ambiguity remains consumed",
	"fails closed if `GITJIG_TEST_STATE_ROOT` is present at all, including empty",
	"withRecoveryVerificationRoot(target, callback)",
	"No token or alternate resolver is exported",
	"permits that wrapper only in named recovery tests",
	"No comment, label, ref, repository variable, workflow artifact or cache, platform setting",
	"no state-domain, key, claim, reset, or finalize capability",
] as const;

function settlementHolds(repair: string, state: string, publicContract = PUBLIC): boolean {
	return (
		repairNeedles.every((needle) => repair.includes(needle)) &&
		stateNeedles.every((needle) => state.includes(needle)) &&
		publicContract.includes("public or unretractable acts remain non-substitutable") &&
		POSTURES.includes('dependency: "recovery-shell-state-domain"')
	);
}

function killNeedle(source: string, needle: string): string {
	assert.ok(source.includes(needle), `fixture missing ${needle}`);
	return source.split(needle).join("MUTATED");
}

describe("issue #335 recovery state-domain contract", () => {
	it("pins the complete bounded settlement and unchanged public/private boundary", () => {
		assert.equal(settlementHolds(REPAIR, STATE), true);
	});

	it("kills every named private contract mutant independently", () => {
		for (const needle of repairNeedles) assert.equal(settlementHolds(killNeedle(REPAIR, needle), STATE), false);
		for (const needle of stateNeedles) assert.equal(settlementHolds(REPAIR, killNeedle(STATE, needle)), false);
		assert.equal(
			settlementHolds(
				REPAIR,
				STATE,
				PUBLIC.replace("public or unretractable acts remain non-substitutable", "public acts may proceed"),
			),
			false,
		);
	});

	it("does not admit clone-local, checkout-derived, repository-directory, public-CAS, or reset alternatives", () => {
		assert.doesNotMatch(REPAIR, /one allowance exists per checkout|repository-key directory is used/);
		assert.match(REPAIR, /no repository-key directory exists/);
		assert.doesNotMatch(STATE, /issue comment.*compare-and-swap|delete.*allowance.*retry|reset.*allowance.*retry/i);
		assert.match(STATE, /No exclusion file or repository metadata is mutated/);
	});
});

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./harness/run-pi.ts";

const spec = readFileSync(join(repoRoot(), "SPEC.md"), "utf8");

function section(source: string, startHeading: string, endHeading: string): string {
	const start = source.indexOf(startHeading);
	const end = source.indexOf(endHeading, start + startHeading.length);
	assert.ok(start >= 0 && end > start, `missing section: ${startHeading}`);
	return source.slice(start, end);
}

function requireAll(source: string, tokens: readonly string[]): void {
	for (const token of tokens) assert.ok(source.includes(token), `missing accepted-set member: ${token}`);
}

function assertModeAcceptedSet(source: string): void {
	const modes = section(source, "### 5.6 Operating modes", "### 5.7 Run conduct");
	requireAll(modes, [
		"`merge-mode: off | on`",
		"`decision-mode: handoff | autonomous`",
		"`--merge-mode`",
		"`GITJIG_MERGE_MODE`",
		"`mergeMode`",
		"default `off`",
		"falls to `off`",
		"`--decision-mode`",
		"`GITJIG_DECISION_MODE`",
		"`decisionMode`",
		"default `handoff`",
		"falls to `handoff`",
		"ordinary landing first",
		"default labeled native-approval waiver",
		"Decision mode grants no landing authority",
	]);
	for (const retired of ["execution mode", "`attended`", "`unattended`", "merge-or-park"]) {
		assert.ok(!modes.includes(retired), `retired mode member survives: ${retired}`);
	}
}

function assertConductAcceptedSet(source: string): void {
	const conduct = section(source, "### 5.7 Run conduct", "### 5.8 Context lifecycle");
	requireAll(conduct, [
		"A clean state proceeds only to the resolved merge-mode ceiling",
		"A soft blocker earns exactly one self-repair attempt",
		"A hard blocker emits one handoff record",
		"`{cause,recipient,reentry,observedAt,subjectHead,baseHead}`",
		"No universal own-behalf or independent-identity restriction applies",
		"#276 owns lifecycle transition writers and clearers",
	]);
	for (const retired of ["parks", "Parking", "park instruments", "marker label"]) {
		assert.ok(!conduct.includes(retired), `retired durable-stop member survives: ${retired}`);
	}
}

function assertCrossReviewHandoffContract(source: string): void {
	const crossReview = section(source, "### 1.4 Cross-review repair", "### 1.5 Delegated work");
	requireAll(crossReview, [
		"Under `handoff` each value emits §2.2's idempotent handoff record and stops",
		"One allowance exists per stable change lineage",
		"platform-attested immutable identities",
		"repository plus the sorted set of activated closing issues",
		"repository plus the pull request where no issue exists",
		"the caller never supplies or mints it",
		"unavailable or ambiguous attested identity hands off",
		"atomically changes the allowance from `available` to `claimed`",
		"claim, crash, invalid return, or unavailable actor consumes it",
		"no later event resets it for that lineage",
		"allowance state `available | claimed | consumed`",
		"terminal `continue | handoff`",
		"`history-diagnosis` basis",
		"`finding-escalation` basis",
		"The acting author cannot write, clear, or satisfy this record",
		"Missing, unknown, duplicate, or misaligned fields handoff",
		"A second recovery request hands off.",
		"only a fresh NONE returns to ordinary flow",
		"every non-NONE, incomplete, invalid, or unavailable result hands off",
		"another `measure-escalate` or any invalid/unavailable result hands off",
	]);
}

const modes = section(spec, "### 5.6 Operating modes", "### 5.7 Run conduct");
const context = section(spec, "### 5.8 Context lifecycle", "### 5.9 Session surfaces");
const sessions = section(spec, "### 5.9 Session surfaces", "## 6. Self-governance milestone");

function productionExtensionFiles(root: string, dir = ".pi/extensions/gitjig"): string[] {
	return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return productionExtensionFiles(root, path);
		return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
	});
}

const COORDINATOR_RUNTIME_EXPORTS = [
	"coordinateHistoryRecovery",
	"hasRecoveryRetryReserve",
	"makeRecoveryProfileDispatcher",
] as const;

async function assertPrivateAllowanceCapabilities(root: string): Promise<void> {
	const production = [".pi/extensions/gitjig.ts", ...productionExtensionFiles(root)];
	assert.ok(!production.includes(".pi/extensions/gitjig/recovery/store.ts"), "standalone mutation module survives");
	const coordinator = ".pi/extensions/gitjig/recovery/coordinator.ts";
	const source = readFileSync(join(root, coordinator), "utf8");
	assert.equal((source.match(/^function claimAllowance\(/gm) ?? []).length, 1);
	assert.equal((source.match(/^function finalizeAllowance\(/gm) ?? []).length, 1);
	for (const path of production) {
		const candidate = readFileSync(join(root, path), "utf8");
		if (path === coordinator) continue;
		assert.doesNotMatch(
			candidate,
			/\bclaimAllowance\b|\bfinalizeAllowance\b/,
			`allowance mutation name crosses lexical module boundary through ${path}`,
		);
	}
	const namespace = await import(
		`${pathToFileURL(join(root, coordinator)).href}?privacy=${Date.now()}-${Math.random()}`
	);
	assert.deepEqual(
		Object.keys(namespace).sort(),
		[...COORDINATOR_RUNTIME_EXPORTS].sort(),
		"coordinator runtime namespace exposes an unapproved capability",
	);
}

describe("§§5.6–5.9 accepted set after actor-neutral settlement", () => {
	it("pins the two independent setting domains and their fail-safe resolution", () => {
		assertModeAcceptedSet(spec);
		const widened = spec.replace("`merge-mode: off | on`", "`merge-mode: off | on | force`");
		assert.notEqual(widened, spec, "merge-mode mutant anchor did not match");
		assert.throws(() => assertModeAcceptedSet(widened));
		const weakened = spec.replaceAll("default labeled native-approval waiver", "unbounded waiver");
		assert.notEqual(weakened, spec, "escape-order mutant anchor did not match");
		assert.throws(() => assertModeAcceptedSet(weakened));
	});

	it("pins all four combinations without coupling the axes", () => {
		requireAll(modes, [
			"`off + handoff`",
			"`off + autonomous`",
			"`on + handoff`",
			"`on + autonomous`",
			"Merge mode governs the ready-to-landing boundary",
			"decision mode selects only the recipient of the closed three-checkpoint set",
		]);
	});

	it("pins handoff conduct and attributes a durable-park insertion to the retired-member guard", () => {
		assertConductAcceptedSet(spec);
		const wrong = spec.replace(
			"A hard blocker emits one handoff record",
			"A hard blocker emits one handoff record and then parks",
		);
		assert.notEqual(wrong, spec, "durable-park insertion mutant anchor did not match");
		assert.throws(() => assertConductAcceptedSet(wrong), /retired durable-stop member survives: parks/);
	});

	it("pins §1.4's lineage-scoped recovery and every handoff terminal", () => {
		assertCrossReviewHandoffContract(spec);
		const wrong = spec.replace("A second recovery request hands off.", "A second recovery request stops.");
		assert.notEqual(wrong, spec, "§1.4 handoff mutant anchor did not match");
		assert.throws(
			() => assertCrossReviewHandoffContract(wrong),
			/missing accepted-set member: A second recovery request hands off\./,
		);
	});

	it("keeps Phase A on the history route with no public mutation, plan-owner, or finding-escalation reach", () => {
		const root = repoRoot();
		const recoveryFiles = ["briefs.ts", "coordinator.ts", "lineage.ts", "profiles.ts", "state-domain.ts", "types.ts"];
		const recovery = recoveryFiles
			.map((name) => readFileSync(join(root, ".pi/extensions/gitjig/recovery", name), "utf8"))
			.join("\n");
		assert.doesNotMatch(
			recovery,
			/platform\/write|publish\/|landing\/|registerCommand|measure-escalate|plan contest owner/i,
		);
		for (const path of [
			".pi/extensions/gitjig/commands/index.ts",
			".pi/extensions/gitjig/commands/review-round.ts",
			".pi/extensions/gitjig/recovery/coordinator.ts",
		]) {
			const source = readFileSync(join(root, path), "utf8");
			if (path.endsWith("coordinator.ts")) assert.match(source, /claimAllowance/);
			else assert.doesNotMatch(source, /claimAllowance|finalizeAllowance|resolveRecoveryStateDomain/);
		}
	});

	it("keeps allowance mutation capabilities lexically private to the coordinator", async () => {
		const root = repoRoot();
		await assertPrivateAllowanceCapabilities(root);
		const coordinator = join(root, ".pi/extensions/gitjig/recovery/coordinator.ts");
		assert.doesNotMatch(
			readFileSync(coordinator, "utf8"),
			/readonly (?:path|recoveryDir|claimedBytes|device|inode|recordRef):/,
		);
		const copy = mkdtempSync(join(tmpdir(), "gitjig-private-capability-mutant-"));
		try {
			cpSync(join(root, ".pi"), join(copy, ".pi"), { recursive: true });
			symlinkSync(join(root, "node_modules"), join(copy, "node_modules"), "dir");
			const target = join(copy, ".pi/extensions/gitjig/recovery/coordinator.ts");
			writeFileSync(
				target,
				`${readFileSync(target, "utf8")}\nconst __leakedClaim = claimAllowance;\nconst __leakedFinalize = finalizeAllowance;\nexport { __leakedClaim, __leakedFinalize };\n`,
			);
			await assert.rejects(
				() => assertPrivateAllowanceCapabilities(copy),
				/coordinator runtime namespace exposes an unapproved capability/,
			);
			cpSync(coordinator, target);
			writeFileSync(
				join(copy, ".pi/extensions/gitjig/recovery/store.ts"),
				"export function claimAllowance() {}\nexport function finalizeAllowance() {}\n",
			);
			await assert.rejects(() => assertPrivateAllowanceCapabilities(copy), /standalone mutation module survives/);
			rmSync(join(copy, ".pi/extensions/gitjig/recovery/store.ts"));
		} finally {
			rmSync(copy, { recursive: true, force: true });
		}
	});

	it("keeps context lifecycle bounded and repository-keyed", () => {
		requireAll(context, [
			"Working context is a managed resource",
			"archive-then-discard, never delete",
			"bounded distillations",
			"Retrieval over durable memory is structurally bounded",
		]);
	});

	it("keeps session projection downstream of owning mode and lifecycle instruments", () => {
		requireAll(sessions, [
			"#278's `.pi/extensions/gitjig/modes.ts` resolver feeds its resolved merge-mode value and source",
			"lifecycle labels and handoff records now have their owning #276 transition service",
			"remain excluded from this projection until #133 derives the persistent actor-neutral view",
			"UI-less mode makes no status call",
		]);
	});
});

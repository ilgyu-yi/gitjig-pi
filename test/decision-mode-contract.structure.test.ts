import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const spec = readFileSync(join(repoRoot(), "SPEC.md"), "utf8");

function section(heading: string, nextHeading: string): string {
	const start = spec.indexOf(heading);
	const end = spec.indexOf(nextHeading, start + heading.length);
	assert.ok(start >= 0 && end > start, `SPEC section bounds are missing: ${heading} -> ${nextHeading}`);
	return spec.slice(start, end);
}

const crossReview = section("### 1.4 Cross-review repair", "### 1.5 Delegated work");
const findingJudgment = section("### 1.9 Finding judgment", "### 1.10 Release backbone");
const modes = section("### 5.6 Operating modes", "### 5.7 Unattended conduct");
const unattended = section("### 5.7 Unattended conduct", "### 5.8 Context lifecycle");

describe("the orthogonal decision-mode settlement (#237)", () => {
	it("pins both axes and each of the four cells' distinct behavior", () => {
		for (const behavior of [
			"`attended + handoff` gives the three recoverable choices to a human and stops at ready",
			"`attended + autonomous` may independently resolve those three choices but still stops at ready and cannot merge",
			"`unattended + handoff` may merge a clear change, but a reached recoverable choice hands off and cannot be merged through",
			"`unattended + autonomous` may independently resolve those choices and retains merge-or-park",
		]) {
			assert.ok(modes.includes(behavior), `a mode cell lost its consequence: ${behavior}`);
		}
		assert.ok(
			modes.includes("Execution mode alone governs ready and merge") &&
				modes.includes("decision mode alone chooses the consumer"),
			"the two axes no longer have disjoint decisions",
		);
	});

	it("pins resolution inputs, defaults, failure direction, and the single project-value home", () => {
		for (const token of [
			"`attended` — the default",
			"`handoff` — the default",
			"`--execution-mode`, `--decision-mode`",
			"`GITJIG_EXECUTION_MODE`, `GITJIG_DECISION_MODE`",
			"`executionMode` or `decisionMode` field",
			"`<resolved-state-root>/modes.json`",
			"execution value falls toward `attended`",
			"decision value toward `handoff`",
		]) {
			assert.ok(modes.includes(token), `mode resolution lost ${token}`);
		}
	});

	it("closes the substitutable checkpoint set and keeps ready under execution mode", () => {
		for (const checkpoint of [
			"§1.8 plan selection",
			"§1.4 history-diagnosis recovery",
			"§1.9 finding-level `measure-escalate`",
		]) {
			assert.ok(modes.includes(checkpoint), `the closed checkpoint set dropped ${checkpoint}`);
		}
		assert.ok(modes.includes("no other gate or judgment is eligible by classification or analogy"));
		assert.ok(modes.includes("The ready decision is not in that set"));
		assert.ok(modes.includes("`attended` always stops there"));
		assert.ok(modes.includes("`unattended` keeps the existing reviewer-verdict fallback"));
	});

	it("derives one lineage key from attested artifact identities rather than caller input", () => {
		for (const token of [
			"platform-attested immutable identities",
			"repository plus the sorted set of activated closing issues",
			"repository plus the pull request where no issue exists",
			"replacement pull request for the same activated issue set therefore reuses the key",
			"the caller never supplies or mints it",
			"unavailable or ambiguous attested identity parks",
		]) {
			assert.ok(crossReview.includes(token), `the lineage identity rule dropped: ${token}`);
		}
	});

	it("makes recovery a durable one-use allowance that restarts cannot replenish", () => {
		for (const token of [
			"One allowance exists per stable change lineage",
			"atomically changes the allowance from `available` to `claimed`",
			"claim, crash, invalid return, or unavailable actor consumes it",
			"no later event resets it for that lineage",
			"A second recovery request parks",
		]) {
			assert.ok(crossReview.includes(token), `the one-use recovery bound dropped: ${token}`);
		}
	});

	it("keeps a tagged closed record outside the acting author's control", () => {
		for (const token of [
			"allowance state `available | claimed | consumed`",
			"terminal `continue | park`",
			"`history-diagnosis` basis",
			"`finding-escalation` basis",
			"invents no invalidation",
			"The acting author cannot write, clear, or satisfy this record",
			"Missing, unknown, duplicate, or misaligned fields park",
		]) {
			assert.ok(crossReview.includes(token), `the recovery-record contract dropped: ${token}`);
		}
	});

	it("pins every history diagnosis intervention and its terminal direction", () => {
		for (const token of [
			"**STAGNATION** runs a mutually blind §1.8-shaped contest over methods",
			"selects and attests one materially different method or the change parks",
			"**OSCILLATION** uses the diagnosis only to identify the opposed adjudications",
			"a semantic rereading is not §1.9 new evidence",
			"exactly one non-mutating discriminating measurement",
			"**INDETERMINATE** independently selects and runs one bounded non-mutating measurement",
			"then re-dispatches the history Judge once",
			"only a fresh NONE returns to ordinary flow",
			"every non-NONE, incomplete, invalid, or unavailable result parks",
		]) {
			assert.ok(crossReview.includes(token), `a diagnosis transition lost: ${token}`);
		}
	});

	it("gives finding-level measure-escalate its own total decision-mode route", () => {
		for (const token of [
			"§1.9's finding-level `measure-escalate` reaches the same decision-mode consumer",
			"`handoff` parks",
			"`autonomous` consumes the lineage's allowance with a `finding-escalation` basis",
			"one fresh findings Judge",
			"another `measure-escalate` or any invalid/unavailable result parks",
		]) {
			assert.ok(crossReview.includes(token), `the finding-escalation route lost: ${token}`);
		}
		assert.ok(findingJudgment.includes("on that clause's `finding-escalation` terms"));
	});

	it("pins invalidation as sole selector and each route's destination", () => {
		assert.ok(
			crossReview.includes(
				"Which gate** the change re-enters is decided by the ruling's invalidation finding and by nothing else",
			),
		);
		for (const destination of [
			"**Nothing invalidated** — no re-entry is owed",
			"**The selected plan is invalidated** — the change re-enters the planning model (§1.8)",
			"**The authorization is invalidated** — the change re-enters the gate that granted it (§1.2's settlement and precedence rules, §2.2's activation)",
		]) {
			assert.ok(crossReview.includes(destination), `an invalidation destination drifted: ${destination}`);
		}
	});

	it("does not stack the soft budget or cross any named non-substitutable boundary", () => {
		assert.ok(unattended.includes("one intervention spends both rather than stacking attempts"));
		for (const boundary of [
			"Trusted-account attribution",
			"approval of an SSOT correction",
			"genuinely new authorization",
			"reversal of deliberate human state",
			"disposal of another party's filed work",
			"credentials",
			"server configuration",
			"another repository",
			"public or unretractable acts",
		]) {
			assert.ok(unattended.includes(boundary), `the all-mode hard boundary dropped ${boundary}`);
		}
		assert.ok(
			unattended.includes(
				"Autonomous decision mode changes the independent consumer at §5.6's closed three-checkpoint set, never another gate",
			),
		);
	});
});

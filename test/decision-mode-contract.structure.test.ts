import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const spec = readFileSync(join(repoRoot(), "SPEC.md"), "utf8");

function section(heading: string, nextHeading: string, source = spec): string {
	const start = source.indexOf(heading);
	const end = source.indexOf(nextHeading, start + heading.length);
	assert.ok(start >= 0 && end > start, `SPEC section bounds are missing: ${heading} -> ${nextHeading}`);
	return source.slice(start, end);
}

function paragraphStarting(source: string, heading: string, nextHeading: string, opening: string): string {
	const body = section(heading, nextHeading, source);
	const matches = body.split("\n\n").filter((paragraph) => paragraph.startsWith(opening));
	assert.equal(matches.length, 1, `expected one paragraph beginning ${opening}`);
	return matches[0];
}

function assertModeResolution(source: string): void {
	const paragraph = paragraphStarting(
		source,
		"### 5.6 Operating modes",
		"### 5.7 Unattended conduct",
		"Each setting resolves separately",
	);
	const sources = [
		"`--execution-mode`, `--decision-mode`",
		"`GITJIG_EXECUTION_MODE`, `GITJIG_DECISION_MODE`",
		"`<resolved-state-root>/modes.json`",
		"then its default",
	];
	let prior = -1;
	for (const token of sources) {
		const at = paragraph.indexOf(token);
		assert.ok(at > prior, `mode source is missing or out of precedence order: ${token}`);
		prior = at;
	}
}

const BOUNDARY_SENTENCE =
	"Trusted-account attribution, approval of an SSOT correction or genuinely new authorization, reversal of deliberate human state, disposal of another party's filed work, credentials, server configuration, another repository, and public or unretractable acts remain non-substitutable and park when reached.";

function assertHardBoundarySentence(source: string): void {
	const paragraph = paragraphStarting(
		source,
		"### 5.7 Unattended conduct",
		"### 5.8 Context lifecycle",
		"**Generation is open, decision is gated.**",
	);
	const start = paragraph.indexOf("Trusted-account attribution");
	const end = paragraph.indexOf("park when reached.", start);
	assert.ok(start >= 0 && end >= start, "the shared hard-boundary consequence sentence is missing");
	assert.equal(paragraph.slice(start, end + "park when reached.".length), BOUNDARY_SENTENCE);
}

function assertDiagnosisAuthority(source: string): void {
	const body = section("### 1.4 Cross-review repair", "### 1.5 Delegated work", source);
	for (const stale of [
		"answers whether a further autonomous repair attempt is admissible",
		"decides whether the next act is an autonomous repair attempt",
		"this value hands off",
		"the value says whether the next act is an autonomous repair attempt or a handoff",
		"whatever the taxonomy value admits",
		"under NONE the repair simply continues",
		"repair the value admits",
		"relief only NONE grants",
	]) {
		assert.ok(!body.includes(stale), `a taxonomy value still carries action authority: ${stale}`);
	}
	assert.ok(body.includes("the value never authorizes an act"));
	assert.ok(body.includes("decision mode alone selects the recipient of an interruption"));
}

function assertPanelModeSplit(source: string): void {
	const paragraph = paragraphStarting(
		source,
		"### 1.7 The reviewer panel",
		"### 1.8 Plan contest",
		"Majority vote is the **rejected design**",
	);
	for (const token of [
		"At **plan selection**, decision mode `handoff` uses a human",
		"`autonomous` uses §1.8's mutually blind contest and independent Judge",
		"a reviewer verdict never substitutes there",
		"At the **ready decision**, execution mode `attended` stops for a human",
		"`unattended` may use the existing reviewer-verdict fallback",
		"decision mode grants no merge authority",
		"complete panel",
		"at least one required slot",
	]) {
		assert.ok(paragraph.includes(token), `the plan/ready mode split dropped: ${token}`);
	}
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

	it("pins resolution inputs, precedence, defaults, failure direction, and the single project-value home", () => {
		assertModeResolution(spec);
		for (const token of [
			"`attended` — the default",
			"`handoff` — the default",
			"`executionMode` or `decisionMode` field",
			"execution value falls toward `attended`",
			"decision value toward `handoff`",
		]) {
			assert.ok(modes.includes(token), `mode resolution lost ${token}`);
		}
		const swapped = spec.replace(
			"through its invocation flag (`--execution-mode`, `--decision-mode`), then its environment value (`GITJIG_EXECUTION_MODE`, `GITJIG_DECISION_MODE`)",
			"through its environment value (`GITJIG_EXECUTION_MODE`, `GITJIG_DECISION_MODE`), then its invocation flag (`--execution-mode`, `--decision-mode`)",
		);
		assert.notEqual(swapped, spec, "the precedence mutant anchor did not match");
		assert.throws(() => assertModeResolution(swapped), /out of precedence order/);
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

	it("does not stack the soft budget or detach a hard boundary from its mandatory park", () => {
		assert.ok(unattended.includes("one intervention spends both rather than stacking attempts"));
		assertHardBoundarySentence(spec);
		const permitted = spec.replace(
			"disposal of another party's filed work, credentials",
			"disposal of another party's filed work is permitted; credentials",
		);
		assert.notEqual(permitted, spec, "the contradictory-permission mutant anchor did not match");
		assert.throws(() => assertHardBoundarySentence(permitted));
		assert.ok(
			unattended.includes(
				"Autonomous decision mode changes the independent consumer at §5.6's closed three-checkpoint set, never another gate",
			),
		);
	});

	it("keeps taxonomy values classification-only across every §1.4 authority cluster", () => {
		assertDiagnosisAuthority(spec);
		for (const stale of [
			"answers whether a further autonomous repair attempt is admissible",
			"this value hands off",
			"whatever the taxonomy value admits",
			"relief only NONE grants",
		]) {
			const mutated = spec.replace("\n### 1.5 Delegated work", `\n${stale}\n\n### 1.5 Delegated work`);
			assert.notEqual(mutated, spec, "the §1.4 authority mutant anchor did not match");
			assert.throws(() => assertDiagnosisAuthority(mutated), /still carries action authority/);
		}
	});

	it("separates decision-mode plan selection from execution-mode ready fallback", () => {
		assertPanelModeSplit(spec);
		const planSubstitution = spec.replace(
			"a reviewer verdict never substitutes there",
			"a reviewer verdict may substitute there",
		);
		assert.notEqual(planSubstitution, spec, "the plan-substitution mutant anchor did not match");
		assert.throws(() => assertPanelModeSplit(planSubstitution), /plan\/ready mode split dropped/);
		const readyOwnership = spec.replace(
			"At the **ready decision**, execution mode `attended` stops for a human",
			"At the **ready decision**, decision mode `handoff` stops for a human",
		);
		assert.notEqual(readyOwnership, spec, "the ready-ownership mutant anchor did not match");
		assert.throws(() => assertPanelModeSplit(readyOwnership), /plan\/ready mode split dropped/);
	});
});

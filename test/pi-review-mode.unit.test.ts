import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseReviewRoundSpec } from "../.pi/extensions/gitjig/commands/review-round.ts";
import { provisionalCheckpointApplies, type RunDispatchOptions } from "../.pi/extensions/gitjig/dispatch/index.ts";
import { contestSelectorBrief, piRecoveryBrief } from "../.pi/extensions/gitjig/recovery/briefs.ts";
import { makeRecoveryProfileDispatcher } from "../.pi/extensions/gitjig/recovery/coordinator.ts";
import { composeJudgeBrief, composeReviewerBrief } from "../.pi/extensions/gitjig/review/briefs.ts";
import { createRecoveryAttemptLedger, makeDispatcher } from "../.pi/extensions/gitjig/review/orchestrate.ts";

test("review-round mode is explicit, closed and exclusive of generic argv", () => {
	const spec = {
		pr: 370,
		changeDescription: "Pi mode",
		fences: {
			outOfScope: [],
			forbiddenRemedies: [],
			deferralHomes: [],
			priorFindings: [],
		},
		pi: { piExecutable: "/usr/local/bin/pi", provider: "scripted", model: "scripted-model" },
	};
	const parsed = parseReviewRoundSpec(spec);
	assert.ok(parsed);
	assert.equal(parsed.delegateArgv, undefined);
	assert.equal(parseReviewRoundSpec({ ...spec, delegateArgv: ["pi"] }), undefined);
	assert.equal(parseReviewRoundSpec({ ...spec, pi: { ...spec.pi, role: "judge" } }), undefined);
	assert.equal(parseReviewRoundSpec({ ...spec, pi: { ...spec.pi, provider: "--mode" } }), undefined);
});

test("production review-round carries explicit Pi selection into recovery without delegate-selected roles", () => {
	const source = readFileSync(new URL("../.pi/extensions/gitjig/commands/review-round.ts", import.meta.url), "utf8");
	const recovery = source.match(/recoveryDispatch: makeRecoveryProfileDispatcher\(\{([\s\S]*?)\n\s*\}\),/)?.[1];
	assert.ok(recovery);
	// `spec` is optional here because #404's `reenter pr=<n>` path builds the
	// same seams with no spec at all; the Pi selection still comes only from an
	// explicit spec, never from a delegate.
	assert.match(recovery, /spec\?\.pi === undefined \? \{\} : \{ pi: spec\.pi \}/);
	assert.doesNotMatch(recovery.replace("...(spec?.pi === undefined ? {} : { pi: spec.pi })", ""), /pi: spec\.pi/);
});

test("consumer-owned Pi briefs use submit_result, not the generic direct return writer", () => {
	const fences = { outOfScope: [], forbiddenRemedies: [], deferralHomes: [], priorFindings: [] };
	const timing = { firstReturnSeconds: 5, finalReturnSeconds: 9 };
	const reviewer = composeReviewerBrief(
		{ lens: "runtime", surface: "code" },
		{ changeDescription: "test" },
		fences,
		timing,
		"pi",
	);
	const judge = composeJudgeBrief(
		[],
		{ state: "present", criteria: [] },
		{ changeDescription: "test" },
		fences,
		timing,
		// No completeness re-request: §1.7's bounded second call is orthogonal
		// to the transport this arm measures.
		undefined,
		"pi",
	);
	const recovery = piRecoveryBrief(contestSelectorBrief([]));
	for (const [brief, prohibition] of [
		[reviewer, "Do NOT write\n../return.json directly,"],
		[judge, "Do NOT write\n../return.json directly,"],
		[recovery, "never write ../return.json directly."],
	]) {
		assert.match(brief, /submit_result/);
		// Every mention of the file is its prohibition: present, and alone.
		assert.ok(brief.includes(prohibition), "the settled prohibition is absent");
		assert.equal(
			brief.split("../return.json").length,
			brief.split(prohibition).length,
			"the file is mentioned outside its prohibition",
		);
		assert.doesNotMatch(
			brief,
			/RETURN: write JSON|provisional \.\.\/return\.json|Return only through \.\.\/return\.json/,
		);
	}
	assert.match(
		composeReviewerBrief({ lens: "runtime", surface: "code" }, { changeDescription: "test" }, fences, timing),
		/RETURN: write JSON/,
	);
	assert.match(contestSelectorBrief([]), /Return only through \.\.\/return\.json/);
	assert.throws(() => piRecoveryBrief("a caller-supplied arbitrary brief"));
});

test("consumer chooses reviewer, Judge and history roles before each Pi dispatch", async () => {
	const roles: string[] = [];
	const options: Omit<RunDispatchOptions, "brief" | "expectedRef"> = {
		callerRepoRoot: "/fixture",
		stateRoot: "/state",
		delegateArgv: [],
		pi: { piExecutable: "/bin/pi", provider: "scripted", model: "scripted-model", role: "reviewer" },
	};
	const dispatch = makeDispatcher(options, async (input) => {
		roles.push(input.pi?.role ?? "missing");
		return {
			disposition: "admitted",
			ok: true,
			summary: "test",
			compare: "confirmed",
			diagnostic: {
				schemaVersion: 1,
				status: "admitted",
				phase: "compare",
				run: { class: "exited", exitCode: 0, signal: null },
				return: { class: "admitted" },
				compare: { class: "confirmed" },
				durationMs: 1,
				code: "ADMITTED",
				message: "dispatch admitted",
			},
		};
	});
	for (const role of ["reviewer", "judge", "history"] as const) await dispatch("brief", "a".repeat(40), role);
	assert.deepEqual(roles, ["reviewer", "judge", "history"]);
	await assert.rejects(dispatch("brief", "a".repeat(40)));
});

// #370: the recovery route's four roles ride the same installation path, and
// the dispatcher refuses outright rather than defaulting a role when the
// consumer supplies none under explicit Pi mode.
test("every recovery role is installed into the Pi invocation, and a missing one refuses", async () => {
	const roles: string[] = [];
	const options: Omit<RunDispatchOptions, "brief" | "expectedRef"> = {
		callerRepoRoot: "/fixture",
		stateRoot: "/state",
		delegateArgv: [],
		pi: { piExecutable: "/bin/pi", provider: "scripted", model: "scripted-model", role: "challenger" },
	};
	const dispatch = makeDispatcher(options, async (input) => {
		roles.push(input.pi?.role ?? "missing");
		return {
			disposition: "admitted",
			ok: true,
			summary: "test",
			compare: "confirmed",
			diagnostic: {
				schemaVersion: 1,
				status: "admitted",
				phase: "compare",
				run: { class: "exited", exitCode: 0, signal: null },
				return: { class: "admitted" },
				compare: { class: "confirmed" },
				durationMs: 1,
				code: "ADMITTED",
				message: "dispatch admitted",
			},
		};
	});
	const recovery = ["challenger", "selector-contest", "selector-measurement", "measurement", "diagnosis"] as const;
	for (const role of recovery) await dispatch("brief", "a".repeat(40), role);
	assert.deepEqual(roles, [...recovery]);
	await assert.rejects(dispatch("brief", "a".repeat(40)), /Pi role unavailable from consumer/);
	// The recovery dispatcher's own guard, at its own message: explicit Pi mode
	// with no consumer-supplied role is a refusal, never a defaulted role.
	const profileDispatch = makeRecoveryProfileDispatcher({
		repoRoot: process.cwd(),
		stateRoot: "/state",
		pi: { piExecutable: "/bin/pi", provider: "scripted", model: "scripted-model" },
	});
	// Each producer declares its own transport, which is what spares an
	// explicitly selected Pi route the ambient generic executable's preflight.
	assert.equal(profileDispatch.transport, "pi");
	assert.equal(makeRecoveryProfileDispatcher({ repoRoot: process.cwd(), stateRoot: "/state" }).transport, "generic");
	await assert.rejects(
		profileDispatch(
			createRecoveryAttemptLedger(performance.now()),
			"recovery-selector",
			"brief",
			"b".repeat(40),
			performance.now() + 5_000,
		),
		/recovery Pi role unavailable from consumer/,
	);
});

// #370: the mid-run provisional checkpoint is the generic argv contract's. A
// Pi child owes no provisional ../return.json under SPEC §1.7 and submits once
// through its trusted tool, so arming that abort under Pi mode would cancel a
// conforming child before its permitted submission.
test("the provisional-return checkpoint governs generic argv dispatch only", () => {
	const pi = { piExecutable: "/bin/pi", provider: "scripted", model: "scripted-model", role: "challenger" } as const;
	assert.equal(provisionalCheckpointApplies({ operationDeadline: 1_000 }), true);
	assert.equal(provisionalCheckpointApplies({ operationDeadline: 1_000, pi }), false);
	// No bounded operation, no checkpoint, on either transport.
	assert.equal(provisionalCheckpointApplies({}), false);
	assert.equal(provisionalCheckpointApplies({ pi }), false);
	// The production call site is the one that must consult it.
	const source = readFileSync(new URL("../.pi/extensions/gitjig/dispatch/index.ts", import.meta.url), "utf8");
	const armed = source.slice(source.indexOf("if (checkpointAbort !== undefined) {"));
	const provisional = armed.slice(0, armed.indexOf("360_000"));
	assert.match(provisional, /if \(provisionalCheckpointApplies\(options\)\)/);
});

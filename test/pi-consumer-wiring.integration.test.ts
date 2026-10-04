/**
 * #422 (part 7 of #370): the consumer wiring, and the head at which an
 * operator can first select Pi at all.
 *
 * `test/pi-review-mode.unit.test.ts` carries the selection and role arms from
 * the implementation basis. This file measures what that one does not: the
 * words each transport-selected brief must and must not carry, §1.7's shared
 * retry as a REPEATED CALL rather than as a count, its trigger enumerated over
 * the dispatcher's own diagnostic codes, its event's one-to-one relation to
 * the send it announces, and the independent validity of the second return at
 * every consumer this part routes it through.
 *
 * As in parts 4 to 6, every arm is a named function used twice — once by the
 * test that asserts it holds, and once by the mutant, which runs THAT ARM and
 * requires it to throw. A mutant asserted in its own words would report a kill
 * no arm observed, and a harness fault is never a kill.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseReviewRoundSpec } from "../.pi/extensions/gitjig/commands/review-round.ts";
import { DIAGNOSTIC_MESSAGES } from "../.pi/extensions/gitjig/dispatch/diagnostics.ts";
import type { DispatchOutcome, RunDispatchOptions } from "../.pi/extensions/gitjig/dispatch/index.ts";
import { registerDispatchTool } from "../.pi/extensions/gitjig/dispatch/index.ts";
import { exposedPiProfile } from "../.pi/extensions/gitjig/dispatch/pi-submit.ts";
import {
	challengerBrief,
	contestSelectorBrief,
	freshDiagnosisBrief,
	measurementBrief,
	measurementSelectorBrief,
	piRecoveryBrief,
} from "../.pi/extensions/gitjig/recovery/briefs.ts";
import { type RecoveryPiRole, recoveryPiProfile } from "../.pi/extensions/gitjig/recovery/pi-profile.ts";
import {
	composeJudgeBrief,
	composeReviewerBrief,
	PI_RETURN_PROTOCOL_RETRY_SUFFIX,
	RETURN_PROTOCOL_RETRY_SUFFIX,
} from "../.pi/extensions/gitjig/review/briefs.ts";
import { composeDiagnosisBrief } from "../.pi/extensions/gitjig/review/history.ts";
import {
	createRecoveryAttemptLedger,
	makeDispatcher,
	reviewRound,
} from "../.pi/extensions/gitjig/review/orchestrate.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const ORCHESTRATE = "review/orchestrate.ts";

type Sent = { brief: string; options: RunDispatchOptions };
type Arm = (make: typeof makeDispatcher) => Promise<void>;

/*
 * Outcomes by the dispatcher's own diagnostic code, so the trigger enumeration
 * below is over that set rather than over a description of it.
 */
const PIN = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const refused = (code: keyof typeof DIAGNOSTIC_MESSAGES, over: Record<string, unknown> = {}): DispatchOutcome =>
	({
		disposition: "refused",
		cause: DIAGNOSTIC_MESSAGES[code],
		diagnostic: {
			status: "refused",
			phase: "return",
			run: { class: "exited", exitCode: 1, signal: null },
			return: { class: "missing" },
			compare: { class: "not-reached" },
			durationMs: 1,
			code,
			...over,
		},
	}) as unknown as DispatchOutcome;

const admitted = (): DispatchOutcome =>
	({
		disposition: "admitted",
		result: { ok: true, output: "{}", summary: "ok" },
		compare: "confirmed",
		diagnostic: {
			status: "admitted",
			phase: "complete",
			run: { class: "exited", exitCode: 0, signal: null },
			return: { class: "admitted" },
			compare: { class: "confirmed" },
			durationMs: 1,
			code: "ADMITTED",
		},
	}) as unknown as DispatchOutcome;

/** A dispatcher over a scripted sequence of outcomes, recording every send. */
function scripted(
	make: typeof makeDispatcher,
	outcomes: readonly DispatchOutcome[],
	options: Partial<RunDispatchOptions> = {},
): {
	dispatch: (brief: string, head: string, role?: string) => Promise<DispatchOutcome>;
	sent: Sent[];
	events: string[];
} {
	const sent: Sent[] = [];
	const events: string[] = [];
	let cursor = 0;
	const base = {
		callerRepoRoot: "/r",
		stateRoot: "/s",
		delegateArgv: ["delegate"],
		timeoutMs: 10,
		...options,
	} as unknown as Omit<RunDispatchOptions, "brief" | "expectedRef">;
	const dispatch = make(
		base,
		async (given: RunDispatchOptions) => {
			sent.push({ brief: given.brief, options: given });
			// A send past the script is admitted rather than thrown: an extra send
			// is the arm's own observation to fail on, and an exception here would
			// reach the mutant harness as a fault instead of as a kill.
			return cursor >= outcomes.length ? admitted() : outcomes[cursor++];
		},
		(event: "retry-return-protocol") => events.push(event),
	);
	return { dispatch: dispatch as never, sent, events };
}

const PI = { piExecutable: "/usr/bin/pi", provider: "scripted", model: "scripted-model" };

/** Every recovery role; the type below fails to compile if the union gains one this list lacks. */
const RECOVERY_PI_ROLES = [
	"challenger",
	"selector-contest",
	"selector-measurement",
	"measurement",
	"diagnosis",
] as const satisfies readonly RecoveryPiRole[];
const ALL_RECOVERY_ROLES: Exclude<RecoveryPiRole, (typeof RECOVERY_PI_ROLES)[number]> extends never ? true : never =
	true;
void ALL_RECOVERY_ROLES;

/*
 * The arms.
 */

/** §1.7: the retry repeats the SAME call — options, pin and brief plus only the suffix. */
const armRepeatsTheSameCall: Arm = async (make) => {
	for (const [label, pi, suffix] of [
		["generic", undefined, RETURN_PROTOCOL_RETRY_SUFFIX],
		["pi", PI, PI_RETURN_PROTOCOL_RETRY_SUFFIX],
	] as ReadonlyArray<readonly [string, typeof PI | undefined, string]>) {
		const run = scripted(make, [refused("RETURN_MISSING"), admitted()], {
			...(pi === undefined ? {} : { pi, delegateArgv: undefined }),
		} as Partial<RunDispatchOptions>);
		await run.dispatch("the semantic brief", PIN, pi === undefined ? undefined : "reviewer");
		assert.equal(run.sent.length, 2, `${label}: sends`);
		// The first send carries the consumer's semantic brief unchanged — the
		// retry is the SAME call repeated, so the thing repeated is pinned too.
		assert.equal(run.sent[0].brief, "the semantic brief", `${label}: the first brief`);
		// The second send is that brief again, plus exactly the suffix.
		assert.equal(run.sent[1].brief, `the semantic brief${suffix}`, `${label}: the retry's brief`);
		assert.equal(run.sent[1].options.expectedRef, PIN, `${label}: the retry's pin`);
		assert.equal(run.sent[0].options.expectedRef, PIN, `${label}: the first pin`);
		// Every other option is identical between the two calls.
		const shape = (sent: Sent) => {
			const { brief: _brief, ...rest } = sent.options as unknown as Record<string, unknown>;
			return JSON.stringify(rest);
		};
		assert.equal(shape(run.sent[1]), shape(run.sent[0]), `${label}: the retry changed an option`);
		// And the suffix is the one its transport owns, not the other's.
		const other = pi === undefined ? PI_RETURN_PROTOCOL_RETRY_SUFFIX : RETURN_PROTOCOL_RETRY_SUFFIX;
		assert.equal(run.sent[1].brief.includes(other), false, `${label}: the other transport's suffix was sent`);
	}
};

type OrchestratorModule = {
	makeDispatcher: typeof makeDispatcher;
	createRecoveryAttemptLedger: typeof createRecoveryAttemptLedger;
};

/**
 * §1.7 under the recovery attempt policy: the retry repeats every option, the
 * Pi selection and pin included. The one field that differs is `enteredAt`,
 * the origin each send's diagnostic duration is measured from. It is a
 * measurement, not a caller option: the retry's own duration must start at the
 * retry, or attempt two would report a duration spanning both. Bounds come from
 * `operationDeadline`, which repeats. Both halves are read here, not assumed.
 */
async function armRepeatsUnderTheAttemptPolicy({
	makeDispatcher: make,
	createRecoveryAttemptLedger: ledgerOf,
}: OrchestratorModule): Promise<void> {
	const sent: { options: RunDispatchOptions; returnedAt: number }[] = [];
	const outcomes = [refused("RETURN_MISSING"), admitted()];
	const dispatch = make(
		{
			callerRepoRoot: "/r",
			stateRoot: "/s",
			delegateArgv: [],
			pi: { ...PI, role: "challenger" },
			timeoutMs: 600_000,
			operationDeadline: performance.now() + 3_600_000,
		} as unknown as Omit<RunDispatchOptions, "brief" | "expectedRef">,
		async (given: RunDispatchOptions) => {
			const outcome = outcomes[sent.length] ?? admitted();
			sent.push({ options: given, returnedAt: performance.now() });
			return outcome;
		},
		{ attemptPolicy: { ledger: ledgerOf(performance.now()), beforeRetry: () => true } },
	);
	await dispatch("the semantic brief", PIN, "challenger");
	assert.equal(sent.length, 2, "the policy path did not retry once");
	const [first, second] = sent;
	const rest = ({ options }: (typeof sent)[number]) => {
		const { brief: _brief, enteredAt: _enteredAt, ...others } = options as unknown as Record<string, unknown>;
		return JSON.stringify(others);
	};
	assert.equal(rest(second), rest(first), "the retry changed an option other than its measurement origin");
	assert.equal(second.options.brief, `the semantic brief${PI_RETURN_PROTOCOL_RETRY_SUFFIX}`);
	assert.equal(typeof first.options.enteredAt, "number", "the first send carried no measurement origin");
	assert.equal(typeof second.options.enteredAt, "number", "the retry carried no measurement origin");
	// The retry's origin is its own: no earlier than the instant the first send returned.
	assert.ok(
		(second.options.enteredAt as number) >= first.returnedAt,
		"the retry's duration would be measured from the first send",
	);
}

/** §1.7: exactly one combination retries, enumerated over the dispatcher's codes. */
const armEnumeratesTheTrigger: Arm = async (make) => {
	const codes = Object.keys(DIAGNOSTIC_MESSAGES) as (keyof typeof DIAGNOSTIC_MESSAGES)[];
	// The enumeration is complete over the dispatcher's own set: a code added
	// there without a disposition here fails this arm rather than passing it.
	assert.deepEqual(codes.sort(), [
		"ABORTED",
		"ADMITTED",
		"INTERNAL_FAILED",
		"PARAMETER_REFUSED",
		"PROVISION_FAILED",
		"RETURN_JSON_INVALID",
		"RETURN_MISSING",
		"RETURN_NOT_REGULAR",
		"RETURN_OPERAND_REJECTED",
		"RETURN_OVERSIZE",
		"RETURN_SCHEMA_INVALID",
		"RETURN_UNREADABLE",
		"SIGNAL_TERMINATED",
		"SPAWN_FAILED",
		"TIMED_OUT",
	]);
	// The one that retries, at both ends of the exit range.
	for (const exitCode of [0, 7]) {
		const run = scripted(make, [
			refused("RETURN_MISSING", { run: { class: "exited", exitCode, signal: null } }),
			admitted(),
		]);
		await run.dispatch("brief", PIN);
		assert.equal(run.sent.length, 2, `exit ${exitCode} with a missing return must retry`);
	}
	// And every other code, each drawing exactly one send.
	for (const code of codes) {
		if (code === "ADMITTED") {
			const run = scripted(make, [admitted()]);
			await run.dispatch("brief", PIN);
			assert.equal(run.sent.length, 1, "an admitted return retried");
			continue;
		}
		const over: Record<string, unknown> =
			code === "RETURN_MISSING"
				? // The same refusal, reached without a numeric exit: a signal is not one.
					{ run: { class: "signaled", exitCode: null, signal: "SIGKILL" } }
				: code === "SIGNAL_TERMINATED"
					? { run: { class: "signaled", exitCode: null, signal: "SIGKILL" }, return: { class: "not-inspected" } }
					: code === "TIMED_OUT" || code === "ABORTED" || code === "SPAWN_FAILED"
						? {
								run: { class: code === "SPAWN_FAILED" ? "not-started" : "exited", exitCode: null, signal: null },
								return: { class: "not-inspected" },
							}
						: code === "PARAMETER_REFUSED" || code === "PROVISION_FAILED"
							? { run: { class: "not-started", exitCode: null, signal: null }, return: { class: "not-inspected" } }
							: code === "INTERNAL_FAILED"
								? { return: { class: "not-inspected" } }
								: { return: { class: "regular" } };
		const run = scripted(make, [refused(code, over)]);
		await run.dispatch("brief", PIN);
		assert.equal(run.sent.length, 1, `${code} drew a second send`);
		if (code === "RETURN_MISSING") continue;
		// The code decides, not the lifecycle it records: each other code with the
		// trigger's own exited, numeric, missing-return shape still sends once.
		for (const exitCode of [0, 7]) {
			const lookalike = scripted(make, [
				refused(code, { run: { class: "exited", exitCode, signal: null }, return: { class: "missing" } }),
			]);
			await lookalike.dispatch("brief", PIN);
			assert.equal(lookalike.sent.length, 1, `${code} at exit ${exitCode} with a missing return drew a second send`);
		}
	}
};

/** §1.7: the event stands one-to-one with the send it announces, and before it. */
const armAnnouncesEachRetryOnce: Arm = async (make) => {
	const retried = scripted(make, [refused("RETURN_MISSING"), admitted()]);
	await retried.dispatch("brief", PIN);
	assert.deepEqual(retried.events, ["retry-return-protocol"], "one event per second send");
	// Without a second send there is no event at all.
	const once = scripted(make, [admitted()]);
	await once.dispatch("brief", PIN);
	assert.deepEqual(once.events, [], "an event fired without a send");
	// A throwing observer cannot alter the authorized act, and an absent one
	// changes nothing: a fixture's observation is not part of the transport.
	for (const observer of [
		() => {
			throw new Error("the observer refuses");
		},
		undefined,
	]) {
		const sent: Sent[] = [];
		let cursor = 0;
		const outcomes = [refused("RETURN_MISSING"), admitted()];
		const dispatch = make(
			{ callerRepoRoot: "/r", stateRoot: "/s", delegateArgv: ["delegate"] } as never,
			async (given: RunDispatchOptions) => {
				sent.push({ brief: given.brief, options: given });
				return outcomes[cursor++];
			},
			observer as never,
		);
		await (dispatch as never as (brief: string, head: string) => Promise<DispatchOutcome>)("brief", PIN);
		assert.equal(sent.length, 2, "a throwing or absent observer changed the sends");
		assert.equal(sent[1].brief.endsWith(RETURN_PROTOCOL_RETRY_SUFFIX), true);
	}
};

/** §1.7: only the second call's own valid return satisfies the consumer. */
const armRequiresTheRetrysOwnReturn: Arm = async (make) => {
	// A retry that again returns nothing leaves the SECOND outcome standing —
	// the first is not reused, and nothing is invented.
	const second = refused("RETURN_MISSING", { durationMs: 2 });
	const run = scripted(make, [refused("RETURN_MISSING"), second]);
	const outcome = await run.dispatch("brief", PIN);
	assert.equal(run.sent.length, 2);
	assert.equal(outcome, second, "the consumer was given something other than the retry's own outcome");
	// A malformed second return is likewise the outcome: refused, not admitted.
	const malformed = refused("RETURN_SCHEMA_INVALID", { return: { class: "schema-invalid" } });
	const other = scripted(make, [refused("RETURN_MISSING"), malformed]);
	const result = await other.dispatch("brief", PIN);
	assert.equal(result, malformed);
	assert.equal((result as { disposition: string }).disposition, "refused");
};

/** §4.9: a Pi brief submits through the tool and never instructs a direct write. */
/** The settled prohibitions, by their own bytes: the review contract's and the recovery projection's. */
const REVIEW_PROHIBITION =
	"Do NOT write\n../return.json directly, choose a role, supply a commit hash, or encode an outer return envelope.";
const RECOVERY_PROHIBITION = "Submit only via the trusted submit_result tool; never write ../return.json directly.";

/**
 * A Pi brief forbids the direct write and says nothing else about the file:
 * the prohibition is present by its own bytes, and every mention of the path
 * lies inside one of them. Disconnected substrings would admit a brief that
 * forbids nothing and instructs the write in the next sentence.
 */
function assertOnlyForbidsTheFile(brief: string, prohibition: string, label: string): void {
	const mentions = brief.split("../return.json").length - 1;
	const forbidding = brief.split(prohibition).length - 1;
	assert.ok(forbidding >= 1, `${label}: the settled prohibition is absent`);
	assert.equal(mentions, forbidding, `${label}: the file is mentioned outside its prohibition`);
}

type ReviewBriefs = { composeReviewerBrief: typeof composeReviewerBrief; composeJudgeBrief: typeof composeJudgeBrief };
type RecoveryBriefs = {
	challengerBrief: typeof challengerBrief;
	contestSelectorBrief: typeof contestSelectorBrief;
	measurementSelectorBrief: typeof measurementSelectorBrief;
	measurementBrief: typeof measurementBrief;
	freshDiagnosisBrief: typeof freshDiagnosisBrief;
	piRecoveryBrief: typeof piRecoveryBrief;
};

/** One generic brief per recovery role, over fixed inputs. */
function recoveryRoleBriefs(briefs: RecoveryBriefs): ReadonlyArray<readonly [RecoveryPiRole, string]> {
	const diagnosis = { value: "STAGNATION", invalidation: "nothing", evidence: "the repairs repeated" } as never;
	const basis = { states: [], intervals: [] } as never;
	const spec = {
		kind: "measurement",
		question: "q",
		method: "m",
		expectedDiscriminator: "d",
		evidence: "e",
		nonMutating: true,
		notPreviouslyPresent: true,
	} as never;
	const result = { kind: "measurement-result", specDigest: "0".repeat(64), result: "r", evidence: "e" } as never;
	return [
		["challenger", briefs.challengerBrief("root", diagnosis, basis)],
		[
			"selector-contest",
			briefs.contestSelectorBrief([{ slot: "root", outcome: "ALTERNATIVE", method: "m", evidence: "e" }] as never),
		],
		["selector-measurement", briefs.measurementSelectorBrief(diagnosis, basis)],
		["measurement", briefs.measurementBrief(spec)],
		["diagnosis", briefs.freshDiagnosisBrief(diagnosis, basis, spec, result)],
	];
}

function armSelectsTheTransportsBrief({ composeReviewerBrief, composeJudgeBrief }: ReviewBriefs): void {
	// Unusual on purpose: a deadline the composer fixed itself cannot equal these.
	const timing = { firstReturnSeconds: 311, finalReturnSeconds: 1433 };
	const context = { changeDescription: "a change" };
	const fences = { outOfScope: [], forbiddenRemedies: [], deferralHomes: [], priorFindings: [] };
	const slot = { lens: "suite", surface: "the test suite" };
	const manifest = { state: "absent" } as const;
	for (const [label, generic, pi] of [
		[
			"reviewer",
			composeReviewerBrief(slot as never, context, fences, timing, "generic"),
			composeReviewerBrief(slot as never, context, fences, timing, "pi"),
		],
		[
			"judge",
			composeJudgeBrief([], manifest, context, fences, timing, undefined, "generic"),
			composeJudgeBrief([], manifest, context, fences, timing, undefined, "pi"),
		],
	] as ReadonlyArray<readonly [string, string, string]>) {
		// The Pi brief names the tool, and carries the settled prohibition of
		// writing the file directly — an absence would not forbid it.
		assert.match(pi, /submit_result/, `${label}: the Pi brief never names the tool`);
		assertOnlyForbidsTheFile(pi, REVIEW_PROHIBITION, label);
		// And it carries no instruction TO write one, provisional or final.
		assert.equal(
			/write a complete provisional|overwrite it with the final|rides the return's "payload" slot/.test(pi),
			false,
			`${label}: the Pi brief instructs a direct write`,
		);
		// Its deadline wording is the transport's own.
		assert.match(pi, /call submit_result once with/, `${label}: the Pi deadline wording`);
		// And the deadline it states is the caller's, in seconds from T0.
		assert.ok(
			pi.includes("final typed result by T0+1433 seconds."),
			`${label}: the Pi brief's deadline is not the caller's`,
		);
		assert.match(pi, /settled agent is not a result/, `${label}: the Pi absent-submission wording`);
		// The generic brief is untouched by any of that.
		assert.equal(generic.includes("submit_result"), false, `${label}: the generic brief names the tool`);
		assert.match(generic, /\.\.\/return\.json/, `${label}: the generic brief lost its direct-file instruction`);
		assert.equal(/call submit_result once with/.test(generic), false, `${label}: the Pi deadline wording leaked`);
	}
}

/** The recovery brief is a projection that refuses rather than half-rewrites. */
function armProjectsTheRecoveryBrief(briefs: RecoveryBriefs): void {
	const { challengerBrief, measurementBrief, piRecoveryBrief } = briefs;
	// Every recovery role's projection, in what it says and withholds: the
	// tool, the prohibition alone, the transport's own deadline and
	// absent-submission words, and no generic writer.
	for (const [role, generic] of recoveryRoleBriefs(briefs)) {
		const projected = piRecoveryBrief(generic);
		assert.match(projected, /submit_result/, `${role}: the tool`);
		assertOnlyForbidsTheFile(projected, RECOVERY_PROHIBITION, role);
		assert.match(projected, /single complete final typed submission within 540 seconds/, `${role}: the Pi deadline`);
		assert.match(
			projected,
			/a settled agent without a valid tool submission is not a result/,
			`${role}: the absent-submission words`,
		);
		assert.equal(/provisional/i.test(projected), false, `${role}: a provisional instruction survived`);
		assert.match(generic, /\.\.\/return\.json/, `${role}: the generic brief lost its writer`);
		assert.equal(/submit_result|typed submission/.test(generic), false, `${role}: Pi words on the generic brief`);
	}
	const diagnosis = { value: "STAGNATION", invalidation: "nothing", evidence: "the repairs repeated" };
	const basis = { states: [], intervals: [] };
	const generic = challengerBrief("root", diagnosis as never, basis as never);
	const pi = piRecoveryBrief(generic);
	assert.match(pi, /submit_result/);
	assertOnlyForbidsTheFile(pi, RECOVERY_PROHIBITION, "challenger");
	assert.equal(/required provisional\/final \.\.\/return\.json/.test(pi), false, "the generic writer survived");
	assert.match(pi, /a settled agent without a valid tool submission is not a result/);
	// Each anchor the projection depends on: with it absent or doubled, the
	// projection refuses instead of rewriting half a brief.
	const anchors = [
		"Read-only evidence only: do not make any public/server or platform act",
		"The decoded payload must be exact JSON of shape ",
	];
	for (const anchor of anchors) {
		assert.ok(generic.includes(anchor), `the generic brief lost an anchor: ${anchor}`);
		assert.throws(() => piRecoveryBrief(generic.replace(anchor, "")), /refused/, `absent: ${anchor}`);
		assert.throws(() => piRecoveryBrief(generic + generic), /refused/, "duplicated anchors");
	}
	// A measurement brief projects the same way, so no role is left generic.
	const measurement = piRecoveryBrief(
		measurementBrief({ question: "q", method: "m", expectedDiscriminator: "d", kind: "measurement" } as never),
	);
	assert.match(measurement, /submit_result/);
	assertOnlyForbidsTheFile(measurement, RECOVERY_PROHIBITION, "measurement");
	// What the brief offers, the tool accepts: no recovery role's exposed
	// schema has a summary field, so no recovery brief may invite one.
	for (const role of RECOVERY_PI_ROLES) {
		const profile = recoveryPiProfile(role, "0".repeat(64));
		assert.ok(profile, `${role}: no profile`);
		const exposed = exposedPiProfile(profile);
		assert.equal(exposed.schema.additionalProperties, false, `${role}: the exposed schema is not closed`);
		assert.equal("summary" in (exposed.schema.properties ?? {}), false, `${role}: the exposed schema gained a summary`);
	}
	for (const brief of [pi, measurement])
		assert.equal(
			/optional summary|summary holds|summary argument/i.test(brief),
			false,
			"a recovery brief invites a summary its schema refuses",
		);
	assert.ok(
		pi.includes("a recovery submission carries no summary field"),
		"the recovery brief does not say its summary is fixed",
	);
}

/**
 * Criterion 12: generic dispatch is unchanged in its briefs, byte for byte.
 * The digests below were produced by the base commit's own composers
 * (de95797, this part's merge base) over exactly these inputs; the head's
 * composers must reproduce them.
 */
const BASE_GENERIC_BRIEFS: Readonly<Record<string, string>> = {
	reviewer: "167f983e4815df5159d6c9682129a48ae8d241d32dc232667834e004e74a0771",
	reviewerDefaultTiming: "3784794b0732d89709794b95c7cbf7e6281bb39f8a810a9eba541c69fb58deed",
	judge: "74e52b9498548ed545f156d6bfdade87b1f1920e0baddcc8cbba8574a22734ea",
	judgeReRequest: "545d3752817e17d1e8ce4e55536618e61c25c6c7bda4d13261b3318d21307db4",
	diagnosis: "b1335518c12cd04544809218aa5c928e473b701e368d6c2e814fef6e5f79cabe",
	challenger: "4be7936af25cf80285f3aeee821d61d3b4af6a71b2392130653f828663243294",
	contestSelector: "b43b7e943c36ed42695b66918457414086062134505956d618306d456de9e190",
	measurementSelector: "bd6056c883a7d4ea7a55f1430273115e9596e1a202bad934120df4ea7e5c1c6e",
	measurement: "61c07a2f08396a1306f370ef4f011387f7cd3181459eb997c47d95c966907264",
	freshDiagnosis: "b65ad179c574761d89cc418552a6035845039fea7ca9b5ce8860fabb8bba0ae5",
};

function armKeepsTheGenericBriefs(
	review: ReviewBriefs & { composeDiagnosisBrief: typeof composeDiagnosisBrief },
	recovery: RecoveryBriefs,
): void {
	const slot = { lens: "suite", surface: "the test suite" } as never;
	const context = { changeDescription: "a fixed change description" };
	const fences = {
		outOfScope: ["out"],
		forbiddenRemedies: ["forbidden"],
		deferralHomes: ["#1"],
		priorFindings: [{ label: "P1", text: "prior" }],
	};
	const timing = { firstReturnSeconds: 311, finalReturnSeconds: 1433 };
	const bundle = [{ rawOrdinal: 0, finding: "one finding", slot }] as never;
	const manifest = { state: "present", criteria: ["criterion one"] } as const;
	const diagnosis = { value: "STAGNATION", invalidation: "nothing", evidence: "evidence" } as never;
	const basis = { states: [{ head: "b".repeat(40), findings: [] }], intervals: [] } as never;
	const spec = {
		kind: "measurement",
		question: "q",
		method: "m",
		expectedDiscriminator: "d",
		evidence: "e",
		nonMutating: true,
		notPreviouslyPresent: true,
	} as never;
	const result = { kind: "measurement-result", specDigest: "0".repeat(64), result: "r", evidence: "e" } as never;
	const head: Record<string, string> = {
		reviewer: review.composeReviewerBrief(slot, context, fences, timing),
		reviewerDefaultTiming: review.composeReviewerBrief(slot, context, fences),
		judge: review.composeJudgeBrief(bundle, manifest, context, fences, timing),
		judgeReRequest: review.composeJudgeBrief(bundle, manifest, context, fences, timing, { gaps: ["0"] }),
		diagnosis: review.composeDiagnosisBrief(basis, { ...context, withheldHead: "c".repeat(40), timing }),
		challenger: recovery.challengerBrief("root", diagnosis, basis),
		contestSelector: recovery.contestSelectorBrief([
			{ slot: "root", outcome: "ALTERNATIVE", method: "m", evidence: "e" },
		] as never),
		measurementSelector: recovery.measurementSelectorBrief(diagnosis, basis),
		measurement: recovery.measurementBrief(spec),
		freshDiagnosis: recovery.freshDiagnosisBrief(diagnosis, basis, spec, result),
	};
	const digest = (text: string) => createHash("sha256").update(text).digest("hex");
	assert.deepEqual(
		Object.fromEntries(Object.entries(head).map(([name, text]) => [name, digest(text)])),
		BASE_GENERIC_BRIEFS,
		"a generic brief differs from the base commit's bytes",
	);
}

/** Criterion 1: the spec's Pi selection is closed, each refusal by its own check. */
function armClosesTheSpec(parse: typeof parseReviewRoundSpec): void {
	const spec = {
		pr: 370,
		changeDescription: "Pi mode",
		fences: { outOfScope: [], forbiddenRemedies: [], deferralHomes: [], priorFindings: [] },
		pi: { piExecutable: "/usr/local/bin/pi", provider: "scripted", model: "scripted-model" },
	};
	const parsed = parse(spec);
	assert.deepEqual(parsed?.pi, spec.pi, "the valid selection must parse, or every refusal below is vacuous");
	assert.equal(parsed?.delegateArgv, undefined);
	for (const [name, value] of [
		["beside delegateArgv", { ...spec, delegateArgv: ["pi"] }],
		["an unknown key", { ...spec, pi: { ...spec.pi, role: "judge" } }],
		["a null selection", { ...spec, pi: null }],
		["an empty executable", { ...spec, pi: { ...spec.pi, piExecutable: "" } }],
		["a numeric executable", { ...spec, pi: { ...spec.pi, piExecutable: 5 } }],
		["a numeric provider", { ...spec, pi: { ...spec.pi, provider: 123 } }],
		["a numeric model", { ...spec, pi: { ...spec.pi, model: 7 } }],
		["a provider outside the charset", { ...spec, pi: { ...spec.pi, provider: "--mode" } }],
		["a model outside the charset", { ...spec, pi: { ...spec.pi, model: "--mode" } }],
		["a missing model", { ...spec, pi: { piExecutable: "/usr/local/bin/pi", provider: "scripted" } }],
	] as const)
		assert.equal(parse(value), undefined, `${name} was admitted`);
}

/** Criterion 1: the model-facing tool exposes no Pi field at this head. */
async function armHidesPiFromTheModel(
	register: (pi: never, repoRoot: string, stateRoot: string) => void,
): Promise<void> {
	const definition: {
		name?: string;
		parameters?: { properties?: Record<string, unknown>; additionalProperties?: unknown };
	} = {};
	register({ registerTool: (tool: typeof definition) => Object.assign(definition, tool) } as never, "/r", "/s");
	assert.equal(definition.name, "gitjig_dispatch");
	assert.deepEqual(
		Object.keys(definition.parameters?.properties ?? {}).sort(),
		["brief", "delegateArgv", "expectedRef", "timeoutMs"],
		"the model-facing tool's parameters changed",
	);
	assert.equal(definition.parameters?.additionalProperties, false, "the model-facing tool admits undeclared fields");
}

/*
 * The production call sites. The arms above measure the pieces; these measure
 * the places that choose, because a role or a projection applied correctly in
 * a helper and wrongly at its call site is a wrong run with the right parts.
 */

/** The orchestrator fixes `reviewer` and `judge` at its own call sites. */
async function armPinsProductionRoles(round: typeof reviewRound): Promise<void> {
	// A two-commit repository of the arm's own, so the round's change surface
	// is fixed here rather than read from whatever this checkout's last commit
	// touched (or from history a shallow clone does not have).
	await withFixtureRepository((fixture) => pinProductionRoles(round, fixture));
}

/** A two-commit repository whose one change is a test file, so the round derives the suite slot. */
async function withFixtureRepository<T>(
	scenario: (fixture: string) => Promise<T>,
	changed: readonly string[] = ["test/round.unit.test.ts"],
): Promise<T> {
	const fixture = mkdtempSync(join(tmpdir(), "gitjig-422-round-"));
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
			cwd: fixture,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		}).trim();
	try {
		git("init", "-q");
		writeFileSync(join(fixture, "README.md"), "base\n");
		git("add", "README.md");
		git("commit", "-q", "-m", "base");
		for (const file of changed) {
			mkdirSync(dirname(join(fixture, file)), { recursive: true });
			writeFileSync(join(fixture, file), "// the change under review\n");
			git("add", file);
		}
		git("commit", "-q", "-m", "change");
		return await scenario(fixture);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
}

/**
 * §1.7 at each review consumer: only the retry's own independently valid
 * return satisfies it. The real round runs over the real dispatcher, whose run
 * is scripted per role: the consumer under test misses its first return, and
 * its retry then returns nothing again or returns malformed. Either way that
 * consumer is left without a result and nothing sends a third time. A valid
 * retry is the control, so the arm is not vacuous.
 */
async function armEachReviewConsumerNeedsItsOwnReturn({
	reviewRound: round,
	makeDispatcher: make,
}: {
	reviewRound: typeof reviewRound;
	makeDispatcher: typeof makeDispatcher;
}): Promise<void> {
	const FINDINGS = JSON.stringify({ token: "FINDINGS", findings: ["one finding"] });
	const APPROVED = JSON.stringify({ token: "APPROVED", findings: [] });
	const payload = (text: string): DispatchOutcome =>
		({
			disposition: "admitted",
			ok: true,
			summary: "a summary",
			payload: text,
			compare: "confirmed",
			diagnostic: {
				status: "admitted",
				phase: "complete",
				run: { class: "exited", exitCode: 0, signal: null },
				return: { class: "admitted" },
				compare: { class: "confirmed" },
				durationMs: 1,
				code: "ADMITTED",
			},
		}) as unknown as DispatchOutcome;
	const seconds: ReadonlyArray<readonly [string, DispatchOutcome]> = [
		["absent", refused("RETURN_MISSING")],
		["malformed", payload("{ not json")],
	];
	await withFixtureRepository(async (fixture) => {
		const drive = async (script: Record<string, DispatchOutcome[]>) => {
			const sends: Record<string, number> = {};
			const result = await round({
				repoRoot: fixture,
				baseRef: "HEAD~1",
				headRef: "HEAD",
				manifest: { state: "present", criteria: ["the change does what it says"] },
				fences: { outOfScope: [], forbiddenRemedies: [], deferralHomes: [], priorFindings: [] },
				changeDescription: "a change",
				transport: "pi",
				dispatch: make(
					{ callerRepoRoot: "/r", stateRoot: "/s", delegateArgv: [], pi: PI, timeoutMs: 10 } as unknown as Omit<
						RunDispatchOptions,
						"brief" | "expectedRef"
					>,
					async (given: RunDispatchOptions) => {
						const role = String(given.pi?.role);
						const count = sends[role] ?? 0;
						sends[role] = count + 1;
						return script[role]?.[count] ?? admitted();
					},
				),
			} as never);
			return { result, sends };
		};
		for (const [name, second] of seconds) {
			// The reviewer slot: its missing and then unusable return leaves it invalid.
			const slot = await drive({ reviewer: [refused("RETURN_MISSING"), second] });
			assert.equal(slot.sends.reviewer, 2, `reviewer, ${name}: the slot's sends`);
			assert.deepEqual(
				slot.result.record.slots.map((entry) => entry.valid),
				[false],
				`reviewer, ${name}: a slot without its own valid return was counted`,
			);
			assert.notEqual(slot.result.review.state, "approved", `reviewer, ${name}: the round approved`);
			// The Judge: a complete panel, then a Judge whose retry is unusable.
			const judge = await drive({
				reviewer: [payload(FINDINGS)],
				judge: [refused("RETURN_MISSING"), second],
			});
			assert.equal(judge.sends.judge, 2, `judge, ${name}: the Judge's sends`);
			assert.deepEqual(
				judge.result.review,
				{ state: "incomplete", cause: "adjudication-missing" },
				`judge, ${name}: a Judge without its own valid return adjudicated`,
			);
		}
		// The control: the slot's own valid retry does satisfy it.
		const control = await drive({ reviewer: [refused("RETURN_MISSING"), payload(APPROVED)] });
		assert.equal(control.sends.reviewer, 2);
		assert.deepEqual(
			control.result.record.slots.map((entry) => entry.valid),
			[true],
			"the slot's own valid retry was not admitted",
		);
	});
	// Two calls in one round, each with its own retry state: both slots miss
	// their first return and each retries once. A shared state would leave the
	// second slot without its retry; a replenished one would send a third time.
	await withFixtureRepository(
		async (fixture) => {
			const sends: Record<string, number> = {};
			const lens = (brief: string) => (/the test suite/.test(brief) ? "suite" : "runtime");
			const result = await round({
				repoRoot: fixture,
				baseRef: "HEAD~1",
				headRef: "HEAD",
				manifest: { state: "absent" },
				fences: { outOfScope: [], forbiddenRemedies: [], deferralHomes: [], priorFindings: [] },
				changeDescription: "a change",
				transport: "pi",
				dispatch: make(
					{ callerRepoRoot: "/r", stateRoot: "/s", delegateArgv: [], pi: PI, timeoutMs: 10 } as unknown as Omit<
						RunDispatchOptions,
						"brief" | "expectedRef"
					>,
					async (given: RunDispatchOptions) => {
						const key = lens(given.brief);
						sends[key] = (sends[key] ?? 0) + 1;
						return sends[key] === 1 ? refused("RETURN_MISSING") : payload(APPROVED);
					},
				),
			} as never);
			assert.equal(result.record.slots.length, 2, "the fixture did not derive two slots");
			assert.deepEqual(sends, { suite: 2, runtime: 2 }, "the two calls did not each retry once");
			assert.deepEqual(
				result.record.slots.map((entry) => entry.valid),
				[true, true],
			);
		},
		["test/round.unit.test.ts", ".pi/extensions/gitjig/probe.ts"],
	);
}

async function pinProductionRoles(round: typeof reviewRound, fixture: string): Promise<void> {
	const calls: { brief: string; role?: string }[] = [];
	const result = await round({
		repoRoot: fixture,
		baseRef: "HEAD~1",
		headRef: "HEAD",
		manifest: { state: "present", criteria: ["the change does what it says"] },
		fences: { outOfScope: [], forbiddenRemedies: [], deferralHomes: [], priorFindings: [] },
		changeDescription: "a change",
		transport: "pi",
		dispatch: async (brief: string, _head: string, role?: string) => {
			calls.push({ brief, role });
			// Each slot returns findings so the Judge is reached; the Judge's own
			// return is malformed, which ends the round without a verdict.
			return {
				disposition: "admitted",
				ok: true,
				summary: "a slot summary",
				payload: '{"token":"FINDINGS","findings":["one"]}',
				compare: "confirmed",
				diagnostic: {
					status: "admitted",
					phase: "complete",
					run: { class: "exited", exitCode: 0, signal: null },
					return: { class: "admitted" },
					compare: { class: "confirmed" },
					durationMs: 1,
					code: "ADMITTED",
				},
			} as never;
		},
	} as never);
	assert.ok(result, "the round returned nothing");
	assert.ok(calls.length >= 2, `the round made ${calls.length} dispatches`);
	// Every slot dispatch is a reviewer, and the Judge dispatch is a judge.
	const roles = calls.map((call) => call.role);
	assert.ok(roles.includes("reviewer"), `no reviewer role was fixed: ${JSON.stringify(roles)}`);
	assert.ok(roles.includes("judge"), `no judge role was fixed: ${JSON.stringify(roles)}`);
	assert.equal(roles.includes(undefined), false, "a consumer left its role unset");
	// And the brief each one carried is its transport's, at the call site.
	for (const call of calls) {
		assert.match(call.brief, /submit_result/, `${call.role}: a generic brief on a Pi path`);
		assertOnlyForbidsTheFile(call.brief, REVIEW_PROHIBITION, String(call.role));
	}
	// The reviewer's brief is the reviewer's and the Judge's is the Judge's:
	// a call site that passed the wrong one would still be "a Pi brief".
	const reviewer = calls.find((call) => call.role === "reviewer");
	const judge = calls.find((call) => call.role === "judge");
	assert.match(String(reviewer?.brief), /reviewer/i);
	assert.match(String(judge?.brief), /adjudicat|Judge/i);
}

/** The history diagnosis brief follows its caller's transport, in all three places. */
function armSelectsTheDiagnosisTransport(compose: typeof composeDiagnosisBrief): void {
	const basis = { states: [], intervals: [] };
	const context = {
		changeDescription: "a change",
		withheldHead: PIN,
		timing: { firstReturnSeconds: 311, finalReturnSeconds: 1433 },
	};
	const generic = compose(basis as never, { ...context, transport: "generic" });
	const pi = compose(basis as never, { ...context, transport: "pi" });
	// Each of the three transport decisions shows in the composed text.
	assert.match(pi, /Submit the following closed object as typed submit_result tool arguments/);
	assert.match(pi, /PI RESULT: use only the trusted submit_result tool/);
	assert.match(pi, /call submit_result once with/);
	assertOnlyForbidsTheFile(pi, REVIEW_PROHIBITION, "diagnosis");
	assert.ok(pi.includes("final typed result by T0+1433 seconds."), "the diagnosis deadline is not the caller's");
	for (const [name, pattern] of [
		["payload-slot instruction", /rides the return's "payload" slot/],
		["generic return contract", /write a complete provisional/],
	] as ReadonlyArray<readonly [string, RegExp]>)
		assert.equal(pattern.test(pi), false, `the Pi diagnosis brief kept the ${name}`);
	assert.match(generic, /\.\.\/return\.json/);
	assert.equal(/submit_result/.test(generic), false, "the generic diagnosis brief names the tool");
}

/** The production recovery dispatcher projects the brief it sends under Pi. */
async function armProjectsInProductionRecovery(edits: ReadonlyArray<readonly [string, string, string]>): Promise<void> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-422-recovery-"));
	try {
		const root = join(scratch, "gitjig");
		cpSync(join(repoRoot, ".pi/extensions/gitjig"), root, { recursive: true });
		symlinkSync(join(repoRoot, "node_modules"), join(scratch, "node_modules"), "dir");
		// The seam: what the coordinator's own dispatcher hands the dispatcher
		// below it. An outcome cannot show which brief was sent.
		const tracePath = join(scratch, "sent.jsonl");
		writeFileSync(
			join(root, "dispatch/run-trace.ts"),
			`import { appendFileSync } from "node:fs";\nimport { runDispatch as real } from "./index.ts";\nexport const runDispatch: typeof real = (options) => {\n\tappendFileSync(${JSON.stringify(tracePath)}, \`\${JSON.stringify({ brief: options.brief, pi: options.pi ?? null, delegateArgv: options.delegateArgv })}\\n\`);\n\treturn Promise.resolve({ disposition: "refused", cause: "fixture", diagnostic: { status: "refused", phase: "return", run: { class: "exited", exitCode: 1, signal: null }, return: { class: "missing" }, compare: { class: "not-reached" }, durationMs: 1, code: "RETURN_MISSING" } } as never);\n};\n`,
		);
		const coordinator = join(root, "recovery/coordinator.ts");
		const source = readFileSync(coordinator, "utf8");
		const anchor = 'import { runDispatch } from "../dispatch/index.ts";';
		if (source.indexOf(anchor) === -1) throw new Error("the coordinator's dispatch import moved");
		writeFileSync(coordinator, source.replace(anchor, 'import { runDispatch } from "../dispatch/run-trace.ts";'));
		for (const [relative, from, to] of edits) {
			const path = join(root, relative);
			const current = readFileSync(path, "utf8");
			if (current.indexOf(from) === -1) throw new Error(`anchor must exist in ${relative}: ${from}`);
			if (current.indexOf(from) !== current.lastIndexOf(from)) throw new Error(`anchor must be unique: ${from}`);
			writeFileSync(
				path,
				current.replace(from, () => to),
			);
		}
		const { makeRecoveryProfileDispatcher } = await import(pathToFileURL(coordinator).href);
		const { createRecoveryAttemptLedger } = await import(pathToFileURL(join(root, ORCHESTRATE)).href);
		type Sent = {
			brief: string;
			delegateArgv: string[];
			pi: { role?: string; piExecutable?: string; provider?: string; model?: string } | null;
		};
		const sent = async (
			pi: { piExecutable: string; provider: string; model: string } | undefined,
			role: RecoveryPiRole | undefined,
		): Promise<Sent[]> => {
			const before = existsSync(tracePath) ? readFileSync(tracePath, "utf8").split("\n").filter(Boolean).length : 0;
			const dispatcher = makeRecoveryProfileDispatcher({
				repoRoot,
				stateRoot: join(scratch, "state"),
				...(pi === undefined ? {} : { pi }),
			});
			assert.equal(dispatcher.transport, pi === undefined ? "generic" : "pi", "the dispatcher's declared transport");
			await dispatcher(
				createRecoveryAttemptLedger(performance.now()),
				"stagnation-root",
				challengerBrief(
					"root",
					{ value: "STAGNATION", invalidation: "nothing", evidence: "e" } as never,
					{
						states: [],
						intervals: [],
					} as never,
				),
				PIN,
				performance.now() + 60_000,
				role,
			).catch(() => undefined);
			// Only this call's sends: a call that never reached the seam must not
			// be read through an earlier call's line.
			const lines = readFileSync(tracePath, "utf8").split("\n").filter(Boolean).slice(before);
			assert.ok(lines.length >= 1, `${role ?? "generic"}: nothing reached the dispatcher`);
			return lines.map((line) => JSON.parse(line) as Sent);
		};
		// Every recovery role reaches the dispatcher below as itself: the role is
		// the consumer's, read where it is handed on, not where it was chosen.
		for (const role of RECOVERY_PI_ROLES)
			for (const underPi of await sent(PI, role)) {
				assert.match(underPi.brief, /submit_result/, `${role}: an unprojected brief was sent`);
				assertOnlyForbidsTheFile(underPi.brief, RECOVERY_PROHIBITION, `production recovery ${role}`);
				assert.equal(underPi.pi?.role, role, `${role}: the role handed on`);
				// The Pi route carries no generic argv: the profile's command is not its child.
				assert.deepEqual(underPi.delegateArgv, [], `${role}: a generic argv rode a Pi dispatch`);
				assert.deepEqual(
					[underPi.pi?.piExecutable, underPi.pi?.provider, underPi.pi?.model],
					[PI.piExecutable, PI.provider, PI.model],
					`${role}: the selection handed on`,
				);
			}
		for (const underGeneric of await sent(undefined, undefined)) {
			assert.equal(/submit_result/.test(underGeneric.brief), false, "the generic recovery dispatch was projected");
			assert.equal(underGeneric.pi, null);
			assert.ok(underGeneric.delegateArgv.length > 0, "the generic route lost its profile argv");
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/*
 * The harness: a private copy of the extension tree, so a mutant of the module
 * under test can be handed to the arm that owns the property. Each module is
 * loaded from the edited copy.
 */
async function withPrivateCopy<T>(
	edits: ReadonlyArray<readonly [string, string, string]>,
	// biome-ignore lint/suspicious/noExplicitAny: a module loaded from a private copy has no static type
	scenario: (load: (relative: string) => Promise<any>) => Promise<T>,
): Promise<T> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-422-"));
	try {
		const root = join(scratch, "gitjig");
		cpSync(join(repoRoot, ".pi/extensions/gitjig"), root, { recursive: true });
		symlinkSync(join(repoRoot, "node_modules"), join(scratch, "node_modules"), "dir");
		for (const [relative, anchor, replacement] of edits) {
			const path = join(root, relative);
			const source = readFileSync(path, "utf8");
			// A plain Error, not an assertion: a stale anchor is a harness fault
			// and must never read as a kill the arm did not make.
			if (source.indexOf(anchor) === -1) throw new Error(`anchor must exist in ${relative}: ${anchor}`);
			if (source.indexOf(anchor) !== source.lastIndexOf(anchor))
				throw new Error(`anchor must be unique in ${relative}: ${anchor}`);
			writeFileSync(
				path,
				source.replace(anchor, () => replacement),
			);
		}
		return await scenario((relative) => import(pathToFileURL(join(root, relative)).href));
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

async function armFails(
	arm: Arm,
	edits: ReadonlyArray<readonly [string, string, string]>,
	named: string,
): Promise<void> {
	await copyFails((load) => load(ORCHESTRATE).then((module) => arm(module.makeDispatcher)), edits, named);
}

/** The same requirement for an arm over any module of the copy. */
async function copyFails(
	// biome-ignore lint/suspicious/noExplicitAny: see withPrivateCopy
	arm: (load: (relative: string) => Promise<any>) => Promise<unknown> | unknown,
	edits: ReadonlyArray<readonly [string, string, string]>,
	named: string,
): Promise<void> {
	await assert.rejects(
		() => withPrivateCopy(edits, async (load) => arm(load)),
		(error: unknown) => {
			assert.ok(error instanceof assert.AssertionError, `${named}: the arm failed for another reason: ${error}`);
			return true;
		},
		`${named}: the owner arm still passed`,
	);
}

test("the shared retry repeats the same call, with only its transport's suffix", async () => {
	await armRepeatsTheSameCall(makeDispatcher);
});

test("the retry under the attempt policy repeats every option but its own measurement origin", async () => {
	await armRepeatsUnderTheAttemptPolicy({ makeDispatcher, createRecoveryAttemptLedger });
});

test("exactly one of the dispatcher's diagnostic codes draws a second send", async () => {
	await armEnumeratesTheTrigger(makeDispatcher);
});

test("the retry event stands one-to-one with the send it announces", async () => {
	await armAnnouncesEachRetryOnce(makeDispatcher);
});

test("only the retry's own return satisfies its consumer", async () => {
	await armRequiresTheRetrysOwnReturn(makeDispatcher);
});

test("each consumer's brief is its transport's own, in what it says and what it withholds", () => {
	armSelectsTheTransportsBrief({ composeReviewerBrief, composeJudgeBrief });
	armProjectsTheRecoveryBrief({
		challengerBrief,
		contestSelectorBrief,
		measurementSelectorBrief,
		measurementBrief,
		freshDiagnosisBrief,
		piRecoveryBrief,
	});
});

test("each review consumer is satisfied only by its retry's own valid return", async () => {
	await armEachReviewConsumerNeedsItsOwnReturn({ reviewRound, makeDispatcher });
});

test("the production call sites fix their own roles and briefs", async () => {
	await armPinsProductionRoles(reviewRound);
	armSelectsTheDiagnosisTransport(composeDiagnosisBrief);
	await armProjectsInProductionRecovery([]);
});

test("baseline-first private-copy mutants: the shared retry's own commitments", async () => {
	await armFails(
		armRepeatsTheSameCall,
		[
			[
				ORCHESTRATE,
				"selectedPi === undefined ? RETURN_PROTOCOL_RETRY_SUFFIX : PI_RETURN_PROTOCOL_RETRY_SUFFIX",
				"RETURN_PROTOCOL_RETRY_SUFFIX",
			],
		],
		"the generic suffix sent on a Pi path",
	);
	await armFails(
		armRepeatsTheSameCall,
		[[ORCHESTRATE, "let outcome = await send(brief);", "let outcome = await send(`${brief} `);"]],
		"a brief altered before the first send",
	);
	// The trigger's conjuncts are AND-ed, so RELAXING one alone admits nothing
	// while the others hold — each is measured by moving it to another class,
	// which is what makes the arm see the trigger rather than its shape.
	await armFails(
		armEnumeratesTheTrigger,
		[[ORCHESTRATE, 'outcome.diagnostic.run.class === "exited"', 'outcome.diagnostic.run.class === "signaled"']],
		"the trigger moved to a signal-terminated run",
	);
	await armFails(
		armEnumeratesTheTrigger,
		[[ORCHESTRATE, 'outcome.diagnostic.return.class === "missing"', 'outcome.diagnostic.return.class === "regular"']],
		"the trigger moved to a non-missing return refusal",
	);
	await armFails(
		armEnumeratesTheTrigger,
		[[ORCHESTRATE, "Number.isInteger(outcome.diagnostic.run.exitCode)", "outcome.diagnostic.run.exitCode !== 0"]],
		"a retry withheld from a zero exit",
	);
	await armFails(
		armAnnouncesEachRetryOnce,
		[
			[
				ORCHESTRATE,
				'onEvent?.("retry-return-protocol");',
				'onEvent?.("retry-return-protocol");\n\t\t\t\tonEvent?.("retry-return-protocol");',
			],
		],
		"an event fired twice for one send",
	);
	await armFails(
		armRequiresTheRetrysOwnReturn,
		[[ORCHESTRATE, "retryAvailable = false;", "retryAvailable = true;"]],
		"a retry state that never spends",
	);
});

test("baseline-first private-copy mutants: each production call site's own choice", async () => {
	const roles = (load: (relative: string) => Promise<{ reviewRound: typeof reviewRound }>) =>
		load(ORCHESTRATE).then((module) => armPinsProductionRoles(module.reviewRound));
	const diagnosis = (load: (relative: string) => Promise<{ composeDiagnosisBrief: typeof composeDiagnosisBrief }>) =>
		load("review/history.ts").then((module) => armSelectsTheDiagnosisTransport(module.composeDiagnosisBrief));
	// Baseline first: the unedited copy passes every arm the mutants run.
	await withPrivateCopy([], roles);
	await withPrivateCopy([], diagnosis);
	await armProjectsInProductionRecovery([]);
	await copyFails(
		roles,
		[[ORCHESTRATE, 'options.dispatch(brief, head, "reviewer")', 'options.dispatch(brief, head, "judge")']],
		"the reviewer call site dispatched as a judge",
	);
	await copyFails(
		roles,
		[[ORCHESTRATE, 'options.dispatch(judgeBrief, head, "judge")', 'options.dispatch(judgeBrief, head, "reviewer")']],
		"the Judge call site dispatched as a reviewer",
	);
	await copyFails(
		roles,
		[
			[
				ORCHESTRATE,
				"\t\t\t\toptions.timing,\n\t\t\t\toptions.transport,\n\t\t\t);\n\t\t\tconst outcome = await options.dispatch(brief",
				'\t\t\t\toptions.timing,\n\t\t\t\t"generic",\n\t\t\t);\n\t\t\tconst outcome = await options.dispatch(brief',
			],
		],
		"the reviewer brief composed generically on a Pi round",
	);
	await copyFails(
		diagnosis,
		[
			[
				"review/history.ts",
				'context.transport === "pi"\n\t\t\t? "Submit the following',
				'false\n\t\t\t? "Submit the following',
			],
		],
		"the diagnosis payload instruction left generic",
	);
	await copyFails(
		diagnosis,
		[["review/history.ts", 'context.transport === "pi" ? PI_RETURN_CONTRACT', "false ? PI_RETURN_CONTRACT"]],
		"the diagnosis return contract left generic",
	);
	await copyFails(
		diagnosis,
		[
			[
				"review/history.ts",
				'context.transport === "pi"\n\t\t\t? composePiDeadlines',
				"false\n\t\t\t? composePiDeadlines",
			],
		],
		"the diagnosis deadlines left generic",
	);
	await assert.rejects(
		() =>
			armProjectsInProductionRecovery([
				[
					"recovery/coordinator.ts",
					"input.pi === undefined ? semanticBrief : piRecoveryBrief(semanticBrief)",
					"semanticBrief",
				],
			]),
		(error: unknown) => {
			assert.ok(
				error instanceof assert.AssertionError,
				`the unprojected recovery dispatch: the arm failed for another reason: ${error}`,
			);
			return true;
		},
		"the unprojected recovery dispatch: the owner arm still passed",
	);
});

test("baseline-first private-copy mutants: a Pi brief forbids the file and nothing else", async () => {
	const BRIEFS = "review/briefs.ts";
	const RECOVERY = "recovery/briefs.ts";
	const review = (load: (relative: string) => Promise<ReviewBriefs>) =>
		load(BRIEFS).then((module) => armSelectsTheTransportsBrief(module));
	const recovery = (load: (relative: string) => Promise<RecoveryBriefs>) =>
		load(RECOVERY).then((module) => armProjectsTheRecoveryBrief(module));
	await withPrivateCopy([], review);
	await withPrivateCopy([], recovery);
	await copyFails(
		review,
		[[BRIEFS, '"../return.json directly, choose a role,', '"elsewhere. Write ../return.json directly, choose a role,']],
		"the prohibition turned into an instruction",
	);
	await copyFails(
		review,
		[
			[
				BRIEFS,
				'"before the deadline. Once the tool accepts',
				'"Also write ../return.json before the deadline. Once the tool accepts',
			],
		],
		"an affirmative write added beside the prohibition",
	);
	await copyFails(
		recovery,
		[[RECOVERY, "never write ../return.json directly.", "write ../return.json directly."]],
		"the recovery prohibition turned into an instruction",
	);
});

test("baseline-first private-copy mutant: the recovery role handed on is the consumer's", async () => {
	// The per-call role is the one makeDispatcher hands on; the role spread into
	// the factory's options is overridden by it, so that statement alone is
	// equivalent by construction and the mutant targets the load-bearing one.
	await armProjectsInProductionRecovery([]);
	await assert.rejects(
		() =>
			armProjectsInProductionRecovery([
				[
					"recovery/coordinator.ts",
					"piRecoveryBrief(semanticBrief), expectedHead, role);",
					'piRecoveryBrief(semanticBrief), expectedHead, role === undefined ? undefined : "challenger");',
				],
			]),
		(error: unknown) => {
			assert.ok(
				error instanceof assert.AssertionError,
				`a constant recovery role: the arm failed for another reason: ${error}`,
			);
			return true;
		},
		"a constant recovery role: the owner arm still passed",
	);
});

test("baseline-first private-copy mutants: the trigger's code and the caller's deadline", async () => {
	const BRIEFS = "review/briefs.ts";
	const HISTORY = "review/history.ts";
	const review = (load: (relative: string) => Promise<ReviewBriefs>) =>
		load(BRIEFS).then((module) => armSelectsTheTransportsBrief(module));
	const diagnosis = (load: (relative: string) => Promise<{ composeDiagnosisBrief: typeof composeDiagnosisBrief }>) =>
		load(HISTORY).then((module) => armSelectsTheDiagnosisTransport(module.composeDiagnosisBrief));
	await withPrivateCopy([], (load) =>
		load(ORCHESTRATE).then((module) => armEnumeratesTheTrigger(module.makeDispatcher)),
	);
	await withPrivateCopy([], review);
	await withPrivateCopy([], diagnosis);
	await armFails(
		armEnumeratesTheTrigger,
		[[ORCHESTRATE, '\t\t\toutcome.diagnostic.code === "RETURN_MISSING" &&\n', ""]],
		"the trigger read from the lifecycle alone",
	);
	await copyFails(
		review,
		[
			[
				BRIEFS,
				'\t\tString(timing.finalReturnSeconds) +\n\t\t" seconds. An absent or late submission',
				'\t\t"1400" +\n\t\t" seconds. An absent or late submission',
			],
		],
		"the Pi deadline fixed by the composer",
	);
	await copyFails(
		diagnosis,
		[[HISTORY, "? composePiDeadlines(context.timing ?? DEFAULT_TIMING)", "? composePiDeadlines(DEFAULT_TIMING)"]],
		"the diagnosis deadline ignoring the caller's timing",
	);
});

test("baseline-first private-copy mutants: the attempt-policy retry's options", async () => {
	const policy = (load: (relative: string) => Promise<OrchestratorModule>) =>
		load(ORCHESTRATE).then((module) => armRepeatsUnderTheAttemptPolicy(module));
	await withPrivateCopy([], policy);
	await copyFails(
		policy,
		[
			[
				ORCHESTRATE,
				"\t\t\t\tbrief: semanticBrief,\n",
				"\t\t\t\tbrief: semanticBrief,\n\t\t\t\t...(attempt === 2 ? { timeoutMs: 1 } : {}),\n",
			],
		],
		"the retry sent with a changed bound",
	);
	await copyFails(
		policy,
		[
			[
				ORCHESTRATE,
				"...(policy === undefined ? {} : { enteredAt: performance.now() }),",
				"...(policy === undefined ? {} : { enteredAt: (stamp ??= performance.now()) }),",
			],
			[
				ORCHESTRATE,
				"\t\tlet retryAvailable = true;\n",
				"\t\tlet retryAvailable = true;\n\t\tlet stamp: number | undefined;\n",
			],
		],
		"the retry measured from the first send",
	);
});

test("baseline-first private-copy mutants: each review consumer's own return", async () => {
	const consumers = (
		load: (relative: string) => Promise<{ reviewRound: typeof reviewRound; makeDispatcher: typeof makeDispatcher }>,
	) => load(ORCHESTRATE).then((module) => armEachReviewConsumerNeedsItsOwnReturn(module));
	await withPrivateCopy([], consumers);
	await copyFails(
		consumers,
		[[ORCHESTRATE, "\t\t\toutcome = await send(\n", "\t\t\tawait send(\n"]],
		"the consumer handed the first send's outcome instead of the retry's",
	);
	await copyFails(
		consumers,
		[[ORCHESTRATE, "\t\tlet retryAvailable = true;\n", "\t\tlet retryAvailable = false;\n"]],
		"no retry at any consumer",
	);
});

test("baseline-first private-copy mutant: a recovery brief offers only what its schema accepts", async () => {
	const recovery = (load: (relative: string) => Promise<RecoveryBriefs>) =>
		load("recovery/briefs.ts").then((module) => armProjectsTheRecoveryBrief(module));
	await withPrivateCopy([], recovery);
	await copyFails(
		recovery,
		[
			[
				"recovery/briefs.ts",
				"summary, fixed fields and payload encoding; a recovery submission carries no summary field.",
				"default summary, fixed fields and payload encoding. Optional summary holds bounded final text.",
			],
		],
		"the recovery brief inviting a summary its schema refuses",
	);
});

test("generic briefs keep the base commit's bytes; the tool and the spec stay closed", async () => {
	armKeepsTheGenericBriefs(
		{ composeReviewerBrief, composeJudgeBrief, composeDiagnosisBrief },
		{
			challengerBrief,
			contestSelectorBrief,
			measurementSelectorBrief,
			measurementBrief,
			freshDiagnosisBrief,
			piRecoveryBrief,
		},
	);
	await armHidesPiFromTheModel(registerDispatchTool as never);
	armClosesTheSpec(parseReviewRoundSpec);
});

test("baseline-first private-copy mutants: generic bytes, the tool, the spec and the role-less refusals", async () => {
	// biome-ignore lint/suspicious/noExplicitAny: modules loaded from a private copy have no static type
	const generic = async (load: (relative: string) => Promise<any>) =>
		armKeepsTheGenericBriefs(
			{ ...(await load("review/briefs.ts")), ...(await load("review/history.ts")) },
			await load("recovery/briefs.ts"),
		);
	const tool = (load: (relative: string) => Promise<{ registerDispatchTool: never }>) =>
		load("dispatch/index.ts").then((module) => armHidesPiFromTheModel(module.registerDispatchTool));
	const closed = (load: (relative: string) => Promise<{ parseReviewRoundSpec: typeof parseReviewRoundSpec }>) =>
		load("commands/review-round.ts").then((module) => armClosesTheSpec(module.parseReviewRoundSpec));
	await withPrivateCopy([], generic);
	await withPrivateCopy([], tool);
	await withPrivateCopy([], closed);
	await copyFails(
		generic,
		[
			[
				"review/briefs.ts",
				'"PARENT directory\'s return.json. The schema is CLOSED:",',
				'"PARENT directory\'s return.json. The schema is closed:",',
			],
		],
		"a generic brief's bytes changed",
	);
	await copyFails(
		tool,
		[
			[
				"dispatch/index.ts",
				'\t\ttimeoutMs: {\n\t\t\ttype: "number",',
				'\t\tpi: { type: "object" },\n\t\ttimeoutMs: {\n\t\t\ttype: "number",',
			],
		],
		"a Pi field on the model-facing tool",
	);
	for (const [named, from] of [
		["the argv exclusion", "\t\t\tvalue.delegateArgv !== undefined ||\n"],
		["the closed key set", '\t\t\t!exactObject(value.pi, ["piExecutable", "provider", "model"]) ||\n'],
		["the executable's type", '\t\t\ttypeof value.pi.piExecutable !== "string" ||\n'],
		["the empty executable", "\t\t\tvalue.pi.piExecutable.length === 0 ||\n"],
		["the provider's type", '\t\t\ttypeof value.pi.provider !== "string" ||\n'],
		["the model's type", '\t\t\ttypeof value.pi.model !== "string" ||\n'],
		["the provider charset", "\t\t\t!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.pi.provider) ||\n"],
	] as const)
		await copyFails(closed, [["commands/review-round.ts", from, ""]], `the spec without ${named}`);
	await copyFails(
		closed,
		[["commands/review-round.ts", " ||\n\t\t\t!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.pi.model)\n", "\n"]],
		"the spec without the model charset",
	);
	// The transport a dispatcher declares, and the role a Pi call cannot lack.
	await assert.rejects(
		() =>
			armProjectsInProductionRecovery([
				[
					"recovery/coordinator.ts",
					'transport: input.pi === undefined ? ("generic" as const) : ("pi" as const)',
					'transport: "generic" as const',
				],
			]),
		(error: unknown) => error instanceof assert.AssertionError,
		"a Pi dispatcher declaring itself generic: the owner arm still passed",
	);
	const roleless = async (load: (relative: string) => Promise<{ makeDispatcher: typeof makeDispatcher }>) => {
		const { makeDispatcher: make } = await load(ORCHESTRATE);
		const dispatch = make(
			{ callerRepoRoot: "/r", stateRoot: "/s", delegateArgv: [], pi: PI } as unknown as Omit<
				RunDispatchOptions,
				"brief" | "expectedRef"
			>,
			async () => admitted(),
		);
		let thrown: unknown;
		await dispatch("brief", PIN).catch((error: unknown) => {
			thrown = error;
		});
		assert.match(String(thrown), /Pi role unavailable from consumer/, "a Pi call without its consumer's role was sent");
	};
	await withPrivateCopy([], roleless);
	await copyFails(
		roleless,
		[
			[
				ORCHESTRATE,
				'if (options.pi !== undefined && selectedPi === undefined) throw Error("Pi role unavailable from consumer");',
				"",
			],
		],
		"a Pi call sent without its consumer's role",
	);
});

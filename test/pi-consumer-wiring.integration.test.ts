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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DIAGNOSTIC_MESSAGES } from "../.pi/extensions/gitjig/dispatch/diagnostics.ts";
import type { DispatchOutcome, RunDispatchOptions } from "../.pi/extensions/gitjig/dispatch/index.ts";
import { challengerBrief, measurementBrief, piRecoveryBrief } from "../.pi/extensions/gitjig/recovery/briefs.ts";
import type { RecoveryPiRole } from "../.pi/extensions/gitjig/recovery/pi-profile.ts";
import {
	composeJudgeBrief,
	composeReviewerBrief,
	PI_RETURN_PROTOCOL_RETRY_SUFFIX,
	RETURN_PROTOCOL_RETRY_SUFFIX,
} from "../.pi/extensions/gitjig/review/briefs.ts";
import { composeDiagnosisBrief } from "../.pi/extensions/gitjig/review/history.ts";
import { makeDispatcher, reviewRound } from "../.pi/extensions/gitjig/review/orchestrate.ts";

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
	measurementBrief: typeof measurementBrief;
	piRecoveryBrief: typeof piRecoveryBrief;
};

function armSelectsTheTransportsBrief({ composeReviewerBrief, composeJudgeBrief }: ReviewBriefs): void {
	const timing = { firstReturnSeconds: 300, finalReturnSeconds: 1500 };
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
		assert.match(pi, /settled agent is not a result/, `${label}: the Pi absent-submission wording`);
		// The generic brief is untouched by any of that.
		assert.equal(generic.includes("submit_result"), false, `${label}: the generic brief names the tool`);
		assert.match(generic, /\.\.\/return\.json/, `${label}: the generic brief lost its direct-file instruction`);
		assert.equal(/call submit_result once with/.test(generic), false, `${label}: the Pi deadline wording leaked`);
	}
}

/** The recovery brief is a projection that refuses rather than half-rewrites. */
function armProjectsTheRecoveryBrief({ challengerBrief, measurementBrief, piRecoveryBrief }: RecoveryBriefs): void {
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
		mkdirSync(join(fixture, "test"));
		writeFileSync(join(fixture, "test/round.unit.test.ts"), "// the change under review\n");
		git("add", "test/round.unit.test.ts");
		git("commit", "-q", "-m", "change");
		await pinProductionRoles(round, fixture);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
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
	const context = { changeDescription: "a change", withheldHead: PIN };
	const generic = compose(basis as never, { ...context, transport: "generic" });
	const pi = compose(basis as never, { ...context, transport: "pi" });
	// Each of the three transport decisions shows in the composed text.
	assert.match(pi, /Submit the following closed object as typed submit_result tool arguments/);
	assert.match(pi, /PI RESULT: use only the trusted submit_result tool/);
	assert.match(pi, /call submit_result once with/);
	assertOnlyForbidsTheFile(pi, REVIEW_PROHIBITION, "diagnosis");
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
			`import { appendFileSync } from "node:fs";\nimport { runDispatch as real } from "./index.ts";\nexport const runDispatch: typeof real = (options) => {\n\tappendFileSync(${JSON.stringify(tracePath)}, \`\${JSON.stringify({ brief: options.brief, pi: options.pi ?? null })}\\n\`);\n\treturn Promise.resolve({ disposition: "refused", cause: "fixture", diagnostic: { status: "refused", phase: "return", run: { class: "exited", exitCode: 1, signal: null }, return: { class: "missing" }, compare: { class: "not-reached" }, durationMs: 1, code: "RETURN_MISSING" } } as never);\n};\n`,
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
				assert.deepEqual(
					[underPi.pi?.piExecutable, underPi.pi?.provider, underPi.pi?.model],
					[PI.piExecutable, PI.provider, PI.model],
					`${role}: the selection handed on`,
				);
			}
		for (const underGeneric of await sent(undefined, undefined)) {
			assert.equal(/submit_result/.test(underGeneric.brief), false, "the generic recovery dispatch was projected");
			assert.equal(underGeneric.pi, null);
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
	armProjectsTheRecoveryBrief({ challengerBrief, measurementBrief, piRecoveryBrief });
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

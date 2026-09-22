/** Warning-surface roster: EXEMPT — this module emits no warning, throw, record, or operator-facing text; child output stays in dispatcher diagnostics. */
/** Closed recovery execution profiles and executable preflight. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_DIR_MODE } from "../audit.ts";
import { withoutRepoLocatingGitEnv } from "../dispatch/provision.ts";
import { makeDispatcher } from "../review/orchestrate.ts";
import type { SessionSurface } from "../session-surface.ts";
import { canonicalJson } from "./lineage.ts";
import { PHASE_A_PROFILE_IDS, type PhaseAProfileId, type RecoveryProfileDispatcher } from "./types.ts";

const PROMPT =
	"Read ../brief.md completely. Write a complete provisional ../return.json early, then overwrite it with the final closed return before the stated deadline.";
const PROFILE_PATH = fileURLToPath(new URL("./profiles.json", import.meta.url));
const HELP_LINES = [
	/^ {2}--print, -p +/m,
	/^ {2}--thinking <level> +/m,
	/^ {2}--no-session +/m,
	/^ {2}--no-extensions, -ne +/m,
	/^ {2}--no-skills, -ns +/m,
	/^ {2}--no-context-files, -nc +/m,
	/^ {2}--approve, -a +/m,
	/^ {2}-- +End option parsing;/m,
];

type Profile = {
	id: PhaseAProfileId;
	provider: "ambient-default";
	model: "ambient-default";
	thinking: "high";
	runBoundMs: 600000;
};
type ProfileSet = { schemaVersion: 1; profiles: Profile[] };
const ATTEMPT_COUNTS = new WeakMap<object, 1 | 2>();
const DEADLINES = new WeakMap<RecoveryProfileDispatcher, { value?: number }>();

export function recoveryAttemptCount(outcome: object): 1 | 2 {
	return ATTEMPT_COUNTS.get(outcome) ?? 1;
}

export function armRecoveryProfileDeadline(dispatcher: RecoveryProfileDispatcher, deadline: number): void {
	const cell = DEADLINES.get(dispatcher);
	if (cell !== undefined && cell.value === undefined && Number.isFinite(deadline)) cell.value = deadline;
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

export function loadProfiles(): { set: ProfileSet; digest: string } | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(PROFILE_PATH, "utf8"));
		if (!exact(value, ["schemaVersion", "profiles"]) || value.schemaVersion !== 1 || !Array.isArray(value.profiles))
			return undefined;
		if (value.profiles.length !== PHASE_A_PROFILE_IDS.length) return undefined;
		for (let index = 0; index < value.profiles.length; index += 1) {
			const profile = value.profiles[index];
			if (
				!exact(profile, ["id", "provider", "model", "thinking", "runBoundMs"]) ||
				profile.id !== [...PHASE_A_PROFILE_IDS].sort()[index] ||
				profile.provider !== "ambient-default" ||
				profile.model !== "ambient-default" ||
				profile.thinking !== "high" ||
				profile.runBoundMs !== 600_000
			)
				return undefined;
		}
		const canonical = canonicalJson(value);
		if (canonical === undefined) return undefined;
		return {
			set: value as ProfileSet,
			digest: createHash("sha256").update(`gitjig-recovery-profiles:v1\n${canonical}`).digest("hex"),
		};
	} catch {
		return undefined;
	}
}

export function profileArgv(id: PhaseAProfileId): string[] | undefined {
	const loaded = loadProfiles();
	if (loaded === undefined || !loaded.set.profiles.some((profile) => profile.id === id)) return undefined;
	return [
		"pi",
		"-p",
		"--thinking",
		"high",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--approve",
		"--",
		PROMPT,
	];
}

export function profileMaterializationDigest(id: PhaseAProfileId): string | undefined {
	const loaded = loadProfiles();
	const argv = profileArgv(id);
	if (loaded === undefined || argv === undefined) return undefined;
	const canonical = canonicalJson({ profileSetDigest: loaded.digest, profileId: id, argv, runBoundMs: 600_000 });
	return canonical === undefined
		? undefined
		: createHash("sha256").update(`gitjig-recovery-materialization:v1\n${canonical}`).digest("hex");
}

export function makeRecoveryProfileDispatcher(options: {
	callerRepoRoot: string;
	stateRoot: string;
	surface?: SessionSurface;
}): RecoveryProfileDispatcher {
	const deadline: { value?: number } = {};
	const dispatcher: RecoveryProfileDispatcher = async (profileId, semanticBrief, expectedHead) => {
		deadline.value ??= performance.now() + 3_600_000;
		const delegateArgv = profileArgv(profileId) ?? [];
		let retried = false;
		const outcome = await makeDispatcher(
			{
				callerRepoRoot: options.callerRepoRoot,
				stateRoot: options.stateRoot,
				delegateArgv,
				timeoutMs: 600_000,
				operationDeadline: deadline.value,
				surface: options.surface,
			},
			undefined,
			() => {
				retried = true;
			},
		)(semanticBrief.text, expectedHead);
		ATTEMPT_COUNTS.set(outcome, retried ? 2 : 1);
		return outcome;
	};
	DEADLINES.set(dispatcher, deadline);
	return dispatcher;
}

export function preflightProfiles(stateRoot: string): boolean {
	if (loadProfiles() === undefined) return false;
	let root: string | undefined;
	try {
		root = mkdtempSync(join(stateRoot, "recovery-preflight-"));
		chmodSync(root, STATE_DIR_MODE);
		const env = withoutRepoLocatingGitEnv(process.env);
		env.GITJIG_TEST_STATE_ROOT = root;
		const help = execFileSync("pi", ["--help"], {
			encoding: "utf8",
			env,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
			killSignal: "SIGKILL",
			maxBuffer: 1024 * 1024,
		});
		const start = help.split("\n").filter((line) => line === "Options:");
		const end = help.split("\n").filter((line) => /^Extensions can register additional flags(?: |$)/.test(line));
		if (start.length !== 1 || end.length !== 1) return false;
		const block = help.slice(help.indexOf("Options:"), help.indexOf(end[0]));
		return HELP_LINES.every((pattern) => (block.match(pattern) ?? []).length === 1);
	} catch {
		return false;
	} finally {
		if (root !== undefined)
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {}
	}
}

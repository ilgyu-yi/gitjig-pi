/** Warning-surface roster: EXEMPT — this module emits no operator-facing warning text. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withoutRepoLocatingGitEnv } from "../dispatch/provision.ts";
import { canonicalJson, type PhaseAProfileId, structuralDigest } from "./types.ts";

export const RECOVERY_INITIAL_PROMPT =
	"Read ../brief.md completely. Write a complete provisional ../return.json early, then overwrite it with the final closed return before the stated deadline.";
const IDS: readonly PhaseAProfileId[] = [
	"recovery-diagnosis",
	"recovery-measurement",
	"recovery-selector",
	"stagnation-blast-radius",
	"stagnation-root",
];
export type RecoveryProfile = {
	id: PhaseAProfileId;
	provider: "ambient-default";
	model: "ambient-default";
	thinking: "high";
	runBoundMs: 600000;
};
export type RecoveryProfileSet = { schemaVersion: 1; profiles: RecoveryProfile[] };

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

export function loadRecoveryProfiles(): { set: RecoveryProfileSet; digest: string } | undefined {
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(fileURLToPath(new URL("./profiles.json", import.meta.url)), "utf8"),
		);
		if (!exact(parsed, ["schemaVersion", "profiles"]) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.profiles))
			return undefined;
		if (parsed.profiles.length !== IDS.length) return undefined;
		const profiles: RecoveryProfile[] = [];
		for (let index = 0; index < IDS.length; index += 1) {
			const value = parsed.profiles[index];
			if (
				!exact(value, ["id", "provider", "model", "thinking", "runBoundMs"]) ||
				value.id !== IDS[index] ||
				value.provider !== "ambient-default" ||
				value.model !== "ambient-default" ||
				value.thinking !== "high" ||
				value.runBoundMs !== 600000
			)
				return undefined;
			profiles.push(value as RecoveryProfile);
		}
		const set: RecoveryProfileSet = { schemaVersion: 1, profiles };
		return { set, digest: structuralDigest("gitjig-recovery-profiles:v1", set) };
	} catch {
		return undefined;
	}
}

export function materializeRecoveryProfile(
	loaded: { set: RecoveryProfileSet; digest: string },
	id: PhaseAProfileId,
): { profile: RecoveryProfile; argv: string[]; digest: string } | undefined {
	const profile = loaded.set.profiles.find((entry) => entry.id === id);
	if (profile === undefined) return undefined;
	const argv = [
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
		RECOVERY_INITIAL_PROMPT,
	];
	return {
		profile,
		argv,
		digest: structuralDigest("gitjig-recovery-materialization:v1", {
			profileSetDigest: loaded.digest,
			profileId: id,
			argv,
			runBoundMs: profile.runBoundMs,
		}),
	};
}

export function preflightRecoveryExecutable(): boolean {
	try {
		const child = spawnSync("pi", ["--help"], {
			encoding: "buffer",
			env: withoutRepoLocatingGitEnv(process.env),
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
			killSignal: "SIGKILL",
			maxBuffer: 1024 * 1024 + 1,
		});
		if (child.error !== undefined || child.signal !== null || child.status !== 0) return false;
		const stdout = child.stdout ?? Buffer.alloc(0);
		const stderr = child.stderr ?? Buffer.alloc(0);
		if (stdout.length + stderr.length > 1024 * 1024) return false;
		const output = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat([stdout, stderr]));
		const lines = output.split(/\r?\n/);
		const start = lines.filter((line) => line === "Options:");
		const ends = lines.filter((line) => /^Extensions can register additional flags(?: |$)/.test(line));
		if (start.length !== 1 || ends.length !== 1) return false;
		const firstUsage = start[0];
		if (firstUsage === undefined) return false;
		const from = lines.indexOf(firstUsage);
		const to = lines.findIndex((line) => /^Extensions can register additional flags(?: |$)/.test(line));
		if (to <= from) return false;
		const block = lines.slice(from + 1, to);
		const required = [
			/^ {2}--print, -p +/,
			/^ {2}--thinking <level> +/,
			/^ {2}--no-session +/,
			/^ {2}--no-extensions, -ne +/,
			/^ {2}--no-skills, -ns +/,
			/^ {2}--no-context-files, -nc +/,
			/^ {2}--approve, -a +/,
			/^ {2}-- +End option parsing;/,
		];
		return required.every((pattern) => block.filter((line) => pattern.test(line)).length === 1);
	} catch {
		return false;
	}
}

export function profileSetCanonicalBytes(set: RecoveryProfileSet): string {
	return canonicalJson(set);
}

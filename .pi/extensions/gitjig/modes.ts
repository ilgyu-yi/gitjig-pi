/** Warning-surface roster: EXEMPT — this module emits no operator-facing text; it returns closed source/refusal tokens and writes encoded JSON. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { STATE_DIR_MODE, STATE_FILE_MODE, STATE_PATH_GUARD_FLAGS, sinkRefusal, writeRecordLine } from "./audit.ts";

export type MergeMode = "off" | "on";
export type DecisionMode = "handoff" | "autonomous";
export type ModeSource = "invocation" | "environment" | "state" | "default";
export interface ResolvedModes {
	mergeMode: MergeMode;
	mergeSource: ModeSource;
	decisionMode: DecisionMode;
	decisionSource: ModeSource;
	refusals: readonly string[];
}

const exactObject = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
	value !== null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	Object.keys(value).length === keys.length &&
	keys.every((key) => Object.hasOwn(value, key));

function invocationValues(argv: readonly string[], name: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === name && index + 1 < argv.length) values.push(argv[index + 1] ?? "");
		else if (token?.startsWith(`${name}=`)) values.push(token.slice(name.length + 1));
	}
	return values;
}

function readState(stateRoot: string): { kind: "absent" | "invalid" | "valid"; value?: Record<string, unknown> } {
	try {
		const value: unknown = JSON.parse(readFileSync(join(stateRoot, "modes.json"), "utf8"));
		return exactObject(value, ["mergeMode", "decisionMode"]) ? { kind: "valid", value } : { kind: "invalid" };
	} catch (error) {
		return (error as { code?: string }).code === "ENOENT" ? { kind: "absent" } : { kind: "invalid" };
	}
}

function one<T extends string>(
	name: string,
	invocation: readonly string[],
	environment: string | undefined,
	state: unknown,
	allowed: readonly T[],
	fallback: T,
	refusals: string[],
): { value: T; source: ModeSource } {
	if (invocation.length > 1) {
		refusals.push(`${name}:invocation-conflict`);
		return { value: fallback, source: "invocation" };
	}
	const candidates: readonly [ModeSource, unknown][] = [
		["invocation", invocation[0]],
		["environment", environment],
		["state", state],
	];
	for (const [source, candidate] of candidates) {
		if (candidate === undefined) continue;
		if (typeof candidate === "string" && allowed.includes(candidate as T)) return { value: candidate as T, source };
		refusals.push(`${name}:${source}-invalid`);
		return { value: fallback, source };
	}
	return { value: fallback, source: "default" };
}

export function resolveModes(input: {
	argv: readonly string[];
	env: Readonly<Record<string, string | undefined>>;
	stateRoot: string;
}): ResolvedModes {
	const refusals: string[] = [];
	const state = readState(input.stateRoot);
	const merge = one(
		"merge-mode",
		invocationValues(input.argv, "--merge-mode"),
		input.env.GITJIG_MERGE_MODE,
		state.kind === "valid" ? state.value?.mergeMode : state.kind === "invalid" ? null : undefined,
		["off", "on"],
		"off",
		refusals,
	);
	const decision = one(
		"decision-mode",
		invocationValues(input.argv, "--decision-mode"),
		input.env.GITJIG_DECISION_MODE,
		state.kind === "valid" ? state.value?.decisionMode : state.kind === "invalid" ? null : undefined,
		["handoff", "autonomous"],
		"handoff",
		refusals,
	);
	return Object.freeze({
		mergeMode: merge.value,
		mergeSource: merge.source,
		decisionMode: decision.value,
		decisionSource: decision.source,
		refusals: Object.freeze(refusals),
	});
}

export function recordModeRun(
	stateRoot: string,
	repoRoot: string,
	modes: ResolvedModes,
	startedAt = new Date().toISOString(),
): boolean {
	if (!isAbsolute(stateRoot) || !isAbsolute(repoRoot) || !Number.isFinite(Date.parse(startedAt))) return false;
	try {
		mkdirSync(stateRoot, { recursive: true, mode: STATE_DIR_MODE });
		const path = join(stateRoot, "mode-runs.jsonl");
		const fd = openSync(
			path,
			constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | STATE_PATH_GUARD_FLAGS,
			STATE_FILE_MODE,
		);
		try {
			if (sinkRefusal(fstatSync(fd), path) !== undefined) return false;
			const repositoryKey = createHash("sha256").update(repoRoot).digest("hex");
			writeRecordLine(
				fd,
				`${JSON.stringify({
					schemaVersion: 1,
					repositoryKey,
					startedAt,
					mergeMode: modes.mergeMode,
					mergeSource: modes.mergeSource,
					decisionMode: modes.decisionMode,
					decisionSource: modes.decisionSource,
					refusals: modes.refusals,
				})}\n`,
			);
		} finally {
			closeSync(fd);
		}
		return true;
	} catch {
		return false;
	}
}

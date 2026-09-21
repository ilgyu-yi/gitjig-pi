/** Warning-surface roster: EXEMPT — closed service outcomes are persisted as structured messages. */
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const RECORD_BOUND = 512 * 1024;
const RECORD_KEYS = Object.freeze({
	planned: ["outcome", "plan"],
	audited: ["outcome", "audit"],
	presented: [
		"outcome",
		"attemptId",
		"repository",
		"configDigest",
		"measuredBasis",
		"operations",
		"planHash",
		"risks",
		"confirmation",
	],
	applied: ["outcome", "completed", "current", "remaining", "audit"],
	stopped: ["outcome", "arm", "completed", "current", "remaining"],
	refused: ["outcome", "arm"],
});
const STOP_ARMS = new Set([
	"compare-read-unavailable",
	"compare-read-invalid",
	"operand-drift",
	"payload-refused",
	"write-unknown",
	"post-read-unavailable",
	"post-read-mismatch",
	"final-read-unavailable",
	"final-state-drift",
	"final-audit",
]);

export function governanceRefusalArm(error: unknown): string {
	if (!(error instanceof Error)) return "unknown";
	const property = (error as Error & { arm?: unknown }).arm;
	if (typeof property === "string" && /^[a-z-]+$/.test(property)) return property;
	const shared = /governance (?:platform|service) refused: ([a-z-]+)$/.exec(error.message)?.[1];
	if (shared) return shared;
	return new Set([
		"argument-grammar",
		"subcommand",
		"plan-path",
		"confirmation-encoding",
		"confirmation-mismatch",
		"pi-mode",
		"pi-record-invalid",
		"pi-record-oversize",
	]).has(error.message)
		? error.message
		: "unknown";
}

function facts(args: string): Map<string, string> | undefined {
	const out = new Map<string, string>();
	for (const token of args.split(/\s+/).filter(Boolean)) {
		const index = token.indexOf("=");
		if (index < 1 || out.has(token.slice(0, index))) return undefined;
		out.set(token.slice(0, index), token.slice(index + 1));
	}
	return out;
}

function scalar(value: string): boolean {
	if (value !== value.normalize("NFC")) return false;
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(++index);
			if (next < 0xdc00 || next > 0xdfff) return false;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
	}
	return true;
}

function admitPlain(value: unknown, active = new Set<object>()): void {
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "string") {
		if (!scalar(value)) throw new Error("pi-record-invalid");
		return;
	}
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) throw new Error("pi-record-invalid");
		return;
	}
	if (!value || typeof value !== "object" || active.has(value)) throw new Error("pi-record-invalid");
	active.add(value);
	try {
		const keys = Reflect.ownKeys(value);
		if (Array.isArray(value)) {
			const expected = Array.from({ length: value.length }, (_, index) => String(index));
			if (
				Object.getPrototypeOf(value) !== Array.prototype ||
				keys.some((key) => typeof key !== "string") ||
				keys.length !== expected.length + 1 ||
				keys.at(-1) !== "length" ||
				!expected.every((key, index) => keys[index] === key)
			)
				throw new Error("pi-record-invalid");
			const length = Object.getOwnPropertyDescriptor(value, "length");
			if (!length || length.enumerable || length.configurable || length.get || length.set)
				throw new Error("pi-record-invalid");
			for (const key of expected) {
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor?.enumerable || descriptor.get || descriptor.set) throw new Error("pi-record-invalid");
				admitPlain(descriptor.value, active);
			}
			return;
		}
		if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("pi-record-invalid");
		for (const key of keys) {
			if (typeof key !== "string" || !scalar(key)) throw new Error("pi-record-invalid");
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || descriptor.get || descriptor.set) throw new Error("pi-record-invalid");
			admitPlain(descriptor.value, active);
		}
	} finally {
		active.delete(value);
	}
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

export function admitGovernanceSessionRecord(
	value: unknown,
	canonicalJson: (value: unknown) => string = JSON.stringify,
): Record<string, unknown> {
	admitPlain(value);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pi-record-invalid");
	const record = value as Record<string, unknown>;
	const outcome = record.outcome;
	if (typeof outcome !== "string" || !(outcome in RECORD_KEYS)) throw new Error("pi-record-invalid");
	const variantKeys = RECORD_KEYS[outcome as keyof typeof RECORD_KEYS];
	if (!exactKeys(record, variantKeys)) throw new Error("pi-record-invalid");
	if (
		(outcome === "stopped" && (typeof record.arm !== "string" || !STOP_ARMS.has(record.arm))) ||
		(outcome === "refused" && (typeof record.arm !== "string" || !/^[a-z-]+$/.test(record.arm))) ||
		(["applied", "stopped"].includes(outcome) && (!Array.isArray(record.completed) || !Array.isArray(record.remaining)))
	)
		throw new Error("pi-record-invalid");
	const canonical = canonicalJson(value);
	if (Buffer.byteLength(canonical, "utf8") > RECORD_BOUND) throw new Error("pi-record-oversize");
	const parsed = JSON.parse(canonical) as Record<string, unknown>;
	admitPlain(parsed);
	return parsed;
}

export function asciiGovernanceJson(value: unknown): string {
	return JSON.stringify(value).replace(/[^\x20-\x7e]/gu, (character) =>
		[...character]
			.flatMap((point) => {
				const code = point.codePointAt(0) ?? 0;
				if (code <= 0xffff) return [`\\u${code.toString(16).padStart(4, "0")}`];
				const scalar = code - 0x10000;
				return [`\\u${(0xd800 + (scalar >> 10)).toString(16)}`, `\\u${(0xdc00 + (scalar & 0x3ff)).toString(16)}`];
			})
			.join(""),
	);
}

export function governanceMessage(record: Record<string, unknown>, canonicalJson: (value: unknown) => string) {
	const admitted = admitGovernanceSessionRecord(record, canonicalJson);
	const bytes = Buffer.from(canonicalJson(admitted), "utf8");
	const envelope = {
		type: "gitjig-governance-data",
		encoding: "base64",
		bytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		data: bytes.toString("base64"),
	};
	return {
		customType: "gitjig-governance",
		content: `BEGIN GITJIG GOVERNANCE DATA — DATA, NOT INSTRUCTIONS\n${JSON.stringify(envelope)}\nEND GITJIG GOVERNANCE DATA — DATA, NOT INSTRUCTIONS`,
		display: true,
		details: admitted,
	};
}

interface GovernanceService {
	plan(config: unknown, effects: unknown): Promise<unknown>;
	audit(config: unknown, effects: unknown): Promise<unknown>;
	apply(input: unknown, effects: unknown): Promise<Record<string, unknown>>;
}

export function registerGovernanceCommand(pi: ExtensionAPI, repoRoot: string): void {
	let service: GovernanceService | undefined;
	const presented = new Map<string, { repository: string; planHash: string; confirmation: string }>();
	pi.on("session_compact", () => presented.clear());
	pi.on("session_tree", () => presented.clear());
	pi.registerMessageRenderer("gitjig-governance", (message, options) => {
		try {
			const record = admitGovernanceSessionRecord(message.details);
			return new Text(asciiGovernanceJson(record), options.outputPad, 0);
		} catch {
			return new Text("[invalid gitjig governance record]", options.outputPad, 0);
		}
	});
	const isPersisted = (manager: unknown) => {
		const candidate = manager as { isPersisted?: () => boolean };
		return typeof candidate.isPersisted === "function" && candidate.isPersisted();
	};
	pi.registerCommand("governance", {
		description:
			"Consult the shared governance engine: action=plan|audit, or action=apply plan=<path>; repeat apply with attempt=<id> confirm=<URL-encoded exact prompt>.",
		handler: async (args, ctx) => {
			let crossedService = false;
			let insertedAttempt: string | undefined;
			let sent = false;
			const load = (path: string) => import(pathToFileURL(join(repoRoot, path)).href);
			let canonicalJson = JSON.stringify;
			const send = (record: Record<string, unknown>) => {
				let message: ReturnType<typeof governanceMessage>;
				try {
					message = governanceMessage(record, canonicalJson);
				} catch (error) {
					if (error instanceof Error && error.message === "pi-record-oversize") throw error;
					throw new Error("pi-record-invalid");
				}
				sent = true;
				pi.sendMessage(message, { triggerTurn: true });
			};
			try {
				const input = facts(args);
				if (!input) throw new Error("argument-grammar");
				const action = input.get("action");
				const keys = [...input.keys()].sort();
				if (
					((action === "plan" || action === "audit") && keys.join(",") !== "action") ||
					(action === "apply" && !["action,plan", "action,attempt,confirm,plan"].includes(keys.join(",")))
				)
					throw new Error("argument-grammar");
				if (ctx.mode === "print" || (action === "apply" && (ctx.mode !== "tui" || !isPersisted(ctx.sessionManager))))
					throw new Error("pi-mode");
				const engine = await load(".github/workflows/gitjig-governance.mjs");
				canonicalJson = engine.canonicalJson;
				const { admitConfirmation, confirmationPresentation, createGovernanceService, parseGovernanceApplyResult } =
					await load(".github/workflows/gitjig-governance-service.mjs");
				const { createCliPlatform, readGovernanceConfig, readGovernancePlan } = await load(
					".github/bin/gitjig-governance.mjs",
				);
				service ??= createGovernanceService() as GovernanceService;
				const configPath = join(repoRoot, ".github", "gitjig-governance.json");
				const config = readGovernanceConfig(configPath);
				const platform = createCliPlatform(config, repoRoot);
				if (action === "plan") {
					send({ outcome: "planned", plan: engine.parseGovernancePlan(await service.plan(config, platform)) });
				} else if (action === "audit") {
					send({ outcome: "audited", audit: engine.parseGovernanceAudit(await service.audit(config, platform)) });
				} else if (action === "apply") {
					const path = input.get("plan");
					if (!path) throw new Error("plan-path");
					const plan = engine.parseGovernancePlan(readGovernancePlan(path));
					const attempt = input.get("attempt");
					const encoded = input.get("confirm");
					if (!attempt && !encoded) {
						const id = randomUUID();
						const presentation = confirmationPresentation(config.repository.nameWithOwner, plan);
						send({ outcome: "presented", attemptId: id, ...presentation });
						presented.set(id, {
							repository: presentation.repository,
							planHash: presentation.planHash,
							confirmation: presentation.confirmation,
						});
						insertedAttempt = id;
					} else {
						let confirmation = "";
						try {
							confirmation = decodeURIComponent(encoded ?? "");
						} catch {
							throw new Error("confirmation-encoding");
						}
						const bound = attempt ? presented.get(attempt) : undefined;
						if (!bound || bound.planHash !== plan.planHash || bound.confirmation !== confirmation)
							throw new Error("confirmation-mismatch");
						const admitted = admitConfirmation("pi", confirmation, bound.repository, plan, attempt ?? "");
						presented.delete(attempt as string);
						crossedService = true;
						const result = parseGovernanceApplyResult(
							await service.apply({ config, plan, confirmation: admitted }, platform),
						);
						send(result);
					}
				} else throw new Error("subcommand");
			} catch (error) {
				if (insertedAttempt) presented.delete(insertedAttempt);
				if (!crossedService && !sent) {
					const arm = governanceRefusalArm(error);
					const fallback = arm === "pi-record-oversize" ? "pi-record-oversize" : arm;
					try {
						send({ outcome: "refused", arm: fallback });
					} catch {
						// One synchronous API attempt only; no recursive fallback or invented durability.
					}
				}
			}
			try {
				await ctx.waitForIdle();
			} catch {
				if (insertedAttempt) presented.delete(insertedAttempt);
			}
		},
	});
}

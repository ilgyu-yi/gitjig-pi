/* Trusted Pi child extension: copied beside a caller-owned closed profile in
 * scratch before spawn. It never reads a role from the reviewed clone. The
 * parent still admits return.json and blind-compares the independently
 * resolved HEAD; this writer's preflight is defense in depth, not authority.
 */
import { execFileSync } from "node:child_process";
import { closeSync, constants, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
const MAX_RETURN_BYTES = 65_536;
export type JsonSchema = {
	type: "object" | "array" | "string" | "boolean";
	properties?: Record<string, JsonSchema>;
	required?: string[];
	additionalProperties?: false;
	items?: JsonSchema;
	enum?: string[];
	const?: string | boolean;
	minLength?: number;
	maxLength?: number;
	maxItems?: number;
};
export type Profile = {
	role:
		| "reviewer"
		| "judge"
		| "history"
		| "recovery-challenger"
		| "recovery-selector-contest"
		| "recovery-selector-measurement"
		| "recovery-measurement"
		| "recovery-diagnosis";
	schema: JsonSchema;
	summary: string;
	fixed: Record<string, string | boolean>;
};

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		Object.keys(value).every((key) => keys.includes(key))
	);
}

/** Validate again inside the tool, before any candidate file is created. */
export function matchesProfile(schema: JsonSchema, value: unknown, depth = 0): boolean {
	if (depth > 8) return false;
	if (schema.type === "string")
		return (
			typeof value === "string" &&
			(schema.minLength === undefined || value.length >= schema.minLength) &&
			(schema.maxLength === undefined || value.length <= schema.maxLength) &&
			(schema.enum === undefined || schema.enum.includes(value)) &&
			(schema.const === undefined || value === schema.const)
		);
	if (schema.type === "boolean")
		return typeof value === "boolean" && (schema.const === undefined || value === schema.const);
	if (schema.type === "array")
		return (
			Array.isArray(value) &&
			(schema.maxItems === undefined || value.length <= schema.maxItems) &&
			schema.items !== undefined &&
			value.every((item) => matchesProfile(schema.items as JsonSchema, item, depth + 1))
		);
	if (
		schema.type !== "object" ||
		schema.properties === undefined ||
		schema.required === undefined ||
		schema.additionalProperties !== false ||
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value)
	)
		return false;
	const fields = value as Record<string, unknown>;
	return (
		Object.keys(fields).every(
			(key) =>
				key in (schema.properties as Record<string, JsonSchema>) &&
				matchesProfile((schema.properties as Record<string, JsonSchema>)[key], fields[key], depth + 1),
		) && schema.required.every((key) => Object.hasOwn(fields, key))
	);
}

function namesHead(text: string, head: string): boolean {
	return (text.match(/[0-9a-fA-F]{4,}/g) ?? []).some((run) => {
		const lower = run.toLowerCase();
		return (lower.length >= 6 && head.includes(lower)) || lower.includes(head.slice(0, 7));
	});
}

function recoveryText(value: unknown, empty = false): value is string {
	if (
		typeof value !== "string" ||
		(!empty && value.length === 0) ||
		Buffer.byteLength(value, "utf8") > 4096 ||
		value !== value.normalize("NFC")
	)
		return false;
	for (const character of value) {
		const point = character.codePointAt(0);
		if (
			point === undefined ||
			(point >= 0xd800 && point <= 0xdfff) ||
			point <= 0x1f ||
			(point >= 0x7f && point <= 0x9f)
		)
			return false;
	}
	return true;
}

/** Consumer-specific checks not expressible by the Pi tool's JSON schema. */
export function matchesConsumerPolicy(profile: Profile, value: Record<string, unknown>): boolean {
	if (!profile.role.startsWith("recovery-")) return true;
	const encoded = JSON.stringify(value);
	if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) return false;
	const fields =
		profile.role === "recovery-challenger"
			? ["method", "evidence"]
			: profile.role === "recovery-selector-contest" || profile.role === "recovery-diagnosis"
				? ["evidence"]
				: profile.role === "recovery-selector-measurement"
					? ["question", "method", "expectedDiscriminator", "evidence"]
					: ["result", "evidence"];
	for (const field of fields) {
		if (!recoveryText(value[field], profile.role === "recovery-challenger" && field === "method")) return false;
	}
	if (profile.role === "recovery-challenger") {
		if (value.outcome === "BASE_STANDS" ? value.method !== "" : value.method === "") return false;
	}
	if (
		["recovery-challenger", "recovery-selector-measurement", "recovery-measurement"].includes(profile.role) &&
		fields.reduce((size, field) => size + Buffer.byteLength(value[field] as string, "utf8"), 0) > 8192
	)
		return false;
	return true;
}

function submit(profile: Profile, args: unknown): void {
	if (!matchesProfile(profile.schema, args)) throw Error("submit_result parameters rejected");
	const { summary: requestedSummary, ...fields } = args as Record<string, unknown>;
	const summary = typeof requestedSummary === "string" ? requestedSummary : profile.summary;
	const value = { ...profile.fixed, ...fields };
	if (!matchesConsumerPolicy(profile, value)) throw Error("submit_result consumer profile rejected");
	const payload = JSON.stringify(value);
	// The clone's HEAD is resolved here, not received from the delegate or caller.
	const env = { ...process.env };
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_COMMON_DIR",
		"GIT_CONFIG_PARAMETERS",
		"GIT_CONFIG_COUNT",
	])
		delete env[key];
	const head = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
		cwd: process.cwd(),
		env,
		encoding: "utf8",
		timeout: 2000,
	}).trim();
	if (!/^[0-9a-f]{40}$/.test(head) || namesHead(JSON.stringify({ summary, payload }), head))
		throw Error("submit_result operand rejected");
	const bytes = Buffer.from(JSON.stringify({ ok: true, summary, reviewedHead: head, payload }), "utf8");
	if (bytes.length > MAX_RETURN_BYTES) throw Error("submit_result return too large");
	const target = join(here, "..", "return.json");
	const temp = join(here, `.${process.pid}.return.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
		writeFileSync(fd, bytes);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		// Hard-link installation is atomic and never replaces an existing return.
		linkSync(temp, target);
	} finally {
		if (fd !== undefined) closeSync(fd);
		try {
			unlinkSync(temp);
		} catch {}
	}
}

export default function registerSubmitResult(pi: ExtensionAPI): void {
	const config: unknown = JSON.parse(readFileSync(join(here, "profile.json"), "utf8"));
	if (
		!exact(config, ["role", "schema", "summary", "fixed"]) ||
		typeof config.role !== "string" ||
		![
			"reviewer",
			"judge",
			"history",
			"recovery-challenger",
			"recovery-selector-contest",
			"recovery-selector-measurement",
			"recovery-measurement",
			"recovery-diagnosis",
		].includes(config.role) ||
		typeof config.summary !== "string" ||
		config.summary.length === 0 ||
		typeof config.schema !== "object" ||
		config.schema === null ||
		(config.schema as JsonSchema).type !== "object" ||
		typeof config.fixed !== "object" ||
		config.fixed === null ||
		Array.isArray(config.fixed) ||
		Object.values(config.fixed).some((item) => typeof item !== "string" && typeof item !== "boolean")
	)
		throw Error("submit_result profile refused");
	const profile = config as Profile;
	if (Object.keys(profile.fixed).some((key) => key in (profile.schema.properties ?? {})))
		throw Error("submit_result profile refused");
	pi.registerTool({
		name: "submit_result",
		label: "Submit result",
		description: "Submit one structured final result for this invocation.",
		parameters: profile.schema as Parameters<ExtensionAPI["registerTool"]>[0]["parameters"],
		async execute(_id, args: unknown) {
			submit(profile, args);
			return { content: [{ type: "text", text: "Result submitted." }], details: {} };
		},
	});
}

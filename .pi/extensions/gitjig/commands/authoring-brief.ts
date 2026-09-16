/**
 * On-demand pre-authoring norm delivery (SPEC §2.5, issue #245).
 *
 * The policy is repository-controlled data. User text selects only named paths;
 * it never selects source files or anchors. Clauses are byte slices of SPEC.md,
 * not restated summaries. An incomplete result is advisory and cannot claim
 * readiness.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface AuthoringInput {
	plan: string;
	failingCheck: { description: string; command: string };
	paths: string[];
}

interface PolicyRoute {
	surface: string;
	prefixes: string[];
	anchors: string[];
	defaultAct?: string;
}

interface AuthoringPolicy {
	version: number;
	routes: PolicyRoute[];
}

export interface AuthoringBriefResult {
	complete: boolean;
	text: string;
}

const SOURCE_PATH = "SPEC.md";
const POLICY_PATH = ".pi/extensions/gitjig/authoring/policy.json";

function ownKeys(value: object, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function parseInput(raw: string): AuthoringInput | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	if (!ownKeys(value, ["failingCheck", "paths", "plan"])) return undefined;
	const candidate = value as Record<string, unknown>;
	const check = candidate.failingCheck;
	if (typeof check !== "object" || check === null || Array.isArray(check)) return undefined;
	if (!ownKeys(check, ["command", "description"])) return undefined;
	const checkFields = check as Record<string, unknown>;
	if (!nonempty(candidate.plan) || !nonempty(checkFields.description) || !nonempty(checkFields.command))
		return undefined;
	if (!Array.isArray(candidate.paths) || candidate.paths.length === 0 || !candidate.paths.every(nonempty))
		return undefined;
	return {
		plan: candidate.plan,
		failingCheck: { description: checkFields.description, command: checkFields.command },
		paths: candidate.paths,
	};
}

function validRepoPath(path: string): boolean {
	if (isAbsolute(path) || path.includes("\\") || path.endsWith("/")) return false;
	const parts = path.split("/");
	return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function readRegularNoLinks(root: string, repositoryPath: string): string {
	const realRoot = realpathSync(root);
	const lexical = resolve(realRoot, repositoryPath);
	const fromRoot = relative(realRoot, lexical);
	if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
		throw new Error("source escapes repository root");
	}
	let cursor = realRoot;
	for (const part of repositoryPath.split("/")) {
		cursor = join(cursor, part);
		if (lstatSync(cursor).isSymbolicLink()) throw new Error("source traverses a symbolic link");
	}
	const descriptor = openSync(cursor, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		if (!fstatSync(descriptor).isFile()) throw new Error("source is not a regular file");
		return readFileSync(descriptor, "utf8");
	} finally {
		closeSync(descriptor);
	}
}

function parsePolicy(text: string): AuthoringPolicy {
	const value = JSON.parse(text) as Partial<AuthoringPolicy>;
	if (value.version !== 1 || !Array.isArray(value.routes) || value.routes.length === 0) {
		throw new Error("unsupported routing policy");
	}
	for (const route of value.routes) {
		if (!nonempty(route.surface) || !Array.isArray(route.prefixes) || !Array.isArray(route.anchors)) {
			throw new Error("invalid routing policy row");
		}
		if (
			route.prefixes.length === 0 ||
			route.anchors.length === 0 ||
			!route.prefixes.every(nonempty) ||
			!route.anchors.every(nonempty)
		) {
			throw new Error("empty routing policy row");
		}
		if (route.prefixes.includes("")) throw new Error("catch-all routing is forbidden");
		if (!route.anchors.every((anchor) => /^#{1,6} [^\r\n]+$/.test(anchor))) {
			throw new Error("every canonical anchor must be an exact heading");
		}
	}
	return value as AuthoringPolicy;
}

function matches(path: string, prefix: string): boolean {
	return prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix;
}

function sectionAt(source: string, anchor: string): string | undefined {
	const marker = `${anchor}\n`;
	const starts: number[] = [];
	for (let cursor = 0; cursor < source.length; ) {
		const candidate = source.indexOf(marker, cursor);
		if (candidate < 0) break;
		if (candidate === 0 || source[candidate - 1] === "\n") starts.push(candidate);
		cursor = candidate + marker.length;
	}
	if (starts.length !== 1) return undefined;
	const start = starts[0];
	const level = anchor.match(/^#+/)?.[0].length;
	if (level === undefined) return undefined;
	let end = source.length;
	const heading = /^(#{1,6}) .+$/gm;
	heading.lastIndex = start + marker.length;
	for (let match = heading.exec(source); match !== null; match = heading.exec(source)) {
		if (match[1].length <= level) {
			end = match.index;
			break;
		}
	}
	return source.slice(start, end);
}

function incomplete(causes: string[]): AuthoringBriefResult {
	return {
		complete: false,
		text: [
			"AUTHORING BRIEF — INCOMPLETE (advisory only)",
			"Readiness is not established. Do not treat this result as permission to author.",
			...causes.map((cause) => `- ${cause}`),
		].join("\n"),
	};
}

export function composeAuthoringBrief(raw: string, root = process.cwd()): AuthoringBriefResult {
	const input = parseInput(raw);
	if (input === undefined)
		return incomplete([
			"input must be closed JSON with plan, failingCheck.description, failingCheck.command, and paths",
		]);
	if (!input.paths.every(validRepoPath))
		return incomplete(["every named path must be a normalized repository-relative path"]);

	let policy: AuthoringPolicy;
	let source: string;
	try {
		policy = parsePolicy(readRegularNoLinks(root, POLICY_PATH));
		source = readRegularNoLinks(root, SOURCE_PATH);
	} catch {
		return incomplete(["the routing policy or canonical SPEC source is unavailable or invalid"]);
	}

	const routes: PolicyRoute[] = [];
	const pathRows: string[] = [];
	const causes: string[] = [];
	for (const path of input.paths) {
		const matching = policy.routes.filter((route) => route.prefixes.some((prefix) => matches(path, prefix)));
		if (matching.length === 0) {
			causes.push(`unrouted path ${JSON.stringify(path)}`);
			continue;
		}
		if (matching.length > 1) {
			causes.push(`conflicting routes for ${JSON.stringify(path)}`);
			continue;
		}
		routes.push(matching[0]);
		pathRows.push(`- ${JSON.stringify(path)} → ${matching[0].surface}`);
	}
	if (causes.length > 0) return incomplete(causes);

	const anchors = [...new Set(routes.flatMap((route) => route.anchors))];
	const sections: string[] = [];
	for (const anchor of anchors) {
		const section = sectionAt(source, anchor);
		if (section === undefined) causes.push(`missing or ambiguous canonical anchor ${JSON.stringify(anchor)}`);
		else sections.push(section);
	}
	if (causes.length > 0) return incomplete(causes);

	const defaults = [...new Set(routes.map((route) => route.defaultAct).filter(nonempty))];
	const defaultRows =
		defaults.length === 0 ? ["- none"] : defaults.map((act) => `- ${act} (only on the rendered clause's own terms)`);
	return {
		complete: true,
		text: [
			"AUTHORING BRIEF — COMPLETE",
			"Plan:",
			input.plan,
			"Failing check:",
			input.failingCheck.description,
			"Exact command:",
			input.failingCheck.command,
			"Routed paths:",
			...pathRows,
			"Inherited default authoring act:",
			...defaultRows,
			"Applicable canonical clauses (verbatim from SPEC.md):",
			...sections,
		].join("\n\n"),
	};
}

export function registerAuthoringBriefCommand(pi: ExtensionAPI, repoRoot: string): void {
	pi.registerCommand("authoring-brief", {
		description: "Deliver path-routed canonical authoring norms before editing",
		handler: async (args) => {
			const result = composeAuthoringBrief(args, repoRoot);
			pi.sendMessage({ customType: "gitjig-authoring-brief", content: result.text, display: true });
		},
	});
}

/** Warning-surface roster: EXEMPT — pure classifier errors are fixed strings. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";

export const CANDIDATE_ROOTS = [".pi", ".github", ".githooks", "changelog_unreleased"] as const;
export const DISPOSITIONS = ["source-only", "instance-state", "handed-over", "carried"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
export type Classification = Disposition | "refuse";
export interface Membership {
	path: string;
	disposition: Disposition;
}
export interface ObservedCandidate extends Membership {
	bytes: Buffer;
}
export interface ObservationOptions {
	/** Test seams for replacements at exact pathname/descriptor phases. */
	afterLstat?: (path: string) => void;
	afterRead?: (path: string) => void;
	afterDirectoryRead?: (path: string) => void;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const DECLARATIONS = new Set(["# gitjig: source-only", "// gitjig: source-only"]);

export class ClassificationRefusal extends Error {
	constructor(cause: string) {
		super(`candidate classification refused: ${cause}`);
	}
}

function lineAt(bytes: Buffer, start: number): { text: string; terminated: boolean; next: number } {
	const lf = bytes.indexOf(0x0a, start);
	const end = lf < 0 ? bytes.length : lf;
	let body = bytes.subarray(start, end);
	if (body.at(-1) === 0x0d) body = body.subarray(0, -1);
	let text: string;
	try {
		text = utf8.decode(body);
	} catch {
		throw new ClassificationRefusal("an eligible declaration line is not UTF-8");
	}
	return { text, terminated: lf >= 0, next: lf < 0 ? bytes.length : lf + 1 };
}

export function classifyMarker(bytes: Buffer): "source-only" | "absent" | "refuse" {
	const first = lineAt(bytes, 0);
	const eligible = first.text.startsWith("#!") ? lineAt(bytes, first.next) : first;
	if (eligible.terminated && DECLARATIONS.has(eligible.text)) return "source-only";
	return eligible.text.includes("gitjig:") ? "refuse" : "absent";
}

function hasLoneSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true;
			index++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
	}
	return false;
}
export function validateUnicodeScalars(value: string): void {
	if (hasLoneSurrogate(value)) throw new ClassificationRefusal("value is not a Unicode scalar sequence");
}

export function validateCandidatePath(path: string): void {
	validateUnicodeScalars(path);
	if (
		path.length === 0 ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path.includes("\0") ||
		path !== path.normalize("NFC")
	)
		throw new ClassificationRefusal("invalid canonical path");
	const parts = path.split("/");
	if (parts.some((part) => part === "" || part === "." || part === ".."))
		throw new ClassificationRefusal("invalid canonical path component");
	if (!CANDIDATE_ROOTS.includes(parts[0] as (typeof CANDIDATE_ROOTS)[number]))
		throw new ClassificationRefusal("path is outside the candidate universe");
}

export function classifyCandidate(path: string, bytes: Buffer): Classification {
	validateCandidatePath(path);
	const marker = classifyMarker(bytes);
	if (marker !== "absent") return marker;
	if (path === "changelog_unreleased/TEMPLATE.md") return "handed-over";
	if (path.startsWith("changelog_unreleased/")) return "instance-state";
	if (
		path === ".pi/extensions/gitjig.ts" ||
		path.startsWith(".pi/extensions/gitjig/") ||
		path.startsWith(".pi/prompts/")
	)
		return "carried";
	if (path.startsWith(".pi/")) return "refuse";
	if (path.startsWith(".github/") || path.startsWith(".githooks/")) return "handed-over";
	return "refuse";
}

function appendPath(base: Buffer, name: Buffer): Buffer {
	return Buffer.concat([base, Buffer.from("/"), name]);
}

export function decodeCandidatePath(bytes: Buffer): string {
	let path: string;
	try {
		path = utf8.decode(bytes);
	} catch {
		throw new ClassificationRefusal("candidate path is not UTF-8");
	}
	validateCandidatePath(path);
	return path;
}

function sameObject(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function walk(
	abs: Buffer,
	relative: Buffer,
	out: ObservedCandidate[],
	expected: Stats,
	options: ObservationOptions,
): void {
	let before: Stats;
	let entries: ReturnType<typeof readdirSync>;
	try {
		before = lstatSync(abs);
		if (!before.isDirectory() || before.isSymbolicLink() || !sameObject(before, expected))
			throw new ClassificationRefusal("candidate directory identity changed");
		entries = readdirSync(abs, { withFileTypes: true, encoding: "buffer" });
	} catch (error) {
		if (error instanceof ClassificationRefusal) throw error;
		throw new ClassificationRefusal("candidate namespace is unreadable");
	}
	for (const entry of entries) {
		const name = entry.name as unknown as Buffer;
		const childAbs = appendPath(abs, name);
		const childRel = relative.length === 0 ? name : appendPath(relative, name);
		let stats: Stats;
		try {
			stats = lstatSync(childAbs);
		} catch {
			throw new ClassificationRefusal("candidate is unreadable");
		}
		const path = decodeCandidatePath(childRel);
		options.afterLstat?.(path);
		if (stats.isDirectory()) {
			walk(childAbs, childRel, out, stats, options);
			continue;
		}
		if (!stats.isFile())
			throw new ClassificationRefusal(stats.isSymbolicLink() ? "candidate is a symlink" : "candidate is non-regular");
		let bytes: Buffer;
		let descriptor: number | undefined;
		try {
			descriptor = openSync(childAbs, constants.O_RDONLY | constants.O_NOFOLLOW);
			const opened = fstatSync(descriptor);
			if (!opened.isFile() || !sameObject(stats, opened)) throw new ClassificationRefusal("candidate identity changed");
			bytes = readFileSync(descriptor);
			options.afterRead?.(path);
			if (!sameObject(opened, lstatSync(childAbs))) throw new ClassificationRefusal("candidate identity changed");
		} catch (error) {
			if (error instanceof ClassificationRefusal) throw error;
			throw new ClassificationRefusal("candidate is unreadable or was replaced");
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
		}
		const disposition = classifyCandidate(path, bytes);
		if (disposition === "refuse") throw new ClassificationRefusal("candidate has no admitted disposition");
		out.push({ path, disposition, bytes });
	}
	options.afterDirectoryRead?.(decodeCandidatePath(relative));
	let after: Stats;
	let afterEntries: ReturnType<typeof readdirSync>;
	try {
		after = lstatSync(abs);
		afterEntries = readdirSync(abs, { withFileTypes: true, encoding: "buffer" });
	} catch {
		throw new ClassificationRefusal("candidate directory identity changed");
	}
	const names = (values: ReturnType<typeof readdirSync>) => values.map((entry) => entry.name).sort(Buffer.compare);
	const beforeNames = names(entries);
	const afterNames = names(afterEntries);
	if (
		!after.isDirectory() ||
		after.isSymbolicLink() ||
		!sameObject(before, after) ||
		!beforeNames.every((name, index) => name.equals(afterNames[index] ?? Buffer.alloc(0))) ||
		beforeNames.length !== afterNames.length
	)
		throw new ClassificationRefusal("candidate directory identity changed");
}

export function observeCandidates(sourceRoot: string, options: ObservationOptions = {}): ObservedCandidate[] {
	const root = Buffer.from(resolve(sourceRoot));
	const found: ObservedCandidate[] = [];
	for (const namespace of CANDIDATE_ROOTS) {
		const abs = appendPath(root, Buffer.from(namespace));
		let stats: Stats;
		try {
			stats = lstatSync(abs);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw new ClassificationRefusal("candidate namespace is unreadable");
		}
		if (!stats.isDirectory() || stats.isSymbolicLink())
			throw new ClassificationRefusal("candidate namespace is non-regular");
		walk(abs, Buffer.from(namespace), found, stats, options);
	}
	return found.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

export function renderMembershipSnapshot(members: readonly Membership[]): string {
	const sorted = [...members].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
	if (
		new Set(sorted.map((m) => m.path)).size !== sorted.length ||
		sorted.some((member) => {
			try {
				validateCandidatePath(member.path);
			} catch {
				return true;
			}
			return Object.keys(member).sort().join(",") !== "disposition,path" || !DISPOSITIONS.includes(member.disposition);
		})
	)
		throw new ClassificationRefusal("snapshot membership is not closed");
	return `${JSON.stringify({ schemaVersion: 1, members: sorted }, null, "\t")}\n`;
}

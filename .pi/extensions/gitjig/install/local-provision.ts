/**
 * Local filesystem adapter for verified per-clone provision (#130).
 * Warning-surface roster: EXEMPT — returns null on fixed provision failure and renders no operands.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { appendAuditRecord } from "../audit.ts";
import { observeOccupants, validateCandidatePath } from "./classifier.ts";
import type { Occupant } from "./plan.ts";
import type { ProvisionChange, ProvisionPlatform, ProvisionRequest, ProvisionSnapshot } from "./provision.ts";

function equalOccupant(left: Occupant, right: Occupant): boolean {
	return (
		left.kind === right.kind && (left.kind === "absent" || (right.kind === "bytes" && left.bytes.equals(right.bytes)))
	);
}

export class LocalProvisionPlatform implements ProvisionPlatform {
	readonly root: string;
	readonly stateRoot: string;
	private pending: { request: ProvisionRequest; snapshot: ProvisionSnapshot; excludePath: string } | null = null;
	constructor(targetRoot: string) {
		this.root = realpathSync(resolve(targetRoot));
		this.stateRoot = join(this.root, ".gitjig");
	}
	private git(args: string[]): string {
		return execFileSync("git", ["-C", this.root, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_TERMINAL_PROMPT: "0",
			},
		}).trim();
	}
	private appendExclusions(path: string, values: readonly string[]): Set<string> {
		const before = lstatSync(path);
		if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("unsafe exclude sink");
		let descriptor: number | undefined;
		try {
			descriptor = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
			const opened = fstatSync(descriptor);
			if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile())
				throw new Error("exclude sink changed");
			const existing = readFileSync(descriptor, "utf8");
			const lines = new Set(existing.split(/\r?\n/u));
			const additions = values.map((value) => `/${value}`).filter((line) => !lines.has(line));
			if (additions.length > 0)
				writeFileSync(
					descriptor,
					`${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${additions.join("\n")}\n`,
				);
			for (const addition of additions) lines.add(addition);
			const after = lstatSync(path);
			if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1)
				throw new Error("exclude sink changed");
			return lines;
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
		}
	}
	private ensureStateRoot(): void {
		if (!existsSync(this.stateRoot)) mkdirSync(this.stateRoot, { mode: 0o700 });
		const stats = lstatSync(this.stateRoot);
		if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("unsafe provision state root");
	}
	private ensureDirectory(relative: string): void {
		let current = this.root;
		for (const part of relative.split("/").slice(0, -1)) {
			current = join(current, part);
			if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
			const stats = lstatSync(current);
			if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("non-regular provision container");
		}
	}
	private recheck(change: ProvisionChange): void {
		const current = observeOccupants(this.root, [change.path]).get(change.path);
		if (!current || !equalOccupant(current, change.expected)) throw new Error("provision occupant changed");
	}
	private applyChange(change: ProvisionChange): void {
		validateCandidatePath(change.path);
		this.recheck(change);
		const destination = join(this.root, change.path);
		if (change.operation === "delete") {
			if (change.expected.kind === "absent") return;
			const tombstone = `${destination}.gitjig-retire-${randomBytes(8).toString("hex")}`;
			renameSync(destination, tombstone);
			rmSync(tombstone, { force: true });
			return;
		}
		if (!change.bytes) throw new Error("missing provision bytes");
		if (change.expected.kind === "bytes" && change.expected.bytes.equals(change.bytes)) return;
		this.ensureDirectory(change.path);
		const temporary = join(dirname(destination), `.gitjig-write-${randomBytes(8).toString("hex")}`);
		let descriptor: number | undefined;
		try {
			descriptor = openSync(
				temporary,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			writeFileSync(descriptor, change.bytes);
			closeSync(descriptor);
			descriptor = undefined;
			this.recheck(change);
			renameSync(temporary, destination);
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
			rmSync(temporary, { force: true });
		}
	}
	async apply(request: ProvisionRequest): Promise<ProvisionSnapshot | null> {
		try {
			const top = resolve(this.git(["rev-parse", "--show-toplevel"]));
			if (top !== this.root) return null;
			for (const change of request.changes) this.recheck(change);
			const excludePath = this.git(["rev-parse", "--git-path", "info/exclude"]);
			const absoluteExclude = resolve(this.root, excludePath);
			const afterExclude = this.appendExclusions(absoluteExclude, request.exclude);
			for (const change of request.changes) this.applyChange(change);
			execFileSync("bash", [join(this.root, ".githooks/bind_local_tier.sh")], {
				cwd: this.root,
				stdio: ["ignore", "pipe", "pipe"],
				env: { PATH: process.env.PATH, HOME: process.env.HOME },
			});
			this.ensureStateRoot();
			appendAuditRecord(this.stateRoot, {
				category: "provision",
				action: "apply",
				text: "carried state applied; final verification pending",
			});
			const snapshot = {
				occupants: observeOccupants(this.root, request.verifyPaths),
				excluded: request.exclude.filter((path) => afterExclude.has(`/${path}`)),
				hooksPath: this.git(["config", "--get", "core.hooksPath"]),
			};
			this.pending = { request, snapshot, excludePath: absoluteExclude };
			return snapshot;
		} catch {
			return null;
		}
	}
	async advanceInstalledPin(pinBytes: Buffer): Promise<Buffer | null> {
		try {
			if (!this.pending) return null;
			const { request, snapshot, excludePath } = this.pending;
			const current = observeOccupants(this.root, request.verifyPaths);
			for (const [path, expected] of snapshot.occupants) {
				const occupant = current.get(path);
				if (!occupant || !equalOccupant(occupant, expected)) return null;
			}
			const exclusions = new Set(readFileSync(excludePath, "utf8").split(/\r?\n/u));
			if (!request.exclude.every((path) => exclusions.has(`/${path}`))) return null;
			if (this.git(["config", "--get", "core.hooksPath"]) !== snapshot.hooksPath) return null;
			this.ensureStateRoot();
			const destination = join(this.stateRoot, "installed-pin.json");
			const temporary = join(this.stateRoot, `.installed-pin-${randomBytes(8).toString("hex")}`);
			writeFileSync(temporary, pinBytes, { mode: 0o600, flag: "wx" });
			renameSync(temporary, destination);
			const written = readFileSync(destination);
			appendAuditRecord(this.stateRoot, {
				category: "provision",
				action: "verified",
				text: "installed pin advanced after final verification",
			});
			this.pending = null;
			return written;
		} catch {
			return null;
		}
	}
}

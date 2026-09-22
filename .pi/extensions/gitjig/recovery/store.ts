/** Warning-surface roster: EXEMPT — this module writes closed JSON and returns booleans; it emits no free-text warning, throw, or operator surface. */
/** Durable exclusive one-use recovery allowance. */
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { STATE_DIR_MODE, STATE_FILE_MODE, STATE_PATH_GUARD_FLAGS, sinkRefusal } from "../audit.ts";

const KEY = /^[0-9a-f]{64}$/;
const CAP = 256 * 1024;

export type RecoveryRecord = {
	schemaVersion: 1;
	repositoryId: string;
	repositoryKey: string;
	lineageKey: string;
	lineageInput: string;
	pullRequestId: string;
	issueIds: string[];
	subjectHead: string;
	subjectBase: string;
	modes: unknown;
	profileSetVersion: 1;
	profileSetDigest: string;
	basis: unknown;
	state: "claimed" | "consumed";
	claimId: string;
	claimedAt: string;
	attempts: unknown[];
	candidateSet: "not-applicable" | "incomplete" | "complete";
	sequenceAuthority: "authoritative" | "consumed-failure" | "shadow-only";
	selectedIntervention: unknown | null;
	measurement: unknown | null;
	freshRuling: unknown | null;
	reentry: "none" | "plan" | "authorization" | null;
	nextGate: "author-repair" | "planning" | "ordinary-flow" | "park" | "authorization-handoff" | null;
	terminal: "pending" | "continue" | "handoff";
	terminalAt: string | null;
};

export type Claim = { path: string; record: RecoveryRecord };

function directory(path: string): boolean {
	try {
		mkdirSync(path, { recursive: true, mode: STATE_DIR_MODE });
		const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | STATE_PATH_GUARD_FLAGS);
		try {
			const stat = fstatSync(fd);
			return stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
}

function bytes(record: RecoveryRecord): Buffer | undefined {
	try {
		const value = Buffer.from(JSON.stringify(record), "utf8");
		return value.length <= CAP ? value : undefined;
	} catch {
		return undefined;
	}
}

export function claimAllowance(
	stateRoot: string,
	repositoryKey: string,
	lineageKey: string,
	record: RecoveryRecord,
): Claim | undefined {
	if (
		!isAbsolute(stateRoot) ||
		!KEY.test(repositoryKey) ||
		!KEY.test(lineageKey) ||
		record.state !== "claimed" ||
		record.terminal !== "pending"
	)
		return undefined;
	const root = join(stateRoot, "recovery");
	const repo = join(root, repositoryKey);
	if (!directory(root) || !directory(repo)) return undefined;
	const path = join(repo, `${lineageKey}.json`);
	const value = bytes(record);
	if (value === undefined) return undefined;
	let fd: number | undefined;
	try {
		fd = openSync(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | STATE_PATH_GUARD_FLAGS,
			STATE_FILE_MODE,
		);
		if (sinkRefusal(fstatSync(fd), path) !== undefined) return undefined;
		fchmodSync(fd, STATE_FILE_MODE);
		writeFileSync(fd, value);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		const parent = openSync(repo, constants.O_RDONLY | constants.O_DIRECTORY | STATE_PATH_GUARD_FLAGS);
		try {
			fsyncSync(parent);
		} finally {
			closeSync(parent);
		}
		return { path, record: structuredClone(record) };
	} catch {
		// A partial final file is deliberately retained as a permanent tombstone.
		return undefined;
	} finally {
		if (fd !== undefined)
			try {
				closeSync(fd);
			} catch {}
	}
}

export function finalizeAllowance(claim: Claim, consumed: RecoveryRecord): boolean {
	if (
		consumed.state !== "consumed" ||
		consumed.terminal === "pending" ||
		consumed.claimId !== claim.record.claimId ||
		consumed.lineageKey !== claim.record.lineageKey
	)
		return false;
	const value = bytes(consumed);
	if (value === undefined) return false;
	let existing: Buffer;
	try {
		const fd = openSync(claim.path, constants.O_RDONLY | STATE_PATH_GUARD_FLAGS);
		try {
			const stat = fstatSync(fd);
			if (sinkRefusal(stat, claim.path) !== undefined || stat.size > CAP) return false;
			existing = readFileSync(fd);
		} finally {
			closeSync(fd);
		}
		if (!existing.equals(bytes(claim.record) ?? Buffer.alloc(0))) return false;
	} catch {
		return false;
	}
	const temp = `${claim.path}.${claim.record.claimId}.tmp`;
	let fd: number | undefined;
	let created = false;
	try {
		fd = openSync(
			temp,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | STATE_PATH_GUARD_FLAGS,
			STATE_FILE_MODE,
		);
		created = true;
		writeFileSync(fd, value);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temp, claim.path);
		const parent = openSync(dirname(claim.path), constants.O_RDONLY | constants.O_DIRECTORY | STATE_PATH_GUARD_FLAGS);
		try {
			fsyncSync(parent);
		} finally {
			closeSync(parent);
		}
		return true;
	} catch {
		return false;
	} finally {
		if (fd !== undefined)
			try {
				closeSync(fd);
			} catch {}
		if (created)
			try {
				rmSync(temp, { force: true });
			} catch {}
	}
}

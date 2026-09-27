/** Warning-surface roster: EXEMPT — this module emits no operator-facing warning text. */
import { createHash } from "node:crypto";
import type { ReviewSubject } from "../review/subject.ts";

const REPOSITORY_DOMAIN = Buffer.from("gitjig-recovery-repository-path:v2\0", "ascii");
const CHANGE_DOMAIN = Buffer.from("gitjig-recovery-change-path:v2\0", "ascii");
const MAX_NODE_BYTES = 1_024;

export type ChangeKeyOperands = {
	repositoryNodeId: string;
	subject: { kind: "issues"; issueNodeIds: readonly string[] } | { kind: "pull-request"; pullRequestNodeId: string };
};

export type AllowancePathEncoding = {
	operands: ChangeKeyOperands;
	repoHash: string;
	keyHash: string;
	leaf: string;
};

/** Validate the canonical operands carried by a durable record, not its path encoding. */
export function admitChangeKeyOperands(value: unknown): value is ChangeKeyOperands {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const key = value as Record<string, unknown>;
	if (Object.keys(key).length !== 2 || !Object.hasOwn(key, "repositoryNodeId") || !Object.hasOwn(key, "subject"))
		return false;
	if (typeof key.repositoryNodeId !== "string" || nodeBytes(key.repositoryNodeId) === undefined) return false;
	if (key.subject === null || typeof key.subject !== "object" || Array.isArray(key.subject)) return false;
	const subject = key.subject as Record<string, unknown>;
	if (subject.kind === "pull-request")
		return (
			Object.keys(subject).length === 2 &&
			Object.hasOwn(subject, "pullRequestNodeId") &&
			typeof subject.pullRequestNodeId === "string" &&
			nodeBytes(subject.pullRequestNodeId) !== undefined
		);
	if (subject.kind !== "issues" || Object.keys(subject).length !== 2 || !Array.isArray(subject.issueNodeIds))
		return false;
	const ids = subject.issueNodeIds;
	if (ids.length === 0 || ids.length > 10_000) return false;
	let previous: Buffer | undefined;
	for (const id of ids) {
		const current = typeof id === "string" ? nodeBytes(id) : undefined;
		if (current === undefined || (previous !== undefined && Buffer.compare(previous, current) >= 0)) return false;
		previous = current;
	}
	return true;
}

function nodeBytes(value: string): Buffer | undefined {
	if (value.length === 0) return undefined;
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return undefined;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return undefined;
	}
	const bytes = Buffer.from(value, "utf8");
	return bytes.length > 0 && bytes.length <= MAX_NODE_BYTES ? bytes : undefined;
}

function frame(bytes: Buffer): Buffer {
	const length = Buffer.allocUnsafe(4);
	length.writeUInt32BE(bytes.length);
	return Buffer.concat([length, bytes]);
}

function compareBytes(left: Buffer, right: Buffer): number {
	return Buffer.compare(left, right);
}

function digest(parts: readonly Buffer[]): string {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(part);
	return hash.digest("hex");
}

export function deriveAllowancePathEncoding(subject: ReviewSubject): AllowancePathEncoding | undefined {
	const repository = nodeBytes(subject.context.repository.id);
	if (repository === undefined) return undefined;
	const activated = new Set(subject.activation.map((entry) => entry.issueId));
	const closing = subject.context.pullRequest.closingIssues;
	if (activated.size !== subject.activation.length || activated.size !== closing.length) return undefined;
	for (const issue of closing)
		if (!activated.has(issue.id) || issue.repositoryId !== subject.context.repository.id) return undefined;

	let operands: ChangeKeyOperands;
	let keyInput: Buffer;
	if (closing.length === 0) {
		const pullRequest = nodeBytes(subject.context.pullRequest.id);
		if (pullRequest === undefined) return undefined;
		operands = {
			repositoryNodeId: subject.context.repository.id,
			subject: { kind: "pull-request", pullRequestNodeId: subject.context.pullRequest.id },
		};
		keyInput = Buffer.concat([Buffer.from([0x02]), frame(pullRequest)]);
	} else {
		const issueBytes: { id: string; bytes: Buffer }[] = [];
		for (const issue of closing) {
			const bytes = nodeBytes(issue.id);
			if (bytes === undefined) return undefined;
			issueBytes.push({ id: issue.id, bytes });
		}
		issueBytes.sort((left, right) => compareBytes(left.bytes, right.bytes));
		for (let index = 1; index < issueBytes.length; index += 1) {
			const previous = issueBytes[index - 1];
			const current = issueBytes[index];
			if (previous === undefined || current === undefined || compareBytes(previous.bytes, current.bytes) === 0)
				return undefined;
		}
		const count = Buffer.allocUnsafe(4);
		count.writeUInt32BE(issueBytes.length);
		operands = {
			repositoryNodeId: subject.context.repository.id,
			subject: { kind: "issues", issueNodeIds: issueBytes.map((entry) => entry.id) },
		};
		keyInput = Buffer.concat([Buffer.from([0x01]), count, ...issueBytes.map((entry) => frame(entry.bytes))]);
	}
	const repoHash = digest([REPOSITORY_DOMAIN, frame(repository)]);
	const keyHash = digest([CHANGE_DOMAIN, keyInput]);
	const leaf = `r2-${repoHash}-${keyHash}.json`;
	if (Buffer.byteLength(leaf, "ascii") !== 137) return undefined;
	return { operands, repoHash, keyHash, leaf };
}

/** Warning-surface roster: EXEMPT — this module returns data and emits no warning, throw, record, or operator-facing text. */
/** Attested recovery lineage and canonical digest helpers. */
import { createHash } from "node:crypto";
import type { ReviewSubject } from "../review/subject.ts";

const CONTROL = (value: string): boolean =>
	[...value].some((char) => {
		const code = char.codePointAt(0) ?? 0;
		return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
	});
const HEX = /^[0-9a-f]{64}$/;

function admittedText(value: string): boolean {
	return value.length > 0 && value === value.normalize("NFC") && !CONTROL(value);
}

export function canonicalJson(value: unknown): string | undefined {
	const visit = (entry: unknown): string | undefined => {
		if (entry === null) return "null";
		if (typeof entry === "string") return admittedText(entry) || entry === "" ? JSON.stringify(entry) : undefined;
		if (typeof entry === "boolean") return entry ? "true" : "false";
		if (typeof entry === "number") return Number.isFinite(entry) ? JSON.stringify(entry) : undefined;
		if (Array.isArray(entry)) {
			const values = entry.map(visit);
			return values.every((item) => item !== undefined) ? `[${values.join(",")}]` : undefined;
		}
		if (typeof entry !== "object" || entry === undefined) return undefined;
		const object = entry as Record<string, unknown>;
		const keys = Object.keys(object).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
		const values: string[] = [];
		for (const key of keys) {
			if (!admittedText(key)) return undefined;
			const value = visit(object[key]);
			if (value === undefined) return undefined;
			values.push(`${JSON.stringify(key)}:${value}`);
		}
		return `{${values.join(",")}}`;
	};
	return visit(value);
}

export function domainDigest(domain: string, value: unknown): string | undefined {
	const bytes = canonicalJson(value);
	if (bytes === undefined || !/^[a-z0-9-]+:v1$/.test(domain)) return undefined;
	return createHash("sha256").update(`${domain}\n${bytes}`, "utf8").digest("hex");
}

export function contentDigest(text: string): string | undefined {
	if (!admittedText(text)) return undefined;
	return createHash("sha256")
		.update(`gitjig-recovery-content:v1\n${text.normalize("NFC")}`, "utf8")
		.digest("hex");
}

export type Lineage = { repositoryId: string; issueIds: readonly string[]; input: string; key: string };

export function deriveLineage(subject: ReviewSubject): Lineage | undefined {
	const repositoryId = subject.context.repository.id;
	const pullRequestId = subject.context.pullRequest.id;
	if (!admittedText(repositoryId) || !admittedText(pullRequestId)) return undefined;
	const ids = subject.context.pullRequest.closingIssues.map((issue) => issue.id);
	if (ids.some((id) => !admittedText(id)) || new Set(ids).size !== ids.length) return undefined;
	const issueIds = [...ids].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
	if (
		subject.activation.length !== issueIds.length ||
		new Set(subject.activation.map((entry) => entry.issueId)).size !== issueIds.length ||
		subject.activation.some((entry) => !issueIds.includes(entry.issueId))
	)
		return undefined;
	const value = {
		schemaVersion: 1,
		repositoryId,
		subject: issueIds.length === 0 ? { kind: "pull-request", pullRequestId } : { kind: "issues", issueIds },
	};
	const input = canonicalJson(value);
	if (input === undefined) return undefined;
	const key = createHash("sha256").update(`gitjig-recovery-lineage:v1\n${input}`, "utf8").digest("hex");
	return HEX.test(key) ? Object.freeze({ repositoryId, issueIds: Object.freeze(issueIds), input, key }) : undefined;
}

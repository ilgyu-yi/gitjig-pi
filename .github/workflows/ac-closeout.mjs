/**
 * Self-standing, handed-over ac-closeout grammar and predicate.
 * No ambient repository state enters these pure functions.
 */

export const AC_CLOSEOUT_MARKER = "<!-- ac-closeout-record: v1 -->";
const HEADING = /^#{1,6}[ \t]+acceptance criteria[ \t]*$/i;
const ANY_HEADING = /^#{1,6}[ \t]/;
const ITEM = /^(?:[-*+]|\d{1,3}[.)])[ \t]+(\S.*?)[ \t]*$/;
const CHECKBOX = /^\[([ xX])\][ \t]+(\S.*)$/;
const OTHER_BOX = /^\[[^\]]*\]/;
const OID = /^[0-9a-f]{40}$/;

/** @param {any} value @param {readonly string[]} keys */
function object(value, keys) {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		Object.keys(value).every((key) => keys.includes(key))
	);
}
/** @param {any} value */
function text(value) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		![...value].some((character) => {
			const point = character.codePointAt(0) ?? 0;
			return point < 32 || (point >= 127 && point <= 159) || point === 0x2028 || point === 0x2029;
		}) &&
		value === value.normalize("NFC")
	);
}
/** @param {any} value */
function positive(value) {
	return Number.isSafeInteger(value) && value > 0;
}

/** Preserve the existing full-item, Issue-prefixed, EMPTY-never-absent derivation. */
/** @param {readonly any[]} issues @returns {string[]} */
export function criteriaFromClosingIssues(issues) {
	const criteria = [];
	for (const issue of issues) {
		let inside = false;
		for (const raw of issue.body.split("\n")) {
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			if (ANY_HEADING.test(line)) {
				inside = HEADING.test(line);
				continue;
			}
			if (!inside) continue;
			const item = ITEM.exec(line);
			if (item) criteria.push(`#${issue.number}: ${item[1]}`);
		}
	}
	return criteria;
}

/** Closeout-only identity derivation; empty or malformed populations refuse. */
/** @param {any} issue */
export function closeoutCriteria(issue) {
	if (
		!object(issue, ["id", "number", "body"]) ||
		!text(issue.id) ||
		!positive(issue.number) ||
		typeof issue.body !== "string"
	)
		return { ok: false, arm: "issue-malformed" };
	const criteria = [];
	let inside = false;
	for (const raw of issue.body.split("\n")) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (ANY_HEADING.test(line)) {
			inside = HEADING.test(line);
			continue;
		}
		if (!inside) continue;
		const item = ITEM.exec(line);
		if (!item) continue;
		const checkbox = CHECKBOX.exec(item[1]);
		if (!checkbox)
			return { ok: false, arm: OTHER_BOX.test(item[1]) ? "criterion-marker-invalid" : "criterion-marker-absent" };
		const identity = `#${issue.number}: ${checkbox[2]}`;
		if (!text(identity)) return { ok: false, arm: "criterion-malformed" };
		criteria.push(identity);
	}
	if (criteria.length === 0) return { ok: false, arm: "criteria-absent" };
	if (new Set(criteria).size !== criteria.length) return { ok: false, arm: "criteria-duplicate" };
	return { ok: true, criteria };
}

/** @param {unknown} body */
export function parseCloseoutRecord(body) {
	if (typeof body !== "string" || !body.startsWith(`${AC_CLOSEOUT_MARKER}\n`)) return undefined;
	if (body.indexOf(AC_CLOSEOUT_MARKER, AC_CLOSEOUT_MARKER.length) !== -1) return undefined;
	try {
		return JSON.parse(body.slice(AC_CLOSEOUT_MARKER.length + 1));
	} catch {
		return undefined;
	}
}

/** @param {any} value */
export function admitCloseoutRecord(value) {
	if (
		!object(value, [
			"schemaVersion",
			"repositoryId",
			"issueId",
			"issueNumber",
			"pullRequestId",
			"pullRequestNumber",
			"headSha",
			"baseSha",
			"writerId",
			"observedAt",
			"criteria",
		])
	)
		return false;
	if (
		value.schemaVersion !== 1 ||
		!text(value.repositoryId) ||
		!text(value.issueId) ||
		!positive(value.issueNumber) ||
		!text(value.pullRequestId) ||
		!positive(value.pullRequestNumber) ||
		!OID.test(value.headSha) ||
		!OID.test(value.baseSha) ||
		!text(value.writerId) ||
		!text(value.observedAt) ||
		!Number.isFinite(Date.parse(value.observedAt)) ||
		!Array.isArray(value.criteria) ||
		value.criteria.length === 0
	)
		return false;
	return value.criteria.every(
		/** @param {any} entry */ (entry) =>
			object(
				entry,
				entry?.disposition === "checked" ? ["identity", "disposition"] : ["identity", "disposition", "reason"],
			) &&
			text(entry.identity) &&
			(entry.disposition === "checked" ||
				(entry.disposition === "na" && text(entry.reason) && !entry.reason.includes("\n"))),
	);
}

/** @param {unknown} body */
export function prChecklistTerminal(body) {
	if (typeof body !== "string") return false;
	let fence;
	for (const line of body.split("\n")) {
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker && (fence === undefined || (marker[0] === fence[0] && marker.length >= fence.length))) {
			fence = fence === undefined ? marker : undefined;
			continue;
		}
		if (fence !== undefined || /^ {0,3}>/.test(line)) continue;
		const match = /^\s*(?:[-*+]|\d{1,3}[.)])\s+\[([^\]]*)\](.*)$/.exec(line);
		if (!match) continue;
		if (/^[xX]$/.test(match[1])) continue;
		if (match[1] === "~" && match[2].startsWith(" N/A — ") && text(match[2].slice(" N/A — ".length))) continue;
		return false;
	}
	return fence === undefined;
}

/** Evaluate one fully attested PR/Issue/comment snapshot. */
/** @param {any} input */
export function evaluateAcCloseout(input) {
	if (
		!object(input, [
			"repositoryId",
			"pullRequestId",
			"pullRequestNumber",
			"headSha",
			"baseSha",
			"pullRequestBody",
			"closingIssues",
		]) ||
		!text(input.repositoryId) ||
		!text(input.pullRequestId) ||
		!positive(input.pullRequestNumber) ||
		!OID.test(input.headSha) ||
		!OID.test(input.baseSha) ||
		typeof input.pullRequestBody !== "string" ||
		!Array.isArray(input.closingIssues)
	)
		return { ok: false, arm: "subject-malformed" };
	if (input.closingIssues.length === 0) return { ok: false, arm: "closing-issues-absent" };
	if (!prChecklistTerminal(input.pullRequestBody)) return { ok: false, arm: "pr-checklist-unresolved" };
	for (const issue of input.closingIssues) {
		if (!object(issue, ["id", "number", "body", "comments"]) || !Array.isArray(issue.comments))
			return { ok: false, arm: "issue-population-malformed" };
		const derived = closeoutCriteria({ id: issue.id, number: issue.number, body: issue.body });
		if (!derived.ok) return derived;
		const marked = issue.comments.filter(
			/** @param {any} comment */ (comment) =>
				typeof comment?.body === "string" && comment.body.includes(AC_CLOSEOUT_MARKER),
		);
		if (marked.length === 0) return { ok: false, arm: "evidence-absent" };
		if (marked.length !== 1) return { ok: false, arm: "evidence-ambiguous" };
		const comment = marked[0];
		const record = parseCloseoutRecord(comment.body);
		if (!admitCloseoutRecord(record)) return { ok: false, arm: "evidence-malformed" };
		if (comment.createdAt !== comment.updatedAt) return { ok: false, arm: "evidence-edited" };
		if (!text(comment.authorId) || record.writerId !== comment.authorId) return { ok: false, arm: "writer-unattested" };
		if (
			record.repositoryId !== input.repositoryId ||
			record.issueId !== issue.id ||
			record.issueNumber !== issue.number ||
			record.pullRequestId !== input.pullRequestId ||
			record.pullRequestNumber !== input.pullRequestNumber
		)
			return { ok: false, arm: "evidence-copied" };
		if (record.headSha !== input.headSha || record.baseSha !== input.baseSha)
			return { ok: false, arm: "evidence-stale-subject" };
		if (
			JSON.stringify(record.criteria.map(/** @param {any} entry */ (entry) => entry.identity)) !==
			JSON.stringify(derived.criteria)
		)
			return { ok: false, arm: "evidence-stale-criteria" };
	}
	return { ok: true, arm: "pass" };
}

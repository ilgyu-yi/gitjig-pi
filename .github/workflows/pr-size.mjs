#!/usr/bin/env node
// gitjig: source-only
/*
 * The `pr-size` reporting check (SPEC §1.11, #408). It measures a pull
 * request to the default branch by the platform's own per-file counts and
 * reports success or failure on its head. It reads no pull-request code: every
 * input is a platform read, so it is safe under `pull_request_target`.
 *
 * Scope, stated: this check is source-only (§4.1): its bound, basis and
 * exclusions are this repository's, so it ships to no adopter. It governs
 * pull requests to the default branch and to `*-maintenance` lines, the same
 * set its workflow's branch filter names.
 */
import { readFile } from "node:fs/promises";

/** SPEC §1.11's bound, in changed lines. */
export const THRESHOLD = 2400;

/** The one owner of §1.11's exclusions. */
export const EXCLUSIONS = Object.freeze({
	/** A file excluded whole: its generator writes all of it. */
	files: Object.freeze(["test/fixtures/adopter-membership.snapshot.json"]),
	/** A region excluded between its markers: its generator writes only that. */
	regions: Object.freeze([Object.freeze({ path: "SPEC.md", start: "<!-- TOC START", end: "<!-- TOC END" })]),
});

export const ESCAPE_MARKER = "<!-- gitjig-pr-size-escape: v1 -->";

/** The permissions the platform reports for an account that can write. */
export const WRITER_ROLES = Object.freeze(["ADMIN", "MAINTAIN", "WRITE"]);

/**
 * The region's inner line numbers (1-based, exclusive of both markers) in one
 * version of a file, or null when the version has neither marker.
 * @param {string | null} text
 * @param {{start:string,end:string}} region
 * @returns {{after:number,before:number} | null}
 */
export function regionBounds(text, region) {
	if (text === null) return null;
	const lines = text.split("\n");
	const starts = lines.flatMap((line, index) => (line.startsWith(region.start) ? [index + 1] : []));
	const ends = lines.flatMap((line, index) => (line.startsWith(region.end) ? [index + 1] : []));
	if (starts.length === 0 && ends.length === 0) return null;
	if (starts.length !== 1 || ends.length !== 1 || (starts[0] ?? 0) >= (ends[0] ?? 0))
		throw new Error("region-malformed");
	return { after: starts[0] ?? 0, before: ends[0] ?? 0 };
}

/**
 * Changed lines of a unified-diff patch that fall inside the region: removed
 * lines by their old line number, added lines by their new one.
 * @param {string} patch
 * @param {{after:number,before:number} | null} base
 * @param {{after:number,before:number} | null} head
 */
export function regionChangedLines(patch, base, head) {
	let oldLine = 0;
	let newLine = 0;
	let inside = 0;
	let hunks = 0;
	for (const line of patch.split("\n")) {
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			hunks += 1;
			continue;
		}
		if (hunks === 0) throw new Error("diff-unavailable");
		if (line.startsWith("\\")) continue;
		if (line.startsWith("-")) {
			if (base && oldLine > base.after && oldLine < base.before) inside += 1;
			oldLine += 1;
		} else if (line.startsWith("+")) {
			if (head && newLine > head.after && newLine < head.before) inside += 1;
			newLine += 1;
		} else {
			oldLine += 1;
			newLine += 1;
		}
	}
	return inside;
}

/**
 * The measured quantity: every listed file's additions plus deletions, less
 * the excluded files and the excluded regions' changed lines.
 * @param {{files:any[],changedFiles:number,regionText:(path:string,side:"base"|"head")=>Promise<string|null>}} input
 */
export async function measure({ files, changedFiles, regionText }) {
	if (!Number.isSafeInteger(changedFiles) || files.length !== changedFiles) throw new Error("listing-truncated");
	let total = 0;
	for (const file of files) {
		const added = file?.additions;
		const deleted = file?.deletions;
		if (typeof file?.filename !== "string" || !Number.isSafeInteger(added) || !Number.isSafeInteger(deleted))
			throw new Error("listing-malformed");
		if (EXCLUSIONS.files.includes(file.filename)) continue;
		total += added + deleted;
		const region = EXCLUSIONS.regions.find((candidate) => candidate.path === file.filename);
		if (!region || added + deleted === 0) continue;
		if (typeof file.patch !== "string") throw new Error("diff-unavailable");
		const base = file.status === "added" ? null : regionBounds(await regionText(file.filename, "base"), region);
		const head = file.status === "removed" ? null : regionBounds(await regionText(file.filename, "head"), region);
		total -= regionChangedLines(file.patch, base, head);
	}
	return total;
}

/**
 * Decide one pull request at one head. Over the bound, an escape is examined
 * and honoured only by §1.11's full conjunction; anything else names the
 * refusing arm.
 * @param {{number:number,head:string,measured:number,records:{id:number,body:string,permission:string|undefined}[]}} input
 * @returns {{ok:boolean,arm:string,record?:number}}
 */
export function decide({ number, head, measured, records }) {
	if (measured <= THRESHOLD) return { ok: true, arm: "within-bound" };
	const candidates = records.filter((record) => record.body.startsWith(ESCAPE_MARKER));
	if (candidates.length === 0) return { ok: false, arm: "over-bound" };
	// Only a writer's comment is a record (§1.11): another account's marker
	// comment is ignored, so it can neither honour nor refuse a writer's record.
	const written = candidates.filter((record) => WRITER_ROLES.includes(String(record.permission)));
	if (written.length === 0) return { ok: false, arm: "escape-unauthorized" };
	/** @type {{id:number,value:any}[]} */
	const parsed = [];
	for (const record of written) {
		const value = parseEscape(record.body);
		if (value === undefined) return { ok: false, arm: "escape-malformed" };
		parsed.push({ id: record.id, value });
	}
	const current = parsed.filter((record) => record.value.pr === number && record.value.head === head);
	if (current.length === 0)
		return {
			ok: false,
			arm: parsed.some((record) => record.value.pr === number) ? "escape-stale" : "escape-other-pull",
		};
	if (current.length > 1) return { ok: false, arm: "escape-duplicate" };
	const record = /** @type {{id:number,value:any}} */ (current[0]);
	if (record.value.measured !== measured) return { ok: false, arm: "escape-value-mismatch" };
	return { ok: true, arm: "escape-honoured", record: record.id };
}

/**
 * The record's JSON, which follows the marker: exactly the four fields, or
 * undefined.
 * @param {string} body
 */
export function parseEscape(body) {
	let value;
	try {
		value = JSON.parse(
			body
				.slice(ESCAPE_MARKER.length)
				.trim()
				.replace(/^```json\n|\n```$/g, ""),
		);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	if (Object.keys(value).sort().join(",") !== "head,measured,pr,reason") return undefined;
	if (!Number.isSafeInteger(value.pr) || value.pr < 1) return undefined;
	if (typeof value.head !== "string" || !/^[0-9a-f]{40}$/.test(value.head)) return undefined;
	if (!Number.isSafeInteger(value.measured) || value.measured < 0) return undefined;
	if (typeof value.reason !== "string" || value.reason.trim() === "") return undefined;
	return value;
}

/**
 * Whether a base branch is one the check governs: the default branch or a
 * maintenance line.
 * @param {string} ref @param {unknown} defaultBranch
 */
export function governedBase(ref, defaultBranch) {
	return ref === defaultBranch || /^[^/]*-maintenance$/.test(ref);
}

/** @typedef {(path:string, init?:RequestInit)=>Promise<any>} Api */

/** @param {Api} api @param {string} path */
async function readPaginated(api, path) {
	const all = [];
	for (let page = 1; ; page += 1) {
		const separator = path.includes("?") ? "&" : "?";
		const batch = await api(`${path}${separator}per_page=100&page=${page}`);
		if (!Array.isArray(batch)) throw new Error("listing-malformed");
		all.push(...batch);
		if (batch.length < 100) return all;
	}
}

/**
 * Measure and decide one pull request from platform reads.
 * @param {{api:Api,raw:(path:string)=>Promise<string|null>,number:number}} input
 * @returns {Promise<{head:string|undefined,result:{ok:boolean,arm:string,record?:number},measured?:number}>}
 */
export async function evaluate({ api, raw, number }) {
	const pull = await api(`/pulls/${number}`);
	const base = pull?.base?.sha;
	// Governance is decided only from a complete base: a missing ref or default
	// branch is an unknown base, never an ungoverned one.
	const baseRef = pull?.base?.ref;
	const defaultBranch = pull?.base?.repo?.default_branch;
	if (typeof baseRef !== "string" || typeof defaultBranch !== "string")
		return { head: undefined, result: { ok: false, arm: "base-unknown" } };
	if (!governedBase(baseRef, defaultBranch))
		return { head: pull?.head?.sha, result: { ok: true, arm: "not-governed" } };
	const head = pull?.head?.sha;
	if (typeof head !== "string" || !/^[0-9a-f]{40}$/.test(head))
		return { head: undefined, result: { ok: false, arm: "head-unknown" } };
	if (typeof base !== "string" || !/^[0-9a-f]{40}$/.test(base))
		return { head, result: { ok: false, arm: "base-unknown" } };
	// The platform's patch runs from the merge base, so the base-side region is
	// located in that version, not in the base branch's tip.
	const mergeBase = (await api(`/compare/${base}...${head}`))?.merge_base_commit?.sha;
	if (typeof mergeBase !== "string" || !/^[0-9a-f]{40}$/.test(mergeBase))
		return { head, result: { ok: false, arm: "merge-base-unknown" } };
	let measured;
	try {
		measured = await measure({
			files: await readPaginated(api, `/pulls/${number}/files`),
			changedFiles: pull.changed_files,
			regionText: (path, side) =>
				raw(`/contents/${encodeURIComponent(path)}?ref=${side === "base" ? mergeBase : head}`),
		});
	} catch (error) {
		const arm = error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : "lookup-unavailable";
		return { head, result: { ok: false, arm } };
	}
	/** @type {{id:number,body:string,permission:string|undefined}[]} */
	const records = [];
	if (measured > THRESHOLD) {
		for (const comment of await readPaginated(api, `/issues/${number}/comments`)) {
			if (typeof comment?.body !== "string" || !comment.body.startsWith(ESCAPE_MARKER)) continue;
			const login = comment?.user?.login;
			const authority =
				typeof login === "string" ? await api(`/collaborators/${encodeURIComponent(login)}/permission`) : undefined;
			const role = typeof authority?.role_name === "string" ? authority.role_name.toUpperCase() : undefined;
			// A custom repository role carries its own name; its write level is the
			// permission field's.
			const level = typeof authority?.permission === "string" ? authority.permission.toLowerCase() : "";
			const permission = level === "admin" || level === "write" ? "WRITE" : role;
			records.push({ id: Number(comment.id), body: comment.body, permission });
		}
	}
	const result = decide({ number, head, measured, records });
	const after = await api(`/pulls/${number}`);
	if (after?.head?.sha !== head || after?.base?.sha !== base)
		return { head, measured, result: { ok: false, arm: "subject-changed" } };
	return { head, measured, result };
}

/**
 * The check output: the measured value and the threshold, and the honoured
 * record or the refusing arm.
 * @param {number | undefined} measured @param {{arm:string,record?:number}} result
 */
export function summary(measured, result) {
	const value = measured === undefined ? "not measured" : `${measured} changed lines`;
	const tail = result.record === undefined ? `arm: ${result.arm}` : `honoured escape record: comment ${result.record}`;
	return `${value}; threshold ${THRESHOLD}; ${tail}`;
}

/**
 * Evaluate the event's pull request and post its check run. Returns the
 * posted body, or undefined when the event addresses no governed pull request.
 * Any evaluation failure posts a failure: no measurement is no pass.
 * @param {{event:any,api:Api,raw:(path:string)=>Promise<string|null>}} input
 */
export async function report({ event, api, raw }) {
	const number = event.pull_request?.number ?? (event.issue?.pull_request ? event.issue.number : undefined);
	if (!Number.isSafeInteger(number)) return undefined;
	// A comment can address any pull request; the check governs those to the
	// default branch and maintenance lines only, as the workflow's own filter does.
	const baseRef = event.pull_request?.base?.ref;
	const defaultBranch = event.repository?.default_branch;
	if (typeof baseRef === "string" && typeof defaultBranch === "string" && !governedBase(baseRef, defaultBranch))
		return undefined;
	let outcome;
	try {
		outcome = await evaluate({ api, raw, number });
	} catch {
		outcome = { head: undefined, measured: undefined, result: { ok: false, arm: "lookup-unavailable" } };
	}
	if (outcome.result.arm === "not-governed") return undefined;
	const head = outcome.head ?? (await api(`/pulls/${number}`))?.head?.sha;
	if (typeof head !== "string") throw new Error("pr-size: head unavailable");
	const body = {
		name: "pr-size",
		head_sha: head,
		status: "completed",
		conclusion: outcome.result.ok ? "success" : "failure",
		output: {
			title: outcome.result.ok ? "Within the size bound" : "Size bound refused",
			summary: summary(outcome.measured, outcome.result),
		},
	};
	await api("/check-runs", { method: "POST", body: JSON.stringify(body) });
	return body;
}

async function main() {
	const token = process.env.GITHUB_TOKEN;
	const repository = process.env.GITHUB_REPOSITORY;
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!token || !repository || !eventPath) throw new Error("pr-size: event context unavailable");
	const event = JSON.parse(await readFile(eventPath, "utf8"));
	const headers = {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	/** @type {Api} */
	const api = async (path, init = {}) => {
		const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
			...init,
			headers: { ...headers, ...(init.headers ?? {}) },
		});
		if (!response.ok) throw new Error(`pr-size: API ${response.status}`);
		return response.status === 204 ? undefined : response.json();
	};
	/** @param {string} path */
	const raw = async (path) => {
		const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
			headers: { ...headers, Accept: "application/vnd.github.raw" },
		});
		if (response.status === 404) return null;
		if (!response.ok) throw new Error("lookup-unavailable");
		return response.text();
	};
	await report({ event, api, raw });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href)
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});

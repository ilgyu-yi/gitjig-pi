#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OID = /^[0-9a-f]{40}$/;

export class HistoryShapeRefusal extends Error {
	/** @param {string} cause */
	constructor(cause) {
		super(`history-shape refused: ${cause}`);
	}
}

/** @param {string[]} args @param {string} [cwd] */
function git(args, cwd = process.cwd()) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0 || result.signal || result.error) throw new HistoryShapeRefusal("git history is unreadable");
	return result.stdout.trim();
}

/** @param {{baseSha: string, headSha: string, cwd?: string}} operands */
export function evaluateHistoryShape({ baseSha, headSha, cwd = process.cwd() }) {
	if (!OID.test(baseSha) || !OID.test(headSha)) throw new HistoryShapeRefusal("invalid operand");
	if (git(["rev-parse", "--is-shallow-repository"], cwd) !== "false")
		throw new HistoryShapeRefusal("history is shallow");
	for (const oid of [baseSha, headSha]) {
		if (git(["cat-file", "-t", oid], cwd) !== "commit") throw new HistoryShapeRefusal("operand is not a commit");
	}
	const mergeBase = git(["merge-base", baseSha, headSha], cwd);
	if (!OID.test(mergeBase)) throw new HistoryShapeRefusal("merge base is absent or ambiguous");
	const output = git(["rev-list", "--min-parents=2", `${mergeBase}..${headSha}`], cwd);
	const mergeCommits = output === "" ? [] : output.split("\n");
	if (mergeCommits.some((oid) => !OID.test(oid))) throw new HistoryShapeRefusal("merge population is malformed");
	return { mergeBase, mergeCommits, pass: mergeCommits.length === 0 };
}

/** @param {string} path @param {string} token @param {string} repository @param {string} apiRoot */
async function api(path, token, repository, apiRoot) {
	const response = await fetch(`${apiRoot}/repos/${repository}/${path}`, {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (!response.ok) throw new HistoryShapeRefusal("platform read failed");
	return response.json();
}

/** @param {any} pull @param {string} repositoryId @param {string} repository */
function pullOperands(pull, repositoryId, repository) {
	const baseSha = pull?.base?.sha;
	const headSha = pull?.head?.sha;
	const baseRef = pull?.base?.ref;
	if (
		!Number.isSafeInteger(pull?.number) ||
		String(pull?.base?.repo?.id) !== repositoryId ||
		pull?.base?.repo?.full_name !== repository ||
		pull?.state !== "open" ||
		typeof pull?.head?.repo?.full_name !== "string" ||
		!OID.test(baseSha) ||
		!OID.test(headSha) ||
		typeof baseRef !== "string" ||
		baseRef.length === 0
	)
		throw new HistoryShapeRefusal("pull request identity is ambiguous");
	return { number: pull.number, baseSha, headSha, baseRef };
}

/** @param {NodeJS.ProcessEnv} [environment] */
export async function runHistoryShape(environment = process.env) {
	const token = environment.GITHUB_TOKEN;
	const repository = environment.GITHUB_REPOSITORY;
	const repositoryId = environment.GITHUB_REPOSITORY_ID;
	const eventPath = environment.GITHUB_EVENT_PATH;
	const apiRoot = environment.GITHUB_API_URL ?? "https://api.github.com";
	const trustedCwd = environment.HISTORY_SHAPE_TRUSTED_CWD;
	const graphCwd = environment.HISTORY_SHAPE_GRAPH_CWD;
	if (
		!token ||
		!repositoryId ||
		!eventPath ||
		!trustedCwd ||
		!graphCwd ||
		typeof repository !== "string" ||
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
	)
		throw new HistoryShapeRefusal("runtime identity is unavailable");
	let event;
	try {
		event = JSON.parse(await readFile(eventPath, "utf8"));
	} catch {
		throw new HistoryShapeRefusal("event is unreadable");
	}
	const number = event?.pull_request?.number;
	if (!Number.isSafeInteger(number)) throw new HistoryShapeRefusal("pull request is unavailable");
	const first = pullOperands(await api(`pulls/${number}`, token, repository, apiRoot), repositoryId, repository);
	if (first.number !== number || event?.repository?.id?.toString() !== repositoryId)
		throw new HistoryShapeRefusal("event identity drifted");
	if (git(["rev-parse", "HEAD"], trustedCwd) !== first.baseSha)
		throw new HistoryShapeRefusal("trusted base revision is unavailable");
	if (git(["rev-parse", "HEAD"], graphCwd) !== first.headSha) throw new HistoryShapeRefusal("checked-out head differs");
	const result = evaluateHistoryShape({ ...first, cwd: graphCwd });
	const second = pullOperands(await api(`pulls/${number}`, token, repository, apiRoot), repositoryId, repository);
	if (JSON.stringify(first) !== JSON.stringify(second)) throw new HistoryShapeRefusal("operands drifted");
	if (!result.pass) throw new HistoryShapeRefusal(`topic contains ${result.mergeCommits.length} merge commit(s)`);
	return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	try {
		const result = await runHistoryShape();
		console.log(`history-shape passed at merge base ${result.mergeBase}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : "history-shape refused: unknown failure");
		process.exitCode = 1;
	}
}

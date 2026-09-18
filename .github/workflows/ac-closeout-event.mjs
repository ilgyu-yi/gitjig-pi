#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { evaluateAcCloseout } from "./ac-closeout.mjs";

/** @typedef {(path:string, init?:RequestInit)=>Promise<any>} Api */
/** @typedef {(query:string, variables:Record<string,unknown>)=>Promise<any>} Graphql */

/** @param {Api} api @param {string} path */
export async function readPaginated(api, path) {
	const all = [];
	for (let page = 1; ; page += 1) {
		const separator = path.includes("?") ? "&" : "?";
		const batch = await api(`${path}${separator}per_page=100&page=${page}`);
		if (!Array.isArray(batch)) throw new Error("ac-closeout: population malformed");
		all.push(...batch);
		if (batch.length < 100) return all;
	}
}

/** @param {Graphql} graphql @param {string} owner @param {string} name @param {number} number */
export async function readClosingIssues(graphql, owner, name, number) {
	const all = [];
	let cursor = null;
	for (;;) {
		/** @type {any} */
		const data = await graphql(
			`query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:100,after:$cursor){nodes{id number body}pageInfo{hasNextPage endCursor}}}}}`,
			{ owner, name, number, cursor },
		);
		const connection = data?.repository?.pullRequest?.closingIssuesReferences;
		if (!connection || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean")
			throw new Error("ac-closeout: closing Issue population unavailable");
		all.push(...connection.nodes);
		if (!connection.pageInfo.hasNextPage) return all;
		if (typeof connection.pageInfo.endCursor !== "string")
			throw new Error("ac-closeout: closing Issue pagination unavailable");
		cursor = connection.pageInfo.endCursor;
	}
}

/** @param {Api} api @param {string} repository */
async function openPullNumbers(api, repository) {
	return (await readPaginated(api, "/pulls?state=open"))
		.filter((pull) => pull?.base?.repo?.full_name === repository && pull?.head?.repo?.full_name === repository)
		.map((pull) => pull?.number)
		.filter(Number.isSafeInteger);
}

/** @param {any} event @param {Api} api @param {Graphql} graphql @param {string} owner @param {string} name @param {string} repository */
async function affectedPullNumbers(event, api, graphql, owner, name, repository) {
	if (event.pull_request && Number.isSafeInteger(event.pull_request.number)) return [event.pull_request.number];
	const issue = event.issue;
	if (!issue || event.issue?.pull_request || typeof issue.node_id !== "string") return [];
	const result = [];
	for (const number of await openPullNumbers(api, repository)) {
		try {
			if ((await readClosingIssues(graphql, owner, name, number)).some((candidate) => candidate.id === issue.node_id))
				result.push(number);
		} catch {
			// An unreadable reverse edge may hide the addressed Issue. Evaluate
			// that PR too, so its prior green is replaced by a closed result.
			result.push(number);
		}
	}
	return result;
}

/** @param {Api} api @param {Graphql} graphql @param {string} owner @param {string} name @param {string} repository @param {number} number */
async function snapshot(api, graphql, owner, name, repository, number) {
	const pull = await api(`/pulls/${number}`);
	if (pull?.base?.repo?.full_name !== repository || pull?.head?.repo?.full_name !== repository)
		throw new Error("ac-closeout: same-repository pull request required");
	const issues = await readClosingIssues(graphql, owner, name, number);
	const populated = [];
	for (const issue of issues) {
		const fresh = await api(`/issues/${issue.number}`);
		if (fresh?.node_id !== issue.id) throw new Error("ac-closeout: Issue identity changed");
		const comments = await readPaginated(api, `/issues/${issue.number}/comments`);
		populated.push({
			id: issue.id,
			number: issue.number,
			body: fresh.body ?? "",
			comments: comments.map((comment) => ({
				body: comment?.body,
				authorId: comment?.user?.node_id,
				createdAt: comment?.created_at,
				updatedAt: comment?.updated_at,
			})),
		});
	}
	return {
		repositoryId: pull?.base?.repo?.node_id,
		pullRequestId: pull?.node_id,
		pullRequestNumber: number,
		headSha: pull?.head?.sha,
		baseSha: pull?.base?.sha,
		pullRequestBody: pull?.body ?? "",
		closingIssues: populated,
	};
}

/** @param {Api} api @param {string} sha */
async function checkRuns(api, sha) {
	const response = await api(`/commits/${sha}/check-runs?per_page=100`);
	if (
		!Number.isSafeInteger(response?.total_count) ||
		!Array.isArray(response?.check_runs) ||
		response.total_count !== response.check_runs.length
	)
		throw new Error("ac-closeout: check population incomplete");
	for (const run of response.check_runs) {
		if (
			!Number.isSafeInteger(run?.id) ||
			typeof run?.name !== "string" ||
			typeof run?.status !== "string" ||
			typeof run?.app?.slug !== "string"
		)
			throw new Error("ac-closeout: check population malformed");
	}
	return response.check_runs.filter(
		/** @param {any} run */ (run) => run.name === "ac-closeout" && run.app.slug === "github-actions",
	);
}

/** @param {{api:Api,graphql:Graphql,owner:string,name:string,repository:string,number:number}} input */
export async function evaluatePull({ api, graphql, owner, name, repository, number }) {
	const initial = await api(`/pulls/${number}`);
	if (initial?.base?.repo?.full_name !== repository || initial?.head?.repo?.full_name !== repository)
		throw new Error("ac-closeout: same-repository pull request required");
	const created = await api("/check-runs", {
		method: "POST",
		body: JSON.stringify({
			name: "ac-closeout",
			head_sha: initial.head.sha,
			status: "in_progress",
			details_url: initial.html_url,
			external_id: `ac-closeout:${initial.node_id}:${initial.head.sha}`,
		}),
	});
	if (!Number.isSafeInteger(created?.id)) throw new Error("ac-closeout: check creation failed");
	/** @type {{ok:boolean,arm:string}} */
	let result = { ok: false, arm: "lookup-unavailable" };
	try {
		const evaluated = evaluateAcCloseout(await snapshot(api, graphql, owner, name, repository, number));
		result = {
			ok: evaluated.ok === true,
			arm: typeof evaluated.arm === "string" ? evaluated.arm : "lookup-unavailable",
		};
	} catch {
		result = { ok: false, arm: "lookup-unavailable" };
	}
	try {
		const runs = await checkRuns(api, initial.head.sha);
		if (runs.some(/** @param {any} run */ (run) => Number(run.id) > created.id)) {
			await api(`/check-runs/${created.id}`, {
				method: "PATCH",
				body: JSON.stringify({
					status: "completed",
					conclusion: "neutral",
					output: { title: "Superseded", summary: "A newer ac-closeout evaluation owns this head." },
				}),
			});
			return { ok: false, arm: "superseded" };
		}
		for (const run of runs) {
			if (Number(run.id) < created.id && run.status !== "completed")
				await api(`/check-runs/${run.id}`, {
					method: "PATCH",
					body: JSON.stringify({
						status: "completed",
						conclusion: "neutral",
						output: { title: "Superseded", summary: "A newer ac-closeout evaluation owns this head." },
					}),
				});
		}
		const finalPull = await api(`/pulls/${number}`);
		if (finalPull?.head?.sha !== initial.head.sha || finalPull?.base?.sha !== initial.base.sha)
			result = { ok: false, arm: "subject-changed" };
	} catch {
		result = { ok: false, arm: "lookup-unavailable" };
	}
	await api(`/check-runs/${created.id}`, {
		method: "PATCH",
		body: JSON.stringify({
			status: "completed",
			conclusion: result.ok ? "success" : "failure",
			output: {
				title: result.ok ? "Acceptance closeout verified" : "Acceptance closeout refused",
				summary: result.arm,
			},
		}),
	});
	return result;
}

/** @param {{event:any,repository:string,api:Api,graphql:Graphql,evaluate?:typeof evaluatePull}} input */
export async function runAcCloseoutEvent({ event, repository, api, graphql, evaluate = evaluatePull }) {
	const [owner, name] = repository.split("/");
	if (!owner || !name || `${owner}/${name}` !== repository) throw new Error("ac-closeout: repository malformed");
	const numbers = await affectedPullNumbers(event, api, graphql, owner, name, repository);
	let failed = false;
	for (const number of numbers) {
		try {
			await evaluate({ api, graphql, owner, name, repository, number });
		} catch {
			failed = true;
		}
	}
	if (failed) throw new Error("ac-closeout: one or more independent PR evaluations failed");
}

async function main() {
	const token = process.env.GITHUB_TOKEN;
	const repository = process.env.GITHUB_REPOSITORY;
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!token || !repository || !eventPath) throw new Error("ac-closeout: event context unavailable");
	const [owner, name] = repository.split("/");
	if (!owner || !name) throw new Error("ac-closeout: repository malformed");
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
		if (!response.ok) throw new Error(`ac-closeout: API ${response.status}`);
		return response.status === 204 ? undefined : response.json();
	};
	/** @type {Graphql} */
	const graphql = async (query, variables) => {
		const response = await fetch("https://api.github.com/graphql", {
			method: "POST",
			headers,
			body: JSON.stringify({ query, variables }),
		});
		if (!response.ok) throw new Error(`ac-closeout: GraphQL ${response.status}`);
		/** @type {any} */
		const value = await response.json();
		if (value.errors) throw new Error("ac-closeout: GraphQL unavailable");
		return value.data;
	};
	await runAcCloseoutEvent({ event: JSON.parse(await readFile(eventPath, "utf8")), repository, api, graphql });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href)
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});

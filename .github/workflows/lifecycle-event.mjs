#!/usr/bin/env node
// Handed-over lifecycle event adapter. Delivery data selects a possible arm;
// fresh platform reads provide every deciding subject, review, and author fact.
import { readFile } from "node:fs/promises";
import {
	admitAwaitingAuthorRecord,
	authorizedResolver,
	encodeRecord,
	executeTransitionPlan,
	inspectAwaitingAuthorPopulation,
	latestEligibleHumanReviews,
	parseMarkedRecord,
	RECORD_MARKERS,
	recordThenLabelPlan,
	terminalThenUnlabelPlan,
} from "./gitjig-lifecycle.mjs";

const LABEL = "awaiting-author";

/** @param {any} review */
function reviewSnapshot(review) {
	return {
		actorId: review?.user?.node_id,
		actorType: review?.user?.type,
		association: review?.author_association,
		state: review?.state,
		headSha: review?.commit_id,
		submittedAt: review?.submitted_at,
		dismissed: review?.state === "DISMISSED",
	};
}

/** @param {any} comment */
function workflowComment(comment) {
	return comment?.user?.type === "Bot" && comment?.user?.login === "github-actions[bot]";
}

/** @param {any} api @param {number} number */
async function readComments(api, number) {
	const values = [];
	for (let page = 1; ; page += 1) {
		const batch = await api(`/issues/${number}/comments?per_page=100&page=${page}`);
		if (!Array.isArray(batch)) throw new Error("lifecycle adapter: comment population malformed");
		values.push(...batch);
		if (batch.length < 100) return values;
	}
}

/** @param {any} api @param {number} number */
async function readReviews(api, number) {
	const values = [];
	for (let page = 1; ; page += 1) {
		const batch = await api(`/pulls/${number}/reviews?per_page=100&page=${page}`);
		if (!Array.isArray(batch)) throw new Error("lifecycle adapter: review population malformed");
		values.push(...batch);
		if (batch.length < 100) return values;
	}
}

/** @param {any} api @param {any[]} comments @param {"issue"|"pull"} subjectKind @param {string} repository */
async function attestComments(api, comments, subjectKind, repository) {
	const examined = [];
	for (const comment of comments) {
		const body = comment?.body;
		if (typeof body !== "string") continue;
		const common = { id: comment.id, body, authorId: comment.user?.login };
		if (body.startsWith(RECORD_MARKERS.awaitingAuthorTerminal)) {
			examined.push({ ...common, attested: workflowComment(comment) });
			continue;
		}
		if (!body.startsWith(RECORD_MARKERS.awaitingAuthor)) continue;
		const record = parseMarkedRecord(body, RECORD_MARKERS.awaitingAuthor);
		let attested =
			admitAwaitingAuthorRecord(record, subjectKind) &&
			record.producerKind === "human-changes-requested" &&
			workflowComment(comment);
		if (
			admitAwaitingAuthorRecord(record, subjectKind) &&
			record.producerKind === "resolver-repair" &&
			record.producer === comment.user?.node_id
		) {
			const login = comment.user?.login;
			if (typeof login === "string" && login.length > 0) {
				const authority = await api(`/collaborators/${encodeURIComponent(login)}/permission`);
				const permission = typeof authority?.role_name === "string" ? authority.role_name.toUpperCase() : undefined;
				attested = authorizedResolver({
					actorId: comment.user.node_id,
					actorType: comment.user.type,
					repositoryId: repository,
					addressedRepositoryId: repository,
					permission,
				});
			}
		}
		examined.push({ ...common, attested });
	}
	return examined;
}

/** @param {any} api @param {number} number @param {"issue"|"pull"} subjectKind @param {string} repository */
async function population(api, number, subjectKind, repository) {
	return inspectAwaitingAuthorPopulation(
		await attestComments(api, await readComments(api, number), subjectKind, repository),
		subjectKind,
	);
}

/** @param {any} api @param {number} number @param {readonly any[]} plan */
async function execute(api, number, plan) {
	await executeTransitionPlan(plan, {
		comment: async (body) => {
			await api(`/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
		},
		addLabel: async (label) => {
			await api(`/issues/${number}/labels`, { method: "POST", body: JSON.stringify({ labels: [label] }) });
		},
		removeLabel: async (label) => {
			const labels = await api(`/issues/${number}/labels?per_page=100`);
			if (!Array.isArray(labels)) throw new Error("lifecycle adapter: label population malformed");
			if (labels.some((candidate) => candidate?.name === label))
				await api(`/issues/${number}/labels/${encodeURIComponent(label)}`, { method: "DELETE" });
		},
	});
}

/** @param {any} pull @param {any} eventPull @param {string} repository */
function requirePullSubject(pull, eventPull, repository) {
	if (
		pull?.id !== eventPull?.id ||
		pull?.base?.repo?.full_name !== repository ||
		pull?.head?.repo?.full_name !== repository
	)
		throw new Error("lifecycle adapter: repository or fork mismatch");
}

/** @param {{event:any,repository:string,api:any,now?:()=>string}} input */
export async function runLifecycleEvent({ event, repository, api, now = () => new Date().toISOString() }) {
	if (event.action === "submitted" && event.review) {
		const number = event.pull_request?.number;
		if (!Number.isSafeInteger(number)) throw new Error("lifecycle adapter: pull request number unavailable");
		const pull = await api(`/pulls/${number}`);
		requirePullSubject(pull, event.pull_request, repository);
		const reviews = (await readReviews(api, number)).map(reviewSnapshot);
		const latest = latestEligibleHumanReviews(reviews, pull.user?.node_id, pull.head?.sha);
		const candidate = latest.get(event.review?.user?.node_id);
		if (candidate === undefined || candidate.dismissed || candidate.state !== "CHANGES_REQUESTED") return;
		const inspected = await population(api, number, "pull", repository);
		if (!inspected.ok) throw new Error(`lifecycle adapter: ${inspected.arm}`);
		const current = inspected.current ?? [];
		const existing = current[0];
		if (existing !== undefined) {
			if (existing.record.subjectHead !== pull.head.sha || existing.record.baseHead !== pull.base.sha)
				throw new Error("lifecycle adapter: stale current record requires synchronization");
			await execute(api, number, [{ kind: "add-label", label: LABEL }]);
			return;
		}
		const body = encodeRecord(RECORD_MARKERS.awaitingAuthor, {
			producer: candidate.actorId,
			producerKind: "human-changes-requested",
			observedAt: now(),
			subjectHead: pull.head.sha,
			baseHead: pull.base.sha,
		});
		await execute(api, number, recordThenLabelPlan(body, LABEL));
		return;
	}

	if (event.action === "synchronize" && event.pull_request) {
		const number = event.pull_request.number;
		if (!Number.isSafeInteger(number)) throw new Error("lifecycle adapter: pull request number unavailable");
		const pull = await api(`/pulls/${number}`);
		requirePullSubject(pull, event.pull_request, repository);
		const inspected = await population(api, number, "pull", repository);
		if (!inspected.ok && inspected.arm !== "record-ambiguous") throw new Error(`lifecycle adapter: ${inspected.arm}`);
		const current = inspected.current ?? [];
		const stale = current.filter(({ record }) => record.subjectHead !== pull.head.sha);
		const terminals = stale.map((existing) =>
			encodeRecord(RECORD_MARKERS.awaitingAuthorTerminal, {
				recordCommentId: existing.comment.id,
				clearerId: "github-actions[bot]",
				clearedAt: now(),
				cause: "pull-synchronize",
				subjectHead: pull.head.sha,
				baseHead: pull.base.sha,
			}),
		);
		for (const body of terminals.slice(0, -1)) await execute(api, number, [{ kind: "comment", body }]);
		const lastTerminal = terminals.at(-1);
		if (lastTerminal !== undefined && stale.length === current.length)
			await execute(api, number, terminalThenUnlabelPlan(lastTerminal, LABEL));
		else if (lastTerminal !== undefined) await execute(api, number, recordThenLabelPlan(lastTerminal, LABEL));
		else if (current.length === 0) await execute(api, number, [{ kind: "remove-label", label: LABEL }]);
		return;
	}

	if (event.action === "edited" && event.issue && !event.issue.pull_request) {
		if (event.changes?.body === undefined) return;
		const number = event.issue.number;
		if (!Number.isSafeInteger(number)) throw new Error("lifecycle adapter: issue number unavailable");
		const issue = await api(`/issues/${number}`);
		if (issue?.id !== event.issue.id || issue?.repository_url !== `https://api.github.com/repos/${repository}`)
			throw new Error("lifecycle adapter: repository mismatch");
		const actorId = event.sender?.node_id;
		const authorId = issue.user?.node_id;
		if (typeof actorId !== "string" || typeof authorId !== "string" || actorId.length === 0 || actorId !== authorId)
			return;
		const inspected = await population(api, number, "issue", repository);
		if (!inspected.ok && inspected.arm !== "record-ambiguous") throw new Error(`lifecycle adapter: ${inspected.arm}`);
		const current = inspected.current ?? [];
		const terminals = current.map((existing) =>
			encodeRecord(RECORD_MARKERS.awaitingAuthorTerminal, {
				recordCommentId: existing.comment.id,
				clearerId: "github-actions[bot]",
				clearedAt: now(),
				cause: "issue-author-body-edit",
				subjectHead: null,
				baseHead: null,
			}),
		);
		for (const body of terminals.slice(0, -1)) await execute(api, number, [{ kind: "comment", body }]);
		const lastTerminal = terminals.at(-1);
		if (lastTerminal !== undefined) await execute(api, number, terminalThenUnlabelPlan(lastTerminal, LABEL));
		else await execute(api, number, [{ kind: "remove-label", label: LABEL }]);
	}
}

async function main() {
	const token = process.env.GITHUB_TOKEN;
	const repository = process.env.GITHUB_REPOSITORY;
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!token || !repository || !eventPath) throw new Error("lifecycle adapter: event context unavailable");
	const [owner, repo] = repository.split("/");
	if (!owner || !repo || `${owner}/${repo}` !== repository)
		throw new Error("lifecycle adapter: repository is malformed");
	const event = JSON.parse(await readFile(eventPath, "utf8"));
	/** @param {string} path @param {RequestInit} [init] */
	const api = async (path, init = {}) => {
		const response = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
			...init,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
				...init.headers,
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) throw new Error(`lifecycle adapter: platform request refused (${response.status})`);
		return response.status === 204 ? undefined : response.json();
	};
	await runLifecycleEvent({ event, repository, api });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();

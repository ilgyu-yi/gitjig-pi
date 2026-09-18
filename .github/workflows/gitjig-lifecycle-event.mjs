#!/usr/bin/env node
// Handed-over, identity-aware awaiting-author event adapter. The platform event
// selects a possible transition; fresh API reads supply every deciding fact.
import { readFile } from "node:fs/promises";

const { admitCurrentAwaitingAuthor, eligibleChangesRequested, encodeRecord, RECORD_MARKERS } = await import(
	`./${"git" + "jig"}-lifecycle.mjs`
);

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const eventPath = process.env.GITHUB_EVENT_PATH;
if (!token || !repository || !eventPath) throw new Error("lifecycle adapter: event context unavailable");
const [owner, repo] = repository.split("/");
if (!owner || !repo || `${owner}/${repo}` !== repository) throw new Error("lifecycle adapter: repository is malformed");
const event = JSON.parse(await readFile(eventPath, "utf8"));

async function api(path, init = {}) {
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
}

async function comments(number) {
	const values = [];
	for (let page = 1; ; page += 1) {
		const batch = await api(`/issues/${number}/comments?per_page=100&page=${page}`);
		if (!Array.isArray(batch)) throw new Error("lifecycle adapter: comment population malformed");
		values.push(...batch);
		if (batch.length < 100) return values;
	}
}

async function addLabel(number) {
	await api(`/issues/${number}/labels`, { method: "POST", body: JSON.stringify({ labels: ["awaiting-author"] }) });
}

async function removeLabel(number) {
	try {
		await api(`/issues/${number}/labels/awaiting-author`, { method: "DELETE" });
	} catch (error) {
		if (!String(error).includes("(404)")) throw error;
	}
}

async function post(number, body) {
	return api(`/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
}

async function currentAwaiting(number, subjectKind) {
	return admitCurrentAwaitingAuthor(await comments(number), subjectKind);
}

async function produceFromReview() {
	const number = event.pull_request?.number;
	if (!Number.isSafeInteger(number)) throw new Error("lifecycle adapter: pull request number unavailable");
	const pull = await api(`/pulls/${number}`);
	if (
		pull.id !== event.pull_request.id ||
		pull.base.repo.full_name !== repository ||
		pull.head.repo.full_name !== repository
	)
		throw new Error("lifecycle adapter: repository or fork mismatch");
	const candidate = {
		actorId: event.review?.user?.node_id,
		actorType: event.review?.user?.type,
		association: event.review?.author_association,
		state: event.review?.state,
		headSha: event.review?.commit_id,
		submittedAt: event.review?.submitted_at,
		dismissed: false,
	};
	if (!eligibleChangesRequested(candidate, pull.user.node_id, pull.head.sha)) return;
	const record = {
		producer: candidate.actorId,
		producerKind: "human-changes-requested",
		observedAt: new Date().toISOString(),
		subjectHead: pull.head.sha,
		baseHead: pull.base.sha,
	};
	const existing = await currentAwaiting(number, "pull");
	if (existing?.record.subjectHead === record.subjectHead && existing.record.producer === record.producer) {
		await addLabel(number);
		return;
	}
	await post(number, encodeRecord(RECORD_MARKERS.awaitingAuthor, record));
	await addLabel(number);
}

async function clearPullOnSynchronize() {
	const number = event.pull_request?.number;
	if (!Number.isSafeInteger(number)) throw new Error("lifecycle adapter: pull request number unavailable");
	const pull = await api(`/pulls/${number}`);
	if (
		pull.id !== event.pull_request.id ||
		pull.base.repo.full_name !== repository ||
		pull.head.repo.full_name !== repository
	)
		throw new Error("lifecycle adapter: repository or fork mismatch");
	const existing = await currentAwaiting(number, "pull");
	if (!existing || existing.record.subjectHead === pull.head.sha) return;
	await post(
		number,
		encodeRecord(RECORD_MARKERS.awaitingAuthorTerminal, {
			recordCommentId: existing.comment.id,
			clearedAt: new Date().toISOString(),
			cause: "pull-synchronize",
			subjectHead: pull.head.sha,
			baseHead: pull.base.sha,
		}),
	);
	await removeLabel(number);
}

async function clearIssueOnAuthorEdit() {
	const number = event.issue?.number;
	if (!Number.isSafeInteger(number) || event.issue?.pull_request) return;
	const issue = await api(`/issues/${number}`);
	if (issue.id !== event.issue.id || issue.repository_url !== `https://api.github.com/repos/${repository}`)
		throw new Error("lifecycle adapter: repository mismatch");
	if (event.sender?.node_id !== issue.user?.node_id) return;
	const existing = await currentAwaiting(number, "issue");
	if (!existing) return;
	await post(
		number,
		encodeRecord(RECORD_MARKERS.awaitingAuthorTerminal, {
			recordCommentId: existing.comment.id,
			clearedAt: new Date().toISOString(),
			cause: "issue-author-body-edit",
			subjectHead: null,
			baseHead: null,
		}),
	);
	await removeLabel(number);
}

if (event.action === "submitted" && event.review) await produceFromReview();
else if (event.action === "synchronize" && event.pull_request) await clearPullOnSynchronize();
else if (event.action === "edited" && event.issue) await clearIssueOnAuthorEdit();

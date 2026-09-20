#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { invalidatesLandingAdvisory } from "./gitjig-lifecycle.mjs";

const LABEL = "merge:bypass-permitted";
const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const apiRoot = process.env.GITHUB_API_URL ?? "https://api.github.com";
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
if (!token || !repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
	throw new Error("label hygiene refused: identity unavailable");
async function api(path, init = {}) {
	const response = await fetch(`${apiRoot}/repos/${repository}/${path}`, {
		...init,
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
			...(init.headers ?? {}),
		},
	});
	if (!response.ok && response.status !== 404) throw new Error("label hygiene refused: platform ambiguity");
	return response.status === 404 ? undefined : response.json();
}
async function remove(number) {
	await api(`issues/${number}/labels/${encodeURIComponent(LABEL)}`, { method: "DELETE" });
	const current = await api(`issues/${number}`);
	if (!current || current.labels.some((label) => label.name === LABEL))
		throw new Error("label hygiene refused: write not observed");
}
if (process.env.GITHUB_EVENT_NAME === "pull_request_target") {
	const number = event.pull_request?.number;
	const current = Number.isSafeInteger(number) ? await api(`pulls/${number}`) : undefined;
	if (!current) throw new Error("label hygiene refused: pull request unreadable");
	const labels = current.labels.map((label) => label.name);
	if (
		labels.includes(LABEL) &&
		invalidatesLandingAdvisory({
			kind: "synchronize",
			before: event.before,
			after: current.head?.sha,
			eventRef: null,
			baseRef: current.base?.ref,
		})
	)
		await remove(number);
} else if (process.env.GITHUB_EVENT_NAME === "push") {
	let page = 1;
	let complete = false;
	while (page <= 100) {
		const pulls = await api(
			`pulls?state=open&base=${encodeURIComponent(event.ref?.replace(/^refs\/heads\//, "") ?? "")}&per_page=100&page=${page}`,
		);
		if (!Array.isArray(pulls)) throw new Error("label hygiene refused: pull population unreadable");
		for (const summary of pulls) {
			const current = await api(`pulls/${summary.number}`);
			if (!current) throw new Error("label hygiene refused: pull reread failed");
			if (
				current.labels.some((label) => label.name === LABEL) &&
				invalidatesLandingAdvisory({
					kind: "base-push",
					before: event.before,
					after: event.after,
					eventRef: event.ref,
					baseRef: current.base?.ref,
				}) &&
				current.base?.sha === event.after
			)
				await remove(current.number);
		}
		if (pulls.length < 100) {
			complete = true;
			break;
		}
		page += 1;
	}
	if (!complete) throw new Error("label hygiene refused: pagination bound");
} else throw new Error("label hygiene refused: event unsupported");

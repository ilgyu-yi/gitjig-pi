import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeRecord, RECORD_MARKERS } from "../.github/workflows/gitjig-lifecycle.mjs";
import { runLifecycleEvent } from "../.github/workflows/lifecycle-event.mjs";

const REPOSITORY = "owner/repo";
const OLD = "1".repeat(40);
const HEAD = "2".repeat(40);
const BASE = "3".repeat(40);
const NOW = "2026-09-18T00:00:00.000Z";

type ReviewFixture = ReturnType<typeof review>;
interface CommentFixture {
	id: number;
	body: string;
	user: { login: string; node_id: string; type: string };
}

function platform() {
	const state = {
		pull: {
			id: 90,
			number: 7,
			user: { node_id: "AUTHOR" },
			head: { sha: HEAD, repo: { full_name: REPOSITORY } },
			base: { sha: BASE, repo: { full_name: REPOSITORY } },
		},
		issue: {
			id: 91,
			number: 8,
			user: { node_id: "AUTHOR" },
			repository_url: `https://api.github.com/repos/${REPOSITORY}`,
		},
		reviews: [] as ReviewFixture[],
		comments: [] as CommentFixture[],
		labels: new Set<string>(),
		log: [] as string[],
		failRemove: false,
	};
	const api = async (path: string, init: RequestInit = {}): Promise<unknown> => {
		const method = init.method ?? "GET";
		state.log.push(`${method} ${path}`);
		if (path === "/pulls/7") return state.pull;
		if (path.startsWith("/pulls/7/reviews")) return state.reviews;
		if (path === "/issues/8") return state.issue;
		if (path.includes("/comments?") && method === "GET") return state.comments;
		if (path.includes("/collaborators/")) return { permission: "write", role_name: "maintain" };
		if (path.endsWith("/comments") && method === "POST") {
			const body = JSON.parse(String(init.body)).body;
			const comment = {
				id: state.comments.length + 1,
				body,
				user: { login: "github-actions[bot]", node_id: "BOT", type: "Bot" },
			};
			state.comments.push(comment);
			return comment;
		}
		if (path.endsWith("/labels") && method === "POST") {
			for (const label of JSON.parse(String(init.body)).labels) state.labels.add(label);
			return [];
		}
		if (path.endsWith("/labels?per_page=100")) return [...state.labels].map((name) => ({ name }));
		if (path.includes("/labels/") && method === "DELETE") {
			if (state.failRemove) {
				state.failRemove = false;
				throw new Error("injected label failure");
			}
			state.labels.delete("awaiting-author");
			return undefined;
		}
		throw new Error(`unexpected API call: ${method} ${path}`);
	};
	return { state, api };
}

function review(actorId = "REVIEWER") {
	return {
		id: 44,
		user: { node_id: actorId, type: "User" },
		author_association: "MEMBER",
		state: "CHANGES_REQUESTED",
		commit_id: HEAD,
		submitted_at: NOW,
	};
}

function reviewEvent(actorId = "REVIEWER") {
	return { action: "submitted", pull_request: { id: 90, number: 7 }, review: { user: { node_id: actorId } } };
}

function syncEvent() {
	return { action: "synchronize", pull_request: { id: 90, number: 7 } };
}

describe("#276 lifecycle event adapter", () => {
	it("uses fresh latest-review facts and remains producer-replay safe", async () => {
		const { state, api } = platform();
		state.reviews.push(review());
		await runLifecycleEvent({ event: reviewEvent(), repository: REPOSITORY, api, now: () => NOW });
		assert.equal(state.comments.length, 1);
		assert.deepEqual([...state.labels], ["awaiting-author"]);
		await runLifecycleEvent({ event: reviewEvent(), repository: REPOSITORY, api, now: () => NOW });
		assert.equal(state.comments.length, 1);
		state.reviews[0].state = "DISMISSED";
		await runLifecycleEvent({ event: reviewEvent(), repository: REPOSITORY, api, now: () => NOW });
		assert.equal(state.comments.length, 1);
	});

	it("keeps exactly one current producer until the sanctioned new-head clearer", async () => {
		const { state, api } = platform();
		state.reviews.push(review("A"), review("B"));
		await runLifecycleEvent({ event: reviewEvent("A"), repository: REPOSITORY, api, now: () => NOW });
		await runLifecycleEvent({ event: reviewEvent("B"), repository: REPOSITORY, api, now: () => NOW });
		assert.equal(state.comments.length, 1);
		state.pull.head.sha = OLD;
		await runLifecycleEvent({ event: syncEvent(), repository: REPOSITORY, api, now: () => NOW });
		assert.equal(state.comments.length, 2);
		assert.equal(state.labels.has("awaiting-author"), false);
		assert.ok(
			state.log.indexOf("POST /issues/7/comments") < state.log.lastIndexOf("DELETE /issues/7/labels/awaiting-author"),
		);
	});

	it("recovers terminal-record/label partial state by replay", async () => {
		const { state, api } = platform();
		state.reviews.push(review());
		await runLifecycleEvent({ event: reviewEvent(), repository: REPOSITORY, api, now: () => NOW });
		state.pull.head.sha = OLD;
		state.failRemove = true;
		await assert.rejects(runLifecycleEvent({ event: syncEvent(), repository: REPOSITORY, api, now: () => NOW }));
		assert.equal(state.labels.has("awaiting-author"), true);
		await runLifecycleEvent({ event: syncEvent(), repository: REPOSITORY, api, now: () => NOW });
		assert.equal(state.labels.has("awaiting-author"), false);
	});

	it("ignores forged comments and refuses malformed bot records", async () => {
		const { state, api } = platform();
		state.reviews.push(review());
		state.comments.push({
			id: 1,
			body: encodeRecord(RECORD_MARKERS.awaitingAuthor, {
				producer: "REVIEWER",
				producerKind: "human-changes-requested",
				observedAt: NOW,
				subjectHead: HEAD,
				baseHead: BASE,
			}),
			user: { login: "attacker", node_id: "ATTACKER", type: "User" },
		});
		await runLifecycleEvent({ event: reviewEvent(), repository: REPOSITORY, api, now: () => NOW });
		assert.equal(state.comments.length, 2);
		state.comments.push({
			id: 3,
			body: `${RECORD_MARKERS.awaitingAuthor}\nmalformed`,
			user: { login: "github-actions[bot]", node_id: "BOT", type: "Bot" },
		});
		await assert.rejects(
			runLifecycleEvent({ event: reviewEvent(), repository: REPOSITORY, api, now: () => NOW }),
			/record-unparseable/,
		);
	});

	it("clears an Issue only for a body edit by its resolvable author", async () => {
		const { state, api } = platform();
		state.comments.push({
			id: 1,
			body: encodeRecord(RECORD_MARKERS.awaitingAuthor, {
				producer: "AUTHOR",
				producerKind: "resolver-repair",
				observedAt: NOW,
				subjectHead: null,
				baseHead: null,
			}),
			user: { login: "author", node_id: "AUTHOR", type: "User" },
		});
		state.labels.add("awaiting-author");
		const base = { action: "edited", issue: { id: 91, number: 8 }, sender: { node_id: "AUTHOR" } };
		await runLifecycleEvent({ event: { ...base, changes: { title: { from: "old" } } }, repository: REPOSITORY, api });
		assert.equal(state.comments.length, 1);
		await runLifecycleEvent({
			event: { ...base, sender: {}, changes: { body: { from: "old" } } },
			repository: REPOSITORY,
			api,
		});
		assert.equal(state.comments.length, 1);
		await runLifecycleEvent({
			event: { ...base, changes: { body: { from: "old" } } },
			repository: REPOSITORY,
			api,
			now: () => NOW,
		});
		assert.equal(state.comments.length, 2);
		assert.equal(state.labels.has("awaiting-author"), false);
	});
});

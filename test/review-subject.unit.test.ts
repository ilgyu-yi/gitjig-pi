import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublishRepository } from "../.pi/extensions/gitjig/publish/executor.ts";
import type { PublishRequest, PublishResult } from "../.pi/extensions/gitjig/publish/index.ts";
import {
	commitPostStateDiagnosis,
	publishAndRefetchReviewRecord,
	publishReviewRecord,
} from "../.pi/extensions/gitjig/review/publication.ts";
import {
	admitPlatformReviewContext,
	admitReviewSubject,
	criteriaFromClosingIssues,
	fetchPlatformReviewContext,
	fetchReviewSubject,
	type ReviewSubject,
	refetchPlatformReviewContext,
	subjectCriterionManifest,
} from "../.pi/extensions/gitjig/review/subject.ts";

const OID = "a".repeat(40);

function rawPull(): Record<string, unknown> {
	return {
		id: "PR_node",
		number: 223,
		url: "https://github.example/owner/repo/pull/223",
		author: { id: "U_author" },
		baseRefName: "main",
		baseRefOid: OID,
		headRefName: "feature",
		headRefOid: "b".repeat(40),
		headRepository: { id: "R_repo" },
		closingIssuesReferences: [
			{ id: "I_node", number: 212, title: "task", body: "criteria", repository: { id: "R_repo" } },
		],
	};
}

function snapshot(): Record<string, unknown> {
	return {
		repository: { id: "R_repo", host: "github.example", nameWithOwner: "owner/repo" },
		pullRequest: {
			id: "PR_node",
			number: 223,
			url: "https://github.example/owner/repo/pull/223",
			authorId: "U_author",
			base: { repositoryId: "R_repo", name: "main", oid: OID },
			head: { repositoryId: "R_repo", name: "feature", oid: "b".repeat(40) },
			closingIssues: [{ id: "I_node", repositoryId: "R_repo", number: 212, title: "task", body: "criteria" }],
		},
	};
}

function subject(criteria: readonly string[] = []): ReviewSubject {
	const admitted = admitReviewSubject({ context: snapshot(), writerId: "U_writer", criteria });
	assert.ok(admitted !== undefined);
	return admitted;
}

describe("inert platform review context", () => {
	it("admits and detaches one closed same-repository snapshot", () => {
		const source = snapshot();
		const admitted = admitPlatformReviewContext(source);
		assert.ok(admitted !== undefined);
		(source.pullRequest as { number: number }).number = 1;
		assert.equal(admitted.pullRequest.number, 223);
	});

	it("refuses abbreviated object ids and cross-repository identities", () => {
		const abbreviated = snapshot();
		((abbreviated.pullRequest as Record<string, unknown>).head as { oid: string }).oid = "b".repeat(7);
		assert.equal(admitPlatformReviewContext(abbreviated), undefined);

		for (const limb of ["base", "head"] as const) {
			const foreign = snapshot();
			((foreign.pullRequest as Record<string, unknown>)[limb] as { repositoryId: string }).repositoryId = "R_other";
			assert.equal(admitPlatformReviewContext(foreign), undefined, limb);
		}
		const foreignIssue = snapshot();
		(
			(foreignIssue.pullRequest as Record<string, unknown>).closingIssues as { repositoryId: string }[]
		)[0].repositoryId = "R_other";
		assert.equal(admitPlatformReviewContext(foreignIssue), undefined);
	});

	it("refuses unknown and missing fields at both object boundaries", () => {
		for (const boundary of ["root", "pull"] as const) {
			const extra = snapshot();
			const target = boundary === "root" ? extra : (extra.pullRequest as Record<string, unknown>);
			target.untrusted = true;
			assert.equal(admitPlatformReviewContext(extra), undefined, `${boundary} extra`);
			delete target.untrusted;
			delete target[boundary === "root" ? "repository" : "authorId"];
			assert.equal(admitPlatformReviewContext(extra), undefined, `${boundary} missing`);
		}
	});

	it("bootstraps once, then addresses the PR by explicit platform repository", async () => {
		const calls: string[][] = [];
		const outputs = [
			JSON.stringify({ id: "R_repo", nameWithOwner: "owner/repo", url: "https://github.example/owner/repo" }),
			JSON.stringify({
				id: "PR_node",
				number: 223,
				url: "https://github.example/owner/repo/pull/223",
				author: { id: "U_author", login: "author" },
				baseRefName: "main",
				baseRefOid: OID,
				headRefName: "feature",
				headRefOid: "b".repeat(40),
				headRepository: { id: "R_repo", nameWithOwner: "owner/repo" },
				closingIssuesReferences: [
					{ id: "I_node", number: 212, title: "task", body: "criteria", repository: { id: "R_repo" } },
				],
			}),
		];
		const context = await fetchPlatformReviewContext("/repo", 223, async (argv) => {
			calls.push(argv);
			return outputs.shift();
		});
		assert.ok(context !== undefined);
		assert.equal(context.pullRequest.head.oid, "b".repeat(40));
		assert.deepEqual(calls[1]?.slice(0, 6), ["pr", "view", "223", "--repo", "github.example/owner/repo", "--json"]);
	});

	it("refetches only through the sealed repository and rejects every observed drift", async () => {
		const expected = admitPlatformReviewContext(snapshot());
		assert.ok(expected !== undefined);
		const calls: string[][] = [];
		const unchanged = await refetchPlatformReviewContext("/repo", expected, async (argv) => {
			calls.push(argv);
			return JSON.stringify(rawPull());
		});
		assert.deepEqual(unchanged, expected);
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0]?.slice(0, 6), ["pr", "view", "223", "--repo", "github.example/owner/repo", "--json"]);

		for (const mutate of [
			(value: Record<string, unknown>) => {
				value.author = { id: "U_other" };
			},
			(value: Record<string, unknown>) => {
				value.headRefOid = "c".repeat(40);
			},
			(value: Record<string, unknown>) => {
				((value.closingIssuesReferences as Record<string, unknown>[])[0] as Record<string, unknown>).body = "drift";
			},
		]) {
			const changed = rawPull();
			mutate(changed);
			assert.equal(
				await refetchPlatformReviewContext("/repo", expected, async () => JSON.stringify(changed)),
				undefined,
			);
		}
	});

	it("retries an unavailable bootstrap identically and never queries a PR without it", async () => {
		const calls: string[][] = [];
		const context = await fetchPlatformReviewContext("/repo", 223, async (argv) => {
			calls.push(argv);
			return undefined;
		});
		assert.equal(context, undefined);
		assert.equal(calls.length, 2);
		assert.deepEqual(calls[0], calls[1]);
		assert.equal(
			calls.every((argv) => argv[0] === "repo"),
			true,
		);
	});

	it("does not cross a mismatched bootstrap URL and refuses a retargeted PR response", async () => {
		let calls = 0;
		const badRepository = await fetchPlatformReviewContext("/repo", 223, async () => {
			calls += 1;
			return JSON.stringify({ id: "R_repo", nameWithOwner: "owner/repo", url: "https://other.example/wrong/repo" });
		});
		assert.equal(badRepository, undefined);
		assert.equal(calls, 1);

		const outputs = [
			JSON.stringify({ id: "R_repo", nameWithOwner: "owner/repo", url: "https://github.example/owner/repo" }),
			JSON.stringify({
				id: "PR_node",
				number: 224,
				url: "https://github.example/owner/repo/pull/224",
				author: { id: "U_author" },
				baseRefName: "main",
				baseRefOid: OID,
				headRefName: "feature",
				headRefOid: "b".repeat(40),
				headRepository: { id: "R_repo" },
				closingIssuesReferences: [],
			}),
		];
		assert.equal(await fetchPlatformReviewContext("/repo", 223, async () => outputs.shift()), undefined);
	});

	it("derives the criterion snapshot from the closing issues alone", () => {
		const issues = [
			{
				id: "I_a",
				repositoryId: "R_repo",
				number: 212,
				title: "task",
				body: [
					"## Background",
					"- not a criterion",
					"## Acceptance criteria",
					"1. an operator can drive a round",
					"- the record is posted\r",
					"",
					"### Notes",
					"* also not a criterion",
				].join("\n"),
			},
			{ id: "I_b", repositoryId: "R_repo", number: 9, title: "task", body: "## acceptance criteria\n2) second issue" },
		];
		assert.deepEqual(criteriaFromClosingIssues(issues), [
			"#212: an operator can drive a round",
			"#212: the record is posted",
			"#9: second issue",
		]);
		assert.deepEqual(criteriaFromClosingIssues([]), []);
	});

	it("seals the writer and the criterion snapshot against a caller-authored set", () => {
		const sealed = subject();
		assert.deepEqual(subjectCriterionManifest(sealed), { state: "present", criteria: [] });
		assert.equal(sealed.writerId, "U_writer");

		const context = snapshot();
		(context.pullRequest as { closingIssues: { body: string }[] }).closingIssues[0].body =
			"## Acceptance criteria\n- the sealed one";
		assert.deepEqual(
			admitReviewSubject({ context, writerId: "U_writer", criteria: ["#212: the sealed one"] })?.criteria,
			["#212: the sealed one"],
		);
		for (const criteria of [[], ["#212: a criterion nobody filed"], ["#212: the sealed one", "#212: and one more"]]) {
			assert.equal(
				admitReviewSubject({ context, writerId: "U_writer", criteria }),
				undefined,
				JSON.stringify(criteria),
			);
		}
		assert.equal(admitReviewSubject({ context: snapshot(), writerId: "", criteria: [] }), undefined);
		assert.equal(admitReviewSubject({ context: snapshot(), writerId: "U_writer" }), undefined);
		assert.equal(admitReviewSubject({ context: { wrong: true }, writerId: "U_writer", criteria: [] }), undefined);
	});

	it("fetches the whole subject or none of it, retrying the writer read identically", async () => {
		const bootstrap = JSON.stringify({
			id: "R_repo",
			nameWithOwner: "owner/repo",
			url: "https://github.example/owner/repo",
		});
		const pull = JSON.stringify(rawPull());
		const calls: string[][] = [];
		const outputs = [bootstrap, pull, JSON.stringify({ node_id: "U_writer", login: "writer" })];
		const sealed = await fetchReviewSubject("/repo", 223, async (argv) => {
			calls.push(argv);
			return outputs.shift();
		});
		assert.deepEqual(sealed, subject());
		assert.deepEqual(calls[2], ["api", "--hostname", "github.example", "user"]);

		const retried: string[][] = [];
		const unavailable = [bootstrap, pull];
		assert.equal(
			await fetchReviewSubject("/repo", 223, async (argv) => {
				retried.push(argv);
				return unavailable.shift();
			}),
			undefined,
		);
		assert.equal(retried.length, 4);
		assert.deepEqual(retried[2], retried[3]);

		const anonymous = [bootstrap, pull, JSON.stringify({ login: "writer" })];
		assert.equal(await fetchReviewSubject("/repo", 223, async () => anonymous.shift()), undefined);
	});

	it("projects publication target and PR only from the re-admitted context", async () => {
		let captured: { params: PublishRequest; repository?: PublishRepository } | undefined;
		const result = await publishReviewRecord(
			"record",
			snapshot() as never,
			"/repo",
			"/state",
			async (params, _repoRoot, _stateRoot, repository): Promise<PublishResult> => {
				captured = { params, repository };
				return { content: [{ type: "text", text: "published" }], details: { disposition: "published" } };
			},
		);
		assert.equal(result.details.disposition, "published");
		assert.deepEqual(captured, {
			params: { body: "record", destination: { kind: "pr-comment", number: 223 } },
			repository: { host: "github.example", nameWithOwner: "owner/repo" },
		});

		const malformed = snapshot();
		(malformed.pullRequest as { number: number }).number = 224;
		let called = false;
		const refused = await publishReviewRecord("record", malformed as never, "/repo", "/state", async () => {
			called = true;
			throw new Error("must not publish");
		});
		assert.equal(called, false);
		assert.equal(refused.details.disposition, "refuse-subject");
	});

	it("admits a durable receipt only after exact bound-subject refetch", async () => {
		const context = subject();
		const publish = async (): Promise<PublishResult> => ({
			content: [{ type: "text", text: "published" }],
			details: {
				disposition: "published",
				url: "https://github.example/owner/repo/pull/223#issuecomment-99",
			},
		});
		const admitted = await publishAndRefetchReviewRecord("record", context, "/repo", "/state", publish, async () => ({
			ok: true,
			comments: [{ id: 99, authorId: "U_writer", body: "record" }],
		}));
		assert.deepEqual(admitted, {
			ok: true,
			receipt: {
				repositoryId: "R_repo",
				pullRequestId: "PR_node",
				headOid: "b".repeat(40),
				commentId: 99,
				authorId: "U_writer",
				body: "record",
			},
		});

		const foreignWriter = await publishAndRefetchReviewRecord(
			"record",
			context,
			"/repo",
			"/state",
			publish,
			async () => ({ ok: true, comments: [{ id: 99, authorId: "U_other", body: "record" }] }),
		);
		assert.deepEqual(foreignWriter, { ok: false, cause: "the published review record did not refetch exactly" });

		let attempts = 0;
		const eventuallyVisible = await publishAndRefetchReviewRecord(
			"record",
			context,
			"/repo",
			"/state",
			publish,
			async () => {
				attempts += 1;
				return {
					ok: true,
					comments: attempts === 1 ? [] : [{ id: 99, authorId: "U_writer", body: "record" }],
				};
			},
		);
		assert.equal(eventuallyVisible.ok, true);
		assert.equal(attempts, 2);

		for (const url of [
			"https://other.example/owner/repo/pull/223#issuecomment-99",
			"https://github.example/owner/repo/pull/224#issuecomment-99",
			"https://github.example/other/repo/pull/223#issuecomment-99",
			"https://github.example/owner/repo/pull/223#issuecomment-0",
		]) {
			let fetched = false;
			const refused = await publishAndRefetchReviewRecord(
				"record",
				context,
				"/repo",
				"/state",
				async () => ({
					content: [{ type: "text", text: "published" }],
					details: { disposition: "published", url },
				}),
				async () => {
					fetched = true;
					return { ok: true, comments: [] };
				},
			);
			assert.equal(refused.ok, false, url);
			assert.equal(fetched, false, url);
		}
	});

	it("refuses mismatched, absent, and ambiguous post-send comments", async () => {
		const publish = async (): Promise<PublishResult> => ({
			content: [{ type: "text", text: "published" }],
			details: { disposition: "published", url: "https://github.example/owner/repo/issues/223#issuecomment-99" },
		});
		for (const comments of [
			[],
			[{ id: 99, authorId: "U_writer", body: "different" }],
			[
				{ id: 99, authorId: "U_writer", body: "record" },
				{ id: 99, authorId: "U_writer", body: "record" },
			],
		]) {
			const outcome = await publishAndRefetchReviewRecord(
				"record",
				subject(),
				"/repo",
				"/state",
				publish,
				async () => ({ ok: true, comments }),
			);
			assert.deepEqual(outcome, { ok: false, cause: "the published review record did not refetch exactly" });
		}
	});

	it("lands the post-state diagnosis only as a confirmed durable record", async () => {
		const A = "a".repeat(40);
		const B = "b".repeat(40);
		const history = [
			{ head: A, outcome: "repair" as const, findings: ["first"], rulings: [] },
			{ head: B, outcome: "repair" as const, findings: ["second"], rulings: [] },
		];
		const diagnosis = { value: "NONE" as const, invalidation: "nothing" as const, evidence: "inspection" };
		let sent: string | undefined;
		const publish = async (params: PublishRequest): Promise<PublishResult> => {
			sent = params.body;
			return {
				content: [{ type: "text", text: "published" }],
				details: { disposition: "published", url: "https://github.example/owner/repo/pull/223#issuecomment-99" },
			};
		};
		const landed = await commitPostStateDiagnosis(
			subject(),
			history,
			diagnosis,
			"/repo",
			"/state",
			publish,
			async () => ({ ok: true, comments: [{ id: 99, authorId: "U_writer", body: sent as string }] }),
		);
		assert.equal(landed.ok, true);
		assert.ok(sent !== undefined);
		assert.equal(sent.startsWith(`<!-- gitjig-diagnosis-record: ${B} -->`), true);

		const uncomposable = await commitPostStateDiagnosis(
			subject(),
			[history[1]],
			diagnosis,
			"/repo",
			"/state",
			async () => {
				throw new Error("must not publish");
			},
			async () => ({ ok: false, cause: "must not read" }),
		);
		assert.deepEqual(uncomposable, { ok: false, cause: "the post-state diagnosis record was not composable" });

		const unconfirmed = await commitPostStateDiagnosis(
			subject(),
			history,
			diagnosis,
			"/repo",
			"/state",
			publish,
			async () => ({ ok: true, comments: [] }),
		);
		assert.equal(unconfirmed.ok, false);
	});

	it("refuses invalid repository names, hosts, URLs, and empty platform identities", () => {
		const badName = snapshot();
		(badName.repository as { nameWithOwner: string }).nameWithOwner = "ambient-only";
		assert.equal(admitPlatformReviewContext(badName), undefined);
		const badHost = snapshot();
		(badHost.repository as { host: string }).host = "-option.example";
		assert.equal(admitPlatformReviewContext(badHost), undefined);
		for (const url of [
			"http://github.example/owner/repo/pull/223",
			"https://other.example/owner/repo/pull/223",
			"https://github.example/other/repo/pull/223",
			"https://github.example/owner/repo/pull/224",
			"https://github.example/owner/repo/pull/223?wrong=1",
		]) {
			const wrongUrl = snapshot();
			(wrongUrl.pullRequest as { url: string }).url = url;
			assert.equal(admitPlatformReviewContext(wrongUrl), undefined, url);
		}
		const emptyAuthor = snapshot();
		(emptyAuthor.pullRequest as { authorId: string }).authorId = "";
		assert.equal(admitPlatformReviewContext(emptyAuthor), undefined);
	});
});

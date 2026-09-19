import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { canonicalInstant } from "../.github/workflows/landing-topology.mjs";
import { gitBlobOid } from "../.pi/extensions/gitjig/landing/provenance.ts";
import {
	admitTopologySourceClaim,
	admitTopologySourceStep,
	admitTopologySourceTerminal,
	encodeTopologySourceRecord,
	TOPOLOGY_SOURCE_REFUSAL_ARMS,
	type TopologySourceClaimRecord,
	type TopologySourceStepRecord,
	topologySourceDigest,
	topologySourcePairKey,
} from "../.pi/extensions/gitjig/landing/source-split-contract.ts";
import {
	executePlatformTopologySource,
	loadTopologySourceApplication,
} from "../.pi/extensions/gitjig/landing/source-split-platform.ts";
import {
	executeTopologySourceSplit,
	type TopologySourceComment,
	type TopologySourceEffects,
	type TopologySourceInput,
} from "../.pi/extensions/gitjig/landing/source-split-service.ts";
import {
	TOPOLOGY_AUTHORIZATION_MARKER,
	TOPOLOGY_SOURCE_CLAIM_MARKER,
	TOPOLOGY_SOURCE_STEP_MARKER,
} from "../.pi/extensions/gitjig/landing/topology-authorization.ts";
import {
	attestTopologyPlan,
	desiredCoreRuleset,
	desiredHumanApprovalRuleset,
	type TopologyPlan,
	topologyPlanArtifactHash,
} from "../.pi/extensions/gitjig/landing/topology-plan.ts";

const now = "2026-09-19T15:00:00.000Z";
const expires = "2026-09-20T15:00:00.000Z";
const hex = (character: string) => character.repeat(64);
function plan(actorId = "U"): TopologyPlan {
	const before = { repositorySettings: { allow_merge_commit: true }, rulesets: [{ id: 1 }] };
	const postconditions = { core: { name: "core-governance" }, human: { name: "human-approval" } };
	const value: Omit<TopologyPlan, "artifactHash"> = {
		schemaVersion: 1,
		authorized: false,
		assumption: "bypass-exemption-unverified",
		stage: "source-split",
		repositoryId: "R",
		actorId,
		actorPermission: "admin",
		defaultBranch: "main",
		before,
		optimisticRulesets: [{ id: 1, updatedAt: "2026-09-19T14:00:00.000Z" }],
		beforeDigest: hex("0"),
		desiredDigest: hex("1"),
		correlationId: hex("2"),
		steps: [
			{
				order: 1,
				method: "PATCH",
				path: "/repos/o/r/rulesets/1",
				body: { name: "core-governance" },
				postRead: { core: { name: "core-governance" } },
			},
			{
				order: 2,
				method: "POST",
				path: "/repos/o/r/rulesets",
				body: { name: "human-approval" },
				postRead: postconditions,
			},
		],
		postconditions,
		rollback: [],
	};
	// The attester binds before/desired/correlation to its own canonical hashes. Use a real planned
	// artifact's digest algorithm through repeated repair of those operands.
	const crypto = (item: unknown): string => {
		const canonical = (entry: unknown): string => {
			if (Array.isArray(entry)) return `[${entry.map(canonical).join(",")}]`;
			if (entry !== null && typeof entry === "object")
				return `{${Object.entries(entry as Record<string, unknown>)
					.sort(([a], [b]) => Buffer.from(a).compare(Buffer.from(b)))
					.map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
					.join(",")}}`;
			return JSON.stringify(entry);
		};
		return createHash("sha256").update(canonical(item)).digest("hex");
	};
	value.beforeDigest = crypto(before);
	value.desiredDigest = crypto(postconditions);
	value.correlationId = crypto({
		repositoryId: "R",
		actorId,
		before: value.beforeDigest,
		desired: value.desiredDigest,
	});
	return { ...value, artifactHash: topologyPlanArtifactHash(value) };
}
function input(authorization: TopologySourceInput["authorization"]): TopologySourceInput {
	const artifact = plan();
	return {
		repositoryId: "R",
		issueId: "I",
		writerId: "U",
		now,
		complete: true,
		plan: artifact,
		freshPlan: structuredClone(artifact),
		authorization,
		comments: [],
	};
}
function admittedInput(): TopologySourceInput {
	const initial = input({ ok: false, arm: "authorization-absent", populationDigest: hex("a") });
	initial.authorization = {
		ok: true,
		authorization: {
			schemaVersion: 1,
			recordId: "AR",
			repositoryId: "R",
			stage: "source-split",
			planHash: initial.plan.artifactHash,
			pairKey: topologySourcePairKey(initial.plan),
			actorId: "U",
			actorPermission: "admin",
			correlationId: initial.plan.correlationId,
			issuedAt: now,
			expiresAt: expires,
		},
	};
	return initial;
}
function effects(
	options: {
		mutate?: "written" | "unknown" | "not-written";
		drift?: boolean;
		failRecordAt?: number;
		audit?: boolean;
	} = {},
) {
	const comments: TopologySourceComment[] = [];
	const calls: string[] = [];
	let writes = 0;
	const value: TopologySourceEffects = {
		canonicalInstant,
		attestPlan: attestTopologyPlan,
		appendAndRead: async (body) => {
			calls.push(`record:${body.split("\n")[0]}`);
			writes += 1;
			if (writes === options.failRecordAt) return undefined;
			const item = { nodeId: `C${writes}`, databaseId: writes, authorId: "U", createdAt: now, updatedAt: now, body };
			comments.push(item);
			return item;
		},
		readComments: async () => comments,
		readState: async (expected) => {
			calls.push("read");
			return options.drift ? { drift: true } : structuredClone(expected);
		},
		mutate: async (step) => {
			calls.push(`write:${step.order}`);
			return { kind: options.mutate ?? "written" };
		},
		auditFinal: async () => {
			calls.push("audit");
			return options.audit ?? true;
		},
	};
	return { value, comments, calls };
}

describe("#293 source-split grammar", () => {
	it("pins every closed refusal arm", () => {
		assert.deepEqual(TOPOLOGY_SOURCE_REFUSAL_ARMS, [
			"subject-invalid",
			"population-incomplete",
			"plan-invalid",
			"authorization-absent",
			"authorization-ambiguous",
			"authorization-unattested",
			"authorization-stale",
			"stage-mismatch",
			"pair-mismatch",
			"claim-conflict",
			"live-drift",
			"ownership-mismatch",
			"write-unverified",
			"postread-mismatch",
			"record-failed",
			"partial-consumed",
			"audit-failed",
		]);
	});
	it("admits exact claim/step shapes and rejects extras", () => {
		const claim = {
			schemaVersion: 1,
			repositoryId: "R",
			issueId: "I",
			authorizationRecordId: "A",
			planHash: hex("a"),
			pairKey: hex("b"),
			correlationId: hex("c"),
			writerId: "U",
			claimedAt: now,
		};
		assert.equal(admitTopologySourceClaim(claim, canonicalInstant), true);
		assert.equal(admitTopologySourceClaim({ ...claim, extra: true }, canonicalInstant), false);
		const step = {
			schemaVersion: 1,
			repositoryId: "R",
			issueId: "I",
			claimCommentId: "C",
			authorizationRecordId: "A",
			planHash: hex("a"),
			pairKey: hex("b"),
			order: 1,
			method: "PATCH",
			path: "/x",
			requestBodyDigest: hex("c"),
			beforeStateDigest: hex("d"),
			afterStateDigest: hex("e"),
			observedAt: now,
			writerId: "U",
		};
		assert.equal(admitTopologySourceStep(step, canonicalInstant), true);
		assert.equal(admitTopologySourceStep({ ...step, method: "PUT" }, canonicalInstant), false);
	});
	it("admits null expiry only for exact absent/ambiguous/unattested pre-claim shapes", () => {
		for (const arm of ["authorization-absent", "authorization-ambiguous"] as const) {
			const terminal = {
				schemaVersion: 1,
				repositoryId: "R",
				issueId: "I",
				authorizationRecordId: null,
				claimCommentId: null,
				outcome: "refused",
				completedOrders: [],
				lastVerifiedStateDigest: null,
				observedMismatch: { arm, condition: "authorization", observedDigest: hex("a") },
				remainingOrders: [1],
				expiresAt: null,
				writerId: "U",
				observedAt: now,
			};
			assert.equal(admitTopologySourceTerminal(terminal, canonicalInstant), true);
			assert.equal(admitTopologySourceTerminal({ ...terminal, expiresAt: now }, canonicalInstant), false);
		}
		const unattested = {
			schemaVersion: 1,
			repositoryId: "R",
			issueId: "I",
			authorizationRecordId: "A",
			claimCommentId: null,
			outcome: "refused",
			completedOrders: [],
			lastVerifiedStateDigest: null,
			observedMismatch: {
				arm: "authorization-unattested",
				condition: "authorization",
				observedDigest: hex("a"),
			},
			remainingOrders: [1],
			expiresAt: null,
			writerId: "U",
			observedAt: now,
		};
		assert.equal(admitTopologySourceTerminal(unattested, canonicalInstant), true);
		assert.equal(
			admitTopologySourceTerminal(
				{
					...unattested,
					observedMismatch: { ...unattested.observedMismatch, arm: "authorization-stale" },
				},
				canonicalInstant,
			),
			false,
		);
	});
});

describe("#293 source-split service", () => {
	it("refuses invalid subject, incomplete population, and unattested plan before effects", async () => {
		for (const [change, arm] of [
			[
				(value: TopologySourceInput) => {
					value.issueId = "";
				},
				"subject-invalid",
			],
			[
				(value: TopologySourceInput) => {
					value.complete = false;
				},
				"population-incomplete",
			],
			[
				(value: TopologySourceInput) => {
					(value.plan as { artifactHash: string }).artifactHash = hex("f");
				},
				"plan-invalid",
			],
		] as const) {
			const candidate = admittedInput();
			change(candidate);
			const fx = effects();
			const result = await executeTopologySourceSplit(candidate, fx.value);
			assert.equal(result.outcome === "refused" && result.arm, arm);
			assert.deepEqual(fx.calls, []);
		}
	});
	it("records authorization absence and performs no source write", async () => {
		const fx = effects();
		const result = await executeTopologySourceSplit(
			input({ ok: false, arm: "authorization-absent", populationDigest: hex("a") }),
			fx.value,
		);
		assert.equal(result.outcome, "refused");
		assert.equal(result.outcome === "refused" && result.arm, "authorization-absent");
		assert.equal(
			fx.calls.some((call) => call.startsWith("write:")),
			false,
		);
		if (result.outcome === "refused") assert.equal(result.terminal?.expiresAt, null);
	});
	it("replays one pre-authorization refusal and does not let it block later authority", async () => {
		const fx = effects();
		const absent = input({ ok: false, arm: "authorization-absent", populationDigest: hex("a") });
		assert.equal((await executeTopologySourceSplit(absent, fx.value)).outcome, "refused");
		const records = fx.comments.length;
		assert.equal((await executeTopologySourceSplit({ ...absent, comments: fx.comments }, fx.value)).outcome, "refused");
		assert.equal(fx.comments.length, records);
		const authorized = { ...admittedInput(), comments: fx.comments };
		assert.equal((await executeTopologySourceSplit(authorized, fx.value)).outcome, "success");
	});
	it("does not consume authorization on a refusal before claim", async () => {
		const fx = effects();
		const first = admittedInput();
		first.freshPlan = plan("V");
		const refused = await executeTopologySourceSplit(first, fx.value);
		assert.equal(refused.outcome === "refused" && refused.arm, "live-drift");
		const retry = admittedInput();
		retry.comments = fx.comments;
		assert.equal((await executeTopologySourceSplit(retry, fx.value)).outcome, "success");
	});
	it("claims before ordered compare/write/post-read/record and succeeds", async () => {
		const fx = effects();
		const result = await executeTopologySourceSplit(admittedInput(), fx.value);
		assert.equal(result.outcome, "success");
		assert.deepEqual(fx.calls, [
			"record:<!-- topology-source-claim: v1 -->",
			"read",
			"write:1",
			"read",
			"record:<!-- topology-source-step: v1 -->",
			"read",
			"write:2",
			"read",
			"record:<!-- topology-source-step: v1 -->",
			"audit",
			"record:<!-- topology-source-terminal: v1 -->",
		]);
	});
	it("stops an ambiguous write without continuation or rollback", async () => {
		const fx = effects({ mutate: "unknown" });
		const result = await executeTopologySourceSplit(admittedInput(), fx.value);
		assert.equal(result.outcome, "partial");
		assert.equal(result.outcome === "partial" && result.arm, "write-unverified");
		assert.deepEqual(
			fx.calls.filter((call) => call.startsWith("write:")),
			["write:1"],
		);
		assert.equal(
			fx.calls.some((call) => call.includes("rollback")),
			false,
		);
	});
	it("stops pre-write drift and does not mutate", async () => {
		const fx = effects({ drift: true });
		const result = await executeTopologySourceSplit(admittedInput(), fx.value);
		assert.equal(result.outcome === "partial" && result.arm, "live-drift");
		assert.equal(
			fx.calls.some((call) => call.startsWith("write:")),
			false,
		);
	});
	it("turns evidence publication failure into record-failed", async () => {
		const fx = effects({ failRecordAt: 1 });
		const result = await executeTopologySourceSplit(admittedInput(), fx.value);
		assert.equal(result.outcome === "refused" && result.arm, "record-failed");
		assert.equal(
			fx.calls.some((call) => call.startsWith("write:")),
			false,
		);
	});
	it("refuses a failed final auditor after all writes", async () => {
		const fx = effects({ audit: false });
		const result = await executeTopologySourceSplit(admittedInput(), fx.value);
		assert.equal(result.outcome === "partial" && result.arm, "audit-failed");
	});
	it("publishes closed pre-admission refusals without source writes", async () => {
		for (const authorization of [
			{ ok: false, arm: "authorization-ambiguous", populationDigest: hex("a") },
			{ ok: false, arm: "authorization-unattested", authorizationRecordId: "A", populationDigest: hex("b") },
			{ ok: false, arm: "authorization-stale", authorizationRecordId: "A", expiresAt: expires },
		] as const) {
			const fx = effects();
			const result = await executeTopologySourceSplit(input(authorization), fx.value);
			assert.equal(result.outcome === "refused" && result.arm, authorization.arm);
			assert.equal(
				fx.calls.some((call) => call.startsWith("write:")),
				false,
			);
		}
	});
	it("rejects stage, pair, and fresh-plan interchange before a claim", async () => {
		const stage = admittedInput();
		if (stage.authorization.ok) stage.authorization.authorization.stage = "carrier-bootstrap";
		let fx = effects();
		let result = await executeTopologySourceSplit(stage, fx.value);
		assert.equal(result.outcome === "refused" && result.arm, "stage-mismatch");
		const pair = admittedInput();
		if (pair.authorization.ok) pair.authorization.authorization.pairKey = hex("f");
		fx = effects();
		result = await executeTopologySourceSplit(pair, fx.value);
		assert.equal(result.outcome === "refused" && result.arm, "pair-mismatch");
		const drift = admittedInput();
		drift.freshPlan = plan("V");
		fx = effects();
		result = await executeTopologySourceSplit(drift, fx.value);
		assert.equal(result.outcome === "refused" && result.arm, "live-drift");
		assert.equal(
			fx.calls.some((call) => call.startsWith("write:")),
			false,
		);
	});
	it("stops on a post-read mismatch and records no later step", async () => {
		const fx = effects();
		let reads = 0;
		fx.value.readState = async (expected) => {
			reads += 1;
			return reads === 2 ? { mismatch: true } : structuredClone(expected);
		};
		const result = await executeTopologySourceSplit(admittedInput(), fx.value);
		assert.equal(result.outcome === "partial" && result.arm, "postread-mismatch");
		assert.deepEqual(
			fx.calls.filter((call) => call.startsWith("write:")),
			["write:1"],
		);
	});
	it("hands off when the post-write step record cannot be re-read", async () => {
		const fx = effects({ failRecordAt: 2 });
		const result = await executeTopologySourceSplit(admittedInput(), fx.value);
		assert.equal(result.outcome === "partial" && result.arm, "record-failed");
		assert.deepEqual(
			fx.calls.filter((call) => call.startsWith("write:")),
			["write:1"],
		);
	});
	it("replays a consumed success without another write", async () => {
		const fx = effects();
		const original = admittedInput();
		assert.equal((await executeTopologySourceSplit(original, fx.value)).outcome, "success");
		const writes = fx.calls.filter((call) => call.startsWith("write:")).length;
		const replay = { ...admittedInput(), comments: fx.comments };
		const result = await executeTopologySourceSplit(replay, fx.value);
		assert.equal(result.outcome === "success" && result.replay, true);
		assert.equal(fx.calls.filter((call) => call.startsWith("write:")).length, writes);
	});
	it("recovers a valid recorded prefix without rewriting it and stops if its live state differs", async () => {
		const seed = effects();
		assert.equal((await executeTopologySourceSplit(admittedInput(), seed.value)).outcome, "success");
		const prefix = seed.comments.filter(
			(comment) =>
				comment.body.includes(TOPOLOGY_SOURCE_CLAIM_MARKER) ||
				(comment.body.includes(TOPOLOGY_SOURCE_STEP_MARKER) && comment.body.includes('"order":1')),
		);
		const continuation = effects();
		const result = await executeTopologySourceSplit({ ...admittedInput(), comments: prefix }, continuation.value);
		assert.equal(result.outcome, "success");
		assert.deepEqual(
			continuation.calls.filter((call) => call.startsWith("write:")),
			["write:2"],
		);

		const mismatch = effects({ drift: true });
		const refused = await executeTopologySourceSplit({ ...admittedInput(), comments: prefix }, mismatch.value);
		assert.equal(refused.outcome === "partial" && refused.arm, "partial-consumed");
		assert.equal(
			mismatch.calls.some((call) => call.startsWith("write:")),
			false,
		);
	});
	it("never accepts a success terminal without its winning claim and full steps", async () => {
		const seed = effects();
		assert.equal((await executeTopologySourceSplit(admittedInput(), seed.value)).outcome, "success");
		const terminalOnly = seed.comments.filter((comment) => comment.body.includes("topology-source-terminal"));
		const replay = effects();
		const result = await executeTopologySourceSplit({ ...admittedInput(), comments: terminalOnly }, replay.value);
		assert.equal(result.outcome === "partial" && result.arm, "partial-consumed");
		assert.equal(
			replay.calls.some((call) => call.startsWith("write:")),
			false,
		);
	});
	it("loses a competing append-only claim to the lowest REST id", async () => {
		const fx = effects();
		const originalRead = fx.value.readComments;
		fx.value.readComments = async () => {
			const current = await originalRead();
			const appended = current?.[0];
			return appended
				? [
						{ ...appended, nodeId: "EARLIER", databaseId: 1 },
						{ ...appended, databaseId: 2 },
					]
				: current;
		};
		const result = await executeTopologySourceSplit(admittedInput(), fx.value);
		assert.equal(result.outcome === "refused" && result.arm, "claim-conflict");
		assert.equal(
			fx.calls.some((call) => call.startsWith("write:")),
			false,
		);
	});
	it("refuses foreign record ownership and reordered recorded steps", async () => {
		const owned = admittedInput();
		if (!owned.authorization.ok) throw new Error("fixture authorization");
		const claim: TopologySourceClaimRecord = {
			schemaVersion: 1,
			repositoryId: "R",
			issueId: "I",
			authorizationRecordId: "AR",
			planHash: owned.plan.artifactHash,
			pairKey: owned.authorization.authorization.pairKey,
			correlationId: owned.plan.correlationId,
			writerId: "V",
			claimedAt: now,
		};
		owned.comments = [
			{
				nodeId: "C",
				databaseId: 1,
				authorId: "V",
				createdAt: now,
				updatedAt: now,
				body: encodeTopologySourceRecord(TOPOLOGY_SOURCE_CLAIM_MARKER, claim),
			},
		];
		let fx = effects();
		let result = await executeTopologySourceSplit(owned, fx.value);
		assert.equal(result.outcome === "refused" && result.arm, "ownership-mismatch");

		const reordered = admittedInput();
		if (!reordered.authorization.ok) throw new Error("fixture authorization");
		claim.writerId = "U";
		const step = reordered.plan.steps[1];
		const stepRecord: TopologySourceStepRecord = {
			schemaVersion: 1,
			repositoryId: "R",
			issueId: "I",
			claimCommentId: "C",
			authorizationRecordId: "AR",
			planHash: reordered.plan.artifactHash,
			pairKey: reordered.authorization.authorization.pairKey,
			order: 2,
			method: step.method,
			path: step.path,
			requestBodyDigest: "body" in step ? topologySourceDigest(step.body) : null,
			beforeStateDigest: topologySourceDigest(reordered.plan.steps[0]?.postRead),
			afterStateDigest: topologySourceDigest(step.postRead),
			observedAt: now,
			writerId: "U",
		};
		reordered.comments = [
			{
				nodeId: "C",
				databaseId: 1,
				authorId: "U",
				createdAt: now,
				updatedAt: now,
				body: encodeTopologySourceRecord(TOPOLOGY_SOURCE_CLAIM_MARKER, claim),
			},
			{
				nodeId: "S",
				databaseId: 2,
				authorId: "U",
				createdAt: now,
				updatedAt: now,
				body: encodeTopologySourceRecord(TOPOLOGY_SOURCE_STEP_MARKER, stepRecord),
			},
		];
		fx = effects();
		result = await executeTopologySourceSplit(reordered, fx.value);
		assert.equal(result.outcome === "partial" && result.arm, "partial-consumed");
		assert.equal(
			fx.calls.some((call) => call.startsWith("write:")),
			false,
		);
	});
});

function platformFixture(options: { topologyBlobSha?: string } = {}) {
	const actionsId = 15368;
	const current = {
		id: 20,
		...desiredCoreRuleset(actionsId),
		name: "ghjig-tier3",
		source_type: "Repository",
		source: "o/r",
		updated_at: "2026-09-19T14:00:00.000Z",
	};
	let comments: unknown[][] = [[]];
	let writtenComment: Record<string, unknown> | undefined;
	const calls: string[][] = [];
	const mutations: Array<{ argv: string[]; body?: unknown }> = [];
	const read = async (argv: string[]) => {
		calls.push(argv);
		const endpoint = argv.at(-1) ?? "";
		if (endpoint === "repos/o/r")
			return JSON.stringify({
				node_id: "R",
				default_branch: "main",
				allow_merge_commit: true,
				allow_squash_merge: true,
				allow_rebase_merge: true,
			});
		if (endpoint === "user") return JSON.stringify({ node_id: "U", login: "operator" });
		if (endpoint === "apps/github-actions") return JSON.stringify({ id: actionsId });
		if (endpoint.includes("contents/.github/workflows/landing-topology.mjs?ref=main"))
			return JSON.stringify({
				sha: options.topologyBlobSha ?? gitBlobOid(readFileSync(".github/workflows/landing-topology.mjs")),
			});
		if (endpoint.includes("rulesets?")) return JSON.stringify([[{ id: 20 }]]);
		if (endpoint === "repos/o/r/rulesets/20") return JSON.stringify(current);
		if (endpoint.includes("collaborators/operator/permission")) return JSON.stringify({ role_name: "admin" });
		if (endpoint === "repos/o/r/issues/293") return JSON.stringify({ node_id: "I", number: 293, state: "open" });
		if (endpoint.includes("issues/293/comments?")) return JSON.stringify(comments);
		if (endpoint.includes("issues/comments/") && writtenComment) return JSON.stringify(writtenComment);
		return undefined;
	};
	const mutate = async (argv: string[]) => {
		mutations.push({ argv });
		return "";
	};
	const mutateJson = async (argv: string[], body: unknown) => {
		mutations.push({ argv, body });
		writtenComment = {
			node_id: "T",
			id: 9,
			created_at: now,
			updated_at: now,
			body: (body as { body: string }).body,
			user: { node_id: "U" },
		};
		return JSON.stringify(writtenComment);
	};
	return {
		calls,
		mutations,
		read,
		mutate,
		mutateJson,
		setComments: (value: unknown[][]) => {
			comments = value;
		},
	};
}

function authorizedPlatformFixture(options: { extraHuman?: boolean; failTerminalOnce?: boolean } = {}) {
	const actionsId = 15368;
	let settings = { allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true };
	let rulesets: Array<Record<string, unknown>> = [
		{
			id: 20,
			...desiredCoreRuleset(actionsId),
			source_type: "Repository",
			source: "o/r",
			updated_at: "2026-09-19T14:00:00.000Z",
		},
		{
			id: 21,
			...desiredCoreRuleset(actionsId),
			name: "legacy-duplicate",
			source_type: "Repository",
			source: "o/r",
			updated_at: "2026-09-19T14:00:00.000Z",
		},
	];
	let comments: Array<Record<string, unknown>> = [];
	let nextComment = 100;
	let terminalFailureRemaining = options.failTerminalOnce === true;
	const sourceWrites: Array<{ method: string; endpoint: string; body?: unknown }> = [];
	const read = async (argv: string[]) => {
		const endpoint = argv.at(-1) ?? "";
		if (endpoint === "repos/o/r") return JSON.stringify({ node_id: "R", default_branch: "main", ...settings });
		if (endpoint === "user") return JSON.stringify({ node_id: "U", login: "operator" });
		if (endpoint === "apps/github-actions") return JSON.stringify({ id: actionsId });
		if (endpoint.includes("contents/.github/workflows/landing-topology.mjs?ref=main"))
			return JSON.stringify({ sha: gitBlobOid(readFileSync(".github/workflows/landing-topology.mjs")) });
		if (endpoint.includes("rulesets?")) return JSON.stringify([rulesets.map(({ id }) => ({ id }))]);
		const ruleset = /^repos\/o\/r\/rulesets\/(\d+)$/u.exec(endpoint);
		if (ruleset) return JSON.stringify(rulesets.find((item) => item.id === Number(ruleset[1])));
		if (endpoint.includes("collaborators/operator/permission")) return JSON.stringify({ role_name: "admin" });
		if (endpoint === "repos/o/r/issues/293") return JSON.stringify({ node_id: "I", number: 293, state: "open" });
		if (endpoint.includes("issues/293/comments?")) return JSON.stringify([comments]);
		const commentId = /issues\/comments\/(\d+)$/u.exec(endpoint);
		if (commentId) return JSON.stringify(comments.find((item) => item.id === Number(commentId[1])));
		return undefined;
	};
	const append = (body: string) => {
		const item = {
			node_id: `C${nextComment}`,
			id: nextComment,
			created_at: now,
			updated_at: now,
			body,
			user: { node_id: "U", login: "operator", type: "User" },
		};
		nextComment += 1;
		comments.push(item);
		return item;
	};
	const mutateJson = async (argv: string[], body: unknown) => {
		const method = argv[argv.indexOf("--method") + 1] ?? "";
		const endpoint = argv.find((part) => part.startsWith("repos/")) ?? "";
		if (endpoint.endsWith("issues/293/comments")) {
			const commentBody = (body as { body: string }).body;
			if (terminalFailureRemaining && commentBody.includes("topology-source-terminal")) {
				terminalFailureRemaining = false;
				return undefined;
			}
			return JSON.stringify(append(commentBody));
		}
		sourceWrites.push({ method, endpoint, body });
		if (method === "PATCH" && endpoint === "repos/o/r/rulesets/20")
			rulesets = rulesets.map((item) =>
				item.id === 20
					? {
							id: 20,
							...(body as object),
							source_type: "Repository",
							source: "o/r",
							updated_at: "2026-09-19T15:00:01.000Z",
						}
					: item,
			);
		else if (method === "POST" && endpoint === "repos/o/r/rulesets") {
			rulesets.push({
				id: 22,
				...(body as object),
				source_type: "Repository",
				source: "o/r",
				updated_at: "2026-09-19T15:00:02.000Z",
			});
			if (options.extraHuman)
				rulesets.push({
					id: 23,
					...desiredHumanApprovalRuleset(),
					source_type: "Repository",
					source: "o/r",
					updated_at: "2026-09-19T15:00:03.000Z",
				});
		} else if (method === "PATCH" && endpoint === "repos/o/r") settings = body as typeof settings;
		return "{}";
	};
	const mutate = async (argv: string[]) => {
		const method = argv[argv.indexOf("--method") + 1] ?? "";
		const endpoint = argv.find((part) => part.startsWith("repos/")) ?? "";
		sourceWrites.push({ method, endpoint });
		if (method === "DELETE") rulesets = rulesets.filter((item) => item.id !== Number(endpoint.split("/").at(-1)));
		return "";
	};
	return {
		read,
		mutate,
		mutateJson,
		sourceWrites,
		authorize: (artifact: TopologyPlan) => {
			const value = {
				schemaVersion: 1,
				repositoryId: "R",
				issueId: "I",
				issueNumber: 293,
				stage: "source-split",
				planHash: artifact.artifactHash,
				pairKey: topologySourcePairKey(artifact),
				correlationId: artifact.correlationId,
				issuedAt: "2026-09-19T14:59:00.000Z",
				expiresAt: "2026-09-19T16:00:00.000Z",
			};
			comments = [
				{
					node_id: "AUTH",
					id: 7,
					created_at: value.issuedAt,
					updated_at: value.issuedAt,
					body: `${TOPOLOGY_AUTHORIZATION_MARKER}\n${JSON.stringify(value)}`,
					user: { node_id: "U", login: "operator", type: "User" },
				},
			];
		},
	};
}

describe("#293 source-split platform boundary", () => {
	it("refuses before loading the planner when default-branch engine bytes differ", async () => {
		const seam = platformFixture({ topologyBlobSha: "0".repeat(40) });
		const loaded = await loadTopologySourceApplication(
			"github.com",
			"o/r",
			293,
			now,
			process.cwd(),
			undefined,
			seam.read,
			seam.mutate,
			seam.mutateJson,
		);
		assert.equal(loaded.arm, "population-incomplete");
		assert.equal(seam.mutations.length, 0);
	});
	it("executes the exact authorized PATCH/POST/PATCH/DELETE platform sequence", async () => {
		const seam = authorizedPlatformFixture();
		const preview = await loadTopologySourceApplication(
			"github.com",
			"o/r",
			293,
			now,
			process.cwd(),
			undefined,
			seam.read,
			seam.mutate,
			seam.mutateJson,
		);
		assert.ok(preview.input);
		seam.authorize(preview.input?.plan as TopologyPlan);
		const loaded = await loadTopologySourceApplication(
			"github.com",
			"o/r",
			293,
			now,
			process.cwd(),
			preview.input?.plan,
			seam.read,
			seam.mutate,
			seam.mutateJson,
		);
		const result = await executePlatformTopologySource(loaded);
		assert.equal(result.outcome, "success");
		assert.deepEqual(
			seam.sourceWrites.map(({ method, endpoint }) => [method, endpoint]),
			[
				["PATCH", "repos/o/r/rulesets/20"],
				["POST", "repos/o/r/rulesets"],
				["PATCH", "repos/o/r"],
				["DELETE", "repos/o/r/rulesets/21"],
			],
		);
		assert.deepEqual(seam.sourceWrites[2]?.body, {
			allow_merge_commit: true,
			allow_squash_merge: false,
			allow_rebase_merge: false,
		});
		const replayLoaded = await loadTopologySourceApplication(
			"github.com",
			"o/r",
			293,
			now,
			process.cwd(),
			preview.input?.plan,
			seam.read,
			seam.mutate,
			seam.mutateJson,
		);
		const replay = await executePlatformTopologySource(replayLoaded);
		assert.equal(replay.outcome === "success" && replay.replay, true);
		assert.equal(seam.sourceWrites.length, 4);
	});
	it("recovers a fully recorded platform run whose terminal publication failed", async () => {
		const seam = authorizedPlatformFixture({ failTerminalOnce: true });
		const preview = await loadTopologySourceApplication(
			"github.com",
			"o/r",
			293,
			now,
			process.cwd(),
			undefined,
			seam.read,
			seam.mutate,
			seam.mutateJson,
		);
		seam.authorize(preview.input?.plan as TopologyPlan);
		let loaded = await loadTopologySourceApplication(
			"github.com",
			"o/r",
			293,
			now,
			process.cwd(),
			preview.input?.plan,
			seam.read,
			seam.mutate,
			seam.mutateJson,
		);
		const first = await executePlatformTopologySource(loaded);
		assert.equal(first.outcome === "partial" && first.arm, "record-failed");
		assert.equal(seam.sourceWrites.length, 4);
		loaded = await loadTopologySourceApplication(
			"github.com",
			"o/r",
			293,
			now,
			process.cwd(),
			preview.input?.plan,
			seam.read,
			seam.mutate,
			seam.mutateJson,
		);
		const recovered = await executePlatformTopologySource(loaded);
		assert.equal(recovered.outcome, "success");
		assert.equal(seam.sourceWrites.length, 4);
	});
	it("stops after a concurrent extra human ruleset appears in the post-read", async () => {
		const seam = authorizedPlatformFixture({ extraHuman: true });
		const preview = await loadTopologySourceApplication(
			"github.com",
			"o/r",
			293,
			now,
			process.cwd(),
			undefined,
			seam.read,
			seam.mutate,
			seam.mutateJson,
		);
		seam.authorize(preview.input?.plan as TopologyPlan);
		const loaded = await loadTopologySourceApplication(
			"github.com",
			"o/r",
			293,
			now,
			process.cwd(),
			preview.input?.plan,
			seam.read,
			seam.mutate,
			seam.mutateJson,
		);
		const result = await executePlatformTopologySource(loaded);
		assert.equal(result.outcome === "partial" && result.arm, "postread-mismatch");
		assert.deepEqual(
			seam.sourceWrites.map(({ method }) => method),
			["PATCH", "POST"],
		);
	});
	it("derives authorization absence through GETs and writes only its refusal comment", async () => {
		const seam = platformFixture();
		const loaded = await loadTopologySourceApplication(
			"github.com",
			"o/r",
			293,
			now,
			process.cwd(),
			undefined,
			seam.read,
			seam.mutate,
			seam.mutateJson,
		);
		const result = await executePlatformTopologySource(loaded);
		assert.equal(result.outcome === "refused" && result.arm, "authorization-absent");
		assert.equal(seam.mutations.length, 1);
		assert.ok(seam.mutations[0]?.argv.some((part) => part.endsWith("issues/293/comments")));
		assert.equal(
			seam.mutations.some(({ argv }) => argv.some((part) => part.includes("rulesets") || part === "repos/o/r")),
			false,
		);
	});
	it("classifies duplicate, edited, copied, and stale authorization without a source mutation", async () => {
		const base = platformFixture();
		const first = await loadTopologySourceApplication(
			"github.com",
			"o/r",
			293,
			now,
			process.cwd(),
			undefined,
			base.read,
			base.mutate,
			base.mutateJson,
		);
		assert.ok(first.input);
		const artifact = first.input?.plan as TopologyPlan;
		const authorization = {
			schemaVersion: 1,
			repositoryId: "R",
			issueId: "I",
			issueNumber: 293,
			stage: "source-split",
			planHash: artifact.artifactHash,
			pairKey: topologySourcePairKey(artifact),
			correlationId: artifact.correlationId,
			issuedAt: "2026-09-19T14:00:00.000Z",
			expiresAt: "2026-09-19T14:30:00.000Z",
		};
		const candidate = (overrides: Record<string, unknown> = {}) => ({
			node_id: "A",
			id: 7,
			created_at: authorization.issuedAt,
			updated_at: authorization.issuedAt,
			body: `${TOPOLOGY_AUTHORIZATION_MARKER}\n${JSON.stringify(authorization)}`,
			user: { node_id: "U", login: "operator", type: "User" },
			...overrides,
		});
		for (const [population, arm] of [
			[[candidate(), candidate({ node_id: "B" })], "authorization-ambiguous"],
			[[candidate({ updated_at: "2026-09-19T14:00:01.000Z" })], "authorization-unattested"],
			[[candidate({ user: { node_id: "V", login: "other", type: "User" } })], "authorization-unattested"],
			[[candidate()], "authorization-stale"],
		] as const) {
			const seam = platformFixture();
			seam.setComments([[...population]]);
			const loaded = await loadTopologySourceApplication(
				"github.com",
				"o/r",
				293,
				now,
				process.cwd(),
				undefined,
				seam.read,
				seam.mutate,
				seam.mutateJson,
			);
			assert.equal(loaded.input?.authorization.ok, false);
			if (loaded.input?.authorization.ok === false) assert.equal(loaded.input.authorization.arm, arm);
			assert.equal(seam.mutations.length, 0);
		}
	});
});

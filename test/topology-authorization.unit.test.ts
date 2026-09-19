import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { canonicalInstant } from "../.github/workflows/landing-topology.mjs";
import {
	loadTopologyAuthorization,
	TOPOLOGY_AUTHORIZATION_MARKER,
} from "../.pi/extensions/gitjig/landing/topology-authorization.ts";

const hex = (value: string) => value.repeat(64);
const record = {
	schemaVersion: 1,
	repositoryId: "REPO",
	issueId: "ISSUE",
	issueNumber: 286,
	stage: "carrier-bootstrap",
	planHash: hex("a"),
	pairKey: hex("b"),
	correlationId: hex("c"),
	issuedAt: "2026-09-19T00:00:00.000Z",
	expiresAt: "2026-09-19T01:00:00.000Z",
};
const comment = {
	node_id: "COMMENT",
	created_at: record.issuedAt,
	updated_at: record.issuedAt,
	body: `${TOPOLOGY_AUTHORIZATION_MARKER}\n${JSON.stringify(record)}`,
	user: { node_id: "ACTOR", login: "operator", type: "User" },
};
const topologyEngine = {
	canonicalInstant,
	attestLandingTopology: () => ({ ok: false }),
	encodeLandingTopology: () => undefined,
};

function reader(overrides: { comments?: unknown; role?: string; viewerId?: string; repositoryId?: string } = {}) {
	const calls: string[][] = [];
	const read = async (argv: string[]) => {
		calls.push(argv);
		const endpoint = argv.at(-1);
		if (endpoint === "repos/o/r") return JSON.stringify({ node_id: overrides.repositoryId ?? "REPO" });
		if (endpoint === "user") return JSON.stringify({ node_id: overrides.viewerId ?? "ACTOR" });
		if (endpoint === "repos/o/r/issues/286") return JSON.stringify({ node_id: "ISSUE", number: 286 });
		if (endpoint?.includes("issues/286/comments")) return JSON.stringify(overrides.comments ?? [[comment]]);
		if (endpoint?.includes("collaborators/operator/permission"))
			return JSON.stringify({ role_name: overrides.role ?? "admin" });
		return undefined;
	};
	return { calls, read };
}

describe("#286 GET-only topology authorization acquisition", () => {
	it("has no mutation seam or production bootstrap call site", () => {
		const root = join(import.meta.dirname, "..");
		const source = readFileSync(join(root, ".pi/extensions/gitjig/landing/topology-authorization.ts"), "utf8");
		assert.doesNotMatch(source, /runPlatformMutation|platform\/write|--method|\bPOST\b|\bPATCH\b|\bDELETE\b/u);
		const command = readFileSync(join(root, ".pi/extensions/gitjig/commands/land.ts"), "utf8");
		assert.doesNotMatch(command, /bootstrap|topology-authorization/u);
	});
	it("derives every trust operand from complete platform facts", async () => {
		const seam = reader();
		const result = await loadTopologyAuthorization(
			"github.com",
			"o/r",
			286,
			"2026-09-19T00:30:00Z",
			topologyEngine,
			"/repo",
			seam.read,
		);
		assert.equal(result.ok, true);
		if (result.ok)
			assert.deepEqual(result.authorization, {
				schemaVersion: 1,
				recordId: "COMMENT",
				repositoryId: "REPO",
				stage: "carrier-bootstrap",
				planHash: record.planHash,
				pairKey: record.pairKey,
				actorId: "ACTOR",
				actorPermission: "admin",
				correlationId: record.correlationId,
				issuedAt: record.issuedAt,
				expiresAt: record.expiresAt,
			});
		assert.ok(seam.calls.every((argv) => !argv.includes("--method")));
		assert.ok(seam.calls.some((argv) => argv.includes("--paginate") && argv.includes("--slurp")));
	});

	it("refuses incomplete, duplicate, edited, copied, foreign, non-admin and stale records", async () => {
		const load = async (overrides: Parameters<typeof reader>[0], now = "2026-09-19T00:30:00Z") =>
			loadTopologyAuthorization("github.com", "o/r", 286, now, topologyEngine, "/repo", reader(overrides).read);
		assert.equal((await load({ comments: [comment] })).ok, false);
		assert.equal((await load({ comments: [[comment, { ...comment, node_id: "OTHER" }]] })).ok, false);
		assert.equal((await load({ comments: [[{ ...comment, updated_at: "2026-09-19T00:00:01Z" }]] })).ok, false);
		assert.equal((await load({ repositoryId: "OTHER" })).ok, false);
		assert.equal((await load({ viewerId: "OTHER" })).ok, false);
		assert.equal((await load({ role: "write" })).ok, false);
		assert.equal((await load({}, record.expiresAt)).ok, false);
		assert.equal((await load({}, "2026-09-18T23:59:59Z")).ok, false);
	});
});

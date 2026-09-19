/** Warning-surface roster: EXEMPT — GET-only authorization reads return fixed arm tokens. */
import { runPlatformRead } from "../platform/read.ts";
import type { BootstrapAuthorization, BootstrapTopologyEngine } from "./bootstrap.ts";

export const TOPOLOGY_AUTHORIZATION_MARKER = "<!-- topology-plan-authorization: v1 -->";
export type TopologyAuthorizationRead = (argv: string[], repoRoot: string) => Promise<string | undefined>;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	const item = record(value);
	return (
		item !== undefined &&
		Object.keys(item).length === keys.length &&
		Object.keys(item).every((key) => keys.includes(key))
	);
}
function nonempty(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value === value.normalize("NFC") &&
		![...value].some((character) => {
			const point = character.codePointAt(0) ?? 0;
			return point < 32 || (point >= 127 && point <= 159) || point === 0x2028 || point === 0x2029;
		})
	);
}
function validRepository(value: string): boolean {
	return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value);
}
function parse(value: string | undefined): unknown {
	if (value === undefined) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}
export function parseTopologyAuthorization(body: unknown): Record<string, unknown> | undefined {
	if (typeof body !== "string" || !body.startsWith(`${TOPOLOGY_AUTHORIZATION_MARKER}\n`)) return undefined;
	if (body.indexOf(TOPOLOGY_AUTHORIZATION_MARKER, TOPOLOGY_AUTHORIZATION_MARKER.length) !== -1) return undefined;
	const value = parse(body.slice(TOPOLOGY_AUTHORIZATION_MARKER.length + 1));
	if (
		!exact(value, [
			"schemaVersion",
			"repositoryId",
			"issueId",
			"issueNumber",
			"stage",
			"planHash",
			"pairKey",
			"correlationId",
			"issuedAt",
			"expiresAt",
		]) ||
		value.schemaVersion !== 1 ||
		!["source-split", "carrier-bootstrap"].includes(String(value.stage)) ||
		!Number.isSafeInteger(value.issueNumber) ||
		Number(value.issueNumber) <= 0 ||
		![
			value.repositoryId,
			value.issueId,
			value.stage,
			value.planHash,
			value.pairKey,
			value.correlationId,
			value.issuedAt,
			value.expiresAt,
		].every(nonempty) ||
		![
			/^[0-9a-f]{64}$/u.test(String(value.planHash)),
			/^[0-9a-f]{64}$/u.test(String(value.pairKey)),
			/^[0-9a-f]{64}$/u.test(String(value.correlationId)),
		].every(Boolean)
	)
		return undefined;
	return value;
}

export async function loadTopologyAuthorization(
	host: string,
	repositoryName: string,
	issueNumber: number,
	now: string,
	topologyEngine: BootstrapTopologyEngine,
	repoRoot: string,
	read: TopologyAuthorizationRead = runPlatformRead,
): Promise<{ ok: true; authorization: BootstrapAuthorization } | { ok: false; arm: string }> {
	if (!nonempty(host) || !validRepository(repositoryName) || !Number.isSafeInteger(issueNumber) || issueNumber <= 0)
		return { ok: false, arm: "authorization-subject-invalid" };
	const api = async (endpoint: string, paginate = false): Promise<unknown> => {
		const argv = ["--hostname", host, "api"];
		if (paginate) argv.push("--paginate", "--slurp");
		argv.push(endpoint);
		return parse(await read(argv, repoRoot));
	};
	const [repositoryRaw, viewerRaw, issueRaw, commentsRaw] = await Promise.all([
		api(`repos/${repositoryName}`),
		api("user"),
		api(`repos/${repositoryName}/issues/${issueNumber}`),
		api(`repos/${repositoryName}/issues/${issueNumber}/comments?per_page=100`, true),
	]);
	const repository = record(repositoryRaw);
	const viewer = record(viewerRaw);
	const issue = record(issueRaw);
	if (
		!repository ||
		!viewer ||
		!issue ||
		!nonempty(repository.node_id) ||
		!nonempty(viewer.node_id) ||
		!nonempty(issue.node_id) ||
		issue.number !== issueNumber
	)
		return { ok: false, arm: "authorization-platform-unavailable" };
	if (!Array.isArray(commentsRaw) || commentsRaw.some((page) => !Array.isArray(page)))
		return { ok: false, arm: "authorization-population-incomplete" };
	const marked = commentsRaw
		.flat()
		.filter(
			(comment) =>
				typeof record(comment)?.body === "string" &&
				String(record(comment)?.body).includes(TOPOLOGY_AUTHORIZATION_MARKER),
		);
	if (marked.length !== 1)
		return { ok: false, arm: marked.length === 0 ? "authorization-absent" : "authorization-ambiguous" };
	const comment = record(marked[0]);
	const author = record(comment?.user);
	const value = parseTopologyAuthorization(comment?.body);
	if (
		!comment ||
		!author ||
		!value ||
		!nonempty(comment.node_id) ||
		!nonempty(comment.created_at) ||
		comment.created_at !== comment.updated_at ||
		author.type !== "User" ||
		!nonempty(author.node_id) ||
		!nonempty(author.login) ||
		author.node_id !== viewer.node_id ||
		value.repositoryId !== repository.node_id ||
		value.issueId !== issue.node_id ||
		value.issueNumber !== issueNumber
	)
		return { ok: false, arm: "authorization-unattested" };
	const permission = record(
		await api(`repos/${repositoryName}/collaborators/${encodeURIComponent(author.login)}/permission`),
	);
	if (permission?.role_name !== "admin") return { ok: false, arm: "authorization-actor-not-admin" };
	const issuedAt = topologyEngine.canonicalInstant(value.issuedAt);
	const expiresAt = topologyEngine.canonicalInstant(value.expiresAt);
	const observedAt = topologyEngine.canonicalInstant(now);
	const createdAt = topologyEngine.canonicalInstant(comment.created_at);
	if (
		!issuedAt ||
		!expiresAt ||
		!observedAt ||
		!createdAt ||
		issuedAt !== createdAt ||
		Date.parse(issuedAt) > Date.parse(observedAt) ||
		Date.parse(expiresAt) <= Date.parse(observedAt) ||
		Date.parse(expiresAt) <= Date.parse(issuedAt)
	)
		return { ok: false, arm: "authorization-time-invalid" };
	return {
		ok: true,
		authorization: {
			schemaVersion: 1,
			recordId: comment.node_id,
			repositoryId: String(value.repositoryId),
			stage: value.stage as "source-split" | "carrier-bootstrap",
			planHash: String(value.planHash),
			pairKey: String(value.pairKey),
			actorId: author.node_id,
			actorPermission: "admin",
			correlationId: String(value.correlationId),
			issuedAt,
			expiresAt,
		},
	};
}

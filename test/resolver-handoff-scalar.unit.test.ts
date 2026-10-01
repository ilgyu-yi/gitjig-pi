/**
 * #406 — the Resolver-repair publication reads `gh --jq` scalars, and `gh`
 * terminates a scalar with one U+000A. These arms drive
 * `publishResolverRepairHandoff` through its production `read` default against
 * a `gh` PATH stub, so the normalization is measured where it is used, not
 * only where it is defined.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runPlatformRead } from "../.pi/extensions/gitjig/platform/read.ts";
import { publishResolverRepairHandoff } from "../.pi/extensions/gitjig/review/publication.ts";
import type { ReviewSubject } from "../.pi/extensions/gitjig/review/subject.ts";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const NOW = "2026-10-01T00:00:00.000Z";
const CAUSE_IDENTITY = "the Resolver writer identity was unavailable";
const CAUSE_AUTHORITY = "the Resolver writer lacked current collaborator authority";
const CAUSE_AMBIGUOUS = "the current lifecycle record population was ambiguous";

function subject(): ReviewSubject {
	return {
		context: {
			repository: { id: "R", host: "github.com", nameWithOwner: "owner/repo" },
			pullRequest: {
				id: "P",
				number: 7,
				url: "https://github.com/owner/repo/pull/7",
				authorId: "AUTHOR",
				base: { repositoryId: "R", name: "main", oid: BASE },
				head: { repositoryId: "R", name: "feature", oid: HEAD },
				closingIssues: [],
			},
		},
		writerId: "WRITER",
		activation: [],
		criteria: [],
	};
}

/** A current record carried by another authorized Resolver: the attested carrier. */
const CARRIER_BODY = `<!-- lifecycle-awaiting-author-record: v1 -->\n\n\`\`\`json\n${JSON.stringify({
	producer: "OTHER",
	producerKind: "resolver-repair",
	observedAt: NOW,
	subjectHead: HEAD,
	baseHead: BASE,
})}\n\`\`\``;

/**
 * A `gh` whose `--jq` scalars are emitted exactly as the real one emits them,
 * with each arm's literal bytes. The writer's own login and the carrier's are
 * separate reads, so one arm can carry a defective scalar alone.
 */
function stubbedGh(login: string, writerRole: string, carrierRole: string): string {
	const bin = mkdtempSync(join(tmpdir(), "gitjig-406-gh-"));
	dirs.push(bin);
	const literal = (value: string) => `'${value.replaceAll("\n", "\\n")}'`;
	writeFileSync(
		join(bin, "gh"),
		`#!/bin/sh\ncase "$*" in\n*.login*) printf ${literal(login)} ;;\n*collaborators/other/permission*) printf ${literal(carrierRole)} ;;\n*.role_name*) printf ${literal(writerRole)} ;;\n*.labels*) printf 'awaiting-author\\n' ;;\n*) exit 1 ;;\nesac\n`,
		{ mode: 0o755 },
	);
	return bin;
}

type Attempt = { outcome: Awaited<ReturnType<typeof publishResolverRepairHandoff>>; publications: number };

async function publish(login: string, writerRole: string, carrierRole: string): Promise<Attempt> {
	const bin = stubbedGh(login, writerRole, carrierRole);
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path ?? ""}`;
	let publications = 0;
	try {
		const outcome = await publishResolverRepairHandoff(subject(), bin, join(bin, "state"), () => NOW, {
			fetchComments: async () => ({
				ok: true,
				comments: [{ id: 5, authorId: "OTHER", authorLogin: "other", authorType: "User", body: CARRIER_BODY }],
			}),
			publishRecord: async () => {
				publications += 1;
				return { ok: false, cause: "a second current record was attempted" };
			},
			mutate: async () => true,
			// The production default itself: this seam is the one `gh`-spawning reader.
			read: runPlatformRead,
		});
		return { outcome, publications };
	} finally {
		process.env.PATH = path;
	}
}

describe("#406 Resolver-repair publication reads gh scalars", () => {
	it("admits a newline-terminated login, writer role and carrier role through the default read", async () => {
		const { outcome, publications } = await publish("stubwriter\n", "admin\n", "admin\n");
		assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.cause);
		assert.equal(publications, 0);
	});

	it("refuses a login carrying a second trailing newline", async () => {
		const { outcome } = await publish("stubwriter\n\n", "admin\n", "admin\n");
		assert.equal(outcome.ok, false);
		assert.equal(outcome.ok === false && outcome.cause, CAUSE_IDENTITY);
	});

	it("refuses a writer role carrying surrounding whitespace", async () => {
		const { outcome } = await publish("stubwriter\n", " admin\n", "admin\n");
		assert.equal(outcome.ok, false);
		assert.equal(outcome.ok === false && outcome.cause, CAUSE_AUTHORITY);
	});

	it("leaves a carrier whose role carries a second newline unattested", async () => {
		const { outcome, publications } = await publish("stubwriter\n", "admin\n", "admin\n\n");
		// An unattested carrier of a current record is not displaced by a second
		// record: the population reads ambiguous and the publication fails closed.
		assert.equal(publications, 0);
		assert.equal(outcome.ok, false);
		assert.equal(outcome.ok === false && outcome.cause, CAUSE_AMBIGUOUS);
	});
});

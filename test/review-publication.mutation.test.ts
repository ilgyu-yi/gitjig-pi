import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "gitjig-381-mutants-"));
after(() => rmSync(root, { recursive: true, force: true }));

const mutations = [
	[
		"collection-route",
		"`repos/${context.repository.nameWithOwner}/issues/comments/${String(locator.id)}`",
		"`repos/${context.repository.nameWithOwner}/issues/${String(context.pullRequest.number)}/comments`",
	],
	["comment-id", 'numberField(payload, "id") !== locator.id', "false"],
	[
		"parent-identity",
		'stringField(payload, "issue_url") !==\n\t\t\t`${apiRoot}/repos/${context.repository.nameWithOwner}/issues/${String(context.pullRequest.number)}`',
		"false",
	],
	["html-locator", 'stringField(payload, "html_url") !== locator.url', "false"],
	["exact-body", 'stringField(payload, "body") !== body', "false"],
	["writer", 'stringField(user, "node_id") !== subject.writerId', "false"],
	[
		"second-read",
		"const receipt = admitTargetedReceipt(subject, body, locator, output);",
		"await read([], repoRoot);\n\tconst receipt = admitTargetedReceipt(subject, body, locator, output);",
	],
	[
		"second-send",
		"const locator = publishedCommentLocator(published, context);",
		"await publishReviewRecord(body, context, repoRoot, stateRoot, publish);\n\tconst locator = publishedCommentLocator(published, context);",
	],
] as const;

function run(name: string, mutation?: (typeof mutations)[number]): ReturnType<typeof spawnSync> {
	const box = mkdtempSync(join(root, `${name}-`));
	cpSync(join(repository, ".pi/extensions/gitjig"), join(box, ".pi/extensions/gitjig"), { recursive: true });
	const workflow = join(box, ".github/workflows/ac-closeout.mjs");
	mkdirSync(dirname(workflow), { recursive: true });
	cpSync(join(repository, ".github/workflows/ac-closeout.mjs"), workflow);
	mkdirSync(join(box, "test"), { recursive: true });
	cpSync(join(repository, "test/review-publication.unit.test.ts"), join(box, "test/review-publication.unit.test.ts"));
	symlinkSync(join(repository, "node_modules"), join(box, "node_modules"), "dir");
	if (mutation !== undefined) {
		const target = join(box, ".pi/extensions/gitjig/review/publication.ts");
		const source = readFileSync(target, "utf8");
		assert.notEqual(source.indexOf(mutation[1]), -1, `${mutation[0]}: mutation target must exist`);
		assert.equal(source.indexOf(mutation[1]), source.lastIndexOf(mutation[1]), `${mutation[0]}: target must be unique`);
		writeFileSync(target, source.replace(mutation[1], mutation[2]));
	}
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	return spawnSync(process.execPath, ["--test", "test/review-publication.unit.test.ts"], {
		cwd: box,
		encoding: "utf8",
		timeout: 30_000,
		env,
	});
}

describe("#381 baseline-first targeted receipt mutants", () => {
	it("passes the isolated baseline", () => {
		const result = run("baseline");
		assert.equal(result.status, 0, String(result.stderr));
	});

	for (const mutation of mutations) {
		it(`kills ${mutation[0]}`, () => {
			const result = run(mutation[0], mutation);
			assert.notEqual(result.status, 0, `${mutation[0]} survived\n${result.stdout}\n${result.stderr}`);
		});
	}
});

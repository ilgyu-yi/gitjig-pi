import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";
import {
	flipRefusalPolarity,
	type PolarityOwner,
	REFUSAL_LITERAL,
	refusalOccurrences,
	validatePolarityOwners,
} from "./harness/fail-closed-polarity.ts";

const repository = join(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "fail-closed-polarity-"));
after(() => rmSync(root, { recursive: true, force: true }));

const owners = [
	{ source: ".github/workflows/ac-closeout.mjs", owner: "test/ac-closeout.mutation.test.ts" },
	{ source: ".github/workflows/ac-closeout-event.mjs", owner: "test/ac-closeout-event.unit.test.ts" },
	{ source: ".github/workflows/gitjig-lifecycle.mjs", owner: "test/lifecycle-governance.unit.test.ts" },
] as const satisfies readonly PolarityOwner[];

function box(name: string): string {
	const destination = mkdtempSync(join(root, `${name}-`));
	cpSync(repository, destination, {
		recursive: true,
		filter: (source) => !new Set([".git", "node_modules", ".gitjig"]).has(basename(source)),
	});
	symlinkSync(join(repository, "node_modules"), join(destination, "node_modules"), "dir");
	return destination;
}

function run(cwd: string, owner: string) {
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	return spawnSync(process.execPath, ["--test", "--test-concurrency=1", owner], {
		cwd,
		encoding: "utf8",
		timeout: 30_000,
		env,
	});
}

describe("repository fail-closed polarity ownership", () => {
	it("owns the complete production refusal-literal corpus exactly once", () => {
		const occurrences = refusalOccurrences(repository);
		validatePolarityOwners(occurrences, owners);
		assert.deepEqual(
			[...new Set(occurrences.map(({ source }) => source))].sort(),
			owners.map(({ source }) => source).sort(),
		);
		const acOwner = readFileSync(join(repository, owners[0].owner), "utf8");
		assert.match(acOwner, /killEveryOccurrence\(/);
		assert.ok(acOwner.includes(JSON.stringify(REFUSAL_LITERAL)));
	});

	it("fails closed on unowned, duplicate, skipped, and drifted ownership inputs", () => {
		const occurrences = refusalOccurrences(repository);
		assert.throws(() => validatePolarityOwners(occurrences, owners.slice(1)), /unowned refusal occurrence/);
		assert.throws(() => validatePolarityOwners(occurrences, [...owners, owners[0]]), /duplicate polarity owner/);
		assert.throws(
			() =>
				validatePolarityOwners(
					occurrences.filter(({ source }) => source !== owners[2].source),
					owners,
				),
			/owner has no refusal occurrence/,
		);
		assert.throws(() => flipRefusalPolarity("no refusal", occurrences[0]), /drifted/);
	});

	it("kills every event and lifecycle refusal-polarity mutant with its focused owner", () => {
		const occurrences = refusalOccurrences(repository).filter(({ source }) => source !== owners[0].source);
		for (const [index, occurrence] of occurrences.entries()) {
			const owner = owners.find(({ source }) => source === occurrence.source);
			assert.ok(owner, `unowned occurrence: ${occurrence.source}`);
			const cwd = box(`polarity-${index + 1}`);
			const target = join(cwd, occurrence.source);
			writeFileSync(target, flipRefusalPolarity(readFileSync(target, "utf8"), occurrence));
			const result = run(cwd, owner.owner);
			assert.notEqual(
				result.status,
				0,
				`${occurrence.source} at ${occurrence.offset}: polarity mutant survived\n${result.stdout}\n${result.stderr}`,
			);
		}
	});
});

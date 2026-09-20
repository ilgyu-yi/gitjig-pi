import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { parseDocument } from "yaml";
import { type ObservedCandidate, observeCandidates } from "../.pi/extensions/gitjig/install/classifier.ts";

const repository = join(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "gitjig-excision-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function handedOver(root = repository): ObservedCandidate[] {
	return observeCandidates(root).filter((candidate) => candidate.disposition === "handed-over");
}

function materialize(candidates: readonly ObservedCandidate[]): string {
	const root = join(scratch, `fixture-${Math.random().toString(16).slice(2)}`);
	mkdirSync(root, { recursive: true });
	for (const candidate of candidates) {
		const destination = join(root, candidate.path);
		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(destination, candidate.bytes);
		if (candidate.path.startsWith(".githooks/")) chmodSync(destination, 0o755);
	}
	return root;
}

const forbiddenDependencies = [
	{ name: "carried path", pattern: /\.pi\/(?:extensions\/gitjig(?:\.ts|\/)|prompts\/)/ },
	{ name: "source-repository locator", pattern: /ilgyu-yi\/gitjig-pi/ },
	{ name: "source contract section", pattern: /(?:SPEC\s+)?§\d|\bSPEC\s+\d+(?:\.\d+)+/ },
	{ name: "development test path", pattern: /(?:^|[\s`'"])(?:test\/|package\.json\b)/m },
	{ name: "source-only declaration", pattern: /^(?:#|\/\/) gitjig: source-only\r?$/m },
] as const;

function dependencyFindings(candidates: readonly ObservedCandidate[]): string[] {
	const findings: string[] = [];
	for (const candidate of candidates) {
		const text = candidate.bytes.toString("utf8");
		for (const rule of forbiddenDependencies) {
			if (rule.pattern.test(text)) findings.push(`${candidate.path}: ${rule.name}`);
		}
		// #276 fixes this engine basename as the cross-tier contract; neutralize only
		// that exact name while continuing to reject every other shell-brand use.
		const neutralizeContractName = (value: string) =>
			value.replaceAll(".gitjig", ".project-state").replaceAll("gitjig-lifecycle.mjs", "lifecycle-engine.mjs");
		if (/gitjig/i.test(neutralizeContractName(text))) findings.push(`${candidate.path}: source-shell branding`);
		if (
			candidate.path !== ".github/workflows/gitjig-governance.mjs" &&
			/gitjig/i.test(neutralizeContractName(candidate.path))
		)
			findings.push(`${candidate.path}: branded handed-over path`);
	}
	return findings;
}

function run(command: string, args: string[], cwd: string, input?: string) {
	return spawnSync(command, args, { cwd, input, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
}

test("#251 derives the handed-over corpus only from the classifier", () => {
	const candidates = handedOver();
	assert.ok(candidates.length > 0);
	assert.equal(
		candidates.some((candidate) => candidate.path.startsWith(".pi/")),
		false,
	);
	assert.deepEqual(dependencyFindings(candidates), []);

	const fixture = materialize(candidates);
	assert.equal(
		observeCandidates(fixture).filter((candidate) => candidate.disposition === "handed-over").length,
		candidates.length,
	);
});

test("#251 named negative fixture catches a handed-over reference to a carried member", () => {
	const negative: ObservedCandidate = {
		path: ".github/workflows/negative.yml",
		disposition: "handed-over",
		bytes: Buffer.from("run: node .pi/extensions/gitjig.ts\n"),
	};
	assert.ok(dependencyFindings([negative]).includes(".github/workflows/negative.yml: carried path"));
	assert.deepEqual(
		dependencyFindings([
			{ ...negative, path: ".github/workflows/gitjig-rival.yml", bytes: Buffer.from("name: rival\n") },
		]),
		[".github/workflows/gitjig-rival.yml: branded handed-over path"],
	);
});

test("#251 handed-over hooks execute after the carried tree is deleted", () => {
	const fixture = materialize(handedOver());
	assert.equal(run("git", ["init", "-q"], fixture).status, 0);
	assert.equal(run("git", ["config", "user.name", "Fixture"], fixture).status, 0);
	assert.equal(run("git", ["config", "user.email", "fixture@example.invalid"], fixture).status, 0);
	assert.equal(run("git", ["config", "commit.gpgsign", "false"], fixture).status, 0);
	assert.equal(run("git", ["config", "core.hooksPath", ".githooks"], fixture).status, 0);
	assert.equal(run("git", ["switch", "-c", "fixture/change"], fixture).status, 0);
	writeFileSync(join(fixture, "README.md"), "fixture\n");
	assert.equal(run("git", ["add", "README.md"], fixture).status, 0);
	const commit = run("git", ["commit", "-q", "-m", "test: verify handed assets"], fixture);
	assert.equal(commit.status, 0, commit.stderr);
	const pushHook = run("bash", [".githooks/pre-push", "origin", "https://example.invalid/repository.git"], fixture, "");
	assert.equal(pushHook.status, 0, pushHook.stderr);
});

test("#251 applicable workflow helpers and authoring templates remain usable in isolation", () => {
	const fixture = materialize(handedOver());
	const handed = handedOver();
	for (const candidate of handed.filter(
		(item) => /\.(?:sh|bash)$/.test(item.path) || item.path.startsWith(".githooks/"),
	)) {
		if (candidate.bytes.subarray(0, 2).toString() !== "#!" && !candidate.path.endsWith(".sh")) continue;
		const syntax = run("bash", ["-n", candidate.path], fixture);
		assert.equal(syntax.status, 0, `${candidate.path}: ${syntax.stderr}`);
	}
	const ssot = run("bash", [".github/workflows/check-ssot-home.sh", "--root", fixture], fixture);
	assert.equal(ssot.status, 0, ssot.stderr);

	mkdirSync(join(fixture, "changelog_unreleased/changed"), { recursive: true });
	writeFileSync(join(fixture, "changelog_unreleased/changed/251.md"), "- Fixture change. (#251)\n");
	const listing = JSON.stringify([[{ filename: "changelog_unreleased/changed/251.md", status: "added" }]]);
	const changelog = run(
		"bash",
		[
			".github/workflows/check-changelog.sh",
			"--pr",
			"251",
			"--expected-count",
			"1",
			"--allowed",
			"251",
			"--root",
			fixture,
		],
		fixture,
		listing,
	);
	assert.equal(changelog.status, 0, `${changelog.stdout}\n${changelog.stderr}`);

	const specPath = join(fixture, "SPEC.md");
	writeFileSync(
		specPath,
		"# Contract\n\n## Table of contents\n\n<!-- TOC START — generated by .github/workflows/build_toc.sh; do not edit by hand -->\n<!-- TOC END -->\n\n## 1. Rule\n",
	);
	const tocWrite = run("bash", [".github/workflows/build_toc.sh", "--spec", specPath], fixture);
	assert.equal(tocWrite.status, 0, tocWrite.stderr);
	const tocCheck = run("bash", [".github/workflows/build_toc.sh", "--check", "--spec", specPath], fixture);
	assert.equal(tocCheck.status, 0, tocCheck.stderr);

	for (const candidate of handed.filter((item) => item.path.endsWith(".yml") || item.path.endsWith(".yaml"))) {
		const document = parseDocument(readFileSync(join(fixture, candidate.path), "utf8"));
		assert.deepEqual(document.errors, [], candidate.path);
	}
	const template = readFileSync(join(fixture, "changelog_unreleased/TEMPLATE.md"), "utf8");
	assert.match(template, /changelog_unreleased\/<category>\/<N>\.md/);
	assert.match(template, /single-line markdown bullet/);
});

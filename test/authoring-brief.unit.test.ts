import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	composeAuthoringBrief,
	registerAuthoringBriefCommand,
} from "../.pi/extensions/gitjig/commands/authoring-brief.ts";
import { repoRoot } from "./harness/run-pi.ts";

const roots: string[] = [];

function input(paths: string[]): string {
	return JSON.stringify({
		plan: "repair the named surface without restating its contracts",
		failingCheck: { description: "the pre-authoring route is not yet established", command: "npm test" },
		paths,
	});
}

function fixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "gitjig-authoring-brief-"));
	roots.push(root);
	mkdirSync(join(root, ".pi/extensions/gitjig/authoring"), { recursive: true });
	cpSync(join(repoRoot(), "SPEC.md"), join(root, "SPEC.md"));
	cpSync(
		join(repoRoot(), ".pi/extensions/gitjig/authoring/policy.json"),
		join(root, ".pi/extensions/gitjig/authoring/policy.json"),
	);
	return root;
}

function headingSet(text: string): string[] {
	return [...text.matchAll(/^### (1\.2|2\.4|2\.5|2\.8) .+$/gm)].map((match) => match[0]).sort();
}

function exactSection(source: string, anchor: string): string {
	const start = source.indexOf(`${anchor}\n`);
	assert.notEqual(start, -1);
	const next = source.slice(start + anchor.length + 1).search(/^###? /m);
	return next < 0 ? source.slice(start) : source.slice(start, start + anchor.length + 1 + next);
}

afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("the on-demand authoring brief", () => {
	it("routes specification prose, tests, and production code to different canonical clause sets", () => {
		const root = fixtureRoot();
		const prose = composeAuthoringBrief(input(["SPEC.md"]), root);
		const test = composeAuthoringBrief(input(["test/example.test.ts"]), root);
		const production = composeAuthoringBrief(input([".pi/extensions/example.ts"]), root);
		assert.equal(prose.complete, true);
		assert.equal(test.complete, true);
		assert.equal(production.complete, true);
		assert.notDeepEqual(headingSet(prose.text), headingSet(test.text));
		assert.notDeepEqual(headingSet(test.text), headingSet(production.text));
		assert.match(
			prose.text,
			/Inherited default authoring act:\n\n- delete \(only on the rendered clause's own terms\)/,
		);
		assert.doesNotMatch(test.text, /- delete/);
	});

	it("injects the completed brief directly into the session working set", async () => {
		const root = fixtureRoot();
		let handler: ((args: string) => Promise<void>) | undefined;
		const messages: unknown[] = [];
		registerAuthoringBriefCommand(
			{
				registerCommand: (_name: string, command: { handler: (args: string) => Promise<void> }) => {
					handler = command.handler;
				},
				sendMessage: (message: unknown) => {
					messages.push(message);
				},
			} as never,
			root,
		);
		assert.ok(handler !== undefined);
		await handler(input(["SPEC.md"]));
		assert.equal(messages.length, 1);
		assert.match(JSON.stringify(messages[0]), /gitjig-authoring-brief/);
		assert.match(JSON.stringify(messages[0]), /AUTHORING BRIEF — COMPLETE/);
	});

	it("renders the canonical section bytes unchanged", () => {
		const root = fixtureRoot();
		const source = readFileSync(join(root, "SPEC.md"), "utf8");
		const result = composeAuthoringBrief(input(["test/example.test.ts"]), root);
		assert.equal(result.complete, true);
		for (const anchor of [
			"### 1.2 Authorization, evidence, and synchronization",
			"### 2.4 Evidence discipline",
			"### 2.5 Authoring doctrine",
			"### 2.8 Artifact surfaces",
		]) {
			assert.ok(result.text.includes(exactSection(source, anchor)), `brief changed canonical bytes at ${anchor}`);
		}
	});

	it("marks missing fields, malformed JSON, and unrouted paths incomplete without claiming readiness", () => {
		for (const raw of ["not-json", JSON.stringify({ plan: "x" }), input(["unowned/example.xyz"])]) {
			const result = composeAuthoringBrief(raw, fixtureRoot());
			assert.equal(result.complete, false);
			assert.match(result.text, /INCOMPLETE \(advisory only\)/);
			assert.match(result.text, /Readiness is not established/);
			assert.doesNotMatch(result.text, /AUTHORING BRIEF — COMPLETE/);
		}
	});

	it("the committed routing policy covers every tracked path without a catch-all", () => {
		const paths = execFileSync("git", ["ls-files"], { cwd: repoRoot(), encoding: "utf8" }).trim().split("\n");
		const result = composeAuthoringBrief(input(paths), repoRoot());
		assert.equal(result.complete, true, result.text);
	});

	it("marks conflicting routes and missing anchors incomplete", () => {
		for (const mutation of ["conflict", "anchor"] as const) {
			const root = fixtureRoot();
			const policyPath = join(root, ".pi/extensions/gitjig/authoring/policy.json");
			const policy = JSON.parse(readFileSync(policyPath, "utf8"));
			if (mutation === "conflict") policy.routes.push({ ...policy.routes[0], surface: "collision" });
			else policy.routes[0].anchors.push("### 9.9 Missing anchor mutant");
			writeFileSync(policyPath, JSON.stringify(policy));
			const result = composeAuthoringBrief(input(["SPEC.md"]), root);
			assert.equal(result.complete, false);
			assert.match(
				result.text,
				mutation === "conflict" ? /conflicting routes/ : /missing or ambiguous canonical anchor/,
			);
		}
	});

	it("rejects an inline anchor decoy after the real heading is removed", () => {
		const root = fixtureRoot();
		const sourcePath = join(root, "SPEC.md");
		const anchor = "### 2.4 Evidence discipline";
		const source = readFileSync(sourcePath, "utf8").replace(`${anchor}\n`, `A quotation names ${anchor}\n`);
		writeFileSync(sourcePath, source);
		const result = composeAuthoringBrief(input(["test/example.test.ts"]), root);
		assert.equal(result.complete, false);
		assert.match(result.text, /missing or ambiguous canonical anchor/);
	});

	it("the route-set witness kills a fixed-selector mutant", () => {
		const root = fixtureRoot();
		const policyPath = join(root, ".pi/extensions/gitjig/authoring/policy.json");
		const policy = JSON.parse(readFileSync(policyPath, "utf8"));
		for (const route of policy.routes) route.anchors = [...policy.routes[0].anchors];
		writeFileSync(policyPath, JSON.stringify(policy));
		const sets = ["SPEC.md", "test/example.test.ts", ".pi/extensions/example.ts"].map((path) =>
			headingSet(composeAuthoringBrief(input([path]), root).text).join("\n"),
		);
		assert.equal(new Set(sets).size, 1, "fixed-selector mutant survived the route-set witness");
	});

	it("refuses a canonical source reached through a symbolic link", () => {
		const root = fixtureRoot();
		const source = join(root, "real-spec.md");
		writeFileSync(source, readFileSync(join(root, "SPEC.md")));
		rmSync(join(root, "SPEC.md"));
		symlinkSync(source, join(root, "SPEC.md"));
		const result = composeAuthoringBrief(input(["SPEC.md"]), root);
		assert.equal(result.complete, false);
		assert.match(result.text, /canonical SPEC source is unavailable or invalid/);
	});
});

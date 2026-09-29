import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const spec = readFileSync(join(root, "SPEC.md"), "utf8").replaceAll("\r\n", "\n");
const readme = readFileSync(join(root, "README.md"), "utf8");
const fixturePath = join(root, "test/fixtures/adopter-acquisition-contract.v1.json");
type MatrixFixture = {
	schemaVersion: 2;
	stages: string[];
	surfaces: string[];
	cells: Array<[string, string, string, number]>;
	crossStage: string[];
};
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as MatrixFixture;
const regionNames = ["launcher", "trust", "binding", "host"] as const;
const sections = {
	launcher: ["### 4.1 Namespaces", "### 4.2 Target-parameterization"],
	trust: ["### 4.2 Target-parameterization", "### 4.3 PR-based installs"],
	binding: ["### 4.6 Binding and resolution", "### 4.7 Host boundary"],
	host: ["### 4.7 Host boundary", "### 4.8 The command layer"],
} as const;

function exactFixture(value: unknown): value is MatrixFixture {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join(",") !== "cells,crossStage,schemaVersion,stages,surfaces") return false;
	if (record.schemaVersion !== 2) return false;
	if (![record.stages, record.surfaces, record.cells, record.crossStage].every(Array.isArray)) return false;
	return (
		(record.stages as unknown[]).every((entry) => typeof entry === "string" && entry.length > 0) &&
		(record.surfaces as unknown[]).every((entry) => typeof entry === "string" && entry.length > 0) &&
		(record.cells as unknown[]).every(
			(entry) =>
				Array.isArray(entry) &&
				entry.length === 4 &&
				entry.slice(0, 3).every((part) => typeof part === "string" && part.length > 0) &&
				Number.isSafeInteger(entry[3]),
		) &&
		(record.crossStage as unknown[]).every((entry) => typeof entry === "string" && entry.length > 0)
	);
}

function ownedRegions(text: string): Record<(typeof regionNames)[number], string> | undefined {
	const positions: number[] = [];
	const regions = {} as Record<(typeof regionNames)[number], string>;
	for (const name of regionNames) {
		const startMarker = `<!-- acquisition-contract: ${name}:start -->`;
		const endMarker = `<!-- acquisition-contract: ${name}:end -->`;
		if (text.split(startMarker).length !== 2 || text.split(endMarker).length !== 2) return undefined;
		const sectionStart = text.indexOf(sections[name][0]);
		const sectionEnd = text.indexOf(sections[name][1], sectionStart);
		const start = text.indexOf(startMarker);
		const end = text.indexOf(endMarker, start + startMarker.length);
		if (sectionStart < 0 || sectionEnd <= sectionStart || start <= sectionStart || end <= start || end >= sectionEnd)
			return undefined;
		positions.push(start, end);
		regions[name] = text.slice(start + startMarker.length, end).trim();
	}
	if (!positions.every((position, index) => index === 0 || position > positions[index - 1])) return undefined;
	return regions;
}

type ParsedMatrix = { cells: MatrixFixture["cells"]; fields: string[][]; body: string };
function parseMatrix(text: string): ParsedMatrix | undefined {
	const startMarker = "<!-- acquisition-process-matrix: start -->";
	const endMarker = "<!-- acquisition-process-matrix: end -->";
	if (text.split(startMarker).length !== 2 || text.split(endMarker).length !== 2) return undefined;
	const regions = ownedRegions(text);
	if (regions === undefined) return undefined;
	const start = text.indexOf(startMarker);
	const end = text.indexOf(endMarker, start + startMarker.length);
	const trustStart = text.indexOf("<!-- acquisition-contract: trust:start -->");
	const trustEnd = text.indexOf("<!-- acquisition-contract: trust:end -->");
	if (!(trustStart < start && start < end && end < trustEnd)) return undefined;
	const lines = text
		.slice(start + startMarker.length, end)
		.trim()
		.split("\n");
	if (lines[0] !== "| stage | surface | authority | bound | refusal | cleanup obligation |") return undefined;
	if (lines[1] !== "| --- | --- | --- | --- | --- | --- |") return undefined;
	const fields = lines.slice(2).map((line) =>
		line
			.split("|")
			.slice(1, -1)
			.map((field) => field.trim()),
	);
	if (fields.some((row) => row.length !== 6 || row.some((field) => field.length === 0))) return undefined;
	const cells: MatrixFixture["cells"] = [];
	for (const row of fields) {
		if (row[0] === "terminal") {
			if (row[4] !== "the closed six-cause/status algebra in §4.7") return undefined;
			cells.push([row[0], row[1], "closed-six-cause-status-algebra", 0]);
			continue;
		}
		const refusal = /^`([^`]+)`\/`([0-9]+)`$/.exec(row[4]);
		if (refusal === null) return undefined;
		cells.push([row[0], row[1], refusal[1], Number(refusal[2])]);
	}
	return { cells, fields, body: text.slice(start + startMarker.length, end) };
}

const crossStagePhrases = new Map([
	["temporary-create<source-acquisition", "No `git-child` starts before `temporary-create`"],
	["snapshot-confirmation<provision", "no `provision-node` starts before `snapshot-confirmation`"],
	["temporary-create=>cleanup", "every controlled terminal after `temporary-create` reaches `cleanup`"],
	["cleanup<terminal", "the `terminal` cell is selected only after cleanup"],
	["cleanup-failed>stage-result", "`cleanup-failed` overriding the earlier stage result"],
]);
const ownedSemanticPhrases = [
	"After snapshot confirmation",
	"no branch, tag, default HEAD, local path, URL rewrite, mirror, alternate, cache, package, global install, or fallback",
	"every working byte equals its HEAD blob",
	"set `GIT_CONFIG_NOSYSTEM=1`",
	"Cleanup responsibility begins with that first artifact",
	"Cleanup failure overrides every simultaneous post-creation cause",
] as const;

function contractHolds(text: string): boolean {
	if (!exactFixture(fixture) || ownedRegions(text) === undefined) return false;
	const matrix = parseMatrix(text);
	if (matrix === undefined || JSON.stringify(matrix.cells) !== JSON.stringify(fixture.cells)) return false;
	if (JSON.stringify(matrix.cells.map(([stage]) => stage)) !== JSON.stringify(fixture.stages)) return false;
	if (new Set(matrix.cells.map(([, surface]) => surface)).size !== fixture.surfaces.length) return false;
	if (!fixture.surfaces.every((surface) => matrix.cells.some(([, candidate]) => candidate === surface))) return false;
	const positions = fixture.crossStage.map((key) => text.indexOf(crossStagePhrases.get(key) ?? ""));
	return (
		positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])) &&
		ownedSemanticPhrases.every((phrase) => text.split(phrase).length === 2)
	);
}

it("#363 owns one semantic process matrix without a copied-prose oracle or runtime smuggling", () => {
	assert.equal(contractHolds(spec), true);
	assert.match(readme, /SPEC §§4\.1–4\.2 and 4\.6–4\.7/u);
	assert.equal(existsSync(join(root, ".github/bin/gitjig-bootstrap.mjs")), false);
	assert.equal(existsSync(join(root, ".pi/extensions/gitjig/install/bootstrap.ts")), true);
	assert.equal(Object.hasOwn(fixture, "regions"), false, "the retired copied-prose oracle returned");
});

it("rejects open sets, missing cell semantics, and broken cross-stage invariants", () => {
	for (const stage of fixture.stages)
		assert.equal(
			contractHolds(spec.replace(`| ${stage} |`, `| invented-${stage} |`)),
			false,
			`${stage} drift survived`,
		);
	for (const surface of fixture.surfaces) {
		const occurrence = `| ${surface} |`;
		assert.ok(spec.includes(occurrence), `surface absent from matrix: ${surface}`);
		assert.equal(
			contractHolds(spec.replace(occurrence, `| invented-${surface} |`)),
			false,
			`${surface} drift survived`,
		);
	}
	for (const field of ["authority", "bound", "refusal", "cleanup obligation"])
		assert.equal(contractHolds(spec.replace(`| ${field} |`, "| |")), false, `empty ${field} column survived`);
	for (const phrase of crossStagePhrases.values())
		assert.equal(
			contractHolds(spec.replace(phrase, "[cross-stage invariant removed]")),
			false,
			`cross-stage mutant survived: ${phrase}`,
		);
	assert.equal(
		contractHolds(
			spec.replace(
				"<!-- acquisition-process-matrix: end -->",
				"| invented | launcher | x | x | `invalid-input`/`64` | x |\n<!-- acquisition-process-matrix: end -->",
			),
		),
		false,
		"an unlisted matrix cell survived",
	);
});

it("pins the trust, closure, bound, terminal, and cleanup semantics outside the matrix grammar", () => {
	for (const from of ownedSemanticPhrases) {
		assert.equal(spec.split(from).length, 2, `mutation site must be unique: ${from}`);
		assert.equal(contractHolds(spec.replace(from, "[owned semantic removed]")), false, `mutant survived: ${from}`);
	}
	assert.match(spec, /caller-supplied `PATH` and `HOME`/u);
	assert.match(spec, /selection of `env` and the PATH-selected `node`/u);
});

it("startup probe distinguishes environment erasure from PATH/HOME and executable-selection residuals", () => {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-acquisition-startup-"));
	const fakeBin = join(scratch, "bin");
	const marker = join(scratch, "selected-node");
	const fakeNode = join(fakeBin, "node");
	const hostileHome = join(scratch, "hostile-home");
	spawnSync("mkdir", ["-p", fakeBin, hostileHome]);
	writeFileSync(fakeNode, `#!/bin/sh\nprintf '%s' "$HOME" > ${JSON.stringify(marker)}\n`);
	chmodSync(fakeNode, 0o700);
	const selected = spawnSync("env", ["-i", `PATH=${fakeBin}`, `HOME=${hostileHome}`, "LC_ALL=C", "node", "ignored"], {
		env: { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}` },
		encoding: "utf8",
	});
	assert.equal(selected.status, 0, selected.stderr);
	assert.equal(readFileSync(marker, "utf8"), hostileHome, "PATH-selected executable/HOME residual was not observable");
	const probe = join(scratch, "probe.mjs");
	writeFileSync(probe, "process.stdout.write(JSON.stringify(process.env));");
	const erased = spawnSync(
		"env",
		["-i", `PATH=${process.env.PATH ?? ""}`, `HOME=${hostileHome}`, "LC_ALL=C", process.execPath, probe],
		{ encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--definitely-invalid", GIT_DIR: "/hostile" } },
	);
	assert.equal(erased.status, 0, erased.stderr);
	const observed = JSON.parse(erased.stdout) as Record<string, string>;
	assert.equal(observed.HOME, hostileHome);
	assert.equal(Object.hasOwn(observed, "NODE_OPTIONS"), false);
	assert.equal(Object.hasOwn(observed, "GIT_DIR"), false);
	rmSync(scratch, { recursive: true, force: true });
});

it("child, filesystem, and terminal probes cover every matrix surface", () => {
	const matrix = parseMatrix(spec);
	assert.ok(matrix);
	assert.deepEqual(new Set(matrix.cells.map(([, surface]) => surface)), new Set(fixture.surfaces));
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-acquisition-surfaces-"));
	const child = join(scratch, "child.mjs");
	writeFileSync(
		child,
		"let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({input,env:process.env})));",
	);
	for (const surface of ["git-child", "provision-node"] as const) {
		const run = spawnSync(process.execPath, [child], {
			input: "",
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: 1024 * 1024,
			env: { PATH: process.env.PATH ?? "", HOME: scratch, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1" },
		});
		assert.equal(run.status, 0, `${surface}: ${run.stderr}`);
		const observed = JSON.parse(run.stdout) as { input: string; env: Record<string, string> };
		assert.equal(observed.input, "", `${surface} did not observe EOF`);
		assert.deepEqual(
			Object.keys(observed.env).filter((key) => key.startsWith("NODE_") || key.startsWith("GIT_")),
			["GIT_CONFIG_NOSYSTEM"],
		);
	}
	const owned = mkdtempSync(join(scratch, "gitjig-acquire-"));
	assert.equal(lstatSync(owned).isSymbolicLink(), false);
	assert.equal(lstatSync(owned).mode & 0o777, 0o700);
	rmSync(owned, { recursive: true, force: true });
	assert.equal(existsSync(owned), false, "filesystem cleanup did not confirm absence");
	assert.deepEqual(
		matrix.cells.map(([, , cause, status]) => [cause, status]),
		fixture.cells.map(([, , cause, status]) => [cause, status]),
		"terminal cause/status projection drifted",
	);
	rmSync(scratch, { recursive: true, force: true });
});

after(() => {
	assert.equal(contractHolds(spec), true);
});

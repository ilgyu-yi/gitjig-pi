import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const spec = readFileSync(join(root, "SPEC.md"), "utf8").replaceAll("\r\n", "\n");
const readme = readFileSync(join(root, "README.md"), "utf8");
const fixturePath = join(root, "test/fixtures/adopter-acquisition-contract.v1.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
	schemaVersion: number;
	regions: Array<{ name: string; text: string }>;
};
const names = ["launcher", "trust", "binding", "host"] as const;
const sections = {
	launcher: ["### 4.1 Namespaces", "### 4.2 Target-parameterization"],
	trust: ["### 4.2 Target-parameterization", "### 4.3 PR-based installs"],
	binding: ["### 4.6 Binding and resolution", "### 4.7 Host boundary"],
	host: ["### 4.7 Host boundary", "### 4.8 The command layer"],
} as const;

function exactFixture(value: unknown): value is typeof fixture {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join(",") !== "regions,schemaVersion" || record.schemaVersion !== 1) return false;
	if (!Array.isArray(record.regions) || record.regions.length !== names.length) return false;
	return record.regions.every(
		(region, index) =>
			typeof region === "object" &&
			region !== null &&
			!Array.isArray(region) &&
			Object.keys(region).sort().join(",") === "name,text" &&
			(region as { name?: unknown }).name === names[index] &&
			typeof (region as { text?: unknown }).text === "string" &&
			(region as { text: string }).text.trim() === (region as { text: string }).text,
	);
}

function extractRegions(text: string): Array<{ name: string; text: string }> | undefined {
	const positions: number[] = [];
	const regions = [];
	for (const name of names) {
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
		regions.push({ name, text: text.slice(start + startMarker.length, end).trim() });
	}
	if (!positions.every((position, index) => index === 0 || position > positions[index - 1])) return undefined;
	return regions;
}

function contractHolds(text: string): boolean {
	return exactFixture(fixture) && JSON.stringify(extractRegions(text)) === JSON.stringify(fixture.regions);
}

it("#363 owns the complete bounded first-clone contract without runtime smuggling", () => {
	assert.equal(contractHolds(spec), true);
	assert.match(readme, /SPEC §§4\.1–4\.2 and 4\.6–4\.7/u);
	assert.equal(existsSync(join(root, ".github/bin/gitjig-bootstrap.mjs")), false);
	assert.equal(existsSync(join(root, ".pi/extensions/gitjig/install/bootstrap.ts")), true);
});

it("#363 rejects omission, insertion, contradiction, movement, and terminal mutants", () => {
	for (const region of fixture.regions) {
		assert.equal(
			contractHolds(spec.replace(region.text, region.text.slice(0, -1))),
			false,
			`${region.name}: terminal-byte deletion survived`,
		);
		assert.equal(
			contractHolds(spec.replace(region.text, `${region.text}\nContradictory fallback authority is also accepted.`)),
			false,
			`${region.name}: contradictory insertion survived`,
		);
	}
	for (const [from, to] of [
		["before any acquisition operation", "after acquisition begins"],
		["Any argument is `invalid-input`.", "Arguments may select another source."],
		["and no other own key", "and optional routing keys"],
		['`provider: "github"`; `host: "github.com"`', '`provider: "gitlab"`; `host: "gitlab.com"`'],
		["every HEAD entry is a regular blob mode", "every HEAD entry may be a symlink"],
		["every ancestor and working entry is non-link and confined", "ancestors may escape"],
		["set `GIT_CONFIG_NOSYSTEM=1`", "permit system Git configuration"],
		["every working byte equals its HEAD blob", "working bytes need only exist"],
		["Cleanup responsibility begins with that first artifact", "Cleanup begins after identity confirmation"],
		["Cleanup failure overrides every simultaneous post-creation cause", "The primary cause overrides cleanup"],
		["Git errors to `69`", "Git errors to `70`"],
	] as const) {
		assert.equal(spec.split(from).length, 2, `mutation site must be unique: ${from}`);
		assert.equal(contractHolds(spec.replace(from, to)), false, `mutant survived: ${from}`);
	}
	const extraCause = spec.replace(
		"`cleanup-failed`/`74` whenever controlled cleanup",
		"`unexpected`/`75` for another cause; and `cleanup-failed`/`74` whenever controlled cleanup",
	);
	assert.equal(contractHolds(extraCause), false, "a seventh terminal cause survived");
	const launcher = fixture.regions[0];
	const moved = spec
		.replace(
			`<!-- acquisition-contract: launcher:start -->\n${launcher.text}\n<!-- acquisition-contract: launcher:end -->`,
			"",
		)
		.replace("### 4.1 Namespaces", `### 4.1 Namespaces\n\n${launcher.text}`);
	assert.equal(contractHolds(moved), false, "a moved owner region survived");
	assert.equal(
		contractHolds(spec.replace("## 6. Self-governance milestone", "## 6. Self-governance milestone\ncontrol")),
		true,
	);
});

it("the exact empty-environment boundary erases inherited startup influence", () => {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-acquisition-env-"));
	const preload = join(scratch, "preload.cjs");
	const marker = join(scratch, "preloaded");
	const coverage = join(scratch, "coverage");
	const probe = join(scratch, "probe.mjs");
	writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");`);
	writeFileSync(probe, "process.stdout.write(JSON.stringify(process.env));");
	const hostile = {
		...process.env,
		NODE_OPTIONS: `--require=${preload}`,
		NODE_V8_COVERAGE: coverage,
		GIT_CONFIG_SYSTEM: join(scratch, "gitconfig"),
		ARBITRARY_SENTINEL: "hostile",
	};
	const control = spawnSync(process.execPath, [probe], { encoding: "utf8", env: hostile });
	assert.equal(control.status, 0);
	assert.equal(existsSync(marker), true, "control preload did not establish the witness");
	rmSync(marker);
	rmSync(coverage, { recursive: true, force: true });
	const clean = spawnSync(
		"env",
		["-i", `PATH=${process.env.PATH ?? ""}`, `HOME=${process.env.HOME ?? ""}`, "LC_ALL=C", process.execPath, probe],
		{ encoding: "utf8", env: hostile },
	);
	assert.equal(clean.status, 0, clean.stderr);
	const observed = JSON.parse(clean.stdout) as Record<string, string>;
	assert.deepEqual(
		{ HOME: observed.HOME, LC_ALL: observed.LC_ALL, PATH: observed.PATH },
		{ HOME: process.env.HOME ?? "", LC_ALL: "C", PATH: process.env.PATH ?? "" },
	);
	for (const inherited of ["NODE_OPTIONS", "NODE_V8_COVERAGE", "GIT_CONFIG_SYSTEM", "ARBITRARY_SENTINEL"])
		assert.equal(Object.hasOwn(observed, inherited), false, `inherited startup input survived: ${inherited}`);
	const platformCreated = Object.keys(observed).filter((key) => !new Set(["HOME", "LC_ALL", "PATH"]).has(key));
	assert.deepEqual(platformCreated, process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : []);
	assert.equal(existsSync(marker), false);
	assert.equal(existsSync(coverage), false);
	rmSync(scratch, { recursive: true, force: true });
});

after(() => {
	assert.equal(contractHolds(spec), true);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const join = (...parts: string[]): string => parts.join("");
const TOKENS = [
	join("super", "seded-dormant"),
	join("source", "-split"),
	join("/source", "-split"),
	join("source", "Split"),
	join("landing", "-topology"),
	join("landing", "-policy"),
	join("topology", "-authorization"),
	join("topology", "-plan"),
	join("topology", "-provenance"),
	join("attest", "Topology", "Plan"),
	join("load", "Topology", "Authorization"),
	join("bootstrap", "-super", "seded-dormant"),
	join("optimistic", "Rulesets"),
	join("pair", "Key"),
	join("Source", "Split"),
	join("Source", "-split"),
	join("source", ".split"),
	join("Landing", "Topology"),
	join("landing", "/topology"),
	join("landing", " topology"),
	join("Topology", "Authorization"),
	join("TOPOLOGY", "_AUTHORIZATION"),
	join("topology", " authorization"),
	join("Topology", "Plan"),
	join("topology", "Plan"),
	join("topology", " plan"),
	join("Pair", "Key"),
	join("split", "-topology"),
	join("pair", "-key"),
] as const;

const RETIRED = [
	join(".github/workflows/landing", "-topology.mjs"),
	join(".pi/extensions/gitjig/commands/source", "-split.ts"),
	".pi/extensions/gitjig/landing/bootstrap.ts",
	".pi/extensions/gitjig/landing/provenance.ts",
	join(".pi/extensions/gitjig/landing/source", "-split-contract.ts"),
	join(".pi/extensions/gitjig/landing/source", "-split-platform.ts"),
	join(".pi/extensions/gitjig/landing/source", "-split-service.ts"),
	join(".pi/extensions/gitjig/landing/", "topology", "-author", "ization.ts"),
	join(".pi/extensions/gitjig/landing/", "topology", "-pl", "an.ts"),
	join(".pi/extensions/gitjig/landing/", "topology", "-prove", "nance.ts"),
] as const;

const REMOVED_SUITES = [
	"test/landing-provenance.unit.test.ts",
	join("test/landing", "-topology.unit.test.ts"),
	join("test/landing", "-topology.mutation.test.ts"),
	join("test/source", "-split-application.unit.test.ts"),
	join("test/source", "-split-application.mutation.test.ts"),
	join("test/topology", "-authorization.unit.test.ts"),
] as const;

interface Occurrence {
	path: string;
	token: string;
	line: string;
	ordinal: number;
}
interface EncodedDisposition {
	pathBase64: string;
	tokenBase64: string;
	lineBase64: string;
	ordinal: number;
	disposition: "canonical" | "historical" | "homonym" | "guard" | "retained";
	reason: string;
}

function trackedFiles(): string[] {
	return execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" })
		.toString("utf8")
		.split("\0")
		.filter((path) => path.length > 0 && lstatSync(path).isFile())
		.sort();
}

export function observeOccurrences(): Occurrence[] {
	const found: Occurrence[] = [];
	for (const path of trackedFiles()) {
		const lines = readFileSync(path, "utf8").split(/\r?\n/u);
		for (const line of lines) {
			for (const token of TOKENS) {
				let at = 0;
				let ordinal = 0;
				while (true) {
					const foundAt = line.indexOf(token, at);
					if (foundAt === -1) break;
					found.push({ path, token, line, ordinal });
					ordinal++;
					at = foundAt + token.length;
				}
			}
		}
	}
	return found.sort((left, right) => {
		const leftKey = [left.path, left.line, left.token, left.ordinal].join("\0");
		const rightKey = [right.path, right.line, right.token, right.ordinal].join("\0");
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
}

function decode(row: EncodedDisposition): Occurrence {
	return {
		path: Buffer.from(row.pathBase64, "base64").toString("utf8"),
		token: Buffer.from(row.tokenBase64, "base64").toString("utf8"),
		line: Buffer.from(row.lineBase64, "base64").toString("utf8"),
		ordinal: row.ordinal,
	};
}

const fixturePath = "test/fixtures/phase6-term-dispositions.json";
const sourcePath = "test/phase6-retirement.structure.test.ts";
const dispositions = JSON.parse(readFileSync(fixturePath, "utf8")) as EncodedDisposition[];

describe("Phase-6 retired authority removal", () => {
	it("removes every settled runtime path and stale compiler/classifier carrier", () => {
		for (const path of [...RETIRED, ...REMOVED_SUITES]) assert.equal(existsSync(path), false, path);
		const config = readFileSync("tsconfig.json", "utf8");
		assert.doesNotMatch(config, new RegExp(join("landing", "-(?:policy|topology)\\.mjs"), "u"));
		const classifier = readFileSync(".pi/extensions/gitjig/install/classifier.ts", "utf8");
		assert.doesNotMatch(classifier, new RegExp(join("landing", "-topology\\.json"), "u"));
	});

	it("keeps the replacement authorization and separate application boundary explicit", () => {
		const spec = readFileSync("SPEC.md", "utf8");
		const readme = readFileSync("README.md", "utf8");
		const adr = readFileSync("docs/adr/0001-maintainer-terminal-governance.md", "utf8");
		for (const value of [
			join("source", "-split authority"),
			"authorize no operation",
			"admit no new caller",
			"No live ruleset or repository-setting mutation is authorized",
			join("Source", "-split and configurable-plan artifacts are non-interchangeable"),
			join("supersedes #286/#289's source", "-split marker"),
			join("no Issue marker, escape record or claim population is required"),
			"--confirm-plan-hash <hash>",
			"Partial or ambiguous writes stop",
			"hard prerequisite of Phase 7",
		])
			assert.ok(spec.includes(value), value);
		assert.ok(readme.includes("must not be authorized or executed"));
		assert.ok(adr.includes(join("#293 source", "-split plan and marker must not be authorized or executed")));
	});

	it("keeps its own scanner and encoded table outside the candidate population", () => {
		for (const path of [sourcePath, fixturePath]) {
			const bytes = readFileSync(path, "utf8");
			for (const token of TOKENS) assert.equal(bytes.includes(token), false, `${path}: ${token}`);
		}
	});

	it("accounts exactly for every tracked candidate occurrence", () => {
		const categories = new Set(["canonical", "historical", "homonym", "guard", "retained"]);
		for (const row of dispositions) {
			assert.ok(categories.has(row.disposition));
			assert.ok(row.reason.length > 0);
			const occurrence = decode(row);
			if (row.disposition === "historical") {
				assert.ok(occurrence.path.startsWith("docs/adr/") || occurrence.path.startsWith("changelog_unreleased/"));
				assert.match(row.reason, /historical|record-purpose|removal record/u);
			}
			if (row.disposition === "canonical") {
				assert.ok(["SPEC.md", "README.md"].includes(occurrence.path));
				assert.match(row.reason, /current|completed/u);
			}
			if (row.disposition === "guard") {
				assert.ok(occurrence.path.startsWith("test/"));
				assert.match(row.reason, /guard|assertion/u);
			}
			if (row.disposition === "retained") {
				assert.equal(occurrence.path, "SPEC.md");
				assert.match(row.reason, /SPEC §3\.8/u);
			}
			if (row.disposition === "homonym") {
				assert.ok(occurrence.path.startsWith("test/"));
				assert.equal(occurrence.token, join("source", ".split"));
				assert.match(row.reason, /String\.split/u);
			}
		}
		assert.deepEqual(dispositions.map(decode), observeOccurrences());
	});

	it("detects restoration and population mutants", () => {
		const expected = dispositions.map(decode);
		const observed = observeOccurrences();
		assert.deepEqual(observed, expected);
		assert.notDeepEqual(observed.slice(1), expected);
		assert.notDeepEqual(
			[...observed, { path: "synthetic", token: "synthetic", line: "synthetic", ordinal: 0 }],
			expected,
		);
		assert.equal(
			[...RETIRED, ...REMOVED_SUITES].some((path) => existsSync(path)),
			false,
		);
	});
});

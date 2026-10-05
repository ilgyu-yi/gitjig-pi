/**
 * #363: the first-clone acquisition contract, owned by SPEC's closed relation
 * tables (§§4.1–4.2, 4.6–4.7), measured by value.
 *
 * The SPEC tables are the norm. This suite parses every one of them as a
 * schema: fixed headers, each cell one scalar from its column's closed domain,
 * unique keys, and references that resolve (a node an edge names is a node, a
 * cause a node names is a terminal cause). The parsed tuples are then compared
 * whole against `adopter-acquisition-contract.json`, a non-normative projection
 * reviewed with them. So any tuple that drifts fails by value, however the
 * surrounding prose reads.
 *
 * Changing any tuple therefore changes the SPEC and its projection together:
 * a contract change visible in both files of the diff, which review owns.
 * Nothing here claims to pin a value independently of that projection.
 *
 * There are no runtime probes here: this is a contract-only change, and the
 * handed launcher does not exist yet. Real Git and provision-child selection,
 * limits and environments are #362's runtime evidence.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const spec = readFileSync(join(root, "SPEC.md"), "utf8").replaceAll("\r\n", "\n");
const readme = readFileSync(join(root, "README.md"), "utf8");
const fixture = JSON.parse(readFileSync(join(root, "test/fixtures/adopter-acquisition-contract.json"), "utf8")) as {
	schemaVersion: number;
	relations: Record<string, string[][]>;
	prose: Record<string, string>;
};

const STAGES = [
	"startup",
	"target-admission",
	"temporary-create",
	"source-acquisition",
	"snapshot-confirmation",
	"provision",
	"cleanup",
	"terminal",
];
const SURFACES = ["launcher", "git-child", "provision-node", "filesystem", "terminal"];
const INT = /^(0|[1-9][0-9]*)$/;
const SCALAR = /^[^\s|`]+$/;

type Domain = readonly string[] | RegExp;
type Relation = { region: string; header: readonly string[]; domains: readonly Domain[]; key: readonly number[] };

/** The closed family of relations: where each lives, its header, each column's domain, and its key. */
const RELATIONS: Record<string, Relation> = {
	activation: {
		region: "launcher",
		header: ["owner", "state", "activatesWith", "retiresWith"],
		domains: [SCALAR, ["settled-pending-runtime", "live"], ["#362", "none"], ["#362", "none"]],
		key: [0],
	},
	nodes: {
		region: "trust",
		header: ["node", "stage", "surface", "owner", "cause"],
		domains: [SCALAR, STAGES, SURFACES, ["launcher", "provision-owner"], SCALAR],
		key: [0],
	},
	edges: {
		region: "trust",
		header: ["relation", "from", "to"],
		domains: [["before", "reaches", "overrides"], SCALAR, SCALAR],
		key: [0, 1, 2],
	},
	authority: {
		region: "trust",
		header: ["node", "input", "source", "role", "cardinality"],
		domains: [SCALAR, SCALAR, SCALAR, ["refused", "routing", "non-authorizing", "execution", "integrity"], INT],
		key: [0, 1],
	},
	predicates: {
		region: "trust",
		header: ["node", "subject", "operator", "expected"],
		domains: [
			SCALAR,
			SCALAR,
			["equals", "equals-any", "is", "are", "at-most", "derived-from", "includes", "admits"],
			SCALAR,
		],
		key: [0, 1, 3],
	},
	limits: {
		region: "trust",
		header: ["node", "profile", "stdin", "timeoutMs", "stdoutBytes", "stderrBytes", "processGroupOwner"],
		domains: [SCALAR, ["git-admission", "git", "node"], ["eof"], INT, INT, INT, ["launcher", "provision-owner"]],
		key: [0],
	},
	"child-outcomes": {
		region: "trust",
		header: ["outcome", "mapped"],
		domains: [["spawn-failure", "timeout", "stream-overflow", "signal", "nonzero"], ["node-cause"]],
		key: [0],
	},
	environment: {
		region: "trust",
		header: ["profile", "kind", "key", "value"],
		domains: [["launcher", "git-admission", "git", "node"], ["read", "env", "config"], SCALAR, SCALAR],
		key: [0, 1, 2],
	},
	exclusions: {
		region: "trust",
		header: ["profile", "excluded"],
		domains: [["git-admission", "git", "node"], SCALAR],
		key: [0, 1],
	},
	artifacts: {
		region: "host",
		header: ["artifact", "parent", "count", "mode", "owner", "linkPolicy"],
		domains: [SCALAR, SCALAR, ["1", "0-or-more"], ["existing", "0700", "0600"], ["platform", "current-user"], SCALAR],
		key: [0],
	},
	residuals: {
		region: "host",
		header: ["residual", "holder", "scope"],
		domains: [SCALAR, ["caller", "host"], SCALAR],
		key: [0],
	},
	terminal: {
		region: "host",
		header: ["cause", "status", "stdout", "stderr"],
		domains: [SCALAR, INT, ["empty"], ["empty", "cause-line"]],
		key: [0],
	},
	fallbacks: {
		region: "host",
		header: ["condition", "cause"],
		domains: [SCALAR, SCALAR],
		key: [0],
	},
};

const REGIONS = {
	launcher: ["### 4.1 Namespaces", "### 4.2 Target-parameterization"],
	trust: ["### 4.2 Target-parameterization", "### 4.3 PR-based installs"],
	binding: ["### 4.6 Binding and resolution", "### 4.7 Host boundary"],
	host: ["### 4.7 Host boundary", "### 4.8 The command layer"],
} as const;

/** Each owned region, exactly once and inside its own section, in section order. */
function regions(text: string): Record<keyof typeof REGIONS, string> | undefined {
	const found = {} as Record<keyof typeof REGIONS, string>;
	let last = -1;
	for (const name of Object.keys(REGIONS) as (keyof typeof REGIONS)[]) {
		const start = `<!-- acquisition-contract: ${name}:start -->`;
		const end = `<!-- acquisition-contract: ${name}:end -->`;
		if (text.split(start).length !== 2 || text.split(end).length !== 2) return undefined;
		const sectionStart = text.indexOf(REGIONS[name][0]);
		const sectionEnd = text.indexOf(REGIONS[name][1], sectionStart);
		const from = text.indexOf(start);
		const to = text.indexOf(end);
		if (sectionStart < 0 || !(sectionStart < from && from < to && to < sectionEnd) || from < last) return undefined;
		last = to;
		found[name] = text.slice(from + start.length, to);
	}
	return found;
}

type Parsed = Record<string, string[][]>;

/** Every relation, parsed as a schema; `undefined` on any structural defect. */
function relations(text: string): Parsed | undefined {
	const owned = regions(text);
	if (owned === undefined) return undefined;
	// No relation marker outside the closed family, and none outside its region.
	const markers = [...text.matchAll(/<!-- acquisition-relation: ([a-z-]+):start -->/g)].map((match) => match[1]);
	if (JSON.stringify([...markers].sort()) !== JSON.stringify(Object.keys(RELATIONS).sort())) return undefined;
	const parsed: Parsed = {};
	for (const [name, relation] of Object.entries(RELATIONS)) {
		const region = owned[relation.region as keyof typeof REGIONS];
		const start = `<!-- acquisition-relation: ${name}:start -->`;
		const end = `<!-- acquisition-relation: ${name}:end -->`;
		if (region.split(start).length !== 2 || region.split(end).length !== 2) return undefined;
		const lines = region
			.slice(region.indexOf(start) + start.length, region.indexOf(end))
			.trim()
			.split("\n");
		const cells = (line: string) =>
			line
				.split("|")
				.slice(1, -1)
				.map((cell) => cell.trim());
		// Every line is exactly the canonical rendering of its cells, so nothing can
		// ride after a closing pipe or between cells without breaking the table.
		if (!lines.every((line) => line === `| ${cells(line).join(" | ")} |`)) return undefined;
		if (JSON.stringify(cells(lines[0] ?? "")) !== JSON.stringify(relation.header)) return undefined;
		if (JSON.stringify(cells(lines[1] ?? "")) !== JSON.stringify(relation.header.map(() => "---"))) return undefined;
		const rows = lines.slice(2).map(cells);
		if (rows.length === 0) return undefined;
		for (const row of rows) {
			if (row.length !== relation.header.length) return undefined;
			for (const [index, value] of row.entries()) {
				const domain = relation.domains[index];
				if (domain instanceof RegExp ? !domain.test(value) : !domain.includes(value)) return undefined;
			}
		}
		const keys = rows.map((row) => relation.key.map((index) => row[index]).join("\u0000"));
		if (new Set(keys).size !== keys.length) return undefined;
		parsed[name] = rows;
	}
	return closed(parsed) ? parsed : undefined;
}

/** References resolve, and the node relation is the closed stage/surface population in process order. */
function closed(parsed: Parsed): boolean {
	const nodes = new Set(parsed.nodes.map(([node]) => node));
	const causes = new Set(parsed.terminal.map(([cause]) => cause));
	const stagesInOrder = parsed.nodes
		.map(([, stage]) => stage)
		.filter((stage, index, all) => all.indexOf(stage) === index);
	if (JSON.stringify(stagesInOrder) !== JSON.stringify(STAGES)) return false;
	if (new Set(parsed.nodes.map(([, , surface]) => surface)).size !== SURFACES.length) return false;
	if (!parsed.nodes.every(([, , , , cause]) => causes.has(cause))) return false;
	if (!parsed.fallbacks.every(([, cause]) => causes.has(cause))) return false;
	for (const [relation, from, to] of parsed.edges)
		if (
			relation === "overrides"
				? !(causes.has(from) && to === "post-creation-cause")
				: !(nodes.has(from) && nodes.has(to))
		)
			return false;
	for (const name of ["authority", "predicates", "limits"])
		if (!parsed[name].every(([node]) => nodes.has(node))) return false;
	// Every child's profile is a profile the environment relation defines, with its exclusions.
	const profiles = new Set(parsed.environment.map(([profile]) => profile));
	const excluded = new Set(parsed.exclusions.map(([profile]) => profile));
	if (!parsed.limits.every(([, profile]) => profiles.has(profile) && excluded.has(profile))) return false;
	// Exactly the child nodes carry limits.
	const children = parsed.nodes.filter(([, , surface]) => surface === "git-child" || surface === "provision-node");
	return JSON.stringify(children.map(([node]) => node)) === JSON.stringify(parsed.limits.map(([node]) => node));
}

/**
 * Each owned region's prose, with every relation block replaced by its name:
 * the explanation the tables sit in. It is fixed by digest in the reviewed
 * projection, so a sentence added, removed or changed anywhere in a region,
 * including one that contradicts a table, is a drift that fails. That is a
 * whole-region lock, not a phrase guard: no wording is singled out.
 */
function prose(text: string): Record<string, string> | undefined {
	const owned = regions(text);
	if (owned === undefined) return undefined;
	return Object.fromEntries(
		Object.entries(owned).map(([name, body]) => {
			const placed = body.replace(
				/<!-- acquisition-relation: ([a-z-]+):start -->[\s\S]*?<!-- acquisition-relation: \1:end -->/g,
				(_match, relation: string) => `<relation:${relation}>`,
			);
			const normalized = placed
				.split("\n")
				.map((line) => line.trimEnd())
				.join("\n")
				.trim();
			return [name, createHash("sha256").update(normalized).digest("hex")];
		}),
	);
}

/** The whole contract: schema, closure, and the reviewed projection of its tuples and prose. */
function contractHolds(text: string): boolean {
	const parsed = relations(text);
	return (
		parsed !== undefined &&
		fixture.schemaVersion === 3 &&
		JSON.stringify(parsed) === JSON.stringify(fixture.relations) &&
		JSON.stringify(prose(text)) === JSON.stringify(fixture.prose) &&
		!text.includes("acquisition-process-matrix")
	);
}

/** No runtime is smuggled into a contract-only change: the launcher is absent and the carried owner live. */
function contractOnly(tree: string): boolean {
	return (
		!existsSync(join(tree, ".github/bin/gitjig-bootstrap.mjs")) &&
		existsSync(join(tree, ".pi/extensions/gitjig/install/bootstrap.ts")) &&
		existsSync(join(tree, ".pi/extensions/gitjig/install/acquire.ts"))
	);
}

/** README's one settled pointer to this contract. */
const README_POINTER =
	"An adopter has a different product boundary: its reviewed history carries self-standing handed-over assets and `.pi/gitjig.pin.json`; the gitjig runtime is carried and verified per clone, never committed. The zero-operand first-clone launcher and its exact acquisition and cleanup contract are defined in SPEC §§4.1–4.2 and 4.6–4.7; runtime delivery follows that settlement. This source-tree bind command is therefore not presented as an adopter installer.";

/** The README carries the pointer exactly once, as its own line, and no other line speaks of the contract. */
function thinPointer(text: string): boolean {
	const lines = text.split("\n");
	if (lines.filter((line) => line === README_POINTER).length !== 1) return false;
	return !lines.some(
		(line) => line !== README_POINTER && /launcher|acquisition|gitjig-bootstrap|first-clone|§§4\.1/iu.test(line),
	);
}

/** A copy of the SPEC with one exact edit; the anchor must exist once, or the harness faults. */
function edited(from: string, to: string): string {
	if (spec.split(from).length !== 2) throw new Error(`anchor must exist once: ${from}`);
	return spec.replace(from, () => to);
}

it("#363's contract is the SPEC's closed relations, matching their reviewed projection", () => {
	assert.equal(contractHolds(spec), true);
	assert.equal(contractOnly(root), true, "a runtime file landed, or the carried owner moved");
	assert.equal(thinPointer(readme), true, "README is not the thin settled pointer");
});

it("README stays one thin pointer: its paragraph exact, and the contract nowhere else", () => {
	for (const [named, text] of [
		["a contradiction appended", `${readme}These sections do not define a launcher contract.\n`],
		["the pointer reworded", readme.replace("its exact acquisition and cleanup contract", "its acquisition contract")],
		["the pointer removed", readme.replace(README_POINTER, "")],
		[
			"the contract restated elsewhere",
			readme.replace(
				"Run the verification suite as:",
				"The first-clone acquisition runs Git first.\n\nRun the verification suite as:",
			),
		],
	] as const)
		assert.equal(thinPointer(text), false, `${named} survived`);
});

it("each AC7 class reds by value when its tuples drift", () => {
	for (const [named, from, to] of [
		// Pre-verification execution.
		["provision before closure", "| before | closure-check | provision-run |\n", ""],
		["source Git before the temporary child", "| before | temporary-create | source-fetch |\n", ""],
		// Override or fallback.
		[
			"a caller-supplied source",
			"| source-fetch | source | routing-projection | routing | 1 |",
			"| source-fetch | source | caller-operand | routing | 1 |",
		],
		[
			"an admitted identity substitute",
			"| source-fetch | identity-substitute | admits | none |",
			"| source-fetch | identity-substitute | admits | mirror |",
		],
		[
			"an admitted operand",
			"| argv-admission | operand | process-argv | refused | 0 |",
			"| argv-admission | operand | process-argv | refused | 1 |",
		],
		// Incomplete module closure.
		["closure without byte equality", "| closure-check | working-bytes | equals | head-blob |\n", ""],
		["closure admitting other paths", "| closure-check | population-scope | admits | none-other |\n", ""],
		// Ambient omission.
		["an inherited Git environment", "| git | inherited-environment |\n", ""],
		["a system Git config", "| git | env | GIT_CONFIG_NOSYSTEM | 1 |", "| git | env | GIT_CONFIG_NOSYSTEM | 0 |"],
		// Bound and status drift.
		["a shorter Git bound", "| source-fetch | git | eof | 120000 |", "| source-fetch | git | eof | 60000 |"],
		[
			"an admission Git read given the owned config file",
			"| git-admission | env | GIT_CONFIG_GLOBAL | platform-null-device |",
			"| git-admission | env | GIT_CONFIG_GLOBAL | owned-empty-file |",
		],
		[
			"a larger provision cap",
			"| provision-run | node | eof | 300000 | 1048576 |",
			"| provision-run | node | eof | 300000 | 2097152 |",
		],
		["a moved status", "| invalid-input | 64 |", "| invalid-input | 1 |"],
		// Cleanup reach and precedence.
		["cleanup not reached", "| reaches | temporary-create | cleanup |\n", ""],
		["cleanup failure not overriding", "| overrides | cleanup-failed | post-creation-cause |\n", ""],
	] as const)
		assert.equal(contractHolds(edited(from, to)), false, `${named} survived`);
});

it("the relations are a closed schema: domains, keys, references, headers and placement", () => {
	for (const [named, from, to] of [
		["an unknown stage", "| pin-read | target-admission |", "| pin-read | target-check |"],
		[
			"an unknown operator",
			"| argv-admission | operand-count | equals | 0 |",
			"| argv-admission | operand-count | roughly | 0 |",
		],
		[
			"a duplicate node",
			"| cleanup | cleanup | filesystem | launcher | cleanup-failed |",
			"| cleanup | cleanup | filesystem | launcher | cleanup-failed |\n| cleanup | cleanup | filesystem | launcher | cleanup-failed |",
		],
		["a dangling edge", "| before | cleanup | terminal |", "| before | cleanup | nowhere |"],
		[
			"a cause no terminal row owns",
			"| provision-run | provision | provision-node | provision-owner | provision-refused |",
			"| provision-run | provision | provision-node | provision-owner | provision-failed |",
		],
		["a non-integer bound", "| pin-read | git-admission | eof | 120000 |", "| pin-read | git-admission | eof | 120s |"],
		["a child without a defined profile", "| pin-read | git-admission |", "| pin-read | git-fast |"],
		[
			"text after a row's closing pipe",
			"| argv-admission | operand-count | equals | 0 |",
			"| argv-admission | operand-count | equals | 0 | This requirement is optional.",
		],
		["a header drift", "| node | profile | stdin | timeoutMs |", "| node | profile | stdin | timeout |"],
		[
			"a prose-valued cell",
			"| launcher | read | HOME | caller-value |",
			"| launcher | read | HOME | the caller's value |",
		],
		["a child node without limits", "| pin-read | git-admission | eof | 120000 | 1048576 | 1048576 | launcher |\n", ""],
		[
			"a relation outside the family",
			"<!-- acquisition-relation: fallbacks:start -->",
			"<!-- acquisition-relation: extra:start -->\n| a |\n| --- |\n| b |\n<!-- acquisition-relation: extra:end -->\n<!-- acquisition-relation: fallbacks:start -->",
		],
		[
			"the old matrix restored",
			"<!-- acquisition-relation: nodes:start -->",
			"<!-- acquisition-process-matrix: start -->\n<!-- acquisition-relation: nodes:start -->",
		],
	] as const)
		assert.equal(contractHolds(edited(from, to)), false, `${named} survived`);
	// A relation moved out of its own region.
	const terminal = spec.slice(
		spec.indexOf("<!-- acquisition-relation: terminal:start -->"),
		spec.indexOf("<!-- acquisition-relation: terminal:end -->") + "<!-- acquisition-relation: terminal:end -->".length,
	);
	const moved = edited(terminal, "").replace(
		"<!-- acquisition-contract: trust:end -->",
		() => `${terminal}\n<!-- acquisition-contract: trust:end -->`,
	);
	assert.equal(contractHolds(moved), false, "a relation moved out of its region survived");
});

it("a contradiction in any region's prose reds, though no table changed", () => {
	for (const [named, region] of [
		["a redirect kept after retirement", "launcher"],
		["an override admitted in prose", "trust"],
		["a caller target admitted in prose", "binding"],
		["a second host exception in prose", "host"],
	] as const) {
		const end = `<!-- acquisition-contract: ${region}:end -->`;
		const drifted = edited(end, `The carried bootstrap remains as a redirect after #362.\n${end}`);
		assert.ok(relations(drifted), `${named}: the tables no longer parse, so this measures the schema instead`);
		assert.equal(contractHolds(drifted), false, `${named} survived`);
	}
	// A word changed inside existing prose, not only a sentence added.
	assert.equal(
		contractHolds(edited("Neither exception changes configuration", "Neither exception usually changes configuration")),
		false,
	);
});

it("a runtime file smuggled into the contract-only change reds", () => {
	const tree = mkdtempSync(join(tmpdir(), "gitjig-acquisition-contract-"));
	try {
		for (const file of [".pi/extensions/gitjig/install/bootstrap.ts", ".pi/extensions/gitjig/install/acquire.ts"]) {
			mkdirSync(dirname(join(tree, file)), { recursive: true });
			writeFileSync(join(tree, file), "// carried\n");
		}
		assert.equal(contractOnly(tree), true, "the baseline tree does not hold");
		mkdirSync(join(tree, ".github/bin"), { recursive: true });
		writeFileSync(join(tree, ".github/bin/gitjig-bootstrap.mjs"), "// smuggled runtime\n");
		assert.equal(contractOnly(tree), false, "the handed launcher landed in a contract-only change");
		rmSync(join(tree, ".github/bin/gitjig-bootstrap.mjs"));
		rmSync(join(tree, ".pi/extensions/gitjig/install/bootstrap.ts"));
		assert.equal(contractOnly(tree), false, "the carried owner was retired before its runtime");
	} finally {
		rmSync(tree, { recursive: true, force: true });
	}
});

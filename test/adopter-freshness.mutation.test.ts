/** #365 — isolated baseline-first private-copy mutants for every named freshness guard. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "gitjig-365-mutants-"));
after(() => rmSync(root, { recursive: true, force: true }));

const FRESHNESS = ".pi/extensions/gitjig/install/freshness.ts";
const CLASSIFIER = ".pi/extensions/gitjig/install/classifier.ts";
const COMMAND = ".pi/extensions/gitjig/commands/freshness.ts";
const TEST = "test/adopter-freshness.unit.test.ts";

const mutations: ReadonlyArray<readonly [string, string, string, string]> = [
	[
		"membership omission: members no manifest lists are dropped",
		FRESHNESS,
		'members.map(({ path, bytes }) => ({ path, class: "carried" as const, bytes })),',
		'members\n\t\t\t\t.filter(({ path }) => committed.manifest.some((entry) => entry.path === path))\n\t\t\t\t.map(({ path, bytes }) => ({ path, class: "carried" as const, bytes })),',
	],
	[
		"installed-pin omission: the record is never compared",
		FRESHNESS,
		"\t\tinstalled === undefined ||\n\t\t!sourceEqual(installed.source, committed.source) ||\n\t\tinstalled.revision !== committed.revision ||\n\t\tinstalled.payloadDigest !== committed.payloadDigest\n",
		"\t\tfalse\n",
	],
	[
		"stale/current inversion",
		FRESHNESS,
		'if (!agrees(committed, inputs.capture)) return result("session-stale", RELOAD_COMMAND);',
		'if (agrees(committed, inputs.capture)) return result("session-stale", RELOAD_COMMAND);',
	],
	[
		"mismatch-precedence inversion: a differing projection reads stale",
		FRESHNESS,
		'if (!agrees(committed, inputs.projection)) return result("placement-mismatch", PROVISION_COMMAND);',
		'if (!agrees(committed, inputs.projection)) return result("session-stale", RELOAD_COMMAND);',
	],
	[
		"a failure read as current: an unobserved projection agrees",
		FRESHNESS,
		'observation.kind === "observed" && carriedAggregate(committed, observation.members) === committed.carriedDigest',
		'observation.kind !== "observed" || carriedAggregate(committed, observation.members) === committed.carriedDigest',
	],
	[
		"a mutation: the measurement advances the installed record",
		FRESHNESS,
		"\tconst installedPin = readPinFile(targetRoot, INSTALLED_PIN_PATH);\n",
		'\tif (committedPin.kind === "bytes") process.getBuiltinModule("node:fs").writeFileSync(join(targetRoot, INSTALLED_PIN_PATH), committedPin.bytes);\n\tconst installedPin = readPinFile(targetRoot, INSTALLED_PIN_PATH);\n',
	],
	[
		"a link refusal reshaped: a linked member reads as unreadable, not differs",
		CLASSIFIER,
		'\t\t\tstats.isSymbolicLink() ? "candidate is a symlink" : "candidate is non-regular",\n\t\t\t"differs",',
		'\t\t\tstats.isSymbolicLink() ? "candidate is a symlink" : "candidate is non-regular",\n\t\t\t"unreadable",',
	],
	[
		"a linked container walked",
		CLASSIFIER,
		'throw new ClassificationRefusal("carried container is non-regular", "differs");',
		"continue;",
	],
	[
		"extras omitted by the observer: only manifest roots' entry file read",
		CLASSIFIER,
		"else if (stats.isDirectory() && !stats.isSymbolicLink()) walk(abs, Buffer.from(carried), found, stats, bounded);",
		"else if (stats.isDirectory() && !stats.isSymbolicLink()) return;",
	],
	[
		"source omission: a record naming another source agrees",
		FRESHNESS,
		"\t\t!sourceEqual(installed.source, committed.source) ||\n",
		"",
	],
	[
		"the measurement's own budget omitted",
		FRESHNESS,
		'\tif (clock() > deadline) projection = { kind: "unreadable" };\n',
		"",
	],
	["the code capture retaken on a factory re-run", FRESHNESS, "\tif (held !== undefined) return held;\n", ""],
	[
		"the prompts compared for staleness",
		FRESHNESS,
		"capture: capture === undefined ? undefined : withCurrentPrompts(capture, projection),",
		'capture: capture === undefined ? undefined : withCurrentPrompts(observeCarried(targetRoot, deadline), { kind: "observed", members: [] }),',
	],
	[
		"the byte bound omitted after the reads",
		CLASSIFIER,
		"total + member.bytes.length, 0) > (options.maxBytes ?? MAX_CARRIED_BYTES)",
		"total + member.bytes.length, 0) > Number.POSITIVE_INFINITY",
	],
	[
		"a name or byte refusal read as unreadable",
		CLASSIFIER,
		'if (error instanceof ClassificationRefusal) throw Object.assign(error, { shape: "differs" as const });',
		"if (error instanceof ClassificationRefusal) throw error;",
	],
	[
		"the renderer's help branch",
		COMMAND,
		'if (message.details === "help") return new Text(FRESHNESS_HELP, options.outputPad, 0);',
		'if (message.details === "help") return new Text("x", options.outputPad, 0);',
	],
	[
		"the renderer's record branch",
		COMMAND,
		'outcome === undefined ? "[invalid gitjig freshness record]" : freshnessLine(outcome),',
		'outcome === undefined ? "[invalid gitjig freshness record]" : "x",',
	],
	[
		"the command writes: it copies the committed pin over the record before measuring",
		COMMAND,
		"const outcome = help ? undefined : measureFreshness(repoRoot, capture, Date.now, session);",
		'if (!help) process.getBuiltinModule("node:fs").copyFileSync(`${repoRoot}/.pi/gitjig.pin.json`, `${repoRoot}/.gitjig/installed-pin.json`);\n\t\t\tconst outcome = help ? undefined : measureFreshness(repoRoot, capture, Date.now, session);',
	],
	[
		"the measurement's deadline not handed to the walk",
		FRESHNESS,
		"let projection = observeCarried(targetRoot, deadline);",
		"let projection = observeCarried(targetRoot, Number.POSITIVE_INFINITY);",
	],
	[
		"one root's absent container hides the others",
		CLASSIFIER,
		"if (containers === undefined) return;",
		'if (containers === undefined) throw new Error("one absent container ends the walk");',
	],
	[
		"a blocking pin open",
		FRESHNESS,
		"constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK",
		"constants.O_RDONLY | constants.O_NOFOLLOW",
	],
	[
		"a blocking member open",
		CLASSIFIER,
		"descriptor = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);",
		"descriptor = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);",
	],
	[
		"a pin container replaced by a link is followed",
		FRESHNESS,
		'if (!sameObject(opened, lstatSync(absolute)) || !containersHeld()) return { kind: "unreadable" };',
		'if (!sameObject(opened, lstatSync(absolute))) return { kind: "unreadable" };',
	],
	[
		"a carried container replaced by a link is followed",
		CLASSIFIER,
		'\t\t\t\tfor (const container of containers)\n\t\t\t\t\tif (!sameObject(container.stats, lstatSync(container.path)))\n\t\t\t\t\t\tthrow new ClassificationRefusal("carried container identity changed");\n',
		"",
	],
	["the byte bound applied only after every read", CLASSIFIER, "\toptions.admitSize?.(stats.size);\n", ""],
	[
		"a root- or container-level difference ends the walk",
		CLASSIFIER,
		'\t\t\tif (!(error instanceof ClassificationRefusal) || error.shape !== "differs") throw error;\n\t\t\tdiffers = true;',
		"\t\t\tthrow error;",
	],
	[
		"a difference decided before the post-read byte bound",
		CLASSIFIER,
		'\tif (found.reduce((total, member) => total + member.bytes.length, 0) > (options.maxBytes ?? MAX_CARRIED_BYTES))\n\t\treturn { kind: "unreadable" };\n\tif (differs) return { kind: "differs" };',
		'\tif (differs) return { kind: "differs" };\n\tif (found.reduce((total, member) => total + member.bytes.length, 0) > (options.maxBytes ?? MAX_CARRIED_BYTES))\n\t\treturn { kind: "unreadable" };',
	],
	[
		"the default pre-read byte bound widened",
		CLASSIFIER,
		"\t\t\tif (admitted > (options.maxBytes ?? MAX_CARRIED_BYTES))",
		"\t\t\tif (admitted > (options.maxBytes ?? Number.POSITIVE_INFINITY))",
	],
	[
		"the first difference ends the walk, so path order decides",
		CLASSIFIER,
		"\t\tonDiffers: () => {\n\t\t\tdiffers = true;\n\t\t},\n",
		"",
	],
	[
		"the committed pin read from the working tree",
		FRESHNESS,
		"\tconst committedPin = readCommittedPin(targetRoot, deadline - clock());\n",
		"\tconst committedPin = readPinFile(targetRoot, GENERATED_PIN_PATH);\n",
	],
	[
		"a session in another clone read as this tree",
		FRESHNESS,
		'if (session !== undefined && realpathOrSelf(session) !== realpathOrSelf(targetRoot)) projection = { kind: "differs" };',
		"",
	],
	[
		"the command ignores the session's cwd",
		COMMAND,
		'const session = typeof cwd === "string" ? sessionClone(cwd) : undefined;',
		"const session = undefined;",
	],
	[
		"a record differing only in a handed-over file agrees",
		FRESHNESS,
		"\t\tinstalled.revision !== committed.revision ||\n\t\tinstalled.payloadDigest !== committed.payloadDigest\n",
		"\t\tinstalled.revision !== committed.revision\n",
	],
	["the committed-pin read is unbounded", FRESHNESS, "\t\ttimeout: timeoutMs,\n", ""],
	[
		"the committed-pin read inherits the caller's environment",
		FRESHNESS,
		"\t\t\tenv: {\n\t\t\t\tPATH:",
		"\t\t\tenv: {\n\t\t\t\t...process.env,\n\t\t\t\tPATH:",
	],
	[
		"the committed-pin read climbs into an enclosing repository",
		FRESHNESS,
		"\t\t\t\tGIT_CEILING_DIRECTORIES: dirname(realpathOrSelf(targetRoot)),\n",
		"",
	],
	["the committed pin read from the index", FRESHNESS, "`HEAD:${GENERATED_PIN_PATH}`", "`:${GENERATED_PIN_PATH}`"],
	["the committed-pin read follows replace refs", FRESHNESS, '\t\t\tGIT_NO_REPLACE_OBJECTS: "1",\n', ""],
	[
		"the committed-pin read may fetch lazily",
		FRESHNESS,
		'["--no-lazy-fetch", "-C", resolve(targetRoot), "cat-file"',
		'["-C", resolve(targetRoot), "cat-file"',
	],
	[
		"an unbounded observation",
		CLASSIFIER,
		'if (Date.now() > deadline) throw new ClassificationRefusal("carried observation is past its bound");',
		"",
	],
];

function run(name: string, mutation?: (typeof mutations)[number]): ReturnType<typeof spawnSync> {
	const box = mkdtempSync(join(root, `${name.replace(/[^a-z]+/giu, "-").slice(0, 40)}-`));
	cpSync(join(repository, ".pi"), join(box, ".pi"), { recursive: true });
	cpSync(join(repository, ".github/bin"), join(box, ".github/bin"), { recursive: true });
	mkdirSync(join(box, "test"), { recursive: true });
	cpSync(join(repository, TEST), join(box, TEST));
	symlinkSync(join(repository, "node_modules"), join(box, "node_modules"), "dir");
	if (mutation !== undefined) {
		const [label, file, from, to] = mutation;
		const target = join(box, file);
		const source = readFileSync(target, "utf8");
		assert.notEqual(source.indexOf(from), -1, `${label}: mutation target must exist`);
		assert.equal(source.indexOf(from), source.lastIndexOf(from), `${label}: mutation target must be unique`);
		writeFileSync(
			target,
			source.replace(from, () => to),
		);
	}
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	return spawnSync(process.execPath, ["--test", TEST], { cwd: box, encoding: "utf8", timeout: 180_000, env });
}

describe("#365 baseline-first isolated freshness mutants", () => {
	it("passes the isolated baseline", () => {
		const result = run("baseline");
		assert.equal(result.status, 0, `${String(result.stdout)}\n${String(result.stderr)}`);
	});

	for (const mutation of mutations) {
		it(`kills ${mutation[0]} on an assertion`, () => {
			const result = run(mutation[0], mutation);
			assert.notEqual(result.status, 0, `${mutation[0]} survived`);
			assert.match(
				`${String(result.stdout)}${String(result.stderr)}`,
				/ERR_ASSERTION|AssertionError/,
				`${mutation[0]} died without an assertion`,
			);
		});
	}
});

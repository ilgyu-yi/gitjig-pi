/**
 * #418 (part 5 of #370): the trusted `submit_result` tool, its parent-owned
 * provisioner and the consumer-owned role profiles.
 *
 * `test/pi-profile.unit.test.ts` measures producer/consumer parity over the
 * profiles. This file measures the tool itself: what it refuses, what the
 * provisioner leaves behind when it fails, the ORDER in which a slot is
 * published, and whether the bytes a successful submission installs are ones
 * the dispatcher's admission and the owning consumer parser actually take.
 *
 * Everything runs against a private copy of the whole `.pi` subtree, because
 * the tool is designed to be copied: the provisioner reads its sources
 * relative to its own module URL, and the copied tool resolves `./operand.ts`
 * and its profile beside itself. Copying is therefore the ordinary way to
 * exercise it, and it also lets an arm delete, replace or instrument a source
 * the installed tree owns.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { admitReturn } from "../.pi/extensions/gitjig/dispatch/admit.ts";
import { exposedPiProfile } from "../.pi/extensions/gitjig/dispatch/pi-submit.ts";
import type { JsonSchema, Profile } from "../.pi/extensions/gitjig/dispatch/pi-submit-extension.ts";
import { matchesProfile } from "../.pi/extensions/gitjig/dispatch/pi-submit-extension.ts";
import type { DispatchContext } from "../.pi/extensions/gitjig/dispatch/provision.ts";
import { acceptsRecoveryPiPayload } from "../.pi/extensions/gitjig/recovery/coordinator.ts";
import { recoveryPiProfile } from "../.pi/extensions/gitjig/recovery/pi-profile.ts";
import { admitDiagnosis } from "../.pi/extensions/gitjig/review/history.ts";
import { reviewerReturnFromPayload } from "../.pi/extensions/gitjig/review/join.ts";
import { REVIEW_PI_PROFILES } from "../.pi/extensions/gitjig/review/pi-profile.ts";
import { indexedAdjudicationFromPayload } from "../.pi/extensions/gitjig/review/resolve.ts";

const extensionsRoot = fileURLToPath(new URL("../.pi", import.meta.url));
/** Every repository-locating variable the tool removes before asking git. */
const REPOSITORY_LOCATING = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_COMMON_DIR",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
] as const;
const SUBMIT_RELATIVE = "extensions/gitjig/dispatch/pi-submit.ts";
const TOOL_RELATIVE = "extensions/gitjig/dispatch/pi-submit-extension.ts";

type RegisteredTool = {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (id: string, args: unknown) => Promise<{ content: unknown[]; details: unknown }>;
};

/** A private copy of the whole `.pi` subtree, with optional source edits. */
function copyExtensions(scratch: string, edits: ReadonlyArray<readonly [string, string, string]> = []): string {
	const root = join(scratch, "pi-copy");
	cpSync(extensionsRoot, root, { recursive: true });
	for (const [relative, anchor, replacement] of edits) {
		const path = join(root, relative);
		const source = readFileSync(path, "utf8");
		assert.notEqual(source.indexOf(anchor), -1, `mutation anchor must exist in ${relative}: ${anchor}`);
		assert.equal(source.indexOf(anchor), source.lastIndexOf(anchor), `anchor must be unique in ${relative}`);
		writeFileSync(
			path,
			source.replace(anchor, () => replacement),
		);
	}
	return root;
}

function dispatchContext(scratch: string): DispatchContext {
	const tree = join(scratch, "tree");
	mkdirSync(tree, { recursive: true });
	return {
		scratchRoot: scratch,
		treeDir: tree,
		stateDir: join(scratch, "state"),
		briefPath: join(scratch, "brief.md"),
		returnPath: join(scratch, "return.json"),
		heldHash: "a".repeat(40),
	};
}

/** The HEAD the tool will resolve: it asks git in the process's own cwd. */
function headHere(): string {
	return execFileSync("git", ["rev-parse", "--verify", "HEAD"], { encoding: "utf8" }).trim();
}

/** Provision from a private copy and register the tool through a fake Pi API. */
async function registerFromCopy(
	root: string,
	context: DispatchContext,
	profile: Profile,
	beforeRegister?: (base: string) => void,
): Promise<{ tool: RegisteredTool; base: string }> {
	const { provisionPiSubmitTool } = await import(pathToFileURL(join(root, SUBMIT_RELATIVE)).href);
	const destination: string = provisionPiSubmitTool(context, profile);
	// The tool resolves its relative imports beside the COPY the provisioner
	// made, so anything an arm wants it to import has to land there.
	beforeRegister?.(join(context.scratchRoot, "trusted-pi"));
	const registered: RegisteredTool[] = [];
	const { default: register } = await import(pathToFileURL(destination).href);
	register({ registerTool: (tool: RegisteredTool) => registered.push(tool) });
	assert.equal(registered.length, 1, "registration must expose exactly one tool");
	return { tool: registered[0], base: join(context.scratchRoot, "trusted-pi") };
}

/** Run `scenario` in a scratch with a private `.pi` copy, cleaning up after. */
async function withCopy<T>(
	edits: ReadonlyArray<readonly [string, string, string]>,
	scenario: (root: string, context: DispatchContext, scratch: string) => Promise<T>,
): Promise<T> {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-418-"));
	try {
		return await scenario(copyExtensions(scratch, edits), dispatchContext(scratch), scratch);
	} finally {
		// Sources are copied read-only; make the tree writable again to remove it.
		try {
			chmodSync(join(scratch, "pi-copy", TOOL_RELATIVE), 0o600);
		} catch {}
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Every profile this part ships, with one payload its consumer accepts. */
const SPEC_DIGEST = "b".repeat(64);
function profiles(): ReadonlyArray<{
	name: string;
	profile: Profile;
	valid: Record<string, unknown>;
	accepts: (payload: string) => boolean;
}> {
	const recovery = (role: Parameters<typeof recoveryPiProfile>[0], valid: Record<string, unknown>) => {
		const profile = recoveryPiProfile(role, SPEC_DIGEST);
		assert.notEqual(profile, undefined, `profile missing: ${role}`);
		return {
			name: `recovery-${role}`,
			profile: profile as Profile,
			valid,
			accepts: (payload: string) => acceptsRecoveryPiPayload(role, JSON.parse(payload) as unknown, SPEC_DIGEST),
		};
	};
	return [
		{
			name: "reviewer",
			profile: REVIEW_PI_PROFILES.reviewer,
			valid: { token: "APPROVED", findings: [] },
			accepts: (payload) => !("failure" in reviewerReturnFromPayload(payload)),
		},
		{
			name: "judge",
			profile: REVIEW_PI_PROFILES.judge,
			valid: {
				dedupAttested: true,
				rulings: [
					{
						finding: "one finding",
						rawOrdinals: [0],
						provenance: [{ lens: "suite", surface: "the test suite" }],
						validity: "CONFIRMED",
						severity: "SUBSTANTIVE",
						direction: "live-harm",
						onCriterion: true,
						evidence: "measured",
					},
				],
			},
			accepts: (payload) => indexedAdjudicationFromPayload(payload) !== undefined,
		},
		{
			name: "history",
			profile: REVIEW_PI_PROFILES.history,
			valid: { value: "NONE", invalidation: "nothing", evidence: "each repair closed new ground" },
			accepts: (payload) =>
				admitDiagnosis({
					disposition: "admitted",
					ok: true,
					compare: "confirmed",
					summary: "history-result",
					payload,
				} as unknown as Parameters<typeof admitDiagnosis>[0]).available,
		},
		recovery("challenger", { outcome: "BASE_STANDS", method: "", evidence: "no alternative stands" }),
		recovery("selector-contest", { selected: "none", materiallyDifferent: false, evidence: "no candidate" }),
		recovery("selector-measurement", {
			question: "which limb refuses",
			method: "run the arm twice",
			expectedDiscriminator: "a differing exit",
			evidence: "bounded and non-mutating",
		}),
		recovery("measurement", { result: "the arm refused", evidence: "exit 1 both times" }),
		recovery("diagnosis", { value: "NONE", invalidation: "nothing", evidence: "the repairs advanced" }),
	];
}

/** The message `act` threw, or undefined if it did not throw. */
async function refusal(act: () => unknown | Promise<unknown>): Promise<string | undefined> {
	try {
		await act();
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

const refuses = (tool: RegisteredTool, args: unknown): Promise<string | undefined> =>
	refusal(() => tool.execute("call", args));

test("the provisioner installs the tool, the ruled operand predicate and the exposed profile", async () => {
	await withCopy([], async (root, context) => {
		const { base } = await registerFromCopy(root, context, REVIEW_PI_PROFILES.reviewer);
		assert.deepEqual(readdirSync(base).sort(), ["operand.ts", "profile.json", "submit.ts"]);
		// The copied tool's `./operand.ts` import resolves to the copied
		// predicate, not to the installed tree's.
		const copied = readFileSync(join(base, "operand.ts"), "utf8");
		assert.ok(copied.includes("export function namesHeldOperand"), "the ruled predicate was not copied");
		// The written profile is the EXPOSED one: the caller's closed payload
		// plus the summary property the caller adds and the delegate never chooses.
		const written = JSON.parse(readFileSync(join(base, "profile.json"), "utf8")) as Profile;
		assert.deepEqual(written.schema.properties?.summary, { type: "string", minLength: 1, maxLength: 6000 });
		assert.deepEqual(
			Object.keys(written.schema.properties ?? {}).sort(),
			[...Object.keys(REVIEW_PI_PROFILES.reviewer.schema.properties ?? {}), "summary"].sort(),
		);
	});
});

test("each provisioner failure is its own outcome, with the artifacts it leaves", async () => {
	// A scratch directory that already exists fails at the first non-recursive
	// mkdir, whether it is a directory or a file, and leaves it untouched.
	for (const kind of ["directory", "file"] as const) {
		await withCopy([], async (root, context, scratch) => {
			const base = join(scratch, "trusted-pi");
			if (kind === "directory") mkdirSync(base);
			else writeFileSync(base, "occupied");
			const { provisionPiSubmitTool } = await import(pathToFileURL(join(root, SUBMIT_RELATIVE)).href);
			const error = await refusal(() => provisionPiSubmitTool(context, REVIEW_PI_PROFILES.reviewer));
			assert.match(String(error), /EEXIST/, kind);
			if (kind === "directory") assert.deepEqual(readdirSync(base), [], "the existing directory was written into");
			else assert.equal(readFileSync(base, "utf8"), "occupied", "the existing file was replaced");
		});
	}

	// A scratch root that cannot be written fails there too.
	await withCopy([], async (root, context, scratch) => {
		const locked = join(scratch, "locked");
		mkdirSync(locked, { mode: 0o500 });
		const { provisionPiSubmitTool } = await import(pathToFileURL(join(root, SUBMIT_RELATIVE)).href);
		try {
			assert.match(
				String(
					await refusal(() => provisionPiSubmitTool({ ...context, scratchRoot: locked }, REVIEW_PI_PROFILES.reviewer)),
				),
				/EACCES|EPERM/,
			);
			assert.deepEqual(readdirSync(locked), [], "a directory was created under an unwritable root");
		} finally {
			chmodSync(locked, 0o700);
		}
	});

	// A source that exists but is not a regular file reaches the AUTHORED
	// refusal; a MISSING source instead throws from lstat before that check.
	// The two are different outcomes and leave different artifacts.
	for (const [label, relative, message, remaining] of [
		["tool source", TOOL_RELATIVE, "trusted Pi tool source refused", []],
		["operand source", "extensions/gitjig/dispatch/operand.ts", "trusted Pi operand source refused", ["submit.ts"]],
	] as ReadonlyArray<readonly [string, string, string, string[]]>) {
		await withCopy([], async (root, context, scratch) => {
			const source = join(root, relative);
			rmSync(source);
			mkdirSync(source);
			const { provisionPiSubmitTool } = await import(pathToFileURL(join(root, SUBMIT_RELATIVE)).href);
			assert.equal(await refusal(() => provisionPiSubmitTool(context, REVIEW_PI_PROFILES.reviewer)), message, label);
			assert.deepEqual(readdirSync(join(scratch, "trusted-pi")).sort(), remaining, `${label}: artifacts`);
		});
		await withCopy([], async (root, context, scratch) => {
			rmSync(join(root, relative));
			const { provisionPiSubmitTool } = await import(pathToFileURL(join(root, SUBMIT_RELATIVE)).href);
			const error = String(await refusal(() => provisionPiSubmitTool(context, REVIEW_PI_PROFILES.reviewer)));
			assert.match(error, /ENOENT/, `${label}: a missing source must not reach the authored refusal`);
			assert.notEqual(error, message, `${label}: a missing source reached the authored refusal`);
			assert.deepEqual(readdirSync(join(scratch, "trusted-pi")).sort(), remaining, `${label}: artifacts`);
		});
	}

	// A source that exists, is regular, and cannot be read fails in the copy,
	// after the directory — and for the operand, after the tool copy — exists.
	await withCopy([], async (root, context, scratch) => {
		chmodSync(join(root, TOOL_RELATIVE), 0o000);
		const { provisionPiSubmitTool } = await import(pathToFileURL(join(root, SUBMIT_RELATIVE)).href);
		assert.match(
			String(await refusal(() => provisionPiSubmitTool(context, REVIEW_PI_PROFILES.reviewer))),
			/EACCES|EPERM/,
		);
		assert.deepEqual(readdirSync(join(scratch, "trusted-pi")), [], "an unreadable tool source left artifacts");
	});
});

test("registration refuses every profile shape outside the closed one", async () => {
	const valid = JSON.stringify(REVIEW_PI_PROFILES.reviewer);
	for (const [label, written] of [
		["not JSON", "{ this is not json"],
		["an array", "[]"],
		["a missing key", JSON.stringify({ role: "reviewer", schema: { type: "object" }, summary: "s" })],
		["an extra key", JSON.stringify({ ...REVIEW_PI_PROFILES.reviewer, extra: 1 })],
		["an unknown role", valid.replace('"reviewer"', '"auditor"')],
		["an empty summary", JSON.stringify({ ...REVIEW_PI_PROFILES.reviewer, summary: "" })],
		["a non-object schema", JSON.stringify({ ...REVIEW_PI_PROFILES.reviewer, schema: { type: "string" } })],
		["a fixed value that is a number", JSON.stringify({ ...REVIEW_PI_PROFILES.reviewer, fixed: { kind: 1 } })],
		["a fixed value that is null", JSON.stringify({ ...REVIEW_PI_PROFILES.reviewer, fixed: { kind: null } })],
		["a fixed value that is an object", JSON.stringify({ ...REVIEW_PI_PROFILES.reviewer, fixed: { kind: {} } })],
		[
			"a fixed key the schema also declares",
			JSON.stringify({ ...REVIEW_PI_PROFILES.reviewer, fixed: { token: "APPROVED" } }),
		],
	] as ReadonlyArray<readonly [string, string]>) {
		await withCopy([], async (root, context) => {
			const { provisionPiSubmitTool } = await import(pathToFileURL(join(root, SUBMIT_RELATIVE)).href);
			const destination: string = provisionPiSubmitTool(context, REVIEW_PI_PROFILES.reviewer);
			// Overwrite the profile the provisioner wrote: registration reads it
			// from the file, so this is the shape the child would actually load.
			writeFileSync(join(context.scratchRoot, "trusted-pi", "profile.json"), written);
			const { default: register } = await import(pathToFileURL(destination).href);
			assert.throws(
				() => register({ registerTool: () => assert.fail("a refused profile registered a tool") }),
				/submit_result profile refused|Unexpected|JSON/,
				label,
			);
		});
	}
	// An unreadable profile file refuses too, on its own read.
	await withCopy([], async (root, context) => {
		const { provisionPiSubmitTool } = await import(pathToFileURL(join(root, SUBMIT_RELATIVE)).href);
		const destination: string = provisionPiSubmitTool(context, REVIEW_PI_PROFILES.reviewer);
		chmodSync(join(context.scratchRoot, "trusted-pi", "profile.json"), 0o000);
		const { default: register } = await import(pathToFileURL(destination).href);
		assert.throws(() => register({ registerTool: () => assert.fail("registered") }), /EACCES|EPERM/);
	});
});

test("a schema that is an object but not a closed one registers a tool that refuses everything", async () => {
	// The registration check admits any object schema; `matchesProfile` then
	// refuses every value against a schema missing `properties`, `required` or
	// `additionalProperties: false`. The fail-closed composition is what holds
	// here, so it is measured rather than assumed.
	for (const loose of [
		{ type: "object" },
		{ type: "object", properties: { token: { type: "string" } } },
		{ type: "object", properties: { token: { type: "string" } }, required: ["token"] },
	] as const) {
		await withCopy([], async (root, context) => {
			const { tool } = await registerFromCopy(root, context, {
				...REVIEW_PI_PROFILES.reviewer,
				schema: loose as Profile["schema"],
			});
			assert.equal(tool.name, "submit_result");
			for (const args of [{}, { token: "APPROVED" }, { token: "APPROVED", summary: "s" }])
				assert.equal(await refuses(tool, args), "submit_result parameters rejected", JSON.stringify(loose));
			assert.equal(existsSync(context.returnPath), false, "a refused submission installed a slot");
		});
	}
});

test("a successful submission installs bytes the dispatcher and the owning parser accept", async () => {
	for (const { name, profile, valid, accepts } of profiles()) {
		// A recovery consumer pins the outer summary to its own value, so those
		// profiles expose no summary property and refuse a submitted one.
		const pinned = profile.role.startsWith("recovery-");
		for (const summary of ["an operator-written summary", undefined] as const) {
			if (pinned && summary !== undefined) {
				await withCopy([], async (root, context) => {
					const { tool } = await registerFromCopy(root, context, profile);
					assert.equal(await refuses(tool, { ...valid, summary }), "submit_result parameters rejected", name);
					assert.equal(existsSync(context.returnPath), false, name);
				});
				continue;
			}
			await withCopy([], async (root, context) => {
				const { tool } = await registerFromCopy(root, context, profile);
				await tool.execute("call", summary === undefined ? valid : { ...valid, summary });
				const admitted = admitReturn(context.returnPath);
				assert.equal(admitted.admitted, true, `${name}: the installed slot was not admitted`);
				if (!admitted.admitted) return;
				assert.equal(admitted.ok, true, name);
				// The summary is the submitted one, or the profile's own default.
				assert.equal(admitted.summary, summary ?? profile.summary, name);
				assert.equal(admitted.reviewedHead, headHere(), `${name}: the slot carries another HEAD`);
				// Encoded exactly once, and carrying the profile's fixed fields.
				assert.deepEqual(
					JSON.parse(admitted.payload ?? "null"),
					{ ...profile.fixed, ...valid },
					`${name}: payload composition`,
				);
				assert.equal(accepts(admitted.payload ?? ""), true, `${name}: the owning parser rejected the payload`);
				// The OUTER summary is the consumer's too: recovery pins it, so an
				// installed slot carrying anything else is one its consumer discards.
				if (pinned) assert.equal(admitted.summary, "recovery-result", `${name}: outer summary`);
			});
		}
	}
});

test("baseline-first private-copy mutant: a recovery profile that lets the delegate choose the outer summary", async () => {
	const profile = recoveryPiProfile("diagnosis", SPEC_DIGEST) as Profile;
	const valid = { value: "NONE", invalidation: "nothing", evidence: "the repairs advanced" };
	// Exposing the summary for a recovery role installs a slot whose outer
	// summary the recovery consumer refuses, while every inner-payload
	// assertion still passes — which is why the outer value is asserted above.
	const mutant = await withCopy(
		[["extensions/gitjig/dispatch/pi-submit.ts", 'if (profile.role.startsWith("recovery-")) return profile;', ""]],
		async (root, context) => {
			const { tool } = await registerFromCopy(root, context, profile);
			assert.equal(await refuses(tool, { ...valid, summary: "a delegate-chosen summary" }), undefined);
			return admitReturn(context.returnPath);
		},
	);
	assert.equal(mutant.admitted, true);
	if (!mutant.admitted) return;
	assert.equal(mutant.summary, "a delegate-chosen summary", "the mutant did not expose the summary");
	// The payload alone is fine; the consumer still discards the whole return.
	assert.equal(acceptsRecoveryPiPayload("diagnosis", JSON.parse(mutant.payload ?? "null"), SPEC_DIGEST), true);
	assert.notEqual(mutant.summary, "recovery-result", "the outer summary the consumer requires");
});

test("the slot is published by one link, taken only after the bytes are written and closed", async () => {
	// An instrumented copy records the filesystem calls the tool makes: a final
	// state cannot show that the link came last, because a link taken first
	// publishes an inode that later writes still mutate.
	const trace = async (edits: ReadonlyArray<readonly [string, string, string]>): Promise<string[]> =>
		withCopy(
			[
				[
					TOOL_RELATIVE,
					'import { closeSync, constants, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";',
					'import { constants, readFileSync } from "node:fs";\nimport { closeSync, fsyncSync, linkSync, openSync, unlinkSync, writeFileSync } from "./fs-trace.ts";',
				],
				...edits,
			],
			async (root, context) => {
				const tracePath = join(context.scratchRoot, "fs-trace.log");
				const shim = (base: string) =>
					writeFileSync(
						join(base, "fs-trace.ts"),
						`import { appendFileSync, closeSync as close, fsyncSync as fsync, linkSync as link, openSync as open, unlinkSync as unlink, writeFileSync as write } from "node:fs";\n` +
							`const note = (name: string) => appendFileSync(${JSON.stringify(tracePath)}, \`\${name}\\n\`);\n` +
							"export const openSync: typeof open = (...args) => {\n\tnote('open');\n\treturn open(...args);\n};\n" +
							"export const writeFileSync: typeof write = (...args) => {\n\tnote('write');\n\treturn write(...args);\n};\n" +
							"export const fsyncSync: typeof fsync = (...args) => {\n\tnote('fsync');\n\treturn fsync(...args);\n};\n" +
							"export const closeSync: typeof close = (...args) => {\n\tnote('close');\n\treturn close(...args);\n};\n" +
							"export const linkSync: typeof link = (...args) => {\n\tnote('link');\n\treturn link(...args);\n};\n" +
							"export const unlinkSync: typeof unlink = (...args) => {\n\tnote('unlink');\n\treturn unlink(...args);\n};\n",
					);
				const { tool } = await registerFromCopy(root, context, REVIEW_PI_PROFILES.reviewer, shim);
				await refuses(tool, { token: "APPROVED", findings: [] });
				return readFileSync(tracePath, "utf8").split("\n").filter(Boolean);
			},
		);

	const baseline = await trace([]);
	assert.deepEqual(baseline, ["open", "write", "fsync", "close", "link", "unlink"]);
	// Nothing touches the published name after the link.
	assert.equal(baseline.lastIndexOf("link"), baseline.length - 2, "a call followed the publishing link");
	assert.equal(baseline.filter((call) => call === "link").length, 1, "the slot was linked more than once");

	// The early-link mutant: its installed bytes are still valid, so only the
	// recorded order tells it apart from the baseline.
	const early = await trace([
		[
			TOOL_RELATIVE,
			"\t\twriteFileSync(fd, bytes);\n\t\tfsyncSync(fd);\n\t\tcloseSync(fd);\n\t\tfd = undefined;",
			"\t\tlinkSync(temp, target);\n\t\twriteFileSync(fd, bytes);\n\t\tfsyncSync(fd);\n\t\tcloseSync(fd);\n\t\tfd = undefined;",
		],
		[
			TOOL_RELATIVE,
			"\t\t// Hard-link installation is atomic and never replaces an existing return.\n\t\tlinkSync(temp, target);",
			"\t\tvoid target;",
		],
	]);
	assert.deepEqual(early, ["open", "link", "write", "fsync", "close", "unlink"]);
});

test("the slot is never replaced, and a refused submission leaves no temporary file", async () => {
	await withCopy([], async (root, context) => {
		const { tool, base } = await registerFromCopy(root, context, REVIEW_PI_PROFILES.reviewer);
		await tool.execute("call", { token: "APPROVED", findings: [] });
		const first = readFileSync(context.returnPath, "utf8");
		// A second submission cannot replace the first slot's bytes.
		assert.match(String(await refuses(tool, { token: "FINDINGS", findings: ["later"] })), /EEXIST/);
		assert.equal(readFileSync(context.returnPath, "utf8"), first, "the installed slot was replaced");
		// Nothing temporary survives either the success or that failure.
		assert.deepEqual(readdirSync(base).sort(), ["operand.ts", "profile.json", "submit.ts"]);
	});
});

test("the tool resolves the clone's HEAD itself, and refuses what it cannot resolve or trust", async () => {
	// A cwd that is not a repository: `git rev-parse` fails and nothing installs.
	await withCopy([], async (root, context, scratch) => {
		const { tool } = await registerFromCopy(root, context, REVIEW_PI_PROFILES.reviewer);
		const before = process.cwd();
		const outside = join(scratch, "not-a-repo");
		mkdirSync(outside);
		try {
			process.chdir(outside);
			assert.notEqual(await refuses(tool, { token: "APPROVED", findings: [] }), undefined, "a headless cwd submitted");
		} finally {
			process.chdir(before);
		}
		assert.equal(existsSync(context.returnPath), false, "a slot was installed without a resolved HEAD");
	});

	// A resolved value that is not a forty-character lowercase hash refuses.
	await withCopy([[TOOL_RELATIVE, "\t}).trim();", "\t}).trim().slice(0, 12);"]], async (root, context) => {
		const { tool } = await registerFromCopy(root, context, REVIEW_PI_PROFILES.reviewer);
		assert.equal(
			await refuses(tool, { token: "APPROVED", findings: [] }),
			"submit_result operand rejected",
			"a malformed HEAD was accepted",
		);
		assert.equal(existsSync(context.returnPath), false);
	});

	// The held operand named in a summary or in the payload refuses, through
	// part 1's single ruled predicate rather than a second spelling of it.
	for (const field of ["summary", "payload"] as const) {
		await withCopy([], async (root, context) => {
			const { tool } = await registerFromCopy(root, context, REVIEW_PI_PROFILES.reviewer);
			const head = headHere();
			const args =
				field === "summary"
					? { token: "APPROVED", findings: [], summary: `reviewed at ${head}` }
					: { token: "FINDINGS", findings: [`the head ${head} was named`] };
			assert.equal(await refuses(tool, args), "submit_result operand rejected", field);
			assert.equal(existsSync(context.returnPath), false, field);
		});
	}
});

/**
 * The tool resolves the clone's HEAD with git, and an inherited environment
 * can point git at another repository entirely. The scrub it makes before that
 * call is therefore part of "resolves the clone's HEAD itself": without it the
 * installed slot would carry a head the caller's environment chose.
 */
function repositoryWithOneCommit(path: string): string {
	mkdirSync(path, { recursive: true });
	const git = (...args: string[]) => {
		// This helper builds the decoy, so it must not itself inherit whatever
		// redirection an arm has already put in the environment.
		const env = { ...process.env };
		for (const name of REPOSITORY_LOCATING) delete env[name];
		return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", env });
	};
	git("init", "-q");
	git("config", "user.email", "decoy@example.invalid");
	git("config", "user.name", "decoy");
	// A developer's global `commit.gpgsign` would otherwise fail this commit.
	git("config", "commit.gpgsign", "false");
	writeFileSync(join(path, "file.txt"), "a decoy repository\n");
	git("add", "file.txt");
	git("commit", "-q", "-m", "decoy");
	return git("rev-parse", "--verify", "HEAD").trim();
}

/**
 * What each scrubbed variable has to be set to for its presence to change what
 * `git rev-parse --verify HEAD` returns. Only three of the seven can, measured
 * rather than assumed: `GIT_INDEX_FILE` is not read by this call,
 * `GIT_COMMON_DIR` is inert without `GIT_DIR`, git tolerates a `GIT_WORK_TREE`
 * that no `GIT_DIR` accompanies, and `--verify HEAD` resolves a ref without
 * reaching the object store, so `GIT_OBJECT_DIRECTORY` does not move it
 * either. Those four are carried by the shared helper's list, which other git
 * calls rely on, rather than covered here by arms that would measure nothing
 * — stated rather than quietly dropped.
 */
function redirection(decoyPath: string, _scratch: string): Record<string, Record<string, string>> {
	return {
		GIT_DIR: { GIT_DIR: join(decoyPath, ".git") },
		GIT_CONFIG_COUNT: { GIT_CONFIG_COUNT: "not-a-number" },
		GIT_CONFIG_PARAMETERS: { GIT_CONFIG_PARAMETERS: "'malformed" },
	};
}

async function redirectedHeadScenario(
	edits: ReadonlyArray<readonly [string, string, string]>,
	environment: (decoyPath: string, scratch: string) => Record<string, string> = (decoyPath) => ({
		GIT_DIR: join(decoyPath, ".git"),
		GIT_WORK_TREE: decoyPath,
		GIT_INDEX_FILE: join(decoyPath, ".git", "index"),
		GIT_OBJECT_DIRECTORY: join(decoyPath, ".git", "objects"),
		GIT_COMMON_DIR: join(decoyPath, ".git"),
		GIT_CONFIG_COUNT: "not-a-number",
		GIT_CONFIG_PARAMETERS: "'malformed",
	}),
): Promise<{ installed: string | undefined; decoy: string; real: string }> {
	const previous = Object.fromEntries(REPOSITORY_LOCATING.map((name) => [name, process.env[name]]));
	try {
		return await withCopy(edits, async (root, context, scratch) => {
			const decoyPath = join(scratch, "decoy");
			const decoy = repositoryWithOneCommit(decoyPath);
			const real = headHere();
			assert.notEqual(decoy, real, "the decoy repository shares the real HEAD");
			mkdirSync(join(scratch, "empty-objects"), { recursive: true });
			const { tool } = await registerFromCopy(root, context, REVIEW_PI_PROFILES.reviewer);
			// An inherited environment the way a caller's ambient shell carries one.
			for (const [name, value] of Object.entries(environment(decoyPath, scratch))) process.env[name] = value;
			await refuses(tool, { token: "APPROVED", findings: [] });
			const admitted = admitReturn(context.returnPath);
			return { installed: admitted.admitted ? admitted.reviewedHead : undefined, decoy, real };
		});
	} finally {
		for (const [name, value] of Object.entries(previous))
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
	}
}

test("an inherited environment cannot redirect the HEAD the tool resolves", async () => {
	const observed = await redirectedHeadScenario([]);
	assert.equal(observed.installed, observed.real, "the slot carries a head the environment chose");
});

test("baseline-first private-copy mutants: every scrubbed variable that can redirect this call is measured", async () => {
	// The whole list dropped: the environment chooses the head outright.
	const whole = await redirectedHeadScenario([
		[
			TOOL_RELATIVE,
			'\tconst env = { ...process.env };\n\tfor (const key of [\n\t\t"GIT_DIR",',
			'\tconst env = { ...process.env };\n\tfor (const key of [\n\t\t"GITJIG_UNSET_PLACEHOLDER",',
		],
	]);
	assert.notEqual(whole.installed, whole.real, "the mutant still resolved the clone's own HEAD");

	// And one variable at a time: with only that key removed from the scrub,
	// and only that variable set, the slot must stop carrying the clone's head
	// — either because git answered about the decoy or because it refused.
	for (const name of Object.keys(redirection("", ""))) {
		const only = (decoyPath: string, scratch: string) => redirection(decoyPath, scratch)[name];
		const baseline = await redirectedHeadScenario([], only);
		assert.equal(baseline.installed, baseline.real, `${name}: the baseline did not install the clone's head`);
		const mutant = await redirectedHeadScenario([[TOOL_RELATIVE, `\t\t"${name}",\n`, ""]], only);
		assert.notEqual(mutant.installed, mutant.real, `${name}: dropping it from the scrub changed nothing`);
	}
});

test("a composed return above the byte bound refuses before any candidate file exists", async () => {
	await withCopy([], async (root, context) => {
		const { tool, base } = await registerFromCopy(root, context, REVIEW_PI_PROFILES.reviewer);
		// Under the schema's own bounds — findings are unbounded strings — but
		// past the 65,536-byte return bound once composed.
		assert.equal(
			await refuses(tool, { token: "FINDINGS", findings: ["f".repeat(70_000)] }),
			"submit_result return too large",
		);
		assert.equal(existsSync(context.returnPath), false);
		assert.deepEqual(readdirSync(base).sort(), ["operand.ts", "profile.json", "submit.ts"]);
	});
});

/**
 * One way a profile can be wrong that no omission, long-string or wrong-type
 * case reaches: being WIDER than its consumer. For every bounded property a
 * profile declares, this derives a payload the consumer refuses, requires the
 * producer to refuse it too, and then widens that one restriction and shows
 * the producer admitting it — the isolated mutant the arm kills.
 */
type Restriction = {
	label: string;
	invalid: Record<string, unknown>;
	widen: (schema: JsonSchema) => JsonSchema;
};

function mapProperty(schema: JsonSchema, path: readonly string[], widen: (leaf: JsonSchema) => JsonSchema): JsonSchema {
	if (path.length === 0) return widen(schema);
	const [head, ...rest] = path;
	if (head === "[]") return { ...schema, items: mapProperty(schema.items as JsonSchema, rest, widen) };
	return {
		...schema,
		properties: {
			...(schema.properties as Record<string, JsonSchema>),
			[head]: mapProperty((schema.properties as Record<string, JsonSchema>)[head], rest, widen),
		},
	};
}

function setIn(value: Record<string, unknown>, path: readonly string[], leaf: unknown): Record<string, unknown> {
	const [head, ...rest] = path;
	if (rest.length === 0) return { ...value, [head]: leaf };
	if (rest[0] === "[]") {
		const items = value[head] as Record<string, unknown>[];
		return { ...value, [head]: [setIn(items[0], rest.slice(1), leaf), ...items.slice(1)] };
	}
	return { ...value, [head]: setIn(value[head] as Record<string, unknown>, rest, leaf) };
}

function omitIn(value: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
	const [head, ...rest] = path;
	if (rest.length === 0) {
		const { [head]: _dropped, ...kept } = value;
		return kept;
	}
	if (rest[0] === "[]") {
		const items = value[head] as Record<string, unknown>[];
		return { ...value, [head]: [omitIn(items[0], rest.slice(1)), ...items.slice(1)] };
	}
	return { ...value, [head]: omitIn(value[head] as Record<string, unknown>, rest) };
}

function restrictions(schema: JsonSchema, valid: Record<string, unknown>, at: readonly string[] = []): Restriction[] {
	const found: Restriction[] = [];
	for (const [key, property] of Object.entries(schema.properties ?? {})) {
		const path = [...at, key];
		const name = path.join(".");
		if (property.enum !== undefined)
			found.push({
				label: `${name}: a token outside its enum`,
				invalid: setIn(valid, path, "OUTSIDE-THE-ENUM"),
				widen: (whole) =>
					mapProperty(whole, path, (leaf) => ({ ...leaf, enum: [...(leaf.enum ?? []), "OUTSIDE-THE-ENUM"] })),
			});
		if (property.maxLength !== undefined)
			found.push({
				label: `${name}: one character past its length bound`,
				invalid: setIn(valid, path, "x".repeat(property.maxLength + 1)),
				widen: (whole) => mapProperty(whole, path, (leaf) => ({ ...leaf, maxLength: (leaf.maxLength ?? 0) * 4 + 8 })),
			});
		if ((schema.required ?? []).includes(key))
			found.push({
				label: `${name}: the key omitted`,
				invalid: omitIn(valid, path),
				widen: (whole) =>
					mapProperty(whole, at, (leaf) => ({ ...leaf, required: (leaf.required ?? []).filter((one) => one !== key) })),
			});
		if (property.type === "object") found.push(...restrictions(property, valid, path));
		if (property.type === "array" && property.items?.type === "object")
			found.push(...restrictions(property.items, valid, [...path, "[]"]));
	}
	return found;
}

test("no profile is wider than its consumer: every declared restriction refuses, and widening it is caught", () => {
	let measured = 0;
	for (const { name, profile, valid, accepts } of profiles()) {
		const exposed = exposedPiProfile(profile).schema;
		// The baseline payload is accepted on both sides, so each arm below
		// differs from it in exactly the restriction it names.
		assert.equal(matchesProfile(exposed, valid), true, `${name}: the baseline payload was refused`);
		assert.equal(accepts(JSON.stringify({ ...profile.fixed, ...valid })), true, `${name}: baseline`);
		const found = restrictions(profile.schema, valid);
		assert.ok(found.length > 0, `${name}: no restriction was derived`);
		for (const { label, invalid, widen } of found) {
			measured++;
			const composed = JSON.stringify({ ...profile.fixed, ...invalid });
			assert.equal(accepts(composed), false, `${name}/${label}: the consumer accepted it, so the arm measures nothing`);
			assert.equal(
				matchesProfile(exposed, invalid),
				false,
				`${name}/${label}: the producer is wider than its consumer`,
			);
			// The isolated widening mutant: with that one restriction relaxed the
			// producer admits what the consumer still refuses, which is what the
			// assertion above is here to catch.
			assert.equal(
				matchesProfile(widen(exposed), invalid),
				true,
				`${name}/${label}: widening that restriction changed nothing, so it measures nothing`,
			);
		}
	}
	// A floor, so a generator that silently stops deriving cases is visible.
	assert.ok(measured >= 40, `too few restrictions derived: ${measured}`);
});

/**
 * The consumer policy the schema cannot express. Each restriction gets a
 * payload at its own boundary, and each is widened in an isolated private copy
 * — the aggregate bound in particular is reachable by no per-field arm, since
 * four fields of 2,200 bytes each satisfy every per-field rule.
 */
const LONG = "a".repeat(2200);
const ENCODED_BOUND: readonly [string, string] = [
	'if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) return false;',
	"void encoded;",
];
const PER_FIELD_BOUND: readonly [string, string] = [
	'Buffer.byteLength(value, "utf8") > 4096',
	'Buffer.byteLength(value, "utf8") > 1024 * 1024',
];
const POLICY: ReadonlyArray<{
	label: string;
	role: Parameters<typeof recoveryPiProfile>[0];
	value: Record<string, unknown>;
	widen: ReadonlyArray<readonly [string, string]>;
	/** A profile relaxation that is part of the same mutant, where the policy
	 * restriction is redundant with one the profile's own schema declares. */
	relax?: (profile: Profile) => Profile;
}> = [
	{
		label: "the aggregate text bound that applies to only some roles",
		role: "selector-measurement",
		value: { question: LONG, method: LONG, expectedDiscriminator: LONG, evidence: LONG },
		widen: [["> 8192", "> 20000"]],
	},
	{
		label: "the per-field byte bound",
		role: "diagnosis",
		// 1,025 astral characters: inside the schema's 4,096-CHARACTER bound and
		// past the policy's 4,096-BYTE one, so only the policy layer can refuse it.
		value: { value: "NONE", invalidation: "nothing", evidence: "\u{1f600}".repeat(1025) },
		widen: [PER_FIELD_BOUND],
	},
	{
		// The policy's nonempty rule is REDUNDANT with the `minLength: 1` each
		// profile declares for a field that requires text, so no payload isolates
		// it: the pair is the policy statement together with that schema bound,
		// and each is shown inert alone below.
		label: "the nonempty rule, with the schema bound it is redundant with",
		role: "diagnosis",
		value: { value: "NONE", invalidation: "nothing", evidence: "" },
		widen: [["(!empty && value.length === 0) ||", ""]],
		relax: (profile) => ({
			...profile,
			schema: {
				...profile.schema,
				properties: {
					...(profile.schema.properties as Record<string, JsonSchema>),
					evidence: { type: "string", maxLength: 4096 },
				},
			},
		}),
	},
	{
		label: "NFC normalization",
		role: "diagnosis",
		// Decomposed e-acute: normalizing changes it, so it is not NFC.
		value: { value: "NONE", invalidation: "nothing", evidence: "e\u0301vidence" },
		widen: [['value !== value.normalize("NFC")', "false"]],
	},
	{
		label: "control characters",
		role: "diagnosis",
		value: { value: "NONE", invalidation: "nothing", evidence: "line\u0007break" },
		widen: [["point <= 0x1f ||", ""]],
	},
	{
		label: "the role condition tying an outcome to an empty method",
		role: "challenger",
		value: { outcome: "BASE_STANDS", method: "a method it must not carry", evidence: "grounds" },
		widen: [
			['if (value.outcome === "BASE_STANDS" ? value.method !== "" : value.method === "") return false;', "void value;"],
		],
	},
	{
		// The whole-value encoded bound and the per-field byte bound are
		// REDUNDANT with each other, so neither has a single-statement mutant:
		// a field of 4,096 astral characters is inside the schema's CHARACTER
		// bound while being 16 KiB of UTF-8, which both bounds refuse. The pair
		// is measured as a pair, with each member shown inert alone.
		label: "the whole-value encoded bound, with the per-field bound it is redundant with",
		role: "diagnosis",
		value: { value: "NONE", invalidation: "nothing", evidence: "\u{1f600}".repeat(4096) },
		widen: [ENCODED_BOUND, PER_FIELD_BOUND],
	},
];

test("every consumer-policy restriction refuses at its own boundary, and widening it is caught", async () => {
	for (const { label, role, value, widen, relax } of POLICY) {
		const profile = recoveryPiProfile(role, SPEC_DIGEST) as Profile;
		const relaxed = relax === undefined ? profile : relax(profile);
		// Inside the (possibly relaxed) schema, so only the policy layer refuses.
		assert.equal(matchesProfile(exposedPiProfile(relaxed).schema, value), true, `${label}: outside the schema`);
		await withCopy([], async (root, context) => {
			const { tool } = await registerFromCopy(root, context, relaxed);
			assert.equal(await refuses(tool, value), "submit_result consumer profile rejected", label);
			assert.equal(existsSync(context.returnPath), false, label);
		});
		// Where several statements hold one property, each alone must be inert:
		// reporting any of them as a kill would claim a measurement nothing made.
		const members: ReadonlyArray<readonly [string, Profile, ReadonlyArray<readonly [string, string]>]> =
			widen.length > 1
				? widen.map((one) => ["a policy statement", relaxed, [one]] as const)
				: relax === undefined
					? []
					: [["the policy statement", profile, widen] as const, ["the schema bound", relaxed, []] as const];
		for (const [member, usedProfile, edits] of members)
			await withCopy(
				edits.map(([anchor, replacement]) => [TOOL_RELATIVE, anchor, replacement] as const),
				async (root, context) => {
					const { tool } = await registerFromCopy(root, context, usedProfile);
					assert.notEqual(
						await refuses(tool, value),
						undefined,
						`${label}: ${member} alone admitted it, so it is not redundant and needs its own arm`,
					);
				},
			);
		// The widening mutant: with the restriction relaxed the submission
		// installs a slot the consumer would refuse.
		await withCopy(
			widen.map(([anchor, replacement]) => [TOOL_RELATIVE, anchor, replacement] as const),
			async (root, context) => {
				const { tool } = await registerFromCopy(root, context, relaxed);
				assert.equal(await refuses(tool, value), undefined, `${label}: widening it changed nothing`);
				const admitted = admitReturn(context.returnPath);
				assert.equal(admitted.admitted, true, label);
				if (admitted.admitted)
					assert.equal(
						acceptsRecoveryPiPayload(role, JSON.parse(admitted.payload ?? "null"), SPEC_DIGEST),
						false,
						`${label}: the consumer accepts it, so this restriction measures nothing`,
					);
			},
		);
	}
});

test("the summary bound is counted in characters, not UTF-16 units", async () => {
	await withCopy([], async (root, context) => {
		const { tool } = await registerFromCopy(root, context, REVIEW_PI_PROFILES.reviewer);
		// 6,000 astral characters are 12,000 UTF-16 units: a UTF-16 count would
		// refuse a summary the brief permits and the dispatcher admits.
		await tool.execute("call", { token: "APPROVED", findings: [], summary: "\u{1f600}".repeat(6000) });
		const admitted = admitReturn(context.returnPath);
		assert.equal(admitted.admitted, true);
	});
	await withCopy([], async (root, context) => {
		const { tool } = await registerFromCopy(root, context, REVIEW_PI_PROFILES.reviewer);
		assert.equal(
			await refuses(tool, { token: "APPROVED", findings: [], summary: "\u{1f600}".repeat(6001) }),
			"submit_result parameters rejected",
		);
	});
});

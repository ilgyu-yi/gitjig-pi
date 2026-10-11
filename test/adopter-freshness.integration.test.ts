import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { composeAdopter } from "../.pi/extensions/gitjig/install/compose.ts";
import {
	captureCarriedProjection,
	INSTALLED_PIN_PATH,
	measureFreshness,
	PROVISION_COMMAND,
	RELOAD_COMMAND,
} from "../.pi/extensions/gitjig/install/freshness.ts";
import { LocalProvisionPlatform } from "../.pi/extensions/gitjig/install/local-provision.ts";
import { GENERATED_PIN_PATH } from "../.pi/extensions/gitjig/install/pin.ts";
import { provisionAdopter } from "../.pi/extensions/gitjig/install/provision.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));
const roots: string[] = [];
after(() => {
	for (const root of roots) {
		spawnSync("chmod", ["-R", "u+rwx", root]);
		rmSync(root, { recursive: true, force: true });
	}
});
const ENV = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
function git(root: string, args: string[]): string {
	return execFileSync(
		"git",
		[
			"-C",
			root,
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"maintenance.auto=false",
			...args,
		],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...ENV, HOME: root } },
	).trim();
}
function scratch(name: string): string {
	const root = mkdtempSync(join(tmpdir(), `gitjig-365-${name}-`));
	roots.push(root);
	return root;
}

/** The changed carried file between the old and the next snapshot. */
const PROMPT = ".pi/prompts/work-on.md";
const source = { provider: "github" as const, host: "github.com" as const, owner: "example", repository: "source" };
interface Snapshot {
	root: string;
	pin: Buffer;
	carried: ReadonlyMap<string, Buffer>;
	handed: ReadonlyMap<string, Buffer>;
}
function snapshot(root: string): Snapshot {
	git(root, ["init", "-q", "-b", "main"]);
	git(root, ["add", "-A"]);
	git(root, ["commit", "-qm", "snapshot"]);
	const composition = composeAdopter({
		sourceRoot: root,
		source,
		revision: git(root, ["rev-parse", "HEAD"]),
		priorPinBytes: null,
		occupants: new Map(),
	});
	const pick = (disposition: string) =>
		new Map(
			composition.candidates
				.filter((candidate) => candidate.disposition === disposition)
				.map((candidate) => [candidate.path, Buffer.from(candidate.bytes)] as const),
		);
	return { root, pin: composition.pinBytes, carried: pick("carried"), handed: pick("handed-over") };
}
const base = scratch("snapshots");
const oldRoot = join(base, "old");
mkdirSync(oldRoot);
for (const namespace of [".pi", ".github", ".githooks", "changelog_unreleased"])
	cpSync(join(repository, namespace), join(oldRoot, namespace), { recursive: true });
const OLD = snapshot(oldRoot);
const nextRoot = join(base, "next");
cpSync(oldRoot, nextRoot, { recursive: true });
rmSync(join(nextRoot, ".git"), { recursive: true, force: true });
writeFileSync(join(nextRoot, PROMPT), Buffer.concat([readFileSync(join(nextRoot, PROMPT)), Buffer.from("\nNext.\n")]));
const NEXT = snapshot(nextRoot);

function write(target: string, path: string, bytes: Buffer): void {
	mkdirSync(dirname(join(target, path)), { recursive: true });
	writeFileSync(join(target, path), bytes);
}
/** An adopter whose history holds the handed-over files and the pin of `at`. */
function adopter(at: Snapshot): string {
	const target = scratch("target");
	git(target, ["init", "-q", "-b", "main"]);
	commitPin(target, at);
	return target;
}
function commitPin(target: string, at: Snapshot): void {
	for (const [path, bytes] of at.handed) {
		write(target, path, bytes);
		chmodSync(join(target, path), statSync(join(at.root, path)).mode & 0o777);
	}
	write(target, GENERATED_PIN_PATH, at.pin);
	git(target, ["add", "-A"]);
	git(target, ["commit", "-qm", "chore: adopt the pinned revision", "--allow-empty"]);
}
/** The real provision run against `at`, from whatever record the target holds. */
async function provision(target: string, at: Snapshot): Promise<string> {
	let installed: Buffer | null = null;
	try {
		installed = readFileSync(join(target, INSTALLED_PIN_PATH));
	} catch {}
	const result = await provisionAdopter({
		snapshotRoot: at.root,
		targetRoot: target,
		committedPinBytes: at.pin,
		installedPinBytes: installed,
		platform: new LocalProvisionPlatform(target),
	});
	return result.outcome;
}
const freshness = (target: string) => measureFreshness(target, captureCarriedProjection(target));
const MISMATCH = { state: "placement-mismatch", recovery: PROVISION_COMMAND };
const CURRENT = { state: "current", recovery: null };
/** Remove the record and every carried file that is not exactly the next bytes. */
function fallback(target: string, at: Snapshot): void {
	rmSync(join(target, INSTALLED_PIN_PATH), { force: true });
	for (const [path, bytes] of at.carried) {
		let held: Buffer | undefined;
		try {
			held = readFileSync(join(target, path));
		} catch {}
		if (held !== undefined && !held.equals(bytes)) rmSync(join(target, path), { force: true });
	}
}
/** A provisioned adopter at `at`. */
async function provisioned(at: Snapshot): Promise<string> {
	const target = adopter(at);
	assert.equal(await provision(target, at), "verified");
	assert.deepEqual(freshness(target), CURRENT);
	return target;
}

describe("#365 the recovery, shape by shape, against the real provision run", () => {
	it("converges a behind record over exact-old bytes, and an absent record over absent or exact-next bytes", async () => {
		const behind = await provisioned(OLD);
		commitPin(behind, NEXT);
		assert.deepEqual(freshness(behind), MISMATCH);
		assert.equal(await provision(behind, NEXT), "verified");
		assert.deepEqual(freshness(behind), CURRENT);

		const fresh = adopter(NEXT);
		assert.deepEqual(freshness(fresh), MISMATCH);
		assert.equal(await provision(fresh, NEXT), "verified");
		assert.deepEqual(freshness(fresh), CURRENT);

		const recordless = await provisioned(NEXT);
		rmSync(join(recordless, INSTALLED_PIN_PATH));
		assert.deepEqual(freshness(recordless), MISMATCH);
		assert.notEqual(await provision(recordless, NEXT), "refused");
		assert.deepEqual(freshness(recordless), CURRENT);
	});

	it("refuses an edited, missing or linked carried file under a present record, and restoring the exact bytes converges", async () => {
		for (const damage of ["edited", "missing", "linked"] as const) {
			const target = await provisioned(NEXT);
			const path = join(target, PROMPT);
			rmSync(path);
			if (damage === "edited") writeFileSync(path, "edited\n");
			if (damage === "linked") symlinkSync(join(NEXT.root, PROMPT), path);
			assert.deepEqual(freshness(target), MISMATCH, damage);
			assert.equal(await provision(target, NEXT), "refused", damage);
			rmSync(path, { force: true });
			write(target, PROMPT, NEXT.carried.get(PROMPT) as Buffer);
			assert.notEqual(await provision(target, NEXT), "refused", damage);
			assert.deepEqual(freshness(target), CURRENT, damage);
		}
	});

	it("removing an edited both-listed carried file alone still refuses; the record-removal fallback converges", async () => {
		const target = await provisioned(NEXT);
		writeFileSync(join(target, PROMPT), "edited\n");
		rmSync(join(target, PROMPT));
		assert.equal(await provision(target, NEXT), "refused");
		writeFileSync(join(target, PROMPT), "edited\n");
		fallback(target, NEXT);
		assert.notEqual(await provision(target, NEXT), "refused");
		assert.deepEqual(freshness(target), CURRENT);
	});

	it("refuses a malformed record; removing it and then the absent-record step converges", async () => {
		const target = await provisioned(NEXT);
		writeFileSync(join(target, INSTALLED_PIN_PATH), "not a pin\n");
		assert.deepEqual(freshness(target), MISMATCH);
		assert.equal(await provision(target, NEXT), "refused");
		fallback(target, NEXT);
		assert.notEqual(await provision(target, NEXT), "refused");
		assert.deepEqual(freshness(target), CURRENT);
	});

	it("refuses an absent record over older carried bytes; removing those converges", async () => {
		const target = await provisioned(OLD);
		commitPin(target, NEXT);
		rmSync(join(target, INSTALLED_PIN_PATH));
		assert.deepEqual(freshness(target), MISMATCH);
		assert.equal(await provision(target, NEXT), "refused");
		fallback(target, NEXT);
		assert.notEqual(await provision(target, NEXT), "refused");
		assert.deepEqual(freshness(target), CURRENT);
	});

	it("refuses a handed-over file that differs from its committed bytes; restoring it from HEAD converges", async () => {
		const target = await provisioned(NEXT);
		const handed = [...NEXT.handed.keys()][0] as string;
		writeFileSync(join(target, PROMPT), "edited\n");
		writeFileSync(join(target, handed), "handed-over edit\n");
		assert.equal(await provision(target, NEXT), "refused");
		git(target, ["checkout", "--", handed]);
		write(target, PROMPT, NEXT.carried.get(PROMPT) as Buffer);
		assert.notEqual(await provision(target, NEXT), "refused");
		assert.deepEqual(freshness(target), CURRENT);
	});

	it("leaves a carried file neither pin lists alone, so it keeps reporting until removed", async () => {
		const target = await provisioned(NEXT);
		const extra = ".pi/prompts/extra-local.md";
		write(target, extra, Buffer.from("local\n"));
		assert.deepEqual(freshness(target), MISMATCH);
		assert.notEqual(await provision(target, NEXT), "refused");
		assert.deepEqual(freshness(target), MISMATCH);
		rmSync(join(target, extra));
		assert.deepEqual(freshness(target), CURRENT);
	});
});

/** Run the target's own installed Pi with scripted turns, returning its freshness entries. */
function runTargetPi(
	target: string,
	messages: string[],
	script: unknown[] = [{ kind: "text", text: "ok" }],
): Array<Record<string, unknown>> {
	const root = scratch("pi");
	const agent = join(root, "pi-agent");
	const sessions = join(root, "sessions");
	for (const path of [join(agent, "extensions"), sessions, join(root, "state"), join(root, "home")])
		mkdirSync(path, { recursive: true });
	cpSync(join(repository, "test/harness/scripted-provider.ts"), join(agent, "extensions/scripted-provider.ts"));
	writeFileSync(join(root, "script.json"), `${JSON.stringify(script)}\n`);
	const result = spawnSync(
		"pi",
		[
			"-p",
			"--mode",
			"json",
			...messages,
			"done",
			"-a",
			"--session-dir",
			sessions,
			"--provider",
			"scripted",
			"--model",
			"scripted-model",
		],
		{
			cwd: target,
			encoding: "utf8",
			timeout: 120_000,
			maxBuffer: 4 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				PATH: process.env.PATH,
				HOME: join(root, "home"),
				PI_CODING_AGENT_DIR: agent,
				PI_OFFLINE: "1",
				GITJIG_TEST_STATE_ROOT: join(root, "state"),
				GIT_CONFIG_NOSYSTEM: "1",
			},
		},
	);
	assert.equal(result.status, 0, result.stderr);
	// A command alone takes no model turn and Pi persists no session for it,
	// so every run ends with one ordinary message.
	const entries: Array<Record<string, unknown>> = [];
	for (const file of readdirSync(sessions).filter((name) => name.endsWith(".jsonl")))
		for (const line of readFileSync(join(sessions, file), "utf8").split("\n").filter(Boolean))
			entries.push(JSON.parse(line));
	return entries.filter((entry) => entry.type === "custom_message" && entry.customType === "gitjig-freshness");
}
const only = (entries: Array<Record<string, unknown>>) => {
	assert.equal(entries.length, 1, JSON.stringify(entries));
	return entries[0] as Record<string, unknown>;
};

describe("#365 /freshness in the target's own installed Pi", () => {
	it("renders current, then placement-mismatch, as one content-free message each, changing nothing", async () => {
		const target = await provisioned(NEXT);
		const pins = () => [GENERATED_PIN_PATH, INSTALLED_PIN_PATH].map((path) => readFileSync(join(target, path)));
		const before = pins();
		const current = only(runTargetPi(target, ["/freshness"]));
		assert.deepEqual(current.details, CURRENT);
		assert.equal(current.content, "gitjig freshness: current");
		assert.equal(current.display, true);
		assert.deepEqual(pins(), before);
		writeFileSync(join(target, PROMPT), "edited\n");
		const mismatch = only(runTargetPi(target, ["/freshness"]));
		assert.deepEqual(mismatch.details, MISMATCH);
		assert.equal(
			mismatch.content,
			`gitjig freshness: placement-mismatch — run ${PROVISION_COMMAND} (see /freshness help)`,
		);
		assert.ok(!String(mismatch.content).includes(target), "the message names no path");
	});

	it("renders session-stale when the files were corrected after this session loaded", async () => {
		const target = await provisioned(NEXT);
		writeFileSync(join(target, PROMPT), "edited before load\n");
		const restore = `cp ${JSON.stringify(join(NEXT.root, PROMPT))} ${JSON.stringify(join(target, PROMPT))}`;
		const stale = only(
			runTargetPi(
				target,
				["restore the prompt", "/freshness"],
				[
					{ kind: "toolCall", name: "bash", arguments: { command: restore } },
					{ kind: "text", text: "restored" },
				],
			),
		);
		assert.deepEqual(stale.details, { state: "session-stale", recovery: RELOAD_COMMAND });
	});

	it("renders cannot-measure for an unreadable record, and its help names the shapes", async (context) => {
		if (process.getuid?.() === 0) return context.skip("root reads a mode-000 file");
		const target = await provisioned(NEXT);
		chmodSync(join(target, INSTALLED_PIN_PATH), 0o000);
		const unknown = only(runTargetPi(target, ["/freshness"]));
		assert.deepEqual(unknown.details, { state: "cannot-measure", recovery: PROVISION_COMMAND });
		chmodSync(join(target, INSTALLED_PIN_PATH), 0o600);
		const help = only(runTargetPi(target, ["/freshness help"]));
		assert.equal(help.details, "help");
		assert.match(String(help.content), /Known false positives/);
		assert.match(String(help.content), /still refuses/);
	});
});

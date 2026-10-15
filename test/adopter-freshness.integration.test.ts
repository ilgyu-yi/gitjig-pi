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
import { FRESHNESS_HELP } from "../.pi/extensions/gitjig/commands/freshness.ts";
import { observeCarried } from "../.pi/extensions/gitjig/install/classifier.ts";
import { composeAdopter } from "../.pi/extensions/gitjig/install/compose.ts";
import {
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
	// As the provision CLI reads it: absent is null, any other failure refuses.
	let installed: Buffer | null = null;
	try {
		installed = readFileSync(join(target, INSTALLED_PIN_PATH));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "refused";
	}
	const result = await provisionAdopter({
		snapshotRoot: at.root,
		targetRoot: target,
		committedPinBytes: at.pin,
		installedPinBytes: installed,
		platform: new LocalProvisionPlatform(target),
	});
	return result.outcome;
}
/** A measurement in a session loaded now: its capture is a fresh observation of the files. */
const freshness = (target: string) => measureFreshness(target, observeCarried(target, Date.now() + 2000));
const MISMATCH = { state: "placement-mismatch", recovery: PROVISION_COMMAND };
const CURRENT = { state: "current", recovery: null };
/** A provisioned adopter at `at`. */
async function provisioned(at: Snapshot): Promise<string> {
	const target = adopter(at);
	assert.equal(await provision(target, at), "verified");
	assert.deepEqual(freshness(target), CURRENT);
	return target;
}

describe("#365 the false positives /freshness help states, as the real provision run shows them", () => {
	it("reads placement-mismatch while a provision runs, until it advances the record", async () => {
		/** The real platform, measured at the moment it is about to advance the record. */
		class Probe extends LocalProvisionPlatform {
			seen: unknown;
			override async advanceInstalledPin(pinBytes: Buffer): Promise<Buffer | null> {
				this.seen = freshness(this.root);
				return super.advanceInstalledPin(pinBytes);
			}
		}
		const upgrade = await provisioned(OLD);
		commitPin(upgrade, NEXT);
		const install = adopter(NEXT);
		for (const [label, target, record] of [
			["upgrade", upgrade, readFileSync(join(upgrade, INSTALLED_PIN_PATH))],
			["first install", install, null],
		] as const) {
			const probe = new Probe(target);
			const result = await provisionAdopter({
				snapshotRoot: NEXT.root,
				targetRoot: target,
				committedPinBytes: NEXT.pin,
				installedPinBytes: record,
				platform: probe,
			});
			assert.equal(result.outcome, "verified", label);
			assert.deepEqual(probe.seen, MISMATCH, label);
			assert.deepEqual(freshness(target), CURRENT, label);
		}
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
	it("renders current, then placement-mismatch, as one content-free message each, leaving both pins' bytes unchanged", async () => {
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

	it("renders session-stale when the extension's files were corrected after this process loaded", async () => {
		// A carried file the extension reads only when used, so a damaged copy loads.
		const PROFILES = ".pi/extensions/gitjig/recovery/profiles.json";
		const target = await provisioned(NEXT);
		writeFileSync(join(target, PROFILES), "edited before load\n");
		const restore = `cp ${JSON.stringify(join(NEXT.root, PROFILES))} ${JSON.stringify(join(target, PROFILES))}`;
		const stale = only(
			runTargetPi(
				target,
				["restore the file", "/freshness"],
				[
					{ kind: "toolCall", name: "bash", arguments: { command: restore } },
					{ kind: "text", text: "restored" },
				],
			),
		);
		assert.deepEqual(stale.details, { state: "session-stale", recovery: RELOAD_COMMAND });
	});

	it("renders placement-mismatch in a clone whose .pi/extensions links into a current one", async () => {
		const current = await provisioned(NEXT);
		const linked = adopter(NEXT);
		rmSync(join(linked, ".pi/extensions"), { recursive: true, force: true });
		symlinkSync(join(current, ".pi/extensions"), join(linked, ".pi/extensions"));
		assert.deepEqual(only(runTargetPi(current, ["/freshness"])).details, CURRENT);
		assert.deepEqual(only(runTargetPi(linked, ["/freshness"])).details, MISMATCH);
	});

	it("renders cannot-measure for an unreadable record, and its help as the command defines it", async (context) => {
		if (process.getuid?.() === 0) return context.skip("root reads a mode-000 file");
		const target = await provisioned(NEXT);
		chmodSync(join(target, INSTALLED_PIN_PATH), 0o000);
		const unknown = only(runTargetPi(target, ["/freshness"]));
		assert.deepEqual(unknown.details, { state: "cannot-measure", recovery: PROVISION_COMMAND });
		chmodSync(join(target, INSTALLED_PIN_PATH), 0o600);
		const help = only(runTargetPi(target, ["/freshness help"]));
		assert.equal(help.details, "help");
		assert.equal(help.content, FRESHNESS_HELP);
	});
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { composeAdopter } from "../.pi/extensions/gitjig/install/compose.ts";
import { LocalProvisionPlatform } from "../.pi/extensions/gitjig/install/local-provision.ts";
import { provisionAdopter } from "../.pi/extensions/gitjig/install/provision.ts";
import { buildFixture, readSessionEntries, removeFixture, repoRoot, runPi } from "./harness/run-pi.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const source = { provider: "github" as const, host: "github.com" as const, owner: "example", repository: "source" };
const script = [{ kind: "text" as const, text: "ADOPTER_SESSION_DONE" }];

function git(target: string, ...args: string[]): string {
	return execFileSync("git", ["-C", target, ...args], { encoding: "utf8" });
}
function put(target: string, path: string, bytes: Buffer): void {
	const dest = join(target, path);
	mkdirSync(dirname(dest), { recursive: true });
	writeFileSync(dest, bytes, { mode: path.startsWith(".githooks/") ? 0o755 : 0o600 });
}

/** A target with a committed handover and pin; the source is only a local simulated snapshot. */
async function setup() {
	const root = mkdtempSync(join(tmpdir(), "gitjig-adopter-runtime-"));
	roots.push(root);
	const snapshot = join(root, "source");
	const target = join(root, "adopter");
	mkdirSync(snapshot);
	mkdirSync(target);
	for (const namespace of [".pi", ".github", ".githooks", "changelog_unreleased"])
		cpSync(join(repoRoot(), namespace), join(snapshot, namespace), { recursive: true });
	const seed = composeAdopter({
		sourceRoot: snapshot,
		source,
		revision: "a".repeat(40),
		priorPinBytes: null,
		occupants: new Map(),
	});
	const handed = seed.candidates.filter((member) => member.disposition === "handed-over");
	const carried = seed.pin.manifest.filter((member) => member.class === "carried");
	assert.ok(handed.length > 0 && carried.length > 0);
	for (const candidate of handed) put(target, candidate.path, candidate.bytes);
	put(target, ".pi/gitjig.pin.json", seed.pinBytes);
	// Test-only provider is committed, not classified as a delivery member. Its script is local to the adopter.
	put(
		target,
		".pi/extensions/scripted-provider.ts",
		readFileSync(join(repoRoot(), "test/harness/scripted-provider.ts")),
	);
	writeFileSync(join(target, "script.json"), `${JSON.stringify(script)}\n`);
	git(target, "init", "-q");
	git(target, "add", ".");
	git(
		target,
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		"adopter handover",
	);
	const result = await provisionAdopter({
		snapshotRoot: snapshot,
		targetRoot: target,
		committedPinBytes: seed.pinBytes,
		installedPinBytes: null,
		platform: new LocalProvisionPlatform(target),
	});
	assert.equal(result.outcome, "verified", JSON.stringify(result));
	return { root, snapshot, target, seed, carried };
}

function registration(entries: Array<Record<string, unknown>>, target: string) {
	const found = entries.filter((entry) => entry.type === "custom" && entry.customType === "gitjig-registration");
	assert.equal(found.length, 1, `expected one real carried registration: ${JSON.stringify(found)}`);
	assert.equal(realpathSync((found[0].data as Record<string, string>).repoRoot), realpathSync(target));
}

function assertInstalledPin(target: string, expected: Buffer): void {
	assert.deepEqual(readFileSync(join(target, ".gitjig/installed-pin.json")), expected);
}

function checkCarried(target: string, snapshot: string, carried: { path: string }[]): void {
	const porcelain = git(target, "status", "--porcelain");
	const excludePath = git(target, "rev-parse", "--git-path", "info/exclude").trim();
	const exclude = readFileSync(resolve(target, excludePath), "utf8");
	for (const entry of carried) {
		assert.deepEqual(readFileSync(join(target, entry.path)), readFileSync(join(snapshot, entry.path)), entry.path);
		assert.ok(exclude.split("\n").includes(`/${entry.path}`), `missing exclude: ${entry.path}`);
		assert.equal(porcelain.includes(entry.path), false, `porcelain exposed ${entry.path}: ${porcelain}`);
	}
	assert.equal(porcelain, "", `unexpected untracked/modified target artifact: ${porcelain}`);
}

test("#354 provisioned adopter loads a carried COPY under Pi and keeps literal porcelain clean", async () => {
	const { target, snapshot, carried, seed } = await setup();
	const fixture = buildFixture({ script });
	try {
		// Session, state, agent config and home are siblings of target, not target children.
		const run = await runPi(fixture, { projectRoot: target, timeoutMs: 60_000 });
		assert.equal(run.timedOut, false);
		assert.equal(run.exitCode, 0, `pi ${run.piVersion}: ${run.stdout}\n${run.stderr}`);
		assert.match(run.stdout, /ADOPTER_SESSION_DONE/);
		registration(readSessionEntries(fixture), target);
		assertInstalledPin(target, seed.pinBytes);
		checkCarried(target, snapshot, carried);
		// A private-copy negative: absence of a carried member cannot satisfy the exact byte arm.
		const broken = join(dirname(target), "missing-carried");
		cpSync(target, broken, { recursive: true });
		rmSync(join(broken, ".pi/extensions/gitjig.ts"));
		assert.throws(() => checkCarried(broken, snapshot, carried));
		// A wrong installed pin independently reds the installed-pin identity arm.
		writeFileSync(join(broken, ".gitjig/installed-pin.json"), Buffer.from("wrong pin\n"));
		assert.throws(() => assertInstalledPin(broken, seed.pinBytes));
	} finally {
		removeFixture(fixture);
	}
});

test("#354 existing provisioned clone runs a handed-over local gate after simulated source loss", async () => {
	const { target, snapshot, seed } = await setup();
	const gate = join(target, ".github/workflows/check-ssot-home.sh");
	assert.ok(existsSync(gate));
	const before = readFileSync(join(target, ".gitjig/installed-pin.json"));
	rmSync(snapshot, { recursive: true, force: true });
	assert.equal(existsSync(snapshot), false);
	// A wholly target-local governed check, not bootstrap/acquisition or an attempted re-provision.
	const run = spawnSync("bash", [gate, "--root", target], {
		cwd: target,
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "", HOME: join(dirname(target), "isolated-home") },
		timeout: 30_000,
	});
	assert.equal(run.status, 0, run.stderr);
	assert.deepEqual(readFileSync(join(target, ".gitjig/installed-pin.json")), before);
	assert.deepEqual(before, seed.pinBytes);
	// Independent private-copy negative: removing the local governed act cannot pass the act arm.
	const broken = join(dirname(target), "missing-gate");
	cpSync(target, broken, { recursive: true });
	rmSync(join(broken, ".github/workflows/check-ssot-home.sh"));
	assert.notEqual(
		spawnSync("bash", [join(broken, ".github/workflows/check-ssot-home.sh"), "--root", broken], { encoding: "utf8" })
			.status,
		0,
	);
});

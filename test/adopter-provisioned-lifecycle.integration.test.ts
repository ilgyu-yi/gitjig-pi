import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { composeAdopter } from "../.pi/extensions/gitjig/install/compose.ts";
import {
	type DeliveryPlatform,
	type DraftPullRequestRequest,
	deliverAdopter,
} from "../.pi/extensions/gitjig/install/delivery.ts";
import { LocalProvisionPlatform } from "../.pi/extensions/gitjig/install/local-provision.ts";
import { parsePin } from "../.pi/extensions/gitjig/install/pin.ts";
import { provisionAdopter } from "../.pi/extensions/gitjig/install/provision.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));
const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
	}).trim();
}

function commit(root: string, message: string, allowEmpty = false): string {
	git(root, ["add", "-A"]);
	git(root, [
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		message,
		...(allowEmpty ? ["--allow-empty"] : []),
	]);
	return git(root, ["rev-parse", "HEAD"]);
}

function copySnapshot(target: string): void {
	mkdirSync(target);
	for (const namespace of [".pi", ".github", ".githooks", "changelog_unreleased"])
		cpSync(join(repository, namespace), join(target, namespace), { recursive: true });
	git(target, ["init", "-q", "-b", "main"]);
	commit(target, "immutable source snapshot");
}

function writeChange(target: string, change: DraftPullRequestRequest["changes"][number]): void {
	const path = join(target, change.path);
	if (change.operation === "delete") {
		rmSync(path, { force: true });
		return;
	}
	assert.ok(change.bytes !== undefined);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, change.bytes, { mode: change.path.startsWith(".githooks/") ? 0o755 : 0o600 });
	if (change.path.startsWith(".githooks/")) chmodSync(path, 0o755);
}

class CommittingDeliveryPlatform implements DeliveryPlatform {
	request: DraftPullRequestRequest | null = null;
	head = "";
	private readonly targetRoot: string;
	private readonly source: { provider: "github"; host: "github.com"; owner: string; repository: string };
	private readonly baseRevision: string;
	constructor(
		targetRoot: string,
		source: { provider: "github"; host: "github.com"; owner: string; repository: string },
		baseRevision: string,
	) {
		this.targetRoot = targetRoot;
		this.source = source;
		this.baseRevision = baseRevision;
	}
	async publishDraft(request: DraftPullRequestRequest) {
		this.request = request;
		git(this.targetRoot, ["switch", "-q", "-c", "adopt-evidence"]);
		for (const change of request.changes) writeChange(this.targetRoot, change);
		this.head = commit(this.targetRoot, "materialize delivery request");
		return {
			source: this.source,
			baseRef: "main",
			baseRevision: this.baseRevision,
			headRevision: this.head,
			number: 1,
			draft: true,
			title: request.title,
			body: request.body,
			changes: request.changes,
		};
	}
}

function carriedPaths(pinBytes: Buffer): string[] {
	return parsePin(pinBytes.toString("utf8"))
		.manifest.filter((entry) => entry.class === "carried")
		.map((entry) => entry.path);
}

function assertCarriedInvisible(target: string, carried: readonly string[]): void {
	const porcelain = git(target, ["status", "--porcelain=v1", "--untracked-files=all"]);
	for (const path of carried) {
		assert.equal(
			porcelain.split("\n").some((line) => line.slice(3).replace(/^"|"$/gu, "") === path),
			false,
			`carried path visible in porcelain: ${path}`,
		);
		const ignored = spawnSync("git", ["-C", target, "check-ignore", "-q", path], { encoding: "utf8" });
		assert.equal(ignored.status, 0, `carried path not ignored: ${path}`);
	}
}

function assertTargetRuntimeIsLocal(target: string): void {
	const extensionRoot = join(target, ".pi/extensions");
	const visit = (path: string): void => {
		const stat = lstatSync(path);
		assert.equal(stat.isSymbolicLink(), false, `runtime link survives: ${relative(target, path)}`);
		assert.ok(realpathSync(path).startsWith(`${realpathSync(target)}/`));
		if (stat.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry));
	};
	visit(extensionRoot);
}

function runTargetPi(root: string, target: string, phase: string): void {
	const agent = join(root, "pi-agent");
	const sessions = join(root, `sessions-${phase}`);
	const state = join(root, `pi-state-${phase}`);
	const home = join(root, "pi-home");
	for (const path of [join(agent, "extensions"), sessions, state, home]) mkdirSync(path, { recursive: true });
	cpSync(join(repository, "test/harness/scripted-provider.ts"), join(agent, "extensions/scripted-provider.ts"));
	writeFileSync(join(root, "script.json"), `${JSON.stringify([{ kind: "text", text: `TARGET_PI_${phase}` }])}\n`);
	const result = spawnSync(
		"pi",
		["-p", "run fixture", "-a", "--session-dir", sessions, "--provider", "scripted", "--model", "scripted-model"],
		{
			cwd: target,
			encoding: "utf8",
			timeout: 120_000,
			maxBuffer: 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				PATH: process.env.PATH,
				HOME: home,
				PI_CODING_AGENT_DIR: agent,
				PI_OFFLINE: "1",
				GITJIG_TEST_STATE_ROOT: state,
				GIT_CONFIG_NOSYSTEM: "1",
			},
		},
	);
	assert.equal(result.signal, null, result.stderr);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, new RegExp(`TARGET_PI_${phase}`));
	const audit = readFileSync(join(state, "audit.jsonl"), "utf8");
	assert.match(audit, /"action":"ext-load"/u);
	assert.ok(audit.includes(realpathSync(target)), "load record must name the target root");
	assertTargetRuntimeIsLocal(target);
}

function commitResult(target: string, message: string) {
	return spawnSync(
		"git",
		[
			"-C",
			target,
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-qm",
			message,
		],
		{ encoding: "utf8", env: { PATH: process.env.PATH, HOME: target, GIT_CONFIG_NOSYSTEM: "1" } },
	);
}

function tierTwoCommit(target: string, phase: string, first: boolean): void {
	if (first) {
		git(target, ["switch", "-q", "main"]);
		writeFileSync(join(target, "blocked.txt"), "blocked\n");
		git(target, ["add", "blocked.txt"]);
		const refused = commitResult(target, "must refuse on main");
		assert.notEqual(refused.status, 0, "protected main commit must be refused");
		git(target, ["reset", "--hard", "-q", "HEAD"]);
		git(target, ["switch", "-q", "-c", "evidence"]);
	}
	writeFileSync(join(target, `secret-${phase}.txt`), ["gh", "p_", "A".repeat(36)].join(""));
	git(target, ["add", `secret-${phase}.txt`]);
	const secretRefused = commitResult(target, `must refuse staged secret ${phase}`);
	assert.notEqual(secretRefused.status, 0, `staged-secret hook must run during ${phase}`);
	assert.match(secretRefused.stderr, /staged-secret scan refused/u);
	git(target, ["reset", "--hard", "-q", "HEAD"]);
	writeFileSync(join(target, `evidence-${phase}.txt`), `${phase}\n`);
	commit(target, `test: evidence ${phase}`);
}

async function tierThree(target: string, baseRevision: string): Promise<void> {
	const ssot = spawnSync("bash", [join(target, ".github/workflows/check-ssot-home.sh"), "--root", target], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.equal(ssot.status, 0, ssot.stderr);
	const module = (await import(
		`${pathToFileURL(join(target, ".github/workflows/history-shape.mjs")).href}?v=${Date.now()}`
	)) as {
		evaluateHistoryShape(input: { baseSha: string; headSha: string; cwd: string }): {
			pass: boolean;
			mergeCommits: string[];
		};
	};
	const result = module.evaluateHistoryShape({
		baseSha: baseRevision,
		headSha: git(target, ["rev-parse", "HEAD"]),
		cwd: target,
	});
	assert.deepEqual({ pass: result.pass, mergeCommits: result.mergeCommits }, { pass: true, mergeCommits: [] });
}

function verifyCarriedBytes(target: string, expected: ReadonlyMap<string, Buffer>): void {
	for (const [path, bytes] of expected) assert.deepEqual(readFileSync(join(target, path)), bytes, path);
}

it("#360 proves a provisioned adopter remains target-local after its source snapshot disappears", async () => {
	const root = mkdtempSync(join(tmpdir(), "gitjig-provisioned-adopter-"));
	roots.push(root);
	const sourceRoot = join(root, "source");
	const target = join(root, "target");
	const origin = join(root, "origin.git");
	copySnapshot(sourceRoot);
	mkdirSync(target);
	mkdirSync(origin);
	git(target, ["init", "-q", "-b", "main"]);
	git(origin, ["init", "-q", "--bare", "-b", "main"]);
	git(target, ["remote", "add", "origin", origin]);
	const initial = commit(target, "empty target", true);
	git(target, ["push", "-q", "-u", "origin", "main"]);
	git(target, ["remote", "set-head", "origin", "main"]);

	const source = { provider: "github" as const, host: "github.com" as const, owner: "example", repository: "source" };
	const targetSource = {
		provider: "github" as const,
		host: "github.com" as const,
		owner: "example",
		repository: "target",
	};
	const revision = git(sourceRoot, ["rev-parse", "HEAD"]);
	const observed = composeAdopter({ sourceRoot, source, revision, priorPinBytes: null, occupants: new Map() });
	const occupants = new Map(observed.pin.manifest.map((entry) => [entry.path, { kind: "absent" as const }]));
	occupants.set(".pi/gitjig.pin.json", { kind: "absent" });
	const composition = composeAdopter({ sourceRoot, source, revision, priorPinBytes: null, occupants });
	const platform = new CommittingDeliveryPlatform(target, targetSource, initial);
	const delivered = await deliverAdopter({
		composition,
		target: { source: targetSource, baseRef: "main", baseRevision: initial },
		title: "Adopt gitjig fixture",
		body: "Hermetic reviewed delivery.",
		egress: { prepare: (title, body) => ({ outcome: "prepared", title, body }) },
		platform,
	});
	assert.equal(delivered.outcome, "verified", JSON.stringify(delivered));
	assert.ok(platform.request !== null);
	assert.deepEqual(
		git(target, ["ls-tree", "-r", "--name-only", platform.head]).split("\n").filter(Boolean),
		platform.request.changes.map((change) => change.path).sort(),
	);
	assert.ok(!platform.request.changes.some((change) => carriedPaths(composition.pinBytes).includes(change.path)));
	git(target, ["branch", "-f", "main", platform.head]);
	git(target, ["switch", "-q", "main"]);
	git(target, ["push", "-q", "-f", "origin", "main"]);

	const provisioned = await provisionAdopter({
		snapshotRoot: sourceRoot,
		targetRoot: target,
		committedPinBytes: composition.pinBytes,
		installedPinBytes: null,
		platform: new LocalProvisionPlatform(target),
	});
	assert.equal(
		provisioned.outcome,
		"verified",
		`exclusion and carried-state provision must verify: ${JSON.stringify(provisioned)}`,
	);
	assert.deepEqual(readFileSync(join(target, ".gitjig/installed-pin.json")), composition.pinBytes);
	const carried = carriedPaths(composition.pinBytes);
	const expected = new Map(
		composition.candidates
			.filter((candidate) => candidate.disposition === "carried")
			.map((candidate) => [candidate.path, Buffer.from(candidate.bytes)] as const),
	);
	verifyCarriedBytes(target, expected);
	assertCarriedInvisible(target, carried);
	let completedPhases = 0;
	runTargetPi(root, target, "before");
	completedPhases += 1;
	tierTwoCommit(target, "before", true);
	await tierThree(target, platform.head);

	rmSync(sourceRoot, { recursive: true });
	assert.equal(existsSync(sourceRoot), false, "source snapshot must be absent before the second phase");
	runTargetPi(root, target, "after");
	completedPhases += 1;
	verifyCarriedBytes(target, expected);
	assertCarriedInvisible(target, carried);
	tierTwoCommit(target, "after", false);
	await tierThree(target, platform.head);
	assert.equal(completedPhases, 2, "both pre- and post-source-removal phases must execute");
});

if (process.env.GITJIG_MUTANT_CHILD !== "1") {
	it("#360's four independent private-copy mutants each make the owning evidence arm red", () => {
		const testRelative = "test/adopter-provisioned-lifecycle.integration.test.ts";
		const mutations = [
			{
				name: "source dependence",
				path: testRelative,
				needle: "\trmSync(sourceRoot, { recursive: true });",
				replacement: "\tvoid sourceRoot; // mutant: retain the source snapshot",
				diagnostic: /source snapshot must be absent/u,
			},
			{
				name: "exclusion omission",
				path: ".pi/extensions/gitjig/install/local-provision.ts",
				needle: "\t\t\tconst afterExclude = this.appendExclusions(absoluteExclude, request.exclude);",
				replacement:
					'\t\t\tconst afterExclude = new Set(readFileSync(absoluteExclude, "utf8").split(/\\r?\\n/u)); // mutant: omit exclusions',
				diagnostic: /exclusion and carried-state provision must verify/u,
			},
			{
				name: "source-loaded Pi",
				path: testRelative,
				needle: "\t\t\tcwd: target,",
				replacement: '\t\t\tcwd: join(root, "source"), // mutant: load Pi from the source fixture',
				diagnostic: /load record must name the target root/u,
			},
			{
				name: "second-phase omission",
				path: testRelative,
				needle: '\trunTargetPi(root, target, "after");\n\tcompletedPhases += 1;',
				replacement: "\t// mutant: omit the post-source-removal Pi phase",
				diagnostic: /both pre- and post-source-removal phases must execute/u,
			},
		] as const;
		for (const mutation of mutations) {
			const copy = join(tmpdir(), `gitjig-360-mutant-${randomUUID()}`);
			roots.push(copy);
			mkdirSync(join(copy, "test/harness"), { recursive: true });
			for (const namespace of [".pi", ".github", ".githooks", "changelog_unreleased"])
				cpSync(join(repository, namespace), join(copy, namespace), { recursive: true });
			cpSync(join(repository, testRelative), join(copy, testRelative));
			cpSync(join(repository, "test/harness/scripted-provider.ts"), join(copy, "test/harness/scripted-provider.ts"));
			const mutatePath = join(copy, mutation.path);
			const original = readFileSync(mutatePath, "utf8");
			assert.equal(original.split(mutation.needle).length, 2, `${mutation.name}: mutation site must be unique`);
			writeFileSync(mutatePath, original.replace(mutation.needle, mutation.replacement));
			const childEnv: NodeJS.ProcessEnv = { ...process.env, GITJIG_MUTANT_CHILD: "1" };
			delete childEnv.NODE_TEST_CONTEXT;
			const child = spawnSync(process.execPath, ["--test", join(copy, testRelative)], {
				cwd: copy,
				encoding: "utf8",
				timeout: 180_000,
				maxBuffer: 2 * 1024 * 1024,
				env: childEnv,
			});
			const output = `${child.stdout}\n${child.stderr}`;
			assert.notEqual(child.status, 0, `${mutation.name} survived its private-copy run:\n${output}`);
			assert.match(output, mutation.diagnostic, `${mutation.name} failed outside its owning evidence arm`);
		}
	});
}

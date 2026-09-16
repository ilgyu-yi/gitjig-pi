import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, it } from "node:test";
import { fileURLToPath } from "node:url";
import { composeAdopter } from "../.pi/extensions/gitjig/install/compose.ts";
import { LocalProvisionPlatform } from "../.pi/extensions/gitjig/install/local-provision.ts";
import { provisionAdopter } from "../.pi/extensions/gitjig/install/provision.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));
const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

it("#130 provisions a real clone locally, excludes carried state, binds hooks, and advances installed pin last", async () => {
	const root = mkdtempSync(join(tmpdir(), "gitjig-local-provision-"));
	roots.push(root);
	const snapshot = join(root, "snapshot");
	const target = join(root, "target");
	mkdirSync(snapshot);
	mkdirSync(target);
	for (const namespace of [".pi", ".github", ".githooks", "changelog_unreleased"])
		cpSync(join(repository, namespace), join(snapshot, namespace), { recursive: true });
	const source = { provider: "github" as const, host: "github.com" as const, owner: "example", repository: "source" };
	const seed = composeAdopter({
		sourceRoot: snapshot,
		source,
		revision: "a".repeat(40),
		priorPinBytes: null,
		occupants: new Map(),
	});
	for (const candidate of seed.candidates) {
		if (candidate.disposition !== "handed-over") continue;
		mkdirSync(join(target, candidate.path, ".."), { recursive: true });
		writeFileSync(join(target, candidate.path), candidate.bytes, {
			mode: candidate.path.startsWith(".githooks/") ? 0o755 : 0o600,
		});
	}
	mkdirSync(join(target, ".pi"), { recursive: true });
	writeFileSync(join(target, ".pi/gitjig.pin.json"), seed.pinBytes);
	execFileSync("git", ["init", "-q", target]);
	const result = await provisionAdopter({
		snapshotRoot: snapshot,
		targetRoot: target,
		committedPinBytes: seed.pinBytes,
		installedPinBytes: null,
		platform: new LocalProvisionPlatform(target),
	});
	assert.equal(result.outcome, "verified", JSON.stringify(result));
	for (const entry of seed.pin.manifest.filter((member) => member.class === "carried")) {
		assert.deepEqual(readFileSync(join(target, entry.path)), readFileSync(join(snapshot, entry.path)));
		assert.equal(execFileSync("git", ["-C", target, "check-ignore", "-q", entry.path]).length, 0);
	}
	assert.equal(
		execFileSync("git", ["-C", target, "config", "--local", "--get", "core.hooksPath"], { encoding: "utf8" }).trim(),
		".githooks",
	);
	assert.deepEqual(readFileSync(join(target, ".gitjig/installed-pin.json")), seed.pinBytes);
	assert.match(readFileSync(join(target, ".gitjig/audit.jsonl"), "utf8"), /"action":"verified"/u);
	const rerun = await provisionAdopter({
		snapshotRoot: snapshot,
		targetRoot: target,
		committedPinBytes: seed.pinBytes,
		installedPinBytes: readFileSync(join(target, ".gitjig/installed-pin.json")),
		platform: new LocalProvisionPlatform(target),
	});
	assert.equal(rerun.outcome, "converged", JSON.stringify(rerun));
	const exclude = readFileSync(
		resolve(
			target,
			execFileSync("git", ["-C", target, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" }).trim(),
		),
		"utf8",
	);
	for (const entry of seed.pin.manifest.filter((member) => member.class === "carried"))
		assert.equal(exclude.split(`/${entry.path}`).length, 2, `duplicate exclusion for ${entry.path}`);

	writeFileSync(join(snapshot, ".pi/extensions/gitjig.ts"), "// updated carried entry\n");
	writeFileSync(join(snapshot, ".pi/prompts/new.md"), "new carried prompt\n");
	rmSync(join(snapshot, ".pi/prompts/work-on.md"));
	const next = composeAdopter({
		sourceRoot: snapshot,
		source,
		revision: "b".repeat(40),
		priorPinBytes: seed.pinBytes,
		occupants: new Map(),
	});
	writeFileSync(join(target, ".pi/gitjig.pin.json"), next.pinBytes);
	const update = await provisionAdopter({
		snapshotRoot: snapshot,
		targetRoot: target,
		committedPinBytes: next.pinBytes,
		installedPinBytes: seed.pinBytes,
		platform: new LocalProvisionPlatform(target),
	});
	assert.equal(update.outcome, "verified", JSON.stringify(update));
	assert.equal(readFileSync(join(target, ".pi/extensions/gitjig.ts"), "utf8"), "// updated carried entry\n");
	assert.equal(readFileSync(join(target, ".pi/prompts/new.md"), "utf8"), "new carried prompt\n");
	assert.equal(existsSync(join(target, ".pi/prompts/work-on.md")), false);
	assert.deepEqual(readFileSync(join(target, ".gitjig/installed-pin.json")), next.pinBytes);
});

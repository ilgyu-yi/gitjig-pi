import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

it("#130 carried bootstrap verifies exact Git source and revision before invoking provision", () => {
	const root = mkdtempSync(join(tmpdir(), "gitjig-bootstrap-"));
	roots.push(root);
	const snapshot = join(root, "snapshot");
	const target = join(root, "target");
	mkdirSync(join(snapshot, ".pi/extensions/gitjig/install"), { recursive: true });
	mkdirSync(target);
	cpSync(
		join(repository, ".pi/extensions/gitjig/install/bootstrap.ts"),
		join(snapshot, ".pi/extensions/gitjig/install/bootstrap.ts"),
	);
	const log = join(root, "provision.log");
	writeFileSync(
		join(snapshot, ".pi/extensions/gitjig/install/provision-cli.ts"),
		`import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`,
	);
	execFileSync("git", ["init", "-q", snapshot]);
	execFileSync("git", ["-C", snapshot, "remote", "add", "origin", "https://github.com/example/source"]);
	execFileSync("git", ["-C", snapshot, "add", "."]);
	execFileSync("git", [
		"-C",
		snapshot,
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		"fixture",
	]);
	execFileSync("git", ["init", "-q", target]);
	const revision = execFileSync("git", ["-C", snapshot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const script = join(snapshot, ".pi/extensions/gitjig/install/bootstrap.ts");
	const run = (source: string, rev: string) =>
		spawnSync(process.execPath, ["--experimental-strip-types", script, source, rev, target, snapshot], {
			encoding: "utf8",
		});
	const success = run("https://github.com/example/source", revision);
	assert.equal(success.status, 0, success.stderr);
	const invoked = JSON.parse(readFileSync(log, "utf8")) as string[];
	assert.deepEqual(invoked, [
		"--target",
		realpathSync(target),
		"--source",
		"https://github.com/example/source",
		"--revision",
		revision,
	]);
	rmSync(log, { force: true });
	assert.notEqual(run("https://github.com/example/source", "0".repeat(40)).status, 0);
	assert.notEqual(run("https://github.com/other/source", revision).status, 0);
	assert.equal(readFileSync(join(snapshot, ".git/config"), "utf8").includes("example/source"), true);
});

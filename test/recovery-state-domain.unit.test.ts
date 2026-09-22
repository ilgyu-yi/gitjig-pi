import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const roots: string[] = [];
after(() => {
	for (const entry of roots) rmSync(entry, { recursive: true, force: true });
});

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "gitjig-recovery-domain-"));
	roots.push(value);
	return value;
}

function resolveWith(env: NodeJS.ProcessEnv): { status: number | null; stdout: string } {
	const moduleUrl = new URL("../.pi/extensions/gitjig/recovery/state-domain.ts", import.meta.url).href;
	const child = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import {resolveRecoveryStateDomain as r} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(r() ?? null));`,
		],
		{ encoding: "utf8", env: { PATH: process.env.PATH, ...env } },
	);
	return { status: child.status, stdout: child.stdout.trim() };
}

describe("production recovery state-domain resolver", () => {
	it("uses the exact XDG chain with owner-only runtime components", () => {
		const xdg = root();
		const result = resolveWith({ XDG_STATE_HOME: xdg, HOME: root() });
		assert.equal(result.status, 0);
		assert.equal(JSON.parse(result.stdout), join(xdg, "gitjig", "recovery"));
		assert.equal(statSync(join(xdg, "gitjig")).mode & 0o777, 0o700);
		assert.equal(statSync(join(xdg, "gitjig", "recovery")).mode & 0o777, 0o700);
	});

	it("uses HOME only when XDG is absent and never falls back from invalid XDG", () => {
		const home = root();
		assert.equal(JSON.parse(resolveWith({ HOME: home }).stdout), join(home, ".local", "state", "gitjig", "recovery"));
		assert.equal(JSON.parse(resolveWith({ XDG_STATE_HOME: "relative", HOME: home }).stdout), null);
	});

	it("rejects the production test-root variable even when empty", () => {
		assert.equal(JSON.parse(resolveWith({ XDG_STATE_HOME: root(), GITJIG_TEST_STATE_ROOT: "" }).stdout), null);
	});

	it("rejects ordinary and bare repository ancestors before creating runtime directories", () => {
		const ordinary = root();
		mkdirSync(join(ordinary, ".git"));
		assert.equal(JSON.parse(resolveWith({ XDG_STATE_HOME: ordinary }).stdout), null);
		const bare = root();
		writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
		mkdirSync(join(bare, "objects"));
		mkdirSync(join(bare, "refs"));
		assert.equal(JSON.parse(resolveWith({ XDG_STATE_HOME: bare }).stdout), null);
	});

	it("rejects loose XDG mode and linked chain components", () => {
		const loose = root();
		// root() is 0700; widening makes the XDG root invalid.
		chmodSync(loose, 0o755);
		assert.equal(JSON.parse(resolveWith({ XDG_STATE_HOME: loose }).stdout), null);
	});
});

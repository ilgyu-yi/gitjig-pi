import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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

	it("does not infer HOME policy from gitjig/recovery path spellings", () => {
		for (const name of ["gitjig", "recovery"]) {
			const parent = root();
			const home = join(parent, name);
			mkdirSync(home, { mode: 0o755 });
			assert.equal(JSON.parse(resolveWith({ HOME: home }).stdout), join(home, ".local", "state", "gitjig", "recovery"));
		}
	});

	it("kills omission of every created component's parent-directory fsync", () => {
		for (const variant of ["baseline", "mutant"] as const) {
			const box = root();
			cpSync(new URL("../.pi/extensions/gitjig/recovery", import.meta.url), join(box, "recovery"), { recursive: true });
			const shim = join(box, "fs-shim.mjs");
			writeFileSync(
				shim,
				`import * as fs from "node:fs";\nexport const {closeSync,constants,fstatSync,lstatSync,mkdirSync,openSync}=fs;\nexport function fsyncSync(fd){fs.appendFileSync(process.env.FSYNC_LOG,"d");return fs.fsyncSync(fd);}\n`,
			);
			const target = join(box, "recovery", "state-domain.ts");
			let source = readFileSync(target, "utf8").replace('"node:fs"', JSON.stringify(new URL(`file://${shim}`).href));
			if (variant === "mutant") source = source.replace("\t\t\t\tfsyncSync(parent.fd);", "");
			writeFileSync(target, source);
			const xdg = join(box, "xdg");
			mkdirSync(xdg, { mode: 0o700 });
			const log = join(box, "fsync.log");
			writeFileSync(log, "");
			const result = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`import {readFileSync} from "node:fs"; import {resolveRecoveryStateDomain as r} from ${JSON.stringify(new URL(`file://${target}`).href)}; if(!r() || readFileSync(process.env.FSYNC_LOG,"utf8")!=="dd") process.exit(2);`,
				],
				{ encoding: "utf8", env: { PATH: process.env.PATH, XDG_STATE_HOME: xdg, FSYNC_LOG: log } },
			);
			if (variant === "baseline") {
				assert.equal(result.status, 0, result.stderr);
				assert.equal(readFileSync(log, "utf8"), "dd");
			} else assert.notEqual(result.status, 0, "component parent-fsync mutant survived");
		}
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
		const linked = root();
		const target = root();
		symlinkSync(target, join(linked, "gitjig"));
		assert.equal(JSON.parse(resolveWith({ XDG_STATE_HOME: linked }).stdout), null);
	});
});

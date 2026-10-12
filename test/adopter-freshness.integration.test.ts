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
import { buildPin, encodePin, GENERATED_PIN_PATH, parsePin } from "../.pi/extensions/gitjig/install/pin.ts";
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
/** A carried file only this snapshot lists, added to the next one. */
const ADDED_PATH = ".pi/prompts/added-locally.md";
const addedRoot = join(base, "added");
cpSync(nextRoot, addedRoot, { recursive: true });
rmSync(join(addedRoot, ".git"), { recursive: true, force: true });
writeFileSync(join(addedRoot, ADDED_PATH), "Added.\n");
const ADDED = snapshot(addedRoot);
/** The old snapshot less one handed-over file. */
const RETIRED_PATH = [...OLD.handed.keys()].find((path) => path.startsWith(".github/workflows/")) as string;
const retiredRoot = join(base, "retired");
cpSync(oldRoot, retiredRoot, { recursive: true });
rmSync(join(retiredRoot, ".git"), { recursive: true, force: true });
rmSync(join(retiredRoot, RETIRED_PATH));
const RETIRED = snapshot(retiredRoot);

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

/** Each converge or refuse clause /freshness help states, and a description of the arm or arms here that pin it against the real provision run; the check below reads only the clause, never the arm. */
const HELP_CLAUSES: Readonly<Record<string, string>> = {
	"exactly its committed bytes, and a handed-over file only the old pin lists is absent;":
		"refuses a missing handed-over file and one only the old pin lists; refuses a handed-over file that differs",
	"every carried file both pins list is exactly the old or the new":
		"converges a behind record over exact-old bytes, and over exact-new bytes; refuses an edited, missing or linked carried file",
	"It also refuses a record it cannot read, a directory included, and a carried file it cannot read; it reads a":
		"refuses an unreadable or directory record through the real provision CLI, and an unreadable carried file",
	"It refuses as well when .gitjig, or any directory on a carried path (.pi/extensions, .pi/prompts or one":
		"refuses a linked state root or carried container; a real directory converges",
	"below them), is a link, and when a directory on a handed-over path (.githooks, changelog_unreleased, or one":
		"refuses a linked handed-over directory; a real directory converges",
	"does not diagnose them. invalid-input includes checkouts the launcher never provisions: a linked .pi,":
		"the real launcher stops a linked .pi, .github or .github/bin with invalid-input before provision",
	".github or .github/bin, a linked worktree (its .git a file), and a clone sharing another's objects.":
		"the real launcher refuses a linked worktree, and a clone sharing another's objects, with invalid-input",
	"make an unreadable record or carried file readable, or else remove the record and the unreadable file and":
		"removing only the record leaves an unreadable carried file or a behind unreadable record refusing",
	"linked record through its link, and a dangling one as absent.":
		"refuses an unreadable or directory record through the real provision CLI ... a linked or dangling record converges",
	"one only the new pin lists is absent or exactly the new bytes": "converges a carried file only one pin lists",
	"exactly the old bytes or absent;": "converges a carried file only one pin lists",
	"- under an absent record, every carried file the new pin lists is absent or exactly the new bytes.":
		"converges an absent record over absent or exact-next bytes; refuses ... under an absent record",
	"It refuses (provision-refused) otherwise, on a malformed record, and on a changed source or class transition.":
		"refuses a malformed record; refuses a record naming another source, or another class for a path",
	"A carried file neither pin lists is left alone, so it keeps reporting until removed.":
		"leaves a carried file neither pin lists alone",
	"Removing an edited carried file both pins list, alone, still refuses.":
		"removing an edited both-listed carried file alone still refuses",
};

describe("#365 the recovery, shape by shape, against the real provision run", () => {
	it("is what /freshness help states, clause by clause", () => {
		for (const [clause, arm] of Object.entries(HELP_CLAUSES))
			assert.ok(FRESHNESS_HELP.includes(clause), `help no longer states the clause pinned by: ${arm}`);
	});

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
		writeFileSync(join(target, handed), "handed-over edit\n");
		assert.equal(await provision(target, NEXT), "refused");
		git(target, ["checkout", "--", handed]);
		write(target, PROMPT, NEXT.carried.get(PROMPT) as Buffer);
		assert.notEqual(await provision(target, NEXT), "refused");
		assert.deepEqual(freshness(target), CURRENT);
	});

	it("refuses a missing handed-over file and one only the old pin lists; restoring or removing it converges", async () => {
		const missing = await provisioned(NEXT);
		const handed = [...NEXT.handed.keys()][0] as string;
		rmSync(join(missing, handed));
		assert.equal(await provision(missing, NEXT), "refused");
		git(missing, ["checkout", "--", handed]);
		assert.notEqual(await provision(missing, NEXT), "refused");

		const stale = await provisioned(OLD);
		commitPin(stale, RETIRED);
		assert.equal(await provision(stale, RETIRED), "refused");
		rmSync(join(stale, RETIRED_PATH));
		assert.notEqual(await provision(stale, RETIRED), "refused");
		assert.deepEqual(freshness(stale), CURRENT);
	});

	it("refuses a renamed, foreign or non-regular carried file under a present record", async () => {
		const other = [...NEXT.carried.keys()].find((path) => path !== PROMPT) as string;
		for (const damage of ["renamed", "foreign", "fifo"] as const) {
			const target = await provisioned(NEXT);
			const path = join(target, PROMPT);
			if (damage === "renamed") cpSync(path, `${path}.renamed`);
			rmSync(path);
			if (damage === "foreign") writeFileSync(path, NEXT.carried.get(other) as Buffer);
			if (damage === "fifo") execFileSync("mkfifo", [path]);
			assert.deepEqual(freshness(target), MISMATCH, damage);
			assert.equal(await provision(target, NEXT), "refused", damage);
			rmSync(path, { force: true });
			rmSync(`${path}.renamed`, { force: true });
			write(target, PROMPT, NEXT.carried.get(PROMPT) as Buffer);
			assert.notEqual(await provision(target, NEXT), "refused", damage);
			assert.deepEqual(freshness(target), CURRENT, damage);
		}
	});

	it("refuses an edited, foreign, linked or non-regular carried file under an absent record; the absent-record step converges", async () => {
		const other = [...NEXT.carried.keys()].find((path) => path !== PROMPT) as string;
		for (const damage of ["edited", "foreign", "linked", "fifo"] as const) {
			const target = await provisioned(NEXT);
			rmSync(join(target, INSTALLED_PIN_PATH));
			const path = join(target, PROMPT);
			rmSync(path);
			if (damage === "edited") writeFileSync(path, "edited\n");
			if (damage === "foreign") writeFileSync(path, NEXT.carried.get(other) as Buffer);
			if (damage === "linked") symlinkSync(join(NEXT.root, PROMPT), path);
			if (damage === "fifo") execFileSync("mkfifo", [path]);
			assert.equal(await provision(target, NEXT), "refused", damage);
			rmSync(path, { force: true });
			assert.notEqual(await provision(target, NEXT), "refused", damage);
			assert.deepEqual(freshness(target), CURRENT, damage);
		}
	});

	it("refuses a record naming another source, or another class for a path; the fallback converges", async () => {
		const otherSource = { ...source, owner: "elsewhere" };
		const changed = Buffer.from(encodePin({ ...parsePin(NEXT.pin.toString()), source: otherSource }));
		const inputs = [...NEXT.carried, ...NEXT.handed].map(([path, bytes]) => ({
			path,
			class: path === PROMPT || NEXT.handed.has(path) ? ("handed-over" as const) : ("carried" as const),
			bytes,
		}));
		const transition = Buffer.from(encodePin(buildPin(source, parsePin(NEXT.pin.toString()).revision, inputs)));
		for (const [label, record] of [
			["changed source", changed],
			["class transition", transition],
		] as const) {
			const target = await provisioned(NEXT);
			writeFileSync(join(target, INSTALLED_PIN_PATH), record);
			assert.deepEqual(freshness(target), MISMATCH, label);
			assert.equal(await provision(target, NEXT), "refused", label);
			fallback(target, NEXT);
			assert.notEqual(await provision(target, NEXT), "refused", label);
			assert.deepEqual(freshness(target), CURRENT, label);
		}
	});

	it("converges a carried file only one pin lists when absent or exact, and refuses it edited, under a present record", async () => {
		for (const held of ["absent", "exact", "edited"] as const) {
			const upgrade = await provisioned(NEXT);
			commitPin(upgrade, ADDED);
			if (held !== "absent") write(upgrade, ADDED_PATH, Buffer.from(held === "exact" ? "Added.\n" : "edited\n"));
			assert.equal((await provision(upgrade, ADDED)) === "refused", held === "edited", `new-only ${held}`);

			const retire = await provisioned(ADDED);
			commitPin(retire, NEXT);
			if (held === "absent") rmSync(join(retire, ADDED_PATH));
			if (held === "edited") writeFileSync(join(retire, ADDED_PATH), "edited\n");
			assert.equal((await provision(retire, NEXT)) === "refused", held === "edited", `old-only ${held}`);
		}
	});

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

	it("converges a behind record over carried files already holding the new bytes", async () => {
		const target = await provisioned(OLD);
		commitPin(target, NEXT);
		write(target, PROMPT, NEXT.carried.get(PROMPT) as Buffer);
		assert.deepEqual(freshness(target), MISMATCH);
		assert.notEqual(await provision(target, NEXT), "refused");
		assert.deepEqual(freshness(target), CURRENT);
	});

	it("refuses an unreadable or directory record through the real provision CLI, and an unreadable carried file", async (context) => {
		if (process.getuid?.() === 0) return context.skip("root reads a mode-000 file");
		const cli = (target: string) =>
			spawnSync(
				process.execPath,
				[
					join(NEXT.root, ".pi/extensions/gitjig/install/provision-cli.ts"),
					"--target",
					target,
					"--source",
					"https://github.com/example/source",
					"--revision",
					parsePin(NEXT.pin.toString()).revision,
				],
				{ encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: "C" } },
			).status;
		const unreadable = await provisioned(NEXT);
		chmodSync(join(unreadable, INSTALLED_PIN_PATH), 0o000);
		assert.deepEqual(freshness(unreadable), { state: "cannot-measure", recovery: PROVISION_COMMAND });
		assert.equal(cli(unreadable), 2, "an unreadable record refuses");
		chmodSync(join(unreadable, INSTALLED_PIN_PATH), 0o600);
		assert.equal(cli(unreadable), 0, "a readable record converges");

		const directory = await provisioned(NEXT);
		rmSync(join(directory, INSTALLED_PIN_PATH));
		mkdirSync(join(directory, INSTALLED_PIN_PATH));
		assert.deepEqual(freshness(directory), MISMATCH);
		assert.equal(cli(directory), 2, "a record that is not a regular file refuses");
		rmSync(join(directory, INSTALLED_PIN_PATH), { recursive: true });
		fallback(directory, NEXT);
		assert.equal(cli(directory), 0, "removing it, then the absent-record step, converges");

		// A linked record is read through its link, and a dangling one as absent: both converge.
		const linked = await provisioned(NEXT);
		const elsewhere = join(scratch("record"), "installed-pin.json");
		writeFileSync(elsewhere, readFileSync(join(linked, INSTALLED_PIN_PATH)));
		rmSync(join(linked, INSTALLED_PIN_PATH));
		symlinkSync(elsewhere, join(linked, INSTALLED_PIN_PATH));
		assert.deepEqual(freshness(linked), MISMATCH);
		assert.equal(cli(linked), 0, "a linked record converges");
		assert.deepEqual(freshness(linked), CURRENT);
		const dangling = await provisioned(NEXT);
		rmSync(join(dangling, INSTALLED_PIN_PATH));
		symlinkSync(join(scratch("record"), "missing.json"), join(dangling, INSTALLED_PIN_PATH));
		assert.deepEqual(freshness(dangling), MISMATCH);
		assert.equal(cli(dangling), 0, "a dangling record reads as absent and converges");
		assert.deepEqual(freshness(dangling), CURRENT);

		const carried = await provisioned(NEXT);
		chmodSync(join(carried, PROMPT), 0o000);
		assert.deepEqual(freshness(carried), { state: "cannot-measure", recovery: PROVISION_COMMAND });
		assert.equal(await provision(carried, NEXT), "refused");
		chmodSync(join(carried, PROMPT), 0o600);
		assert.notEqual(await provision(carried, NEXT), "refused");
		assert.deepEqual(freshness(carried), CURRENT);
	});

	it("removing only the record leaves an unreadable carried file or a behind unreadable record refusing", async (context) => {
		if (process.getuid?.() === 0) return context.skip("root reads a mode-000 file");
		const carried = await provisioned(NEXT);
		chmodSync(join(carried, PROMPT), 0o000);
		rmSync(join(carried, INSTALLED_PIN_PATH));
		assert.equal(await provision(carried, NEXT), "refused", "the record alone");
		rmSync(join(carried, PROMPT));
		fallback(carried, NEXT);
		assert.notEqual(await provision(carried, NEXT), "refused", "the unreadable file too, then the absent-record step");
		assert.deepEqual(freshness(carried), CURRENT);

		const behind = await provisioned(OLD);
		commitPin(behind, NEXT);
		chmodSync(join(behind, INSTALLED_PIN_PATH), 0o000);
		assert.equal(await provision(behind, NEXT), "refused", "an unreadable record");
		rmSync(join(behind, INSTALLED_PIN_PATH));
		assert.equal(await provision(behind, NEXT), "refused", "the behind record alone, over older bytes");
		fallback(behind, NEXT);
		assert.notEqual(await provision(behind, NEXT), "refused", "the absent-record step");
		assert.deepEqual(freshness(behind), CURRENT);
	});

	it("refuses a linked state root or carried container; a real directory converges", async () => {
		// A linked .pi also hides the committed pin, which is then not read at all.
		const UNMEASURED = { state: "cannot-measure", recovery: PROVISION_COMMAND };
		for (const [container, reads] of [
			[".gitjig", MISMATCH],
			[".pi", UNMEASURED],
			[".pi/extensions", MISMATCH],
			[".pi/prompts", MISMATCH],
			[".pi/extensions/gitjig/install", MISMATCH],
		] as const) {
			const target = await provisioned(NEXT);
			const away = join(scratch("container"), "held");
			cpSync(join(target, container), away, { recursive: true });
			rmSync(join(target, container), { recursive: true });
			symlinkSync(away, join(target, container));
			assert.deepEqual(freshness(target), reads, container);
			assert.equal(await provision(target, NEXT), "refused", container);
			rmSync(join(target, container));
			cpSync(away, join(target, container), { recursive: true });
			assert.notEqual(await provision(target, NEXT), "refused", container);
			assert.deepEqual(freshness(target), CURRENT, container);
		}
	});

	it("refuses a linked handed-over directory; a real directory converges", async () => {
		for (const container of [".githooks", "changelog_unreleased", ".github/workflows"]) {
			const target = await provisioned(NEXT);
			const away = join(scratch("handed"), "held");
			cpSync(join(target, container), away, { recursive: true });
			rmSync(join(target, container), { recursive: true });
			symlinkSync(away, join(target, container));
			assert.equal(await provision(target, NEXT), "refused", container);
			rmSync(join(target, container));
			cpSync(away, join(target, container), { recursive: true });
			assert.notEqual(await provision(target, NEXT), "refused", container);
		}
	});

	it("the real launcher stops a linked .pi, .github or .github/bin with invalid-input before provision", async () => {
		for (const container of [".pi", ".github", ".github/bin"]) {
			const target = await provisioned(NEXT);
			const away = join(scratch("linked"), "held");
			cpSync(join(target, container), away, { recursive: true });
			rmSync(join(target, container), { recursive: true });
			symlinkSync(away, join(target, container));
			const run = spawnSync(process.execPath, [join(target, ".github/bin/gitjig-bootstrap.mjs")], {
				encoding: "utf8",
				env: { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: "C" },
			});
			assert.equal(run.status, 64, `${container}: ${run.stderr}`);
			assert.equal(run.stderr, "gitjig-bootstrap: invalid-input\n", container);
		}
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

	it("the real launcher refuses a clone sharing another's objects with invalid-input", async () => {
		const main = await provisioned(NEXT);
		const shared = join(scratch("shared"), "clone");
		execFileSync("git", ["clone", "-q", "--shared", main, shared], { env: { PATH: process.env.PATH, HOME: shared } });
		const run = spawnSync(process.execPath, [join(shared, ".github/bin/gitjig-bootstrap.mjs")], {
			encoding: "utf8",
			env: { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: "C" },
		});
		assert.equal(run.status, 64, run.stderr);
		assert.equal(run.stderr, "gitjig-bootstrap: invalid-input\n");
	});

	it("the real launcher refuses a linked worktree with invalid-input", async () => {
		const main = await provisioned(NEXT);
		const worktree = join(scratch("worktree"), "tree");
		git(main, ["worktree", "add", "-q", "--detach", worktree]);
		assert.deepEqual(freshness(worktree), MISMATCH, "a worktree holds no record of its own");
		const run = spawnSync(process.execPath, [join(worktree, ".github/bin/gitjig-bootstrap.mjs")], {
			encoding: "utf8",
			env: { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: "C" },
		});
		assert.equal(run.status, 64, run.stderr);
		assert.equal(run.stderr, "gitjig-bootstrap: invalid-input\n");
	});

	it("renders placement-mismatch in a clone whose .pi/extensions links into a current one", async () => {
		const current = await provisioned(NEXT);
		const linked = adopter(NEXT);
		rmSync(join(linked, ".pi/extensions"), { recursive: true, force: true });
		symlinkSync(join(current, ".pi/extensions"), join(linked, ".pi/extensions"));
		assert.deepEqual(only(runTargetPi(current, ["/freshness"])).details, CURRENT);
		assert.deepEqual(only(runTargetPi(linked, ["/freshness"])).details, MISMATCH);
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

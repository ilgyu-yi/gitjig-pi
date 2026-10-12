import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import {
	FRESHNESS_HELP,
	FRESHNESS_MESSAGE,
	freshnessLine,
	registerFreshnessCommand,
} from "../.pi/extensions/gitjig/commands/freshness.ts";
import { type CarriedObservation, observeCarried } from "../.pi/extensions/gitjig/install/classifier.ts";
import {
	captureCarriedProjection,
	evaluateFreshness,
	type FreshnessInputs,
	INSTALLED_PIN_PATH,
	measureFreshness,
	type PinRead,
	PROVISION_COMMAND,
	RELOAD_COMMAND,
	readCommittedPin,
	readPinFile,
	sessionClone,
} from "../.pi/extensions/gitjig/install/freshness.ts";
import { buildPin, encodePin, GENERATED_PIN_PATH } from "../.pi/extensions/gitjig/install/pin.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) {
		chmodTree(root);
		rmSync(root, { recursive: true, force: true });
	}
});
function chmodTree(path: string): void {
	try {
		if (lstatSync(path).isSymbolicLink()) return;
		chmodSync(path, 0o700);
		if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) chmodTree(join(path, name));
	} catch {}
}

const source = { provider: "github" as const, host: "github.com" as const, owner: "o", repository: "r" };
const CARRIED = {
	".pi/extensions/gitjig.ts": "export default () => {};\n",
	".pi/extensions/gitjig/a.ts": "export const a = 1;\n",
	".pi/prompts/p.md": "prompt\n",
};
const HANDED = { ".github/workflows/x.yml": "on: push\n" };
function pinFor(carried: Record<string, string>, revision = "a".repeat(40)): Buffer {
	return Buffer.from(
		encodePin(
			buildPin(source, revision, [
				...Object.entries(carried).map(([path, text]) => ({
					path,
					class: "carried" as const,
					bytes: Buffer.from(text),
				})),
				...Object.entries(HANDED).map(([path, text]) => ({
					path,
					class: "handed-over" as const,
					bytes: Buffer.from(text),
				})),
			]),
		),
	);
}
const COMMITTED = pinFor(CARRIED);
const observed = (carried: Record<string, string>): CarriedObservation => ({
	kind: "observed",
	members: Object.entries(carried)
		.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
		.map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
});
const bytes = (value: Buffer): PinRead => ({ kind: "bytes", bytes: value });
const current: FreshnessInputs = {
	committedPin: bytes(COMMITTED),
	installedPin: bytes(COMMITTED),
	projection: observed(CARRIED),
	capture: observed(CARRIED),
};
const evaluate = (change: Partial<FreshnessInputs>) => evaluateFreshness({ ...current, ...change });

/** A target holding the committed pin, the installed record and the carried files. */
function target(carried: Record<string, string> = CARRIED, installed: Buffer | null = COMMITTED): string {
	const root = mkdtempSync(join(tmpdir(), "gitjig-365-"));
	roots.push(root);
	const write = (path: string, value: string | Buffer) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), value);
	};
	write(GENERATED_PIN_PATH, COMMITTED);
	commitPin(root);
	for (const [path, text] of Object.entries({ ...HANDED, ...carried })) write(path, text);
	if (installed !== null) write(INSTALLED_PIN_PATH, installed);
	return root;
}
/** Commit the working pin, so HEAD holds it: the committed pin is HEAD's. */
function commitPin(root: string): void {
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", root, "-c", "user.name=F", "-c", "user.email=f@example.invalid", ...args], {
			stdio: "ignore",
			env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" },
		});
	git("init", "-q");
	git("add", GENERATED_PIN_PATH);
	git("-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "pin");
}
/** Every path, type, mode, write time and byte under a root, without following links: any write shows. */
function tree(root: string): string {
	const out: string[] = [];
	const visit = (path: string) => {
		const stats = lstatSync(path);
		const rel = path.slice(root.length);
		if (stats.isDirectory()) {
			out.push(`d ${rel} ${stats.mode} ${stats.mtimeMs}`);
			for (const name of readdirSync(path).sort()) visit(join(path, name));
		} else if (stats.isFile())
			out.push(`f ${rel} ${stats.mode} ${stats.mtimeMs} ${readFileSync(path).toString("base64")}`);
		else out.push(`o ${rel} ${stats.mode}`);
	};
	visit(root);
	return out.join("\n");
}

describe("#365 the evaluator's total precedence", () => {
	it("reads current only when the committed pin, the installed record and both projections agree", () => {
		assert.deepEqual(evaluate({}), { state: "current", recovery: null });
	});

	it("1: a committed pin that cannot be read or parsed is cannot-measure", () => {
		for (const committedPin of [
			{ kind: "absent" },
			{ kind: "differs" },
			{ kind: "unreadable" },
			bytes(Buffer.from("{}")),
			bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), COMMITTED])),
		] as PinRead[])
			assert.deepEqual(evaluate({ committedPin, installedPin: { kind: "absent" } }), {
				state: "cannot-measure",
				recovery: PROVISION_COMMAND,
			});
	});

	it("2: an installed record absent, linked, malformed, behind or another is placement-mismatch; unreadable is cannot-measure", () => {
		for (const installedPin of [
			{ kind: "absent" },
			{ kind: "differs" },
			bytes(Buffer.from("not a pin")),
			bytes(pinFor(CARRIED, "b".repeat(40))),
			bytes(pinFor({ ...CARRIED, ".pi/prompts/p.md": "older\n" })),
			bytes(Buffer.from(COMMITTED.toString().replace('"owner":"o"', '"owner":"p"'))),
		] as PinRead[])
			assert.deepEqual(evaluate({ installedPin, projection: { kind: "unreadable" } }), {
				state: "placement-mismatch",
				recovery: PROVISION_COMMAND,
			});
		assert.deepEqual(evaluate({ installedPin: { kind: "unreadable" }, projection: { kind: "differs" } }), {
			state: "cannot-measure",
			recovery: PROVISION_COMMAND,
		});
	});

	it("3: a carried projection that cannot be observed is cannot-measure, ahead of the capture", () => {
		assert.deepEqual(evaluate({ projection: { kind: "unreadable" }, capture: undefined }), {
			state: "cannot-measure",
			recovery: PROVISION_COMMAND,
		});
	});

	it("4: a projection with a link, or a missing, extra, renamed or different member, is placement-mismatch", () => {
		const { ".pi/prompts/p.md": _dropped, ...missing } = CARRIED;
		for (const projection of [
			{ kind: "differs" },
			observed(missing),
			observed({ ...CARRIED, ".pi/prompts/extra.md": "x\n" }),
			observed({ ...missing, ".pi/prompts/q.md": "prompt\n" }),
			observed({ ...CARRIED, ".pi/prompts/p.md": "edited\n" }),
		] as CarriedObservation[])
			assert.deepEqual(evaluate({ projection, capture: undefined }), {
				state: "placement-mismatch",
				recovery: PROVISION_COMMAND,
			});
	});

	it("5: an unavailable load-time capture is cannot-measure advising /reload", () => {
		for (const capture of [undefined, { kind: "unreadable" } as const])
			assert.deepEqual(evaluate({ capture }), { state: "cannot-measure", recovery: RELOAD_COMMAND });
	});

	it("6: a capture that differs while placement is current is session-stale", () => {
		for (const capture of [
			{ kind: "differs" } as const,
			observed({ ...CARRIED, ".pi/extensions/gitjig/a.ts": "export const a = 0;\n" }),
		])
			assert.deepEqual(evaluate({ capture }), { state: "session-stale", recovery: RELOAD_COMMAND });
	});

	it("never reads current from any failing input", () => {
		const failures: Partial<FreshnessInputs>[] = [
			{ committedPin: { kind: "unreadable" } },
			{ installedPin: { kind: "absent" } },
			{ installedPin: { kind: "unreadable" } },
			{ projection: { kind: "unreadable" } },
			{ projection: { kind: "differs" } },
			{ capture: undefined },
			{ capture: { kind: "unreadable" } },
			{ capture: { kind: "differs" } },
		];
		for (const failure of failures) assert.notEqual(evaluate(failure).state, "current", JSON.stringify(failure));
	});
});

describe("#365 the classifier's carried observer", () => {
	it("reports every carried member, extras included, sorted and with exact bytes", () => {
		const root = target({ ...CARRIED, ".pi/prompts/extra.md": "x\n" });
		const observation = observeCarried(root, Date.now() + 2000);
		assert.equal(observation.kind, "observed");
		assert.deepEqual(
			observation.kind === "observed" ? observation.members.map(({ path, bytes }) => [path, bytes.toString()]) : [],
			[
				[".pi/extensions/gitjig.ts", CARRIED[".pi/extensions/gitjig.ts"]],
				[".pi/extensions/gitjig/a.ts", CARRIED[".pi/extensions/gitjig/a.ts"]],
				[".pi/prompts/extra.md", "x\n"],
				[".pi/prompts/p.md", "prompt\n"],
			],
		);
	});

	it("reads a link or non-regular entry as differs and never follows it", () => {
		const outside = mkdtempSync(join(tmpdir(), "gitjig-365-outside-"));
		roots.push(outside);
		writeFileSync(join(outside, "a.ts"), CARRIED[".pi/extensions/gitjig/a.ts"]);
		const linkedMember = target();
		rmSync(join(linkedMember, ".pi/extensions/gitjig/a.ts"));
		symlinkSync(join(outside, "a.ts"), join(linkedMember, ".pi/extensions/gitjig/a.ts"));
		const linkedRoot = target();
		rmSync(join(linkedRoot, ".pi/extensions/gitjig"), { recursive: true });
		symlinkSync(outside, join(linkedRoot, ".pi/extensions/gitjig"));
		const linkedContainer = target();
		renameSync(join(linkedContainer, ".pi/extensions"), join(outside, "extensions"));
		symlinkSync(join(outside, "extensions"), join(linkedContainer, ".pi/extensions"));
		const fifo = target();
		execFileSync("mkfifo", [join(fifo, ".pi/prompts/pipe.md")]);
		const entryDirectory = target();
		rmSync(join(entryDirectory, ".pi/extensions/gitjig.ts"));
		mkdirSync(join(entryDirectory, ".pi/extensions/gitjig.ts"));
		for (const [label, root] of Object.entries({ linkedMember, linkedRoot, linkedContainer, fifo, entryDirectory }))
			assert.deepEqual(observeCarried(root, Date.now() + 2000), { kind: "differs" }, label);
	});

	it("refuses a projection whose container became a link during the walk", () => {
		const root = target();
		const moved = mkdtempSync(join(tmpdir(), "gitjig-365-moved-"));
		roots.push(moved);
		const observation = observeCarried(root, Date.now() + 2000, {
			afterLstat: (path) => {
				if (path !== ".pi/extensions/gitjig/a.ts") return;
				renameSync(join(root, ".pi/extensions"), join(moved, "extensions"));
				symlinkSync(join(moved, "extensions"), join(root, ".pi/extensions"));
			},
		});
		assert.notEqual(observation.kind, "observed", "a linked container was followed");
	});

	it("reads an unreadable entry before any difference, whatever the path order", (context) => {
		if (process.getuid?.() === 0) return context.skip("root reads a mode-000 file");
		for (const [link, locked] of [
			["a-link.md", "b-locked.md"],
			["b-link.md", "a-locked.md"],
		]) {
			const root = target();
			symlinkSync(join(root, ".pi/prompts/p.md"), join(root, `.pi/prompts/${link}`));
			writeFileSync(join(root, `.pi/prompts/${locked}`), "x\n");
			chmodSync(join(root, `.pi/prompts/${locked}`), 0o000);
			assert.deepEqual(observeCarried(root, Date.now() + 2000), { kind: "unreadable" }, `${link} then ${locked}`);
		}
	});

	it("reads unreadable over a root- or container-level difference, and over a difference past the byte bound", (context) => {
		const outside = mkdtempSync(join(tmpdir(), "gitjig-365-outside-"));
		roots.push(outside);
		writeFileSync(join(outside, "entry.ts"), CARRIED[".pi/extensions/gitjig.ts"]);
		const grown = target();
		symlinkSync(join(grown, ".pi/prompts/p.md"), join(grown, ".pi/prompts/a-link.md"));
		const total = Object.values(CARRIED).reduce((sum, text) => sum + Buffer.byteLength(text), 0);
		assert.deepEqual(
			observeCarried(grown, Date.now() + 2000, {
				maxBytes: total + 2,
				afterLstat: (path) => {
					if (path === ".pi/prompts/p.md") writeFileSync(join(grown, path), "x".repeat(100));
				},
			}),
			{ kind: "unreadable" },
			"a difference and a member grown past the bound",
		);
		if (process.getuid?.() === 0) return context.skip("root reads a mode-000 file");
		const rootLevel = target();
		rmSync(join(rootLevel, ".pi/extensions/gitjig.ts"));
		symlinkSync(join(outside, "entry.ts"), join(rootLevel, ".pi/extensions/gitjig.ts"));
		chmodSync(join(rootLevel, ".pi/prompts"), 0o000);
		assert.deepEqual(
			observeCarried(rootLevel, Date.now() + 2000),
			{ kind: "unreadable" },
			"a linked root, then an unreadable one",
		);
		const containerLevel = target();
		const moved = join(outside, "extensions");
		renameSync(join(containerLevel, ".pi/extensions"), moved);
		symlinkSync(moved, join(containerLevel, ".pi/extensions"));
		chmodSync(join(containerLevel, ".pi/prompts"), 0o000);
		assert.deepEqual(
			observeCarried(containerLevel, Date.now() + 2000),
			{ kind: "unreadable" },
			"a linked container, then an unreadable root",
		);
	});

	it("reads a replaced, unreadable or late observation as unreadable", () => {
		const replaced = target();
		const swapped = observeCarried(replaced, Date.now() + 2000, {
			afterRead: (path) => {
				if (path !== ".pi/prompts/p.md") return;
				rmSync(join(replaced, path));
				writeFileSync(join(replaced, path), "swapped\n");
			},
		});
		assert.deepEqual(swapped, { kind: "unreadable" });
		assert.deepEqual(observeCarried(target(), Date.now() - 1), { kind: "unreadable" });
		if (process.getuid?.() !== 0) {
			const locked = target();
			chmodSync(join(locked, ".pi/prompts"), 0o000);
			assert.deepEqual(observeCarried(locked, Date.now() + 2000), { kind: "unreadable" });
		}
	});

	it("reads a member refused for its name or bytes as differs, not unreadable", () => {
		const nonUtf8 = target();
		writeFileSync(join(nonUtf8, ".pi/prompts/bad.md"), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
		const declared = target();
		writeFileSync(join(declared, ".pi/prompts/declared.md"), "# gitjig: unknown-declaration\n");
		const decomposed = target();
		writeFileSync(join(decomposed, ".pi/prompts/cafe\u0301.md"), "x\n");
		for (const [label, root] of Object.entries({ nonUtf8, declared, decomposed }))
			assert.deepEqual(observeCarried(root, Date.now() + 2000), { kind: "differs" }, label);
	});

	it("refuses past the byte bound before reading, so an oversized member is never classified", () => {
		// The member would classify as a difference; the bound must stop the walk first.
		const root = target();
		writeFileSync(join(root, ".pi/prompts/bad.md"), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
		assert.deepEqual(observeCarried(root, Date.now() + 2000, { maxBytes: 10 }), { kind: "unreadable" });
	});

	it("refuses a member that grew past the byte bound between its lstat and its read", () => {
		const root = target();
		const total = Object.values(CARRIED).reduce((sum, text) => sum + Buffer.byteLength(text), 0);
		const grown = observeCarried(root, Date.now() + 2000, {
			maxBytes: total + 2,
			afterLstat: (path) => {
				if (path === ".pi/prompts/p.md") writeFileSync(join(root, path), "x".repeat(100));
			},
		});
		assert.deepEqual(grown, { kind: "unreadable" });
	});

	it("never reads a member past the byte bound", () => {
		const root = target();
		writeFileSync(join(root, ".pi/prompts/zz-big.md"), "x".repeat(100));
		const total = Object.values(CARRIED).reduce((sum, text) => sum + Buffer.byteLength(text), 0);
		const read: string[] = [];
		const observation = observeCarried(root, Date.now() + 2000, {
			maxBytes: total,
			afterRead: (path) => read.push(path),
		});
		assert.deepEqual(observation, { kind: "unreadable" });
		assert.ok(!read.includes(".pi/prompts/zz-big.md"), "a member past the bound was read");
	});

	it("reads a projection past the byte bound as unreadable", () => {
		const root = target();
		assert.deepEqual(observeCarried(root, Date.now() + 2000, { maxBytes: 4 }), { kind: "unreadable" });
		assert.equal(observeCarried(root, Date.now() + 2000, { maxBytes: 1024 }).kind, "observed");
	});

	it("observes an absent carried root as no members, and an unreadable container or root as unreadable", (context) => {
		const noPrompts = target();
		rmSync(join(noPrompts, ".pi/prompts"), { recursive: true });
		assert.deepEqual(
			(observeCarried(noPrompts, Date.now() + 2000) as unknown as { members: { path: string }[] }).members.map(
				({ path }) => path,
			),
			[".pi/extensions/gitjig.ts", ".pi/extensions/gitjig/a.ts"],
		);
		assert.deepEqual(
			measureFreshness(noPrompts, observeCarried(noPrompts, Date.now() + 2000)).state,
			"placement-mismatch",
		);
		if (process.getuid?.() === 0) return context.skip("root reads a mode-000 directory");
		const lockedContainer = target();
		chmodSync(join(lockedContainer, ".pi"), 0o000);
		assert.deepEqual(observeCarried(lockedContainer, Date.now() + 2000), { kind: "unreadable" });
		const lockedRoot = target();
		chmodSync(join(lockedRoot, ".pi/extensions"), 0o000);
		assert.deepEqual(observeCarried(lockedRoot, Date.now() + 2000), { kind: "unreadable" });
	});

	it("observes the prompt root even when the extension container is absent", () => {
		const root = target({ ".pi/prompts/p.md": "prompt\n", ".pi/prompts/extra.md": "x\n" });
		rmSync(join(root, ".pi/extensions"), { recursive: true, force: true });
		const observation = observeCarried(root, Date.now() + 2000);
		assert.deepEqual(observation.kind === "observed" ? observation.members.map(({ path }) => path) : observation, [
			".pi/prompts/extra.md",
			".pi/prompts/p.md",
		]);
	});

	it("reads an absent .pi as an empty projection", () => {
		const root = mkdtempSync(join(tmpdir(), "gitjig-365-empty-"));
		roots.push(root);
		assert.deepEqual(observeCarried(root, Date.now() + 2000), { kind: "observed", members: [] });
	});
});

describe("#365 the pin reads", () => {
	it("read bytes, absent, a link or a linked container as such, never following a link", () => {
		const root = target();
		assert.deepEqual(readPinFile(root, GENERATED_PIN_PATH), { kind: "bytes", bytes: COMMITTED });
		assert.deepEqual(readPinFile(target(CARRIED, null), INSTALLED_PIN_PATH), { kind: "absent" });
		const linked = target();
		rmSync(join(linked, INSTALLED_PIN_PATH));
		symlinkSync(join(linked, GENERATED_PIN_PATH), join(linked, INSTALLED_PIN_PATH));
		assert.deepEqual(readPinFile(linked, INSTALLED_PIN_PATH), { kind: "differs" });
		const container = target();
		const moved = mkdtempSync(join(tmpdir(), "gitjig-365-state-"));
		roots.push(moved);
		rmSync(join(container, ".gitjig"), { recursive: true });
		writeFileSync(join(moved, "installed-pin.json"), COMMITTED);
		symlinkSync(moved, join(container, ".gitjig"));
		assert.deepEqual(readPinFile(container, INSTALLED_PIN_PATH), { kind: "differs" });
	});
});

describe("#365 the pin reads under replacement", () => {
	it("read a record replaced between lstat and open, or after the read, as unreadable", () => {
		const swap = (root: string) => () => {
			rmSync(join(root, INSTALLED_PIN_PATH));
			writeFileSync(join(root, INSTALLED_PIN_PATH), COMMITTED);
		};
		const early = target();
		assert.deepEqual(readPinFile(early, INSTALLED_PIN_PATH, { afterLstat: swap(early) }), { kind: "unreadable" });
		const late = target();
		assert.deepEqual(readPinFile(late, INSTALLED_PIN_PATH, { afterRead: swap(late) }), { kind: "unreadable" });
	});

	it("refuse, within the bound, a FIFO swapped in between lstat and open", () => {
		// In a child under a timeout: a blocking open would hang this process.
		const root = target();
		const freshness = new URL("../.pi/extensions/gitjig/install/freshness.ts", import.meta.url).href;
		const classifier = new URL("../.pi/extensions/gitjig/install/classifier.ts", import.meta.url).href;
		const script = [
			`import { readPinFile } from ${JSON.stringify(freshness)};`,
			`import { observeCarried } from ${JSON.stringify(classifier)};`,
			'import { rmSync } from "node:fs"; import { execFileSync } from "node:child_process"; import { join } from "node:path";',
			`const root = ${JSON.stringify(root)};`,
			'const fifo = (rel) => { rmSync(join(root, rel)); execFileSync("mkfifo", [join(root, rel)]); };',
			'const pin = readPinFile(root, ".gitjig/installed-pin.json", { afterLstat: () => fifo(".gitjig/installed-pin.json") });',
			'const walk = observeCarried(root, Date.now() + 2000, { afterLstat: (path) => { if (path === ".pi/prompts/p.md") fifo(path); } });',
			"console.log(JSON.stringify([pin.kind, walk.kind]));",
		].join("\n");
		const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
			encoding: "utf8",
			timeout: 10_000,
		});
		assert.equal(run.signal, null, "a swapped-in FIFO blocked the open");
		assert.deepEqual(JSON.parse(run.stdout), ["unreadable", "unreadable"]);
	});

	it("read a record whose container became a link after its check as unreadable, never following it", () => {
		const root = target(CARRIED, null);
		const moved = mkdtempSync(join(tmpdir(), "gitjig-365-moved-"));
		roots.push(moved);
		writeFileSync(join(moved, "installed-pin.json"), COMMITTED);
		mkdirSync(join(root, ".gitjig"));
		writeFileSync(join(root, INSTALLED_PIN_PATH), "placeholder\n");
		const read = readPinFile(root, INSTALLED_PIN_PATH, {
			afterContainers: () => {
				rmSync(join(root, ".gitjig"), { recursive: true });
				symlinkSync(moved, join(root, ".gitjig"));
			},
		});
		assert.notEqual(read.kind, "bytes", "a linked container was followed");
	});

	it("read an unreadable container as unreadable", (context) => {
		if (process.getuid?.() === 0) return context.skip("root reads a mode-000 directory");
		const root = target();
		chmodSync(join(root, ".gitjig"), 0o000);
		assert.deepEqual(readPinFile(root, INSTALLED_PIN_PATH), { kind: "unreadable" });
	});
});

describe("#365 one measurement, end to end", () => {
	it("measures current, mismatch and stale on real files, repeatably and without mutation", () => {
		const root = target();
		const capture = captureCarriedProjection(root);
		const before = tree(root);
		assert.deepEqual(measureFreshness(root, capture), { state: "current", recovery: null });
		assert.deepEqual(measureFreshness(root, capture), { state: "current", recovery: null });
		assert.equal(tree(root), before, "a measurement mutated the target");
		writeFileSync(join(root, ".pi/prompts/p.md"), "edited\n");
		assert.deepEqual(measureFreshness(root, capture), { state: "placement-mismatch", recovery: PROVISION_COMMAND });
		writeFileSync(join(root, ".pi/prompts/p.md"), CARRIED[".pi/prompts/p.md"]);
		writeFileSync(join(root, ".pi/extensions/gitjig/a.ts"), "export const a = 0;\n");
		const staleCapture = observeCarried(root, Date.now() + 2000);
		writeFileSync(join(root, ".pi/extensions/gitjig/a.ts"), CARRIED[".pi/extensions/gitjig/a.ts"]);
		assert.deepEqual(measureFreshness(root, staleCapture), { state: "session-stale", recovery: RELOAD_COMMAND });
	});

	it("keeps one code capture per module instance, as Pi's /new and /resume re-run the factory over the cached module", async () => {
		const root = target();
		const first = captureCarriedProjection(root);
		assert.deepEqual(
			first.kind === "observed" ? first.members.map(({ path }) => path) : first,
			[".pi/extensions/gitjig.ts", ".pi/extensions/gitjig/a.ts"],
			"the capture holds the extension code only",
		);
		writeFileSync(join(root, ".pi/extensions/gitjig/a.ts"), "export const a = 2;\n");
		assert.equal(captureCarriedProjection(root), first, "a factory re-run retook the code the module still runs");
		assert.deepEqual(measureFreshness(root, captureCarriedProjection(root)).state, "placement-mismatch");
		const fresh = (await import(
			`../.pi/extensions/gitjig/install/freshness.ts?instance=${Date.now()}`
		)) as typeof import("../.pi/extensions/gitjig/install/freshness.ts");
		assert.notDeepEqual(fresh.captureCarriedProjection(root), first, "a fresh module instance did not capture anew");
	});

	it("names its prompt residual: prompts take no part in session-stale", () => {
		// Edited when the session loaded, restored since: placement is current,
		// and the session-stale comparison does not look at prompts at all.
		const root = target({ ...CARRIED, ".pi/prompts/p.md": "edited at load\n" });
		const capture = captureCarriedProjection(root);
		writeFileSync(join(root, ".pi/prompts/p.md"), CARRIED[".pi/prompts/p.md"]);
		assert.deepEqual(measureFreshness(root, capture), { state: "current", recovery: null });
		const full = observeCarried(target({ ...CARRIED, ".pi/prompts/p.md": "edited at load\n" }), Date.now() + 2000);
		assert.deepEqual(
			measureFreshness(root, full),
			{ state: "current", recovery: null },
			"a capture's own prompts are set aside",
		);
	});

	it("reads cannot-measure when the reads pass the measurement's own budget", () => {
		const root = target();
		// The walk itself finishes inside its deadline; only the measurement's
		// closing check sees the budget spent.
		const start = Date.now();
		let tick = 0;
		const clock = () => (tick++ < 2 ? start : start + 2001);
		assert.deepEqual(measureFreshness(root, captureCarriedProjection(root), clock), {
			state: "cannot-measure",
			recovery: PROVISION_COMMAND,
		});
	});

	it("passes its own deadline to the walk", () => {
		// A clock whose budget is already spent for the walk, while the closing
		// check sees none: only the deadline handed to the walk can refuse.
		const root = target();
		const spent = Date.now() - 5000;
		assert.deepEqual(
			measureFreshness(root, captureCarriedProjection(root), () => spent),
			{
				state: "cannot-measure",
				recovery: PROVISION_COMMAND,
			},
		);
	});

	it("reads HEAD's own pin blob, never one a replace ref substitutes", () => {
		const root = target();
		const git = (args: string[], input?: Buffer) =>
			execFileSync("git", ["-C", root, ...args], {
				encoding: "utf8",
				input,
				env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" },
			}).trim();
		const blob = git(["rev-parse", `HEAD:${GENERATED_PIN_PATH}`]);
		const other = git(["hash-object", "-w", "--stdin"], pinFor(CARRIED, "b".repeat(40)));
		git(["replace", blob, other]);
		assert.notEqual(
			git(["cat-file", "blob", `HEAD:${GENERATED_PIN_PATH}`]),
			COMMITTED.toString().trim(),
			"the replace ref holds",
		);
		assert.deepEqual(readCommittedPin(root, 2000), { kind: "bytes", bytes: COMMITTED });
	});

	it("reads the committed pin in a partial clone without fetching or running its upload program", () => {
		const origin = target();
		const git = (cwd: string, ...args: string[]) =>
			execFileSync("git", ["-C", cwd, ...args], {
				encoding: "utf8",
				env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
			});
		git(origin, "config", "uploadpack.allowFilter", "true");
		const partial = join(mkdtempSync(join(tmpdir(), "gitjig-365-partial-")), "clone");
		roots.push(dirname(partial));
		git(dirname(partial), "clone", "-q", "--filter=blob:none", "--no-checkout", `file://${origin}`, partial);
		const marker = join(dirname(partial), "upload-ran");
		const program = join(dirname(partial), "upload.sh");
		writeFileSync(program, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexec git-upload-pack "$@"\n`, { mode: 0o755 });
		git(partial, "config", "remote.origin.uploadpack", program);
		const packs = () => readdirSync(join(partial, ".git/objects/pack")).sort().join(",");
		const before = packs();
		assert.deepEqual(readCommittedPin(partial, 2000), { kind: "unreadable" });
		assert.equal(existsSync(marker), false, "the clone's upload program ran");
		assert.equal(packs(), before, "a promisor pack was written");
	});

	it("reads the committed pin from HEAD, never the working tree's file", () => {
		const root = target();
		writeFileSync(join(root, GENERATED_PIN_PATH), "an uncommitted edit\n");
		assert.deepEqual(measureFreshness(root, captureCarriedProjection(root)), { state: "current", recovery: null });
		const elsewhere = join(mkdtempSync(join(tmpdir(), "gitjig-365-pin-")), "pin.json");
		roots.push(dirname(elsewhere));
		writeFileSync(elsewhere, pinFor(CARRIED, "b".repeat(40)));
		rmSync(join(root, GENERATED_PIN_PATH));
		symlinkSync(elsewhere, join(root, GENERATED_PIN_PATH));
		assert.deepEqual(measureFreshness(root, captureCarriedProjection(root)).state, "current", "a linked working pin");
		rmSync(join(root, ".git"), { recursive: true });
		assert.deepEqual(measureFreshness(root, captureCarriedProjection(root)), {
			state: "cannot-measure",
			recovery: PROVISION_COMMAND,
		});
	});

	it("finds the session's clone lexically, and reads a session in another clone as a difference", () => {
		const own = target();
		mkdirSync(join(own, "sub/dir"), { recursive: true });
		assert.equal(sessionClone(join(own, "sub/dir")), resolve(own));
		const other = target();
		rmSync(join(other, ".pi/extensions"), { recursive: true });
		symlinkSync(join(own, ".pi/extensions"), join(other, ".pi/extensions"));
		assert.equal(sessionClone(other), resolve(other), "a linked .pi/extensions still marks the clone");
		const capture = captureCarriedProjection(own);
		assert.deepEqual(measureFreshness(own, capture, Date.now, sessionClone(own)), { state: "current", recovery: null });
		assert.deepEqual(measureFreshness(own, capture, Date.now, sessionClone(other)), {
			state: "placement-mismatch",
			recovery: PROVISION_COMMAND,
		});
	});

	it("states its data-file false positive: a re-read file corrected after load reads session-stale", () => {
		// The runtime re-reads such a file at each use, so the session already
		// runs the corrected bytes; the code capture still holds the edited ones.
		const withData = { ...CARRIED, ".pi/extensions/gitjig/policy.json": '{"edited":true}\n' };
		const root = target(withData);
		const capture = captureCarriedProjection(root);
		writeFileSync(join(root, ".pi/extensions/gitjig/policy.json"), "{}\n");
		const corrected = pinFor({ ...CARRIED, ".pi/extensions/gitjig/policy.json": "{}\n" });
		writeFileSync(join(root, GENERATED_PIN_PATH), corrected);
		execFileSync(
			"git",
			[
				"-C",
				root,
				"-c",
				"user.name=F",
				"-c",
				"user.email=f@example.invalid",
				"commit",
				"-q",
				"--no-verify",
				"-am",
				"pin",
			],
			{
				stdio: "ignore",
				env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" },
			},
		);
		writeFileSync(join(root, INSTALLED_PIN_PATH), corrected);
		assert.deepEqual(measureFreshness(root, capture), { state: "session-stale", recovery: RELOAD_COMMAND });
	});

	it("measures against its own target only", () => {
		const one = target();
		const other = target({ ...CARRIED, ".pi/prompts/p.md": "elsewhere\n" });
		assert.deepEqual(measureFreshness(one, captureCarriedProjection(one)).state, "current");
		assert.deepEqual(measureFreshness(other, captureCarriedProjection(one)).state, "placement-mismatch");
	});

	it("names the load-time residual: a correction before the capture is invisible to session-stale", () => {
		// The extension's static imports evaluate before the capture reads the
		// files; a carried file corrected in between is captured corrected, so
		// the session reads current although it runs the earlier bytes.
		const root = target({ ...CARRIED, ".pi/extensions/gitjig/a.ts": "export const a = 0;\n" });
		writeFileSync(join(root, ".pi/extensions/gitjig/a.ts"), CARRIED[".pi/extensions/gitjig/a.ts"]);
		assert.deepEqual(measureFreshness(root, captureCarriedProjection(root)), { state: "current", recovery: null });
	});
});

describe("#365 the rendered line", () => {
	it("carries the state and its recovery token only", () => {
		assert.equal(freshnessLine({ state: "current", recovery: null }), "gitjig freshness: current");
		assert.equal(
			freshnessLine({ state: "placement-mismatch", recovery: PROVISION_COMMAND }),
			"gitjig freshness: placement-mismatch — run node .github/bin/gitjig-bootstrap.mjs (see /freshness help)",
		);
		assert.equal(
			freshnessLine({ state: "session-stale", recovery: RELOAD_COMMAND }),
			"gitjig freshness: session-stale — run /reload (see /freshness help)",
		);
	});
});

describe("#365 the registered renderer and command", () => {
	type Renderer = (
		message: { details: unknown },
		options: { outputPad: number },
	) => { render(width: number): string[] };
	type Command = { handler: (args: string, context: unknown) => Promise<void> };
	function registered(root: string) {
		const renderers = new Map<string, Renderer>();
		const commands = new Map<string, Command>();
		const sent: Array<[Record<string, unknown>, Record<string, unknown>]> = [];
		const pi = {
			registerMessageRenderer: (type: string, renderer: Renderer) => renderers.set(type, renderer),
			registerCommand: (name: string, command: Command) => commands.set(name, command),
			sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) =>
				sent.push([message, options]),
		};
		registerFreshnessCommand(pi as never, root, captureCarriedProjection(root));
		const renderer = renderers.get(FRESHNESS_MESSAGE) as Renderer;
		const render = (details: unknown) =>
			renderer({ details }, { outputPad: 0 })
				.render(400)
				.map((line) => line.trimEnd())
				.join("\n")
				.trim();
		return { render, command: commands.get("freshness") as Command, sent };
	}

	it("renders the help, every valid record, and an invalid record as invalid", () => {
		const { render } = registered(target());
		assert.equal(render("help"), FRESHNESS_HELP);
		assert.equal(render({ state: "current", recovery: null }), "gitjig freshness: current");
		assert.equal(
			render({ state: "session-stale", recovery: RELOAD_COMMAND }),
			"gitjig freshness: session-stale — run /reload (see /freshness help)",
		);
		for (const details of [
			{ state: "current", recovery: null, path: "/x" },
			{ state: "fresh", recovery: null },
			{ state: "current", recovery: "rm -rf" },
			null,
			"other",
		])
			assert.equal(render(details), "[invalid gitjig freshness record]", JSON.stringify(details));
	});

	it("runs the command itself without writing anything, whatever it reports", async () => {
		const root = target(CARRIED, pinFor(CARRIED, "b".repeat(40)));
		const { command, sent } = registered(root);
		const before = tree(root);
		await command.handler("", {});
		await command.handler("help", {});
		assert.equal(tree(root), before, "the command wrote to the target");
		assert.deepEqual(sent[0]?.[0].details, {
			state: "placement-mismatch",
			recovery: PROVISION_COMMAND,
		});
	});

	it("names each launcher exit by the cause and status the launcher itself defines", () => {
		const launcher = readFileSync(new URL("../.github/bin/gitjig-bootstrap.mjs", import.meta.url), "utf8");
		const start = launcher.indexOf("export const STATUS");
		const block = launcher.slice(start, launcher.indexOf("});", start));
		const status = new Map([...block.matchAll(/"([a-z-]+)": (\d+)/gu)].map(([, cause, code]) => [cause, Number(code)]));
		const named = [...FRESHNESS_HELP.matchAll(/([a-z-]+) \(exit (\d+)\)/gu)];
		assert.equal(new Set(named.map(([, cause]) => cause)).size, 5, "every pre-provision or cleanup exit named");
		for (const [, cause, code] of named) assert.equal(status.get(cause as string), Number(code), cause);
	});

	it("compares the session's clone from the command context's cwd", async () => {
		const own = target();
		const other = target();
		rmSync(join(other, ".pi/extensions"), { recursive: true });
		symlinkSync(join(own, ".pi/extensions"), join(other, ".pi/extensions"));
		const { command, sent } = registered(own);
		await command.handler("", { cwd: join(own) });
		await command.handler("", { cwd: other });
		assert.deepEqual(
			sent.map(([message]) => (message.details as { state: string }).state),
			["current", "placement-mismatch"],
		);
	});

	it("sends one content-free message per run, taking no model turn", async () => {
		const root = target();
		const { command, sent } = registered(root);
		await command.handler("", {});
		await command.handler("help", {});
		assert.deepEqual(sent, [
			[
				{
					customType: FRESHNESS_MESSAGE,
					content: "gitjig freshness: current",
					display: true,
					details: { state: "current", recovery: null },
				},
				{ triggerTurn: false },
			],
			[
				{ customType: FRESHNESS_MESSAGE, content: FRESHNESS_HELP, display: true, details: "help" },
				{ triggerTurn: false },
			],
		]);
	});
});

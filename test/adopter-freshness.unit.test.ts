import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
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
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { freshnessLine } from "../.pi/extensions/gitjig/commands/freshness.ts";
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
	readPinFile,
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
	for (const [path, text] of Object.entries({ ...HANDED, ...carried })) write(path, text);
	if (installed !== null) write(INSTALLED_PIN_PATH, installed);
	return root;
}
/** Every path, type, mode, write time and byte under a root, without following links: any write shows. */
function tree(root: string): string {
	const out: string[] = [];
	const visit = (path: string) => {
		const stats = lstatSync(path);
		const rel = path.slice(root.length);
		if (stats.isDirectory()) {
			out.push(`d ${rel} ${stats.mode}`);
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
		const staleCapture = captureCarriedProjection(root);
		writeFileSync(join(root, ".pi/prompts/p.md"), CARRIED[".pi/prompts/p.md"]);
		assert.deepEqual(measureFreshness(root, staleCapture), { state: "session-stale", recovery: RELOAD_COMMAND });
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

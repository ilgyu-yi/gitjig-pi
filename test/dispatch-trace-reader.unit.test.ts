/**
 * #263 — the sanctioned retained-trace reader and its /dispatch-trace
 * command (SPEC §4.9 *The sanctioned retained-trace reader*). The reader
 * runs against a real owner-only state root written by the landed writer.
 */
import assert from "node:assert/strict";
import {
	chmodSync,
	closeSync,
	constants,
	linkSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DISPATCH_TRACE_NOTICES,
	parseTraceId,
	registerDispatchTraceCommand,
} from "../.pi/extensions/gitjig/commands/dispatch-trace.ts";
import { BoundedDelegateTrace, retainTrace, TRACE_RETAIN_MS } from "../.pi/extensions/gitjig/dispatch/trace.ts";
import {
	canonicalTraceId,
	readRetainedTrace,
	TRACE_READ_BYTES,
	type TraceRead,
} from "../.pi/extensions/gitjig/dispatch/trace-reader.ts";

const ID = "1700000000000-0f8fad5b-d9cb-469f-a165-70867728950e";
const NOW = 1_700_000_000_000;
const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function stateRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "gitjig-263-"));
	roots.push(root);
	chmodSync(root, 0o700);
	return root;
}

function snapshot(lines = 2) {
	const trace = new BoundedDelegateTrace();
	for (let index = 0; index < lines; index++) trace.consume("stdout", Buffer.from(`line ${index}\n`));
	trace.consume("stderr", Buffer.from("warn\n"));
	trace.finish();
	return trace.snapshot("completed");
}

/** Write a record body at `<root>/dispatch-traces/<id>.json` with owner-only modes. */
function plant(root: string, body: string | Buffer, id = ID): string {
	const directory = join(root, "dispatch-traces");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const path = join(directory, `${id}.json`);
	writeFileSync(path, body, { mode: 0o600 });
	chmodSync(path, 0o600);
	return path;
}

const valid = () =>
	JSON.stringify({
		lifecycle: "failed",
		lines: [
			{ stream: "stdout", text: "out", truncated: false },
			{ stream: "stderr", text: "err", truncated: true },
		],
		counters: {
			stdoutBytes: 4,
			stderrBytes: 4,
			stdoutLines: 1,
			stderrLines: 1,
			truncatedLines: 1,
			evictedLines: 0,
			decodeReplacements: 0,
		},
	});

describe("#263 identifier and writer", () => {
	it("admits exactly the canonical stem grammar", () => {
		assert.equal(canonicalTraceId(ID), true);
		assert.equal(canonicalTraceId("0-0f8fad5b-d9cb-469f-a165-70867728950e"), true);
		for (const bad of [
			"01-0f8fad5b-d9cb-469f-a165-70867728950e",
			"1700000000000-0F8FAD5B-D9CB-469F-A165-70867728950E",
			"1700000000000-0F8FAD5B-d9cb-469f-a165-70867728950e",
			"1700000000000-0f8fad5b-D9CB-469f-a165-70867728950e",
			"1700000000000-0f8fad5b-d9cb-469F-a165-70867728950e",
			"1700000000000-0f8fad5b-d9cb-469f-A165-70867728950e",
			"1700000000000-0f8fad5b-d9cb-469f-a165-70867728950E",
			"1700000000000-0f8fad5b-d9cb-169f-a165-70867728950e",
			"1700000000000-0f8fad5b-d9cb-469f-c165-70867728950e",
			"99999999999999999-0f8fad5b-d9cb-469f-a165-70867728950e",
			`${ID}.json`,
			`../${ID}`,
			"",
		])
			assert.equal(canonicalTraceId(bad), false, bad);
	});

	it("returns the stem it wrote, and that stem reads back rendered", () => {
		const root = stateRoot();
		const id = retainTrace(root, snapshot(), NOW);
		assert.ok(id !== undefined && canonicalTraceId(id) && id.startsWith(`${NOW}-`));
		const read = readRetainedTrace(root, id, NOW);
		assert.equal(read.outcome, "rendered");
		assert.equal(
			read.outcome === "rendered" && read.text,
			`trace ${id}\ndelegate completed\nout> "line 0"\nout> "line 1"\nerr> "warn"\nstdout-bytes=14; stderr-bytes=5; stdout-lines=2; stderr-lines=1; truncated-lines=0; evicted-lines=0; decode-replacements=0`,
		);
	});
});

describe("#263 reader outcomes", () => {
	const read = (root: string, id = ID, now = NOW) => readRetainedTrace(root, id, now).outcome;

	it("decides expiry before any state read", () => {
		const root = stateRoot();
		plant(root, valid());
		assert.equal(read(root, ID, NOW + TRACE_RETAIN_MS), "rendered");
		assert.equal(read(root, ID, NOW + TRACE_RETAIN_MS + 1), "missing");
		const unsafe = stateRoot();
		plant(unsafe, valid());
		chmodSync(join(unsafe, "dispatch-traces"), 0o755);
		assert.equal(read(unsafe, ID, NOW + TRACE_RETAIN_MS + 1), "missing", "expiry precedes the directory check");
	});

	it("is missing for an absent directory or an absent record", () => {
		assert.equal(read(stateRoot()), "missing");
		const root = stateRoot();
		plant(root, valid(), "1700000000001-0f8fad5b-d9cb-469f-a165-70867728950e");
		assert.equal(read(root), "missing");
	});

	it("is unavailable for an unsafe directory", () => {
		const open = stateRoot();
		plant(open, valid());
		chmodSync(join(open, "dispatch-traces"), 0o750);
		assert.equal(read(open), "unavailable", "group bits");
		const linked = stateRoot();
		const target = stateRoot();
		plant(target, valid());
		symlinkSync(join(target, "dispatch-traces"), join(linked, "dispatch-traces"));
		assert.equal(read(linked), "unavailable", "symlinked directory");
		const file = stateRoot();
		writeFileSync(join(file, "dispatch-traces"), "x", { mode: 0o600 });
		assert.equal(read(file), "unavailable", "a file in the directory's place");
	});

	it("is unavailable for an unsafe or oversize record file", () => {
		const mode = stateRoot();
		chmodSync(plant(mode, valid()), 0o644);
		assert.equal(read(mode), "unavailable", "group-readable record");
		const link = stateRoot();
		const real = plant(link, valid(), "1700000000001-0f8fad5b-d9cb-469f-a165-70867728950e");
		symlinkSync(real, join(link, "dispatch-traces", `${ID}.json`));
		assert.equal(read(link), "unavailable", "symlinked record");
		const dangling = stateRoot();
		plant(dangling, valid(), "1700000000001-0f8fad5b-d9cb-469f-a165-70867728950e");
		symlinkSync(join(dangling, "nowhere.json"), join(dangling, "dispatch-traces", `${ID}.json`));
		assert.equal(read(dangling), "unavailable", "a dangling symlink is refused, never followed to missing");
		const hard = stateRoot();
		const original = plant(hard, valid(), "1700000000001-0f8fad5b-d9cb-469f-a165-70867728950e");
		linkSync(original, join(hard, "dispatch-traces", `${ID}.json`));
		assert.equal(read(hard), "unavailable", "a second name on the inode");
		const big = stateRoot();
		plant(big, valid() + " ".repeat(TRACE_READ_BYTES + 1 - Buffer.byteLength(valid())));
		assert.equal(read(big), "unavailable", "oversize");
		const edge = stateRoot();
		const body = valid();
		plant(edge, body + " ".repeat(TRACE_READ_BYTES - Buffer.byteLength(body)));
		assert.equal(read(edge), "rendered", "exactly the bound");
	});

	it("is unavailable for invalid UTF-8, JSON or schema, and for a running snapshot", () => {
		const base = JSON.parse(valid());
		const cases: Array<[string, string | Buffer]> = [
			["invalid UTF-8", Buffer.from([0x7b, 0xff, 0x7d])],
			[
				"invalid UTF-8 inside an otherwise valid string",
				Buffer.concat([
					Buffer.from(valid().replace('"out"', '"o_t"').split("_")[0]),
					Buffer.from([0xff]),
					Buffer.from(valid().replace('"out"', '"o_t"').split("_")[1]),
				]),
			],
			["invalid JSON", "{"],
			["partial write", valid().slice(0, 40)],
			["running", JSON.stringify({ ...base, lifecycle: "running" })],
			["unknown lifecycle", JSON.stringify({ ...base, lifecycle: "done" })],
			["extra top-level member", JSON.stringify({ ...base, note: 1 })],
			["missing counters", JSON.stringify({ lifecycle: base.lifecycle, lines: base.lines })],
			["21 lines", JSON.stringify({ ...base, lines: Array(21).fill(base.lines[0]) })],
			["line stream", JSON.stringify({ ...base, lines: [{ ...base.lines[0], stream: "stdin" }] })],
			["line text too long", JSON.stringify({ ...base, lines: [{ ...base.lines[0], text: "x".repeat(513) }] })],
			["line truncated not boolean", JSON.stringify({ ...base, lines: [{ ...base.lines[0], truncated: 0 }] })],
			["extra line member", JSON.stringify({ ...base, lines: [{ ...base.lines[0], extra: 1 }] })],
			["snake_case counter", JSON.stringify({ ...base, counters: { ...base.counters, stdout_bytes: 1 } })],
			["negative counter", JSON.stringify({ ...base, counters: { ...base.counters, evictedLines: -1 } })],
			["fractional counter", JSON.stringify({ ...base, counters: { ...base.counters, evictedLines: 0.5 } })],
			["array body", "[]"],
		];
		for (const [name, body] of cases) {
			const root = stateRoot();
			plant(root, body);
			assert.equal(read(root), "unavailable", name);
		}
		const edge = stateRoot();
		plant(
			edge,
			JSON.stringify({ ...base, lines: Array(20).fill({ stream: "stdout", text: "é".repeat(512), truncated: true }) }),
		);
		const rendered = readRetainedTrace(edge, ID, NOW);
		assert.equal(rendered.outcome, "rendered", "20 lines of 512 code points are within bounds");
		assert.ok(rendered.outcome === "rendered" && rendered.text.split("\n").length === 23, "at most 23 lines");
	});

	it("never derives a path from a non-canonical token", () => {
		const root = stateRoot();
		plant(root, valid());
		assert.equal(read(root, `../${ID}`), "unavailable");
	});
});

describe("#263 reader against the direct-written store", () => {
	it("a record being written reads missing, then unavailable, then rendered, and never partially", () => {
		const root = stateRoot();
		const directory = join(root, "dispatch-traces");
		mkdirSync(directory, { mode: 0o700 });
		const path = join(directory, `${ID}.json`);
		assert.equal(readRetainedTrace(root, ID, NOW).outcome, "missing", "not yet created");
		const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		const body = Buffer.from(`${valid()}\n`);
		writeSync(fd, body, 0, 30);
		assert.equal(readRetainedTrace(root, ID, NOW).outcome, "unavailable", "created but incomplete");
		writeSync(fd, body, 30);
		closeSync(fd);
		assert.equal(readRetainedTrace(root, ID, NOW).outcome, "rendered", "complete");
	});

	it("a prune landing after the open makes the record unavailable under the one-name sink check", () => {
		const root = stateRoot();
		const path = plant(root, valid());
		assert.equal(readRetainedTrace(root, ID, NOW, { afterOpen: () => unlinkSync(path) }).outcome, "unavailable");
		const kept = stateRoot();
		plant(kept, valid());
		assert.equal(
			readRetainedTrace(kept, ID, NOW, { beforeOpen: () => {}, afterOpen: () => {} }).outcome,
			"rendered",
			"the seams alone change nothing",
		);
	});

	it("a directory swapped for a symlink between its check and the open reads unavailable", () => {
		const root = stateRoot();
		plant(root, valid());
		const outside = stateRoot();
		plant(outside, valid());
		const directory = join(root, "dispatch-traces");
		const swap = () => {
			renameSync(directory, join(root, "moved"));
			symlinkSync(join(outside, "dispatch-traces"), directory);
		};
		assert.equal(readRetainedTrace(root, ID, NOW, { beforeOpen: swap }).outcome, "unavailable");
		const rebuilt = stateRoot();
		plant(rebuilt, valid());
		const rebuild = () => {
			renameSync(join(rebuilt, "dispatch-traces"), join(rebuilt, "old"));
			plant(rebuilt, valid());
		};
		assert.equal(
			readRetainedTrace(rebuilt, ID, NOW, { beforeOpen: rebuild }).outcome,
			"unavailable",
			"a safe directory replaced by another safe directory is not the directory that was checked",
		);
		const replaced = stateRoot();
		const path = plant(replaced, valid());
		const other = join(replaced, "other.json");
		writeFileSync(other, valid(), { mode: 0o600 });
		assert.equal(
			readRetainedTrace(replaced, ID, NOW, { afterOpen: () => renameSync(other, path) }).outcome,
			"unavailable",
			"a record renamed over after the open is not the record the path names",
		);
		const moved = stateRoot();
		const movedPath = plant(moved, valid());
		const substitute = join(moved, "substitute.json");
		writeFileSync(substitute, valid(), { mode: 0o600 });
		const shuffle = () => {
			renameSync(movedPath, join(moved, "dispatch-traces", "kept.json"));
			renameSync(substitute, movedPath);
		};
		assert.equal(
			readRetainedTrace(moved, ID, NOW, { afterOpen: shuffle }).outcome,
			"unavailable",
			"the opened record kept its one name elsewhere while another took its path",
		);
	});

	it("checks the directory before its one open of the record", () => {
		const source = readFileSync(new URL("../.pi/extensions/gitjig/dispatch/trace-reader.ts", import.meta.url), "utf8");
		const body = source.slice(source.indexOf("export function readRetainedTrace("));
		assert.equal(body.split("openSync(").length - 1, 1, "exactly one open of the record");
		assert.ok(
			body.indexOf("lstatSync(directory)") < body.indexOf("openSync("),
			"the directory check precedes the open",
		);
	});

	it("a pruned record reads missing, and a crashed one reads unavailable until it expires", () => {
		const root = stateRoot();
		const path = plant(root, valid());
		unlinkSync(path);
		assert.equal(readRetainedTrace(root, ID, NOW).outcome, "missing");
		plant(root, valid().slice(0, 20));
		assert.equal(readRetainedTrace(root, ID, NOW).outcome, "unavailable");
		assert.equal(readRetainedTrace(root, ID, NOW + TRACE_RETAIN_MS + 1).outcome, "missing");
	});
});

type Handler = (args: string, ctx: unknown) => Promise<void>;

function commandHarness(mode: "tui" | "rpc" | "json" | "print", hasUI = mode === "tui" || mode === "rpc") {
	let handler: Handler | undefined;
	const reads: string[] = [];
	const notices: Array<[string, string]> = [];
	const customs: string[][] = [];
	const forbidden: string[] = [];
	const pi = new Proxy(
		{
			registerCommand: (_name: string, spec: { handler: Handler }) => {
				handler = spec.handler;
			},
		},
		{
			get(target, property) {
				if (property in target) return target[property as keyof typeof target];
				return () => forbidden.push(String(property));
			},
		},
	) as unknown as ExtensionAPI;
	let outcome: TraceRead = { outcome: "rendered", text: "trace x\ndelegate completed · no output observed\ncounters" };
	registerDispatchTraceCommand(pi, "/state", (_root, id) => {
		reads.push(id);
		return outcome;
	});
	const ctx = {
		mode,
		hasUI,
		ui: {
			notify: (text: string, level: string) => notices.push([text, level]),
			custom: async (
				factory: (...args: unknown[]) => { render(width: number): string[]; handleInput(data: string): void },
			) => {
				let closed = false;
				const component = factory({}, { fg: (_c: string, text: string) => text }, {}, () => {
					closed = true;
				});
				customs.push(component.render(200));
				component.handleInput("q");
				assert.equal(closed, true, "any key dismisses the viewer");
			},
		},
	};
	return {
		run: async (args: string) => {
			assert.ok(handler);
			await handler(args, ctx);
		},
		set: (value: TraceRead) => {
			outcome = value;
		},
		reads,
		notices,
		customs,
		forbidden,
	};
}

describe("#263 /dispatch-trace command", () => {
	it("returns outside TUI before validating or reading, with one fixed RPC notice", async () => {
		for (const mode of ["rpc", "json", "print"] as const) {
			const h = commandHarness(mode);
			await h.run(ID);
			await h.run("not a token");
			assert.deepEqual(h.reads, [], `${mode}: read state`);
			assert.deepEqual(
				h.notices,
				mode === "rpc" ? [DISPATCH_TRACE_NOTICES.rpc, DISPATCH_TRACE_NOTICES.rpc].map((text) => [text, "warning"]) : [],
				mode,
			);
			assert.deepEqual(h.customs, [], mode);
		}
	});

	it("gives one fixed usage notice for zero, several, or non-canonical tokens, and reads nothing", async () => {
		for (const args of ["", "   ", `${ID} ${ID}`, `${ID}.json`, "../x", `${ID}\u00a0`]) {
			const h = commandHarness("tui");
			await h.run(args);
			assert.deepEqual(h.reads, [], JSON.stringify(args));
			assert.deepEqual(h.notices, [[DISPATCH_TRACE_NOTICES.usage, "error"]], JSON.stringify(args));
		}
		assert.equal(parseTraceId(`\t ${ID}\n`), ID, "ASCII whitespace around one token");
	});

	it("renders only in one dismissible terminal component and notifies fixed text otherwise", async () => {
		const h = commandHarness("tui");
		await h.run(` ${ID} `);
		assert.deepEqual(h.reads, [ID]);
		assert.equal(h.customs.length, 1);
		assert.ok(h.customs[0].join("\n").includes("delegate completed"));
		assert.deepEqual(h.notices, [], "rendered content never rides a notice");
		h.set({ outcome: "missing" });
		await h.run(ID);
		h.set({ outcome: "unavailable" });
		await h.run(ID);
		assert.deepEqual(h.notices, [
			[DISPATCH_TRACE_NOTICES.missing, "warning"],
			[DISPATCH_TRACE_NOTICES.unavailable, "warning"],
		]);
		assert.deepEqual(h.forbidden, [], "the command wrote no session message or entry");
	});
});

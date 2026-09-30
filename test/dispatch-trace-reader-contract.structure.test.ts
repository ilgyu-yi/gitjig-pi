/**
 * Issue #393 — the settled contract for #263's sanctioned retained-trace
 * reader (SPEC §4.9, §5.5, §5.9). Contract-only: this pins the settled text
 * and claims no runtime delivery.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const SPEC = readFileSync(new URL("../SPEC.md", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const READER = readFileSync(new URL("./fixtures/dispatch-trace-reader.contract.txt", import.meta.url), "utf8")
	.replaceAll("\r\n", "\n")
	.trim();

const DETAILS =
	"Persisted `details` is exactly `{disposition,ok?,compare?,diagnostic,traceId?}` and never carries summary, payload, or raw trace; `traceId` is the sanctioned reader's retained-trace identifier below, present only when the writer returned one.";
const STATE =
	"The trace has no runtime read-back path into tool results, session messages, or model context. Its one runtime read path is §4.9's TUI-only operator viewer, which reads one record by its identifier and renders it only in a terminal component; that path never reaches tool results, session messages, or model context either.";
const ROW =
	"The expanded terminal row of a dispatch that ran may also show §4.9's retained-trace identifier as `trace <id>`, or `trace unavailable` when the writer returned none; a dispatch refused before its run shows no trace indication.";

function section(source: string, start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	return from >= 0 && to > from ? source.slice(from, to) : "";
}

function contractHolds(source: string): boolean {
	const delegation = section(source, "### 4.9 The delegation layer", "## 5. Cross-cutting contracts");
	const opening = "**The sanctioned retained-trace reader.**";
	if (delegation.split(opening).length !== 2 || source.indexOf(opening) !== source.lastIndexOf(opening)) return false;
	const start = delegation.indexOf(opening);
	const end = delegation.indexOf("\n\n", start);
	const paragraph = delegation.slice(start, end < 0 ? undefined : end).trim();
	return (
		paragraph === READER &&
		delegation.includes(DETAILS) &&
		section(source, "### 5.5 State boundary", "### 5.6").includes(STATE) &&
		section(source, "### 5.9 Session surfaces", "## 6. Self-governance milestone").includes(ROW)
	);
}

describe("#393 retained-trace reader contract", () => {
	it("pins the reader paragraph, the details shape, the state-boundary read path and the expanded row", () => {
		assert.equal(contractHolds(SPEC), true);
	});

	it("kills every baseline-first contract mutant", () => {
		const mutants: ReadonlyArray<readonly [string, string, string]> = [
			[
				"non-TUI return moved after validation",
				"Unless the mode is `tui`, the handler returns before splitting, validating, or reading anything:",
				"Unless the mode is `tui`, the handler validates the token and then returns:",
			],
			[
				"reader widened to RPC notifications",
				"puts trace content in no notification, status, widget, or channel an RPC client receives",
				"puts trace content in no status or widget",
			],
			[
				"read-time age bound removed",
				"First, an identifier time more than seven days before the reader's clock is **missing**, decided before any state read and even if the record is unpruned. ",
				"",
			],
			[
				"session write added",
				"The command writes no session message or entry,",
				"The command writes one session entry,",
			],
			[
				"running admitted",
				"(`completed`, `failed`, `aborted`, `timed-out`, `spawn-failed`)",
				"(any landed lifecycle class)",
			],
			["size bound widened", "at most 256 KiB", "at most 1 MiB"],
			[
				"absent directory left unclassified",
				"is **missing** when absent, since the writer creates it only on its first retention; when present it",
				"",
			],
			[
				"persisted member names dropped",
				"with exactly the members `lifecycle`, `lines`, and `counters`",
				"of the trace-snapshot shape",
			],
			[
				"counter keys dropped",
				"exactly the members `stdoutBytes`, `stderrBytes`, `stdoutLines`, `stderrLines`, `truncatedLines`, `evictedLines`, and `decodeReplacements`",
				"the seven counters",
			],
			["details shape without the identifier", "diagnostic,traceId?}`", "diagnostic}`"],
			[
				"state-boundary read path dropped",
				" Its one runtime read path is §4.9's TUI-only operator viewer,",
				" Its read path is any operator viewer,",
			],
			["expanded row claim dropped", ROW, ""],
			[
				"reader paragraph duplicated",
				"**The sanctioned retained-trace reader.**",
				"**The sanctioned retained-trace reader.** **The sanctioned retained-trace reader.**",
			],
		];
		for (const [name, from, to] of mutants) {
			assert.equal(SPEC.split(from).length, 2, `${name}: mutation operand must be unique`);
			assert.equal(contractHolds(SPEC.replace(from, () => to)), false, `${name} survived`);
		}
	});
});

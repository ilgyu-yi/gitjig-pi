import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { STATE_DIR_MODE, STATE_FILE_MODE, STATE_PATH_GUARD_FLAGS, sinkRefusal } from "../audit.ts";
import { quoted } from "../quote.ts";

export const TRACE_LINE_BYTES = 8 * 1024;
export const TRACE_LINES = 20;
export const TRACE_RENDER_CODEPOINTS = 512;
export const TRACE_UPDATE_MS = 100;
export const TRACE_RETAIN_COUNT = 50;
export const TRACE_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
export const TRACE_DIRECTORY = "dispatch-traces";

export interface TraceCounters {
	stdoutBytes: number;
	stderrBytes: number;
	stdoutLines: number;
	stderrLines: number;
	truncatedLines: number;
	evictedLines: number;
	decodeReplacements: number;
}

export interface TraceLine {
	stream: "stdout" | "stderr";
	text: string;
	truncated: boolean;
}

export interface TraceSnapshot {
	lines: readonly TraceLine[];
	counters: Readonly<TraceCounters>;
}

interface StreamState {
	kept: Buffer[];
	keptBytes: number;
	dropping: boolean;
}

const freshCounters = (): TraceCounters => ({
	stdoutBytes: 0,
	stderrBytes: 0,
	stdoutLines: 0,
	stderrLines: 0,
	truncatedLines: 0,
	evictedLines: 0,
	decodeReplacements: 0,
});

export class BoundedDelegateTrace {
	readonly counters = freshCounters();
	private readonly states: Record<"stdout" | "stderr", StreamState> = {
		stdout: { kept: [], keptBytes: 0, dropping: false },
		stderr: { kept: [], keptBytes: 0, dropping: false },
	};
	private readonly retained: TraceLine[] = [];

	consume(stream: "stdout" | "stderr", chunk: Buffer): void {
		this.counters[stream === "stdout" ? "stdoutBytes" : "stderrBytes"] += chunk.byteLength;
		let start = 0;
		for (let index = 0; index <= chunk.length; index++) {
			if (index !== chunk.length && chunk[index] !== 0x0a) continue;
			this.consumeFragment(stream, chunk.subarray(start, index));
			if (index !== chunk.length) this.finishLine(stream);
			start = index + 1;
		}
	}

	finish(): void {
		for (const stream of ["stdout", "stderr"] as const) {
			const state = this.states[stream];
			if (state.keptBytes > 0 || state.dropping) this.finishLine(stream);
		}
	}

	snapshot(): TraceSnapshot {
		return {
			lines: this.retained.map((line) => ({ ...line })),
			counters: { ...this.counters },
		};
	}

	private consumeFragment(stream: "stdout" | "stderr", fragment: Buffer): void {
		const state = this.states[stream];
		if (fragment.length === 0 || state.dropping) return;
		const room = TRACE_LINE_BYTES - state.keptBytes;
		if (room > 0) {
			const kept = fragment.subarray(0, room);
			state.kept.push(kept);
			state.keptBytes += kept.length;
		}
		if (fragment.length > room) state.dropping = true;
	}

	private finishLine(stream: "stdout" | "stderr"): void {
		const state = this.states[stream];
		const bytes = Buffer.concat(state.kept, state.keptBytes);
		let text = bytes.toString("utf8");
		const replacements = [...text].filter((value) => value === "�").length;
		this.counters.decodeReplacements += replacements;
		const points = [...text];
		if (points.length > TRACE_RENDER_CODEPOINTS) text = points.slice(0, TRACE_RENDER_CODEPOINTS).join("");
		const line = { stream, text, truncated: state.dropping || points.length > TRACE_RENDER_CODEPOINTS };
		if (line.truncated) this.counters.truncatedLines++;
		this.counters[stream === "stdout" ? "stdoutLines" : "stderrLines"]++;
		this.retained.push(line);
		if (this.retained.length > TRACE_LINES) {
			this.retained.shift();
			this.counters.evictedLines++;
		}
		state.kept = [];
		state.keptBytes = 0;
		state.dropping = false;
	}
}

export function renderTraceSnapshot(snapshot: TraceSnapshot): string {
	const lines = snapshot.lines.map(
		(line) =>
			`${line.stream === "stdout" ? "out" : "err"}> ${quoted(line.text)}${line.truncated ? " [truncated]" : ""}`,
	);
	return lines.length === 0 ? "delegate running · no output observed" : `delegate running\n${lines.join("\n")}`;
}

export function retainTrace(stateRoot: string, snapshot: TraceSnapshot, now = Date.now()): boolean {
	let fd: number | undefined;
	try {
		const directory = join(stateRoot, TRACE_DIRECTORY);
		mkdirSync(directory, { recursive: true, mode: STATE_DIR_MODE });
		const directoryStats = lstatSync(directory);
		if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() || (directoryStats.mode & 0o077) !== 0)
			return false;
		const path = join(directory, `${now}-${randomUUID()}.json`);
		fd = openSync(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | STATE_PATH_GUARD_FLAGS,
			STATE_FILE_MODE,
		);
		if (sinkRefusal(fstatSync(fd), path) !== undefined) return false;
		writeFileSync(fd, `${JSON.stringify(snapshot)}\n`);
		closeSync(fd);
		fd = undefined;
		const entries = readdirSync(directory)
			.filter((name) => /^\d+-[0-9a-f-]+\.json$/.test(name))
			.map((name) => ({ name, time: Number(name.slice(0, name.indexOf("-"))) }))
			.sort((left, right) => right.time - left.time);
		for (const [index, entry] of entries.entries()) {
			if (index >= TRACE_RETAIN_COUNT || now - entry.time > TRACE_RETAIN_MS) unlinkSync(join(directory, entry.name));
		}
		return true;
	} catch {
		return false;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {}
		}
	}
}

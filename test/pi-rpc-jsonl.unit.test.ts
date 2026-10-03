/**
 * #414 (part 3 of #370): the bounded LF-framed JSONL reader SPEC §4.9's Pi
 * clause requires. Every arm in which the READER refuses a record asserts by
 * value that neither that record nor any later one is delivered — later in the
 * same push buffer as well as in a later push — because a reader that reports
 * "invalid" while still handing records to its consumer would carry child text
 * across exactly the boundary it exists to hold. Consumer rejection is the one
 * different case: a consumer can only reject a record it has received, so that
 * one record reaches it; the reader then contains the thrown error and delivers
 * nothing after it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	BoundedRpcJsonl,
	RPC_MAX_RECORD_BYTES,
	RPC_MAX_RECORDS,
	RPC_MAX_STREAM_BYTES,
} from "../.pi/extensions/gitjig/dispatch/rpc-jsonl.ts";

function reader() {
	const records: Record<string, unknown>[] = [];
	return { stream: new BoundedRpcJsonl((record) => records.push(record)), records };
}

/** Once invalid, a further well-formed record in a later push must change nothing a consumer sees. */
function assertSealed(stream: BoundedRpcJsonl, records: readonly unknown[]): void {
	const before = records.length;
	assert.equal(stream.push(Buffer.from('{"type":"after"}\n')), "invalid");
	assert.equal(stream.finish(), "invalid");
	assert.equal(records.length, before, "a record arriving after invalidation was delivered");
}

test("LF framing preserves U+2028 and handles split UTF-8, CRLF and fast adjacent responses/events", () => {
	const { stream, records } = reader();
	const wire = Buffer.from('{"type":"response","id":"1","text":"a\u2028b"}\r\n{"type":"agent_settled"}\n');
	// One byte at a time: U+2028 is three UTF-8 bytes, so this splits it.
	for (const byte of wire) assert.equal(stream.push(Buffer.from([byte])), "reading");
	assert.equal(stream.finish(), "complete");
	assert.equal(stream.recordCount, 2);
	assert.deepEqual(records, [{ type: "response", id: "1", text: "a\u2028b" }, { type: "agent_settled" }]);
});

test("malformed, empty, scalar and incomplete records invalidate without delivering text", () => {
	for (const wire of ["{bad}\n", "\n", "[]\n", '"text"\n', "null\n", "\ufeff{}\n", '{"type":"incomplete"']) {
		const { stream, records } = reader();
		stream.push(Buffer.from(wire));
		assert.equal(stream.finish(), "invalid", JSON.stringify(wire));
		assert.deepEqual(records, [], JSON.stringify(wire));
	}
	// An unfinished record is refused at finish; nothing was delivered before it.
	for (const wire of ["{bad}\n", "\n", "[]\n", '"text"\n', "null\n", "\ufeff{}\n"]) {
		const { stream, records } = reader();
		assert.equal(stream.push(Buffer.from(wire)), "invalid", JSON.stringify(wire));
		assertSealed(stream, records);
		assert.deepEqual(records, []);
	}
});

test("invalid UTF-8 invalidates without delivering the record or any later one", () => {
	const { stream, records } = reader();
	// {"<0xff>"} — well-formed JSON shape around a byte no UTF-8 decoder admits.
	assert.equal(stream.push(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d, 0x0a])), "invalid");
	assert.deepEqual(records, []);
	assertSealed(stream, records);
	assert.deepEqual(records, []);
});

test("a refused record suppresses a valid later record that shares its push buffer", () => {
	const later = Buffer.from('{"type":"later"}\n');
	const refusals: ReadonlyArray<readonly [string, Buffer]> = [
		["malformed", Buffer.from("{bad}\n")],
		["empty", Buffer.from("\n")],
		["array", Buffer.from("[]\n")],
		["scalar", Buffer.from('"text"\n')],
		["null", Buffer.from("null\n")],
		// A BOM is never stripped: the record it prefixes is refused, here as a
		// later record's prefix, where a silently stripping decoder would pass it.
		["BOM-prefixed", Buffer.from('\ufeff{"type":"x"}\n')],
		["invalid UTF-8", Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d, 0x0a])],
		["oversized", Buffer.concat([Buffer.alloc(RPC_MAX_RECORD_BYTES + 1, 65), Buffer.from("\n")])],
	];
	for (const [label, refused] of refusals) {
		const { stream, records } = reader();
		// A valid record first, so the arm also shows earlier delivery is untouched.
		const buffer = Buffer.concat([Buffer.from('{"type":"before"}\n'), refused, later]);
		assert.equal(stream.push(buffer), "invalid", label);
		assert.deepEqual(records, [{ type: "before" }], `${label}: a record after the refused one was delivered`);
		assertSealed(stream, records);
	}
});

test("the record-size bound fails closed without delivering the oversized record or any later one", () => {
	const unfinished = reader();
	assert.equal(unfinished.stream.push(Buffer.alloc(RPC_MAX_RECORD_BYTES + 1, 65)), "invalid");
	assert.equal(unfinished.stream.recordCount, 0);
	assert.deepEqual(unfinished.records, []);
	assertSealed(unfinished.stream, unfinished.records);

	const whole = reader();
	const oversized = `${JSON.stringify({ type: "x", body: "a".repeat(RPC_MAX_RECORD_BYTES) })}\n`;
	assert.ok(Buffer.byteLength(oversized) > RPC_MAX_RECORD_BYTES + 1);
	assert.equal(whole.stream.push(Buffer.from('{"type":"before"}\n')), "reading");
	assert.equal(whole.stream.push(Buffer.from(oversized)), "invalid");
	// Only the record before the bound was delivered; the oversized one was not.
	assert.deepEqual(whole.records, [{ type: "before" }]);
	assertSealed(whole.stream, whole.records);
});

test("the record-count bound trips at exactly its cap and delivers nothing past it", () => {
	const { stream, records } = reader();
	const record = Buffer.from('{"type":"x"}\n');
	// Short records reach the count cap long before the stream cap, so the cap
	// that trips is the count cap; the byte total below proves it.
	assert.ok(record.length * (RPC_MAX_RECORDS + 1) < RPC_MAX_STREAM_BYTES);
	let pushed = 0;
	while (stream.status === "reading" && pushed <= RPC_MAX_RECORDS) {
		stream.push(record);
		pushed++;
	}
	assert.equal(stream.status, "invalid");
	assert.equal(pushed, RPC_MAX_RECORDS + 1, "the cap must trip on the first record past it, not earlier");
	assert.equal(stream.recordCount, RPC_MAX_RECORDS);
	assert.equal(records.length, RPC_MAX_RECORDS, "the record past the cap was delivered");
	assertSealed(stream, records);

	// The same cap, met with the record past it and a later one in one buffer.
	const shared = reader();
	for (let i = 0; i < RPC_MAX_RECORDS - 1; i++) shared.stream.push(record);
	assert.equal(shared.stream.status, "reading");
	assert.equal(shared.stream.push(Buffer.concat([record, record, Buffer.from('{"type":"later"}\n')])), "invalid");
	assert.equal(shared.records.length, RPC_MAX_RECORDS, "a record sharing the buffer past the cap was delivered");
});

test("the stream bound fails closed on the crossing chunk and delivers nothing from it or later", () => {
	const { stream, records } = reader();
	const record = Buffer.from(`${JSON.stringify({ type: "x", body: "a".repeat(1000) })}\n`);
	// Long records reach the stream cap well before the count cap.
	assert.ok(Math.ceil(RPC_MAX_STREAM_BYTES / record.length) < RPC_MAX_RECORDS);
	let accepted = 0;
	while (stream.status === "reading") {
		if (stream.push(record) === "reading") accepted++;
	}
	assert.equal(stream.status, "invalid");
	assert.ok(accepted * record.length <= RPC_MAX_STREAM_BYTES);
	assert.ok((accepted + 1) * record.length > RPC_MAX_STREAM_BYTES);
	// The chunk that crossed the bound was refused before framing, so exactly
	// the records accepted before it were delivered — the stream cap, not the
	// count cap, is what tripped.
	assert.equal(records.length, accepted);
	assert.equal(stream.recordCount, accepted);
	assert.ok(stream.recordCount < RPC_MAX_RECORDS);
	assertSealed(stream, records);
});

test("baseline-first private-copy delimiter mutant fails on a real Unicode separator", async () => {
	const source = readFileSync(
		fileURLToPath(new URL("../.pi/extensions/gitjig/dispatch/rpc-jsonl.ts", import.meta.url)),
		"utf8",
	);
	const anchor = "bytes[i] !== 10";
	assert.notEqual(source.indexOf(anchor), -1, "mutation anchor must exist");
	assert.equal(source.indexOf(anchor), source.lastIndexOf(anchor), "mutation anchor must be unique");
	const wire = Buffer.from('{"type":"response","text":"a\u2028b"}\n');
	const baseline = reader();
	assert.equal(baseline.stream.push(wire), "reading");
	assert.equal(baseline.stream.finish(), "complete");
	assert.deepEqual(baseline.records, [{ type: "response", text: "a\u2028b" }]);
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-rpc-mutant-"));
	try {
		const path = join(scratch, "rpc-jsonl.ts");
		// 0xe2 is U+2028's first UTF-8 byte: framing on it splits that record.
		writeFileSync(
			path,
			source.replace(anchor, () => "bytes[i] !== 0xe2"),
		);
		const { BoundedRpcJsonl: Mutant } = await import(pathToFileURL(path).href);
		const records: Record<string, unknown>[] = [];
		const mutant = new Mutant((record: Record<string, unknown>) => records.push(record));
		assert.equal(mutant.push(wire), "invalid");
		assert.deepEqual(records, []);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("consumer rejection invalidates the transport, contains the thrown error and delivers nothing after it", () => {
	const delivered: unknown[] = [];
	const stream = new BoundedRpcJsonl((record) => {
		delivered.push(record);
		throw Error("private child content");
	});
	// The rejected record and a valid one after it, in one buffer.
	assert.doesNotThrow(() => stream.push(Buffer.from('{"type":"event"}\n{"type":"later"}\n')));
	assert.equal(stream.status, "invalid");
	assert.equal(stream.finish(), "invalid");
	// The rejecting consumer necessarily saw the one record it refused, and
	// nothing after it — not the later record that shared its buffer.
	assert.deepEqual(delivered, [{ type: "event" }]);
	assertSealed(stream, delivered);
});

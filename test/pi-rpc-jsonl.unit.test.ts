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

test("LF framing preserves U+2028 and handles split UTF-8, CRLF and fast adjacent responses/events", () => {
	const { stream, records } = reader();
	const wire = Buffer.from('{"type":"response","id":"1","text":"a\u2028b"}\r\n{"type":"agent_settled"}\n');
	for (const byte of wire) assert.equal(stream.push(Buffer.from([byte])), "reading");
	assert.equal(stream.finish(), "complete");
	assert.equal(stream.recordCount, 2);
	assert.deepEqual(records, [{ type: "response", id: "1", text: "a\u2028b" }, { type: "agent_settled" }]);
});

test("malformed, empty, scalar and incomplete records invalidate without delivering text", () => {
	for (const wire of ["{bad}\n", "\n", "[]\n", '"text"\n', '{"type":"incomplete"']) {
		const { stream, records } = reader();
		stream.push(Buffer.from(wire));
		assert.equal(stream.finish(), "invalid");
		assert.deepEqual(records, []);
		assert.equal(stream.push(Buffer.from('{"type":"response"}\n')), "invalid");
	}
	const { stream } = reader();
	assert.equal(stream.push(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d, 0x0a])), "invalid");
});

test("record, stream and record-count limits fail closed without retaining later content", () => {
	const tooLong = reader();
	assert.equal(tooLong.stream.push(Buffer.alloc(RPC_MAX_RECORD_BYTES + 1, 65)), "invalid");
	assert.equal(tooLong.stream.recordCount, 0);
	const wholeLine = reader();
	assert.equal(
		wholeLine.stream.push(Buffer.concat([Buffer.alloc(RPC_MAX_RECORD_BYTES + 1, 65), Buffer.from("\n")])),
		"invalid",
	);
	const total = reader();
	const record = Buffer.from('{"type":"x"}\n');
	for (let i = 0; i < Math.floor(RPC_MAX_STREAM_BYTES / record.length); i++) {
		if (total.stream.status !== "reading") break;
		total.stream.push(record);
	}
	assert.equal(total.stream.status, "invalid"); // count cap is reached before byte cap on short records
	const byteCap = reader();
	const largeRecord = Buffer.from(`${JSON.stringify({ type: "x", body: "a".repeat(1000) })}\n`);
	for (let i = 0; i < Math.ceil(RPC_MAX_STREAM_BYTES / largeRecord.length) + 1; i++) {
		if (byteCap.stream.status !== "reading") break;
		byteCap.stream.push(largeRecord);
	}
	assert.equal(byteCap.stream.status, "invalid");
	assert.ok(byteCap.stream.recordCount < RPC_MAX_RECORDS);
});

test("baseline-first private-copy delimiter mutant fails on a real Unicode separator", async () => {
	const source = readFileSync(
		fileURLToPath(new URL("../.pi/extensions/gitjig/dispatch/rpc-jsonl.ts", import.meta.url)),
		"utf8",
	);
	const anchor = "bytes[i] !== 10";
	assert.equal(source.split(anchor).length, 2);
	const wire = Buffer.from('{"type":"response","text":"a\u2028b"}\n');
	const baseline = reader();
	assert.equal(baseline.stream.push(wire), "reading");
	assert.equal(baseline.stream.finish(), "complete");
	assert.deepEqual(baseline.records, [{ type: "response", text: "a\u2028b" }]);
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-rpc-mutant-"));
	try {
		const path = join(scratch, "rpc-jsonl.ts");
		writeFileSync(path, source.replace(anchor, "bytes[i] !== 0xe2"));
		const { BoundedRpcJsonl: Mutant } = await import(pathToFileURL(path).href);
		const records: Record<string, unknown>[] = [];
		const mutant = new Mutant((record: Record<string, unknown>) => records.push(record));
		assert.equal(mutant.push(wire), "invalid");
		assert.deepEqual(records, []);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("consumer rejection is an invalid transport, never an exception to leak child data", () => {
	const stream = new BoundedRpcJsonl(() => {
		throw Error("private child content");
	});
	assert.equal(stream.push(Buffer.from('{"type":"event"}\n')), "invalid");
	assert.equal(stream.finish(), "invalid");
});

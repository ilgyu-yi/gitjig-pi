import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { buildPin, digestRecord, encodePin, type PinV1, parsePin } from "../.pi/extensions/gitjig/install/pin.ts";

const source = { provider: "github" as const, host: "github.com" as const, owner: "Owner", repository: "Repo" };
const revision = "0123456789abcdef0123456789abcdef01234567";

describe("#250 pin-v1 closed codec and digest grammar", () => {
	it("reproduces independently fixed member, record, and aggregate vectors", () => {
		const pin = buildPin(source, revision, [
			{ path: ".githooks/a", class: "handed-over", bytes: Buffer.from("abc") },
			{ path: ".pi/prompts/b.md", class: "carried", bytes: Buffer.from("") },
		]);
		assert.equal(pin.manifest[0]?.digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		assert.equal(pin.manifest[1]?.digest, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		const first = pin.manifest[0];
		assert.ok(first);
		assert.equal(
			digestRecord(first).toString("hex"),
			"480000000b2e676974686f6f6b732f610000000000000003ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		assert.equal(pin.payloadDigest, "222f51663a59d0e90532af6c7cbe4a76388d2c065b81e88daffe98e4a7f1a996");
		assert.equal(pin.carriedDigest, "4bab2630baa4ed206e7671ee41a231c32caa178e77078a24de32aa7cca99566c");
	});

	it("round-trips max uint64 and rejects every noncanonical numeric boundary", () => {
		const entry = {
			path: ".githooks/a",
			class: "handed-over" as const,
			size: (1n << 64n) - 1n,
			digest: "00".repeat(32),
		};
		const pin: PinV1 = {
			schemaVersion: 1,
			source,
			revision,
			digest: "sha256-v1",
			manifest: [entry],
			payloadDigest: createHash("sha256").update(digestRecord(entry)).digest("hex"),
			carriedDigest: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
		};
		const text = encodePin(pin);
		assert.deepEqual(parsePin(text), pin);
		for (const spelling of ["18446744073709551616", "-1", "1.0", "1e1", "01"])
			assert.throws(() => parsePin(text.replace("18446744073709551615", spelling)), /size|noncanonical|invalid/);
	});

	it("rejects duplicate, unknown nested keys, and every closed field domain", () => {
		const empty = encodePin(buildPin(source, revision, []));
		assert.throws(
			() => parsePin(empty.replace('{"schemaVersion":1', '{"schemaVersion":1,"schemaVersion":1')),
			/duplicate/,
		);
		assert.throws(() => parsePin(empty.replace('"digest":"sha256-v1"', '"extra":true,"digest":"sha256-v1"')), /keys/);
		assert.throws(() => parsePin(empty.replace('"owner":"Owner"', '"extra":true,"owner":"Owner"')), /keys/);
		assert.throws(() => parsePin(empty.replace('"owner":"Owner"', '"owner":"Owner","owner":"Other"')), /duplicate/);
		assert.throws(() => parsePin(empty.replace('"schemaVersion":1', '"schemaVersion":2')), /version/);
		assert.throws(() => parsePin(empty.replace('"provider":"github"', '"provider":"gitlab"')), /source/);
		assert.throws(() => parsePin(empty.replace('"host":"github.com"', '"host":"example.com"')), /source/);
		assert.throws(() => parsePin(empty.replace('"Owner"', '"bad/name"')), /source/);
		assert.throws(() => parsePin(empty.replace('"Owner"', '"\\ud800"')), /source/);
		assert.throws(() => parsePin(empty.replace(revision, revision.toUpperCase())), /revision/);
		assert.throws(() => parsePin(empty.replace('"sha256-v1"', '"sha256-v2"')), /version/);
		const emptyPin = buildPin(source, revision, []);
		assert.throws(() => parsePin(empty.replace(emptyPin.payloadDigest, "0".repeat(64))), /aggregate/);
		assert.throws(
			() =>
				parsePin(empty.replace(`"carriedDigest":"${emptyPin.carriedDigest}"`, `"carriedDigest":"${"1".repeat(64)}"`)),
			/aggregate/,
		);
		const member = encodePin(
			buildPin(source, revision, [{ path: ".githooks/a", class: "handed-over", bytes: Buffer.from("a") }]),
		);
		assert.throws(() => parsePin(member.replace('"path":".githooks/a"', '"extra":true,"path":".githooks/a"')), /keys/);
		assert.throws(() => parsePin(member.replace('"handed-over"', '"unknown"')), /class/);
		assert.throws(() => parsePin(member.replace(/"digest":"[0-9a-f]{64}"/, '"digest":"A"')), /digest/);
	});

	it("hashes an empty carried projection as SHA-256 of empty bytes", () => {
		const pin = buildPin(source, revision, [{ path: ".githooks/a", class: "handed-over", bytes: Buffer.from("abc") }]);
		assert.equal(pin.carriedDigest, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPin, encodePin, parsePin } from "../.pi/extensions/gitjig/install/pin.ts";

const source = { provider: "github" as const, host: "github.com" as const, owner: "Owner", repository: "Repo" };
const revision = "0123456789abcdef0123456789abcdef01234567";

describe("#250 pin-v1 closed codec and digest grammar", () => {
	it("reproduces independently fixed member and aggregate vectors", () => {
		const pin = buildPin(source, revision, [
			{ path: ".githooks/a", class: "handed-over", bytes: Buffer.from("abc") },
			{ path: ".pi/prompts/b.md", class: "carried", bytes: Buffer.from("") },
		]);
		assert.equal(pin.manifest[0]?.digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		assert.equal(pin.manifest[1]?.digest, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		assert.equal(pin.payloadDigest, "222f51663a59d0e90532af6c7cbe4a76388d2c065b81e88daffe98e4a7f1a996");
		assert.equal(pin.carriedDigest, "4bab2630baa4ed206e7671ee41a231c32caa178e77078a24de32aa7cca99566c");
	});

	it("round-trips canonical uint64 sizes without host-number truncation", () => {
		const pin = buildPin(source, revision, []);
		const text = encodePin(pin);
		assert.deepEqual(parsePin(text), pin);
		const boundary = text
			.replace(
				'"manifest":[]',
				`"manifest":[{"path":".githooks/a","class":"handed-over","size":18446744073709551615,"digest":"${"00".repeat(32)}"}]`,
			)
			.replace(pin.payloadDigest, "00".repeat(32));
		assert.throws(() => parsePin(boundary), /digest|aggregate/);
	});

	it("rejects duplicate, unknown, noncanonical, and invalid identity fields", () => {
		const text = encodePin(buildPin(source, revision, []));
		assert.throws(
			() => parsePin(text.replace('{"schemaVersion":1', '{"schemaVersion":1,"schemaVersion":1')),
			/duplicate/,
		);
		assert.throws(() => parsePin(text.replace('"digest":"sha256-v1"', '"extra":true,"digest":"sha256-v1"')), /keys/);
		assert.throws(() => parsePin(text.replace('"Owner"', '"bad/name"')), /source/);
		assert.throws(() => parsePin(text.replace(revision, revision.toUpperCase())), /revision/);
	});

	it("hashes an empty carried projection as SHA-256 of empty bytes", () => {
		const pin = buildPin(source, revision, [{ path: ".githooks/a", class: "handed-over", bytes: Buffer.from("abc") }]);
		assert.equal(pin.carriedDigest, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});
});

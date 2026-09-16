/** Warning-surface roster: EXEMPT — codec refusals are fixed strings. */
import { createHash } from "node:crypto";
import { validateCandidatePath, validateUnicodeScalars } from "./classifier.ts";

export type PayloadClass = "handed-over" | "carried";
export interface PinSource {
	provider: "github";
	host: "github.com";
	owner: string;
	repository: string;
}
export interface PinEntry {
	path: string;
	class: PayloadClass;
	size: bigint;
	digest: string;
}
export interface PinV1 {
	schemaVersion: 1;
	source: PinSource;
	revision: string;
	digest: "sha256-v1";
	manifest: PinEntry[];
	payloadDigest: string;
	carriedDigest: string;
}
export interface PayloadInput {
	path: string;
	class: PayloadClass;
	bytes: Buffer;
}

type JsonValue = string | boolean | null | bigint | JsonValue[] | { [key: string]: JsonValue };
const HEX64 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT32_MAX = 0xffff_ffff;

export class PinRefusal extends Error {
	constructor(cause: string) {
		super(`pin refused: ${cause}`);
	}
}
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

class JsonReader {
	private at = 0;
	private readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
	parse(): JsonValue {
		const value = this.value();
		this.ws();
		if (this.at !== this.text.length) this.fail("trailing JSON");
		return value;
	}
	private fail(cause: string): never {
		throw new PinRefusal(cause);
	}
	private ws(): void {
		while (this.at < this.text.length && "\t\n\r ".includes(this.text[this.at] ?? "")) this.at++;
	}
	private value(): JsonValue {
		this.ws();
		const c = this.text[this.at];
		if (c === '"') return this.string();
		if (c === "{") return this.object();
		if (c === "[") return this.array();
		for (const [word, value] of [
			["true", true],
			["false", false],
			["null", null],
		] as const)
			if (this.text.startsWith(word, this.at)) {
				this.at += word.length;
				return value;
			}
		const match = /^(0|[1-9][0-9]*)/.exec(this.text.slice(this.at));
		if (match) {
			this.at += match[0].length;
			return BigInt(match[0]);
		}
		this.fail("invalid or noncanonical JSON value");
	}
	private string(): string {
		const start = this.at++;
		let escaped = false;
		while (this.at < this.text.length) {
			const c = this.text[this.at++];
			if (!escaped && c === '"') {
				try {
					return JSON.parse(this.text.slice(start, this.at)) as string;
				} catch {
					this.fail("invalid JSON string");
				}
			}
			if (!escaped && c === "\\") escaped = true;
			else escaped = false;
		}
		this.fail("unterminated JSON string");
	}
	private object(): { [key: string]: JsonValue } {
		this.at++;
		this.ws();
		const out: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
		if (this.text[this.at] === "}") {
			this.at++;
			return out;
		}
		for (;;) {
			this.ws();
			if (this.text[this.at] !== '"') this.fail("object key is not a string");
			const key = this.string();
			if (Object.hasOwn(out, key)) this.fail("duplicate object key");
			this.ws();
			if (this.text[this.at++] !== ":") this.fail("missing object colon");
			out[key] = this.value();
			this.ws();
			const next = this.text[this.at++];
			if (next === "}") return out;
			if (next !== ",") this.fail("invalid object separator");
		}
	}
	private array(): JsonValue[] {
		this.at++;
		this.ws();
		const out: JsonValue[] = [];
		if (this.text[this.at] === "]") {
			this.at++;
			return out;
		}
		for (;;) {
			out.push(this.value());
			this.ws();
			const next = this.text[this.at++];
			if (next === "]") return out;
			if (next !== ",") this.fail("invalid array separator");
		}
	}
}

function object(value: JsonValue, keys: readonly string[], name: string): { [key: string]: JsonValue } {
	if (value === null || Array.isArray(value) || typeof value !== "object")
		throw new PinRefusal(`${name} is not an object`);
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i]))
		throw new PinRefusal(`${name} has invalid keys`);
	return value;
}
function string(value: JsonValue, name: string): string {
	if (typeof value !== "string") throw new PinRefusal(`${name} is not a string`);
	return value;
}
function validName(value: string): boolean {
	try {
		validateUnicodeScalars(value);
	} catch {
		return false;
	}
	return (
		value.length > 0 &&
		value === value.normalize("NFC") &&
		!value.includes("/") &&
		!value.includes("%") &&
		![...value].some((character) => {
			const point = character.codePointAt(0) ?? 0;
			return point <= 0x1f || point === 0x7f;
		})
	);
}
function required(record: { [key: string]: JsonValue }, key: string): JsonValue {
	const value = record[key];
	if (value === undefined) throw new PinRefusal(`${key} is absent`);
	return value;
}
function sourceEqual(a: PinSource, b: PinSource): boolean {
	return a.provider === b.provider && a.host === b.host && a.owner === b.owner && a.repository === b.repository;
}
export { sourceEqual };

export function digestRecord(entry: PinEntry): Buffer {
	const path = Buffer.from(entry.path, "utf8");
	if (path.length > UINT32_MAX || entry.size < 0n || entry.size > UINT64_MAX || !HEX64.test(entry.digest))
		throw new PinRefusal("manifest record is out of domain");
	const record = Buffer.alloc(1 + 4 + path.length + 8 + 32);
	record[0] = entry.class === "handed-over" ? 0x48 : 0x43;
	record.writeUInt32BE(path.length, 1);
	path.copy(record, 5);
	record.writeBigUInt64BE(entry.size, 5 + path.length);
	Buffer.from(entry.digest, "hex").copy(record, 13 + path.length);
	return record;
}
function aggregate(manifest: readonly PinEntry[], carriedOnly: boolean): string {
	return hash(Buffer.concat(manifest.filter((entry) => !carriedOnly || entry.class === "carried").map(digestRecord)));
}

function validateSource(value: JsonValue): PinSource {
	const src = object(value, ["provider", "host", "owner", "repository"], "source");
	const owner = string(required(src, "owner"), "source owner");
	const repository = string(required(src, "repository"), "source repository");
	if (src.provider !== "github" || src.host !== "github.com" || !validName(owner) || !validName(repository))
		throw new PinRefusal("source identity is invalid");
	return { provider: "github", host: "github.com", owner, repository };
}
function validateEntry(value: JsonValue): PinEntry {
	const raw = object(value, ["path", "class", "size", "digest"], "manifest entry");
	const path = string(required(raw, "path"), "manifest path");
	validateCandidatePath(path);
	const cls = raw.class;
	if (cls !== "handed-over" && cls !== "carried") throw new PinRefusal("manifest class is invalid");
	if (typeof raw.size !== "bigint" || raw.size < 0n || raw.size > UINT64_MAX)
		throw new PinRefusal("manifest size is invalid");
	const digest = string(required(raw, "digest"), "manifest digest");
	if (!HEX64.test(digest)) throw new PinRefusal("manifest digest is invalid");
	return { path, class: cls, size: raw.size, digest };
}
function validateManifest(value: JsonValue): PinEntry[] {
	if (!Array.isArray(value)) throw new PinRefusal("manifest is not an array");
	const entries = value.map(validateEntry);
	for (let i = 1; i < entries.length; i++) {
		const previous = entries.at(i - 1);
		const current = entries.at(i);
		if (!previous || !current || Buffer.compare(Buffer.from(previous.path), Buffer.from(current.path)) >= 0)
			throw new PinRefusal("manifest is not uniquely path-sorted");
	}
	return entries;
}

export function parsePin(text: string): PinV1 {
	const raw = object(
		new JsonReader(text).parse(),
		["schemaVersion", "source", "revision", "digest", "manifest", "payloadDigest", "carriedDigest"],
		"pin",
	);
	if (raw.schemaVersion !== 1n || raw.digest !== "sha256-v1")
		throw new PinRefusal("schema or digest version is invalid");
	const revision = string(required(raw, "revision"), "revision");
	if (!REVISION.test(revision)) throw new PinRefusal("revision is invalid");
	const manifest = validateManifest(required(raw, "manifest"));
	const payloadDigest = string(required(raw, "payloadDigest"), "payload digest");
	const carriedDigest = string(required(raw, "carriedDigest"), "carried digest");
	if (
		!HEX64.test(payloadDigest) ||
		!HEX64.test(carriedDigest) ||
		payloadDigest !== aggregate(manifest, false) ||
		carriedDigest !== aggregate(manifest, true)
	)
		throw new PinRefusal("aggregate digest is invalid");
	return {
		schemaVersion: 1,
		source: validateSource(required(raw, "source")),
		revision,
		digest: "sha256-v1",
		manifest,
		payloadDigest,
		carriedDigest,
	};
}

export function buildPin(source: PinSource, revision: string, inputs: readonly PayloadInput[]): PinV1 {
	validateSource(source as unknown as JsonValue);
	if (!REVISION.test(revision)) throw new PinRefusal("revision is invalid");
	const manifest = inputs
		.map((input) => {
			validateCandidatePath(input.path);
			if (input.class !== "handed-over" && input.class !== "carried") throw new PinRefusal("manifest class is invalid");
			return { path: input.path, class: input.class, size: BigInt(input.bytes.length), digest: hash(input.bytes) };
		})
		.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
	for (let i = 1; i < manifest.length; i++)
		if (manifest.at(i - 1)?.path === manifest.at(i)?.path) throw new PinRefusal("manifest path is duplicated");
	return {
		schemaVersion: 1,
		source,
		revision,
		digest: "sha256-v1",
		manifest,
		payloadDigest: aggregate(manifest, false),
		carriedDigest: aggregate(manifest, true),
	};
}

function quote(value: string): string {
	return JSON.stringify(value);
}
export function encodePin(pin: PinV1): string {
	const checked = parsePin(
		`{"schemaVersion":1,"source":{"provider":${quote(pin.source.provider)},"host":${quote(pin.source.host)},"owner":${quote(pin.source.owner)},"repository":${quote(pin.source.repository)}},"revision":${quote(pin.revision)},"digest":"sha256-v1","manifest":[${pin.manifest.map((entry) => `{"path":${quote(entry.path)},"class":${quote(entry.class)},"size":${entry.size.toString()},"digest":${quote(entry.digest)}}`).join(",")}],"payloadDigest":${quote(pin.payloadDigest)},"carriedDigest":${quote(pin.carriedDigest)}}`,
	);
	return `{"schemaVersion":1,"source":{"provider":"github","host":"github.com","owner":${quote(checked.source.owner)},"repository":${quote(checked.source.repository)}},"revision":${quote(checked.revision)},"digest":"sha256-v1","manifest":[${checked.manifest.map((entry) => `{"path":${quote(entry.path)},"class":${quote(entry.class)},"size":${entry.size.toString()},"digest":${quote(entry.digest)}}`).join(",")}],"payloadDigest":${quote(checked.payloadDigest)},"carriedDigest":${quote(checked.carriedDigest)}}\n`;
}

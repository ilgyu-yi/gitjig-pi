/**
 * Closed machine-record admission and byte serializer.
 * Warning-surface roster: EXEMPT — this module returns protocol bytes and fixed admission causes; it emits no operator warning or diagnostic surface.
 */
import { Buffer } from "node:buffer";
import { types } from "node:util";

const MAX_BODY_BYTES = 65_536;
const MAX_MARKER_BYTES = 256;
const MARKER =
	/^<!-- [a-z][a-z0-9]*(?:-[a-z0-9]+)*: v(?:[1-9][0-9]{0,8})(?: [a-z][a-zA-Z0-9]*=[A-Za-z0-9][A-Za-z0-9._:-]{0,127})* -->$/;
const CLOSING = new Set(["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]);
const CF = /\p{Cf}/u;
const INDEX = /^(?:0|[1-9][0-9]*)$/;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface MachineRecordInput {
	marker: string;
	value: JsonValue;
}
export interface AdmittedMachineRecord {
	marker: string;
	value: JsonValue;
	canonicalJson: string;
	semanticBody: string;
	wireBody: string;
	semanticStrings: string[];
}
export type MachineAdmission = { ok: true; record: AdmittedMachineRecord } | { ok: false; cause: string };

function ownDataRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value)) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	if (Object.getOwnPropertySymbols(value).length !== 0) return false;
	for (const key in value) if (!Object.hasOwn(value, key)) return false;
	const own = Object.getOwnPropertyNames(value);
	if (own.length !== keys.length || own.some((key) => !keys.includes(key))) return false;
	return own.every((key) => {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return (
			descriptor !== undefined &&
			"value" in descriptor &&
			descriptor.enumerable &&
			descriptor.configurable &&
			descriptor.writable
		);
	});
}

export function isClosedDataRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	try {
		return ownDataRecord(value, keys);
	} catch {
		return false;
	}
}

function scalarString(value: string): boolean {
	if (value.includes("\0") || CF.test(value)) return false;
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const low = value.charCodeAt(++i);
			if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
		} else if (code >= 0xdc00 && code <= 0xdfff) return false;
	}
	return true;
}

function compareScalars(left: string, right: string): number {
	const a = Array.from(left, (char) => char.codePointAt(0) as number);
	const b = Array.from(right, (char) => char.codePointAt(0) as number);
	for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return a.length - b.length;
}

function quote(value: string, wire: boolean): string {
	let out = '"';
	for (const char of value) {
		const code = char.codePointAt(0) as number;
		if (char === '"') out += '\\"';
		else if (char === "\\") out += "\\\\";
		else if (wire && code === 0x40) out += "\\u0040";
		else if (wire && code === 0x23) out += "\\u0023";
		else if (wire && code === 0x2d) out += "\\u002d";
		else if (wire && code === 0x3a) out += "\\u003a";
		else if (wire && code === 0x2f) out += "\\u002f";
		else if (code <= 0x1f) out += `\\u${code.toString(16).padStart(4, "0")}`;
		else out += char;
	}
	return `${out}"`;
}

function serialize(value: JsonValue, wire: boolean): string {
	type Token = { kind: "value"; value: JsonValue } | { kind: "text"; text: string };
	const output: string[] = [];
	const stack: Token[] = [{ kind: "value", value }];
	while (stack.length > 0) {
		const token = stack.pop() as Token;
		if (token.kind === "text") {
			output.push(token.text);
			continue;
		}
		const current = token.value;
		if (current === null) output.push("null");
		else if (typeof current === "boolean") output.push(current ? "true" : "false");
		else if (typeof current === "number") output.push(String(current));
		else if (typeof current === "string") output.push(quote(current, wire));
		else if (Array.isArray(current)) {
			output.push("[");
			stack.push({ kind: "text", text: "]" });
			for (let index = current.length - 1; index >= 0; index -= 1) {
				stack.push({ kind: "value", value: current[index] });
				if (index > 0) stack.push({ kind: "text", text: "," });
			}
		} else {
			output.push("{");
			stack.push({ kind: "text", text: "}" });
			const keys = Object.keys(current).sort(compareScalars);
			for (let index = keys.length - 1; index >= 0; index -= 1) {
				const key = keys[index];
				stack.push({ kind: "value", value: current[key] });
				stack.push({ kind: "text", text: ":" });
				stack.push({ kind: "text", text: quote(key, wire) });
				if (index > 0) stack.push({ kind: "text", text: "," });
			}
		}
	}
	return output.join("");
}

type CopyFrame = {
	input: object;
	output: JsonValue[] | Record<string, JsonValue>;
	entries: Array<{ key: string; value: unknown; array: boolean }>;
	index: number;
};

function copyJson(value: unknown, strings: string[]): { ok: true; value: JsonValue } | { ok: false } {
	const seen = new WeakSet<object>();
	const inspect = (input: unknown): { ok: true; value: JsonValue; frame?: CopyFrame } | { ok: false } => {
		if (input === null || typeof input === "boolean") return { ok: true, value: input };
		if (typeof input === "number")
			return Number.isSafeInteger(input) && !Object.is(input, -0) ? { ok: true, value: input } : { ok: false };
		if (typeof input === "string") {
			if (!scalarString(input)) return { ok: false };
			strings.push(input);
			return { ok: true, value: input };
		}
		if (typeof input !== "object" || types.isProxy(input) || seen.has(input)) return { ok: false };
		seen.add(input);
		if (Array.isArray(input)) {
			if (Object.getPrototypeOf(input) !== Array.prototype || Object.getOwnPropertySymbols(input).length !== 0)
				return { ok: false };
			for (const key in input) if (!Object.hasOwn(input, key)) return { ok: false };
			const length = Object.getOwnPropertyDescriptor(input, "length");
			if (!length || !("value" in length) || length.enumerable || length.configurable || !length.writable)
				return { ok: false };
			const names = Object.getOwnPropertyNames(input);
			if (names.length !== input.length + 1 || !names.includes("length")) return { ok: false };
			const entries: CopyFrame["entries"] = [];
			for (let index = 0; index < input.length; index += 1) {
				const key = String(index),
					descriptor = Object.getOwnPropertyDescriptor(input, key);
				if (
					!INDEX.test(key) ||
					!descriptor ||
					!("value" in descriptor) ||
					!descriptor.enumerable ||
					!descriptor.configurable ||
					!descriptor.writable
				)
					return { ok: false };
				entries.push({ key, value: descriptor.value, array: true });
			}
			const output: JsonValue[] = [];
			return { ok: true, value: output, frame: { input, output, entries, index: 0 } };
		}
		const proto = Object.getPrototypeOf(input);
		if ((proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(input).length !== 0)
			return { ok: false };
		for (const key in input) if (!Object.hasOwn(input, key)) return { ok: false };
		const entries: CopyFrame["entries"] = [];
		for (const key of Object.getOwnPropertyNames(input).sort(compareScalars)) {
			const descriptor = Object.getOwnPropertyDescriptor(input, key);
			if (
				!scalarString(key) ||
				!descriptor ||
				!("value" in descriptor) ||
				!descriptor.enumerable ||
				!descriptor.configurable ||
				!descriptor.writable
			)
				return { ok: false };
			entries.push({ key, value: descriptor.value, array: false });
		}
		const output: Record<string, JsonValue> = Object.create(null);
		return { ok: true, value: output, frame: { input, output, entries, index: 0 } };
	};
	const root = inspect(value);
	if (!root.ok) return root;
	if (!root.frame) return { ok: true, value: root.value };
	const stack: CopyFrame[] = [root.frame];
	while (stack.length > 0) {
		const frame = stack[stack.length - 1];
		if (frame.index >= frame.entries.length) {
			stack.pop();
			continue;
		}
		const entry = frame.entries[frame.index++];
		if (!entry.array) strings.push(entry.key);
		const child = inspect(entry.value);
		if (!child.ok) return child;
		if (entry.array) (frame.output as JsonValue[]).push(child.value);
		else (frame.output as Record<string, JsonValue>)[entry.key] = child.value;
		if (child.frame) stack.push(child.frame);
	}
	return { ok: true, value: root.value };
}

function validMarker(marker: unknown): marker is string {
	if (typeof marker !== "string" || Buffer.byteLength(marker, "utf8") > MAX_MARKER_BYTES || !MARKER.test(marker))
		return false;
	const fields = marker.slice(5, -4).split(" ").slice(2);
	const names = fields.map((field) => field.slice(0, field.indexOf("=")));
	if (new Set(names).size !== names.length || [...names].sort(compareScalars).join("\0") !== names.join("\0"))
		return false;
	return !marker.split(/[^A-Za-z]+/).some((part) => CLOSING.has(part.toLowerCase()));
}

export function admitMachineRecord(value: unknown): MachineAdmission {
	if (!isClosedDataRecord(value, ["marker", "value"]))
		return { ok: false, cause: "machine record shape is not admissible" };
	const marker = Object.getOwnPropertyDescriptor(value, "marker")?.value;
	const raw = Object.getOwnPropertyDescriptor(value, "value")?.value;
	if (!validMarker(marker)) return { ok: false, cause: "machine record marker is not admissible" };
	const strings: string[] = [];
	const copied = copyJson(raw, strings);
	if (!copied.ok) return { ok: false, cause: "machine record value is not admissible" };
	const canonicalText = serialize(copied.value, false);
	const wireJson = serialize(copied.value, true);
	const semanticBody = `${marker}\n${canonicalText}`;
	const wireBody = `${marker}\n${wireJson}`;
	if (
		Buffer.byteLength(semanticBody, "utf8") > MAX_BODY_BYTES ||
		Buffer.byteLength(wireBody, "utf8") > MAX_BODY_BYTES
	) {
		return { ok: false, cause: "machine record body exceeds its byte bound" };
	}
	try {
		if (canonicalJson(JSON.parse(wireJson) as JsonValue) !== canonicalJson(copied.value))
			return { ok: false, cause: "machine record codec failed" };
	} catch {
		return { ok: false, cause: "machine record codec failed" };
	}
	return {
		ok: true,
		record: {
			marker,
			value: copied.value,
			canonicalJson: canonicalText,
			semanticBody,
			wireBody,
			semanticStrings: strings,
		},
	};
}

export function decodeEscapeView(value: string): { ok: true; value: string } | { ok: false } {
	let out = "";
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] !== "\\") {
			out += value[index];
			continue;
		}
		if (value[index + 1] !== "u" || !/^[0-9a-fA-F]{4}$/.test(value.slice(index + 2, index + 6))) return { ok: false };
		const first = Number.parseInt(value.slice(index + 2, index + 6), 16);
		index += 5;
		if (first >= 0xd800 && first <= 0xdbff) {
			if (value.slice(index + 1, index + 3) !== "\\u" || !/^[0-9a-fA-F]{4}$/.test(value.slice(index + 3, index + 7)))
				return { ok: false };
			const second = Number.parseInt(value.slice(index + 3, index + 7), 16);
			if (second < 0xdc00 || second > 0xdfff) return { ok: false };
			out += String.fromCodePoint(0x10000 + ((first - 0xd800) << 10) + second - 0xdc00);
			index += 6;
		} else if (first >= 0xdc00 && first <= 0xdfff) return { ok: false };
		else out += String.fromCodePoint(first);
	}
	if (!scalarString(out) || Buffer.byteLength(out, "utf8") > MAX_BODY_BYTES) return { ok: false };
	return { ok: true, value: out };
}

export function decodeWireBody(body: string, marker: string): JsonValue | undefined {
	if (!body.startsWith(`${marker}\n`) || body.endsWith("\n")) return undefined;
	try {
		return JSON.parse(body.slice(marker.length + 1)) as JsonValue;
	} catch {
		return undefined;
	}
}

export function canonicalJson(value: JsonValue): string {
	return serialize(value, false);
}

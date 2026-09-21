/**
 * Closed machine-record admission and byte serializer.
 * Warning-surface roster: EXEMPT — this module returns protocol bytes and fixed admission causes; it emits no operator warning or diagnostic surface.
 */
import { Buffer } from "node:buffer";

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
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
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
	return ownDataRecord(value, keys);
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
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return String(value);
	if (typeof value === "string") return quote(value, wire);
	if (Array.isArray(value)) return `[${value.map((item) => serialize(item, wire)).join(",")}]`;
	const keys = Object.keys(value).sort(compareScalars);
	return `{${keys.map((key) => `${quote(key, wire)}:${serialize(value[key], wire)}`).join(",")}}`;
}

function copyJson(
	value: unknown,
	seen: WeakSet<object>,
	strings: string[],
): { ok: true; value: JsonValue } | { ok: false } {
	if (value === null || typeof value === "boolean") return { ok: true, value };
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && !Object.is(value, -0) ? { ok: true, value } : { ok: false };
	}
	if (typeof value === "string") {
		if (!scalarString(value)) return { ok: false };
		strings.push(value);
		return { ok: true, value };
	}
	if (typeof value !== "object") return { ok: false };
	if (seen.has(value)) return { ok: false };
	seen.add(value);
	if (Array.isArray(value)) {
		if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0)
			return { ok: false };
		for (const key in value) if (!Object.hasOwn(value, key)) return { ok: false };
		const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
		if (
			!lengthDescriptor ||
			!("value" in lengthDescriptor) ||
			lengthDescriptor.enumerable ||
			lengthDescriptor.configurable ||
			lengthDescriptor.writable !== true
		)
			return { ok: false };
		const names = Object.getOwnPropertyNames(value);
		if (names.length !== value.length + 1 || !names.includes("length")) return { ok: false };
		const result: JsonValue[] = [];
		for (let index = 0; index < value.length; index += 1) {
			const name = String(index);
			if (!INDEX.test(name) || !Object.hasOwn(value, name)) return { ok: false };
			const descriptor = Object.getOwnPropertyDescriptor(value, name);
			if (
				!descriptor ||
				!("value" in descriptor) ||
				!descriptor.enumerable ||
				!descriptor.configurable ||
				!descriptor.writable
			)
				return { ok: false };
			const child = copyJson(descriptor.value, seen, strings);
			if (!child.ok) return child;
			result.push(child.value);
		}
		return { ok: true, value: result };
	}
	const proto = Object.getPrototypeOf(value);
	if ((proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(value).length !== 0)
		return { ok: false };
	for (const key in value) if (!Object.hasOwn(value, key)) return { ok: false };
	const names = Object.getOwnPropertyNames(value).sort(compareScalars);
	const result: Record<string, JsonValue> = Object.create(null);
	for (const name of names) {
		if (!scalarString(name)) return { ok: false };
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		if (
			!descriptor ||
			!("value" in descriptor) ||
			!descriptor.enumerable ||
			!descriptor.configurable ||
			!descriptor.writable
		)
			return { ok: false };
		strings.push(name);
		const child = copyJson(descriptor.value, seen, strings);
		if (!child.ok) return child;
		result[name] = child.value;
	}
	return { ok: true, value: result };
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
	if (!ownDataRecord(value, ["marker", "value"])) return { ok: false, cause: "machine record shape is not admissible" };
	const marker = Object.getOwnPropertyDescriptor(value, "marker")?.value;
	const raw = Object.getOwnPropertyDescriptor(value, "value")?.value;
	if (!validMarker(marker)) return { ok: false, cause: "machine record marker is not admissible" };
	const strings: string[] = [];
	const copied = copyJson(raw, new WeakSet(), strings);
	if (!copied.ok) return { ok: false, cause: "machine record value is not admissible" };
	const canonicalJson = serialize(copied.value, false);
	const wireJson = serialize(copied.value, true);
	const semanticBody = `${marker}\n${canonicalJson}`;
	const wireBody = `${marker}\n${wireJson}`;
	if (
		Buffer.byteLength(semanticBody, "utf8") > MAX_BODY_BYTES ||
		Buffer.byteLength(wireBody, "utf8") > MAX_BODY_BYTES
	) {
		return { ok: false, cause: "machine record body exceeds its byte bound" };
	}
	try {
		if (JSON.stringify(JSON.parse(wireJson)) !== JSON.stringify(copied.value))
			return { ok: false, cause: "machine record codec failed" };
	} catch {
		return { ok: false, cause: "machine record codec failed" };
	}
	return {
		ok: true,
		record: { marker, value: copied.value, canonicalJson, semanticBody, wireBody, semanticStrings: strings },
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

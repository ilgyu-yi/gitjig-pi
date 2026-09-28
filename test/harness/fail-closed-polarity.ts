import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface PolarityOwner {
	source: string;
	owner: string;
}

export interface RefusalOccurrence {
	source: string;
	offset: number;
}

export const REFUSAL_LITERAL = "return { ok: false, arm:";

function filesUnder(root: string, directory: string): string[] {
	const absolute = join(root, directory);
	return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
		const path = join(absolute, entry.name);
		if (entry.isDirectory()) return filesUnder(root, relative(root, path));
		return entry.isFile() && /\.(?:mjs|ts)$/.test(entry.name) ? [relative(root, path)] : [];
	});
}

export function refusalOccurrences(root: string): RefusalOccurrence[] {
	const files = [...filesUnder(root, ".github"), ...filesUnder(root, ".pi/extensions")];
	return files.flatMap((source) => {
		const text = readFileSync(join(root, source), "utf8");
		const occurrences: RefusalOccurrence[] = [];
		for (
			let offset = text.indexOf(REFUSAL_LITERAL);
			offset !== -1;
			offset = text.indexOf(REFUSAL_LITERAL, offset + 1)
		) {
			occurrences.push({ source, offset });
		}
		return occurrences;
	});
}

export function validatePolarityOwners(
	occurrences: readonly RefusalOccurrence[],
	owners: readonly PolarityOwner[],
): void {
	const ownerCounts = new Map<string, number>();
	for (const owner of owners) ownerCounts.set(owner.source, (ownerCounts.get(owner.source) ?? 0) + 1);
	for (const [source, count] of ownerCounts) {
		if (count !== 1) throw new Error(`duplicate polarity owner: ${source}`);
	}
	const sources = new Set(occurrences.map(({ source }) => source));
	for (const source of sources) {
		if (!ownerCounts.has(source)) throw new Error(`unowned refusal occurrence: ${source}`);
	}
	for (const source of ownerCounts.keys()) {
		if (!sources.has(source)) throw new Error(`owner has no refusal occurrence: ${source}`);
	}
}

export function flipRefusalPolarity(source: string, occurrence: RefusalOccurrence): string {
	if (source.slice(occurrence.offset, occurrence.offset + REFUSAL_LITERAL.length) !== REFUSAL_LITERAL)
		throw new Error("refusal occurrence drifted");
	return `${source.slice(0, occurrence.offset)}return { ok: true, arm:${source.slice(occurrence.offset + REFUSAL_LITERAL.length)}`;
}

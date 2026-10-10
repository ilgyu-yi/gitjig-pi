import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(new URL(`../.pi/extensions/gitjig/${path}`, import.meta.url), "utf8");
const SOURCES = {
	interval: read("review/interval.ts"),
	history: read("review/history.ts"),
	caller: read("commands/review-round.ts"),
	coordinator: read("recovery/coordinator.ts"),
	briefs: read("recovery/briefs.ts"),
};
type Sources = typeof SOURCES;

/**
 * #437's high-cost guards (§3.12): an incomplete walk withholds and never
 * marks, a merge on the chain makes the pair a marker rather than a delta,
 * and neither consumer admits NONE over a basis containing a marker. Each
 * pin below is owned by one weakening in the mutant list, except the
 * chain's own read failure: breaking to the completing walk there is
 * equivalent, because that walk rereads the same commit and fails the same
 * way (missing, malformed, capped or past the deadline), so it is pinned
 * for its line but owes no weakening (§3.12).
 *
 * A behavioural sweep applied every weakening below to the source and ran the
 * real-Git arms; each is killed there too, save three recorded as decisions:
 * - the self-parent refusal is unreachable, since a commit's name hashes its
 *   own parent lines;
 * - `!failed && ready()` admits only a response already buffered before the
 *   failure, read within the bounds, and every later read refuses on `failed`;
 * - the stderr kill: a corrupt commit prints errors and answers `missing` on
 *   stdout, which the header check refuses, so it is equivalent there;
 * - the completing loop's own deadline check is redundant while the visited
 *   set holds, since every iteration then makes a real read the timer can
 *   interrupt; it guards the cached path the visited set's weakening opens,
 *   and the diamond arm kills that weakening through it.
 */
function guardsHold({ interval, history, caller, coordinator, briefs }: Sources): boolean {
	return (
		interval.includes('return "kind" in interval && interval.kind === "rewrite-marker";') &&
		interval.includes("\t\t\tif (parents === undefined) return undefined;\n\t\t\tif (parents.length !== 1) break;") &&
		interval.includes("\t\t\tif (parents === undefined) return undefined;\n\t\t\t// First parent popped first") &&
		interval.includes("pending.push(...parents.toReversed());") &&
		interval.includes('const end = raw.indexOf(Buffer.from("\\n\\n"));\n\tif (end < 0) return undefined;') &&
		interval.includes("\t\tif (parents.includes(parent)) return undefined;") &&
		interval.includes("\t\t\treturn undefined;\n\t}\n\treturn parents;") &&
		interval.includes("if (parents === undefined || parents.includes(oid)) return undefined;") &&
		interval.includes("return !failed && ready();") &&
		interval.includes("const header = /^([0-9a-f]{40}) commit (\\d+)$/.exec(") &&
		interval.includes("\t\t\tif (seen.has(oid)) continue;\n\t\t\tseen.add(oid);") &&
		interval.includes("if (failed || Date.now() >= budget.deadline) return undefined;") &&
		interval.includes(
			'if (cursor === earlier) return (await parentsOf(earlier)) === undefined ? undefined : "linear";',
		) &&
		interval.includes("const timer = setTimeout(fail, timeout);") &&
		interval.includes("if (budget.bytes > BYTE_CAP) return fail();") &&
		interval.includes('child.stderr.on("data", fail);') &&
		interval.includes("if (shape === undefined) return undefined;") &&
		interval.includes(
			"if (earlierHead === laterHead || !OID.test(earlierHead) || !OID.test(laterHead)) return undefined;",
		) &&
		interval.includes('if (shape === "rewrite") return { kind: "rewrite-marker", earlierHead, laterHead };') &&
		history.includes("return basis.intervals.some(isRewriteMarker);") &&
		history.includes('if (admitted.available && admitted.diagnosis.value === "NONE" && hasRewriteMarker(basis))') &&
		history.includes("...(hasRewriteMarker(basis) ? REWRITE_MARKER_RULE : []),") &&
		caller.includes("const admitted = admitBasisDiagnosis(\n\t\t\t\tbasis,") &&
		!caller.includes("admitDiagnosis(") &&
		coordinator.includes(
			'decodedDiagnosis?.value === "NONE" && hasRewriteMarker(input.basis) ? undefined : decodedDiagnosis;',
		) &&
		coordinator.includes("const freshDiagnosis = retainWithinRouteBudget(\n\t\t\t\tparsedDiagnosis,") &&
		briefs.includes("hasRewriteMarker(basis) ? REWRITE_MARKER_RULE : [],")
	);
}

describe("issue #437 rewrite-marker guards", () => {
	it("pins the walk, the marker decision and both NONE refusals", () => {
		assert.equal(guardsHold(SOURCES), true);
	});

	it("kills one weakening of every high-cost guard", () => {
		const mutants: [keyof Sources, string, string][] = [
			["interval", 'return "kind" in interval && interval.kind === "rewrite-marker";', "return false;"],
			["interval", "if (parents.length !== 1) break;", "if (parents.length === 0) break;"],
			[
				"interval",
				"\t\t\tif (parents === undefined) return undefined;\n\t\t\t// First parent popped first",
				'\t\t\tif (parents === undefined) return "rewrite";\n\t\t\t// First parent popped first',
			],
			["interval", "pending.push(...parents.toReversed());", "pending.push(...parents);"],
			[
				"interval",
				'const end = raw.indexOf(Buffer.from("\\n\\n"));\n\tif (end < 0) return undefined;',
				'const end = raw.indexOf(Buffer.from("\\n\\n"));\n\tif (end < 0) return [];',
			],
			["interval", "\t\tif (parents.includes(parent)) return undefined;", ""],
			["interval", "\t\t\treturn undefined;\n\t}\n\treturn parents;", "\t\t\tcontinue;\n\t}\n\treturn parents;"],
			["interval", "parents === undefined || parents.includes(oid)", "parents === undefined"],
			["interval", "return !failed && ready();", "return ready();"],
			["interval", "\t\t\tif (seen.has(oid)) continue;\n", ""],
			["interval", "if (failed || Date.now() >= budget.deadline) return undefined;", ""],
			["interval", "commit (\\d+)$/.exec(", "(?:commit|blob) (\\d+)$/.exec("],
			["interval", '(await parentsOf(earlier)) === undefined ? undefined : "linear"', '"linear"'],
			["interval", "const timer = setTimeout(fail, timeout);", "const timer = undefined;"],
			["interval", "if (budget.bytes > BYTE_CAP) return fail();", ""],
			["interval", 'child.stderr.on("data", fail);', ""],
			[
				"interval",
				"if (shape === undefined) return undefined;",
				'if (shape === undefined) return { kind: "rewrite-marker", earlierHead, laterHead };',
			],
			["interval", 'if (shape === "rewrite") return', "if (false) return"],
			["interval", "|| !OID.test(earlierHead) ||", "||"],
			["history", "return basis.intervals.some(isRewriteMarker);", "return false;"],
			["history", 'admitted.diagnosis.value === "NONE" && hasRewriteMarker(basis)', "false"],
			["history", "...(hasRewriteMarker(basis) ? REWRITE_MARKER_RULE : []),", ""],
			["caller", "const admitted = admitBasisDiagnosis(\n\t\t\t\tbasis,", "const admitted = admitDiagnosis("],
			["coordinator", 'decodedDiagnosis?.value === "NONE" && hasRewriteMarker(input.basis)', "false"],
			[
				"coordinator",
				"retainWithinRouteBudget(\n\t\t\t\tparsedDiagnosis,",
				"retainWithinRouteBudget(\n\t\t\t\tdecodedDiagnosis,",
			],
			["briefs", "hasRewriteMarker(basis) ? REWRITE_MARKER_RULE : [],", "[],"],
		];
		for (const [index, [file, from, to]] of mutants.entries()) {
			assert.ok(SOURCES[file].includes(from), `mutant ${index} anchor is stale`);
			assert.equal(
				guardsHold({ ...SOURCES, [file]: SOURCES[file].replace(from, to) }),
				false,
				`mutant ${index} survived`,
			);
		}
	});
});

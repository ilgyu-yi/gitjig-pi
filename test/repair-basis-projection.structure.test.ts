import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const INTERVAL = readFileSync(new URL("../.pi/extensions/gitjig/review/interval.ts", import.meta.url), "utf8");
const HISTORY = readFileSync(new URL("../.pi/extensions/gitjig/review/history.ts", import.meta.url), "utf8");
const CALLER = readFileSync(new URL("../.pi/extensions/gitjig/commands/review-round.ts", import.meta.url), "utf8");

function contractHolds(interval: string, history: string, caller: string): boolean {
	return (
		interval.includes('GIT_NO_REPLACE_OBJECTS: "1"') &&
		interval.includes("const RUN_MS = 30_000") &&
		interval.includes("const BYTE_CAP = 16 * 1024 * 1024") &&
		interval.includes("const COMMIT_CAP = 100_000") &&
		interval.includes('["rev-parse", "--verify", "--end-of-options", `${oid}^{commit}`]') &&
		interval.includes('["cat-file", "commit", oid]') &&
		interval.includes('if (lines.length === 0 || !/^tree [0-9a-f]{40}$/.test(lines[0].toString("ascii")))') &&
		interval.includes('while (index < lines.length && lines[index].subarray(0, 7).equals(Buffer.from("parent ")))') &&
		interval.includes('["ls-tree", "-r", "-z", "--full-tree", "--end-of-options", earlierHead]') &&
		interval.includes('["cat-file", "blob", entry.oid]') &&
		interval.includes('["100644", "blob"]') &&
		interval.includes('["100755", "blob"]') &&
		interval.includes('["120000", "blob"]') &&
		interval.includes('["160000", "commit"]') &&
		!interval.includes("merge-base") &&
		!interval.includes("git diff") &&
		interval.includes("const budget: Budget = { deadline: Date.now() + RUN_MS, bytes: 0, commits: 0 }") &&
		interval.indexOf("const budget: Budget =") > interval.indexOf("for (const pair of pairs)") &&
		history.includes('while (start > 0 && history[start - 1].outcome === "repair")') &&
		history.includes('ruling.validity === "CONFIRMED"') &&
		history.includes('ruling.severity === "SUBSTANTIVE"') &&
		history.includes('disposition.disposition === "repair"') &&
		history.includes("!adjudication.dedupAttested ||") &&
		history.includes("record.bundle.length === 0 ||") &&
		history.includes("adjudication.rulings.length > record.bundle.length") &&
		history.includes("const slots = new Set(record.bundle.map") &&
		history.includes("const unattributedSlots = new Set(slots)") &&
		history.includes("unattributedSlots.delete(key)") &&
		history.includes("if (unattributedSlots.size !== 0) return undefined") &&
		history.includes("if (joined.has(entry.finding)) return undefined") &&
		history.includes("rulings.size !== dispositions.size") &&
		history.includes("!Array.isArray(ruling.provenance) || ruling.provenance.length === 0") &&
		history.includes("!slots.has(key) || attributed.has(key)") &&
		history.includes("disposition?.finding !== ruling.finding") &&
		history.includes("await readCorrectionIntervals(") &&
		history.includes("composeDiagnosisBrief(\n\tbasis: RepairBasis") &&
		caller.includes("await deriveRepairBasis(repoRoot, history)") &&
		caller.includes("if (basis === undefined)") &&
		caller.indexOf("composeDiagnosisBrief(basis,") > caller.indexOf("if (basis === undefined)") &&
		caller.indexOf('state = { phase: "diagnosis-admitted", diagnosis }') >
			caller.indexOf("JSON.stringify(confirmed.history)")
	);
}

describe("issue #238 structural mutation teeth", () => {
	it("pins the projection, canonical reader and caller admission boundary", () => {
		assert.equal(contractHolds(INTERVAL, HISTORY, CALLER), true);
	});

	it("kills one private-copy mutant for every closed component", () => {
		const mutants = [
			[INTERVAL.replace('GIT_NO_REPLACE_OBJECTS: "1"', 'GIT_NO_REPLACE_OBJECTS: "0"'), HISTORY, CALLER],
			[INTERVAL.replace("const RUN_MS = 30_000", "const RUN_MS = Infinity"), HISTORY, CALLER],
			[INTERVAL.replace("const BYTE_CAP = 16 * 1024 * 1024", "const BYTE_CAP = Infinity"), HISTORY, CALLER],
			[INTERVAL.replace("const COMMIT_CAP = 100_000", "const COMMIT_CAP = Infinity"), HISTORY, CALLER],
			[INTERVAL.replace('"--end-of-options", `${oid}^{commit}`', "`${oid}^{commit}`"), HISTORY, CALLER],
			[INTERVAL.replace('["cat-file", "commit", oid]', '["merge-base", oid]'), HISTORY, CALLER],
			[INTERVAL.replace('lines[0].toString("ascii")', 'raw.toString("ascii")'), HISTORY, CALLER],
			[
				INTERVAL.replace(
					'while (index < lines.length && lines[index].subarray(0, 7).equals(Buffer.from("parent ")))',
					"while (index < lines.length)",
				),
				HISTORY,
				CALLER,
			],
			[INTERVAL.replace('"-z", "--full-tree"', '"--full-tree"'), HISTORY, CALLER],
			[INTERVAL.replace('["cat-file", "blob", entry.oid]', '["show", entry.oid]'), HISTORY, CALLER],
			[INTERVAL.replace('["120000", "blob"]', '["120000", "commit"]'), HISTORY, CALLER],
			[
				INTERVAL.replace(
					"const intervals: CorrectionInterval[] = [];\n\tfor (const pair of pairs) {\n\t\tconst budget: Budget = { deadline: Date.now() + RUN_MS, bytes: 0, commits: 0 };",
					"const budget: Budget = { deadline: Date.now() + RUN_MS, bytes: 0, commits: 0 };\n\tconst intervals: CorrectionInterval[] = [];\n\tfor (const pair of pairs) {",
				),
				HISTORY,
				CALLER,
			],
			[
				INTERVAL,
				HISTORY.replace(
					'while (start > 0 && history[start - 1].outcome === "repair")',
					'while (start > 0 && history[start - 1].outcome !== "approved")',
				),
				CALLER,
			],
			[INTERVAL, HISTORY.replace('ruling.validity === "CONFIRMED"', 'ruling.validity !== "REFUTED"'), CALLER],
			[INTERVAL, HISTORY.replace('ruling.severity === "SUBSTANTIVE"', 'ruling.severity !== "NIT"'), CALLER],
			[INTERVAL, HISTORY.replace('disposition.disposition === "repair"', 'disposition.disposition !== "none"'), CALLER],
			[INTERVAL, HISTORY.replace("!adjudication.dedupAttested ||", "false ||"), CALLER],
			[INTERVAL, HISTORY.replace("record.bundle.length === 0 ||", "false ||"), CALLER],
			[INTERVAL, HISTORY.replace("adjudication.rulings.length > record.bundle.length", "false"), CALLER],
			[
				INTERVAL,
				HISTORY.replace("const slots = new Set(record.bundle.map", "const slots = new Set(record.bundle.flatMap"),
				CALLER,
			],
			[INTERVAL, HISTORY.replace("disposition?.finding !== ruling.finding", "false"), CALLER],
			[
				INTERVAL,
				HISTORY.replace("const unattributedSlots = new Set(slots)", "const unattributedSlots = new Set()"),
				CALLER,
			],
			[INTERVAL, HISTORY.replace("unattributedSlots.delete(key)", "void key"), CALLER],
			[
				INTERVAL,
				HISTORY.replace("if (unattributedSlots.size !== 0) return undefined", "if (false) return undefined"),
				CALLER,
			],
			[
				INTERVAL,
				HISTORY.replace("if (joined.has(entry.finding)) return undefined", "if (false) return undefined"),
				CALLER,
			],
			[INTERVAL, HISTORY.replace("rulings.size !== dispositions.size", "false"), CALLER],
			[
				INTERVAL,
				HISTORY.replace("!Array.isArray(ruling.provenance) || ruling.provenance.length === 0", "false"),
				CALLER,
			],
			[INTERVAL, HISTORY.replace("!slots.has(key) || attributed.has(key)", "false"), CALLER],
			[INTERVAL, HISTORY.replace("await readCorrectionIntervals(", "await Promise.all("), CALLER],
			[
				INTERVAL,
				HISTORY.replace(
					"composeDiagnosisBrief(\n\tbasis: RepairBasis",
					"composeDiagnosisBrief(\n\tbasis: StateSummary[]",
				),
				CALLER,
			],
			[INTERVAL, HISTORY, CALLER.replace("if (basis === undefined)", "if (false)")],
			[
				INTERVAL,
				HISTORY,
				CALLER.replace(
					"const confirmed = await durableState(repoRoot, subject, seams, requiredReceipt);",
					'state = { phase: "diagnosis-admitted", diagnosis };\n\t\t\tconst confirmed = await durableState(repoRoot, subject, seams, requiredReceipt);',
				).replace(
					'\n\t\t\tstate = { phase: "diagnosis-admitted", diagnosis };\n\t\t\tdiagnosedHistory',
					"\n\t\t\tdiagnosedHistory",
				),
			],
		] as const;
		mutants.forEach(([interval, history, caller], index) => {
			assert.equal(contractHolds(interval, history, caller), false, `mutant ${index} survived`);
		});
	});
});

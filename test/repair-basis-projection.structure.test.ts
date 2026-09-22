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
		interval.includes('["ls-tree", "-r", "-z", "--full-tree", "--end-of-options", earlierHead]') &&
		interval.includes('["cat-file", "blob", entry.oid]') &&
		interval.includes('["100644", "blob"]') &&
		interval.includes('["100755", "blob"]') &&
		interval.includes('["120000", "blob"]') &&
		interval.includes('["160000", "commit"]') &&
		!interval.includes("merge-base") &&
		!interval.includes("git diff") &&
		history.includes('while (start > 0 && history[start - 1].outcome === "repair")') &&
		history.includes('ruling.validity === "CONFIRMED"') &&
		history.includes('ruling.severity === "SUBSTANTIVE"') &&
		history.includes('disposition.disposition === "repair"') &&
		history.includes("bundles.size !== rulings.size || bundles.size !== dispositions.size") &&
		history.includes("composeDiagnosisBrief(\n\tbasis: RepairBasis") &&
		caller.includes("await deriveRepairBasis(repoRoot, history)") &&
		caller.includes("if (basis === undefined)") &&
		caller.indexOf("composeDiagnosisBrief(basis,") > caller.indexOf("if (basis === undefined)")
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
			[INTERVAL.replace('"-z", "--full-tree"', '"--full-tree"'), HISTORY, CALLER],
			[INTERVAL.replace('["cat-file", "blob", entry.oid]', '["show", entry.oid]'), HISTORY, CALLER],
			[INTERVAL.replace('["120000", "blob"]', '["120000", "commit"]'), HISTORY, CALLER],
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
			[
				INTERVAL,
				HISTORY.replace("bundles.size !== rulings.size || bundles.size !== dispositions.size", "false"),
				CALLER,
			],
			[
				INTERVAL,
				HISTORY.replace(
					"composeDiagnosisBrief(\n\tbasis: RepairBasis",
					"composeDiagnosisBrief(\n\tbasis: StateSummary[]",
				),
				CALLER,
			],
			[INTERVAL, HISTORY, CALLER.replace("if (basis === undefined)", "if (false)")],
		] as const;
		mutants.forEach(([interval, history, caller], index) => {
			assert.equal(contractHolds(interval, history, caller), false, `mutant ${index} survived`);
		});
	});
});

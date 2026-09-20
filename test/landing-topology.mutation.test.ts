import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("Phase-2 topology excision mutants", () => {
	it("the command registry has no source-split caller", () => {
		const source = readFileSync(new URL("../.pi/extensions/gitjig/commands/index.ts", import.meta.url), "utf8");
		assert.doesNotMatch(source, /registerSourceSplit/);
	});
	it("bootstrap cannot regain a landing call", () => {
		const source = readFileSync(new URL("../.pi/extensions/gitjig/landing/bootstrap.ts", import.meta.url), "utf8");
		assert.match(source, /bootstrap-superseded-dormant/);
		assert.doesNotMatch(source, /executeLanding|executeGuardedLanding|ownBehalf/);
	});
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./harness/run-pi.ts";

const engine = ".github/workflows/gitjig-lifecycle.mjs";
const adapter = ".github/workflows/lifecycle-event.mjs";

describe("#276 executable lifecycle engine gate reach", () => {
	it("puts mjs under the real source-style configuration", () => {
		const biome = readFileSync(join(repoRoot(), "biome.jsonc"), "utf8");
		assert.match(biome, /"\*\*\/\*\.mjs"/);
	});

	it("puts the exact engine body under strict JavaScript type checking", () => {
		const config = readFileSync(join(repoRoot(), "tsconfig.json"), "utf8");
		assert.match(config, /"allowJs": true/);
		assert.match(config, /"checkJs": true/);
		assert.ok(config.includes(`"${engine}"`));
		assert.ok(config.includes(`"${adapter}"`));
	});

	it("parses mjs comments with the code dialect in the one-home guard", () => {
		const guard = readFileSync(join(repoRoot(), "test/posture-home.structure.test.ts"), "utf8");
		assert.match(guard, /endsWith\("\.mjs"\)/);
	});
});

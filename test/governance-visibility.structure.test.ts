import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(new URL("../.pi/extensions/gitjig/commands/governance.ts", import.meta.url), "utf8");

describe("governance session visibility structure", () => {
	it("uses one visible contextual message and supported renderer instead of hidden entries", () => {
		assert.match(source, /registerMessageRenderer\("gitjig-governance"/);
		assert.match(source, /pi\.sendMessage\(message, \{ triggerTurn: true \}\)/);
		assert.match(source, /display: true/);
		assert.match(source, /await ctx\.waitForIdle\(\)/);
		assert.doesNotMatch(source, /appendEntry\("gitjig-governance"/);
		assert.doesNotMatch(source, /^import .*\.github/m);
		assert.doesNotMatch(source, /content: \[\], display: false/);
	});

	it("pins bounds, persisted TUI application, and authority invalidation", () => {
		assert.match(source, /RECORD_BOUND = 512 \* 1024/);
		assert.match(source, /isPersisted/);
		assert.match(source, /ctx\.mode !== "tui"/);
		assert.match(source, /session_compact/);
		assert.match(source, /session_tree/);
		assert.match(source, /presented\.delete\(attempt as string\)/);
	});
});

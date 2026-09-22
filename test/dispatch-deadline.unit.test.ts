import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runDispatch } from "../.pi/extensions/gitjig/dispatch/index.ts";

describe("#332 optional dispatcher operation deadline", () => {
	it("refuses an expired recovery deadline before provisioning", async () => {
		const outcome = await runDispatch({
			callerRepoRoot: process.cwd(),
			stateRoot: mkdtempSync(join(tmpdir(), "dispatch-deadline-")),
			brief: "x",
			delegateArgv: ["true"],
			operationDeadline: performance.now() - 1,
		});
		assert.equal(outcome.disposition, "refused");
		assert.equal(outcome.diagnostic.phase, "preflight");
	});
});

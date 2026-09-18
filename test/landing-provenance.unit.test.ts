import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { gitBlobOid, trustedDefaultBranchBytes } from "../.pi/extensions/gitjig/landing/provenance.ts";

const root = mkdtempSync(join(tmpdir(), "gitjig-landing-provenance-"));
after(() => rmSync(root, { recursive: true, force: true }));

describe("#278 trusted default-branch module bytes", () => {
	it("admits only the exact platform blob identity", () => {
		const path = join(root, "engine.mjs");
		const bytes = Buffer.from("export const predicate = true;\n");
		writeFileSync(path, bytes);
		assert.deepEqual(trustedDefaultBranchBytes(path, gitBlobOid(bytes)), bytes);
		assert.equal(trustedDefaultBranchBytes(path, "0".repeat(40)), undefined);
		assert.equal(trustedDefaultBranchBytes(path, "bad"), undefined);
		assert.equal(trustedDefaultBranchBytes(join(root, "absent"), gitBlobOid(bytes)), undefined);
	});
});

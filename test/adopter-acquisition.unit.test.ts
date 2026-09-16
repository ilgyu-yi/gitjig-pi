import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { verifyAcquiredSnapshot } from "../.pi/extensions/gitjig/install/acquire.ts";
import { composeAdopter } from "../.pi/extensions/gitjig/install/compose.ts";

const roots: string[] = [];
const source = { provider: "github" as const, host: "github.com" as const, owner: "example", repository: "source" };
let fixture: string;

beforeEach(() => {
	fixture = mkdtempSync(join(tmpdir(), "gitjig-acquire-"));
	roots.push(fixture);
	for (const dir of [".pi/extensions", ".github", ".githooks", "changelog_unreleased"])
		mkdirSync(join(fixture, dir), { recursive: true });
	writeFileSync(join(fixture, ".pi/extensions/gitjig.ts"), "carried\n");
	writeFileSync(join(fixture, ".github/gate.yml"), "handed\n");
	writeFileSync(join(fixture, ".githooks/pre-commit"), "hook\n");
	writeFileSync(join(fixture, "changelog_unreleased/TEMPLATE.md"), "template\n");
});
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function pinBytes() {
	return composeAdopter({
		sourceRoot: fixture,
		source,
		revision: "a".repeat(40),
		priorPinBytes: null,
		occupants: new Map(),
	}).pinBytes;
}

describe("#130 immutable snapshot acquisition", () => {
	it("reconstructs the exact classifier-owned payload before admission", () => {
		const bytes = pinBytes();
		const result = verifyAcquiredSnapshot(fixture, bytes);
		assert.equal(result.outcome, "verified");
		if (result.outcome === "verified") assert.equal(result.pin.revision, "a".repeat(40));
	});

	it("refuses missing, changed, additional admitted, symlinked, and malformed inputs", () => {
		const scenarios: Array<(root: string) => void> = [
			(root) => rmSync(join(root, ".pi/extensions/gitjig.ts")),
			(root) => writeFileSync(join(root, ".pi/extensions/gitjig.ts"), "changed\n"),
			(root) => writeFileSync(join(root, ".pi/extensions/extra.ts"), "extra\n"),
			(root) => {
				rmSync(join(root, ".pi/extensions/gitjig.ts"));
				symlinkSync("extra.ts", join(root, ".pi/extensions/gitjig.ts"));
			},
		];
		for (const mutate of scenarios) {
			const bytes = pinBytes();
			const copy = mkdtempSync(join(tmpdir(), "gitjig-acquire-case-"));
			roots.push(copy);
			cpSync(fixture, copy, { recursive: true });
			mutate(copy);
			assert.equal(verifyAcquiredSnapshot(copy, bytes).outcome, "refused");
		}
		assert.deepEqual(verifyAcquiredSnapshot(fixture, Buffer.from("{}")), {
			outcome: "refused",
			cause: "malformed-pin",
		});
	});

	it("ignores source-only and instance-state bytes only through classifier disposition", () => {
		writeFileSync(join(fixture, ".github/dev.yml"), "# gitjig: source-only\ndev\n");
		writeFileSync(join(fixture, "changelog_unreleased/live.md"), "instance\n");
		const bytes = pinBytes();
		writeFileSync(join(fixture, ".github/dev.yml"), "# gitjig: source-only\nchanged\n");
		writeFileSync(join(fixture, "changelog_unreleased/live.md"), "changed\n");
		assert.equal(verifyAcquiredSnapshot(fixture, bytes).outcome, "verified");
	});
});

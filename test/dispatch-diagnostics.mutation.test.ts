import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "gitjig-267-mutants-"));
after(() => rmSync(root, { recursive: true, force: true }));

function kill(name: string, from: string, to: string, probe: string): void {
	for (const variant of ["baseline", "mutant"] as const) {
		const box = mkdtempSync(join(root, `${name}-${variant}-`));
		cpSync(join(repository, ".pi/extensions/gitjig/dispatch"), join(box, "dispatch"), { recursive: true });
		const target = join(box, "dispatch/diagnostics.ts");
		const source = readFileSync(target, "utf8");
		assert.equal(source.split(from).length, 2, `${name}: mutation target must be unique`);
		if (variant === "mutant") writeFileSync(target, source.replace(from, to));
		writeFileSync(
			join(box, "probe.mjs"),
			`import assert from "node:assert/strict"; import {makeDiagnostic} from "./dispatch/diagnostics.ts"; ${probe}`,
		);
		const result = spawnSync(process.execPath, [join(box, "probe.mjs")], { encoding: "utf8", timeout: 10_000 });
		if (variant === "baseline") assert.equal(result.status, 0, `${name}: baseline failed\n${result.stderr}`);
		else assert.notEqual(result.status, 0, `${name}: mutant survived`);
	}
}

const base =
	'status:"refused",run:{class:"exited",exitCode:17,signal:null},return:{class:"missing"},compare:{class:"not-reached"},durationMs:1';

describe("#267 isolated diagnostic mutants", () => {
	it("kills the signed-32-bit exit bound mutant", () => {
		kill(
			"exit-int32",
			"input.run.exitCode > 2_147_483_647",
			"input.run.exitCode > Number.MAX_SAFE_INTEGER",
			'const d=makeDiagnostic({status:"admitted",phase:"return",run:{class:"exited",exitCode:2**40,signal:null},return:{class:"admitted"},compare:{class:"not-requested"},durationMs:1,code:"ADMITTED"}); assert.equal(d.code,"INTERNAL_FAILED");',
		);
	});

	it("kills code-to-return-class and compare-phase mutants independently", () => {
		kill(
			"code-class",
			"input.return.class === expected[2]",
			"true",
			`const d=makeDiagnostic({${base},phase:"return",code:"RETURN_OVERSIZE"}); assert.equal(d.code,"INTERNAL_FAILED");`,
		);
		kill(
			"compare-phase",
			'input.phase !== "compare"',
			"false",
			'const d=makeDiagnostic({status:"refused",phase:"return",run:{class:"exited",exitCode:0,signal:null},return:{class:"admitted"},compare:{class:"confirmed"},durationMs:1,code:"INTERNAL_FAILED"}); assert.notEqual(d.compare.class,"confirmed");',
		);
	});
});

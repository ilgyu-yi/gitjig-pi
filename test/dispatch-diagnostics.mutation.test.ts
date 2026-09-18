import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "gitjig-267-mutants-"));
after(() => rmSync(root, { recursive: true, force: true }));

function kill(
	name: string,
	from: string,
	to: string,
	probe: string,
	module = "diagnostics.ts",
	imports = 'import {makeDiagnostic} from "./gitjig/dispatch/diagnostics.ts";',
): void {
	for (const variant of ["baseline", "mutant"] as const) {
		const box = mkdtempSync(join(root, `${name}-${variant}-`));
		cpSync(join(repository, ".pi/extensions/gitjig"), join(box, "gitjig"), { recursive: true });
		symlinkSync(join(repository, "node_modules"), join(box, "node_modules"), "dir");
		const target = join(box, "gitjig/dispatch", module);
		const source = readFileSync(target, "utf8");
		assert.equal(source.split(from).length, 2, `${name}: mutation target must be unique`);
		if (variant === "mutant") writeFileSync(target, source.replace(from, to));
		writeFileSync(join(box, "probe.mjs"), `import assert from "node:assert/strict"; ${imports} ${probe}`);
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

	it("kills the runtime return-class mapping mutant", () => {
		kill(
			"return-code-map",
			'missing: "RETURN_MISSING"',
			'missing: "RETURN_NOT_REGULAR"',
			'const {RETURN_CODE_BY_CLASS:m}=await import("./gitjig/dispatch/diagnostics.ts"); assert.equal(m.missing,"RETURN_MISSING");',
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

	it("kills each completed-surface bound mutant independently", () => {
		kill(
			"diagnostic-bound",
			"DIAGNOSTIC_SERIALIZED_LIMIT_BYTES = 1_536",
			"DIAGNOSTIC_SERIALIZED_LIMIT_BYTES = 15_360",
			"assert.equal(DIAGNOSTIC_SERIALIZED_LIMIT_BYTES,1536);",
			"diagnostics.ts",
			'import {DIAGNOSTIC_SERIALIZED_LIMIT_BYTES} from "./gitjig/dispatch/diagnostics.ts";',
		);
		for (const [key, value] of [
			["refusedOutcome", "2_048"],
			["admittedOutcome", "524_288"],
			["refusedContent", "2_048"],
			["admittedContent", "524_288"],
			["details", "4_096"],
		] as const) {
			kill(
				`${key}-bound`,
				`${key}: ${value}`,
				`${key}: ${value}0`,
				`assert.equal(DISPATCH_SURFACE_LIMITS.${key},${value.replace("_", "")});`,
				"index.ts",
				'import {DISPATCH_SURFACE_LIMITS} from "./gitjig/dispatch/index.ts";',
			);
		}
		const measurementImport = 'import {dispatchSurfaceBreaches} from "./gitjig/dispatch/index.ts";';
		kill(
			"outcome-measurement",
			"outcome: surfaceBytes(value) > outcomeLimit",
			"outcome: false",
			'const b=dispatchSurfaceBreaches({content:[{type:"text",text:"x".repeat(500)}],details:{padding:"x".repeat(1600)}},false); assert.deepEqual(b,{outcome:true,content:false,details:false});',
			"index.ts",
			measurementImport,
		);
		kill(
			"content-measurement",
			'surfaceBytes(value.content[0]?.text ?? "") > contentLimit',
			"false",
			'const b=dispatchSurfaceBreaches({content:[{type:"text",text:"x".repeat(2049)}],details:{}},false); assert.equal(b.content,true);',
			"index.ts",
			measurementImport,
		);
		kill(
			"details-measurement",
			"surfaceBytes(value.details) > DISPATCH_SURFACE_LIMITS.details",
			"false",
			'const b=dispatchSurfaceBreaches({content:[{type:"text",text:"x"}],details:{padding:"x".repeat(4097)}},true); assert.deepEqual(b,{outcome:false,content:false,details:true});',
			"index.ts",
			measurementImport,
		);
	});
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
let root: string;
before(() => {
	root = mkdtempSync(join(tmpdir(), "gitjig-provision-mutants-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

function kill(name: string, file: string, from: string, to: string, assertion: string): void {
	for (const variant of ["baseline", "mutant"] as const) {
		const box = mkdtempSync(join(root, `${name}-${variant}-`));
		cpSync(join(repository, ".pi/extensions/gitjig"), join(box, "gitjig"), { recursive: true });
		const target = join(box, "gitjig/install", file);
		const source = readFileSync(target, "utf8");
		assert.equal(source.split(from).length, 2, `${name}: target must be unique`);
		if (variant === "mutant") writeFileSync(target, source.replace(from, to));
		writeFileSync(join(box, "probe.mjs"), `${setup}\n${assertion}`);
		const result = spawnSync(process.execPath, [join(box, "probe.mjs")], { encoding: "utf8" });
		if (variant === "baseline") assert.equal(result.status, 0, `${name}: baseline failed\n${result.stderr}`);
		else assert.notEqual(result.status, 0, `${name}: mutant survived\n${result.stderr}`);
	}
}

const setup = `
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {composeAdopter,observeOccupants} from "./gitjig/install/compose.ts";
import {provisionAdopter} from "./gitjig/install/provision.ts";
import {verifyAcquiredSnapshot} from "./gitjig/install/acquire.ts";
const sourceRoot=mkdtempSync(join(tmpdir(),"provision-probe-source-")); const targetRoot=mkdtempSync(join(tmpdir(),"provision-probe-target-"));
for(const d of [".pi/extensions",".github",".githooks","changelog_unreleased"]){mkdirSync(join(sourceRoot,d),{recursive:true})}
writeFileSync(join(sourceRoot,".pi/extensions/gitjig.ts"),"carried"); writeFileSync(join(sourceRoot,".github/a"),"handed"); writeFileSync(join(sourceRoot,".githooks/pre-commit"),"hook"); writeFileSync(join(sourceRoot,"changelog_unreleased/TEMPLATE.md"),"template");
const source={provider:"github",host:"github.com",owner:"o",repository:"r"};
const seed=composeAdopter({sourceRoot,source,revision:"a".repeat(40),priorPinBytes:null,occupants:new Map()});
for(const c of seed.candidates){if(c.disposition==="handed-over"){mkdirSync(join(targetRoot,c.path,".."),{recursive:true});writeFileSync(join(targetRoot,c.path),c.bytes)}} mkdirSync(join(targetRoot,".pi"),{recursive:true}); writeFileSync(join(targetRoot,".pi/gitjig.pin.json"),seed.pinBytes);
let calls=0, advances=0;
const platform={apply:async request=>{calls++;const occupants=new Map(observeOccupants(targetRoot,request.verifyPaths));for(const c of request.changes)occupants.set(c.path,c.operation==="delete"?{kind:"absent"}:{kind:"bytes",bytes:Buffer.from(c.bytes)});return {occupants,excluded:[...request.exclude],hooksPath:".githooks"}},advanceInstalledPin:async bytes=>{advances++;return Buffer.from(bytes)}};
const run=(overrides={})=>provisionAdopter({snapshotRoot:sourceRoot,targetRoot,committedPinBytes:seed.pinBytes,installedPinBytes:null,platform,...overrides});
`;

describe("#130 named isolated provision guard mutants", () => {
	it("kills acquisition and projection mutants", () => {
		kill(
			"acquired-pin-equality",
			"acquire.ts",
			"if (!exact(Buffer.from(encodePin(reconstructed)), pinBytes))",
			"if (false)",
			`writeFileSync(join(sourceRoot,".pi/extensions/gitjig.ts"),"wrong"); assert.equal(verifyAcquiredSnapshot(sourceRoot,seed.pinBytes).outcome,"refused");`,
		);
		kill(
			"carried-projection",
			"provision.ts",
			'if (member.class === "handed-over" || member.class === "pin") {',
			"if (false) {",
			`assert.equal((await run()).outcome,"verified"); assert.equal(calls,1);`,
		);
		kill(
			"platform-null",
			"provision.ts",
			'if (snapshot === null) return Object.freeze({ outcome: "refused", cause: "platform-unconfirmed" });',
			"if (false) return null;",
			`const r=await run({platform:{...platform,apply:async()=>null}}); assert.equal(r.outcome,"refused"); assert.equal(r.cause,"platform-unconfirmed");`,
		);
	});
	it("kills final verification and authority mutants", () => {
		kill(
			"final-planned-state",
			"provision.ts",
			'verifyPlannedState(composition.plan, snapshot.occupants, input.committedPinBytes) === "refused" ||',
			"false ||",
			`const bad={...platform,apply:async r=>{const s=await platform.apply(r);s.occupants.set(".pi/extensions/gitjig.ts",{kind:"bytes",bytes:Buffer.from("bad")});return s}}; assert.equal((await run({platform:bad})).outcome,"refused");`,
		);
		kill(
			"final-hooks-binding",
			"provision.ts",
			'snapshot.hooksPath !== ".githooks" ||',
			"false ||",
			`const bad={...platform,apply:async r=>({...await platform.apply(r),hooksPath:"other"})}; assert.equal((await run({platform:bad})).outcome,"refused");`,
		);
		kill(
			"final-exclusions",
			"provision.ts",
			"!request.exclude.every((path) => snapshot.excluded.includes(path))",
			"false",
			`const bad={...platform,apply:async r=>({...await platform.apply(r),excluded:[]})}; assert.equal((await run({platform:bad})).outcome,"refused");`,
		);
		kill(
			"installed-pin-confirmation",
			"provision.ts",
			"advanced === null || !advanced.equals(input.committedPinBytes)",
			"false",
			`const bad={...platform,advanceInstalledPin:async()=>Buffer.from("wrong")}; assert.equal((await run({platform:bad})).outcome,"refused");`,
		);
	});
});

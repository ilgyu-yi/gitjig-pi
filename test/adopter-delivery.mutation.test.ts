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
	root = mkdtempSync(join(tmpdir(), "gitjig-delivery-mutants-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

function kill(name: string, from: string, to: string, assertion: string): void {
	for (const variant of ["baseline", "mutant"] as const) {
		const box = mkdtempSync(join(root, `${name}-${variant}-`));
		cpSync(join(repository, ".pi/extensions/gitjig"), join(box, "gitjig"), { recursive: true });
		const target = join(box, "gitjig/install/delivery.ts");
		const source = readFileSync(target, "utf8");
		assert.equal(source.split(from).length, 2, `${name}: mutation target must be unique`);
		if (variant === "mutant") writeFileSync(target, source.replace(from, to));
		writeFileSync(join(box, "probe.mjs"), `${setup}\n${assertion}`);
		const result = spawnSync(process.execPath, [join(box, "probe.mjs")], { encoding: "utf8" });
		if (variant === "baseline") assert.equal(result.status, 0, `${name}: baseline failed\n${result.stderr}`);
		else assert.notEqual(result.status, 0, `${name}: mutant survived\n${result.stdout}\n${result.stderr}`);
	}
}

const setup = `
import assert from "node:assert/strict";
import { buildPin, encodePin } from "./gitjig/install/pin.ts";
import { planComposition } from "./gitjig/install/plan.ts";
import { deliverAdopter } from "./gitjig/install/delivery.ts";
const source={provider:"github",host:"github.com",owner:"source",repository:"repo"};
const handed={path:".github/a",disposition:"handed-over",bytes:Buffer.from("handed")};
const carried={path:".pi/extensions/gitjig.ts",disposition:"carried",bytes:Buffer.from("carried")};
const pin=buildPin(source,"a".repeat(40),[{path:handed.path,class:"handed-over",bytes:handed.bytes},{path:carried.path,class:"carried",bytes:carried.bytes}]);
const pinBytes=Buffer.from(encodePin(pin));
const occupants=new Map([[handed.path,{kind:"absent"}],[carried.path,{kind:"absent"}],[".pi/gitjig.pin.json",{kind:"absent"}]]);
const plan=planComposition({nextPinBytes:pinBytes,priorPinBytes:null,occupants});
const composition={candidates:[handed,carried],membershipSnapshot:"",pin,pinBytes,plan};
const target={source:{provider:"github",host:"github.com",owner:"target",repository:"repo"},baseRef:"main",baseRevision:"1".repeat(40)};
const egress={prepare:(title,body)=>({outcome:"prepared",title,body})};
const platform={publishDraft:async request=>({source:request.target.source,baseRef:request.target.baseRef,baseRevision:request.target.baseRevision,headRevision:"2".repeat(40),number:1,draft:true,title:request.title,body:request.body,changes:request.changes})};
`;

describe("#118 named isolated delivery guard mutants", () => {
	it("kills composition and projection guard mutants", () => {
		kill(
			"final-payload-verification",
			'if (verifyPlannedState(composition.plan, desired, composition.pinBytes) === "refused") return null;',
			"void desired;",
			`const bad={...composition,candidates:[{...handed,bytes:Buffer.from("wrong")},carried]}; assert.equal((await deliverAdopter({composition:bad,target,title:"t",body:"b",egress,platform})).outcome,"refused");`,
		);
		kill(
			"carried-projection",
			'if (member.class !== "handed-over" && member.class !== "pin") continue;',
			"if (false) continue;",
			`let request; const p={publishDraft:async r=>{request=r; return platform.publishDraft(r)}}; assert.equal((await deliverAdopter({composition,target,title:"t",body:"b",egress,platform:p})).outcome,"verified"); assert.ok(!request.changes.some(x=>x.path===carried.path));`,
		);
		kill(
			"target-domain",
			'if (!validTarget(input.target)) return refuse("invalid-target");',
			'if (false) return refuse("invalid-target");',
			`assert.equal((await deliverAdopter({composition,target:{...target,baseRevision:"main"},title:"t",body:"b",egress,platform})).outcome,"refused");`,
		);
	});

	it("kills egress and platform confirmation guard mutants", () => {
		kill(
			"egress-refusal",
			'prepared.outcome !== "prepared" ||',
			"false ||",
			`assert.equal((await deliverAdopter({composition,target,title:"t",body:"b",egress:{prepare:()=>({outcome:"refused",title:"x",body:"x"})},platform})).outcome,"refused");`,
		);
		kill(
			"platform-null",
			'if (snapshot === null) return refuse("platform-unconfirmed", retained);',
			'if (false) return refuse("platform-unconfirmed", retained);',
			`const r=await deliverAdopter({composition,target,title:"t",body:"b",egress,platform:{publishDraft:async()=>null}}); assert.equal(r.outcome,"refused"); assert.equal(r.cause,"platform-unconfirmed");`,
		);
		kill(
			"platform-base",
			"snapshot.baseRevision !== input.target.baseRevision ||",
			"false ||",
			`const p={publishDraft:async r=>({...await platform.publishDraft(r),baseRevision:"3".repeat(40)})}; assert.equal((await deliverAdopter({composition,target,title:"t",body:"b",egress,platform:p})).outcome,"refused");`,
		);
		kill(
			"platform-head-format",
			"!/^[0-9a-f]{40}$/u.test(snapshot.headRevision) ||",
			"false ||",
			`const p={publishDraft:async r=>({...await platform.publishDraft(r),headRevision:"not-a-sha"})}; assert.equal((await deliverAdopter({composition,target,title:"t",body:"b",egress,platform:p})).outcome,"refused");`,
		);
		kill(
			"platform-draft",
			"snapshot.draft !== true ||",
			"false ||",
			`const p={publishDraft:async r=>({...await platform.publishDraft(r),draft:false})}; assert.equal((await deliverAdopter({composition,target,title:"t",body:"b",egress,platform:p})).outcome,"refused");`,
		);
		kill(
			"platform-title",
			"snapshot.title !== prepared.title ||",
			"false ||",
			`const p={publishDraft:async r=>({...await platform.publishDraft(r),title:"other"})}; assert.equal((await deliverAdopter({composition,target,title:"t",body:"b",egress,platform:p})).outcome,"refused");`,
		);
		kill(
			"platform-change-content",
			"!retained.every((change, index) => sameChange(change, snapshot.changes[index]))",
			"false",
			`const p={publishDraft:async r=>{const s=await platform.publishDraft(r); return {...s,changes:s.changes.map((x,i)=>i===0?{...x,path:x.path+".altered"}:x)}}}; assert.equal((await deliverAdopter({composition,target,title:"t",body:"b",egress,platform:p})).outcome,"refused");`,
		);
		kill(
			"platform-changes",
			"snapshot.changes.length !== retained.length ||",
			"false ||",
			`const p={publishDraft:async r=>{const s=await platform.publishDraft(r); return {...s,changes:[...s.changes,s.changes[0]]}}}; assert.equal((await deliverAdopter({composition,target,title:"t",body:"b",egress,platform:p})).outcome,"refused");`,
		);
	});
});

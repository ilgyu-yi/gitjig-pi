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
	root = mkdtempSync(join(tmpdir(), "gitjig-adopter-mutants-"));
});
after(() => {
	rmSync(root, { recursive: true, force: true });
});

function kill(name: string, file: string, from: string, to: string, assertion: string): void {
	const box = mkdtempSync(join(root, `${name}-`));
	cpSync(join(repository, ".pi/extensions/gitjig/install"), join(box, "install"), { recursive: true });
	const target = join(box, "install", file);
	const source = readFileSync(target, "utf8");
	assert.equal(source.split(from).length, 2, `${name}: mutant target is not unique`);
	writeFileSync(target, source.replace(from, to));
	writeFileSync(join(box, "probe.mjs"), assertion);
	const result = spawnSync(process.execPath, [join(box, "probe.mjs")], { encoding: "utf8" });
	assert.notEqual(result.status, 0, `${name}: mutant survived\n${result.stdout}\n${result.stderr}`);
}

const pinSetup = `
import assert from "node:assert/strict";
import { buildPin, encodePin } from "./install/pin.ts";
import { planComposition, verifyPlannedState } from "./install/plan.ts";
const source={provider:"github",host:"github.com",owner:"o",repository:"r"};
const member=(path,cls,body)=>({path,class:cls,bytes:Buffer.from(body)});
const oldPin=buildPin(source,"a".repeat(40),[member(".githooks/a","handed-over","old")]);
const nextPin=buildPin(source,"b".repeat(40),[member(".githooks/a","handed-over","new")]);
const occupants=(body)=>new Map([[".githooks/a",{kind:"bytes",bytes:Buffer.from(body)}],[".pi/gitjig.pin.json",{kind:"bytes",bytes:Buffer.from(encodePin(oldPin))}]]);
`;

describe("#250 named isolated guard mutants", () => {
	it("kills exact-marker, carried-path, and digest-framing mutants", () => {
		kill(
			"marker-prefix",
			"classifier.ts",
			"DECLARATIONS.has(eligible.text)",
			'eligible.text.startsWith("# gitjig: source-only")',
			`import assert from "node:assert/strict"; import {classifyMarker} from "./install/classifier.ts"; assert.equal(classifyMarker(Buffer.from("# gitjig: source-only junk\\n")),"refuse");`,
		);
		kill(
			"carried-prompt",
			"classifier.ts",
			'path.startsWith(".pi/prompts/")',
			"false",
			`import assert from "node:assert/strict"; import {classifyCandidate} from "./install/classifier.ts"; assert.equal(classifyCandidate(".pi/prompts/x.md",Buffer.from("x\\n")),"carried");`,
		);
		kill(
			"class-byte",
			"pin.ts",
			'entry.class === "handed-over" ? 0x48 : 0x43',
			'entry.class === "handed-over" ? 0x43 : 0x43',
			`import assert from "node:assert/strict"; import {buildPin} from "./install/pin.ts"; const p=buildPin({provider:"github",host:"github.com",owner:"o",repository:"r"},"a".repeat(40),[{path:".githooks/a",class:"handed-over",bytes:Buffer.from("abc")}]); assert.equal(p.payloadDigest,"dec8b35a0a5e56f7ce4c4a4058cf4bfbbf74542816366d603a0e70ea4d552634");`,
		);
	});

	it("kills path, snapshot, descriptor, schema-order, and aggregate mutants", () => {
		kill(
			"unicode-scalars",
			"classifier.ts",
			"if (hasLoneSurrogate(value))",
			"if (false)",
			`import assert from "node:assert/strict"; import {validateCandidatePath} from "./install/classifier.ts"; assert.throws(()=>validateCandidatePath(".github/\\ud800"));`,
		);
		kill(
			"marker-line-two-slash",
			"classifier.ts",
			'if (eligible.terminated && DECLARATIONS.has(eligible.text)) return "source-only";',
			'if (eligible.terminated && DECLARATIONS.has(eligible.text) && !(first !== eligible && eligible.text.startsWith("//"))) return "source-only";',
			`import assert from "node:assert/strict"; import {classifyMarker} from "./install/classifier.ts"; assert.equal(classifyMarker(Buffer.from("#!/bin/sh\\n// gitjig: source-only\\n")),"source-only");`,
		);
		kill(
			"snapshot-path-domain",
			"classifier.ts",
			"validateCandidatePath(member.path);",
			"void member.path;",
			`import assert from "node:assert/strict"; import {renderMembershipSnapshot} from "./install/classifier.ts"; assert.throws(()=>renderMembershipSnapshot([{path:"../outside",disposition:"carried"}]));`,
		);
		kill(
			"snapshot-closed-member",
			"classifier.ts",
			'Object.keys(member).sort().join(",") !== "disposition,path"',
			"false",
			`import assert from "node:assert/strict"; import {renderMembershipSnapshot} from "./install/classifier.ts"; assert.throws(()=>renderMembershipSnapshot([{path:".github/a",disposition:"handed-over",extra:true}]));`,
		);
		kill(
			"json-whitespace",
			"pin.ts",
			'"\\t\\n\\r ".includes(this.text[this.at] ?? "")',
			'/\\s/u.test(this.text[this.at] ?? "")',
			`import assert from "node:assert/strict"; import {buildPin,encodePin,parsePin} from "./install/pin.ts"; const p=buildPin({provider:"github",host:"github.com",owner:"o",repository:"r"},"a".repeat(40),[]); assert.throws(()=>parsePin(encodePin(p).replace(":1","\\u00a0:1")));`,
		);
		kill(
			"snapshot-duplicate",
			"classifier.ts",
			"new Set(sorted.map((m) => m.path)).size !== sorted.length",
			"false",
			`import assert from "node:assert/strict"; import {renderMembershipSnapshot} from "./install/classifier.ts"; assert.throws(()=>renderMembershipSnapshot([{path:".github/a",disposition:"handed-over"},{path:".github/a",disposition:"handed-over"}]));`,
		);
		kill(
			"nofollow-open",
			"classifier.ts",
			" | constants.O_NOFOLLOW",
			"",
			`import assert from "node:assert/strict"; import {mkdirSync,writeFileSync,renameSync,symlinkSync} from "node:fs"; import {join} from "node:path"; import {observeCandidates} from "./install/classifier.ts"; const root=join(import.meta.dirname,"source"); mkdirSync(join(root,".github"),{recursive:true}); const file=join(root,".github/a"),outside=join(root,"outside"); writeFileSync(file,"in"); writeFileSync(outside,"out"); assert.throws(()=>observeCandidates(root,{afterLstat(p){if(p===".github/a"){renameSync(file,outside+"-checked");symlinkSync(outside+"-checked",file)}}}));`,
		);
		kill(
			"opened-identity",
			"classifier.ts",
			"!sameObject(stats, opened)",
			"false",
			`import assert from "node:assert/strict"; import {mkdirSync,writeFileSync,rmSync} from "node:fs"; import {join} from "node:path"; import {observeCandidates} from "./install/classifier.ts"; const root=join(import.meta.dirname,"source"); mkdirSync(join(root,".github"),{recursive:true}); const file=join(root,".github/a"); writeFileSync(file,"old"); assert.throws(()=>observeCandidates(root,{afterLstat(p){if(p===".github/a"){rmSync(file);writeFileSync(file,"new")}}}));`,
		);
		kill(
			"manifest-order",
			"pin.ts",
			"Buffer.compare(Buffer.from(previous.path), Buffer.from(current.path)) >= 0",
			"false",
			`import assert from "node:assert/strict"; import {buildPin,encodePin,parsePin,digestRecord} from "./install/pin.ts"; import {createHash} from "node:crypto"; const s={provider:"github",host:"github.com",owner:"o",repository:"r"}; const p=buildPin(s,"a".repeat(40),[{path:".github/a",class:"handed-over",bytes:Buffer.from("a")},{path:".githooks/b",class:"handed-over",bytes:Buffer.from("b")}]); p.manifest.reverse(); p.payloadDigest=createHash("sha256").update(Buffer.concat(p.manifest.map(digestRecord))).digest("hex"); const text=JSON.stringify(p,(_,v)=>typeof v==="bigint"?Number(v):v); assert.throws(()=>parsePin(text));`,
		);
		kill(
			"source-percent-name",
			"pin.ts",
			'!value.includes("%")',
			"true",
			`import assert from "node:assert/strict"; import {buildPin,encodePin,parsePin} from "./install/pin.ts"; const p=buildPin({provider:"github",host:"github.com",owner:"bad%name",repository:"r"},"a".repeat(40),[]); assert.throws(()=>parsePin(encodePin(p)));`,
		);
		kill(
			"uint64-zero",
			"pin.ts",
			"raw.size < 0n",
			"raw.size <= 0n",
			`import assert from "node:assert/strict"; import {buildPin,encodePin,parsePin} from "./install/pin.ts"; const p=buildPin({provider:"github",host:"github.com",owner:"o",repository:"r"},"a".repeat(40),[{path:".pi/prompts/a",class:"carried",bytes:Buffer.alloc(0)}]); assert.equal(parsePin(encodePin(p)).manifest[0].size,0n);`,
		);
		kill(
			"schema-version",
			"pin.ts",
			"raw.schemaVersion !== 1n",
			"false",
			`import assert from "node:assert/strict"; import {buildPin,encodePin,parsePin} from "./install/pin.ts"; const p=buildPin({provider:"github",host:"github.com",owner:"o",repository:"r"},"a".repeat(40),[]); assert.throws(()=>parsePin(encodePin(p).replace('"schemaVersion":1','"schemaVersion":2')));`,
		);
		kill(
			"carried-aggregate",
			"pin.ts",
			"carriedDigest !== aggregate(manifest, true)",
			"false",
			`import assert from "node:assert/strict"; import {buildPin,encodePin,parsePin} from "./install/pin.ts"; const p=buildPin({provider:"github",host:"github.com",owner:"o",repository:"r"},"a".repeat(40),[{path:".pi/prompts/a",class:"carried",bytes:Buffer.from("a")}]); assert.throws(()=>parsePin(encodePin(p).replace('"carriedDigest":"'+p.carriedDigest+'"','"carriedDigest":"'+"0".repeat(64)+'"')));`,
		);
		kill(
			"payload-aggregate",
			"pin.ts",
			"payloadDigest !== aggregate(manifest, false)",
			"false",
			`import assert from "node:assert/strict"; import {buildPin,encodePin,parsePin} from "./install/pin.ts"; const p=buildPin({provider:"github",host:"github.com",owner:"o",repository:"r"},"a".repeat(40),[]); assert.throws(()=>parsePin(encodePin(p).replace(p.payloadDigest,"0".repeat(64))));`,
		);
	});

	it("kills changed-source, class-transition, replace, and whole-refusal mutants", () => {
		kill(
			"global-refusal-union",
			"plan.ts",
			"const members = [...new Set([...oldByPath.keys(), ...nextByPath.keys()])]",
			"const members = [...new Set([...nextByPath.keys()])]",
			`${pinSetup} const prior=buildPin({...source,owner:"x"},"a".repeat(40),[member(".pi/prompts/prior","carried","old")]); const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:Buffer.from(encodePin(prior)),occupants:occupants("old")}); assert.ok(p.members.some(x=>x.path===".pi/prompts/prior"));`,
		);
		kill(
			"changed-source",
			"plan.ts",
			"!sourceEqual(prior.source, next.source)",
			"false",
			`${pinSetup} const foreign=buildPin({...source,owner:"x"},"a".repeat(40),oldPin.manifest.map(e=>({path:e.path,class:e.class,bytes:Buffer.from("old")}))); const observed=occupants("old"); observed.set(".pi/gitjig.pin.json",{kind:"bytes",bytes:Buffer.from(encodePin(foreign))}); const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:Buffer.from(encodePin(foreign)),occupants:observed}); assert.equal(p.outcome,"refused");`,
		);
		kill(
			"class-transition",
			"plan.ts",
			"nextEntry && nextEntry.class !== old.class",
			"false",
			`${pinSetup} const switched=buildPin(source,"b".repeat(40),[member(".githooks/a","carried","new")]); const p=planComposition({nextPinBytes:Buffer.from(encodePin(switched)),priorPinBytes:Buffer.from(encodePin(oldPin)),occupants:occupants("old")}); assert.equal(p.outcome,"refused");`,
		);
		kill(
			"exact-old-replace",
			"plan.ts",
			'action: "replace", cause: "exact-old"',
			'action: "converged", cause: "exact-old"',
			`${pinSetup} const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:Buffer.from(encodePin(oldPin)),occupants:occupants("old")}); assert.equal(p.members[0].action,"replace");`,
		);
		kill(
			"whole-refusal",
			"plan.ts",
			'members.some((member) => member.action === "refuse")',
			"false",
			`${pinSetup} const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:Buffer.from(encodePin(oldPin)),occupants:occupants("foreign")}); assert.equal(p.outcome,"refused");`,
		);
	});

	it("kills unmeasured, pin-transition, and final-verification mutants", () => {
		kill(
			"sealed-plan-members",
			"plan.ts",
			"Object.freeze(members.map((member) => Object.freeze({ ...member })))",
			"members.map((member) => Object.freeze({ ...member }))",
			`${pinSetup} const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:Buffer.from(encodePin(oldPin)),occupants:occupants("old")}); assert.throws(()=>p.members.pop());`,
		);
		kill(
			"unmeasured-member",
			"plan.ts",
			"if (!occupant) {",
			"if (false) {",
			`${pinSetup} const states=occupants("old"); states.delete(".githooks/a"); const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:Buffer.from(encodePin(oldPin)),occupants:states}); assert.equal(p.outcome,"refused");`,
		);
		kill(
			"pin-initial-cause",
			"plan.ts",
			'cause: "pin-initial"',
			'cause: "foreign-occupant"',
			`${pinSetup} const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:null,occupants:new Map([[".githooks/a",{kind:"absent"}],[".pi/gitjig.pin.json",{kind:"absent"}]])}); assert.equal(p.members.at(-1).cause,"pin-initial");`,
		);
		kill(
			"pin-next-cause",
			"plan.ts",
			'cause: "pin-exact-next"',
			'cause: "foreign-occupant"',
			`${pinSetup} const states=occupants("new"); states.set(".pi/gitjig.pin.json",{kind:"bytes",bytes:Buffer.from(encodePin(nextPin))}); const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:Buffer.from(encodePin(oldPin)),occupants:states}); assert.equal(p.members.at(-1).cause,"pin-exact-next");`,
		);
		kill(
			"retirement-verification",
			"plan.ts",
			'occupants.get(member.path)?.kind !== "absent"',
			"!occupants.has(member.path)",
			`import assert from "node:assert/strict"; import {buildPin,encodePin} from "./install/pin.ts"; import {planComposition,verifyPlannedState} from "./install/plan.ts"; const s={provider:"github",host:"github.com",owner:"o",repository:"r"}; const old=buildPin(s,"a".repeat(40),[{path:".pi/prompts/gone",class:"carried",bytes:Buffer.from("old")}]); const next=buildPin(s,"b".repeat(40),[]); const p=planComposition({nextPinBytes:Buffer.from(encodePin(next)),priorPinBytes:Buffer.from(encodePin(old)),occupants:new Map([[".pi/prompts/gone",{kind:"bytes",bytes:Buffer.from("old")}],[".pi/gitjig.pin.json",{kind:"bytes",bytes:Buffer.from(encodePin(old))}]])}); const final=new Map([[".pi/prompts/gone",{kind:"bytes",bytes:Buffer.from("foreign")}],[".pi/gitjig.pin.json",{kind:"bytes",bytes:Buffer.from(encodePin(next))}]]); assert.equal(verifyPlannedState(p,final,Buffer.from(encodePin(next))),"refused");`,
		);
		kill(
			"pin-replace",
			"plan.ts",
			'action: "replace", cause: "pin-exact-old"',
			'action: "converged", cause: "pin-exact-old"',
			`${pinSetup} const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:Buffer.from(encodePin(oldPin)),occupants:occupants("old")}); assert.equal(p.members.at(-1).action,"replace");`,
		);
		kill(
			"verify-pin-bytes",
			"plan.ts",
			"digest(pinBytes) !== plan.pinDigest",
			"false",
			`${pinSetup} const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:Buffer.from(encodePin(oldPin)),occupants:occupants("old")}); const alias=buildPin(source,"c".repeat(40),[member(".githooks/a","handed-over","new")]); const final=new Map([[".githooks/a",{kind:"bytes",bytes:Buffer.from("new")}],[".pi/gitjig.pin.json",{kind:"bytes",bytes:Buffer.from(encodePin(alias))}]]); assert.equal(verifyPlannedState(p,final,Buffer.from(encodePin(alias))),"refused");`,
		);
		kill(
			"verify-payload",
			"plan.ts",
			"pin.payloadDigest !== plan.nextPayloadDigest",
			"false",
			`${pinSetup} const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:Buffer.from(encodePin(oldPin)),occupants:occupants("old")}); const forged={...p,pinDigest:(await import("node:crypto")).createHash("sha256").update(encodePin(oldPin)).digest("hex")}; const final=new Map([[".githooks/a",{kind:"bytes",bytes:Buffer.from("old")}],[".pi/gitjig.pin.json",{kind:"bytes",bytes:Buffer.from(encodePin(oldPin))}]]); assert.equal(verifyPlannedState(forged,final,Buffer.from(encodePin(oldPin))),"refused");`,
		);
		kill(
			"verify-member",
			"plan.ts",
			"!occupant || !matches(occupant, entry)",
			"false",
			`${pinSetup} const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:Buffer.from(encodePin(oldPin)),occupants:occupants("old")}); const final=new Map([[".githooks/a",{kind:"bytes",bytes:Buffer.from("foreign")}],[".pi/gitjig.pin.json",{kind:"bytes",bytes:Buffer.from(encodePin(nextPin))}]]); assert.equal(verifyPlannedState(p,final,Buffer.from(encodePin(nextPin))),"refused");`,
		);
	});
});

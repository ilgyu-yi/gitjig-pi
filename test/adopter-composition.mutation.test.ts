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
	const baselineBox = mkdtempSync(join(root, `${name}-baseline-`));
	cpSync(join(repository, ".pi/extensions/gitjig/install"), join(baselineBox, "install"), { recursive: true });
	writeFileSync(join(baselineBox, "probe.mjs"), assertion);
	const baseline = spawnSync(process.execPath, [join(baselineBox, "probe.mjs")], { encoding: "utf8" });
	assert.equal(baseline.status, 0, `${name}: probe fails without mutation\n${baseline.stdout}\n${baseline.stderr}`);
	const box = mkdtempSync(join(root, `${name}-mutant-`));
	cpSync(join(repository, ".pi/extensions/gitjig/install"), join(box, "install"), { recursive: true });
	const target = join(box, "install", file);
	const source = readFileSync(target, "utf8");
	assert.equal(source.split(from).length, 2, `${name}: mutant target is not unique`);
	writeFileSync(join(box, "probe.mjs"), assertion);
	writeFileSync(target, source.replace(from, to));
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
			"candidate-root",
			"classifier.ts",
			"!CANDIDATE_ROOTS.includes(parts[0] as (typeof CANDIDATE_ROOTS)[number])",
			"false",
			`import assert from "node:assert/strict"; import {classifyCandidate} from "./install/classifier.ts"; assert.throws(()=>classifyCandidate("outside/file",Buffer.from("x")));`,
		);
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
			`import assert from "node:assert/strict"; import {mkdirSync,writeFileSync,renameSync,symlinkSync,rmSync} from "node:fs"; import {join} from "node:path"; import {observeCandidates} from "./install/classifier.ts"; const root=join(import.meta.dirname,"source"); mkdirSync(join(root,".github"),{recursive:true}); const file=join(root,".github/a"),outside=join(root,"outside"); writeFileSync(file,"in"); writeFileSync(outside,"out"); assert.throws(()=>observeCandidates(root,{afterLstat(p){if(p===".github/a"){renameSync(file,outside+"-checked");symlinkSync(outside+"-checked",file)}},afterRead(p){if(p===".github/a"){rmSync(file);renameSync(outside+"-checked",file)}}}));`,
		);
		kill(
			"opened-identity",
			"classifier.ts",
			"!sameObject(stats, opened)",
			"false",
			`import assert from "node:assert/strict"; import {mkdirSync,writeFileSync,rmSync} from "node:fs"; import {join} from "node:path"; import {observeCandidates} from "./install/classifier.ts"; const root=join(import.meta.dirname,"source"); mkdirSync(join(root,".github"),{recursive:true}); const file=join(root,".github/a"); writeFileSync(file,"old"); assert.throws(()=>observeCandidates(root,{afterLstat(p){if(p===".github/a"){rmSync(file);writeFileSync(file,"new")}}}));`,
		);
		kill(
			"post-pathname-identity",
			"classifier.ts",
			"!sameObject(opened, lstatSync(childAbs))",
			"false",
			`import assert from "node:assert/strict"; import {mkdirSync,writeFileSync,renameSync} from "node:fs"; import {join} from "node:path"; import {observeCandidates} from "./install/classifier.ts"; const root=join(import.meta.dirname,"source"),d=join(root,".github"),f=join(d,"a"),old=join(root,"old"); mkdirSync(d,{recursive:true}); writeFileSync(f,"old"); assert.throws(()=>observeCandidates(root,{afterRead(){renameSync(f,old);writeFileSync(f,"new")}}));`,
		);
		kill(
			"directory-membership",
			"classifier.ts",
			"beforeNames.length !== afterNames.length",
			"false",
			`import assert from "node:assert/strict"; import {mkdirSync,writeFileSync} from "node:fs"; import {join} from "node:path"; import {observeCandidates} from "./install/classifier.ts"; const root=join(import.meta.dirname,"source"),d=join(root,".github"); mkdirSync(d,{recursive:true}); writeFileSync(join(d,"a"),"a"); assert.throws(()=>observeCandidates(root,{afterDirectoryRead(p){if(p===".github")writeFileSync(join(d,"b"),"b")}}));`,
		);
		kill(
			"snapshot-byte-order",
			"classifier.ts",
			"const sorted = [...members].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));",
			"const sorted = [...members].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);",
			`import assert from "node:assert/strict"; import {renderMembershipSnapshot} from "./install/classifier.ts"; const m=JSON.parse(renderMembershipSnapshot([{path:".github/\\u{10000}",disposition:"handed-over"},{path:".github/\\ue000",disposition:"handed-over"}])).members; assert.equal(m[0].path,".github/\\ue000");`,
		);
		kill(
			"post-directory-identity",
			"classifier.ts",
			"!sameObject(before, after)",
			"false",
			`import assert from "node:assert/strict"; import {mkdirSync,writeFileSync,renameSync} from "node:fs"; import {join} from "node:path"; import {observeCandidates} from "./install/classifier.ts"; const root=join(import.meta.dirname,"source"),d=join(root,".github"); mkdirSync(d,{recursive:true}); writeFileSync(join(d,"a"),"x"); assert.throws(()=>observeCandidates(root,{afterDirectoryRead(p){if(p===".github"){renameSync(d,d+"-old");mkdirSync(d);writeFileSync(join(d,"a"),"x")}}}));`,
		);
		kill(
			"snapshot-disposition",
			"classifier.ts",
			"!DISPOSITIONS.includes(member.disposition)",
			"false",
			`import assert from "node:assert/strict"; import {renderMembershipSnapshot} from "./install/classifier.ts"; assert.throws(()=>renderMembershipSnapshot([{path:".github/a",disposition:"invalid"}]));`,
		);
		kill(
			"manifest-order",
			"pin.ts",
			"Buffer.compare(Buffer.from(previous.path), Buffer.from(current.path)) >= 0",
			"false",
			`import assert from "node:assert/strict"; import {buildPin,encodePin,parsePin,digestRecord} from "./install/pin.ts"; import {createHash} from "node:crypto"; const s={provider:"github",host:"github.com",owner:"o",repository:"r"}; const p=buildPin(s,"a".repeat(40),[{path:".github/a",class:"handed-over",bytes:Buffer.from("a")},{path:".githooks/b",class:"handed-over",bytes:Buffer.from("b")}]); p.manifest.reverse(); p.payloadDigest=createHash("sha256").update(Buffer.concat(p.manifest.map(digestRecord))).digest("hex"); const text=JSON.stringify(p,(_,v)=>typeof v==="bigint"?Number(v):v); assert.throws(()=>parsePin(text));`,
		);
		kill(
			"parser-reserved-pin-path",
			"pin.ts",
			'if (path === GENERATED_PIN_PATH) throw new PinRefusal("manifest path is reserved for the generated pin");',
			'if (false) throw new PinRefusal("manifest path is reserved for the generated pin");',
			`import assert from "node:assert/strict"; import {createHash} from "node:crypto"; import {buildPin,digestRecord,encodePin,parsePin} from "./install/pin.ts"; const p=buildPin({provider:"github",host:"github.com",owner:"o",repository:"r"},"a".repeat(40),[{path:".pi/prompts/a",class:"carried",bytes:Buffer.from("x")}]),e={...p.manifest[0],path:".pi/gitjig.pin.json"},h=createHash("sha256").update(digestRecord(e)).digest("hex"); assert.throws(()=>parsePin(encodePin(p).replace(".pi/prompts/a",e.path).replaceAll(p.payloadDigest,h)));`,
		);
		kill(
			"build-pin-byte-order",
			"pin.ts",
			"Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))",
			"a.path < b.path ? -1 : a.path > b.path ? 1 : 0",
			`import assert from "node:assert/strict"; import {buildPin} from "./install/pin.ts"; const p=buildPin({provider:"github",host:"github.com",owner:"o",repository:"r"},"a".repeat(40),[{path:".github/\\u{10000}",class:"handed-over",bytes:Buffer.from("a")},{path:".github/\\ue000",class:"handed-over",bytes:Buffer.from("b")}]); assert.equal(p.manifest[0].path,".github/\\ue000");`,
		);
		kill(
			"source-empty-name",
			"pin.ts",
			"value.length > 0",
			"true",
			`import assert from "node:assert/strict"; import {buildPin} from "./install/pin.ts"; assert.throws(()=>buildPin({provider:"github",host:"github.com",owner:"",repository:"r"},"a".repeat(40),[]));`,
		);
		kill(
			"source-nfc-name",
			"pin.ts",
			'value === value.normalize("NFC")',
			"true",
			`import assert from "node:assert/strict"; import {buildPin} from "./install/pin.ts"; assert.throws(()=>buildPin({provider:"github",host:"github.com",owner:"e\\u0301",repository:"r"},"a".repeat(40),[]));`,
		);
		kill(
			"reserved-pin-path",
			"pin.ts",
			"input.path === GENERATED_PIN_PATH",
			"false",
			`import assert from "node:assert/strict"; import {buildPin} from "./install/pin.ts"; assert.throws(()=>buildPin({provider:"github",host:"github.com",owner:"o",repository:"r"},"a".repeat(40),[{path:".pi/gitjig.pin.json",class:"carried",bytes:Buffer.from("x")}]))`,
		);
		kill(
			"manifest-path-domain",
			"pin.ts",
			"validateCandidatePath(path);",
			"void path;",
			`import assert from "node:assert/strict"; import {createHash} from "node:crypto"; import {buildPin,digestRecord,encodePin,parsePin} from "./install/pin.ts"; const p=buildPin({provider:"github",host:"github.com",owner:"o",repository:"r"},"a".repeat(40),[{path:".pi/prompts/a",class:"carried",bytes:Buffer.from("x")}]); const e={...p.manifest[0],path:"../x"},h=createHash("sha256").update(digestRecord(e)).digest("hex"); assert.throws(()=>parsePin(encodePin(p).replace(".pi/prompts/a","../x").replaceAll(p.payloadDigest,h)));`,
		);
		kill(
			"source-percent-name",
			"pin.ts",
			'!value.includes("%")',
			"true",
			`import assert from "node:assert/strict"; import {buildPin,encodePin,parsePin} from "./install/pin.ts"; assert.throws(()=>buildPin({provider:"github",host:"github.com",owner:"bad%name",repository:"r"},"a".repeat(40),[]));`,
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
			"strict-pin-utf8",
			"plan.ts",
			"pinUtf8.decode(bytes)",
			'bytes.toString("utf8")',
			`import assert from "node:assert/strict"; import {buildPin,encodePin} from "./install/pin.ts"; import {planComposition} from "./install/plan.ts"; const p=Buffer.from(encodePin(buildPin({provider:"github",host:"github.com",owner:"\\ufffd",repository:"r"},"a".repeat(40),[]))),i=p.indexOf(Buffer.from("\\ufffd")),bad=Buffer.concat([p.subarray(0,i),Buffer.from([255]),p.subarray(i+3)]); assert.equal(planComposition({nextPinBytes:bad,priorPinBytes:null,occupants:new Map()}).members[0].cause,"malformed-next-pin");`,
		);
		kill(
			"malformed-next-pin",
			"plan.ts",
			"} catch {\n\t\treturn Object.freeze({",
			"} catch (error) {\n\t\tthrow error;\n\t\treturn Object.freeze({",
			`import assert from "node:assert/strict"; import {planComposition} from "./install/plan.ts"; const p=planComposition({nextPinBytes:Buffer.from("{"),priorPinBytes:null,occupants:new Map()}); assert.equal(p.outcome,"refused");`,
		);
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

	it("kills composed ownership and every fixed member-cause mutant", () => {
		const composeSetup = `import assert from "node:assert/strict"; import {mkdirSync,writeFileSync} from "node:fs"; import {join} from "node:path"; import {composeAdopter} from "./install/compose.ts"; const root=join(import.meta.dirname,"source"); mkdirSync(join(root,".pi/prompts"),{recursive:true}); mkdirSync(join(root,".githooks"),{recursive:true}); writeFileSync(join(root,".pi/prompts/a"),"a"); writeFileSync(join(root,".githooks/a"),"a"); const occupants=new Map([[".pi/prompts/a",{kind:"absent"}],[".githooks/a",{kind:"absent"}],[".pi/gitjig.pin.json",{kind:"absent"}]]); const r=composeAdopter({sourceRoot:root,source:{provider:"github",host:"github.com",owner:"o",repository:"r"},revision:"a".repeat(40),priorPinBytes:null,occupants});`;
		kill(
			"compose-snapshot-disposition",
			"compose.ts",
			"({ path, disposition }) => ({ path, disposition })",
			'({ path, disposition }) => ({ path, disposition: path.startsWith(".pi/") ? "handed-over" : disposition })',
			`${composeSetup} assert.deepEqual(JSON.parse(r.membershipSnapshot).members,r.candidates.map(({path,disposition})=>({path,disposition})));`,
		);
		kill(
			"compose-manifest-class",
			"compose.ts",
			"class: candidate.disposition",
			'class: "carried"',
			`${composeSetup} assert.equal(r.pin.manifest.find(x=>x.path===".githooks/a").class,"handed-over");`,
		);
		kill(
			"cause-initial-absent",
			"plan.ts",
			'if (occupant.kind === "absent") members.push({ path, class: cls, action: "land", cause: "initial-absent" });',
			'if (occupant.kind === "absent") members.push({ path, class: cls, action: "land", cause: "foreign-occupant" });',
			`${pinSetup} const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:null,occupants:new Map([[".githooks/a",{kind:"absent"}],[".pi/gitjig.pin.json",{kind:"absent"}]])}); assert.equal(p.members[0].cause,"initial-absent");`,
		);
		kill(
			"cause-initial-exact-next",
			"plan.ts",
			'else if (matches(occupant, next)) members.push({ path, class: cls, action: "converged", cause: "exact-next" });',
			'else if (matches(occupant, next)) members.push({ path, class: cls, action: "converged", cause: "foreign-occupant" });',
			`${pinSetup} const states=new Map([[".githooks/a",{kind:"bytes",bytes:Buffer.from("new")}],[".pi/gitjig.pin.json",{kind:"bytes",bytes:Buffer.from(encodePin(nextPin))}]]); const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:null,occupants:states}); assert.equal(p.members[0].cause,"exact-next");`,
		);
		kill(
			"cause-added-initial",
			"plan.ts",
			'else if (!old && next && occupant.kind === "absent")\n\t\t\tmembers.push({ path, class: cls, action: "land", cause: "initial-absent" });',
			'else if (!old && next && occupant.kind === "absent")\n\t\t\tmembers.push({ path, class: cls, action: "land", cause: "foreign-occupant" });',
			`import assert from "node:assert/strict"; import {buildPin,encodePin} from "./install/pin.ts"; import {planComposition} from "./install/plan.ts"; const s={provider:"github",host:"github.com",owner:"o",repository:"r"}; const old=buildPin(s,"a".repeat(40),[]),next=buildPin(s,"b".repeat(40),[{path:".pi/prompts/a",class:"carried",bytes:Buffer.from("x")}]); const p=planComposition({nextPinBytes:Buffer.from(encodePin(next)),priorPinBytes:Buffer.from(encodePin(old)),occupants:new Map([[".pi/prompts/a",{kind:"absent"}],[".pi/gitjig.pin.json",{kind:"bytes",bytes:Buffer.from(encodePin(old))}]])}); assert.equal(p.members[0].cause,"initial-absent");`,
		);
		kill(
			"cause-exact-next",
			"plan.ts",
			'if (next && matches(occupant, next)) members.push({ path, class: cls, action: "converged", cause: "exact-next" });',
			'if (next && matches(occupant, next)) members.push({ path, class: cls, action: "converged", cause: "foreign-occupant" });',
			`${pinSetup} const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:Buffer.from(encodePin(oldPin)),occupants:occupants("new")}); assert.equal(p.members[0].cause,"exact-next");`,
		);
		kill(
			"cause-exact-old",
			"plan.ts",
			'action: "replace", cause: "exact-old"',
			'action: "replace", cause: "foreign-occupant"',
			`${pinSetup} const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:Buffer.from(encodePin(oldPin)),occupants:occupants("old")}); assert.equal(p.members[0].cause,"exact-old");`,
		);
		kill(
			"cause-retire-exact-old",
			"plan.ts",
			'action: "retire", cause: "exact-old"',
			'action: "retire", cause: "foreign-occupant"',
			`import assert from "node:assert/strict"; import {buildPin,encodePin} from "./install/pin.ts"; import {planComposition} from "./install/plan.ts"; const s={provider:"github",host:"github.com",owner:"o",repository:"r"}; const old=buildPin(s,"a".repeat(40),[{path:".pi/prompts/a",class:"carried",bytes:Buffer.from("x")}]),next=buildPin(s,"b".repeat(40),[]); const p=planComposition({nextPinBytes:Buffer.from(encodePin(next)),priorPinBytes:Buffer.from(encodePin(old)),occupants:new Map([[".pi/prompts/a",{kind:"bytes",bytes:Buffer.from("x")}],[".pi/gitjig.pin.json",{kind:"bytes",bytes:Buffer.from(encodePin(old))}]])}); assert.equal(p.members[0].cause,"exact-old");`,
		);
		kill(
			"cause-already-retired",
			"plan.ts",
			'action: "converged", cause: "already-retired"',
			'action: "converged", cause: "foreign-occupant"',
			`import assert from "node:assert/strict"; import {buildPin,encodePin} from "./install/pin.ts"; import {planComposition} from "./install/plan.ts"; const s={provider:"github",host:"github.com",owner:"o",repository:"r"}; const old=buildPin(s,"a".repeat(40),[{path:".pi/prompts/gone",class:"carried",bytes:Buffer.from("x")}]),next=buildPin(s,"b".repeat(40),[]); const p=planComposition({nextPinBytes:Buffer.from(encodePin(next)),priorPinBytes:Buffer.from(encodePin(old)),occupants:new Map([[".pi/prompts/gone",{kind:"absent"}],[".pi/gitjig.pin.json",{kind:"bytes",bytes:Buffer.from(encodePin(old))}]])}); assert.equal(p.members[0].cause,"already-retired");`,
		);
		kill(
			"cause-malformed-prior",
			"plan.ts",
			'globalRefusal(next, input.nextPinBytes, "malformed-prior-pin")',
			'globalRefusal(next, input.nextPinBytes, "foreign-occupant")',
			`${pinSetup} const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:Buffer.from("{"),occupants:occupants("old")}); assert.ok(p.members.every(x=>x.cause==="malformed-prior-pin"));`,
		);
		kill(
			"cause-changed-source",
			"plan.ts",
			'"changed-source", prior',
			'"foreign-occupant", prior',
			`${pinSetup} const prior=buildPin({...source,owner:"x"},"a".repeat(40),[]); const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:Buffer.from(encodePin(prior)),occupants:occupants("old")}); assert.ok(p.members.every(x=>x.cause==="changed-source"));`,
		);
		kill(
			"cause-class-transition",
			"plan.ts",
			'"class-transition", prior',
			'"foreign-occupant", prior',
			`${pinSetup} const prior=buildPin(source,"a".repeat(40),[member(".githooks/a","carried","old")]); const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:Buffer.from(encodePin(prior)),occupants:occupants("old")}); assert.ok(p.members.every(x=>x.cause==="class-transition"));`,
		);
	});

	it("kills unmeasured, pin-transition, and final-verification mutants", () => {
		kill(
			"planner-member-class",
			"plan.ts",
			"const cls = next?.class ?? old?.class;",
			'const cls = "handed-over" as const;',
			`${pinSetup} const added=buildPin(source,"b".repeat(40),[member(".pi/prompts/a","carried","new")]); const p=planComposition({nextPinBytes:Buffer.from(encodePin(added)),priorPinBytes:null,occupants:new Map([[".pi/prompts/a",{kind:"absent"}],[".pi/gitjig.pin.json",{kind:"absent"}]])}); assert.equal(p.members[0].class,"carried");`,
		);
		kill(
			"initial-foreign-pin",
			"plan.ts",
			'!prior && pinOccupant.kind === "absent"',
			"!prior",
			`${pinSetup} const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:null,occupants:new Map([[".githooks/a",{kind:"bytes",bytes:Buffer.from("new")}],[".pi/gitjig.pin.json",{kind:"bytes",bytes:Buffer.from("foreign")}]] )}); assert.equal(p.outcome,"refused");`,
		);
		kill(
			"verify-malformed-pin",
			"plan.ts",
			'} catch {\n\t\treturn "refused";\n\t}',
			"} catch (error) {\n\t\tthrow error;\n\t}",
			`import assert from "node:assert/strict"; import {createHash} from "node:crypto"; import {buildPin,encodePin} from "./install/pin.ts"; import {planComposition,verifyPlannedState} from "./install/plan.ts"; const p0=buildPin({provider:"github",host:"github.com",owner:"o",repository:"r"},"a".repeat(40),[]),bytes=Buffer.from(encodePin(p0)),p=planComposition({nextPinBytes:bytes,priorPinBytes:null,occupants:new Map([[".pi/gitjig.pin.json",{kind:"absent"}]])}),bad=Buffer.from("{"),forged={...p,pinDigest:createHash("sha256").update(bad).digest("hex")}; assert.equal(verifyPlannedState(forged,new Map([[".pi/gitjig.pin.json",{kind:"bytes",bytes:bad}]]),bad),"refused");`,
		);
		kill(
			"initial-exact-pin",
			"plan.ts",
			"bytesEqual(pinOccupant, input.nextPinBytes)",
			"prior !== null && bytesEqual(pinOccupant, input.nextPinBytes)",
			`${pinSetup} const states=new Map([[".githooks/a",{kind:"bytes",bytes:Buffer.from("new")}],[".pi/gitjig.pin.json",{kind:"bytes",bytes:Buffer.from(encodePin(nextPin))}]]); const p=planComposition({nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:null,occupants:states}); assert.equal(p.outcome,"converged");`,
		);
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

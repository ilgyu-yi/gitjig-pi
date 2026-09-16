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
import { planComposition } from "./install/plan.ts";
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

	it("kills changed-source, class-transition, replace, and whole-refusal mutants", () => {
		kill(
			"changed-source",
			"plan.ts",
			"!sourceEqual(prior.source, input.nextPin.source)",
			"false",
			`${pinSetup} const foreign=buildPin({...source,owner:"x"},"a".repeat(40),oldPin.manifest.map(e=>({path:e.path,class:e.class,bytes:Buffer.from("old")}))); const observed=occupants("old"); observed.set(".pi/gitjig.pin.json",{kind:"bytes",bytes:Buffer.from(encodePin(foreign))}); const p=planComposition({nextPin,nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:Buffer.from(encodePin(foreign)),occupants:observed}); assert.equal(p.outcome,"refused");`,
		);
		kill(
			"class-transition",
			"plan.ts",
			"next && next.class !== old.class",
			"false",
			`${pinSetup} const switched=buildPin(source,"b".repeat(40),[member(".githooks/a","carried","new")]); const p=planComposition({nextPin:switched,nextPinBytes:Buffer.from(encodePin(switched)),priorPinBytes:Buffer.from(encodePin(oldPin)),occupants:occupants("old")}); assert.equal(p.outcome,"refused");`,
		);
		kill(
			"exact-old-replace",
			"plan.ts",
			'action: "replace", cause: "exact-old"',
			'action: "converged", cause: "exact-old"',
			`${pinSetup} const p=planComposition({nextPin,nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:Buffer.from(encodePin(oldPin)),occupants:occupants("old")}); assert.equal(p.members[0].action,"replace");`,
		);
		kill(
			"whole-refusal",
			"plan.ts",
			'members.some((member) => member.action === "refuse")',
			"false",
			`${pinSetup} const p=planComposition({nextPin,nextPinBytes:Buffer.from(encodePin(nextPin)),priorPinBytes:Buffer.from(encodePin(oldPin)),occupants:occupants("foreign")}); assert.equal(p.outcome,"refused");`,
		);
	});
});

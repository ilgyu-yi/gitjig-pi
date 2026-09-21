import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

const repository = join(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "gitjig-317-mutants-"));
after(() => rmSync(root, { recursive: true, force: true }));

const files = [
	".github/workflows/gitjig-governance.mjs",
	".github/workflows/gitjig-governance-service.mjs",
	".pi/extensions/gitjig/commands/governance.ts",
] as const;

const probe = `
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {CAPABILITIES,GOVERNANCE_BOUNDS,GOVERNANCE_OVERHEADS,auditGovernance,canonicalJson,parseGovernanceConfig,planGovernance} from "./.github/workflows/gitjig-governance.mjs";
import {admitConfirmation,confirmationPresentation,createGovernanceService} from "./.github/workflows/gitjig-governance-service.mjs";
import {governanceMessage} from "./.pi/extensions/gitjig/commands/governance.ts";
assert.deepEqual(GOVERNANCE_BOUNDS,{config:32768,measured:65536,plan:262144,audit:131072,applyResult:491520,presentation:327680,piRecord:524288});
assert.deepEqual(GOVERNANCE_OVERHEADS,{audit:32768,result:32768,presentation:32768});
const config=parseGovernanceConfig(readFileSync(".github/gitjig-governance.json"));
const off={mergeCommits:false,squashMerging:false,rebaseMerging:false,rulesetEnforcement:"disabled",administratorBypass:[],allowedMergeMethods:[],requiredApprovingReviews:0,dismissStaleReviews:false,requiredReviewers:[],codeOwnerReview:false,lastPushApproval:false,reviewThreadResolution:false,extraApprovalForUnattributedChanges:false,strictRequiredStatusChecks:false,doNotEnforceOnCreate:false,requiredStatusChecks:[],deletionProtection:false,nonFastForwardProtection:false,requiredLinearHistory:false};
const capabilities=Object.fromEntries(CAPABILITIES.map(name=>{const choice=config.capabilities[name];return [name,choice.mode==="selected"?structuredClone(choice.value):off[name]]}));
const measured={schemaVersion:2,repository:{...config.repository,defaultBranchSha:"a".repeat(40)},rulesets:[{id:7,name:config.ruleset.name,target:"branch",sourceType:"Repository",source:config.repository.nameWithOwner,include:config.ruleset.include,exclude:config.ruleset.exclude,ruleTypes:["pull_request","required_status_checks","deletion","non_fast_forward"]}],capabilities};
const plan=planGovernance(config,measured);
auditGovernance(config,measured);
confirmationPresentation(config.repository.nameWithOwner,plan);
const service=createGovernanceService();
const confirmation=admitConfirmation("pi",config.repository.nameWithOwner+" "+plan.planHash,config.repository.nameWithOwner,plan,"probe");
const result=await service.apply({config,plan,confirmation},{readMeasured:async()=>structuredClone(measured),writeOperation:async()=>({outcome:"acknowledged"})});
assert.equal(result.outcome,"applied");
governanceMessage({outcome:"planned",plan},canonicalJson);
governanceMessage({outcome:"audited",audit:auditGovernance(config,measured)},canonicalJson);
const presentation=confirmationPresentation(config.repository.nameWithOwner,plan);
governanceMessage({outcome:"presented",attemptId:"probe",...presentation},canonicalJson);
governanceMessage(result,canonicalJson);
governanceMessage({outcome:"refused",arm:"pi-mode"},canonicalJson);
`;

const mutations = [
	[".github/workflows/gitjig-governance.mjs", "audit: 32 * 1024", "audit: 1"],
	[".github/workflows/gitjig-governance.mjs", "result: 32 * 1024", "result: 1"],
	[".github/workflows/gitjig-governance.mjs", "presentation: 32 * 1024", "presentation: 1"],
	[
		".github/workflows/gitjig-governance.mjs",
		"canonicalByteLength(parsedConfig) + canonicalByteLength(parsedMeasured) + GOVERNANCE_OVERHEADS.audit",
		"canonicalByteLength(parsedMeasured) - 999999 + GOVERNANCE_OVERHEADS.audit",
	],
	[
		".github/workflows/gitjig-governance-service.mjs",
		"canonicalByteLength(supplied.operations) + 2",
		"canonicalByteLength(supplied.operations) + 1",
	],
	[
		".github/workflows/gitjig-governance-service.mjs",
		"canonicalByteLength(supplied) + currentBytes + auditBytes + GOVERNANCE_OVERHEADS.result",
		"canonicalByteLength(supplied) - 999999 + auditBytes + GOVERNANCE_OVERHEADS.result",
	],
	[
		".github/workflows/gitjig-governance-service.mjs",
		"canonicalByteLength(candidate) + GOVERNANCE_BOUNDS.config + GOVERNANCE_OVERHEADS.presentation",
		"canonicalByteLength(candidate) - 999999 + GOVERNANCE_OVERHEADS.presentation",
	],
	[".pi/extensions/gitjig/commands/governance.ts", "const PLAN_BOUND = 256 * 1024", "const PLAN_BOUND = 1"],
	[".pi/extensions/gitjig/commands/governance.ts", "const AUDIT_BOUND = 128 * 1024", "const AUDIT_BOUND = 1"],
	[
		".pi/extensions/gitjig/commands/governance.ts",
		"const PRESENTATION_BOUND = 320 * 1024",
		"const PRESENTATION_BOUND = 1",
	],
	[
		".pi/extensions/gitjig/commands/governance.ts",
		"const APPLY_RESULT_BOUND = 480 * 1024",
		"const APPLY_RESULT_BOUND = 1",
	],
	[".pi/extensions/gitjig/commands/governance.ts", "const WRAPPER_OVERHEAD = 1024", "const WRAPPER_OVERHEAD = 1"],
] as const;

function run(name: string, mutation?: (typeof mutations)[number]) {
	const box = join(root, name);
	for (const path of files) {
		const target = join(box, path);
		mkdirSync(dirname(target), { recursive: true });
		cpSync(join(repository, path), target);
	}
	mkdirSync(join(box, ".github"), { recursive: true });
	cpSync(join(repository, ".github/gitjig-governance.json"), join(box, ".github/gitjig-governance.json"));
	symlinkSync(join(repository, "node_modules"), join(box, "node_modules"), "dir");
	if (mutation) {
		const [path, from, to] = mutation;
		const target = join(box, path);
		const source = readFileSync(target, "utf8");
		assert.equal(source.indexOf(from), source.lastIndexOf(from), `mutation operand must be unique: ${from}`);
		assert.notEqual(source.indexOf(from), -1, `mutation operand must exist: ${from}`);
		writeFileSync(target, source.replace(from, to));
	}
	writeFileSync(join(box, "probe.mjs"), probe);
	return spawnSync(process.execPath, ["probe.mjs"], { cwd: box, encoding: "utf8" });
}

describe("governance visibility executable mutation teeth", () => {
	it("admits the unmodified isolated baseline", () => {
		const result = run("baseline");
		assert.equal(result.status, 0, result.stderr);
	});
	for (const [index, mutation] of mutations.entries()) {
		it(`kills isolated mutant ${index + 1}: ${mutation[1]}`, () => {
			const result = run(`mutant-${index}`, mutation);
			assert.notEqual(result.status, 0, "mutant survived focused production probe");
		});
	}
});

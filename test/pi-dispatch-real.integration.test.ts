import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runDispatch } from "../.pi/extensions/gitjig/dispatch/index.ts";
import { provisionPiSubmitTool } from "../.pi/extensions/gitjig/dispatch/pi-submit.ts";
import { reviewerReturnFromPayload } from "../.pi/extensions/gitjig/review/join.ts";
import { REVIEW_PI_PROFILES } from "../.pi/extensions/gitjig/review/pi-profile.ts";

const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MARKER = "PRIVATE_DELEGATE_TEXT_370";

/** Scripted provider is scratch-provisioned solely for this hermetic arm. */
async function realRound(script: unknown[] | ((root: string) => unknown[]), numericWithoutSettle = false) {
	const root = mkdtempSync(join(tmpdir(), "gitjig-370-real-dispatch-"));
	const repo = join(root, "repo");
	const state = join(root, "state");
	const providerDir = join(root, "trusted", "extensions");
	const provider = join(providerDir, "scripted-provider.ts");
	const wrapper = join(root, "pi-wrapper");
	const before = Object.fromEntries(
		["HOME", "PI_CODING_AGENT_DIR", "XDG_STATE_HOME", "PI_OFFLINE"].map((key) => [key, process.env[key]]),
	);
	try {
		for (const dir of [repo, state, providerDir, join(root, "home"), join(root, "agent")])
			mkdirSync(dir, { recursive: true });
		execFileSync("git", ["-C", repo, "init", "-q"]);
		execFileSync("git", ["-C", repo, "config", "user.name", "Fixture"]);
		execFileSync("git", ["-C", repo, "config", "user.email", "fixture@example.invalid"]);
		execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
		execFileSync("git", ["-C", repo, "config", "core.hooksPath", "/dev/null"]);
		writeFileSync(join(repo, "file"), "fixture\n");
		execFileSync("git", ["-C", repo, "add", "file"]);
		execFileSync("git", ["-C", repo, "commit", "-qm", "fixture"]);
		copyFileSync(join(project, "test/harness/scripted-provider.ts"), provider);
		writeFileSync(join(root, "script.json"), JSON.stringify(typeof script === "function" ? script(root) : script));
		// An executable supplied by the caller can load this test-only provider;
		// production Pi discovery remains disabled by the supervisor.
		writeFileSync(
			wrapper,
			numericWithoutSettle
				? `#!/usr/bin/env node
const {spawn}=require('node:child_process');
const child=spawn(${JSON.stringify(join(project, "node_modules", ".bin", "pi"))},[...process.argv.slice(2),'--extension',${JSON.stringify(provider)}],{stdio:['pipe','pipe','inherit']});
process.stdin.pipe(child.stdin);
let pending='';child.stdout.on('data',data=>{
  pending+=data;let at;while((at=pending.indexOf('\\n'))!==-1){
    const line=pending.slice(0,at);pending=pending.slice(at+1);
    if(JSON.parse(line).type==='agent_settled'){
      process.stdin.unpipe(child.stdin);process.stdin.pause();child.stdin.end();
    }else process.stdout.write(line+'\\n');
  }
});
child.on('close',(_code,signal)=>{
  if(pending)process.stdout.write(pending);
  if(signal)process.kill(process.pid,signal);
  else process.stdout.write('',()=>process.exit(17));
});
`
				: `#!/usr/bin/env node\nconst {spawn}=require('node:child_process');\nconst child=spawn(${JSON.stringify(join(project, "node_modules", ".bin", "pi"))},[...process.argv.slice(2),'--extension',${JSON.stringify(provider)}],{stdio:'inherit'});\nchild.on('exit',(code,signal)=>{if(signal) process.kill(process.pid,signal); else process.exit(code??1)});\n`,
		);
		chmodSync(wrapper, 0o700);
		process.env.HOME = join(root, "home");
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		process.env.XDG_STATE_HOME = state;
		process.env.PI_OFFLINE = "1";
		return await runDispatch({
			callerRepoRoot: repo,
			stateRoot: state,
			brief: "Submit a reviewer result with submit_result",
			delegateArgv: [],
			expectedRef: "HEAD",
			timeoutMs: 10_000,
			pi: { piExecutable: wrapper, provider: "scripted", model: "scripted-model", role: "reviewer" },
		});
	} finally {
		for (const [key, value] of Object.entries(before)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
}

test(
	"real Pi child submits through canonical dispatch; operator events never enter the parent result",
	{ timeout: 20000 },
	async () => {
		const result = await realRound([
			{
				kind: "toolCall",
				name: "submit_result",
				arguments: { token: "APPROVED", findings: [], summary: "final OBSERVATION: scoped evidence" },
			},
			{ kind: "text", text: MARKER },
		]);
		assert.equal(result.disposition, "admitted", JSON.stringify(result.diagnostic));
		if (result.disposition === "admitted") {
			assert.equal(result.compare, "confirmed");
			assert.deepEqual(reviewerReturnFromPayload(result.payload), { token: "APPROVED", findings: [] });
			assert.equal(result.summary, "final OBSERVATION: scoped evidence");
		}
		assert.equal(JSON.stringify(result).includes(MARKER), false);
	},
);

test(
	"real submit_result survives a numeric nonzero exit with no forwarded agent_settled",
	{ timeout: 20000 },
	async () => {
		const result = await realRound(
			[{ kind: "toolCall", name: "submit_result", arguments: { token: "APPROVED", findings: [] } }],
			true,
		);
		assert.equal(result.disposition, "admitted", JSON.stringify(result.diagnostic));
		if (result.disposition === "admitted") {
			assert.equal(result.compare, "confirmed");
			assert.equal(result.diagnostic.run.exitCode, 17);
		}
	},
);

test("trusted submit_result refuses a missing clone HEAD without an admitted slot", { timeout: 20000 }, async () => {
	const result = await realRound([
		{ kind: "toolCall", name: "bash", arguments: { command: "rm -f .git/HEAD" } },
		{ kind: "toolCall", name: "submit_result", arguments: { token: "APPROVED", findings: [] } },
		{ kind: "text", text: "unable to resolve HEAD" },
	]);
	assert.equal(result.disposition, "refused");
	assert.equal(result.diagnostic.return.class, "missing");
});

test("trusted tool rejects HEAD leaked through final summary or encoded payload", { timeout: 20000 }, async () => {
	for (const field of ["summary", "payload"] as const) {
		const result = await realRound((root) => {
			const target = JSON.stringify(join(root, "script.json"));
			const assignment =
				field === "summary" ? 'summary:"review " + head' : 'summary:"review-result",findings:["claim " + head]';
			const command = `node -e 'const fs=require("fs"),cp=require("child_process"),p=${target};const turns=JSON.parse(fs.readFileSync(p,"utf8"));const head=cp.execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();turns[1]={kind:"toolCall",name:"submit_result",arguments:{token:${field === "summary" ? '"APPROVED",findings:[]' : '"FINDINGS"'},${assignment}}};fs.writeFileSync(p,JSON.stringify(turns))'`;
			return [
				{ kind: "toolCall", name: "bash", arguments: { command } },
				{ kind: "text", text: "placeholder" },
				{ kind: "text", text: "final" },
			];
		});
		assert.equal(result.disposition, "refused", field);
		assert.equal(result.diagnostic.return.class, "missing", field);
	}
});

/**
 * The trusted tool consumes the dispatcher's ruled scan, so a run shorter than
 * the 7-prefix but at or above MIN_CONTAINED_RUN is rejected too. A second
 * hand-rolled predicate with its own thresholds would drift from this.
 */
test("trusted tool rejects a six-character contained run of the clone head", { timeout: 20000 }, async () => {
	const result = await realRound((root) => {
		const target = JSON.stringify(join(root, "script.json"));
		// The delegate resolves its own clone HEAD and names six of its characters
		// — no full hash and no 7-character prefix anywhere in the submission.
		const command = `node -e 'const fs=require("fs"),cp=require("child_process"),p=${target};const turns=JSON.parse(fs.readFileSync(p,"utf8"));const head=cp.execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();const run=head.slice(10,16);turns[1]={kind:"toolCall",name:"submit_result",arguments:{token:"APPROVED",findings:[],summary:"review near "+run}};fs.writeFileSync(p,JSON.stringify(turns))'`;
		return [
			{ kind: "toolCall", name: "bash", arguments: { command } },
			{ kind: "text", text: "placeholder" },
			{ kind: "text", text: "final" },
		];
	});
	assert.equal(result.disposition, "refused", JSON.stringify(result.diagnostic));
	assert.equal(result.diagnostic.return.class, "missing");
});

test("the provisioned trusted tool carries the ruled operand owner and hand-rolls no threshold", () => {
	const extension = readFileSync(
		new URL("../.pi/extensions/gitjig/dispatch/pi-submit-extension.ts", import.meta.url),
		"utf8",
	);
	// It consumes the one owner instead of restating the rule (SPEC §3.11).
	assert.match(extension, /import \{ namesHeldOperand \} from "\.\/operand\.ts";/);
	assert.match(extension, /namesHeldOperand\(JSON\.stringify\(\{ summary, payload \}\), head\)/);
	assert.equal(/function namesHead\b/.test(extension), false);
	for (const literal of [">= 6", "slice(0, 7)", "{4,}"])
		assert.equal(extension.includes(literal), false, `the tool restates the ruled scan: ${literal}`);
	// And the provisioner puts that owner beside the copied tool, parent-owned
	// and read-only, so the copied `./operand.ts` import resolves in the scratch.
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-370-provision-"));
	try {
		const context = {
			scratchRoot: scratch,
			treeDir: join(scratch, "tree"),
			stateDir: join(scratch, "state"),
			briefPath: join(scratch, "brief.md"),
			returnPath: join(scratch, "return.json"),
			heldHash: "a".repeat(40),
		};
		const installed = provisionPiSubmitTool(context, REVIEW_PI_PROFILES.reviewer);
		const owner = join(dirname(installed), "operand.ts");
		assert.equal(lstatSync(owner).isFile(), true);
		assert.equal(lstatSync(owner).mode & 0o777, 0o600);
		assert.equal(
			readFileSync(owner, "utf8"),
			readFileSync(new URL("../.pi/extensions/gitjig/dispatch/operand.ts", import.meta.url), "utf8"),
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test(
	"same-domain Pi direct-slot residual retains canonical admission, blind compare and consumer parsing",
	{ timeout: 20000 },
	async () => {
		// This is an explicit §4.9 residual, not a recommended submission path:
		// the caller's tool does not attest exclusive authorship in a shared UID.
		const command = `node -e 'const fs=require("node:fs"),cp=require("node:child_process");const head=cp.execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();fs.writeFileSync("../return.json",JSON.stringify({ok:true,summary:"review-result",reviewedHead:head,payload:JSON.stringify({token:"APPROVED",findings:[]})}))'`;
		const result = await realRound([
			{ kind: "toolCall", name: "bash", arguments: { command } },
			{ kind: "text", text: MARKER },
		]);
		assert.equal(result.disposition, "admitted", JSON.stringify(result.diagnostic));
		if (result.disposition === "admitted") {
			assert.equal(result.compare, "confirmed");
			assert.deepEqual(reviewerReturnFromPayload(result.payload), { token: "APPROVED", findings: [] });
		}
		assert.equal(JSON.stringify(result).includes(MARKER), false);
	},
);

test("real Pi settles without submit_result twice; no message becomes a return", { timeout: 20000 }, async () => {
	const result = await realRound([{ kind: "text", text: MARKER }]);
	assert.equal(result.disposition, "refused");
	assert.equal(JSON.stringify(result).includes(MARKER), false);
});

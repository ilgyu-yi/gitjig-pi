import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { namesHeldOperand } from "../.pi/extensions/gitjig/dispatch/operand.ts";
import { startPiRpc } from "../.pi/extensions/gitjig/dispatch/pi-rpc.ts";
import { runPiDelegate } from "../.pi/extensions/gitjig/dispatch/pi-run.ts";
import type { DispatchContext } from "../.pi/extensions/gitjig/dispatch/provision.ts";

test("Pi runner does not spend a second missing-submission prompt inside one run", { timeout: 8000 }, async () => {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-370-one-prompt-"));
	try {
		const tree = join(scratch, "tree");
		const state = join(scratch, "state");
		const fake = join(scratch, "fake-pi");
		mkdirSync(tree);
		mkdirSync(state);
		writeFileSync(
			fake,
			`#!/usr/bin/env node
const fs=require('node:fs');let data='';
process.stdin.on('data',bytes=>{data+=bytes;let at;
 while((at=data.indexOf('\\n'))!==-1){
  const command=JSON.parse(data.slice(0,at));data=data.slice(at+1);
  if(command.type==='prompt'){
   fs.appendFileSync(${JSON.stringify(join(scratch, "prompts"))},'p');
   process.stdout.write(JSON.stringify({type:'response',id:command.id,success:true})+'\\n');
   process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');
  }
 }
});
process.stdin.on('end',()=>process.exit(0));
`,
		);
		chmodSync(fake, 0o700);
		const context: DispatchContext = {
			scratchRoot: scratch,
			treeDir: tree,
			stateDir: state,
			briefPath: join(scratch, "brief.md"),
			returnPath: join(scratch, "return.json"),
			heldHash: "a".repeat(40),
		};
		writeFileSync(
			context.briefPath,
			`Recovery basis includes current head ${context.heldHash}; independently resolve clone HEAD.`,
		);
		const run = await runPiDelegate(
			context,
			{ piExecutable: fake, provider: "scripted", model: "scripted-model", role: "reviewer" },
			{ timeoutMs: 4000 },
		);
		assert.equal(run.exitCode, 0);
		assert.equal(readFileSync(join(scratch, "prompts"), "utf8"), "p");
		assert.equal(readFileSync(context.briefPath, "utf8").includes(context.heldHash), false);
		assert.match(readFileSync(context.briefPath, "utf8"), /\[clone head withheld\]/);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("RPC handles asynchronously reported stdin EPIPE without crashing the host", { timeout: 8000 }, async () => {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-370-epipe-"));
	try {
		const tree = join(scratch, "tree");
		const state = join(scratch, "state");
		const extension = join(scratch, "trusted.ts");
		const fake = join(scratch, "peer-close");
		mkdirSync(tree);
		mkdirSync(state);
		writeFileSync(extension, "// isolated extension placeholder\n");
		writeFileSync(fake, "#!/usr/bin/env node\nprocess.stdin.destroy();setTimeout(()=>process.exit(0),500);\n");
		chmodSync(fake, 0o700);
		const context: DispatchContext = {
			scratchRoot: scratch,
			treeDir: tree,
			stateDir: state,
			briefPath: join(scratch, "brief.md"),
			returnPath: join(scratch, "return.json"),
			heldHash: "a".repeat(40),
		};
		const session = startPiRpc({
			context,
			extensionPath: extension,
			piExecutable: fake,
			provider: "scripted",
			model: "scripted-model",
			prompt: "x".repeat(8192),
			timeoutMs: 3000,
		});
		await new Promise((resolve) => setTimeout(resolve, 80));
		const commands = await Promise.all(Array.from({ length: 16 }, () => session.command("steer", "x".repeat(8192))));
		assert.ok(commands.every((accepted) => !accepted));
		assert.equal(await session.done, "protocol-invalid");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("RPC numeric exit owns lifecycle through orphan-held pipe flush and later abort", { timeout: 8000 }, async () => {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-370-rpc-exit-"));
	const tree = join(scratch, "tree");
	const state = join(scratch, "state");
	const extension = join(scratch, "trusted.ts");
	const fake = join(scratch, "fake-pi");
	try {
		mkdirSync(tree);
		mkdirSync(state);
		writeFileSync(extension, "// trusted scratch placeholder\n");
		writeFileSync(
			fake,
			`#!/usr/bin/env node
const cp=require('node:child_process');let received='';
process.stdin.on('data',v=>{
 received+=v;let at;while((at=received.indexOf('\\n'))!==-1){
  const item=JSON.parse(received.slice(0,at));received=received.slice(at+1);
  if(item.type==='prompt'){
   process.stdout.write(JSON.stringify({type:'response',id:item.id,success:true})+'\\n',()=>{
    const orphan=cp.spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),1600)'],{detached:true,stdio:['ignore',1,'ignore']});
    orphan.unref();process.exit(17);
   });
  }
 }
});
`,
		);
		chmodSync(fake, 0o700);
		const context: DispatchContext = {
			scratchRoot: scratch,
			treeDir: tree,
			stateDir: state,
			briefPath: join(scratch, "brief.md"),
			returnPath: join(scratch, "return.json"),
			heldHash: "a".repeat(40),
		};
		const controller = new AbortController();
		const laterAbort = setTimeout(() => controller.abort(), 1000);
		try {
			const session = startPiRpc({
				context,
				extensionPath: extension,
				piExecutable: fake,
				provider: "scripted",
				model: "scripted-model",
				prompt: "test",
				timeoutMs: 800,
				signal: controller.signal,
			});
			assert.equal(await session.done, "exited");
			assert.equal(session.exitCode, 17);
		} finally {
			clearTimeout(laterAbort);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

/**
 * The Pi brief rides the dispatcher's own ruled held-operand scan, not a second
 * spelling of it. A contained run at MIN_CONTAINED_RUN (issue #104) names the
 * held operand, so such a brief must refuse before any child starts even though
 * it carries no full hash and no 7-character prefix.
 */
test("a contained held-operand run shorter than the 7-prefix refuses the Pi brief", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "gitjig-370-operand-"));
	try {
		const tree = join(scratch, "tree");
		const state = join(scratch, "state");
		mkdirSync(tree);
		mkdirSync(state);
		const held = "0123456789abcdef0123456789abcdef01234567";
		const context: DispatchContext = {
			scratchRoot: scratch,
			treeDir: tree,
			stateDir: state,
			briefPath: join(scratch, "brief.md"),
			returnPath: join(scratch, "return.json"),
			heldHash: held,
		};
		// Six hex characters contained in the held hash, with no full hash and no
		// 7-character prefix anywhere in the text.
		const contained = held.slice(10, 16);
		assert.equal(contained.length, 6);
		assert.equal(held.includes(contained), true);
		assert.equal(contained.includes(held.slice(0, 7)), false);
		const brief = `Earlier state landed at ${contained}; independently resolve clone HEAD.`;
		assert.equal(brief.includes(held), false);
		assert.equal(brief.toLowerCase().includes(held.slice(0, 7)), false);
		// The ruled predicate the return side uses says this names the operand.
		assert.equal(namesHeldOperand(brief, held), true);
		writeFileSync(context.briefPath, brief);
		const run = await runPiDelegate(
			context,
			// An executable that does not exist: reaching a spawn at all would mean
			// the brief had already been handed over.
			{ piExecutable: join(scratch, "never-spawned"), provider: "scripted", model: "scripted-model", role: "reviewer" },
			{ timeoutMs: 4000 },
		);
		assert.equal(run.protocolInvalid, true, JSON.stringify(run));
		assert.equal(run.spawnFailed, false, "the brief must refuse before any child is started");
		// The refused brief is left exactly as the caller wrote it.
		assert.equal(readFileSync(context.briefPath, "utf8"), brief);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "gitjig-266-mutants-"));
after(() => rmSync(root, { recursive: true, force: true }));

const probe = String.raw`
import assert from "node:assert/strict";
import {makeDispatcher} from "./gitjig/review/orchestrate.ts";
const diagnostic=(run,returned)=>({status:"refused",phase:"return",run,return:{class:returned},compare:{class:"not-reached"},durationMs:1,code:"RETURN_MISSING"});
const missing=(code=1)=>({disposition:"refused",diagnostic:diagnostic({class:"exited",exitCode:code,signal:null},"missing")});
const admitted={disposition:"admitted",result:{ok:true,output:"{}",summary:"ok"},compare:"confirmed",diagnostic:{status:"admitted",phase:"complete",run:{class:"exited",exitCode:0,signal:null},return:{class:"admitted"},compare:{class:"confirmed"},durationMs:1,code:"ADMITTED"}};
const options={callerRepoRoot:"/r",stateRoot:"/s",delegateArgv:["delegate"],expectedRef:"abc",timeoutMs:10};
async function run(outcomes){const order=[];const seen=[];let cursor=0;const dispatch=makeDispatcher(options,(actual)=>{order.push("send");seen.push(actual);if(cursor>=outcomes.length) throw new Error("third send");return Promise.resolve(outcomes[cursor++]);},(event)=>order.push(event));const result=await dispatch("brief");return {order,seen,result};}
let p=await run([missing(0),admitted]);assert.deepEqual(p.order,["send","retry-return-protocol","send"]);assert.equal(p.seen[1].brief,"brief\n\nReturn protocol reminder: write a complete provisional ../return.json early and overwrite it with the final closed-schema return.");assert.equal(p.result,admitted);
p=await run([missing(7),missing(8)]);assert.equal(p.seen.length,2);assert.deepEqual(p.order,["send","retry-return-protocol","send"]);
p=await run([{disposition:"refused",diagnostic:diagnostic({class:"signaled",exitCode:null,signal:"SIGTERM"},"missing")}]);assert.equal(p.seen.length,1);
p=await run([{disposition:"refused",diagnostic:diagnostic({class:"exited",exitCode:3,signal:null},"regular")}]);assert.equal(p.seen.length,1);
`;

function kill(name: string, from: string, to: string): void {
	for (const variant of ["baseline", "mutant"] as const) {
		const box = mkdtempSync(join(root, `${name}-${variant}-`));
		cpSync(join(repository, ".pi/extensions/gitjig"), join(box, "gitjig"), { recursive: true });
		symlinkSync(join(repository, "node_modules"), join(box, "node_modules"), "dir");
		const target = join(box, "gitjig/review/orchestrate.ts");
		const source = readFileSync(target, "utf8");
		assert.equal(source.split(from).length, 2, `${name}: mutation target must be unique`);
		if (variant === "mutant") writeFileSync(target, source.replace(from, to));
		writeFileSync(join(box, "probe.mjs"), probe);
		const result = spawnSync(process.execPath, [join(box, "probe.mjs")], { encoding: "utf8", timeout: 10_000 });
		if (variant === "baseline") assert.equal(result.status, 0, `${name}: baseline failed\n${result.stderr}`);
		else assert.notEqual(result.status, 0, `${name}: mutant survived`);
	}
}

describe("#266 isolated return-protocol retry mutants", () => {
	it("kills each trigger-conjunct and spent-state mutant independently", () => {
		kill("run-class", 'outcome.diagnostic.run.class === "exited"', 'outcome.diagnostic.run.class === "signaled"');
		kill(
			"numeric-exit",
			"Number.isInteger(outcome.diagnostic.run.exitCode)",
			"!Number.isInteger(outcome.diagnostic.run.exitCode)",
		);
		kill(
			"missing-return",
			'outcome.diagnostic.return.class === "missing"',
			'outcome.diagnostic.return.class === "regular"',
		);
		kill("spent-before-send", "retryAvailable = false;", "retryAvailable = true;");
	});

	it("kills suffix, event identity, and event-order mutants independently", () => {
		kill("suffix", "brief + RETURN_PROTOCOL_RETRY_SUFFIX", "brief");
		kill("event", 'onEvent?.("retry-return-protocol")', 'onEvent?.("retry-return-protocol-changed")');
		kill(
			"event-order",
			'onEvent?.("retry-return-protocol");\n\t\t\t} catch {\n\t\t\t\t// Fixture-only observation cannot alter the authorized transport act.\n\t\t\t}\n\t\t\toutcome = await send(brief + RETURN_PROTOCOL_RETRY_SUFFIX);',
			'outcome = await send(brief + RETURN_PROTOCOL_RETRY_SUFFIX);\n\t\t\t\tonEvent?.("retry-return-protocol");\n\t\t\t} catch {\n\t\t\t\t// Fixture-only observation cannot alter the authorized transport act.\n\t\t\t}',
		);
	});
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
let root: string;
before(() => {
	root = mkdtempSync(join(tmpdir(), "gitjig-surface-mutants-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

function kill(name: string, file: string, from: string, to: string, probe: string): void {
	for (const variant of ["baseline", "mutant"] as const) {
		const box = mkdtempSync(join(root, `${name}-${variant}-`));
		cpSync(join(repository, ".pi/extensions/gitjig"), join(box, "gitjig"), { recursive: true });
		symlinkSync(join(repository, "node_modules"), join(box, "node_modules"), "dir");
		const target = join(box, "gitjig", file);
		const source = readFileSync(target, "utf8");
		assert.equal(source.split(from).length, 2, `${name}: mutation target must be unique`);
		if (variant === "mutant") writeFileSync(target, source.replace(from, to));
		writeFileSync(join(box, "probe.mjs"), probe);
		const result = spawnSync(process.execPath, [join(box, "probe.mjs")], { encoding: "utf8" });
		if (variant === "baseline") assert.equal(result.status, 0, `${name}: baseline failed\n${result.stderr}`);
		else assert.notEqual(result.status, 0, `${name}: mutant survived\n${result.stdout}\n${result.stderr}`);
	}
}

const dispatchImport = `import assert from "node:assert/strict"; import {dispatchTarget,dispatchTerminal} from "./gitjig/dispatch/index.ts";`;
const publishImport = `import assert from "node:assert/strict"; import {publishTarget,publishTerminal} from "./gitjig/publish/index.ts";`;

describe("#131 named isolated operator-surface mutants", () => {
	it("kills redacted-target and terminal-class mutants", () => {
		kill(
			"dispatch-expected-ref-redaction",
			"dispatch/index.ts",
			'return expectedRef === undefined ? "isolated clone" : "isolated clone · blind compare";',
			'return expectedRef === undefined ? "isolated clone" : `isolated clone · ${expectedRef}`;',
			`${dispatchImport} const secret="refs/heads/redacted"; assert.ok(!dispatchTarget({expectedRef:secret}).includes(secret));`,
		);
		kill(
			"dispatch-invalid-compare-fails",
			"dispatch/index.ts",
			'value.disposition === "admitted" && value.ok === true && value.compare !== "invalid"',
			'value.disposition === "admitted" && value.ok === true',
			`${dispatchImport} assert.equal(dispatchTerminal({disposition:"admitted",ok:true,compare:"invalid"}),"failure");`,
		);
		kill(
			"dispatch-refusal-distinct",
			"dispatch/index.ts",
			'if (value.disposition === "refused") return "refusal";',
			'if (value.disposition === "refused") return "success";',
			`${dispatchImport} assert.equal(dispatchTerminal({disposition:"refused"}),"refusal");`,
		);
		kill(
			"publish-refusal-distinct",
			"publish/index.ts",
			'if (typeof disposition === "string" && disposition.startsWith("refuse")) return "refusal";',
			'if (typeof disposition === "string" && disposition.startsWith("refuse")) return "success";',
			`${publishImport} assert.equal(publishTerminal({disposition:"refuse-match"}),"refusal");`,
		);
		kill(
			"publish-unverified-fails",
			"publish/index.ts",
			'if (disposition === "published") return "success";',
			'if (disposition === "published" || disposition === "outcome-unverified") return "success";',
			`${publishImport} assert.equal(publishTerminal({disposition:"outcome-unverified"}),"failure");`,
		);
	});

	it("kills structured-target, styling, headless, fail-open, boundary, and activity mutants", () => {
		kill(
			"publish-body-redaction",
			"publish/index.ts",
			"return `PR comment${number}`;",
			"return `PR comment${number} ${(args as { body?: string }).body}`;",
			`${publishImport} const secret="withheld-body"; assert.ok(!publishTarget({body:secret,destination:{kind:"pr-comment",number:1}}).includes(secret));`,
		);
		kill(
			"refusal-warning-style",
			"act-render.ts",
			'theme.fg("warning", "! refusal")',
			'theme.fg("success", "! refusal")',
			`import assert from "node:assert/strict"; import {renderActTerminal} from "./gitjig/act-render.ts"; const t={fg:(c,x)=>"["+c+"]"+x,bold:x=>x}; assert.match(renderActTerminal("refusal",t).render(80)[0],/^\\[warning\\]/);`,
		);
		kill(
			"headless-no-ui-call",
			"session-surface.ts",
			"if (!ctx.hasUI) return;",
			"if (false) return;",
			`import assert from "node:assert/strict"; import {SessionSurface} from "./gitjig/session-surface.ts"; let calls=0; new SessionSurface().attach({hasUI:false,ui:{theme:{fg:(_c,x)=>x},setStatus(){calls++}}}); assert.equal(calls,0);`,
		);
		kill(
			"status-failure-degrades-open",
			"session-surface.ts",
			"} catch {\n\t\t\t// This is an aid",
			"} catch (error) {\n\t\t\tthrow error;\n\t\t\t// This is an aid",
			`import {SessionSurface} from "./gitjig/session-surface.ts"; new SessionSurface().attach({hasUI:true,ui:{theme:{fg:(_c,x)=>x},setStatus(){throw Error("ui")}}});`,
		);
		kill(
			"safe-issue-number-domain",
			"act-render.ts",
			"Number.isSafeInteger(value) && value > 0",
			'typeof value === "number"',
			`import assert from "node:assert/strict"; import {safeIssueNumber} from "./gitjig/act-render.ts"; for (const v of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1]) assert.equal(safeIssueNumber(v),"");`,
		);
		kill(
			"active-dispatch-visible",
			"session-surface.ts",
			"this.activeDispatches > 0",
			"false",
			`import assert from "node:assert/strict"; import {SessionSurface} from "./gitjig/session-surface.ts"; const seen=[]; const t={fg:(_c,x)=>x}; const s=new SessionSurface(); s.attach({hasUI:true,ui:{theme:t,setStatus:(_k,v)=>seen.push(v)}}); s.dispatchStarted(); assert.match(seen.at(-1),/active/);`,
		);
	});
});

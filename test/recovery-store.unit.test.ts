import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { deriveAllowancePathEncoding } from "../.pi/extensions/gitjig/recovery/lineage.ts";
import { claimAllowance, finalizeAllowance } from "../.pi/extensions/gitjig/recovery/store.ts";
import {
	type ClaimedRecordV3,
	type ConsumedRecordV3,
	canonicalJson,
	structuralDigest,
} from "../.pi/extensions/gitjig/recovery/types.ts";
import type { ReviewSubject } from "../.pi/extensions/gitjig/review/subject.ts";

let stateRoot = "";
const oldXdg = process.env.XDG_STATE_HOME;
const oldTest = process.env.GITJIG_TEST_STATE_ROOT;

beforeEach(() => {
	stateRoot = mkdtempSync(join(tmpdir(), "gitjig-recovery-store-"));
	chmodSync(stateRoot, 0o700);
	process.env.XDG_STATE_HOME = stateRoot;
	delete process.env.GITJIG_TEST_STATE_ROOT;
});
afterEach(() => {
	if (oldXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = oldXdg;
	if (oldTest === undefined) delete process.env.GITJIG_TEST_STATE_ROOT;
	else process.env.GITJIG_TEST_STATE_ROOT = oldTest;
	rmSync(stateRoot, { recursive: true, force: true });
});

function subject(pr = "PR_ONE"): ReviewSubject {
	return {
		context: {
			repository: { id: "REPO", host: "github.com", nameWithOwner: "o/r" },
			pullRequest: {
				id: pr,
				number: 1,
				url: "https://github.com/o/r/pull/1",
				authorId: "A",
				base: { repositoryId: "REPO", name: "main", oid: "a".repeat(40) },
				head: { repositoryId: "REPO", name: "topic", oid: "b".repeat(40) },
				closingIssues: [],
			},
		},
		writerId: "W",
		activation: [],
		criteria: [],
	};
}

function encoding(current: ReviewSubject) {
	const value = deriveAllowancePathEncoding(current);
	assert.ok(value !== undefined);
	return value;
}

function record(current: ReviewSubject): ClaimedRecordV3 {
	const path = encoding(current);
	const now = new Date().toISOString();
	return {
		schemaVersion: 3,
		state: "claimed",
		repoHash: path.repoHash,
		keyHash: path.keyHash,
		claimId: randomUUID(),
		createdAt: now,
		updatedAt: now,
		profileSetDigest: "1".repeat(64),
		subjectDigest: "2".repeat(64),
		historyDigest: "3".repeat(64),
		basisDigest: "4".repeat(64),
		basis: {
			kind: "history-diagnosis",
			triggeringReviewState: { head: "b".repeat(40), historyIndex: 0, stateDigest: "5".repeat(64) },
			taxonomy: "STAGNATION",
			invalidation: "nothing",
			diagnosisDigest: "6".repeat(64),
		},
		modes: { mergeMode: "off", decisionMode: "autonomous", mergeSource: "default", decisionSource: "default" },
		route: "stagnation",
		attempts: [],
		completeness: null,
		sequenceAuthority: null,
		selectedIntervention: null,
		measurement: null,
		freshRuling: null,
		reentry: "nothing",
		nextGate: null,
		terminal: null,
		cause: null,
	};
}

function consumed(claimed: ClaimedRecordV3): ConsumedRecordV3 {
	return {
		...claimed,
		state: "consumed",
		updatedAt: new Date(Date.now() + 1).toISOString(),
		attempts: [],
		completeness: {
			requiredSlots: ["stagnation-root", "stagnation-blast-radius", "recovery-selector"],
			admittedSlots: [],
		},
		sequenceAuthority: { source: "host-attempt-order", lastSequence: 0, retrySlots: [] },
		selectedIntervention: null,
		measurement: null,
		freshRuling: null,
		reentry: "nothing",
		nextGate: "park",
		terminal: "handoff",
		cause: "recovery-failed",
	};
}

function successful(current: ReviewSubject): ConsumedRecordV3 {
	const base = consumed(record(current));
	const candidates = [
		{ slot: "root", outcome: "ALTERNATIVE", method: "root method", evidence: "root evidence" },
		{ slot: "blast-radius", outcome: "ALTERNATIVE", method: "blast method", evidence: "blast evidence" },
	] as const;
	const candidateDigests = candidates.map((value) => structuralDigest("gitjig-recovery-candidate:v1", value)) as [
		string,
		string,
	];
	const selected = {
		slot: "root" as const,
		method: candidates[0].method,
		candidateEvidence: candidates[0].evidence,
		selectionEvidence: "selected",
		candidateDigests,
	};
	const resultDigests = [
		...candidateDigests,
		structuralDigest("gitjig-recovery-selection:v1", {
			selected: "root",
			materiallyDifferent: true,
			evidence: "selected",
		}),
	];
	const slots = ["stagnation-root", "stagnation-blast-radius", "recovery-selector"] as const;
	base.attempts = slots.map((slot, index) => ({
		sequence: index + 1,
		startedOffsetMs: index * 2,
		finishedOffsetMs: index * 2 + 1,
		diagnostic: {
			schemaVersion: 1,
			status: "admitted",
			phase: "compare",
			run: { class: "exited", exitCode: 0, signal: null },
			return: { class: "admitted" },
			compare: { class: "confirmed" },
			durationMs: 1,
			code: "ADMITTED",
		},
		outcomeDigest: "7".repeat(64),
		slot,
		profileId: slot,
		profileVersion: 1,
		profileSetDigest: base.profileSetDigest,
		materializationDigest: "8".repeat(64),
		expectedHead: current.context.pullRequest.head.oid,
		admission: "retained",
		resultDigest: resultDigests[index],
	}));
	base.completeness = { requiredSlots: [...slots], admittedSlots: [...slots] };
	base.sequenceAuthority = { source: "host-attempt-order", lastSequence: 3, retrySlots: [] };
	base.selectedIntervention = selected;
	base.nextGate = "author-repair";
	base.terminal = "continue";
	base.cause = null;
	return base;
}

describe("state-domain allowance store", () => {
	it("claims once, persists complete bytes, and atomically terminalizes without reopening", () => {
		const current = subject();
		const claimed = record(current);
		const first = claimAllowance({ subject: current, record: claimed });
		assert.equal(first.status, "claimed");
		if (first.status !== "claimed") return;
		const leaf = encoding(current).leaf;
		const path = join(stateRoot, "gitjig", "recovery", leaf);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).state, "claimed");
		const concurrent = claimAllowance({ subject: current, record: record(current) });
		assert.equal(concurrent.status, "consumed");
		assert.equal(finalizeAllowance(first.claim, consumed(claimed)).status, "finalized");
		assert.equal(JSON.parse(readFileSync(path, "utf8")).state, "consumed");
		assert.equal(finalizeAllowance(first.claim, consumed(claimed)).status, "consumed-unverified");
	});

	it("admits exactly one winner across synchronized competing processes", async () => {
		const gate = join(stateRoot, "go");
		const storeUrl = new URL("../.pi/extensions/gitjig/recovery/store.ts", import.meta.url).href;
		const script = [
			`import {claimAllowance} from ${JSON.stringify(storeUrl)};`,
			"import {randomUUID} from 'node:crypto'; import {existsSync} from 'node:fs';",
			`while(!existsSync(${JSON.stringify(gate)})) await new Promise(r=>setTimeout(r,1));`,
			`const subject=${JSON.stringify(subject("PR_CONCURRENT"))};`,
			"const now=new Date().toISOString(); const e=(await import(" +
				JSON.stringify(new URL("../.pi/extensions/gitjig/recovery/lineage.ts", import.meta.url).href) +
				")).deriveAllowancePathEncoding(subject);",
			"const record={schemaVersion:3,state:'claimed',repoHash:e.repoHash,keyHash:e.keyHash,claimId:randomUUID(),createdAt:now,updatedAt:now,profileSetDigest:'1'.repeat(64),subjectDigest:'2'.repeat(64),historyDigest:'3'.repeat(64),basisDigest:'4'.repeat(64),basis:{kind:'history-diagnosis',triggeringReviewState:{head:'a'.repeat(40),historyIndex:0,stateDigest:'5'.repeat(64)},taxonomy:'STAGNATION',invalidation:'nothing',diagnosisDigest:'6'.repeat(64)},modes:{mergeMode:'off',decisionMode:'autonomous',mergeSource:'default',decisionSource:'default'},route:'stagnation',attempts:[],completeness:null,sequenceAuthority:null,selectedIntervention:null,measurement:null,freshRuling:null,reentry:'nothing',nextGate:null,terminal:null,cause:null};",
			"console.log(claimAllowance({subject,record}).status);",
		].join("\n");
		const children = Array.from({ length: 8 }, () =>
			spawn(process.execPath, ["--input-type=module", "-e", script], {
				env: { ...process.env, XDG_STATE_HOME: stateRoot },
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		writeFileSync(gate, "go");
		const statuses = await Promise.all(
			children.map(
				(child) =>
					new Promise<string>((resolve, reject) => {
						let stdout = "";
						let stderr = "";
						child.stdout.on("data", (chunk) => {
							stdout += chunk.toString();
						});
						child.stderr.on("data", (chunk) => {
							stderr += chunk.toString();
						});
						child.on("close", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr))));
					}),
			),
		);
		assert.equal(statuses.filter((status) => status === "claimed").length, 1);
		assert.ok(statuses.filter((status) => status === "consumed").length === 7);
	});

	it("kills non-exclusive claim in a synchronized private copy", async () => {
		const box = mkdtempSync(join(tmpdir(), "gitjig-nonexclusive-mutant-"));
		try {
			cpSync(new URL("../.pi/extensions/gitjig", import.meta.url), join(box, "gitjig"), { recursive: true });
			symlinkSync(new URL("../node_modules", import.meta.url), join(box, "node_modules"), "dir");
			const shim = join(box, "fs-shim.mjs");
			writeFileSync(
				shim,
				`import * as fs from "node:fs";\nexport const {closeSync,constants,fstatSync,fsyncSync,lstatSync,readSync,renameSync,writeSync}=fs;\nexport function openSync(path,flags,mode){if((flags&fs.constants.O_CREAT)!==0&&String(path).endsWith(".json")){fs.appendFileSync(process.env.ARRIVALS,"x");const until=Date.now()+5000;while(fs.readFileSync(process.env.ARRIVALS).length<2&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}return fs.openSync(path,flags,mode);}\n`,
			);
			const target = join(box, "gitjig", "recovery", "store.ts");
			const original = readFileSync(target, "utf8");
			assert.ok(original.includes("constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW"));
			writeFileSync(
				target,
				original
					.replace('"node:fs"', JSON.stringify(new URL(`file://${shim}`).href))
					.replace(
						"constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW",
						"constants.O_CREAT | constants.O_NOFOLLOW",
					),
			);
			const script = `import {randomUUID} from "node:crypto"; import {claimAllowance} from "./gitjig/recovery/store.ts"; import {deriveAllowancePathEncoding} from "./gitjig/recovery/lineage.ts"; const subject=${JSON.stringify(subject("PR_NONEXCLUSIVE"))}; const e=deriveAllowancePathEncoding(subject), now=new Date().toISOString(); const record={schemaVersion:3,state:"claimed",repoHash:e.repoHash,keyHash:e.keyHash,claimId:randomUUID(),createdAt:now,updatedAt:now,profileSetDigest:"1".repeat(64),subjectDigest:"2".repeat(64),historyDigest:"3".repeat(64),basisDigest:"4".repeat(64),basis:{kind:"history-diagnosis",triggeringReviewState:{head:"a".repeat(40),historyIndex:0,stateDigest:"5".repeat(64)},taxonomy:"STAGNATION",invalidation:"nothing",diagnosisDigest:"6".repeat(64)},modes:{mergeMode:"off",decisionMode:"autonomous",mergeSource:"default",decisionSource:"default"},route:"stagnation",attempts:[],completeness:null,sequenceAuthority:null,selectedIntervention:null,measurement:null,freshRuling:null,reentry:"nothing",nextGate:null,terminal:null,cause:null}; console.log(claimAllowance({subject,record}).status);`;
			writeFileSync(join(box, "probe.mjs"), script);
			const xdg = join(box, "state");
			mkdirSync(xdg, { mode: 0o700 });
			const arrivals = join(box, "arrivals");
			writeFileSync(arrivals, "");
			const children = Array.from({ length: 2 }, () =>
				spawn(process.execPath, [join(box, "probe.mjs")], {
					cwd: box,
					env: { ...process.env, XDG_STATE_HOME: xdg, ARRIVALS: arrivals },
					stdio: ["ignore", "pipe", "pipe"],
				}),
			);
			const results = await Promise.all(
				children.map(
					(child) =>
						new Promise<string>((resolve, reject) => {
							let stdout = "",
								stderr = "";
							child.stdout.on("data", (chunk) => {
								stdout += String(chunk);
							});
							child.stderr.on("data", (chunk) => {
								stderr += String(chunk);
							});
							child.on("close", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr))));
						}),
				),
			);
			assert.deepEqual(results, ["claimed", "claimed"], "removing O_EXCL must violate the production one-winner test");
		} finally {
			rmSync(box, { recursive: true, force: true });
		}
	});

	it("kills omission of the claimed-leaf parent fsync in an isolated copy", () => {
		const probe = `
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {claimAllowance,finalizeAllowance} from "./gitjig/recovery/store.ts";
import {deriveAllowancePathEncoding} from "./gitjig/recovery/lineage.ts";
const subject={context:{repository:{id:"R",host:"github.com",nameWithOwner:"o/r"},pullRequest:{id:"P",number:1,url:"https://github.com/o/r/pull/1",authorId:"A",base:{repositoryId:"R",name:"main",oid:"a".repeat(40)},head:{repositoryId:"R",name:"topic",oid:"b".repeat(40)},closingIssues:[]}},writerId:"W",activation:[],criteria:[]};
const e=deriveAllowancePathEncoding(subject), now=new Date().toISOString(); assert.ok(e);
const record={schemaVersion:3,state:"claimed",repoHash:e.repoHash,keyHash:e.keyHash,claimId:randomUUID(),createdAt:now,updatedAt:now,profileSetDigest:"1".repeat(64),subjectDigest:"2".repeat(64),historyDigest:"3".repeat(64),basisDigest:"4".repeat(64),basis:{kind:"history-diagnosis",triggeringReviewState:{head:"a".repeat(40),historyIndex:0,stateDigest:"5".repeat(64)},taxonomy:"STAGNATION",invalidation:"nothing",diagnosisDigest:"6".repeat(64)},modes:{mergeMode:"off",decisionMode:"autonomous",mergeSource:"default",decisionSource:"default"},route:"stagnation",attempts:[],completeness:null,sequenceAuthority:null,selectedIntervention:null,measurement:null,freshRuling:null,reentry:"nothing",nextGate:null,terminal:null,cause:null};
const claim=claimAllowance({subject,record}); assert.equal(claim.status,"claimed"); if(claim.status!=="claimed") process.exit(3);
const consumed={...record,state:"consumed",updatedAt:new Date(Date.now()+1).toISOString(),attempts:[],completeness:{requiredSlots:["stagnation-root","stagnation-blast-radius","recovery-selector"],admittedSlots:[]},sequenceAuthority:{source:"host-attempt-order",lastSequence:0,retrySlots:[]},selectedIntervention:null,measurement:null,freshRuling:null,reentry:"nothing",nextGate:"park",terminal:"handoff",cause:"recovery-failed"};
assert.equal(finalizeAllowance(claim.claim,consumed).status,"finalized");
assert.equal(readFileSync(process.env.FSYNC_LOG,"utf8"),"fdfd");
`;
		for (const variant of [
			"baseline",
			"claim-file-mutant",
			"parent-mutant",
			"terminal-mutant",
			"terminal-parent-mutant",
		] as const) {
			const box = mkdtempSync(join(tmpdir(), `gitjig-store-fsync-${variant}-`));
			try {
				cpSync(new URL("../.pi/extensions/gitjig", import.meta.url), join(box, "gitjig"), { recursive: true });
				symlinkSync(new URL("../node_modules", import.meta.url), join(box, "node_modules"), "dir");
				const shim = join(box, "fs-shim.mjs");
				writeFileSync(
					shim,
					`import * as fs from "node:fs";\nexport const {closeSync,constants,fstatSync,lstatSync,openSync,readSync,renameSync,writeSync}=fs;\nexport function fsyncSync(fd){fs.appendFileSync(process.env.FSYNC_LOG,fs.fstatSync(fd).isDirectory()?"d":"f");return fs.fsyncSync(fd);}\n`,
				);
				const target = join(box, "gitjig", "recovery", "store.ts");
				let source = readFileSync(target, "utf8").replace('"node:fs"', JSON.stringify(new URL(`file://${shim}`).href));
				if (variant === "claim-file-mutant") {
					const from = "\t\twriteComplete(fd, bytes);\n\t\tfsyncSync(fd);";
					assert.ok(source.includes(from));
					source = source.replace(from, "\t\twriteComplete(fd, bytes);");
				}
				if (variant === "parent-mutant") {
					const from = "\t\tfsyncSync(fd);\n\t\tcloseSync(fd);\n\t\tfd = undefined;\n\t\tsyncDirectory(recoveryDir);";
					assert.ok(source.indexOf(from) >= 0 && source.indexOf(from) === source.lastIndexOf(from));
					source = source.replace(from, "\t\tfsyncSync(fd);\n\t\tcloseSync(fd);\n\t\tfd = undefined;");
				}
				if (variant === "terminal-mutant") {
					const from = "\t\t\twriteComplete(tempFd, bytes);\n\t\t\tfsyncSync(tempFd);";
					assert.ok(source.includes(from));
					source = source.replace(from, "\t\t\twriteComplete(tempFd, bytes);");
				}
				if (variant === "terminal-parent-mutant") {
					const from = "\t\t\trenameSync(temporary, state.path);\n\t\t\tsyncDirectory(resolved);";
					assert.ok(source.includes(from));
					source = source.replace(from, "\t\t\trenameSync(temporary, state.path);");
				}
				writeFileSync(target, source);
				writeFileSync(join(box, "probe.mjs"), probe);
				const xdg = join(box, "state");
				mkdirSync(xdg, { mode: 0o700 });
				const log = join(box, "fsync.log");
				writeFileSync(log, "");
				const result = spawnSync(process.execPath, [join(box, "probe.mjs")], {
					cwd: box,
					encoding: "utf8",
					timeout: 10_000,
					env: { ...process.env, XDG_STATE_HOME: xdg, FSYNC_LOG: log },
				});
				if (variant === "baseline") assert.equal(result.status, 0, result.stderr);
				else assert.notEqual(result.status, 0, `${variant} survived`);
			} finally {
				rmSync(box, { recursive: true, force: true });
			}
		}
	});

	it("consumes claim and terminal write, close, fsync, rename, and post-read failures without reopening allowance", () => {
		const owner = readFileSync(new URL(import.meta.url), "utf8");
		const probe = owner.match(/const probe = `([\s\S]*?)`;\n\t\tfor \(const variant of \[/)?.[1];
		assert.ok(probe);
		const replaced = probe.replace(
			'assert.equal(finalizeAllowance(claim.claim,consumed).status,"finalized");\nassert.equal(readFileSync(process.env.FSYNC_LOG,"utf8"),"fdfd");',
			'assert.equal(finalizeAllowance(claim.claim,consumed).status,"consumed-unverified"); assert.equal(claimAllowance({subject,record}).status,"consumed");',
		);
		assert.notEqual(replaced, probe);
		for (const failure of [
			"claim-file",
			"claim-parent",
			"terminal-file",
			"terminal-parent",
			"claim-write",
			"claim-close",
			"terminal-create",
			"terminal-write",
			"terminal-close",
			"terminal-rename",
			"terminal-post-read",
		] as const) {
			const box = mkdtempSync(join(tmpdir(), `gitjig-store-fsync-error-${failure}-`));
			try {
				cpSync(new URL("../.pi/extensions/gitjig", import.meta.url), join(box, "gitjig"), { recursive: true });
				symlinkSync(new URL("../node_modules", import.meta.url), join(box, "node_modules"), "dir");
				const shim = join(box, "fs-shim.mjs");
				writeFileSync(
					shim,
					`import * as fs from "node:fs";\nexport const {constants,fstatSync,lstatSync}=fs;\nlet f=0,d=0,w=0,c=0,r=0; const fail=(point)=>{if(process.env.FAIL_ON===point){const error=new Error("injected");error.code="EIO";throw error;}};\nexport function fsyncSync(fd){const directory=fs.fstatSync(fd).isDirectory();const n=directory?++d:++f;fail((directory?"d":"f")+String(n));return fs.fsyncSync(fd);}\nexport function writeSync(...args){fail("w"+String(++w));return fs.writeSync(...args);}\nexport function closeSync(fd){fail("c"+String(++c));return fs.closeSync(fd);}\nexport function readSync(...args){fail("r"+String(++r));return fs.readSync(...args);}\nexport function openSync(path,...args){if(String(path).endsWith(".tmp"))fail("temp-create");return fs.openSync(path,...args);}\nexport function renameSync(...args){fail("rename");return fs.renameSync(...args);}\n`,
				);
				const target = join(box, "gitjig", "recovery", "store.ts");
				writeFileSync(
					target,
					readFileSync(target, "utf8").replace('"node:fs"', JSON.stringify(new URL(`file://${shim}`).href)),
				);
				const script = failure.startsWith("claim")
					? probe.replace(
							'assert.equal(claim.status,"claimed"); if(claim.status!=="claimed") process.exit(3);',
							'assert.equal(claim.status,"consumed"); assert.equal(claim.cause,"create-or-write-ambiguous"); assert.equal(claimAllowance({subject,record}).status,"consumed"); process.exit(0);',
						)
					: replaced;
				writeFileSync(join(box, "probe.mjs"), script);
				const xdg = join(box, "state");
				mkdirSync(xdg, { mode: 0o700 });
				const log = join(box, "fsync.log");
				writeFileSync(log, "");
				const point = {
					"claim-file": "f1",
					"claim-parent": "d1",
					"terminal-file": "f2",
					"terminal-parent": "d2",
					"claim-write": "w1",
					"claim-close": "c1",
					"terminal-create": "temp-create",
					"terminal-write": "w2",
					"terminal-close": "c3",
					"terminal-rename": "rename",
					"terminal-post-read": "r3",
				}[failure];
				const result = spawnSync(process.execPath, [join(box, "probe.mjs")], {
					cwd: box,
					encoding: "utf8",
					timeout: 10_000,
					env: { ...process.env, XDG_STATE_HOME: xdg, FSYNC_LOG: log, FAIL_ON: point },
				});
				assert.equal(result.status, 0, `${failure}: ${result.stderr}`);
			} finally {
				rmSync(box, { recursive: true, force: true });
			}
		}
	});

	it("kills an immutable-mode author mutation in a private copy", () => {
		const owner = readFileSync(new URL(import.meta.url), "utf8");
		const probe = owner.match(/const probe = `([\s\S]*?)`;\n\t\tfor \(const variant of \[/)?.[1];
		assert.ok(probe);
		const adjusted = probe.replace(
			'assert.equal(finalizeAllowance(claim.claim,consumed).status,"finalized");\nassert.equal(readFileSync(process.env.FSYNC_LOG,"utf8"),"fdfd");',
			'consumed.modes={...record.modes,mergeMode:"on"}; assert.equal(finalizeAllowance(claim.claim,consumed).status,process.env.EXPECT);',
		);
		assert.notEqual(adjusted, probe);
		for (const mutant of [false, true]) {
			const box = mkdtempSync(join(tmpdir(), "gitjig-immutable-mode-"));
			try {
				cpSync(new URL("../.pi/extensions/gitjig", import.meta.url), join(box, "gitjig"), { recursive: true });
				symlinkSync(new URL("../node_modules", import.meta.url), join(box, "node_modules"), "dir");
				const target = join(box, "gitjig", "recovery", "store.ts");
				const source = readFileSync(target, "utf8");
				assert.ok(
					source.includes("\t\tmodes: record.modes,") &&
						source.indexOf("\t\tmodes: record.modes,") === source.lastIndexOf("\t\tmodes: record.modes,"),
				);
				if (mutant) writeFileSync(target, source.replace("\t\tmodes: record.modes,", ""));
				writeFileSync(join(box, "probe.mjs"), adjusted);
				const xdg = join(box, "state");
				mkdirSync(xdg, { mode: 0o700 });
				const result = spawnSync(process.execPath, [join(box, "probe.mjs")], {
					cwd: box,
					encoding: "utf8",
					timeout: 10_000,
					env: { ...process.env, XDG_STATE_HOME: xdg, EXPECT: mutant ? "finalized" : "consumed-unverified" },
				});
				assert.equal(result.status, 0, result.stderr);
			} finally {
				rmSync(box, { recursive: true, force: true });
			}
		}
	});

	it("kills omission of the terminal post-rename reread in a private copy", () => {
		const owner = readFileSync(new URL(import.meta.url), "utf8");
		const probe = owner.match(/const probe = `([\s\S]*?)`;\n\t\tfor \(const variant of \[/)?.[1];
		assert.ok(probe);
		const script = probe.replace(
			'assert.equal(finalizeAllowance(claim.claim,consumed).status,"finalized");\nassert.equal(readFileSync(process.env.FSYNC_LOG,"utf8"),"fdfd");',
			'assert.equal(finalizeAllowance(claim.claim,consumed).status,process.env.EXPECT); assert.equal(claimAllowance({subject,record}).status,"consumed");',
		);
		assert.notEqual(script, probe);
		for (const mutant of [false, true]) {
			const box = mkdtempSync(join(tmpdir(), "gitjig-post-read-mutant-"));
			try {
				cpSync(new URL("../.pi/extensions/gitjig", import.meta.url), join(box, "gitjig"), { recursive: true });
				symlinkSync(new URL("../node_modules", import.meta.url), join(box, "node_modules"), "dir");
				const shim = join(box, "fs-shim.mjs");
				writeFileSync(
					shim,
					`import * as fs from "node:fs"; export const {closeSync,constants,fstatSync,fsyncSync,lstatSync,openSync,renameSync,writeSync}=fs; let reads=0; export function readSync(...args){if(++reads===3){const error=new Error("post-read failure");error.code="EIO";throw error;}return fs.readSync(...args);}`,
				);
				const target = join(box, "gitjig", "recovery", "store.ts");
				let source = readFileSync(target, "utf8").replace('"node:fs"', JSON.stringify(new URL(`file://${shim}`).href));
				const postRead =
					/\t\t\tconst finalFd = openSync\(state\.path, READ_FLAGS\);[\s\S]*?\t\t\t}\n\t\t\treturn \{ status: "finalized"/;
				assert.match(source, postRead);
				if (mutant) source = source.replace(postRead, '\t\t\treturn { status: "finalized"');
				writeFileSync(target, source);
				writeFileSync(join(box, "probe.mjs"), script);
				const xdg = join(box, "state");
				mkdirSync(xdg, { mode: 0o700 });
				const result = spawnSync(process.execPath, [join(box, "probe.mjs")], {
					cwd: box,
					encoding: "utf8",
					timeout: 10_000,
					env: { ...process.env, XDG_STATE_HOME: xdg, EXPECT: mutant ? "finalized" : "consumed-unverified" },
				});
				assert.equal(result.status, 0, result.stderr);
			} finally {
				rmSync(box, { recursive: true, force: true });
			}
		}
	});

	it("distinguishes definite ENOSPC/EDQUOT from may-have-created open failure", () => {
		for (const code of ["EIO", "ENOSPC", "EDQUOT", "LSTAT_EIO"] as const) {
			const box = mkdtempSync(join(tmpdir(), `gitjig-store-create-${code}-`));
			try {
				cpSync(new URL("../.pi/extensions/gitjig", import.meta.url), join(box, "gitjig"), { recursive: true });
				symlinkSync(new URL("../node_modules", import.meta.url), join(box, "node_modules"), "dir");
				const shim = join(box, "fs-shim.mjs");
				writeFileSync(
					shim,
					`import * as fs from "node:fs";\nexport const {closeSync,constants,fstatSync,fsyncSync,readSync,renameSync,writeSync}=fs;\nexport function lstatSync(path){if(process.env.OPEN_CODE==="LSTAT_EIO"&&String(path).endsWith(".json")){const error=new Error("injected");error.code="EIO";throw error;}return fs.lstatSync(path);}\nexport function openSync(path,flags,mode){if((flags&fs.constants.O_CREAT)!==0){if(process.env.OPEN_CODE==="EIO"){const fd=fs.openSync(path,flags,mode);fs.closeSync(fd);}const error=new Error("injected");error.code=process.env.OPEN_CODE;throw error;}return fs.openSync(path,flags,mode);}\n`,
				);
				const target = join(box, "gitjig", "recovery", "store.ts");
				writeFileSync(
					target,
					readFileSync(target, "utf8").replace('"node:fs"', JSON.stringify(new URL(`file://${shim}`).href)),
				);
				const probe = readFileSync(new URL(import.meta.url), "utf8").match(/const probe = `([\s\S]*?)`;\n/)?.[1];
				assert.ok(probe);
				const expectation =
					code === "EIO"
						? 'assert.equal(result.status,"consumed"); assert.equal(result.cause,"create-or-write-ambiguous");'
						: 'assert.equal(result.status,"preclaim-refused"); assert.equal(result.cause,"state-domain");';
				const adjusted = probe.replace(
					/const claim=claimAllowance[\s\S]*?assert\.equal\(readFileSync\(process\.env\.FSYNC_LOG,"utf8"\),"fdfd"\);/,
					`const result=claimAllowance({subject,record}); ${expectation}`,
				);
				writeFileSync(join(box, "probe.mjs"), adjusted);
				const xdg = join(box, "state");
				mkdirSync(xdg, { mode: 0o700 });
				const result = spawnSync(process.execPath, [join(box, "probe.mjs")], {
					cwd: box,
					encoding: "utf8",
					timeout: 10_000,
					env: { ...process.env, XDG_STATE_HOME: xdg, FSYNC_LOG: join(box, "unused"), OPEN_CODE: code },
				});
				assert.equal(result.status, 0, result.stderr);
			} finally {
				rmSync(box, { recursive: true, force: true });
			}
		}
	});

	it("pins the existing-record read to 256 KiB plus one byte", () => {
		const box = mkdtempSync(join(tmpdir(), "gitjig-store-record-cap-"));
		try {
			cpSync(new URL("../.pi/extensions/gitjig", import.meta.url), join(box, "gitjig"), { recursive: true });
			symlinkSync(new URL("../node_modules", import.meta.url), join(box, "node_modules"), "dir");
			const shim = join(box, "fs-shim.mjs");
			writeFileSync(
				shim,
				`import * as fs from "node:fs";\nexport const {closeSync,constants,fstatSync,fsyncSync,lstatSync,openSync,renameSync,writeSync}=fs;\nexport function readSync(fd,buffer,offset,length,position){fs.appendFileSync(process.env.READ_LOG,String(buffer.length)+"\\n");return fs.readSync(fd,buffer,offset,length,position);}\n`,
			);
			const target = join(box, "gitjig", "recovery", "store.ts");
			writeFileSync(
				target,
				readFileSync(target, "utf8").replace('"node:fs"', JSON.stringify(new URL(`file://${shim}`).href)),
			);
			const owner = readFileSync(new URL(import.meta.url), "utf8").match(/const probe = `([\s\S]*?)`;\n/)?.[1];
			assert.ok(owner);
			const setup = owner.slice(0, owner.indexOf("const claim="));
			const script = `${setup}\nconst {mkdirSync,writeFileSync}=await import("node:fs"); const {join}=await import("node:path"); const directory=join(process.env.XDG_STATE_HOME,"gitjig","recovery"); mkdirSync(directory,{recursive:true,mode:0o700}); writeFileSync(join(directory,\`r2-\${e.repoHash}-\${e.keyHash}.json\`),"x".repeat(262144),{mode:0o600}); const result=claimAllowance({subject,record}); assert.equal(result.status,"consumed"); assert.equal(result.recordRef,undefined); assert.match(readFileSync(process.env.READ_LOG,"utf8"),/^262145\\n/);`;
			writeFileSync(join(box, "probe.mjs"), script);
			const xdg = join(box, "state");
			mkdirSync(xdg, { mode: 0o700 });
			const log = join(box, "read.log");
			writeFileSync(log, "");
			const result = spawnSync(process.execPath, [join(box, "probe.mjs")], {
				cwd: box,
				encoding: "utf8",
				timeout: 10_000,
				env: { ...process.env, XDG_STATE_HOME: xdg, READ_LOG: log },
			});
			assert.equal(result.status, 0, result.stderr);
		} finally {
			rmSync(box, { recursive: true, force: true });
		}
	});

	it("classifies a non-regular existing leaf without opening it", () => {
		const current = subject("PR_FIFO");
		const path = encoding(current);
		const directory = join(stateRoot, "gitjig", "recovery");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		execFileSync("mkfifo", [join(directory, path.leaf)]);
		assert.deepEqual(claimAllowance({ subject: current, record: record(current) }), {
			status: "consumed",
			cause: "existing",
		});
	});

	it("binds selected evidence and retained result digests before returning recordRef", () => {
		for (const [name, mutate] of [
			["valid", (_value: ConsumedRecordV3) => undefined],
			[
				"selected",
				(value: ConsumedRecordV3) => {
					if (value.selectedIntervention) value.selectedIntervention.candidateEvidence = "changed";
				},
			],
			[
				"attempt",
				(value: ConsumedRecordV3) => {
					const first = value.attempts[0];
					assert.ok(first);
					first.resultDigest = "f".repeat(64);
				},
			],
			[
				"dependency-overlap",
				(value: ConsumedRecordV3) => {
					const selector = value.attempts.find((attempt) => attempt.profileId === "recovery-selector");
					assert.ok(selector);
					selector.startedOffsetMs = 0;
				},
			],
			[
				"dependency-order",
				(value: ConsumedRecordV3) => {
					value.attempts = [value.attempts[2], value.attempts[0], value.attempts[1]].map((attempt, index) => ({
						...attempt,
						sequence: index + 1,
					}));
				},
			],
			[
				"route-head",
				(value: ConsumedRecordV3) => {
					const first = value.attempts[0];
					assert.ok(first);
					first.expectedHead = "c".repeat(40);
				},
			],
			[
				"refused-retained",
				(value: ConsumedRecordV3) => {
					const first = value.attempts[0];
					assert.ok(first);
					first.diagnostic = {
						schemaVersion: 1,
						status: "refused",
						phase: "run",
						run: { class: "aborted", exitCode: null, signal: null },
						return: { class: "not-inspected" },
						compare: { class: "not-reached" },
						durationMs: 1,
						code: "ABORTED",
					};
				},
			],
			[
				"impossible-handoff",
				(value: ConsumedRecordV3) => {
					const mutable = value as unknown as Record<string, unknown>;
					mutable.terminal = "handoff";
					mutable.cause = "recovery-failed";
					mutable.reentry = "plan";
					mutable.nextGate = "planning-handoff";
				},
			],
			[
				"taxonomy",
				(value: ConsumedRecordV3) => {
					value.basis.taxonomy = "OSCILLATION";
				},
			],
			[
				"incomplete",
				(value: ConsumedRecordV3) => {
					value.attempts = [];
					value.completeness = {
						requiredSlots: ["stagnation-root", "stagnation-blast-radius", "recovery-selector"],
						admittedSlots: [],
					};
					value.sequenceAuthority = { source: "host-attempt-order", lastSequence: 0, retrySlots: [] };
				},
			],
		] as const) {
			const current = subject(`PR_BIND_${name}`);
			const value = successful(current);
			mutate(value);
			const path = encoding(current);
			const directory = join(stateRoot, "gitjig", "recovery");
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			writeFileSync(join(directory, path.leaf), canonicalJson(value), { mode: 0o600 });
			const result = claimAllowance({ subject: current, record: record(current) });
			assert.equal(result.status, "consumed");
			assert.equal(result.status === "consumed" ? result.recordRef !== undefined : false, name === "valid");
		}
	});

	it("rejects claimed taxonomy drift and impossible handoff attempt order", () => {
		for (const [name, value] of (() => {
			const claimedSubject = subject("PR_CLAIMED_TAXONOMY");
			const claimed = record(claimedSubject);
			claimed.basis.taxonomy = "OSCILLATION";
			const orderSubject = subject("PR_HANDOFF_ORDER");
			const handoff = consumed(record(orderSubject));
			handoff.attempts = [
				{
					sequence: 1,
					startedOffsetMs: 0,
					finishedOffsetMs: 1,
					diagnostic: {
						schemaVersion: 1,
						status: "admitted",
						phase: "compare",
						run: { class: "exited", exitCode: 0, signal: null },
						return: { class: "admitted" },
						compare: { class: "confirmed" },
						durationMs: 1,
						code: "ADMITTED",
					},
					outcomeDigest: "7".repeat(64),
					slot: "recovery-selector",
					profileId: "recovery-selector",
					profileVersion: 1,
					profileSetDigest: handoff.profileSetDigest,
					materializationDigest: "8".repeat(64),
					expectedHead: orderSubject.context.pullRequest.head.oid,
					admission: "retained",
					resultDigest: "9".repeat(64),
				},
			];
			handoff.completeness = {
				requiredSlots: ["stagnation-root", "stagnation-blast-radius", "recovery-selector"],
				admittedSlots: ["recovery-selector"],
			};
			handoff.sequenceAuthority = { source: "host-attempt-order", lastSequence: 1, retrySlots: [] };
			return [
				["claimed", { subject: claimedSubject, record: claimed }],
				["order", { subject: orderSubject, record: handoff }],
			] as const;
		})()) {
			const path = encoding(value.subject);
			const directory = join(stateRoot, "gitjig", "recovery");
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			writeFileSync(join(directory, path.leaf), canonicalJson(value.record), { mode: 0o600 });
			assert.deepEqual(
				claimAllowance({ subject: value.subject, record: record(value.subject) }),
				{ status: "consumed", cause: "existing" },
				name,
			);
		}
	});

	it("keeps a finalized allowance consumed after mode, head, branch and replan changes", () => {
		const current = subject("PR_REUSE_AFTER_FINAL");
		const claimed = record(current);
		const first = claimAllowance({ subject: current, record: claimed });
		assert.equal(first.status, "claimed");
		if (first.status !== "claimed") return;
		assert.equal(finalizeAllowance(first.claim, consumed(claimed)).status, "finalized");
		for (const [index, change] of (
			[
				(value: ReviewSubject) => {
					value.context.pullRequest.head.oid = "c".repeat(40);
				},
				(value: ReviewSubject) => {
					value.context.pullRequest.head.name = "new-branch";
				},
				(_value: ReviewSubject) => {},
			] as const
		).entries()) {
			const changed = structuredClone(current);
			change(changed);
			const repeated = record(changed);
			repeated.modes.mergeMode = index === 2 ? "on" : "off";
			repeated.basis.diagnosisDigest = index === 2 ? "9".repeat(64) : repeated.basis.diagnosisDigest;
			assert.equal(claimAllowance({ subject: changed, record: repeated }).status, "consumed");
		}
	});

	it("binds terminalization to every immutable claimed field", () => {
		const current = subject("PR_IMMUTABLE");
		const claimed = record(current);
		const result = claimAllowance({ subject: current, record: claimed });
		assert.equal(result.status, "claimed");
		if (result.status !== "claimed") return;
		const changed = consumed(claimed);
		changed.profileSetDigest = "9".repeat(64);
		assert.equal(finalizeAllowance(result.claim, changed).status, "consumed-unverified");
		assert.equal(finalizeAllowance(result.claim, consumed(claimed)).status, "consumed-unverified");
	});

	it("treats malformed existing bytes as consumed without a record reference", () => {
		const current = subject("PR_BAD");
		const pathEncoding = encoding(current);
		mkdirSync(join(stateRoot, "gitjig", "recovery"), { recursive: true, mode: 0o700 });
		const path = join(stateRoot, "gitjig", "recovery", pathEncoding.leaf);
		writeFileSync(path, "partial", { mode: 0o600 });
		const result = claimAllowance({ subject: current, record: record(current) });
		assert.deepEqual(result, { status: "consumed", cause: "existing" });
	});

	it("withholds recordRef from canonical bytes with cross-field provenance drift", () => {
		const current = subject("PR_CROSS_FIELD");
		const encoding = deriveAllowancePathEncoding(current);
		assert.ok(encoding);
		const malformed = consumed(record(current));
		malformed.attempts = [
			{
				sequence: 1,
				startedOffsetMs: 0,
				finishedOffsetMs: 1,
				diagnostic: {
					schemaVersion: 1,
					status: "admitted",
					phase: "compare",
					run: { class: "exited", exitCode: 0, signal: null },
					return: { class: "admitted" },
					compare: { class: "confirmed" },
					durationMs: 1,
					code: "ADMITTED",
				},
				outcomeDigest: "7".repeat(64),
				slot: "stagnation-root",
				profileId: "stagnation-root",
				profileVersion: 1,
				profileSetDigest: "9".repeat(64),
				materializationDigest: "8".repeat(64),
				expectedHead: "b".repeat(40),
				admission: "retained",
				resultDigest: "6".repeat(64),
			},
		];
		malformed.completeness.admittedSlots = ["stagnation-root"];
		malformed.sequenceAuthority.lastSequence = 1;
		const directory = join(stateRoot, "gitjig", "recovery");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(join(directory, encoding.leaf), canonicalJson(malformed), { mode: 0o600 });
		assert.deepEqual(claimAllowance({ subject: current, record: record(current) }), {
			status: "consumed",
			cause: "existing",
		});
	});

	it("exports no reset, delete, or injection capability", () => {
		const source = readFileSync(new URL("../.pi/extensions/gitjig/recovery/store.ts", import.meta.url), "utf8");
		const functions = [...source.matchAll(/^export function (\w+)/gm)].map((match) => match[1]);
		assert.deepEqual(functions, ["claimAllowance", "finalizeAllowance"]);
		assert.deepEqual(
			[...source.matchAll(/^export const (\w+)/gm)].map((match) => match[1]),
			[],
		);
		assert.doesNotMatch(source, /^export .*?(?:reset|delete|clear|repair|unlock|inject)/gim);
	});

	it("keeps definite preclaim domain refusal unconsumed", () => {
		process.env.GITJIG_TEST_STATE_ROOT = "";
		const current = subject("PR_PRECLAIM");
		assert.deepEqual(claimAllowance({ subject: current, record: record(current) }), {
			status: "preclaim-refused",
			cause: "state-domain",
		});
	});
});

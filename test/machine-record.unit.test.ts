import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	admitMachineRecord,
	canonicalJson,
	decodeEscapeView,
	decodeWireBody,
} from "../.pi/extensions/gitjig/publish/machine-record.ts";
import { performPublish } from "../.pi/extensions/gitjig/publish/service.ts";

const MARKER = "<!-- machine-record: v1 -->";

function admit(value: unknown) {
	return admitMachineRecord({ marker: MARKER, value });
}

describe("closed machine-record codec", () => {
	it("orders scalar keys and reversibly encodes the five actionable characters", () => {
		const value = { z: "@#-:/", "😀": 2, "\ue000": 1 };
		const outcome = admit(value);
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(outcome.record.canonicalJson, '{"z":"@#-:/","":1,"😀":2}');
		assert.match(outcome.record.wireBody, /\\u0040\\u0023\\u002d\\u003a\\u002f/);
		const controls = admit("\u007f\u0080\u009f");
		assert.equal(controls.ok, true);
		if (controls.ok) assert.match(controls.record.canonicalJson, /\\u007f\\u0080\\u009f/);
		assert.deepEqual(decodeWireBody(outcome.record.wireBody, MARKER), value);
		const decoded = decodeWireBody(outcome.record.wireBody, MARKER);
		assert.ok(decoded !== undefined);
		assert.equal(canonicalJson(decoded), outcome.record.canonicalJson);
	});

	it("refuses non-data descriptors, aliases, holes, unsafe numbers, forbidden scalars, and bad markers", () => {
		const getter = {};
		Object.defineProperty(getter, "x", { enumerable: true, configurable: true, get: () => 1 });
		const shared = { x: 1 };
		const hole = Array(1);
		const symbolObject = { nested: { value: 1 } };
		Object.defineProperty(symbolObject.nested, Symbol("extra"), { value: true });
		for (const value of [getter, [shared, shared], hole, symbolObject, -0, 1.5, "\u200b", "\ud800"]) {
			assert.equal(admit(value).ok, false);
		}
		assert.equal(admitMachineRecord({ marker: "<!-- closes: v1 -->", value: null }).ok, false);
	});

	it("reads no getter or proxy trap and handles deeply nested bounded JSON iteratively", () => {
		let reads = 0;
		const record = {
			marker: MARKER,
			get value() {
				reads += 1;
				return 1;
			},
		};
		assert.equal(admitMachineRecord(record).ok, false);
		const proxy = new Proxy(
			{},
			{
				ownKeys: () => {
					reads += 1;
					return [];
				},
			},
		);
		assert.equal(admitMachineRecord({ marker: MARKER, value: proxy }).ok, false);
		assert.equal(reads, 0);
		let deep: unknown = null;
		for (let index = 0; index < 12_000; index += 1) deep = [deep];
		assert.equal(admitMachineRecord({ marker: MARKER, value: deep }).ok, true);
	});

	it("pins marker, integer, key-order, and independent body-byte boundaries", () => {
		assert.equal(admit(Number.MAX_SAFE_INTEGER).ok, true);
		assert.equal(admit(Number.MAX_SAFE_INTEGER + 1).ok, false);
		const ordered = admit({ "10": 10, "2": 2, a: 1 });
		assert.equal(ordered.ok, true);
		if (ordered.ok) assert.equal(ordered.record.canonicalJson, '{"10":10,"2":2,"a":1}');
		assert.equal(admitMachineRecord({ marker: "<!-- machine-record: v1 z=1 a=2 -->", value: null }).ok, false);
		const overhead = Buffer.byteLength(MARKER, "utf8") + 1 + 2;
		assert.equal(admit("a".repeat(65_536 - overhead)).ok, true);
		assert.equal(admit("a".repeat(65_537 - overhead)).ok, false);
	});

	it("admits one bounded lowercase-u escape view and refuses malformed or unsafe views", () => {
		assert.deepEqual(decodeEscapeView("a\\u0040b"), { ok: true, value: "a@b" });
		assert.deepEqual(decodeEscapeView("\\uD83D\\uDE00"), { ok: true, value: "😀" });
		for (const value of ["\\U0040", "\\u12", "\\uD800x", "\\uDC00", "\\u0000", "\\u200b", "\\x40"]) {
			assert.equal(decodeEscapeView(value).ok, false);
		}
	});
});

describe("machine publication transport", () => {
	it("binds post-spawn error classification to the observed spawn event", async () => {
		const source = await readFile(new URL("../.pi/extensions/gitjig/publish/executor.ts", import.meta.url), "utf8");
		assert.match(source, /child\.on\("spawn", \(\) => \{\s*didSpawn = true;/);
		assert.match(source, /settle\(\{ spawned: didSpawn, code: null, signal: null/);
	});

	it("verifies all six destinations with one send and one GET, and invalid locators with zero GETs", async () => {
		const root = await mkdtemp(join(tmpdir(), "gitjig-machine-"));
		const bin = join(root, "bin");
		const state = join(root, "state");
		await mkdir(bin);
		await mkdir(state);
		const bodyFile = join(root, "body");
		const callsFile = join(root, "calls");
		const metaFile = join(root, "meta");
		const apiArgsFile = join(root, "api-args");
		const shim = join(bin, "gh");
		await writeFile(
			shim,
			`#!/usr/bin/env node
const fs=require("fs"),args=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS,(args[0]==="api"?"get":"send")+"\\n");
if(args[0]==="api"){
 fs.writeFileSync(process.env.APIARGS,args.join(" "));
 const m=JSON.parse(fs.readFileSync(process.env.META,"utf8")),body=process.env.MISMATCH?"wrong":fs.readFileSync(process.env.BODY,"utf8");
 const p={id:process.env.WRONG_ID?9:(m.comment?8:99),html_url:process.env.WRONG_HTML?m.url+"/wrong":m.url,body};if(!process.env.OMIT_NUMBER)p.number=process.env.WRONG_NUMBER?99:m.number;
 if(m.comment)p.issue_url=process.env.WRONG_PARENT?"https://api.github.com/repos/o/r/issues/99":"https://api.github.com/repos/o/r/issues/"+m.number;
 else if(m.noun==="pr")p.base={repo:{full_name:process.env.WRONG_BASE?"x/y":"o/r"}};else if(!process.env.OMIT_REPO)p.repository_url="https://api.github.com/repos/o/r";
 if(m.verb==="create")p.title=process.env.WRONG_TITLE?"wrong":m.title;if(process.env.PULL_SHAPE)p.pull_request={url:"x"};
 process.stdout.write(JSON.stringify(p));
}else{
 const noun=args[0],verb=args[1],comment=verb==="comment",number=verb==="create"?7:Number(args[2]);
 const title=verb==="create"?args[args.indexOf("--title")+1]:undefined;
 const path=noun==="issue"?"issues":"pull",url="https://github.com/o/r/"+path+"/"+number+(comment?"#issuecomment-8":"");
 const chunks=[];process.stdin.on("data",c=>chunks.push(c));process.stdin.on("end",()=>{fs.writeFileSync(process.env.BODY,Buffer.concat(chunks));fs.writeFileSync(process.env.META,JSON.stringify({noun,verb,comment,number,title,url}));const done=()=>{process.stdout.write((process.env.LOCATOR||url)+(process.env.NO_LF?"":"\\n"));if(process.env.FAIL)process.exitCode=1;};if(process.env.HOLD){done();setTimeout(()=>{},5000);}else if(process.env.DELAY)setTimeout(done,5000);else done();});
}
`,
		);
		await chmod(shim, 0o755);
		const prior = {
			PATH: process.env.PATH,
			BODY: process.env.BODY,
			CALLS: process.env.CALLS,
			META: process.env.META,
			BAD: process.env.BAD,
			FAIL: process.env.FAIL,
			MISMATCH: process.env.MISMATCH,
			APIARGS: process.env.APIARGS,
			WRONG_ID: process.env.WRONG_ID,
			WRONG_HTML: process.env.WRONG_HTML,
			WRONG_PARENT: process.env.WRONG_PARENT,
			WRONG_BASE: process.env.WRONG_BASE,
			WRONG_TITLE: process.env.WRONG_TITLE,
			WRONG_NUMBER: process.env.WRONG_NUMBER,
			PULL_SHAPE: process.env.PULL_SHAPE,
			LOCATOR: process.env.LOCATOR,
			OMIT_NUMBER: process.env.OMIT_NUMBER,
			OMIT_REPO: process.env.OMIT_REPO,
			DELAY: process.env.DELAY,
			HOLD: process.env.HOLD,
			NO_LF: process.env.NO_LF,
		};
		Object.assign(process.env, {
			PATH: `${bin}:${prior.PATH}`,
			BODY: bodyFile,
			CALLS: callsFile,
			META: metaFile,
			APIARGS: apiArgsFile,
		});
		try {
			await writeFile(callsFile, "");
			for (const malformed of [
				{
					body: "prose",
					machineRecord: { marker: MARKER, value: null },
					destination: { kind: "issue-comment", number: 7 },
				},
				{
					machineRecord: { marker: MARKER, value: null },
					destination: { kind: "issue-comment", number: 7 },
					extra: true,
				},
			]) {
				const refused = await performPublish(malformed, root, state, { host: "github.com", nameWithOwner: "o/r" });
				assert.equal(refused.details.disposition, "refuse-request");
			}
			let repositoryReads = 0;
			const accessorRepository = {
				get host() {
					repositoryReads += 1;
					return "github.com";
				},
				nameWithOwner: "o/r",
			};
			const repositoryRefusal = await performPublish(
				{ machineRecord: { marker: MARKER, value: null }, destination: { kind: "issue-comment", number: 7 } },
				root,
				state,
				accessorRepository,
			);
			assert.equal(repositoryRefusal.details.disposition, "refuse-repository");
			assert.equal(repositoryReads, 0);

			for (const secret of [
				"-----" + "BEGIN PRIVATE KEY" + "-----",
				"\\u002d\\u002d\\u002d\\u002d\\u002dBEGIN PRIVATE KEY\\u002d\\u002d\\u002d\\u002d\\u002d",
			]) {
				const blocked = await performPublish(
					{ machineRecord: { marker: MARKER, value: secret }, destination: { kind: "issue-comment", number: 7 } },
					root,
					state,
					{ host: "github.com", nameWithOwner: "o/r" },
				);
				assert.equal(blocked.details.disposition, "refuse-match");
			}
			assert.equal(await readFile(callsFile, "utf8"), "", "local refusals must spawn no platform child");

			const oneView = await performPublish(
				{
					machineRecord: {
						marker: MARKER,
						value: "\\u005cu002d\\u005cu002d\\u005cu002d\\u005cu002d\\u005cu002dBEGIN PRIVATE KEY",
					},
					destination: { kind: "issue-comment", number: 7 },
				},
				root,
				state,
				{ host: "github.com", nameWithOwner: "o/r" },
			);
			assert.equal(oneView.details.disposition, "published", "semantic strings receive exactly one decode view");

			const mutableDestination = { kind: "issue-comment", number: 7 };
			const mutationProof = performPublish(
				{ machineRecord: { marker: MARKER, value: null }, destination: mutableDestination },
				root,
				state,
				{ host: "github.com", nameWithOwner: "o/r" },
			);
			mutableDestination.number = 99;
			assert.equal(
				(await mutationProof).details.disposition,
				"published",
				"destination identity is snapshotted before spawn",
			);

			const destinations = [
				{ kind: "issue-comment", number: 7 },
				{ kind: "pr-comment", number: 7 },
				{ kind: "issue-body", number: 7 },
				{ kind: "pr-body", number: 7 },
				{ kind: "issue-create", title: "Machine title" },
				{ kind: "pr-create", title: "Machine title" },
			];
			for (const destination of destinations) {
				await writeFile(callsFile, "");
				const request = {
					machineRecord: {
						marker: MARKER,
						value: { planRecordUrl: "https://github.com/o/r/issues/9#issuecomment-10" },
					},
					destination,
				};
				const result = await performPublish(request, root, state, { host: "github.com", nameWithOwner: "o/r" });
				assert.equal(result.details.disposition, "published", destination.kind);
				assert.equal(result.details.verified, true, destination.kind);
				assert.deepEqual((await readFile(callsFile, "utf8")).trim().split("\n"), ["send", "get"]);
				const expectedPath = destination.kind.endsWith("comment")
					? "/repos/o/r/issues/comments/8"
					: destination.kind.startsWith("issue")
						? "/repos/o/r/issues/7"
						: "/repos/o/r/pulls/7";
				assert.equal(await readFile(apiArgsFile, "utf8"), `api --hostname github.com ${expectedPath}`);
			}
			const wire = await readFile(bodyFile, "utf8");
			assert.doesNotMatch(wire, /https:\/\//);
			const decoded = decodeWireBody(wire, MARKER) as { planRecordUrl?: unknown } | undefined;
			assert.equal(decoded?.planRecordUrl, "https://github.com/o/r/issues/9#issuecomment-10");

			await writeFile(callsFile, "");
			const titled = await performPublish(
				{ machineRecord: { marker: MARKER, value: null }, destination: { kind: "issue-create", title: "@operator" } },
				root,
				state,
				{ host: "github.com", nameWithOwner: "o/r" },
			);
			assert.equal(titled.details.disposition, "published");
			assert.equal(titled.details.neutralized, 1);
			assert.deepEqual((await readFile(callsFile, "utf8")).trim().split("\n"), ["send", "get"]);

			await writeFile(callsFile, "");
			process.env.FAIL = "1";
			const terminalFailure = await performPublish(
				{ machineRecord: { marker: MARKER, value: null }, destination: { kind: "issue-comment", number: 7 } },
				root,
				state,
				{ host: "github.com", nameWithOwner: "o/r" },
			);
			assert.equal(terminalFailure.details.disposition, "published", "an exact reread outranks send terminal status");
			assert.deepEqual((await readFile(callsFile, "utf8")).trim().split("\n"), ["send", "get"]);
			delete process.env.FAIL;

			await writeFile(callsFile, "");
			process.env.MISMATCH = "1";
			const mismatch = await performPublish(
				{ machineRecord: { marker: MARKER, value: null }, destination: { kind: "issue-comment", number: 7 } },
				root,
				state,
				{ host: "github.com", nameWithOwner: "o/r" },
			);
			assert.equal(mismatch.details.disposition, "outcome-unverified");
			assert.deepEqual((await readFile(callsFile, "utf8")).trim().split("\n"), ["send", "get"]);
			delete process.env.MISMATCH;

			for (const variable of ["OMIT_NUMBER", "OMIT_REPO"] as const) {
				await writeFile(callsFile, "");
				process.env[variable] = "1";
				const destination =
					variable === "OMIT_REPO" ? { kind: "issue-body", number: 7 } : { kind: "pr-body", number: 7 };
				const missing = await performPublish(
					{ machineRecord: { marker: MARKER, value: null }, destination },
					root,
					state,
					{ host: "github.com", nameWithOwner: "o/r" },
				);
				assert.equal(missing.details.disposition, "outcome-unverified", variable);
				assert.deepEqual((await readFile(callsFile, "utf8")).trim().split("\n"), ["send", "get"]);
				delete process.env[variable];
			}

			for (const [variable, destination] of [
				["WRONG_ID", { kind: "issue-comment", number: 7 }],
				["WRONG_HTML", { kind: "issue-body", number: 7 }],
				["WRONG_PARENT", { kind: "pr-comment", number: 7 }],
				["WRONG_BASE", { kind: "pr-body", number: 7 }],
				["WRONG_TITLE", { kind: "pr-create", title: "Machine title" }],
				["WRONG_NUMBER", { kind: "issue-body", number: 7 }],
				["PULL_SHAPE", { kind: "issue-body", number: 7 }],
			] as const) {
				await writeFile(callsFile, "");
				process.env[variable] = "1";
				const mismatch = await performPublish(
					{ machineRecord: { marker: MARKER, value: null }, destination },
					root,
					state,
					{ host: "github.com", nameWithOwner: "o/r" },
				);
				assert.equal(mismatch.details.disposition, "outcome-unverified", variable);
				assert.deepEqual((await readFile(callsFile, "utf8")).trim().split("\n"), ["send", "get"]);
				delete process.env[variable];
			}

			for (const locator of [
				"https://github.com:443/o/r/issues/7#issuecomment-8",
				"https://github.com/o/r/x/../issues/7#issuecomment-8",
				"https://github.com/o/r/%2e%2e/issues/7#issuecomment-8",
				"https://github.com/o/r/issues/07#issuecomment-8",
				"https://github.com/o/r/issues/7?#issuecomment-8",
				`https://github.com/o/r/issues/7#issuecomment-8${"x".repeat(4096)}`,
			]) {
				await writeFile(callsFile, "");
				process.env.LOCATOR = locator;
				const invalid = await performPublish(
					{ machineRecord: { marker: MARKER, value: null }, destination: { kind: "issue-comment", number: 7 } },
					root,
					state,
					{ host: "github.com", nameWithOwner: "o/r" },
				);
				assert.equal(invalid.details.disposition, "outcome-unverified", locator);
				assert.deepEqual((await readFile(callsFile, "utf8")).trim().split("\n"), ["send"]);
				delete process.env.LOCATOR;
			}
			await writeFile(callsFile, "");
			process.env.NO_LF = "1";
			const noLf = await performPublish(
				{ machineRecord: { marker: MARKER, value: null }, destination: { kind: "issue-comment", number: 7 } },
				root,
				state,
				{ host: "github.com", nameWithOwner: "o/r" },
			);
			assert.equal(noLf.details.disposition, "outcome-unverified");
			assert.deepEqual((await readFile(callsFile, "utf8")).trim().split("\n"), ["send"]);
			delete process.env.NO_LF;

			await writeFile(callsFile, "");
			const preAborted = new AbortController();
			preAborted.abort();
			const stopped = await performPublish(
				{ machineRecord: { marker: MARKER, value: null }, destination: { kind: "issue-comment", number: 7 } },
				root,
				state,
				{ host: "github.com", nameWithOwner: "o/r" },
				preAborted.signal,
			);
			assert.equal(stopped.details.disposition, "refuse-delegated");
			assert.equal(await readFile(callsFile, "utf8"), "");

			process.env.DELAY = "1";
			const noLocatorController = new AbortController();
			const noLocatorPending = performPublish(
				{ machineRecord: { marker: MARKER, value: null }, destination: { kind: "issue-comment", number: 7 } },
				root,
				state,
				{ host: "github.com", nameWithOwner: "o/r" },
				noLocatorController.signal,
			);
			for (let attempt = 0; attempt < 100 && !(await readFile(callsFile, "utf8")).includes("send"); attempt += 1)
				await new Promise((resolve) => setTimeout(resolve, 10));
			noLocatorController.abort();
			assert.equal((await noLocatorPending).details.disposition, "outcome-unverified");
			assert.deepEqual((await readFile(callsFile, "utf8")).trim().split("\n"), ["send"]);
			delete process.env.DELAY;

			await writeFile(callsFile, "");
			process.env.HOLD = "1";
			const controller = new AbortController();
			const pending = performPublish(
				{ machineRecord: { marker: MARKER, value: null }, destination: { kind: "issue-comment", number: 7 } },
				root,
				state,
				{ host: "github.com", nameWithOwner: "o/r" },
				controller.signal,
			);
			for (let attempt = 0; attempt < 100 && !(await readFile(callsFile, "utf8")).includes("send"); attempt += 1)
				await new Promise((resolve) => setTimeout(resolve, 10));
			await new Promise((resolve) => setTimeout(resolve, 30));
			controller.abort();
			const aborted = await pending;
			assert.equal(aborted.details.disposition, "published", "a captured strict locator compels one GET after abort");
			assert.deepEqual((await readFile(callsFile, "utf8")).trim().split("\n"), ["send", "get"]);
			delete process.env.HOLD;
		} finally {
			for (const [key, value] of Object.entries(prior)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});

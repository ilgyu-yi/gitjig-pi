import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
		assert.deepEqual(decodeWireBody(outcome.record.wireBody, MARKER), value);
		assert.equal(canonicalJson(decodeWireBody(outcome.record.wireBody, MARKER)!), outcome.record.canonicalJson);
	});

	it("refuses non-data descriptors, aliases, holes, unsafe numbers, forbidden scalars, and bad markers", () => {
		const getter = {};
		Object.defineProperty(getter, "x", { enumerable: true, configurable: true, get: () => 1 });
		const shared = { x: 1 };
		const hole = Array(1);
		for (const value of [getter, [shared, shared], hole, -0, 1.5, "\u200b", "\ud800"]) {
			assert.equal(admit(value).ok, false);
		}
		assert.equal(admitMachineRecord({ marker: "<!-- closes: v1 -->", value: null }).ok, false);
	});

	it("reads no getter on the request or recursive value", () => {
		let reads = 0;
		const record = {
			marker: MARKER,
			get value() {
				reads += 1;
				return 1;
			},
		};
		assert.equal(admitMachineRecord(record).ok, false);
		assert.equal(reads, 0);
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
	it("verifies all six destinations with one send and one GET, and invalid locators with zero GETs", async () => {
		const root = await mkdtemp(join(tmpdir(), "gitjig-machine-"));
		const bin = join(root, "bin");
		const state = join(root, "state");
		await mkdir(bin);
		await mkdir(state);
		const bodyFile = join(root, "body");
		const callsFile = join(root, "calls");
		const metaFile = join(root, "meta");
		const shim = join(bin, "gh");
		await writeFile(
			shim,
			`#!/usr/bin/env node
const fs=require("fs"),args=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS,(args[0]==="api"?"get":"send")+"\\n");
if(args[0]==="api"){
 const m=JSON.parse(fs.readFileSync(process.env.META,"utf8")),body=process.env.MISMATCH?"wrong":fs.readFileSync(process.env.BODY,"utf8");
 const p={id:m.comment?8:99,number:m.number,html_url:m.url,body};
 if(m.comment)p.issue_url="https://api.github.com/repos/o/r/issues/"+m.number;
 else if(m.noun==="pr")p.base={repo:{full_name:"o/r"}};
 if(m.verb==="create")p.title=m.title;
 process.stdout.write(JSON.stringify(p));
}else{
 const noun=args[0],verb=args[1],comment=verb==="comment",number=verb==="create"?7:Number(args[2]);
 const title=verb==="create"?args[args.indexOf("--title")+1]:undefined;
 const path=noun==="issue"?"issues":"pull",url="https://github.com/o/r/"+path+"/"+number+(comment?"#issuecomment-8":"");
 const chunks=[];process.stdin.on("data",c=>chunks.push(c));process.stdin.on("end",()=>{fs.writeFileSync(process.env.BODY,Buffer.concat(chunks));fs.writeFileSync(process.env.META,JSON.stringify({noun,verb,comment,number,title,url}));process.stdout.write(process.env.BAD?"https://evil.example/o/r/issues/7#issuecomment-8\\n":url+"\\n");if(process.env.FAIL)process.exitCode=1;});
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
		};
		Object.assign(process.env, { PATH: `${bin}:${prior.PATH}`, BODY: bodyFile, CALLS: callsFile, META: metaFile });
		try {
			await writeFile(callsFile, "");
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
			}
			const wire = await readFile(bodyFile, "utf8");
			assert.doesNotMatch(wire, /https:\/\//);
			const decoded = decodeWireBody(wire, MARKER) as { planRecordUrl?: unknown } | undefined;
			assert.equal(decoded?.planRecordUrl, "https://github.com/o/r/issues/9#issuecomment-10");

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

			await writeFile(callsFile, "");
			process.env.BAD = "1";
			const refused = await performPublish(
				{ machineRecord: { marker: MARKER, value: null }, destination: { kind: "issue-comment", number: 7 } },
				root,
				state,
				{ host: "github.com", nameWithOwner: "o/r" },
			);
			assert.equal(refused.details.disposition, "outcome-unverified");
			assert.deepEqual((await readFile(callsFile, "utf8")).trim().split("\n"), ["send"]);
		} finally {
			for (const [key, value] of Object.entries(prior))
				value === undefined ? delete process.env[key] : (process.env[key] = value);
		}
	});
});

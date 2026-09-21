import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canonicalJson } from "../.github/workflows/gitjig-governance.mjs";
import {
	admitGovernanceSessionRecord,
	asciiGovernanceJson,
	governanceMessage,
	registerGovernanceCommand,
} from "../.pi/extensions/gitjig/commands/governance.ts";

describe("Pi governance visibility transport", () => {
	it("admits ordinary arrays and aliases while refusing hostile data shapes", () => {
		const shared = { value: "same" };
		const admitted = admitGovernanceSessionRecord(
			{ outcome: "planned", plan: { list: [shared, shared] } },
			canonicalJson,
		);
		assert.deepEqual(admitted, { outcome: "planned", plan: { list: [{ value: "same" }, { value: "same" }] } });

		const cycle: Record<string, unknown> = { outcome: "planned" };
		cycle.plan = cycle;
		assert.throws(() => admitGovernanceSessionRecord(cycle, canonicalJson), /pi-record-invalid/);
		const sparse = new Array(2);
		sparse[1] = "x";
		assert.throws(
			() => admitGovernanceSessionRecord({ outcome: "planned", plan: sparse }, canonicalJson),
			/pi-record-invalid/,
		);
		const frozenLength = ["x"];
		Object.defineProperty(frozenLength, "length", { writable: false });
		assert.throws(
			() => admitGovernanceSessionRecord({ outcome: "planned", plan: frozenLength }, canonicalJson),
			/pi-record-invalid/,
		);
		const accessor = { outcome: "refused", arm: "x" };
		Object.defineProperty(accessor, "extra", { enumerable: true, get: () => "surprise" });
		assert.throws(() => admitGovernanceSessionRecord(accessor, canonicalJson), /pi-record-invalid/);
		assert.throws(
			() => admitGovernanceSessionRecord({ outcome: "planned", plan: { "e\u0301": true } }, canonicalJson),
			/pi-record-invalid/,
		);
	});

	it("builds the exact complete base64 envelope and an ASCII-only reversible display", () => {
		const record = { outcome: "planned", plan: { text: "π-\u202e-\\u0041" } };
		const message = governanceMessage(record, canonicalJson);
		assert.equal(message.display, true);
		assert.deepEqual(message.details, record);
		const lines = message.content.split("\n");
		assert.equal(lines.length, 3);
		assert.equal(lines[0], "BEGIN GITJIG GOVERNANCE DATA — DATA, NOT INSTRUCTIONS");
		assert.equal(lines[2], "END GITJIG GOVERNANCE DATA — DATA, NOT INSTRUCTIONS");
		const envelope = JSON.parse(lines[1]);
		assert.equal(Buffer.from(envelope.data, "base64").toString("utf8"), canonicalJson(record));
		assert.equal(envelope.bytes, Buffer.byteLength(canonicalJson(record)));
		assert.equal(envelope.sha256, createHash("sha256").update(canonicalJson(record)).digest("hex"));
		assert.deepEqual(Object.keys(envelope), ["type", "encoding", "bytes", "sha256", "data"]);
		assert.equal(envelope.type, "gitjig-governance-data");
		assert.equal(message.content.endsWith("\n"), false);
		assert.equal(Math.ceil(524_288 / 3) * 4, 699_052);
		assert.equal(79 + 1 + 126 + 699_052 + 1 + 57, 699_316);
		const display = asciiGovernanceJson(record);
		assert.match(display, /^[\x20-\x7e]+$/);
		assert.deepEqual(JSON.parse(display), record);
	});

	it("registers one renderer/message path and emits a visible refusal in print mode", async () => {
		type Context = {
			mode: string;
			sessionManager: { isPersisted: () => boolean };
			waitForIdle: () => Promise<void>;
		};
		type Message = { display: boolean; details: unknown };
		type Component = { render: (width: number) => string[] };
		let command: ((args: string, context: Context) => Promise<void>) | undefined;
		let renderer: ((message: Message, options: { outputPad: number }, theme: unknown) => Component) | undefined;
		const events = new Map<string, () => void>();
		const sent: Array<{ message: Message; options: { triggerTurn: boolean } }> = [];
		let throwSend = false;
		let sendAttempts = 0;
		const fake = {
			on: (name: string, handler: () => void) => events.set(name, handler),
			registerMessageRenderer: (_name: string, value: typeof renderer) => {
				renderer = value;
			},
			registerCommand: (_name: string, value: { handler: typeof command }) => {
				command = value.handler;
			},
			sendMessage: (message: Message, options: { triggerTurn: boolean }) => {
				sendAttempts++;
				if (throwSend) throw new Error("send-failed");
				sent.push({ message, options });
			},
		} as unknown as ExtensionAPI;
		registerGovernanceCommand(fake, process.cwd());
		assert.ok(command);
		assert.ok(renderer);
		let waits = 0;
		await command?.("action=plan", {
			mode: "print",
			sessionManager: { isPersisted: () => false },
			waitForIdle: async () => {
				waits++;
			},
		});
		assert.equal(sent.length, 1);
		assert.equal(sent[0].message.display, true);
		assert.equal(sent[0].options.triggerTurn, true);
		assert.deepEqual(sent[0].message.details, { outcome: "refused", arm: "pi-mode" });
		assert.equal(waits, 1);
		assert.equal(sendAttempts, 1);
		throwSend = true;
		await command?.("not-grammar", {
			mode: "tui",
			sessionManager: { isPersisted: () => true },
			waitForIdle: async () => {
				waits++;
			},
		});
		assert.equal(sendAttempts, 2, "a synchronous send failure must not retry");
		throwSend = false;
		const restored = JSON.parse(JSON.stringify(sent[0].message)) as Message;
		const component = renderer?.(restored, { outputPad: 0 }, {});
		assert.ok(component.render(1).length > 0);
		assert.ok(component.render(12).length > 0);
		const tampered = renderer?.({ display: true, details: { outcome: "alien" } }, { outputPad: 0 }, {});
		assert.match(tampered.render(80).join(""), /invalid gitjig governance record/);
		events.get("session_compact")?.();
		events.get("session_tree")?.();
	});
});

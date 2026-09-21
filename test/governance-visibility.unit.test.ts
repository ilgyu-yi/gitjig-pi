import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CAPABILITIES,
	canonicalJson,
	parseGovernanceConfig,
	planGovernance,
} from "../.github/workflows/gitjig-governance.mjs";
import {
	admitGovernanceSessionRecord,
	asciiGovernanceJson,
	governanceMessage,
	registerGovernanceCommand,
} from "../.pi/extensions/gitjig/commands/governance.ts";

const config = parseGovernanceConfig(readFileSync(new URL("../.github/gitjig-governance.json", import.meta.url)));
const disabled: Record<string, unknown> = {
	mergeCommits: false,
	squashMerging: false,
	rebaseMerging: false,
	rulesetEnforcement: "disabled",
	administratorBypass: [],
	allowedMergeMethods: [],
	requiredApprovingReviews: 0,
	dismissStaleReviews: false,
	requiredReviewers: [],
	codeOwnerReview: false,
	lastPushApproval: false,
	reviewThreadResolution: false,
	extraApprovalForUnattributedChanges: false,
	strictRequiredStatusChecks: false,
	doNotEnforceOnCreate: false,
	requiredStatusChecks: [],
	deletionProtection: false,
	nonFastForwardProtection: false,
	requiredLinearHistory: false,
};
function fixturePlan() {
	const capabilities = Object.fromEntries(
		CAPABILITIES.map((name) => {
			const selection = config.capabilities[name];
			return [name, selection.mode === "selected" ? structuredClone(selection.value) : disabled[name]];
		}),
	);
	return planGovernance(config, {
		schemaVersion: 2,
		repository: { ...config.repository, defaultBranchSha: "a".repeat(40) },
		rulesets: [
			{
				id: 7,
				name: config.ruleset.name,
				target: "branch",
				sourceType: "Repository",
				source: config.repository.nameWithOwner,
				include: config.ruleset.include,
				exclude: config.ruleset.exclude,
				ruleTypes: ["pull_request", "required_status_checks", "deletion", "non_fast_forward"],
			},
		],
		capabilities,
	});
}

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
		const fallbackEnvelope = JSON.parse((sent[0].message as Message & { content: string }).content.split("\n")[1]);
		const fallbackCanonical = Buffer.from(fallbackEnvelope.data, "base64").toString("utf8");
		assert.equal(fallbackCanonical, canonicalJson(sent[0].message.details));
		assert.equal(fallbackEnvelope.bytes, Buffer.byteLength(fallbackCanonical));
		assert.equal(fallbackEnvelope.sha256, createHash("sha256").update(fallbackCanonical).digest("hex"));
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

	it("drives plan, audit, presentation, and applied messages through the real CLI platform with a hermetic gh", async () => {
		const root = mkdtempSync(join(tmpdir(), "gitjig-governance-platform-"));
		const bin = join(root, "bin");
		mkdirSync(bin);
		const plan = fixturePlan();
		const planPath = join(root, "plan.json");
		writeFileSync(planPath, `${canonicalJson(plan)}\n`);
		const live = plan.measured;
		const detail = {
			id: 7,
			name: config.ruleset.name,
			target: "branch",
			source_type: "Repository",
			source: config.repository.nameWithOwner,
			enforcement: live.capabilities.rulesetEnforcement,
			bypass_actors: live.capabilities.administratorBypass.map(
				(actor: { actorId: number; actorType: string; bypassMode: string }) => ({
					actor_id: actor.actorId,
					actor_type: actor.actorType,
					bypass_mode: actor.bypassMode,
				}),
			),
			conditions: { ref_name: { include: config.ruleset.include, exclude: config.ruleset.exclude } },
			rules: [
				{
					type: "pull_request",
					parameters: {
						allowed_merge_methods: live.capabilities.allowedMergeMethods,
						required_approving_review_count: live.capabilities.requiredApprovingReviews,
						dismiss_stale_reviews_on_push: live.capabilities.dismissStaleReviews,
						required_reviewers: [],
						require_code_owner_review: live.capabilities.codeOwnerReview,
						require_last_push_approval: live.capabilities.lastPushApproval,
						required_review_thread_resolution: live.capabilities.reviewThreadResolution,
						require_extra_approval_for_unattributed_changes: live.capabilities.extraApprovalForUnattributedChanges,
					},
				},
				{
					type: "required_status_checks",
					parameters: {
						strict_required_status_checks_policy: live.capabilities.strictRequiredStatusChecks,
						do_not_enforce_on_create: live.capabilities.doNotEnforceOnCreate,
						required_status_checks: live.capabilities.requiredStatusChecks.map(
							(check: { context: string; integrationId: number | null }) => ({
								context: check.context,
								integration_id: check.integrationId,
							}),
						),
					},
				},
				{ type: "deletion" },
				{ type: "non_fast_forward" },
			],
		};
		const responses = {
			repository: {
				node_id: config.repository.id,
				full_name: config.repository.nameWithOwner,
				default_branch: config.repository.defaultBranch,
				allow_merge_commit: true,
				allow_squash_merge: false,
				allow_rebase_merge: false,
			},
			head: { ref: `refs/heads/${config.repository.defaultBranch}`, object: { type: "commit", sha: "a".repeat(40) } },
			summaries: [{ id: 7, name: config.ruleset.name, source_type: "Repository" }],
			detail,
		};
		const gh = join(bin, "gh");
		writeFileSync(
			gh,
			`#!/usr/bin/env node\nconst r=${JSON.stringify(responses)};const a=process.argv;const p=a.at(-1);let v;if(p.includes('/git/ref/heads/'))v=r.head;else if(p.includes('/rulesets/7'))v=r.detail;else if(p.includes('/rulesets?'))v=r.summaries;else if(p==='repos/${config.repository.nameWithOwner}')v=r.repository;else process.exit(2);process.stdout.write(JSON.stringify(v));\n`,
		);
		chmodSync(gh, 0o755);
		const priorPath = process.env.PATH;
		process.env.PATH = `${bin}:${priorPath}`;
		try {
			let command: ((args: string, context: unknown) => Promise<void>) | undefined;
			const sent: Array<{ details: Record<string, unknown> }> = [];
			const fake = {
				on: () => {},
				registerMessageRenderer: () => {},
				registerCommand: (_name: string, value: { handler: typeof command }) => {
					command = value.handler;
				},
				sendMessage: (message: { details: Record<string, unknown> }) => sent.push(message),
			} as unknown as ExtensionAPI;
			registerGovernanceCommand(fake, process.cwd());
			const context = {
				mode: "json",
				sessionManager: { isPersisted: () => false },
				waitForIdle: async () => {},
			};
			await command?.("action=plan", context);
			await command?.("action=audit", context);
			context.mode = "tui";
			context.sessionManager = { isPersisted: () => true };
			await command?.(`action=apply plan=${planPath}`, context);
			const presentation = sent.at(-1)?.details;
			await command?.(
				`action=apply plan=${planPath} attempt=${presentation?.attemptId} confirm=${encodeURIComponent(String(presentation?.confirmation))}`,
				context,
			);
			assert.deepEqual(
				sent.map((message) => message.details.outcome),
				["planned", "audited", "presented", "applied"],
			);
			assert.deepEqual(JSON.parse(JSON.stringify(sent)), sent);
		} finally {
			process.env.PATH = priorPath;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("inserts authority only after presentation send and clears it on wait failure or tree changes", async () => {
		const root = mkdtempSync(join(tmpdir(), "gitjig-governance-attempt-"));
		const planPath = join(root, "plan.json");
		writeFileSync(planPath, `${canonicalJson(fixturePlan())}\n`);
		try {
			for (const invalidator of ["send", "wait", "session_tree", "session_compact"] as const) {
				let command: ((args: string, context: unknown) => Promise<void>) | undefined;
				const events = new Map<string, () => void>();
				const sent: Array<{ details: Record<string, unknown> }> = [];
				const fake = {
					on: (name: string, handler: () => void) => events.set(name, handler),
					registerMessageRenderer: () => {},
					registerCommand: (_name: string, value: { handler: typeof command }) => {
						command = value.handler;
					},
					sendMessage: (message: { details: Record<string, unknown> }) => {
						sent.push(message);
						if (invalidator === "send" && sent.length === 1) throw new Error("send-failed");
					},
				} as unknown as ExtensionAPI;
				registerGovernanceCommand(fake, process.cwd());
				let rejectWait = invalidator === "wait";
				const context = {
					mode: "tui",
					sessionManager: { isPersisted: () => true },
					waitForIdle: async () => {
						if (rejectWait) throw new Error("wait-failed");
					},
				};
				await command?.(`action=apply plan=${planPath}`, context);
				const presentation = sent[0]?.details;
				assert.equal(presentation?.outcome, "presented");
				rejectWait = false;
				if (invalidator.startsWith("session_")) events.get(invalidator)?.();
				const attempt = String(presentation?.attemptId);
				const confirmation = encodeURIComponent(String(presentation?.confirmation));
				await command?.(`action=apply plan=${planPath} attempt=${attempt} confirm=${confirmation}`, context);
				assert.equal(sent.at(-1)?.details.outcome, "refused");
				assert.equal(sent.at(-1)?.details.arm, "confirmation-mismatch");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

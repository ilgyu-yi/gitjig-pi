import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { composeAdopter, GENERATED_PIN_PATH, type Occupant } from "../.pi/extensions/gitjig/install/compose.ts";
import {
	createDeliveryEgress,
	type DeliveryPlatform,
	type DeliveryTarget,
	type DraftPullRequestRequest,
	deliverAdopter,
} from "../.pi/extensions/gitjig/install/delivery.ts";

const root = mkdtempSync(join(tmpdir(), "gitjig-delivery-"));
const source = { provider: "github" as const, host: "github.com" as const, owner: "example", repository: "source" };
const target: DeliveryTarget = {
	source: { provider: "github", host: "github.com", owner: "example", repository: "target" },
	baseRef: "main",
	baseRevision: "1".repeat(40),
};

before(() => {
	for (const dir of [".pi/extensions", ".github/workflows", ".githooks", "changelog_unreleased"])
		mkdirSync(join(root, dir), { recursive: true });
	writeFileSync(join(root, ".pi/extensions/gitjig.ts"), "carried\n");
	writeFileSync(join(root, ".github/workflows/check.yml"), "name: check\n");
	writeFileSync(join(root, ".githooks/pre-commit"), "#!/bin/sh\nexit 0\n");
	writeFileSync(join(root, "changelog_unreleased/TEMPLATE.md"), "template\n");
});
after(() => rmSync(root, { recursive: true, force: true }));

function composition(kind: "initial" | "converged" = "initial") {
	const first = composeAdopter({
		sourceRoot: root,
		source,
		revision: "a".repeat(40),
		priorPinBytes: null,
		occupants: new Map(),
	});
	const occupants = new Map<string, Occupant>();
	for (const entry of first.pin.manifest) occupants.set(entry.path, { kind: "absent" });
	occupants.set(GENERATED_PIN_PATH, { kind: "absent" });
	if (kind === "converged") {
		for (const candidate of first.candidates)
			if (candidate.disposition === "handed-over" || candidate.disposition === "carried")
				occupants.set(candidate.path, { kind: "bytes", bytes: candidate.bytes });
		occupants.set(GENERATED_PIN_PATH, { kind: "bytes", bytes: first.pinBytes });
	}
	return composeAdopter({
		sourceRoot: root,
		source,
		revision: "a".repeat(40),
		priorPinBytes: null,
		occupants,
	});
}

function acceptingPlatform(calls: DraftPullRequestRequest[]): DeliveryPlatform {
	return {
		async publishDraft(request) {
			calls.push(request);
			return {
				source: request.target.source,
				baseRef: request.target.baseRef,
				baseRevision: request.target.baseRevision,
				headRevision: "2".repeat(40),
				number: 17,
				draft: true,
				title: request.title,
				body: request.body,
				changes: request.changes,
			};
		},
	};
}
const egress = { prepare: (title: string, body: string) => ({ outcome: "prepared" as const, title, body }) };

describe("#118 reviewed delivery", () => {
	it("publishes one atomic draft projection containing handed members and the pin, never carried bytes", async () => {
		const calls: DraftPullRequestRequest[] = [];
		const result = await deliverAdopter({
			composition: composition(),
			target,
			title: "Adopt project substrate",
			body: "Reviewed fixture delivery.",
			egress,
			platform: acceptingPlatform(calls),
		});
		assert.equal(result.outcome, "verified");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.draft, true);
		assert.deepEqual(
			calls[0]?.changes.map((change) => change.path),
			[".githooks/pre-commit", ".github/workflows/check.yml", "changelog_unreleased/TEMPLATE.md", GENERATED_PIN_PATH],
		);
		assert.ok(!calls[0]?.changes.some((change) => change.path === ".pi/extensions/gitjig.ts"));
	});

	it("projects clean replacement and retirement actions without inventing decisions", async () => {
		const prior = composition("converged");
		writeFileSync(join(root, ".github/workflows/check.yml"), "name: changed\n");
		rmSync(join(root, "changelog_unreleased/TEMPLATE.md"));
		try {
			const occupants = new Map<string, Occupant>();
			for (const candidate of prior.candidates)
				if (candidate.disposition === "handed-over" || candidate.disposition === "carried")
					occupants.set(candidate.path, { kind: "bytes", bytes: candidate.bytes });
			occupants.set(GENERATED_PIN_PATH, { kind: "bytes", bytes: prior.pinBytes });
			const update = composeAdopter({
				sourceRoot: root,
				source,
				revision: "b".repeat(40),
				priorPinBytes: prior.pinBytes,
				occupants,
			});
			const calls: DraftPullRequestRequest[] = [];
			const result = await deliverAdopter({
				composition: update,
				target,
				title: "Update",
				body: "Reviewed.",
				egress,
				platform: acceptingPlatform(calls),
			});
			assert.equal(result.outcome, "verified");
			assert.deepEqual(
				calls[0]?.changes.map(({ path, action, operation }) => ({ path, action, operation })),
				[
					{ path: ".github/workflows/check.yml", action: "replace", operation: "upsert" },
					{ path: "changelog_unreleased/TEMPLATE.md", action: "retire", operation: "delete" },
					{ path: GENERATED_PIN_PATH, action: "replace", operation: "upsert" },
				],
			);
		} finally {
			writeFileSync(join(root, ".github/workflows/check.yml"), "name: check\n");
			writeFileSync(join(root, "changelog_unreleased/TEMPLATE.md"), "template\n");
		}
	});

	it("returns converged without invoking egress or platform", async () => {
		let touched = false;
		const result = await deliverAdopter({
			composition: composition("converged"),
			target,
			title: "unused",
			body: "unused",
			egress: {
				prepare: () => {
					touched = true;
					return { outcome: "refused" };
				},
			},
			platform: {
				async publishDraft() {
					touched = true;
					return null;
				},
			},
		});
		assert.equal(result.outcome, "converged");
		assert.equal(touched, false);
	});

	it("uses the landed egress predicate for delivery prose", () => {
		mkdirSync(join(root, "state"), { recursive: true });
		const boundary = createDeliveryEgress(join(root, "state"));
		assert.equal(boundary.prepare("Adopt @operator", "Body GH-118").outcome, "prepared");
		assert.equal(boundary.prepare("Adopt", "outside\0domain").outcome, "refused");
	});

	it("fails closed before platform publication when egress refuses", async () => {
		const calls: DraftPullRequestRequest[] = [];
		const result = await deliverAdopter({
			composition: composition(),
			target,
			title: "secret",
			body: "withheld",
			egress: { prepare: () => ({ outcome: "refused" }) },
			platform: acceptingPlatform(calls),
		});
		assert.deepEqual(
			{ outcome: result.outcome, cause: "cause" in result ? result.cause : "" },
			{ outcome: "refused", cause: "egress-refused" },
		);
		assert.equal(calls.length, 0);
		assert.ok(!JSON.stringify(result).includes("withheld"));
	});

	it("refuses unconfirmed or mismatched platform outcomes without claiming delivery", async () => {
		for (const platform of [
			{
				async publishDraft() {
					return null;
				},
			},
			{
				async publishDraft(request: DraftPullRequestRequest) {
					return {
						source: request.target.source,
						baseRef: request.target.baseRef,
						baseRevision: "3".repeat(40),
						headRevision: "2".repeat(40),
						number: 1,
						draft: true,
						title: request.title,
						body: request.body,
						changes: request.changes,
					};
				},
			},
		]) {
			const result = await deliverAdopter({
				composition: composition(),
				target,
				title: "title",
				body: "body",
				egress,
				platform,
			});
			assert.equal(result.outcome, "refused");
		}
	});

	it("rejects every unconfirmed platform identity and payload field", async () => {
		const mutations: Array<(request: DraftPullRequestRequest) => Record<string, unknown>> = [
			(request) => ({ source: { ...request.target.source, repository: "other" } }),
			() => ({ baseRef: "other" }),
			() => ({ baseRevision: "3".repeat(40) }),
			(request) => ({ headRevision: request.target.baseRevision }),
			() => ({ headRevision: "not-a-sha" }),
			() => ({ number: 0 }),
			() => ({ draft: false }),
			() => ({ title: "other" }),
			() => ({ body: "other" }),
			() => ({ changes: [] }),
			(request) => ({
				changes: request.changes.map((change, index) =>
					index === 0 ? { ...change, path: `${change.path}.altered` } : change,
				),
			}),
		];
		for (const mutate of mutations) {
			const platform: DeliveryPlatform = {
				async publishDraft(request) {
					return {
						source: request.target.source,
						baseRef: request.target.baseRef,
						baseRevision: request.target.baseRevision,
						headRevision: "2".repeat(40),
						number: 1,
						draft: true,
						title: request.title,
						body: request.body,
						changes: request.changes,
						...mutate(request),
					} as never;
				},
			};
			const result = await deliverAdopter({
				composition: composition(),
				target,
				title: "title",
				body: "body",
				egress,
				platform,
			});
			assert.equal(result.outcome, "refused");
		}
	});

	it("rejects malformed target, egress, and thrown platform boundaries before a success claim", async () => {
		for (const invalidTarget of [
			{ ...target, baseRevision: "main" },
			{ ...target, source: { ...target.source, host: "example.com" as "github.com" } },
			{ ...target, source: { ...target.source, owner: "bad/name" } },
		]) {
			const result = await deliverAdopter({
				composition: composition(),
				target: invalidTarget,
				title: "title",
				body: "body",
				egress,
				platform: acceptingPlatform([]),
			});
			assert.equal(result.outcome, "refused");
		}
		const thrownEgress = await deliverAdopter({
			composition: composition(),
			target,
			title: "title",
			body: "body",
			egress: {
				prepare() {
					throw new Error("no");
				},
			},
			platform: acceptingPlatform([]),
		});
		assert.equal(thrownEgress.outcome, "refused");
		const thrownPlatform = await deliverAdopter({
			composition: composition(),
			target,
			title: "title",
			body: "body",
			egress,
			platform: {
				async publishDraft() {
					throw new Error("unknown");
				},
			},
		});
		assert.equal(thrownPlatform.outcome, "refused");
	});

	it("named negative: a carried candidate relabeled as handed refuses before platform", async () => {
		const base = composition();
		const carried = base.candidates.find((candidate) => candidate.disposition === "carried");
		assert.ok(carried);
		const forged = {
			...base,
			candidates: base.candidates.map((candidate) =>
				candidate === carried ? { ...candidate, disposition: "handed-over" as const } : candidate,
			),
		};
		const calls: DraftPullRequestRequest[] = [];
		const result = await deliverAdopter({
			composition: forged,
			target,
			title: "title",
			body: "body",
			egress,
			platform: acceptingPlatform(calls),
		});
		assert.equal(result.outcome, "refused");
		assert.equal(calls.length, 0);
	});
});

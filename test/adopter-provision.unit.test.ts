import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { composeAdopter, GENERATED_PIN_PATH, observeOccupants } from "../.pi/extensions/gitjig/install/compose.ts";
import {
	type ProvisionPlatform,
	type ProvisionRequest,
	provisionAdopter,
} from "../.pi/extensions/gitjig/install/provision.ts";

const root = mkdtempSync(join(tmpdir(), "gitjig-provision-"));
const snapshot = join(root, "snapshot");
const target = join(root, "target");
const source = { provider: "github" as const, host: "github.com" as const, owner: "example", repository: "source" };
let pinBytes: Buffer;
let manifestPaths: string[];

before(() => {
	for (const base of [snapshot, target]) mkdirSync(base, { recursive: true });
	for (const dir of [".pi/extensions", ".github", ".githooks", "changelog_unreleased"])
		mkdirSync(join(snapshot, dir), { recursive: true });
	writeFileSync(join(snapshot, ".pi/extensions/gitjig.ts"), "carried\n");
	writeFileSync(join(snapshot, ".github/gate.yml"), "handed\n");
	writeFileSync(join(snapshot, ".githooks/pre-commit"), "hook\n");
	writeFileSync(join(snapshot, "changelog_unreleased/TEMPLATE.md"), "template\n");
	const composition = composeAdopter({
		sourceRoot: snapshot,
		source,
		revision: "a".repeat(40),
		priorPinBytes: null,
		occupants: new Map(),
	});
	pinBytes = composition.pinBytes;
	manifestPaths = composition.pin.manifest.map((entry) => entry.path);
	for (const candidate of composition.candidates) {
		if (candidate.disposition !== "handed-over") continue;
		mkdirSync(join(target, candidate.path, ".."), { recursive: true });
		writeFileSync(join(target, candidate.path), candidate.bytes);
	}
	mkdirSync(join(target, ".pi"), { recursive: true });
	writeFileSync(join(target, GENERATED_PIN_PATH), pinBytes);
});
after(() => rmSync(root, { recursive: true, force: true }));

function platform(
	calls: ProvisionRequest[],
	alter?: (snapshot: Awaited<ReturnType<ProvisionPlatform["apply"]>>) => void,
): ProvisionPlatform {
	return {
		async apply(request) {
			calls.push(request);
			const occupants = new Map(observeOccupants(target, [...manifestPaths, GENERATED_PIN_PATH]));
			for (const change of request.changes)
				occupants.set(
					change.path,
					change.operation === "delete"
						? { kind: "absent" }
						: { kind: "bytes", bytes: Buffer.from(change.bytes ?? []) },
				);
			const result = {
				occupants,
				excluded: [...request.exclude],
				hooksPath: request.bindHooksPath,
			};
			alter?.(result);
			return result;
		},
		async advanceInstalledPin(bytes) {
			return Buffer.from(bytes);
		},
	};
}

describe("#130 carried provision projection", () => {
	it("projects only carried actions and verifies exclusion, binding, and installed pin", async () => {
		const calls: ProvisionRequest[] = [];
		const result = await provisionAdopter({
			snapshotRoot: snapshot,
			targetRoot: target,
			committedPinBytes: pinBytes,
			installedPinBytes: null,
			platform: platform(calls),
		});
		assert.equal(result.outcome, "verified");
		assert.equal(calls.length, 1);
		assert.deepEqual(
			calls[0]?.changes.map((change) => change.path),
			[".pi/extensions/gitjig.ts"],
		);
		assert.deepEqual(calls[0]?.exclude, [".pi/extensions/gitjig.ts"]);
		assert.equal(calls[0]?.bindHooksPath, ".githooks");
	});

	it("refuses before the platform when handed or pin target state is not converged", async () => {
		const original = join(target, ".github/gate.yml");
		writeFileSync(original, "foreign\n");
		try {
			const calls: ProvisionRequest[] = [];
			const result = await provisionAdopter({
				snapshotRoot: snapshot,
				targetRoot: target,
				committedPinBytes: pinBytes,
				installedPinBytes: null,
				platform: platform(calls),
			});
			assert.equal(result.outcome, "refused");
			assert.equal(calls.length, 0);
		} finally {
			writeFileSync(original, "handed\n");
		}
	});

	it("refuses symlinked target occupants and containers before platform mutation", async () => {
		const carriedPath = join(target, ".pi/extensions/gitjig.ts");
		mkdirSync(join(target, ".pi/extensions"), { recursive: true });
		symlinkSync(join(snapshot, ".pi/extensions/gitjig.ts"), carriedPath);
		try {
			const calls: ProvisionRequest[] = [];
			const result = await provisionAdopter({
				snapshotRoot: snapshot,
				targetRoot: target,
				committedPinBytes: pinBytes,
				installedPinBytes: null,
				platform: platform(calls),
			});
			assert.equal(result.outcome, "refused");
			assert.equal(calls.length, 0);
		} finally {
			rmSync(carriedPath, { force: true });
		}
	});

	it("fails closed on unconfirmed and incomplete final state", async () => {
		const nullResult = await provisionAdopter({
			snapshotRoot: snapshot,
			targetRoot: target,
			committedPinBytes: pinBytes,
			installedPinBytes: null,
			platform: {
				async apply() {
					return null;
				},
				async advanceInstalledPin() {
					throw new Error("must not advance");
				},
			},
		});
		assert.equal(nullResult.outcome, "refused");
		const calls: ProvisionRequest[] = [];
		const bad = await provisionAdopter({
			snapshotRoot: snapshot,
			targetRoot: target,
			committedPinBytes: pinBytes,
			installedPinBytes: null,
			platform: platform(calls, (state) => {
				if (state) Object.assign(state, { hooksPath: "other" });
			}),
		});
		assert.equal(bad.outcome, "refused");
	});
});

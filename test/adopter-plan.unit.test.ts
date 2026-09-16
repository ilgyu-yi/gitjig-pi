import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPin, encodePin } from "../.pi/extensions/gitjig/install/pin.ts";
import { type Occupant, planComposition, verifyPlannedState } from "../.pi/extensions/gitjig/install/plan.ts";

const source = { provider: "github" as const, host: "github.com" as const, owner: "o", repository: "r" };
const rev = (n: string) => n.repeat(40);
const member = (path: string, cls: "handed-over" | "carried", body: string) => ({
	path,
	class: cls,
	bytes: Buffer.from(body),
});
const oldPin = buildPin(source, rev("a"), [
	member(".githooks/a", "handed-over", "old"),
	member(".pi/prompts/gone", "carried", "gone"),
]);
const nextPin = buildPin(source, rev("b"), [
	member(".githooks/a", "handed-over", "new"),
	member(".pi/prompts/new", "carried", "new"),
]);
const occupied = (entries: Record<string, string | null>): Map<string, Occupant> =>
	new Map(
		Object.entries(entries).map(([p, b]) => [
			p,
			b === null ? { kind: "absent" } : { kind: "bytes", bytes: Buffer.from(b) },
		]),
	);

describe("#250 total old/new union planner", () => {
	it("plans initial land, exact-next convergence, and foreign refusal", () => {
		const land = planComposition({
			nextPin,
			nextPinBytes: Buffer.from(encodePin(nextPin)),
			priorPinBytes: null,
			occupants: occupied({ ".githooks/a": null, ".pi/prompts/new": "new", ".pi/gitjig.pin.json": null }),
		});
		assert.equal(land.outcome, "planned");
		assert.deepEqual(
			land.members.map((x) => [x.path, x.action]),
			[
				[".githooks/a", "land"],
				[".pi/prompts/new", "converged"],
				[".pi/gitjig.pin.json", "land"],
			],
		);
		const refused = planComposition({
			nextPin,
			nextPinBytes: Buffer.from(encodePin(nextPin)),
			priorPinBytes: null,
			occupants: occupied({ ".githooks/a": "foreign", ".pi/prompts/new": null, ".pi/gitjig.pin.json": null }),
		});
		assert.equal(refused.outcome, "refused");
	});

	it("plans replacement, retirement, additions, and skipped-revision rerun states", () => {
		const plan = planComposition({
			nextPin,
			nextPinBytes: Buffer.from(encodePin(nextPin)),
			priorPinBytes: Buffer.from(encodePin(oldPin)),
			occupants: occupied({
				".githooks/a": "old",
				".pi/prompts/gone": "gone",
				".pi/prompts/new": null,
				".pi/gitjig.pin.json": encodePin(oldPin),
			}),
		});
		assert.equal(plan.outcome, "planned");
		assert.deepEqual(
			plan.members.map((x) => [x.path, x.action]),
			[
				[".githooks/a", "replace"],
				[".pi/prompts/gone", "retire"],
				[".pi/prompts/new", "land"],
				[".pi/gitjig.pin.json", "replace"],
			],
		);
		const prefix = planComposition({
			nextPin,
			nextPinBytes: Buffer.from(encodePin(nextPin)),
			priorPinBytes: Buffer.from(encodePin(oldPin)),
			occupants: occupied({
				".githooks/a": "new",
				".pi/prompts/gone": null,
				".pi/prompts/new": "new",
				".pi/gitjig.pin.json": encodePin(oldPin),
			}),
		});
		assert.equal(prefix.outcome, "planned");
		assert.deepEqual(
			prefix.members.slice(0, 3).map((x) => x.action),
			["converged", "converged", "converged"],
		);
	});

	it("reports verified only after the final manifest and pin comparison", () => {
		const plan = planComposition({
			nextPin,
			nextPinBytes: Buffer.from(encodePin(nextPin)),
			priorPinBytes: Buffer.from(encodePin(oldPin)),
			occupants: occupied({
				".githooks/a": "old",
				".pi/prompts/gone": "gone",
				".pi/prompts/new": null,
				".pi/gitjig.pin.json": encodePin(oldPin),
			}),
		});
		const final = occupied({
			".githooks/a": "new",
			".pi/prompts/gone": null,
			".pi/prompts/new": "new",
			".pi/gitjig.pin.json": encodePin(nextPin),
		});
		assert.equal(verifyPlannedState(plan, nextPin, final, Buffer.from(encodePin(nextPin))), "verified");
		final.set(".githooks/a", { kind: "bytes", bytes: Buffer.from("diverged") });
		assert.equal(verifyPlannedState(plan, nextPin, final, Buffer.from(encodePin(nextPin))), "refused");
	});

	it("refuses changed source, malformed prior pin, local divergence, and same-path class change", () => {
		const common = {
			nextPin,
			nextPinBytes: Buffer.from(encodePin(nextPin)),
			occupants: occupied({
				".githooks/a": "local",
				".pi/prompts/gone": "gone",
				".pi/prompts/new": null,
				".pi/gitjig.pin.json": encodePin(oldPin),
			}),
		};
		assert.equal(planComposition({ ...common, priorPinBytes: Buffer.from("{") }).outcome, "refused");
		assert.equal(planComposition({ ...common, priorPinBytes: Buffer.from(encodePin(oldPin)) }).outcome, "refused");
		const foreign = buildPin({ ...source, owner: "elsewhere" }, rev("a"), []);
		assert.equal(planComposition({ ...common, priorPinBytes: Buffer.from(encodePin(foreign)) }).outcome, "refused");
		const oldClass = buildPin(source, rev("a"), [member(".githooks/a", "carried", "old")]);
		assert.equal(planComposition({ ...common, priorPinBytes: Buffer.from(encodePin(oldClass)) }).outcome, "refused");
	});
});

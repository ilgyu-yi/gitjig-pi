import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPin, encodePin } from "../.pi/extensions/gitjig/install/pin.ts";
import {
	type Occupant,
	type PlannedMember,
	planComposition,
	verifyPlannedState,
} from "../.pi/extensions/gitjig/install/plan.ts";

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
			nextPinBytes: Buffer.from(encodePin(nextPin)),
			priorPinBytes: null,
			occupants: occupied({ ".githooks/a": null, ".pi/prompts/new": "new", ".pi/gitjig.pin.json": null }),
		});
		assert.equal(land.outcome, "planned");
		assert.equal(land.members.at(-1)?.cause, "pin-initial");
		assert.deepEqual(
			land.members.map((x) => [x.path, x.action]),
			[
				[".githooks/a", "land"],
				[".pi/prompts/new", "converged"],
				[".pi/gitjig.pin.json", "land"],
			],
		);
		const refused = planComposition({
			nextPinBytes: Buffer.from(encodePin(nextPin)),
			priorPinBytes: null,
			occupants: occupied({ ".githooks/a": "foreign", ".pi/prompts/new": null, ".pi/gitjig.pin.json": null }),
		});
		assert.equal(refused.outcome, "refused");
	});

	it("plans replacement, retirement, additions, and skipped-revision rerun states", () => {
		const plan = planComposition({
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

	it("totalizes retained, added, and retired occupant states", () => {
		const cases = [
			[".githooks/a", "old", "replace"],
			[".githooks/a", "new", "converged"],
			[".githooks/a", null, "refuse"],
			[".githooks/a", "foreign", "refuse"],
			[".pi/prompts/new", null, "land"],
			[".pi/prompts/new", "new", "converged"],
			[".pi/prompts/new", "foreign", "refuse"],
			[".pi/prompts/gone", "gone", "retire"],
			[".pi/prompts/gone", null, "converged"],
			[".pi/prompts/gone", "foreign", "refuse"],
		] as const;
		for (const [path, body, action] of cases) {
			const states = occupied({
				".githooks/a": "new",
				".pi/prompts/gone": null,
				".pi/prompts/new": "new",
				".pi/gitjig.pin.json": encodePin(oldPin),
			});
			states.set(path, body === null ? { kind: "absent" } : { kind: "bytes", bytes: Buffer.from(body) });
			const plan = planComposition({
				nextPinBytes: Buffer.from(encodePin(nextPin)),
				priorPinBytes: Buffer.from(encodePin(oldPin)),
				occupants: states,
			});
			assert.equal(plan.members.find((item) => item.path === path)?.action, action, path);
			assert.equal(plan.outcome === "refused", action === "refuse", path);
		}
		for (const path of [".githooks/a", ".pi/prompts/new", ".pi/prompts/gone"]) {
			const states = occupied({
				".githooks/a": "new",
				".pi/prompts/gone": null,
				".pi/prompts/new": "new",
				".pi/gitjig.pin.json": encodePin(oldPin),
			});
			states.delete(path);
			const plan = planComposition({
				nextPinBytes: Buffer.from(encodePin(nextPin)),
				priorPinBytes: Buffer.from(encodePin(oldPin)),
				occupants: states,
			});
			assert.equal(plan.members.find((item) => item.path === path)?.cause, "unmeasured-occupant");
			assert.equal(plan.outcome, "refused");
		}
	});

	it("totalizes pin occupants and derives the fully converged outcome", () => {
		const base = { ".githooks/a": "new", ".pi/prompts/gone": null, ".pi/prompts/new": "new" };
		for (const [pinBody, action] of [
			[encodePin(nextPin), "converged"],
			[encodePin(oldPin), "replace"],
			[null, "refuse"],
			["foreign", "refuse"],
		] as const) {
			const plan = planComposition({
				nextPinBytes: Buffer.from(encodePin(nextPin)),
				priorPinBytes: Buffer.from(encodePin(oldPin)),
				occupants: occupied({ ...base, ".pi/gitjig.pin.json": pinBody }),
			});
			assert.equal(plan.members.at(-1)?.action, action);
			assert.equal(plan.outcome === "refused", action === "refuse");
		}
		const missing = occupied({ ...base, ".pi/gitjig.pin.json": encodePin(oldPin) });
		missing.delete(".pi/gitjig.pin.json");
		assert.equal(
			planComposition({
				nextPinBytes: Buffer.from(encodePin(nextPin)),
				priorPinBytes: Buffer.from(encodePin(oldPin)),
				occupants: missing,
			}).members.at(-1)?.cause,
			"unmeasured-occupant",
		);
		const converged = planComposition({
			nextPinBytes: Buffer.from(encodePin(nextPin)),
			priorPinBytes: Buffer.from(encodePin(oldPin)),
			occupants: occupied({ ...base, ".pi/gitjig.pin.json": encodePin(nextPin) }),
		});
		assert.equal(converged.outcome, "converged");
	});

	it("seals the plan evidence before handing it to final verification", () => {
		const plan = planComposition({
			nextPinBytes: Buffer.from(encodePin(nextPin)),
			priorPinBytes: Buffer.from(encodePin(oldPin)),
			occupants: occupied({
				".githooks/a": "old",
				".pi/prompts/gone": "gone",
				".pi/prompts/new": null,
				".pi/gitjig.pin.json": encodePin(oldPin),
			}),
		});
		assert.ok(Object.isFrozen(plan));
		assert.ok(Object.isFrozen(plan.members));
		assert.ok(plan.members.every(Object.isFrozen));
		assert.throws(() => (plan.members as PlannedMember[]).pop(), TypeError);
	});

	it("reports verified only after the final manifest and pin comparison", () => {
		const plan = planComposition({
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
		assert.equal(verifyPlannedState(plan, final, Buffer.from(encodePin(nextPin))), "verified");
		for (const path of [".githooks/a", ".pi/prompts/new", ".pi/prompts/gone", ".pi/gitjig.pin.json"]) {
			const broken = new Map(final);
			broken.delete(path);
			assert.equal(verifyPlannedState(plan, broken, Buffer.from(encodePin(nextPin))), "refused", path);
		}
		const diverged = new Map(final);
		diverged.set(".githooks/a", { kind: "bytes", bytes: Buffer.from("diverged") });
		assert.equal(verifyPlannedState(plan, diverged, Buffer.from(encodePin(nextPin))), "refused");
		assert.equal(verifyPlannedState(plan, final, Buffer.from(encodePin(oldPin))), "refused");
		const refused = { ...plan, outcome: "refused" as const };
		assert.equal(verifyPlannedState(refused, final, Buffer.from(encodePin(nextPin))), "refused");
		const convergedPlan = planComposition({
			nextPinBytes: Buffer.from(encodePin(nextPin)),
			priorPinBytes: Buffer.from(encodePin(oldPin)),
			occupants: final,
		});
		assert.equal(verifyPlannedState(convergedPlan, final, Buffer.from(encodePin(nextPin))), "converged");
	});

	it("refuses changed source, malformed prior pin, local divergence, and same-path class change", () => {
		const common = {
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

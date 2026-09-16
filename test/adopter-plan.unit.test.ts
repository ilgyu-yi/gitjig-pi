import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
			[".githooks/a", "old", "replace", "exact-old", "handed-over"],
			[".githooks/a", "new", "converged", "exact-next", "handed-over"],
			[".githooks/a", null, "refuse", "foreign-occupant", "handed-over"],
			[".githooks/a", "foreign", "refuse", "foreign-occupant", "handed-over"],
			[".pi/prompts/new", null, "land", "initial-absent", "carried"],
			[".pi/prompts/new", "new", "converged", "exact-next", "carried"],
			[".pi/prompts/new", "foreign", "refuse", "foreign-occupant", "carried"],
			[".pi/prompts/gone", "gone", "retire", "exact-old", "carried"],
			[".pi/prompts/gone", null, "converged", "already-retired", "carried"],
			[".pi/prompts/gone", "foreign", "refuse", "foreign-occupant", "carried"],
		] as const;
		for (const [path, body, action, cause, memberClass] of cases) {
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
			const member = plan.members.find((item) => item.path === path);
			assert.deepEqual([member?.action, member?.cause, member?.class], [action, cause, memberClass], path);
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
		for (const [pinBody, action, cause] of [
			[encodePin(nextPin), "converged", "pin-exact-next"],
			[encodePin(oldPin), "replace", "pin-exact-old"],
			[null, "refuse", "foreign-occupant"],
			["foreign", "refuse", "foreign-occupant"],
		] as const) {
			const plan = planComposition({
				nextPinBytes: Buffer.from(encodePin(nextPin)),
				priorPinBytes: Buffer.from(encodePin(oldPin)),
				occupants: occupied({ ...base, ".pi/gitjig.pin.json": pinBody }),
			});
			assert.deepEqual([plan.members.at(-1)?.action, plan.members.at(-1)?.cause], [action, cause]);
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
		assert.equal(converged.members.at(-1)?.cause, "pin-exact-next");
		const exactRerun = planComposition({
			nextPinBytes: Buffer.from(encodePin(nextPin)),
			priorPinBytes: Buffer.from(encodePin(nextPin)),
			occupants: occupied({ ...base, ".pi/gitjig.pin.json": encodePin(nextPin) }),
		});
		assert.equal(exactRerun.outcome, "converged");
		const initialExactPin = planComposition({
			nextPinBytes: Buffer.from(encodePin(nextPin)),
			priorPinBytes: null,
			occupants: occupied({ ...base, ".pi/gitjig.pin.json": encodePin(nextPin) }),
		});
		assert.equal(initialExactPin.outcome, "converged");
		assert.equal(initialExactPin.members.at(-1)?.cause, "pin-exact-next");
		const initialForeignPin = planComposition({
			nextPinBytes: Buffer.from(encodePin(nextPin)),
			priorPinBytes: null,
			occupants: occupied({ ...base, ".pi/gitjig.pin.json": "foreign" }),
		});
		assert.deepEqual(
			[initialForeignPin.outcome, initialForeignPin.members.at(-1)?.action, initialForeignPin.members.at(-1)?.cause],
			["refused", "refuse", "foreign-occupant"],
		);
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
		const resurrected = new Map(final);
		resurrected.set(".pi/prompts/gone", { kind: "bytes", bytes: Buffer.from("foreign") });
		assert.equal(verifyPlannedState(plan, resurrected, Buffer.from(encodePin(nextPin))), "refused");
		assert.equal(verifyPlannedState(plan, final, Buffer.from(encodePin(oldPin))), "refused");
		const malformedPinBytes = Buffer.from("{");
		const malformedPlan = { ...plan, pinDigest: createHash("sha256").update(malformedPinBytes).digest("hex") };
		const malformedFinal = new Map(final);
		malformedFinal.set(".pi/gitjig.pin.json", { kind: "bytes", bytes: malformedPinBytes });
		assert.equal(verifyPlannedState(malformedPlan, malformedFinal, malformedPinBytes), "refused");
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
		const malformedNext = planComposition({ ...common, nextPinBytes: Buffer.from("{"), priorPinBytes: null });
		assert.deepEqual([malformedNext.outcome, malformedNext.members[0]?.cause], ["refused", "malformed-next-pin"]);
		const replacementPin = buildPin({ ...source, owner: "\ufffd" }, rev("b"), []);
		const encodedReplacement = Buffer.from(encodePin(replacementPin));
		const replacementAt = encodedReplacement.indexOf(Buffer.from("\ufffd"));
		assert.notEqual(replacementAt, -1);
		const invalidUtf8 = Buffer.concat([
			encodedReplacement.subarray(0, replacementAt),
			Buffer.from([0xff]),
			encodedReplacement.subarray(replacementAt + 3),
		]);
		const malformedBytes = planComposition({ ...common, nextPinBytes: invalidUtf8, priorPinBytes: null });
		assert.equal(malformedBytes.members[0]?.cause, "malformed-next-pin");
		const malformedPrior = planComposition({ ...common, priorPinBytes: Buffer.from("{") });
		assert.equal(malformedPrior.outcome, "refused");
		assert.ok(malformedPrior.members.every((item) => item.cause === "malformed-prior-pin"));
		assert.equal(planComposition({ ...common, priorPinBytes: Buffer.from(encodePin(oldPin)) }).outcome, "refused");
		const foreign = buildPin({ ...source, owner: "elsewhere" }, rev("a"), [
			member(".pi/prompts/prior-only", "carried", "old"),
		]);
		const changedSource = planComposition({ ...common, priorPinBytes: Buffer.from(encodePin(foreign)) });
		assert.equal(changedSource.outcome, "refused");
		assert.ok(changedSource.members.some((item) => item.path === ".pi/prompts/prior-only"));
		assert.ok(changedSource.members.every((item) => item.cause === "changed-source"));
		const oldClass = buildPin(source, rev("a"), [member(".githooks/a", "carried", "old")]);
		const classChange = planComposition({ ...common, priorPinBytes: Buffer.from(encodePin(oldClass)) });
		assert.equal(classChange.outcome, "refused");
		assert.ok(classChange.members.every((item) => item.cause === "class-transition"));
	});
});

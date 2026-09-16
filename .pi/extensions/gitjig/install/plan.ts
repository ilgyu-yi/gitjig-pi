/** Warning-surface roster: EXEMPT — plan causes are fixed tokens, not rendered operands. */
import { createHash } from "node:crypto";
import { type PinEntry, type PinV1, parsePin, sourceEqual } from "./pin.ts";

export type PlanAction = "land" | "replace" | "retire" | "converged" | "refuse";
export type PlanOutcome = "planned" | "converged" | "refused";
export type TerminalOutcome = "verified" | "converged" | "refused";
export type PlanCause =
	| "initial-absent"
	| "exact-next"
	| "exact-old"
	| "already-retired"
	| "pin-initial"
	| "pin-exact-next"
	| "pin-exact-old"
	| "foreign-occupant"
	| "unmeasured-occupant"
	| "malformed-prior-pin"
	| "changed-source"
	| "class-transition";
export type Occupant = { kind: "absent" } | { kind: "bytes"; bytes: Buffer };
export interface PlannedMember {
	path: string;
	class: PinEntry["class"] | "pin";
	action: PlanAction;
	cause: PlanCause;
}
export interface CompositionPlan {
	outcome: PlanOutcome;
	members: PlannedMember[];
}
export interface PlanInput {
	nextPin: PinV1;
	nextPinBytes: Buffer;
	priorPinBytes: Buffer | null;
	occupants: ReadonlyMap<string, Occupant>;
}

const PIN_PATH = ".pi/gitjig.pin.json";
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
function matches(occupant: Occupant, entry: PinEntry): boolean {
	return (
		occupant.kind === "bytes" && BigInt(occupant.bytes.length) === entry.size && digest(occupant.bytes) === entry.digest
	);
}
function bytesEqual(occupant: Occupant, expected: Buffer): boolean {
	return occupant.kind === "bytes" && occupant.bytes.equals(expected);
}
function refused(path: string, cls: PlannedMember["class"], cause: PlanCause): PlannedMember {
	return { path, class: cls, action: "refuse", cause };
}
function lookup(occupants: ReadonlyMap<string, Occupant>, path: string): Occupant | undefined {
	return occupants.get(path);
}

function globalRefusal(next: PinV1, cause: PlanCause): CompositionPlan {
	const members = next.manifest.map((entry) => refused(entry.path, entry.class, cause));
	members.push(refused(PIN_PATH, "pin", cause));
	return { outcome: "refused", members };
}

export function planComposition(input: PlanInput): CompositionPlan {
	let prior: PinV1 | null = null;
	if (input.priorPinBytes !== null) {
		try {
			prior = parsePin(input.priorPinBytes.toString("utf8"));
		} catch {
			return globalRefusal(input.nextPin, "malformed-prior-pin");
		}
		if (!sourceEqual(prior.source, input.nextPin.source)) return globalRefusal(input.nextPin, "changed-source");
	}
	const oldByPath = new Map((prior?.manifest ?? []).map((entry) => [entry.path, entry]));
	const nextByPath = new Map(input.nextPin.manifest.map((entry) => [entry.path, entry]));
	for (const [path, old] of oldByPath) {
		const next = nextByPath.get(path);
		if (next && next.class !== old.class) return globalRefusal(input.nextPin, "class-transition");
	}
	const paths = [...new Set([...oldByPath.keys(), ...nextByPath.keys()])].sort((a, b) =>
		Buffer.compare(Buffer.from(a), Buffer.from(b)),
	);
	const members: PlannedMember[] = [];
	for (const path of paths) {
		const old = oldByPath.get(path);
		const next = nextByPath.get(path);
		const occupant = lookup(input.occupants, path);
		const cls = next?.class ?? old?.class;
		if (!cls) throw new Error("planner union invariant failed");
		if (!occupant) {
			members.push(refused(path, cls, "unmeasured-occupant"));
			continue;
		}
		if (!prior) {
			if (!next) {
				members.push(refused(path, cls, "foreign-occupant"));
				continue;
			}
			if (occupant.kind === "absent") members.push({ path, class: cls, action: "land", cause: "initial-absent" });
			else if (matches(occupant, next)) members.push({ path, class: cls, action: "converged", cause: "exact-next" });
			else members.push(refused(path, cls, "foreign-occupant"));
			continue;
		}
		if (next && matches(occupant, next)) members.push({ path, class: cls, action: "converged", cause: "exact-next" });
		else if (old && next && matches(occupant, old))
			members.push({ path, class: cls, action: "replace", cause: "exact-old" });
		else if (!old && next && occupant.kind === "absent")
			members.push({ path, class: cls, action: "land", cause: "initial-absent" });
		else if (old && !next && matches(occupant, old))
			members.push({ path, class: cls, action: "retire", cause: "exact-old" });
		else if (old && !next && occupant.kind === "absent")
			members.push({ path, class: cls, action: "converged", cause: "already-retired" });
		else members.push(refused(path, cls, "foreign-occupant"));
	}
	const pinOccupant = lookup(input.occupants, PIN_PATH);
	if (!pinOccupant) members.push(refused(PIN_PATH, "pin", "unmeasured-occupant"));
	else if (bytesEqual(pinOccupant, input.nextPinBytes))
		members.push({ path: PIN_PATH, class: "pin", action: "converged", cause: "pin-exact-next" });
	else if (!prior && pinOccupant.kind === "absent")
		members.push({ path: PIN_PATH, class: "pin", action: "land", cause: "pin-initial" });
	else if (prior && input.priorPinBytes && bytesEqual(pinOccupant, input.priorPinBytes))
		members.push({ path: PIN_PATH, class: "pin", action: "replace", cause: "pin-exact-old" });
	else members.push(refused(PIN_PATH, "pin", "foreign-occupant"));
	if (members.some((member) => member.action === "refuse")) return { outcome: "refused", members };
	return { outcome: members.every((member) => member.action === "converged") ? "converged" : "planned", members };
}

export function verifyPlannedState(
	plan: CompositionPlan,
	pin: PinV1,
	occupants: ReadonlyMap<string, Occupant>,
	pinBytes: Buffer,
): TerminalOutcome {
	if (plan.outcome === "refused") return "refused";
	for (const entry of pin.manifest) {
		const occupant = occupants.get(entry.path);
		if (!occupant || !matches(occupant, entry)) return "refused";
	}
	const expected = new Set(pin.manifest.map((entry) => entry.path));
	for (const member of plan.members)
		if (member.class !== "pin" && !expected.has(member.path) && occupants.get(member.path)?.kind !== "absent")
			return "refused";
	const installedPin = occupants.get(PIN_PATH);
	if (!installedPin || !bytesEqual(installedPin, pinBytes)) return "refused";
	return plan.members.every((member) => member.action === "converged") ? "converged" : "verified";
}

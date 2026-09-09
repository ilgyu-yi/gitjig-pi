/**
 * The reviewer panel orchestrator (issue #169, Directive #166) — the
 * caller side of SPEC §1.7, sitting ABOVE §4.9's dispatcher and never
 * inside it.
 *
 * What this module owns, and what it must never grow into. It derives
 * the required slot set from the change's own paths against the
 * committed policy beside this file, decides each returned result's
 * VALIDITY (§1.6 puts that with the caller, never with the reviewer),
 * concatenates the valid slots' raw findings into the bundle, and
 * decides panel completeness. Every one of those is mechanical. The
 * moment any of them starts reading what a finding MEANS, this module
 * has become the second semantic decision-maker §1.7's one-adjudication
 * -point paragraph forbids — semantics are the Judge's, downstream, and
 * the workflow consequence is the Resolver's after that (§1.9).
 *
 * Why the bundle is not clever. §1.7 makes it transport: no vote, no
 * threshold, no semantic deduplication, no severity, no filtering, no
 * reordering that loses provenance. A bundle that dropped a finding is
 * a defective bundle rather than a strict one, and the property that
 * falls out is the one this panel exists for — one valid finding
 * survives any number of empty co-reviews. Deduplication is the Judge's
 * act and needs the provenance this module carries, so the lens rides
 * with every finding rather than being recoverable only by position.
 *
 * The dispatcher is untouched. The panel is a CALL SITE of §4.9's
 * dispatcher (§3.11's predicate-ownership rule), which keeps owning
 * provisioning, isolation, the bounded return and the blind compare.
 * The only widening this Execution made there is one opaque string
 * slot; the contract for what a reviewer puts in it is stated here,
 * which is what keeps review policy above the dispatcher.
 *
 * What is deliberately NOT here: the Judge, the Resolver, and every
 * axis and disposition they own. A non-empty bundle is this module's
 * terminal output, and a later Execution under #166 consumes it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A required review slot: one lens over one declared surface (§1.7). */
export type Slot = { lens: string; surface: string };

/** A reviewer's returned result, before the caller has ruled on it. */
export type SlotResult =
	| {
			slot: Slot;
			/** §1.6's grammar: exactly two tokens, at a defined position. */
			token: "APPROVED" | "FINDINGS";
			findings: string[];
			/** §4.9's blind-compare outcome, which crosses back as validity alone. */
			compare: "confirmed" | "invalid";
	  }
	| { slot: Slot; malformed: true };

/** One raw finding in the bundle, with the slot it came from (§1.9's dedup needs it). */
export type BundleEntry = { finding: string; lens: string };

export type PanelOutcome =
	| { outcome: "incomplete"; missing: string[] }
	| { outcome: "approved" }
	| { outcome: "bundle"; bundle: BundleEntry[] };

type PolicyRow = { lens: string; surface: string; prefixes: string[] };
type Policy = { version: number; rows: PolicyRow[] };

const POLICY_PATH = join(dirname(fileURLToPath(import.meta.url)), "lens-policy.json");

/**
 * Read the committed policy surface. §1.7 requires it be *committed* —
 * a repository artifact, diffable and reviewable like any other — which
 * is why this reads a tracked file rather than accepting a structure a
 * caller composed in memory. A row with an empty prefix is refused
 * rather than tolerated: an empty prefix matches every string, so it
 * would let anything shaped like a claim select a lens, which is the
 * self-selected-specialist failure §1.7 forbids by name.
 */
export function loadPolicy(path: string = POLICY_PATH): Policy {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Policy;
	if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) {
		throw new Error("lens policy: no rows — a policy that routes nothing is not a routing surface (SPEC §1.7)");
	}
	for (const row of parsed.rows) {
		if (!row.lens || !Array.isArray(row.prefixes) || row.prefixes.length === 0) {
			throw new Error(`lens policy: row "${row.lens}" declares no prefix — it would never route (SPEC §1.7)`);
		}
		for (const prefix of row.prefixes) {
			if (typeof prefix !== "string" || prefix.length === 0) {
				throw new Error(
					`lens policy: row "${row.lens}" carries an empty prefix, which matches every string — a lens no ` +
						"change surface selects is a lens anything selects (SPEC §1.7)",
				);
			}
		}
	}
	return parsed;
}

/**
 * Derive the required slot set from the change's own changed paths
 * (§1.7's authoritative inputs). A pure function of its two arguments:
 * the same change surface derives the same slots every time, which is
 * what makes a routing decision reproducible and auditable after the
 * fact. Order is the policy's, not the input's, so two orderings of one
 * change surface cannot derive two different-looking sets.
 */
export function deriveRequiredSlots(changedPaths: string[], policy: Policy): Slot[] {
	const required: Slot[] = [];
	for (const row of policy.rows) {
		const matched = changedPaths.some((path) => row.prefixes.some((prefix) => path.startsWith(prefix)));
		if (matched) {
			required.push({ lens: row.lens, surface: row.surface });
		}
	}
	return required;
}

/**
 * Rule whether a returned result counts at all — §1.6's caller's fact.
 * Never an approve and never a reject: an invalid result is NO result,
 * and what an absent result does to the panel is `panelOutcome`'s.
 *
 * The four causes §1.7 enumerates, plus the two the grammar itself
 * decides: a result whose token contradicts its own findings is not a
 * result in the grammar (§1.6 fixes FINDINGS as "discovered at least
 * one" and APPROVED as "discovered no finding"), so it is malformed
 * rather than generously read as whichever half looks truthful.
 */
export function decideValidity(result: SlotResult, slot: Slot): { valid: boolean; reason?: string } {
	if ("malformed" in result) {
		return { valid: false, reason: "malformed return" };
	}
	if (result.compare !== "confirmed") {
		return { valid: false, reason: "blind compare not confirmed" };
	}
	if (result.slot.lens !== slot.lens || result.slot.surface !== slot.surface) {
		return { valid: false, reason: "reviewed a surface other than the one the slot required" };
	}
	if (result.token !== "APPROVED" && result.token !== "FINDINGS") {
		return { valid: false, reason: "token outside the two-token grammar" };
	}
	if (result.token === "APPROVED" && result.findings.length > 0) {
		return { valid: false, reason: "APPROVED carrying findings contradicts its own token" };
	}
	if (result.token === "FINDINGS" && result.findings.length === 0) {
		return { valid: false, reason: "FINDINGS carrying none contradicts its own token" };
	}
	return { valid: true };
}

/** Match a returned result to a required slot by lens; validity is decided separately. */
function resultFor(results: SlotResult[], slot: Slot): SlotResult | undefined {
	return results.find((result) => result.slot.lens === slot.lens);
}

/**
 * The bundle: the concatenation of the raw findings returned by every
 * VALID slot (§1.7's mechanical aggregation). Nothing is dropped,
 * filtered, deduplicated, or reordered in a way that loses provenance —
 * two slots reporting the same text yield two entries, because deciding
 * they are one finding is the Judge's act and it needs both.
 */
export function buildBundle(results: SlotResult[], required: Slot[]): BundleEntry[] {
	const bundle: BundleEntry[] = [];
	for (const slot of required) {
		const result = resultFor(results, slot);
		if (result === undefined || !decideValidity(result, slot).valid) {
			continue;
		}
		if ("malformed" in result) {
			continue;
		}
		for (const finding of result.findings) {
			bundle.push({ finding, lens: slot.lens });
		}
	}
	return bundle;
}

/**
 * The panel's outcome. Completeness is the panel's whole contract —
 * every required slot valid, with no threshold below it and no quorum
 * above it (§1.7). An incomplete panel is not a review outcome at all:
 * the caller re-dispatches the missing slots, and until it does the
 * review is incomplete, which passes no gate.
 *
 * On a complete panel with an empty bundle the outcome is APPROVED and
 * there is nothing for a Judge to run on (§1.9's findings-free path).
 * That approval settles the review and only the review: AC closeout and
 * the landing gates are untouched by it, which is why nothing here
 * reaches them.
 */
export function panelOutcome(results: SlotResult[], required: Slot[]): PanelOutcome {
	const missing: string[] = [];
	for (const slot of required) {
		const result = resultFor(results, slot);
		if (result === undefined || !decideValidity(result, slot).valid) {
			missing.push(slot.lens);
		}
	}
	if (missing.length > 0) {
		return { outcome: "incomplete", missing };
	}
	const bundle = buildBundle(results, required);
	return bundle.length === 0 ? { outcome: "approved" } : { outcome: "bundle", bundle };
}

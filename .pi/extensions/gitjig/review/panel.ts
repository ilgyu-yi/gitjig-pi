/**
 * The reviewer panel orchestrator (issue #169, Directive #166) — the
 * caller side of SPEC §1.7, sitting above §4.9's dispatcher.
 *
 * This module derives the required slot set, decides each returned
 * result's validity, concatenates findings into the bundle, and decides
 * panel completeness. It enforces §1.7 and §1.6 and copies neither
 * (§2.8): read those sections for what the panel owes. What lives here
 * instead is the local decisions and the alternatives weighed.
 *
 * DECISION — a result is constructed by the caller, never by a reviewer.
 * `receive()` is the only way to make a SlotResult, and it takes the
 * slot the caller DISPATCHED as a separate argument from anything the
 * delegate returned. The alternative — letting the delegate name its own
 * slot inside the return — was tried and rejected: it makes §1.7's
 * wrong-surface cause unreachable, because the check then compares the
 * delegate's claim against itself, and it lets a delegate satisfy a slot
 * it never reviewed. §1.6 puts validity with the caller precisely so
 * that no part of it rests on a reviewer's own say-so.
 *
 * DECISION — a slot may be answered more than once, and every valid
 * answer contributes. §1.7 lets the caller re-dispatch a missing slot,
 * so a slot can carry a stale invalid result and a fresh valid one. The
 * rejected alternative was first-match-wins, which made the outcome a
 * function of argument ORDER: a stale result could block a slot that had
 * in fact returned, and a stale empty result could mask a fresh finding.
 * Collecting every valid result is order-independent and cannot drop;
 * two answers that are really one finding are the Judge's to merge.
 *
 * DECISION — an unrouted change is its own outcome, not an approval.
 * A change whose paths match no policy row derives an empty required
 * set. Reporting that as Review APPROVED would hand a head an approval
 * no reviewer produced, so it reports `unrouted` and the caller decides.
 * §1.7 sets no floor on the required slot set, so this module does not
 * invent one; it refuses only to call the empty case a review.
 *
 * DECISION — the policy is read from the committed file and from
 * nowhere else. `loadPolicy` takes no path. An earlier shape took one
 * with a committed default, which made the committed property a default
 * rather than a constraint and let routing derive from an untracked file
 * outside the repository. A caller that wants to exercise derivation
 * against a synthetic table calls `deriveRequiredSlots` with one
 * directly; that is derivation under test, not the policy surface.
 *
 * NOT here, by design: the Judge and the Resolver. A non-empty bundle is
 * this module's terminal output. Nothing below reads what a finding
 * means — no filter, no rank, no merge, no severity — because that is
 * the semantic act §1.7 reserves for exactly one downstream point.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { quoted } from "../quote.ts";

/** A required review slot: one lens over one declared surface (§1.7). */
export type Slot = { lens: string; surface: string };

/** What a reviewer returned, before the caller has ruled on it. */
export type ReviewerReturn =
	| { token: "APPROVED" | "FINDINGS"; findings: string[] }
	/** The shapes §1.7 names that carry no reviewer output at all. */
	| { failure: "timeout" | "malformed" };

/**
 * A result, as the CALLER records it. `slot` is what the caller
 * dispatched and `compare` is the caller's own blind-compare outcome
 * (§1.6); neither is anything the delegate said. Built only by
 * `receive`.
 */
export type SlotResult = {
	readonly slot: Slot;
	readonly compare: "confirmed" | "invalid";
	readonly returned: ReviewerReturn;
};

/** One raw finding in the bundle, with the slot it came from. */
export type BundleEntry = { finding: string; lens: string };

export type PanelOutcome =
	| { outcome: "unrouted" }
	| { outcome: "incomplete"; missing: string[] }
	| { outcome: "approved" }
	| { outcome: "bundle"; bundle: BundleEntry[] };

type PolicyRow = { lens: string; surface: string; prefixes: string[] };
export type Policy = { version: number; rows: PolicyRow[] };

const POLICY_PATH = join(dirname(fileURLToPath(import.meta.url)), "lens-policy.json");

/**
 * The policy's own validity predicate, exported so it has exactly one
 * implementation and one owner (§3.11): `loadPolicy` calls it, and a
 * test exercises it directly rather than re-deriving these rules over a
 * fixture. Every check is a property routing rests on — a policy that
 * routes nothing, a row that can never match, a prefix that matches
 * everything, or two rows sharing a lens each break a guarantee §1.7
 * states.
 */
export function validatePolicy(parsed: Policy): Policy {
	if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) {
		throw new Error("lens policy: no rows — a policy that routes nothing is not a routing surface (SPEC §1.7)");
	}
	const seen = new Set<string>();
	for (const row of parsed.rows) {
		if (typeof row.lens !== "string" || row.lens.length === 0) {
			throw new Error("lens policy: a row carries no lens name (SPEC §1.7)");
		}
		// Lens uniqueness is load-bearing, not tidiness: a slot's identity
		// is its lens+surface, and two rows sharing a lens produce two
		// slots a caller cannot tell apart when it pairs a dispatch to one.
		if (seen.has(row.lens)) {
			throw new Error(
				`lens policy: lens ${quoted(row.lens)} appears twice — a lens names one slot, and two rows ` +
					"sharing one make a slot no caller can pair a dispatch to (SPEC §1.7)",
			);
		}
		seen.add(row.lens);
		if (!Array.isArray(row.prefixes) || row.prefixes.length === 0) {
			throw new Error(`lens policy: row ${quoted(row.lens)} declares no prefix — it would never route (SPEC §1.7)`);
		}
		for (const prefix of row.prefixes) {
			if (typeof prefix !== "string" || prefix.length === 0) {
				throw new Error(
					`lens policy: row ${quoted(row.lens)} carries an empty prefix, which matches every ` +
						"string — a lens no change surface selects is a lens anything selects (SPEC §1.7)",
				);
			}
		}
	}
	return parsed;
}

/**
 * Read the committed policy surface — that file and no other, so that
 * "committed" is a constraint rather than a default (see the header's
 * fourth decision). This function takes no path for that reason.
 */
export function loadPolicy(): Policy {
	return validatePolicy(JSON.parse(readFileSync(POLICY_PATH, "utf8")) as Policy);
}

/**
 * The change's own changed-path set, read from the repository rather
 * than from anyone's summary of it — §1.7's third contract property,
 * which a caller-supplied array cannot satisfy however honestly it was
 * assembled. This is the authoritative read; `deriveRequiredSlots`
 * consumes what it returns.
 */
export function changedPathsFromRepo(baseRef: string, headRef: string, repoRoot: string): string[] {
	const out = execFileSync("git", ["diff", "--name-only", `${baseRef}...${headRef}`], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	return out.split("\n").filter((line) => line.length > 0);
}

/**
 * Does one changed path fall under one policy prefix? Matching is
 * path-segment aware: a bare `startsWith` lets `SPEC.md.bak` select the
 * lens for `SPEC.md`, which routes a change by a name it merely
 * resembles.
 */
function underPrefix(path: string, prefix: string): boolean {
	if (path === prefix) {
		return true;
	}
	return prefix.endsWith("/") ? path.startsWith(prefix) : path.startsWith(`${prefix}/`);
}

/**
 * Derive the required slot set. A pure function of its arguments, and
 * ordered by the POLICY rather than by the input, so two orderings of
 * one change surface cannot derive two different-looking sets. Each
 * lens appears at most once however many paths matched it.
 */
export function deriveRequiredSlots(changedPaths: string[], policy: Policy): Slot[] {
	const required: Slot[] = [];
	for (const row of policy.rows) {
		const matched = changedPaths.some((path) => row.prefixes.some((prefix) => underPrefix(path, prefix)));
		if (matched) {
			required.push({ lens: row.lens, surface: row.surface });
		}
	}
	return required;
}

/**
 * Record a result against the slot the caller DISPATCHED. The only
 * constructor of a SlotResult, and the reason nothing a delegate says
 * can decide which slot it answered or whether its compare confirmed.
 */
export function receive(slot: Slot, compare: "confirmed" | "invalid", returned: ReviewerReturn): SlotResult {
	return { slot: { lens: slot.lens, surface: slot.surface }, compare, returned };
}

/** Do two slots name the same slot? Identity is the pair, never the lens alone. */
function sameSlot(a: Slot, b: Slot): boolean {
	return a.lens === b.lens && a.surface === b.surface;
}

/**
 * Rule whether a result counts at all — §1.6's caller's fact. Never an
 * approve and never a reject: an invalid result is NO result. The
 * causes are §1.7's four, plus the grammar's own: a result whose token
 * contradicts its own findings is outside §1.6's two-token set, and
 * reading it as whichever half looks truthful would be the caller
 * deciding what a reviewer meant.
 */
export function decideValidity(result: SlotResult, slot: Slot): { valid: boolean; reason?: string } {
	if (!sameSlot(result.slot, slot)) {
		return { valid: false, reason: "reviewed a surface other than the one the slot required" };
	}
	if ("failure" in result.returned) {
		return { valid: false, reason: result.returned.failure === "timeout" ? "timed out" : "malformed return" };
	}
	if (result.compare !== "confirmed") {
		return { valid: false, reason: "blind compare not confirmed" };
	}
	const { token, findings } = result.returned;
	if (token !== "APPROVED" && token !== "FINDINGS") {
		return { valid: false, reason: "token outside the two-token grammar" };
	}
	if (token === "APPROVED" && findings.length > 0) {
		return { valid: false, reason: "APPROVED carrying findings contradicts its own token" };
	}
	if (token === "FINDINGS" && findings.length === 0) {
		return { valid: false, reason: "FINDINGS carrying none contradicts its own token" };
	}
	return { valid: true };
}

/** Every valid result recorded against one required slot, in argument order. */
function validResultsFor(results: readonly SlotResult[], slot: Slot): SlotResult[] {
	return results.filter((result) => sameSlot(result.slot, slot) && decideValidity(result, slot).valid);
}

/**
 * The bundle: the concatenation of the raw findings from every valid
 * result recorded against a required slot. It drops nothing, reads no
 * finding's text, and carries each finding's lens so the Judge can
 * merge duplicates without losing which slots reported them.
 */
export function buildBundle(results: readonly SlotResult[], required: readonly Slot[]): BundleEntry[] {
	const bundle: BundleEntry[] = [];
	for (const slot of required) {
		for (const result of validResultsFor(results, slot)) {
			if ("failure" in result.returned) {
				continue;
			}
			for (const finding of result.returned.findings) {
				bundle.push({ finding, lens: slot.lens });
			}
		}
	}
	return bundle;
}

/**
 * The panel's outcome. Completeness is every required slot carrying at
 * least one valid result; a slot answered twice is satisfied by either
 * answer, which is what makes re-dispatch work and the outcome
 * independent of the order results are supplied in.
 */
export function panelOutcome(results: readonly SlotResult[], required: readonly Slot[]): PanelOutcome {
	if (required.length === 0) {
		return { outcome: "unrouted" };
	}
	const missing = required.filter((slot) => validResultsFor(results, slot).length === 0).map((slot) => slot.lens);
	if (missing.length > 0) {
		return { outcome: "incomplete", missing };
	}
	const bundle = buildBundle(results, required);
	return bundle.length === 0 ? { outcome: "approved" } : { outcome: "bundle", bundle };
}

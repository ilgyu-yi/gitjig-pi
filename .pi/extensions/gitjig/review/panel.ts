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
 * DECISION — the empty required set follows the SSOT as written, and
 * the concern is filed rather than decided. Two rejected alternatives
 * are recorded at the branch itself so neither returns silently: a
 * minted `unrouted` token (a contract the SSOT does not carry) and a
 * thrown refusal (a behaviour it does not carry either). Issue #172
 * holds the open §1.7/§1.9 question.
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

/** §1.6's blind-compare outcome. */
export type Compare = "confirmed" | "invalid" | "absent";

declare const recorded: unique symbol;

/**
 * A result, as the CALLER records it. `slot` is what the caller
 * dispatched and `compare` is the caller's own blind-compare outcome
 * (§1.6); neither is anything the delegate said.
 *
 * What the brand holds, and what holds the brand — stated so neither is
 * over-read: without it a plain object literal of this shape is a
 * SlotResult, so "only `receive` builds one" would be a convention. The
 * brand makes it a property FOR TYPE-CHECKED CONSUMERS; at runtime the
 * symbol does not exist, so nothing dynamic is stopped by it, and the
 * suite pins the brand's presence in the source text rather than its
 * effect. `receive` is the only thing that can mint it.
 */
export type SlotResult = {
	readonly [recorded]: true;
	readonly slot: Slot;
	readonly compare: Compare;
	readonly returned: ReviewerReturn;
};
// The brand is TYPE-ONLY and never exists at runtime: this runtime strips
// types, so a branded key written into an object literal would be a
// reference to a binding that is not there. `receive` casts instead, and
// it is the only place in the module that may.

/**
 * One raw finding in the bundle, with the slot it came from. The whole
 * slot rides, not its lens alone: this module's own identity rule is the
 * lens+surface pair, and a bundle that carried half of it would hand the
 * Judge a provenance that cannot tell two slots apart.
 */
export type BundleEntry = { finding: string; slot: Slot };

export type PanelOutcome =
	| { outcome: "incomplete"; missing: Slot[] }
	| { outcome: "approved" }
	| { outcome: "bundle"; bundle: BundleEntry[] };

type PolicyRow = { lens: string; surface: string; prefixes: string[] };
declare const validated: unique symbol;

/** The policy's parsed shape, before its validity predicate has run. */
export type PolicyInput = { version: number; rows: PolicyRow[] };

/**
 * A policy the predicate has ruled on. Branded like the other two
 * routing inputs and for the same reason: an unbranded parameter accepts
 * anyone's routing table however honestly it was assembled, which is the
 * caller-summary defect §1.7's caller-owned property exists to close.
 * Only `validatePolicy` mints one.
 */
export type Policy = PolicyInput & { readonly [validated]: true };

const POLICY_PATH = join(dirname(fileURLToPath(import.meta.url)), "lens-policy.json");

/**
 * The policy's own validity predicate, exported so it has exactly one
 * implementation and one owner (§3.11): `loadPolicy` calls it, and a
 * test exercises it directly rather than re-deriving these rules over a
 * fixture.
 *
 * These rules are THIS MODULE'S, not §1.7's, and the refusals below say
 * so rather than citing a clause that does not carry them: §1.7 fixes
 * three properties of the surface — committed, caller-owned,
 * authoritative — and says in terms that the surface's CONTENT is not
 * its business. What each check defends is the local ground stated
 * beside it.
 */
export function validatePolicy(parsed: PolicyInput): Policy {
	// The parameter is typed, but every value that reaches it came from
	// JSON.parse of a file, so the type is not a guarantee. Without this
	// the null case throws a TypeError no one in this repository authored,
	// in place of the citing refusals below.
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("lens policy: the committed surface did not parse to an object");
	}
	if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) {
		throw new Error(
			"lens policy: no rows — a policy that routes nothing derives an empty required set for every change, and this module refuses to convene a panel from one",
		);
	}
	const seen = new Set<string>();
	for (const row of parsed.rows) {
		if (typeof row.lens !== "string" || row.lens.length === 0) {
			throw new Error("lens policy: a row carries no lens name, and a lens is half a slot's identity");
		}
		// Lens uniqueness is load-bearing, not tidiness: a slot's identity
		// is its lens+surface, and two rows sharing a lens produce two
		// slots a caller cannot tell apart when it pairs a dispatch to one.
		if (seen.has(row.lens)) {
			throw new Error(
				`lens policy: lens ${quoted(row.lens)} appears twice — a lens names one slot, and two rows ` +
					"sharing one make a slot no caller can pair a dispatch to",
			);
		}
		seen.add(row.lens);
		// The surface is half of a slot's identity, so it is validated like
		// the other half: an absent surface makes two rows' slots compare
		// equal on a field that is undefined in both, which is the same
		// unpairable slot the uniqueness check above exists to prevent.
		if (typeof row.surface !== "string" || row.surface.length === 0) {
			throw new Error(
				`lens policy: row ${quoted(row.lens)} declares no surface, and a slot's identity is the lens and ` +
					"the surface together",
			);
		}
		if (!Array.isArray(row.prefixes) || row.prefixes.length === 0) {
			throw new Error(`lens policy: row ${quoted(row.lens)} declares no prefix — it would never route`);
		}
		for (const prefix of row.prefixes) {
			if (typeof prefix !== "string" || prefix.length === 0) {
				throw new Error(
					`lens policy: row ${quoted(row.lens)} carries an empty prefix, which matches every ` +
						"string — the caller-owned routing cannot rest on a row anything selects",
				);
			}
		}
	}
	return parsed as Policy;
}

/**
 * Read the committed policy surface — that file and no other, so that
 * "committed" is a constraint rather than a default (see the header's
 * fourth decision). This function takes no path for that reason.
 */
export function loadPolicy(): Policy {
	// Committedness is a CONSTRAINT here, not a description: reading the
	// worktree bytes alone would let an uncommitted local edit change the
	// derived slot set with nothing observing it, and §1.7 makes the
	// routing decision auditable-after-the-fact because the surface is a
	// committed artifact. A dirty surface refuses — the evidence-gate
	// direction — rather than routing from bytes no reviewer can diff.
	const dirty = execFileSync("git", ["status", "--porcelain", "--", POLICY_PATH], {
		cwd: dirname(POLICY_PATH),
		encoding: "utf8",
	});
	if (dirty.trim().length > 0) {
		throw new Error(
			"lens policy: the committed surface has uncommitted local edits — routing must derive from bytes a " +
				"reviewer can diff, so a dirty policy refuses rather than routes (SPEC §1.7's committed property)",
		);
	}
	return validatePolicy(JSON.parse(readFileSync(POLICY_PATH, "utf8")) as PolicyInput);
}

declare const authoritative: unique symbol;

/**
 * A changed-path set read from the change itself. Branded for the same
 * reason a result is: §1.7's third property is not satisfied by a caller
 * promising its array came from a repository, and an unbranded
 * `string[]` parameter accepts anyone's summary however honestly it was
 * assembled. Only `changedPathsFromRepo` mints one.
 */
export type ChangedPaths = readonly string[] & { readonly [authoritative]: true };

/**
 * The authoritative read. `-z` is not a detail: without it git renders
 * any path carrying a non-ASCII or special byte in C-quoted form with
 * surrounding double quotes, and a quoted name matches no policy prefix
 * — so a change touching only such files would route to no lens at all
 * and its review would silently never run. `-z` emits the true bytes and
 * NUL-separates them, which also removes the newline ambiguity a
 * line-split read has.
 */
export function changedPathsFromRepo(baseRef: string, headRef: string, repoRoot: string): ChangedPaths {
	// `--end-of-options` is the guard, not a flourish: without it a ref
	// beginning with `-` is consumed as a git OPTION — measured: an
	// `--output=`-shaped operand wrote a file and the read returned empty,
	// so the change would route to no reviewer, silently. With the guard a
	// dash-leading operand is a revision, which does not resolve, which
	// throws — the refusal direction, never the silent-empty one.
	const out = execFileSync("git", ["diff", "--name-only", "-z", "--end-of-options", `${baseRef}...${headRef}`], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	return out.split("\0").filter((entry) => entry.length > 0) as unknown as ChangedPaths;
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
export function deriveRequiredSlots(changedPaths: ChangedPaths, policy: Policy): Slot[] {
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
export function receive(slot: Slot, compare: Compare, returned: ReviewerReturn): SlotResult {
	// Both operands are COPIED, not aliased. `readonly` is shallow, so an
	// aliased `returned` lets whoever still holds the parsed object rewrite
	// what the panel reports — and, by emptying `findings`, flip the
	// result's own validity — after the caller recorded it.
	const copied: ReviewerReturn =
		"failure" in returned ? { failure: returned.failure } : { token: returned.token, findings: [...returned.findings] };
	return { slot: { lens: slot.lens, surface: slot.surface }, compare, returned: copied } as unknown as SlotResult;
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
 * Builds the bundle §1.7 defines. Read that clause for what it must and
 * must not do; what this comment adds is the one local consequence: each
 * entry carries its whole slot, because the Judge's dedup (§1.9) needs
 * to know which slot reported a finding and this module's identity rule
 * is the pair.
 */
export function buildBundle(results: readonly SlotResult[], required: readonly Slot[]): BundleEntry[] {
	const bundle: BundleEntry[] = [];
	for (const slot of required) {
		for (const result of validResultsFor(results, slot)) {
			if ("failure" in result.returned) {
				continue;
			}
			for (const finding of result.returned.findings) {
				// A COPY, never the caller's `required[i]` object: `readonly`
				// is shallow, and an aliased entry lets a later mutation of
				// the caller's array rewrite the provenance of findings
				// already in the bundle — after construction, which is when
				// the Judge reads it.
				bundle.push({ finding, slot: { lens: slot.lens, surface: slot.surface } });
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
	// The empty required set takes the SSOT's own derived answer, stated
	// here because two review rounds pulled it in opposite directions:
	// §1.7's completeness test is vacuously true over an empty set and
	// §1.9's findings-free path then reads the empty bundle as Review
	// APPROVED — an approval for a head no reviewer examined, which is a
	// real concern, and it is FILED (issue #172) rather than answered in
	// this module. A minted fourth token and a thrown refusal were both
	// tried and both rejected as behaviours the SSOT does not carry;
	// conforming while the question is open is §1.9's own defer shape —
	// the concern is durable and caller-held, and the code follows the
	// contract as written until the operator settles it.
	const missing = required
		.filter((slot) => validResultsFor(results, slot).length === 0)
		.map((slot) => ({ lens: slot.lens, surface: slot.surface }));
	if (missing.length > 0) {
		return { outcome: "incomplete", missing };
	}
	const bundle = buildBundle(results, required);
	return bundle.length === 0 ? { outcome: "approved" } : { outcome: "bundle", bundle };
}

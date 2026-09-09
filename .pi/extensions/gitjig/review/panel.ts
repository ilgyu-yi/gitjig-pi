/**
 * The reviewer panel orchestrator (issue #169, Directive #166) — the
 * caller side of SPEC §1.7, sitting above §4.9's dispatcher.
 *
 * This module derives the required slot set, decides each returned
 * result's validity, concatenates findings into the bundle, and decides
 * panel completeness. It enforces §1.7 and §1.6; read those sections for
 * what the panel owes, and expect the comments here to point at a clause
 * rather than restate it (§2.8). What lives here is the local decisions
 * and the alternatives weighed — where a comment does name a rule, it is
 * to say which branch applies it, not to carry a second copy of it.
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
 * nowhere else. `loadPolicy` takes no path, so routing cannot derive
 * from an untracked file outside the repository; a caller exercising
 * derivation against a synthetic table calls `deriveRequiredSlots`
 * directly, which is derivation under test, not the policy surface.
 *
 * What "committed" is NOT: it is not a runtime cleanliness check.
 * A round-3 repair had `loadPolicy` shell `git status` to refuse a
 * worktree-modified policy; that one mechanism drew a §4.6 ambient-env
 * exposure onto the routing path, an undeclared §3.9 git dependency,
 * and `git status` proxies with measured false-clean bypasses — a patch
 * cascade whose root was the premise. §1.7's committed property is that
 * the policy is a reviewed repository artifact, diffable and auditable
 * like any other; that is enforced by the file being tracked and going
 * through review and the merge gate, exactly as this module's own source
 * is, not by the module re-policing its own bytes at every call. An
 * operator's uncommitted local edit to it is outside the threat model
 * the same way an edit to any gate's own source is (§5.5, §4.6).
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

/**
 * The parent environment with git's repo-locating and config-injection
 * families removed, so a shelled read answers about the repository `cwd`
 * names and not one an ambient variable points at (§4.6, §4.7). The same
 * families §4.9's executor strips; the panel does not import that helper
 * because the dispatcher's dependency boundary is severed from it, so the
 * one list lives here for the panel's own git calls.
 */
function withoutRepoLocatingGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const scrubbed = { ...env };
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_COMMON_DIR",
		"GIT_CONFIG_PARAMETERS",
		"GIT_CONFIG_COUNT",
	]) {
		delete scrubbed[key];
	}
	return scrubbed;
}

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
// reference to a binding that is not there. `receive` casts instead.

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
		// Lens uniqueness is not an identity requirement — `sameSlot` reads
		// the lens+surface pair, so two rows sharing a lens but differing in
		// surface are distinguishable. It is a readability-and-routing rule:
		// one row per lens keeps the committed table diffable by lens and
		// keeps deriveRequiredSlots' "each lens appears at most once" true,
		// so a required set is a set of lenses rather than a multiset.
		if (seen.has(row.lens)) {
			throw new Error(
				`lens policy: lens ${quoted(row.lens)} appears twice — one row per lens keeps the committed table ` +
					"diffable by lens and the required set free of duplicates",
			);
		}
		seen.add(row.lens);
		// The surface is half of a slot's identity, so it is validated like
		// the other half: an absent surface leaves a derived slot with an
		// undefined surface, and `sameSlot` then cannot distinguish it from
		// any other surfaceless slot on the same lens — a slot no dispatch
		// can be paired to.
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
					`lens policy: row ${quoted(row.lens)} carries an empty prefix, which under this module's ` +
						"segment-aware matching selects nothing a change surface emits — the caller-owned routing " +
						"cannot rest on a row that never routes",
				);
			}
		}
	}
	// A fresh, fully-detached policy — never the caller's own object. The
	// brand certifies the rows the predicate ruled on, so a post-validation
	// push to the caller's array must not reach the branded value; this is
	// the aliasing class receive and buildBundle were cured of, at the
	// boundary where the routing table itself ships.
	return {
		version: parsed.version,
		rows: parsed.rows.map((row) => ({ lens: row.lens, surface: row.surface, prefixes: [...row.prefixes] })),
	} as Policy;
}

/**
 * Read the committed policy surface — that file and no other, so that
 * "committed" is a constraint rather than a default (see the header's
 * fourth decision). This function takes no path for that reason.
 */
export function loadPolicy(): Policy {
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
	// so the change would route to no reviewer, silently. With the guard git
	// refuses the operand while parsing options — measured: `fatal: option
	// '--output=...' must come before non-option arguments` — the refusal
	// direction, never the silent-empty one.
	//
	// The repo-locating GIT_* families are stripped from the child's
	// environment, the same scrub §4.9's executor applies: without it an
	// ambient GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE would redirect this
	// read at a repository other than the one under review, while `cwd`
	// still points here — an ambient value on the routing path (§4.6).
	const out = execFileSync("git", ["diff", "--name-only", "-z", "--end-of-options", `${baseRef}...${headRef}`], {
		cwd: repoRoot,
		encoding: "utf8",
		env: withoutRepoLocatingGitEnv(process.env),
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
 * The panel's outcome, on §1.7's completeness contract. The local facts,
 * not restated from the section: a slot answered twice is satisfied by
 * either valid answer, which is what makes re-dispatch work and the
 * outcome independent of the order results are supplied in.
 */
export function panelOutcome(results: readonly SlotResult[], required: readonly Slot[]): PanelOutcome {
	// The empty required set follows the SSOT as written (§1.7, §1.9), and
	// the concern with doing so is FILED, not decided here. Read those
	// sections for the outcome; the local facts are why this is not the
	// module's call. §1.7 names the gap as its own open residual — it
	// "sets no floor on the required slot set" and says closing it "is an
	// amendment to §5.6's substitution reach and is not made here" — and
	// §0.3 forbids code leading that amendment (drift is surfaced, never
	// auto-corrected; an SSOT correction is attended-only). So the concern
	// that this can approve a head no reviewer examined is on issue #172
	// for the operator, and the code follows the contract meanwhile. A
	// minted fourth token and a thrown refusal were both tried in earlier
	// rounds and both ruled behaviours the SSOT does not carry.
	const missing = required
		.filter((slot) => validResultsFor(results, slot).length === 0)
		.map((slot) => ({ lens: slot.lens, surface: slot.surface }));
	if (missing.length > 0) {
		return { outcome: "incomplete", missing };
	}
	const bundle = buildBundle(results, required);
	return bundle.length === 0 ? { outcome: "approved" } : { outcome: "bundle", bundle };
}

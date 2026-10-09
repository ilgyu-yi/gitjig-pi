/**
 * Issue #402 — the settled record and re-entry terms of §1.4's
 * review-history handoff (SPEC §1.4, §2.2). Contract-only: the two
 * paragraphs are pinned by fixture and by literal, so a coordinated
 * SPEC-and-fixture edit still fails.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const SPEC = readFileSync(new URL("../SPEC.md", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const FIXTURE = readFileSync(new URL("./fixtures/review-history-reentry.contract.txt", import.meta.url), "utf8")
	.replaceAll("\r\n", "\n")
	.trim();

/**
 * Both settled paragraphs, byte for byte. Pinned here as well as by the
 * fixture, so any coordinated SPEC-and-fixture edit of any clause fails.
 */
const PARAGRAPHS = [
	"**Handoff record and re-entry for this gate (§2.2).** Every stop of `/review-round` on a history handoff falls in exactly one of three limbs. **(a) Legacy-underivable projection:** some state in the trailing run is an unversioned review record on which one of exactly these record-local checks, and no others, refuses from that record's own bytes — the adjudication is null; dedup is not attested; the raw bundle is empty; there are more effective rulings than raw findings; ruling or disposition findings repeat, or their counts differ; a ruling has empty provenance or empty evidence, or a CONFIRMED ruling lacks severity, direction or AC impact, or is a NIT without a remedy; the rulings' provenance slots are not exactly the multiset of the raw bundle's slots; or the disposition at a ruling's index names a different finding. It also covers a trailing repair run in which some adjacent pair of reviewed heads has a later head whose ancestry walk completes — every reachable commit read within the reader's bounds — without meeting the earlier head, whose own object need not be present. A walk ending on a missing object, a malformed commit, a read failure, a timeout or a commit or byte cap has not decided ancestry for its pair: the stop is limb (a) when the record-local check refuses or any pair in the run is decided non-ancestral, whatever the other pairs' walks do, and limb (c) when neither holds and some walk did not complete. It is decided either from a record's own bytes, without any platform or git read, or from immutable commit objects by a walk that completes, so it is persistent either way; a projection unavailable for any other reason is not limb (a). **(b) Disposed diagnosis:** a valid admitted diagnosis's consequence hands the change off, in any decision mode and with any invalidation, including the autonomous route's `handoff` terminal. **(c) Unmeasured:** every other history handoff — an unreadable history record, an environmental projection failure, or a Judge not dispatched, unavailable, invalid or incomplete. Before stopping, the command writes one handoff record through the #276 transition service at the exact PR subject and base heads, with `cause` `review-history-legacy-underivable`, `review-history-diagnosis-handoff` or `review-history-unmeasured` respectively, `recipient` `maintainer`, and `reentry` equal, for limb (b), to the invalidation (`nothing`, `plan` or `authorization`) of the most recent valid admitted history diagnosis in that round — the autonomous route's fresh ruling when one was admitted, otherwise the initial diagnosis — and `none` for limbs (a) and (c). While any unterminated handoff record of any cause or owner stands on the PR, a later stop writes no second record and hands off citing the standing one, which keeps the engine's population to at most one current record; a standing record of another owner blocks this route until that owner re-enters it on its own terms. A repeated identical observation is idempotent, and a failed write keeps the handoff and names the failure.",
	"A limb-(c) record stands until the owning gate reaches a determinate outcome: a later `/review-round` may run its projection and diagnosis while it stands, and on a limb-(a) refusal of the projection or a valid admitted diagnosis the round itself first writes the `handoff-reentry` terminal for that record, with the record's heads and the engine's rules, then writes the limb-(a) record, the limb-(b) record when the diagnosis hands off, or nothing more when it continues. That terminal replaces a failed attempt with a later determinate outcome; it is not a disposition and never resets the trailing run. Where the round's account cannot pass `authorizedResolver`, the record stays standing and the round hands off — a stated residual. A limb-(a) or limb-(b) gate is re-entered only by a `handoff-reentry` terminal that references the standing admitted record of one of those two causes, carries that record's exact subject and base heads, follows it, and whose carrying comment's author passes `authorizedResolver` for the repository (a User with `WRITE`, `MAINTAIN` or `ADMIN`), attested exactly as `inspectHandoffPopulation` attests carriers; until then the command hands off citing the standing record without a new diagnosis. A Bot or an account without that permission cannot re-enter. The authority is a platform permission and an ordering, not an account-separation claim: where the PR's author and the maintainer operate one account — the capability-and-ordering same-account operation this SPEC already accepts — the platform cannot tell the maintainer's disposition from an author's act, and the terminal claims no more than a permitted account's disposition. Whether a limb-(a) terminal is honored is read statelessly by every reader, over the trailing repair run the standing record was written for — the review states after both the latest non-`repair` reset and the latest earlier honored limb-(a) or limb-(b) terminal, up to this terminal — and over every adjacent pair of reviewed heads in that run: it is honored when the record-local check refuses or some pair's ancestry walk completes without meeting its earlier head; it is dishonored when the record-local check does not refuse and every pair's walk completes and meets its earlier head; otherwise its honor is undetermined and the reader fails closed to the existing hand-off citing the standing record, so an incomplete or missing walk never honors a terminal. Where an earlier limb-(a) terminal whose honor is undetermined for a reader falls after both the latest non-`repair` reset and the latest earlier terminal honored for that reader, that reader cannot bound the window, and the later terminal's honor is undetermined for it too; a terminal whose honor is undetermined for a reader neither bounds a window nor starts a new trailing run for it. A second residual is stated with its bound: a non-ancestral pair is something an author can produce — a sanctioned rebase or force-push between repair reviews — and its limb-(a) stop runs no history diagnosis, so the stagnation and oscillation reading that limb (b) would give is not given for the states before the rewrite; under the same-account operation this SPEC accepts, the account that rewrote can be the account that writes the honored terminal. The bound is that nothing is silent: the handoff record, the terminal and every pre-rewrite review state stay in the complete repair history, the terminal names the record it disposes, the next current-head panel still runs in full, and a later run that again reaches the trigger is diagnosed as usual. A reader that lacks the later head of a non-ancestral pair — a reviewed head that a further rewrite left unreachable — and has no other positive proof, no refusing record-local check and no other pair decided non-ancestral, cannot complete that pair's walk, and stays handed off until it has that head: a stated residual. An author who rewrites a branch with published review states keeps each reviewed head reachable on the remote through a pushed backup ref, so that any clone can fetch it. A non-ancestral pair is not a non-`repair` state and never starts a new trailing run by itself; a non-`repair` state or an honored terminal does. This non-ancestral classification and its honor read activate only with their implementing derivation, never from a contract-only PR alone (§5.3); until then the installed gate files such a stop under limb (c). For the trigger and the repair-basis projection only, an honored limb-(a) or limb-(b) terminal starts a new trailing run: review states recorded before the terminal's comment do not join a run after it, as a non-`repair` state resets the run; the complete repair history keeps every record, and nothing is edited, deleted or reclassified. Re-entry claims no recovery allowance and never resets a consumed one; it never satisfies a plan or authorization invalidation, which re-enters its own gate on that gate's terms (§1.2, §2.2); it grants no review verdict, ready state, merge or AC closeout, and the next current-head panel still runs in full. A limb-(a) handoff recorded only in prose before this rule is re-entered the same way once an authorized resolver writes the limb-(a) record at the PR's current heads, honored only on the same positive proof on the PR's own history at re-entry time; a prose handoff of any other kind is recomputed by the next round, which writes its own record. Every refusal — an unreadable or ambiguous handoff population, an unattested carrier, a terminal whose heads differ from its record's, a terminal without an admitted record, a limb-(a) terminal that is dishonored or whose honor is undetermined, or a limb-(c) record offered for disposition — fails closed to the existing hand-off.",
].join("\n\n");

/** Clauses pinned by literal: each is load-bearing for one AC3 mutant. */
const LITERALS = [
	"a projection unavailable for any other reason is not limb (a)",
	"on which one of exactly these record-local checks, and no others, refuses from that record's own bytes",
	"It is decided either from a record's own bytes, without any platform or git read, or from immutable commit objects by a walk that completes",
	"the stop is limb (a) when the record-local check refuses or any pair in the run is decided non-ancestral, whatever the other pairs' walks do",
	"so an incomplete or missing walk never honors a terminal",
	"and the later terminal's honor is undetermined for it too",
	"falls after both the latest non-`repair` reset and the latest earlier terminal honored for that reader",
	"its limb-(a) stop runs no history diagnosis",
	"the account that rewrote can be the account that writes the honored terminal",
	"A non-ancestral pair is not a non-`repair` state and never starts a new trailing run by itself",
	"keeps each reviewed head reachable on the remote through a pushed backup ref",
	"a later stop writes no second record and hands off citing the standing one",
	"it is not a disposition and never resets the trailing run",
	"references the standing admitted record of one of those two causes",
	"whose carrying comment's author passes `authorizedResolver` for the repository (a User with `WRITE`, `MAINTAIN` or `ADMIN`), attested exactly as `inspectHandoffPopulation` attests carriers",
	"the complete repair history keeps every record, and nothing is edited, deleted or reclassified",
	"Re-entry claims no recovery allowance and never resets a consumed one",
	"it never satisfies a plan or authorization invalidation, which re-enters its own gate on that gate's terms",
	"`cause` `review-history-legacy-underivable`, `review-history-diagnosis-handoff` or `review-history-unmeasured` respectively",
] as const;
const CROSS_REFERENCE =
	"Re-entry consumes the interruption on the owning gate's terms while the record remains durable history; §1.4 states those terms, and the record values, for its review-history gate.";

function section(source: string, start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	return from >= 0 && to > from ? source.slice(from, to) : "";
}

function contractHoldsWith(source: string, fixture: string): boolean {
	const repair = section(source, "### 1.4 Cross-review repair", "### 1.5 Delegated work");
	const opening = "**Handoff record and re-entry for this gate (§2.2).**";
	const start = repair.indexOf(opening);
	if (start < 0 || source.indexOf(opening) !== source.lastIndexOf(opening)) return false;
	const second = repair.indexOf("\n\n", start);
	const end = repair.indexOf("\n\n", second + 2);
	const paragraphs = repair.slice(start, end < 0 ? undefined : end).trim();
	return (
		paragraphs === fixture &&
		paragraphs === PARAGRAPHS &&
		LITERALS.every((literal) => paragraphs.split(literal).length === 2) &&
		section(source, "### 2.2 Lifecycle states", "### 2.3").includes(CROSS_REFERENCE)
	);
}

describe("#402 review-history handoff record and re-entry contract", () => {
	it("pins both paragraphs by fixture and literal, and the §2.2 cross-reference", () => {
		assert.equal(contractHoldsWith(SPEC, FIXTURE), true);
	});

	it("kills every baseline-first contract mutant, alone and as a coordinated SPEC-and-fixture edit", () => {
		const mutants: ReadonlyArray<readonly [string, string, string]> = [
			[
				"a mixed run sent to limb (c)",
				"the stop is limb (a) when the record-local check refuses or any pair in the run is decided non-ancestral, whatever the other pairs' walks do",
				"the stop is limb (c) when any pair's walk did not complete",
			],
			[
				"legacy prose re-entry kept on the record-local check alone",
				"honored only on the same positive proof on the PR's own history",
				"honored only if the record-local check refuses on the PR's own history",
			],
			[
				"the honor window reaching past a non-repair reset",
				"the review states after both the latest non-`repair` reset and the latest earlier honored",
				"the review states after the latest earlier honored",
			],
			[
				"the residual blocking a reader that has other proof",
				"and has no other positive proof, no refusing record-local check and no other pair decided non-ancestral, ",
				"",
			],
			[
				"the classification active from the contract alone",
				"This non-ancestral classification and its honor read activate only with their implementing derivation",
				"This non-ancestral classification and its honor read activate at once",
			],
			[
				"an undetermined earlier terminal skipped when bounding the window",
				"and the later terminal's honor is undetermined for it too",
				"and the window extends past it",
			],
			[
				"the skipped diagnosis left unstated",
				"its limb-(a) stop runs no history diagnosis, so the stagnation and oscillation reading that limb (b) would give is not given for the states before the rewrite",
				"its limb-(a) stop is diagnosed as usual",
			],
			[
				"the same-account path left unstated",
				"the account that rewrote can be the account that writes the honored terminal",
				"only a separate maintainer account writes the honored terminal",
			],
			[
				"an undetermined terminal before a later reset still blocking",
				"falls after both the latest non-`repair` reset and the latest earlier terminal honored for that reader",
				"falls anywhere before it",
			],
			// #435: the non-ancestral shape of limb (a), its (c) residue and the
			// stateless positive-proof honor rule.
			[
				"the decision clause narrowed back to record bytes",
				", or from immutable commit objects by a walk that completes",
				"",
			],
			[
				"an incomplete walk deciding ancestry",
				"a read failure, a timeout or a commit or byte cap has not decided ancestry",
				"a read failure has not decided ancestry",
			],
			[
				"the non-ancestral shape decided by an attempted walk",
				"whose ancestry walk completes —",
				"whose ancestry walk is attempted —",
			],
			[
				"an incomplete walk honoring a terminal",
				"otherwise its honor is undetermined and the reader fails closed to the existing hand-off citing the standing record, so an incomplete or missing walk never honors a terminal",
				"otherwise the terminal is honored and the reader continues",
			],
			[
				"a dishonor that ignores the walks",
				"it is dishonored when the record-local check does not refuse and every pair's walk completes and meets its earlier head",
				"it is dishonored when the record-local check does not refuse",
			],
			[
				"a rewrite that resets the run by itself",
				"A non-ancestral pair is not a non-`repair` state and never starts a new trailing run by itself",
				"A non-ancestral pair is a non-`repair` state and starts a new trailing run by itself",
			],
			[
				"the backup-ref mitigation dropped",
				"keeps each reviewed head reachable on the remote through a pushed backup ref",
				"may keep pre-rewrite heads",
			],
			[
				"re-entry without an authorized carrier",
				", and whose carrying comment's author passes `authorizedResolver` for the repository (a User with `WRITE`, `MAINTAIN` or `ADMIN`), attested exactly as `inspectHandoffPopulation` attests carriers",
				"",
			],
			[
				"a disposition terminal honored for a limb-(c) record",
				"references the standing admitted record of one of those two causes",
				"references the standing admitted record of any cause",
			],
			[
				"a limb-(c) terminal that resets the run",
				"it is not a disposition and never resets the trailing run",
				"it is not a disposition and resets the trailing run",
			],
			[
				"an environmental projection failure accepted as limb (a)",
				"a projection unavailable for any other reason is not limb (a)",
				"a projection unavailable for any other reason is also limb (a)",
			],
			[
				"a second standing record beside another owner's",
				"a later stop writes no second record and hands off citing the standing one",
				"a later stop writes its own record and hands off",
			],
			[
				"a reset that edits or drops history",
				"the complete repair history keeps every record, and nothing is edited, deleted or reclassified",
				"earlier records leave the repair history",
			],
			[
				"re-entry that resets a consumed allowance",
				"Re-entry claims no recovery allowance and never resets a consumed one",
				"Re-entry claims no recovery allowance and resets a consumed one",
			],
			[
				"re-entry that satisfies a plan or authorization gate",
				"it never satisfies a plan or authorization invalidation, which re-enters its own gate on that gate's terms",
				"it satisfies any plan or authorization invalidation",
			],
			[
				"limb (a) made non-exclusive",
				"one of exactly these record-local checks, and no others, refuses",
				"one of these record-local checks refuses",
			],
			[
				"limb (a) allowed a platform or git read",
				"from a record's own bytes, without any platform or git read",
				"from a record's own bytes and any platform or git read",
			],
			["a record-local check deleted", "; dedup is not attested", ""],
			["cause literals changed", "`review-history-unmeasured` respectively", "`review-history-transient` respectively"],
			[
				"§2.2 cross-reference dropped",
				"; §1.4 states those terms, and the record values, for its review-history gate.",
				".",
			],
		];
		for (const [name, from, to] of mutants) {
			assert.equal(SPEC.split(from).length, 2, `${name}: mutation operand must be unique`);
			assert.equal(
				contractHoldsWith(
					SPEC.replace(from, () => to),
					FIXTURE,
				),
				false,
				`${name} survived`,
			);
			if (FIXTURE.includes(from) || PARAGRAPHS.includes(from))
				assert.equal(
					contractHoldsWith(
						SPEC.replace(from, () => to),
						FIXTURE.replace(from, () => to),
					),
					false,
					`${name} survived a coordinated SPEC-and-fixture edit`,
				);
		}
	});
});

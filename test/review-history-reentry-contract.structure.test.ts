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

/** Clauses pinned by literal: each is load-bearing for one AC3 mutant. */
const LITERALS = [
	"a projection unavailable for any other reason is not limb (a)",
	"on which one of exactly these record-local checks, and no others, refuses from that record's own bytes",
	"It is decided without any platform or git read",
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
				"It is decided without any platform or git read",
				"It may use a platform or git read",
			],
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
			if (FIXTURE.includes(from))
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

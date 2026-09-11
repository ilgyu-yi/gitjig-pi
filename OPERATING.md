# OPERATING — working doctrine for this repository

This document is the durable home of the operating knowledge a session needs to work in this
repository through its own review-and-dispatch machinery. It is **non-normative**: contracts live
in `SPEC.md`, and where this file and the SPEC disagree, the SPEC governs. Nothing here binds a
gate or an actor; everything here is practice that was paid for, kept so it is not re-derived.

**Why this file, and why here.** The session card (`.gitjig/overnight.md`) is gitignored by
design — it carries session-local state. Its stable half used to live there too, which left the
durable operating knowledge in a file the repository cannot see, with exactly one copy. That
stable half now lives here, committed and reviewable; the card carries only what genuinely
expires with a session (current heads, what is parked, measurements pinned to a moment, standing
items awaiting a human) and points here for everything else. On any conflict, the repository and
this file supersede the card. `docs/` is not this file's home because the ssot-home gate holds
`docs/*.md` to thin SPEC pointers; the repository root, beside the other standing documents, is.

## What the loop is for, and how to rank the queue

This repository is built by dogfooding itself: the SPEC and the shell are developed *through*
the review-and-dispatch machinery they define, and the failures that surface in that loop are
the issue population. An issue's worth is how much it degrades the loop, not how incomplete the
artifact is without it.

The operator's ranking — sort the queue by it, and judge new filings by it:

1. **Remove what blocks or degrades development itself.** The signal is failure to converge —
   usually a round count that climbs and will not come down. SPEC §1.4 owns the diagnosis and
   §1.9 owns oscillation; read both before using a round count as evidence for anything.
2. **Make developing other projects with this shell easy** — the adopter path.
3. **Completeness** of the artifact.

**Preferred repair, in order: delete, then simplify.** Complexity is available only against a
stated trade-off — an addition owes a written reason why deletion and simplification were both
unavailable (§2.5 binds this; the operator states it as a standing preference on top).

**When the best structure keeps demanding new mechanisms, re-examine the premise.** A patch
cascade is a priority-1 signal about the premise, not a backlog of patches.

**A prose-accuracy finding on a record surface can never obligate you into minting prose.**
Measurement precedes generation; the render is machine-emitted, never typed. If you cannot
produce the render or the pointer, delete the claim rather than authoring a replacement for it.

## The claim discipline (author-side)

The single highest-frequency failure in this repository's history is an author recording a claim
that measurement contradicts. Each rule below carries the measured incident that produced it,
because a rule without its incident is the kind of prose that gets skimmed. The incidents are
stated as standing facts; the review records that hold their full narration are not needed to
apply the rules.

1. **Every claim about a command is backed by a captured exit status, never by reading output —
   and the command run is the command CI runs.** Measured: `biome check .` exits 0 on a tree
   where `biome ci --error-on-warnings .` exits 1. Incident: a commit message recorded "biome
   clean" while the required `source-style` check was red — blank output was read as success and
   the exit code was never taken.
2. **Every claimed textual remedy is re-read from the artifact after the edit.** Issuing an edit
   is not evidence the edit exists. Incident: a repair was recorded as landed while a grep over
   both target files returned zero hits.
3. **Every scripted edit asserts its anchor matched.** A string replacement that matches nothing
   is a silent no-op. Incident: exactly that no-op produced a false commit-message claim; once
   the assertion was in place, it caught a wrong anchor guess instead of silently proceeding.
4. **Findings cross into a brief verbatim, never as labels or summaries** (§1.9's own ground).
   Incident: two findings passed to a Judge as labels were both ruled INDETERMINATE for want of
   content — a ruling cannot be made on a summary of a summary.
5. **A universal claim needs its falsifying command run first, and the wording may not exceed
   what the command read.** Incident: "reports nothing" was recorded where the command reported
   one hit; separately, a domain was recorded as cleared by measurement where two of its three
   treatments and one cardinality point had been measured — and clearances were reported anyway.
6. **An exculpatory claim carries a finding's burden — an enumeration establishes an
   enumeration, never a class closure.** Incident: a panel's claim that a defect class was
   closed rested on nine killed variants; a tenth surviving shape existed, and the unearned
   closure became a load-bearing input to a wrong convergence ruling.

The unifying shape, as one adjudication put it: *asserting a change landed instead of measuring
that it landed* and *titling a check over a domain instead of measuring the domain* are one act.

## The evidence ledger

- A population's boundary is part of the claim; deletion as repair needs its own verification;
  the announcement is load-bearing when the posture is fail-open; evidence is measured at the
  head it ships on; a guard the suite never measures is decoration; a caveat is a claim.
- **A mechanized population is only as good as its domain and its corpus, and both can exclude
  the answer by construction.** An enumeration is admissible only when its domain and corpus are
  shown to contain a known answer.
- **A replacement that asserts less than the text it replaced is the characteristic failure of a
  subtractive round** — not the dangling reference you watch for.
- **The record and the artifact drift apart.** Quote the landed sentence for every claim a
  commit message makes about the text; what you cannot quote is what you must measure.
- **A wandering name means no item owns the referent.** Give the referent an owner rather than
  another name.
- **Reuse the identifier the clause already mints** rather than inventing a predicate about
  sameness: "the same unrepaired finding" was undecidable; "the finding's filed issue is still
  open" is decidable from one artifact.
- **A pin narrower than the normative content of the line it pins is not a pin.** A substring
  check that omits a clause's polarity or qualifiers stays green while the instruction inverts;
  and substring pinning as a class is defeated by appended negating qualifiers, so a guard over
  normative prose wants whole-string equality where it wants anything.
- **§1.2's Doc→Test→Code re-maps for a pure-document deliverable** — Test is the pre-existing
  gates exercised failing-first. "No test owed, because the clause is advisory" answers a
  question §1.2 does not ask.
- **Do not reach for §3.11 to license not doing the work.** It forbids a second implementation
  of the predicate; building an input fixture is not that.
- **§1.9's durable-before-the-fix ordering breaks exactly when you are moving fastest.** Record
  the lapse rather than backdating.

## Review practice (the panel, the Judge, the diagnosis)

- Required slots derive from `.pi/extensions/gitjig/review/lens-policy.json` against the
  change's changed-path set; the deriver is `deriveRequiredSlots` in
  `.pi/extensions/gitjig/review/panel.ts`.
- **Put the §1.4 convergence question to the Judge, never self-check it**, and supply the
  criterion manifest with every Judge dispatch — a supplied manifest is a manifest, and absent
  is not empty (§1.9).
- Demand the defer conjunction in full: §1.9's `defer` opens "confirmed SUBSTANTIVE" —
  SUBSTANTIVE is the first conjunct, a NIT takes `remedy`, and a substantive finding with no
  home is non-deferrable; repair in place is always available.
- **Do not read source text to pin a declared domain** — the thing a plan reads (a literal, a
  declaration) is not the thing that enforces (a runtime object, mutable after its literal).
  Pin composed or runtime output.
- Name forbidden remedies and deferral homes by number in every brief, and say when none
  matches; foreclose the refuted-decoration class by name or slots re-litigate it.
- An adjudicated refutation is retained marked REFUTED with its refuting command, never filed
  as an issue (§1.9).

## The dispatch instrument (caller-side)

The brief a delegate reads is composed by `.pi/extensions/gitjig/review/briefs.ts` — what a
delegate must be told about its provisioned world belongs there, not here. What the caller must
know about the transport:

- The dispatch tool provisions an isolated clone and returns validity plus the return's
  `summary` string — **only the summary crosses back to the caller**. A structured payload a
  brief asks for is readable by the orchestrator's own driver, not by the tool's caller, so a
  brief written for tool-side dispatch must demand the complete result inside `summary`.
- Return schema is closed; a stray hexadecimal run of six or more characters anywhere outside
  the head field refuses the whole return — demand commit position-labels.
- Give delegates a self-enforced deadline well inside the run bound, a private `mktemp -d`, and
  the instruction to run `npm ci` first with the reason (a bare `npx biome` on an uninstalled
  tree resolves a different package and exits 0; a bare suite run silently skips the arms that
  need the install and still exits 0).
- A refused "the delegated run reported failure" is the transient class — re-dispatch the same
  brief once before diagnosing.
- Verify the run bound is exposed before relying on it (the host loads extensions once per
  session): `grep -c 'Optional run bound in milliseconds' .pi/extensions/gitjig/dispatch/index.ts`
  must be non-zero.

## Working in this repository

- Branch `ilgyu-yi/<type>/<issue#>-<slug>`; the draft PR opens with the first real commit, body
  first line `Closes #N`.
- A SPEC edit regenerates the TOC in the same commit (`.github/workflows/build_toc.sh`) or CI
  fails.
- Commit grammar is gated at tier 2 in this clone: do not re-check it by hand and do not push
  past it with `--no-verify` — an escape is accountable and observable (§3.8).
- No mutation harness exists: weaken a guard in a throwaway isolated copy (never `git archive`;
  never mutate git state in a copy) and run the suite there by hand, serially.
- Egress for repository-derived text going to an issue or PR is the publish instrument — the
  one landed tier-1 gate; composing a comment and posting it another way routes around the only
  egress boundary that exists. It has no draft option: create, then `gh pr ready N --undo`.
- Name the changelog fragment by the issue number and never close the issue by hand —
  `Closes #N` on the body's first line populates the closing reference.
- Merging needs a beat after `gh pr ready`: the first merge attempt can report a base-branch
  policy refusal while the draft transition settles, then succeeds shortly after.
- Suite facts that mislead if unknown: five arms in `test/egress-publish.integration.test.ts`
  announce a SKIP without `npm ci` (bare 29/5 skipped, installed 34/34, both intended and
  pinned in that file's own header), and the suite is not all-green under parallel load — a
  kill or a red must survive a serial re-run.

## Modes, the park, and the own-behalf grant

- Declare the session's mode explicitly at the start; never infer it (§5.6). Attended stops at
  the ready transition; unattended runs to merge-or-park (§5.7). The park's marker label in
  this repository is **`unattended-parked`** (§5.7 names only "a marker label"; this is the
  name).
- A reviewer verdict may stand in the human slot at the judgment checkpoints; attribution is
  never substitutable (§5.6).
- **The standing own-behalf activation grant** — the §5.7 per-project, default-off, operator-set
  policy switch, turned on by the operator for a bounded domain and revocable at any time. It
  reaches activation only. The run may activate an issue it authored when all three hold: the
  type is `task` or `bug`; the ranking above classifies it priority 1; and the change amends no
  SPEC contract. Always the operator's, never the run's: `directive`, `initiative` and
  `execution` issues; any SSOT amendment however typed; anything not priority 1; and directive
  completion review. An own-behalf verdict carries the activation marker, states in its own text
  that it is own-behalf under this grant, answers the three conditions explicitly with the
  priority-1 call naming the convergence-failure form it removes, and performs the §1.2
  adjudication for real — §5.7 binds §1.6's evidence rules to an own-artifact approval in full.
  On any doubt about scope, it is the operator's: an autonomy toggle fails safe toward more
  human (§5.6).
- Four acts are never side effects of a run (§5.7, §0.3): applying an SSOT correction; reversing
  a deliberate human act; re-adjudicating an unchanged artifact; closing or discarding another
  party's filed work.

## Reading the SPEC

Read targeted, through the generated TOC's line numbers. Never load the whole document.

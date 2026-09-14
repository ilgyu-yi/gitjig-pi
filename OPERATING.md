# OPERATING — working doctrine for this repository

This file is **non-normative**: contracts live in `SPEC.md`, and where this file and the SPEC
disagree, the SPEC governs. Nothing here binds a gate or an actor. What it holds is the residue of
the author-side working knowledge that no instrument carries yet — and the condition on which it
stops existing.

## The exit condition

**This file is deleted when the residual roster below is empty.** A rule earns a place on that
roster on one ground: it is author-side, and the reason no instrument can reach it is stated at it.
A rule that has an instrument, that can have one, or that restates a SPEC clause does not belong on
the roster and does not belong in this file — the instrument, the filed derivation, and the clause
are its three homes, in that order.

The condition resolves from the living set alone: the roster is in this file, the derivations it
names are open issues, and nothing outside the tree has to be consulted to tell whether it is met.
That is what keeps it a contract rather than a schedule (§2.4).

**The residual roster.** Each entry names what it keeps and why an instrument cannot reach it:

| § | what it keeps | why no instrument reaches it | derivation |
|---|---|---|---|
| R1 | the queue ranking and the repair preference | no actor but the author ranks a queue; a brief binds a delegate for one round, and the ranking has to hold across all of them | none owed |
| R2 | claim-discipline rules 1, 2, 3 and 5 | they govern **acts** — taking an exit status, re-reading after an edit, asserting an anchor matched — and a text reader cannot observe an act. A brief also binds the wrong party: the author is the one who runs the command | #227 |
| R3 | the evidence ledger | readings of SPEC clauses against this corpus, addressed to the author across rounds; part of it is delegate-facing and in scope for its derivation | #227 |
| R4 | the caller-side transport contract | what the **caller** must put into any brief: neither a delegate-world fact (which `briefs.ts` composes) nor a SPEC contract | #220 |
| R5 | the clone's working facts | properties of this one clone's toolchain and gates, true of no adopter and so homeless in the SPEC | none owed |
| R6 | the own-behalf grant's bounded domain | §5.7 makes the switch per-project and operator-set but homes no value for it; the value lives here as prose | #228 |

**The §2.4 disposition, settled.** Doctrine **is** a living surface. §2.5 defines the living set by
a criterion — *the surfaces read to decide current behavior* — before enumerating it, and this file
is read to decide how work proceeds. The alternative class does not fit: a write-once record is
*"owed no maintenance afterward"* and *"superseded, never repaired"*, and this file is repaired.
So §2.4's archaeology clause binds it, on the same terms the sweep of the rest of the tree settled:
**the fact stays and the provenance goes.** A rule's incident is the reason the rule applies rather
than gets skimmed, so it travels — restated as a property of the artifact rather than as an episode
in its history. The composed brief blocks already hold it that way: the exculpatory burden carries
*"nine hiding shapes killed is evidence about nine shapes and is silent about a tenth"* and the
coverage-attribution burden carries *"a pin that reads a SUBSTRING stays green while a DIFFERENT arm
is the one that reds"* — each the incident's causal content, in the present tense, with no round,
finding label or issue number attached.

## What the loop is for, and how to rank the queue  <!-- R1 -->

This repository is built by dogfooding itself: the SPEC and the shell are developed *through* the
review-and-dispatch machinery they define, and the failures that surface in that loop are the issue
population. An issue's worth is how much it degrades the loop, not how incomplete the artifact is
without it.

The operator's ranking — sort the queue by it, and judge new filings by it:

1. **Remove what blocks or degrades development itself.** The signal is failure to converge —
   usually a round count that climbs and will not come down. SPEC §1.4 owns the diagnosis and
   §1.9 owns oscillation; read both before using a round count as evidence for anything.
2. **Make developing other projects with this shell easy** — the adopter path.
3. **Completeness** of the artifact.

**Preferred repair, in order: delete, then simplify.** §2.5 binds this; the operator states it as a
standing preference on top, which is why it is here and not only there.

**When the best structure keeps demanding new mechanisms, re-examine the premise.** A patch cascade
is a priority-1 signal about the premise, not a backlog of patches.

**A prose-accuracy finding on a record surface can never obligate you into minting prose.**
Measurement precedes generation; the render is machine-emitted, never typed. If you cannot produce
the render or the pointer, delete the claim rather than authoring a replacement for it.

## The claim discipline (author-side)  <!-- R2 -->

The single highest-frequency failure in this repository's history is an author recording a claim
that measurement contradicts. Each rule carries the measured fact that makes it apply, because a
rule without it is the kind of prose that gets skimmed.

1. **Every claim about a command is backed by a captured exit status, never by reading output —
   and the command run is the command CI runs.** `biome check .` exits 0 on a tree where
   `biome ci --error-on-warnings .` exits 1, so blank output read as success records "biome clean"
   over a red `source-style` check.
2. **Every claimed textual remedy is re-read from the artifact after the edit.** Issuing an edit is
   not evidence the edit exists; a grep over the target files is.
3. **Every scripted edit asserts its anchor matched.** A string replacement that matches nothing is
   a silent no-op that reads exactly like a landed repair, and the assertion is what turns a wrong
   anchor guess into an error instead of a false record.
4. **A universal claim needs its falsifying command run first, and the wording may not exceed what
   the command read.** "Reports nothing" over a command reporting one hit, and a domain recorded as
   cleared where two of its three treatments were measured, are the same defect at two scales.

Four rules already left this list because instruments carry them, and they are named here so the
roster is readable against the file's own history: findings crossing into a brief verbatim is
structural in `briefs.ts` (it composes raw findings and has no summarizing path); the exculpatory
burden and the coverage-attribution burden are composed blocks in both briefs; and the sentence
tying the last two together named no act either of them did not already own.

## The evidence ledger  <!-- R3 -->

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
- **Do not read source text to pin a declared domain** — the thing a plan reads (a literal, a
  declaration) is not the thing that enforces (a runtime object, mutable after its literal). Pin
  composed or runtime output.
- **§1.2's failing-first evidence obligation covers a pure-document deliverable** — the pre-existing
  gates exercised failing-first. "No test owed, because the clause is advisory" answers a
  question §1.2 does not ask.
- **Do not reach for §3.11 to license not doing the work.** It forbids a second implementation
  of the predicate; building an input fixture is not that.
- **§1.9's durable-before-the-fix ordering breaks exactly when you are moving fastest.** Record
  the lapse rather than backdating.

## The dispatch instrument (caller-side)  <!-- R4 -->

The brief a delegate reads is composed by `.pi/extensions/gitjig/review/briefs.ts` — what a delegate
must be told about its provisioned world belongs there, not here. What the caller must know about
the transport is below, and **this file is not its durable home**: a file carrying a deletion
condition cannot be the durable home of a contract. Which surface is, #220 decides.

- The dispatch tool provisions an isolated clone and returns validity plus the return's
  `summary` string — **only the summary crosses back to the caller**. A structured payload a
  brief asks for is readable by the orchestrator's own driver, not by the tool's caller, so a
  brief written for tool-side dispatch must demand the complete result inside `summary`.
- Return schema is closed; outside the head field a hexadecimal run that names the held head —
  one the held hash contains at six or more characters, or one containing its 7-prefix — refuses
  the whole return; demand commit position-labels.
- Give delegates a self-enforced deadline well inside the run bound, a private `mktemp -d`, and
  the instruction to run `npm ci` first with the reason (a bare `npx biome` on an uninstalled
  tree resolves a different package and exits 0; a bare suite run silently skips the arms that
  need the install and still exits 0).
- A refused "the delegated run reported failure" is the transient class — re-dispatch the same
  brief once before diagnosing.
- Verify the run bound is exposed before relying on it (the host loads extensions once per
  session): `grep -c 'Optional run bound in milliseconds' .pi/extensions/gitjig/dispatch/index.ts`
  must be non-zero.

## The clone's working facts  <!-- R5 -->

- Commit grammar is gated at tier 2 in this clone: do not re-check it by hand and do not push
  past it with `--no-verify` — §3.8 records that escape as traceless, so nothing catches it.
- No mutation harness exists: weaken a guard in a throwaway isolated copy (never `git archive`;
  never mutate git state in a copy) and run the suite there by hand, serially.
- Egress for repository-derived text going to an issue or PR is the publish instrument — the
  one landed tier-1 gate; composing a comment and posting it another way routes around the only
  egress boundary that exists. It has no draft option: create, then `gh pr ready N --undo`.
- Merging needs a beat after `gh pr ready`: the first merge attempt can report a base-branch
  policy refusal while the draft transition settles, then succeeds shortly after.
- Suite facts that mislead if unknown: arms in `test/egress-publish.integration.test.ts`
  announce a SKIP without `npm ci` rather than reddening (the skip and its reason are stated
  in that file's own header), and the suite is not all-green under parallel load — a
  kill or a red must survive a serial re-run.

## The own-behalf activation grant  <!-- R6 -->

§5.7 makes own-artifact approval a per-project, default-off, operator-set policy switch and homes
no value for it. This is that value, for this repository, revocable at any time. It reaches
**activation only**. The run may activate an issue it authored when all three hold: the type is
`task` or `bug`; the ranking above classifies it priority 1; and the change amends no SPEC contract.
Always the operator's, never the run's: `directive` and `initiative` issues; any SSOT amendment
however typed; anything not priority 1; and directive completion review. On any doubt about scope
it is the operator's — an autonomy toggle fails safe toward more human (§5.6).

The grant's verdict form, which is also local: an own-behalf verdict carries the activation marker,
states in its own text that it is own-behalf under this grant, answers the three conditions
explicitly with the priority-1 call naming the convergence-failure form it removes, and performs the
§1.2 adjudication for real.

The park's marker label in this repository is **`unattended-parked`** — §5.7 names only "a marker
label", and this is the name.

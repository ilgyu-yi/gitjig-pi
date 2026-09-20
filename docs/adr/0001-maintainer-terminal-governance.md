# ADR 0001: Maintainer-terminal, human-operable governance

- Status: accepted by #301 contract settlement
- Supersedes: incompatible landing/topology doctrine derived by #261 and #293
- Normative contract: `SPEC.md` §3.8

## Context

The split-ruleset design made agent evidence, independent identity, App-produced escape records, and one-shot claims prerequisites of repository governance. That drifted from the intended model: GitHub administrators retain broad terminal authority, while Pi narrows its own ordinary use and provides durable evidence. Tier 2 and Tier 3 must also remain worthwhile and complete for humans without Pi.

## Decision

Use the authority, label, operator-directed, history-shape, configurable-installation, migration, and phase contracts in SPEC §3.8. One configurable native ruleset is the default shape. Native administrator bypass remains broad. Tier 1 ordinarily uses it only to waive missing native approval when `merge:bypass-permitted` is present; a current operator may explicitly direct a one-attempt bypass of enumerated blockers after durable audit publication and operand reread. The label is advisory and carries no producer, TTL, claim, consumption, or own-behalf semantics.

Review → Judge → Resolver and default `ac-closeout` consumption remain Tier 1. Humans retain complete native merge, administration, installation, and audit paths. Configuration is target-owned and never self-applies. Ordinary topic branches rebase; `history-shape` rejects topic-side merges while merge commits preserve first-parent PR grouping.

## Consequences

The #293 source-split plan and marker must not be authorized or executed. Existing split-topology, escape/App, and source-application code is superseded-dormant and has no authority; SPEC §3.8 phases remove or migrate it before any replacement application. #261 and #28 must be revised and re-activated in Phase 1R. Live settings mutation requires a later separately activated phase and fresh human confirmation.

Maintenance forward-port policy is deliberately excluded and remains with #300 or a concrete Issue it promotes.

## Placement precedence and human-only cases

A lower-tier rule is eligible only when it is independently good human governance and leaves human development, review, landing, administration, installation, and audit complete without Pi. Exact deciding-information placement follows that filter; cost calibration cannot project an agent-only abstraction downward. This preserves native multi-human review and merge, single-administrator own-PR landing, direct human emergency bypass, human-only governance installation/audit, and useful local Git discipline.

## Rejected alternatives

We reject the two-rule split with a doorless core, own-beneficiary restrictions, required independent identities, installed-App policy producers, expiring escape records, claim/consume state, and native-required `ac-closeout`. We also reject an all-or-nothing fixed installer and GitHub required-linear-history. Those mechanisms either confuse Tier-1 agent discipline with ordinary human governance or cannot support the intended first-parent merge-commit history.

## Residual risks

A writer-supplied advisory label can be applied by any writer and is not a capability. Head/base observation can race the eventual merge. Administrators can bypass broad governance, and direct human administration does not receive Tier-1 evidence guarantees. Configurable writes can partially succeed when the platform offers no transaction; the shared engine stops and reports measured state rather than rolling back or claiming success. Malicious-administrator defense is explicitly out of scope.

## Derivation map

Phase 1R revises and re-activates #261 and #28 and settles affected Issues. Phase 2 migrates Tier-1 landing and removes escape/App/own-behalf authority. Phase 3 lands `history-shape`. Phase 4 lands target config and the pure shared engine. Phase 5 lands human, Pi, and headless surfaces. Phase 6 removes remaining old topology/policy/source-split assets. A separately authorized Phase 7 alone may plan, confirm, apply, audit, and pilot live governance.

# ADR 0001: Maintainer-terminal, human-operable governance

- Status: accepted by #301 contract settlement
- Supersedes: incompatible landing/topology doctrine derived by #261 and #293

## Context

The split-ruleset design made agent evidence, independent identity, App-produced escape records, and one-shot claims prerequisites of repository governance. That drifted from the intended model: GitHub administrators retain broad terminal authority, while Pi narrows its own ordinary use and provides durable evidence. Tier 2 and Tier 3 must also remain worthwhile and complete for humans without Pi.

## Decision

Use the authority, label, operator-directed, history-shape, configurable-installation, migration, and phase contracts in SPEC §3.8. One configurable native ruleset is the default shape. Native administrator bypass remains broad. Tier 1 ordinarily uses it only to waive missing native approval when `merge:bypass-permitted` is present; a current operator may explicitly direct a one-attempt bypass of enumerated blockers after durable audit publication and operand reread. The label is advisory and carries no producer, TTL, claim, consumption, or own-behalf semantics.

Review → Judge → Resolver and default `ac-closeout` consumption remain Tier 1. Humans retain complete native merge, administration, installation, and audit paths. Configuration is target-owned and never self-applies. Ordinary topic branches rebase; `history-shape` rejects topic-side merges while merge commits preserve first-parent PR grouping.

## Consequences

The #293 source-split plan and marker must not be authorized or executed. Existing split-topology, escape/App, and source-application code is superseded-dormant and has no authority; SPEC §3.8 phases remove or migrate it before any replacement application. #261 and #28 must be revised and re-activated in Phase 1R. Live settings mutation requires a later separately activated phase and fresh human confirmation.

Maintenance forward-port policy is deliberately excluded and remains with #300 or a concrete Issue it promotes.

# Mission

## What this exists for

Gitjig exists to make governed software change legible, repeatable, and safe without making an agent a prerequisite. It supplies a disciplined path from intent through evidence, review, landing, and audit while preserving complete human-operated paths at every repository-governance layer.

Pi is the optional Tier-1 shell. It adds agent-specific orchestration, review composition, credential-use discipline, and durable evidence. Git and GitHub remain independently useful for humans: Tier 2 is good local Git discipline, and Tier 3 is good repository governance whether or not Pi is installed or running.

## Success looks like

- **Traceability** — a reader can connect intent, evidence, review, decision, and landed change.
- **Enforcement** — irreversible acts are guarded where the deciding facts exist, with explicit failure and bypass semantics.
- **Agent-agnosticism** — repository governance does not depend on one model, agent, or harness.
- **Evidence** — claims are backed by durable, intelligible artifacts rather than ceremony.
- **Human operability** — humans can develop, review, merge, administer, install, and audit without Pi; Tier 2 and Tier 3 are independently useful and desirable human disciplines. Tier 1 earns its place by adding safety for agent operation, not by making ordinary human governance valid.

## Explicitly NOT goals

- Replacing native human review, merge, or repository administration with agent-only ceremony.
- Treating an automation identity, a second person, or a platform identity split as mandatory for single-maintainer development.
- Defending against a malicious repository administrator; administrators retain the platform's broad administrative authority and audit trail.
- Making Tier-1-only evidence, including Review → Judge → Resolver or `ac-closeout`, a native repository requirement by default.
- Mutating live repository settings merely because configuration changed or a plan was generated.
- Requiring globally linear Git history. PRs are grouped by merge commits on the first-parent line while the complete DAG may remain intentionally non-linear.
- Settling maintenance forward-port timing or exceptions here; that policy is owned by #300 and any later activated contract it promotes.

## Stakeholders

Maintainer: ilgyu-yi (decision maker). Primary users: agents and human operators working under the shell, including humans operating Tier 2 and Tier 3 directly.

## Last reviewed: 2026-09-07

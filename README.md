# gitjig-pi

An agent-agnostic operating shell that enforces engineering work norms — the GitHub-standard flow (issue → branch → draft PR → authorized landing), documentation, testing, and evidence discipline — for agent-driven development on the [pi harness](https://github.com/earendil-works/pi). Built for agents and the human operators who authorize and supervise their work.

## Status

Active development under the contract in [`SPEC.md`](SPEC.md).

Issue completion is PR-bound except for the two routes SPEC §2.2 defines: Directive completion review, and — for an activated `task`, `bug`, or `execution` Issue whose governed-repository change surface is expressly empty — empty-change completion review on that section's terms. Neither route substitutes for a PR: Directives never branch into engineering PRs, and empty-change completion is unavailable wherever governed-repository implementation exists.

## Getting started

The runtime has no build step — the tree ships TypeScript sources that run directly, and nothing is compiled before it executes. Two prerequisites, and neither is an `npm install` — nothing in this repository's manifest is needed to run the suite:

- [`pi`](https://github.com/earendil-works/pi) available on `PATH` — the suite drives the real binary against disposable fixtures.
- A Node.js runtime with native TypeScript type-stripping.

To arm the local git-hook tier in a clone of this source repository, run `bash .githooks/bind_local_tier.sh` from the repository root — idempotent; full contract in SPEC §3.2/§4.7.

An adopter has a different product boundary: its reviewed history carries self-standing handed-over assets and `.pi/gitjig.pin.json`; the gitjig runtime is carried and verified per clone, never committed. The delivery and provisioning commands derive after the settlement in SPEC §4, so this source-tree bind command is not presented as an adopter installer.

Run the verification suite as:

```sh
node --test "test/*.test.ts"
```

Keep the glob quoted, and do not run a bare `node --test`: node's default discovery treats every file under `test/` as a test and executes the harness assets themselves, so that shape false-reds on a harness asset instead of measuring the runtime. The harness's own contract stays with its author-side home, the header of [`test/harness/run-pi.ts`](test/harness/run-pi.ts). CI runs the same invocation on every pull request to `main` or a maintenance branch — the `suite` required check, [`.github/workflows/suite.yml`](.github/workflows/suite.yml), which also states its own install posture; contract in SPEC §3.2/§3.3.

## Driving a review round

Run the composed panel, Judge, Resolver, durable record, and repair-history path with a repository-relative JSON file:

```sh
/review-round review-round.json
```

A complete specification is:

```json
{
  "pr": 212,
  "fences": {
    "outOfScope": [],
    "forbiddenRemedies": [],
    "deferralHomes": [],
    "priorFindings": [{"label": "F1", "text": "A prior adjudicated finding."}]
  },
  "changeDescription": "Add the review-round call site.",
  "delegateArgv": ["pi", "-p", "--no-session", "Read ../brief.md and write ../return.json."],
  "timeoutMs": 600000,
  "timing": {"firstReturnSeconds": 120, "finalReturnSeconds": 480}
}
```

`pr` is a positive integer, and it is the only review target the spec carries. The repository is resolved once from the checkout the command runs in, and the pull request is then addressed explicitly within that resolved identity; the base and reviewed head come from that pull request. The criterion manifest is the stable union of each closing issue's writer-attributed activation snapshot, immediately following its activation PASS record, and its current `Acceptance criteria` section. Missing, malformed, detached, or ambiguous activation evidence hands off rather than narrowing the manifest. Nothing in the spec can retarget the round: it names a number, and every other review target is derived. The clone must already contain the attested head, or the round hands off instead of reviewing a different commit.

`changeDescription` is a non-empty string and `delegateArgv` a non-empty list of non-empty strings. All four fence lists are required; each prior finding has exactly `label` and `text`. `timeoutMs` is optional, positive, and at most 2147483647. `timing` is optional; both values are positive seconds, `finalReturnSeconds` is greater than `firstReturnSeconds`, and `finalReturnSeconds` in milliseconds is less than `timeoutMs`. Unknown keys, an absolute or outside-repository spec path, a path with a symbolic-link component, and unreadable JSON are refused before dispatch. An omitted `timeoutMs` defaults to 1800000 (30 minutes). An omitted `timing` defaults to `firstReturnSeconds = timeoutMs / 3000` and `finalReturnSeconds = timeoutMs / 2000`, computed from whichever `timeoutMs` is in effect.

The command appends one structured `gitjig-review-round` entry and displays one terminal line. `refused` means the input was rejected before a round; `hand-off` means subject, history, dispatch, publication, or required re-entry could not safely complete and names the re-entry target; `posted` means the durable review record was confirmed. The terminal line reports the disposition and, when present, the review state and diagnosis.

The delegate runs in the caller's trust domain and inherits its environment, credentials included: remote reach through inherited credentials is not confined.

## Pre-authoring brief

Before editing, invoke the advisory command with one closed JSON argument:

```text
/authoring-brief {"plan":"repair the named surface","failingCheck":{"description":"the focused test is red","command":"node --test test/example.test.ts"},"paths":["test/example.test.ts"]}
```

The required fields are `plan`, `failingCheck.description`, `failingCheck.command`, and a non-empty list of normalized repository-relative `paths`; unknown or missing fields, unrouted or conflicting paths, and unavailable canonical anchors produce an explicit **incomplete** result, not readiness. The command uses the paths only to select exact `SPEC.md` sections through the committed policy, then injects the brief into the current session. It does not execute the supplied command or infer authority from plan text. Plan/check text is repository- or operator-provided untrusted context that is shown to the model verbatim; the committed policy and symlink-safe `SPEC.md` read, not that text, select the governing clauses. Full contract in SPEC §2.5.

## The development toolchain

Formatting, linting and type checking run from a root `package.json` and are **development and CI only**. They are not part of what an adopting repository receives, and they are not a precondition for the suite above — the command runs unchanged in a clone that never installs. Contract in SPEC §3.3 (`source-style`, `type-check`).

```sh
npm ci          # install the pinned dev tools
npm run check   # format + lint, reporting only
npm run format  # format, rewriting in place
npm run typecheck
```

`typecheck` runs `tsc --noEmit`: it checks the annotations node's type stripping erases, and emits nothing. No path in the run path depends on its output.

## Inspecting the Phase-4 topology handoff

Phase 4A is read-only. The topology planner reads the addressed repository, complete ruleset details, repository merge settings, the authenticated account's collaborator role, and the GitHub Actions integration. Its output is an **unauthorized** before/after/rollback artifact: do not copy its API calls into a shell until the separately activated Phase 4B records an operator authorization for the exact plan hash.

A human can inspect the same inputs without Pi:

```sh
gh api repos/OWNER/REPO
gh api --paginate --slurp 'repos/OWNER/REPO/rulesets?includes_parents=true&per_page=100'
gh api repos/OWNER/REPO/rulesets/RULESET_ID
gh api apps/github-actions
gh api repos/OWNER/REPO/collaborators/LOGIN/permission
```

A human can also render the closed artifact from a clean checkout (with Node TypeScript stripping) without invoking Pi:

```sh
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
node --experimental-strip-types --input-type=module -e \
  'import {loadTopologyPlanningSnapshot,planSplitTopology} from "./.pi/extensions/gitjig/landing/topology-plan.ts";
   const snapshot=await loadTopologyPlanningSnapshot("github.com",process.argv[1],process.cwd());
   if (!snapshot) process.exit(2);
   const result=planSplitTopology(snapshot);
   console.log(JSON.stringify(result,null,2));
   if (!result.ok || result.plan.authorized !== false) process.exit(3)' "$repo" > topology-plan.json
```

Inspect `before`, every ordered `steps[*].{method,path,body,postRead}`, optimistic ids/instants, `beforeDigest`, `desiredDigest`, the derived `correlationId`, the planner-owned whole `artifactHash`, and reverse-order `rollback` entries. Never translate those calls into an ad hoc shell loop. The one application surface is `/source-split repo=OWNER/REPO issue=N [host=github.com]`; it re-derives the plan and authority, appends/re-reads the winning claim, and owns every compare/write/post-read/record transition. Without Pi, a human may invoke the same exported `loadTopologySourceApplication` then `executePlatformTopologySource` functions from `source-split-platform.ts` with Node TypeScript stripping; this is the same service and effect boundary, not a second executor. Drift or mismatch stops with the append-only terminal as the operator recovery artifact; rollback bodies are information, never executable authority, and recovery never improvises a direct push or broader bypass.

Expected end state is one default-branch `core-governance` ruleset with no bypass and one `human-approval` ruleset whose only bypass is repository role 5 in pull-request mode. Repository merge settings allow merge commits and disable squash/rebase. The authorized Phase-4 scratch proof established that this quorum-only bypass leaves an independently composed doorless core enforced; that evidence is not source mutation authority.

The plan remains unauthorized data. A later authorization is valid only when one completely paginated GET-only read finds one unedited human platform comment, its author is the current authenticated actor with freshly read `admin` collaborator permission, and its explicit issued/expiry window, repository, source pair, correlation id and whole artifact hash all match. Source application is record-first and stepwise: claim the exact authorization, immediate GET/compare, execute only the plan's method/path/body, exact post-read, then append step evidence. Drift or mismatch stops without continuation or automatic rollback; replay requires the same winning claim and recorded exact live state. Pre-split source and post-split carrier plans have different keys, hashes, records and authorization stages; neither transfers. The application implementation exports closed parsers, one effect-injected service, and the one operator surface; without a unique admitted marker it may append a refusal terminal but performs no ruleset or repository-setting write.

The dormant bootstrap service is not a general installer. It can consider only a PR whose sole semantic constituent is canonical `.github/landing-topology.json`, after a fresh exact plan authorization and a valid escape producer distinct under the existing own-behalf rule. Phase 4B therefore requires either a genuinely distinct authorized human producer or a separately configured source App identity; no single-maintainer exception exists. Phase 4A performs none of these server actions.

## Documentation

- [`MISSION.md`](MISSION.md) — canonical direction for this project.
- [`SPEC.md`](SPEC.md) — the behavioural SSOT: work norms, gate classes, and workflow contracts.

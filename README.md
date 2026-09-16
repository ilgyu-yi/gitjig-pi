# gitjig-pi

An agent-agnostic operating shell that enforces engineering work norms — the GitHub-standard flow (issue → branch → draft PR → review-gated merge), documentation, testing, and evidence discipline — for agent-driven development on the [pi harness](https://github.com/earendil-works/pi). Built for agents and the human operators who work with them.

## Status

Active development under the contract in [`SPEC.md`](SPEC.md).

## Getting started

The runtime has no build step — the tree ships TypeScript sources that run directly, and nothing is compiled before it executes. Two prerequisites, and neither is an `npm install` — nothing in this repository's manifest is needed to run the suite:

- [`pi`](https://github.com/earendil-works/pi) available on `PATH` — the suite drives the real binary against disposable fixtures.
- A Node.js runtime with native TypeScript type-stripping.

To arm the local git-hook tier in a clone, run `bash .githooks/bind_local_tier.sh` from the repository root — idempotent; full contract in SPEC §3.2/§4.7.

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

`pr` is a positive integer, and it is the only review target the spec carries. The repository is resolved once from the checkout the command runs in, and the pull request is then addressed explicitly within that resolved identity; the base and reviewed head come from that pull request. The criterion manifest is the stable union of each closing issue's writer-attributed activation snapshot and its current `Acceptance criteria` section. A missing, malformed, or ambiguous activation snapshot hands off rather than narrowing the manifest. Nothing in the spec can retarget the round: it names a number, and every other review target is derived. The clone must already contain the attested head, or the round hands off instead of reviewing a different commit.

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

## Documentation

- [`MISSION.md`](MISSION.md) — canonical direction for this project.
- [`SPEC.md`](SPEC.md) — the behavioural SSOT: work norms, gate classes, and workflow contracts.

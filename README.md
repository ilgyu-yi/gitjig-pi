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

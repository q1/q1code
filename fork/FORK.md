# q1code

q1code is a public fork of T3 Code, specialised for one user (Mic) and one private stack. It is not a distribution for other people. Everything about that stack (hostnames, unit files, backup paths) lives in a separate private repo and reaches q1code through env or `~/.q1code/userdata/fork.json`. The public tree never names a private host.

AGENTS.md still applies in full. This file adds the rules that keep the fork syncable with an upstream that ships ~26 commits a day.

## Branch model

```
upstream/main   pingdotgg/t3code. Fetched, never edited.
main            fast-forward mirror of upstream/main. Never commit here.
fork            main + a linear series of fork commits. Rebased onto main on every sync.
                Deployed trunk. Force-pushed with --force-with-lease only.
fork/<slug>     optional refs inside the series, moved by `git rebase --update-refs`.
up/<topic>      upstream PR branches. Branched from main. Never from fork.
sync/<stamp>    throwaway branch a sync rebases on. Promoted to fork or reviewed as a PR.
snap/<stamp>    tag taken at fork before every rebase. Rollback is one force-push.
```

The series is the changelog: `git log main..fork` answers "what is different from upstream". `rerere` is on (`rerere.enabled`, `rerere.autoupdate`, `rebase.updateRefs`) so a conflict is resolved once. The rerere cache is committed to the `fork-rerere` orphan branch.

## Isolation

Fork code is additive files in fork-owned locations:

- `packages/fork-core/` (`@q1code/core`): flag registry, brand, fork config, fork RPC contracts. No heavy deps.
- `apps/server/src/fork/`, `apps/web/src/fork/`, `apps/mobile/src/fork/`, `apps/desktop/src/fork/`
- `.github/workflows/fork-*.yml`. Upstream workflows are disabled with `gh workflow disable`, never deleted.
- `.agents/skills/fork-*/`
- `fork/`: this file, `FEATURES.md`, `SEAMS.md` (generated), `docs/`.

Upstream files are touched only at seams. A seam is at most 3 lines (one import plus one call, JSX element, or array entry), carries `// fork: <slug>`, and is either guarded by its flag or inert (an optional key, a registry entry). A seam never restructures upstream code. If a feature needs restructuring, that is an upstream PR first; the feature waits or carries a temporary larger patch marked `Fork-Seam-Debt: yes`.

Prefer seam points built for extension: `builtInDrivers.ts`, `ExecutionEnvironmentCapabilities`, `settingsSearch.ts`, the command palette list, `ServerEnvironment.ts` capabilities, route tables. Do not seam inside the bodies of `ChatView.tsx`, `Sidebar.tsx`, or `ChatComposer.tsx`; if you must, the seam is one `<ForkSlot name="..." />` whose implementation lives in `apps/web/src/fork/`.

`fork/SEAMS.md` lists every upstream file the series touches. Budget: 40 files. `scripts/fork/seams.ts` regenerates it and fails over budget.

## Commits

Every fork commit carries trailers:

```
Fork-Feature: <slug>     required. `base` for infra, else the feature slug from FEATURES.md
Upstream: no | candidate | pr:<n> | merged:<sha>
```

Conventional titles as upstream (`feat(web): ...`) so a cherry-pick needs no rewording.

`candidate` commits must apply on plain `main`: no `@q1code/` imports, no flag checks, no fork paths, no `// fork:` comments. They sit first in the series so they never depend on fork-only commits. Before starting any fork work, ask "would upstream want part of this?" and split the series into `candidate` then `no`.

## Flags-off parity

With every flag off, q1code behaves exactly like upstream. Flags live in `packages/fork-core/src/flags.ts`, default off, resolved on the server (`T3FORK_<SLUG>` env, then `fork.json`, then default) and published to clients through `capabilities.forkFlags`. Clients read `useForkFlag('slug')` from `packages/client-runtime`. Nothing runs, renders, or persists behind an off flag. Fork CI enforces this by running upstream's own suites on `fork`.

## Upstream PRs without leaks

- Branch `up/<topic>` from a freshly fast-forwarded `main`. Never from `fork`.
- `git cherry-pick -x` the candidate commits. Strip `Fork-*` and `Upstream:` trailers.
- `scripts/fork/leak-check.ts` must pass: no `@q1code/`, `/fork/`, `T3FORK_`, `fork:` comments, flag names, `q1`, `q1code` in the diff.
- PR text never mentions fork, downstream, q1, or q1code. Screenshots come from the `up/` build.
- Upstream accepts small focused fixes and not much else. Read their CONTRIBUTING.md before opening anything.

The `fork-upstream-pr` skill runs this end to end.

## Sync

`fork-sync` fetches upstream, fast-forwards `main`, tags `snap/<stamp>`, rebases `fork` onto `main` on `sync/<stamp>`, resolves conflicts under fixed rules (upstream wins in upstream files unless a seam is destroyed; re-apply seams minimally; drop commits upstream absorbed; never wholesale ours or theirs), runs targeted checks, and either promotes deterministically or opens one sync PR. An agent that resolved conflicts by hand never promotes. Each run writes `fork/docs/sync-log/<stamp>.md`.

## Where to look

- `fork/FEATURES.md`: the registry. Every slug in a trailer has an entry here.
- `fork/SEAMS.md`: generated seam table.
- `scripts/fork/`: `seams.ts`, `leak-check.ts`, `range-diff-classify.ts`, `sync.sh`, `promote.sh`, `rollback.sh`.
- `.agents/skills/fork-sync`, `fork-audit`, `fork-feature`, `fork-upstream-pr`, `fork-release`, `fork-triage-branches`.

## Never

- Commit on `main`.
- Branch an upstream PR from `fork`.
- Delete or edit an upstream workflow file. Disable it.
- Rewrite "T3 Code" strings globally. Brand seams are listed under `base` in FEATURES.md; the rest stays upstream's.
- Put a private hostname, secret, or unit file in this tree.
- Touch `~/.t3`. q1code's home is `~/.q1code`.

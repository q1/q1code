---
name: fork-feature
description: Scaffold a new q1code fork feature: registry entry in fork/FEATURES.md, flag in packages/fork-core/src/flags.ts, fork-owned directories, a seam checklist, the every-surface walk from AGENTS.md, and a plan that splits the commit series into upstream candidates and fork-only wiring. Use when starting any fork feature, before writing feature code, or when an existing feature needs its seams or flags re-planned.
---

# Fork Feature

Read `fork/FORK.md` first, then the `base` and `prism` entries in `fork/FEATURES.md` as examples. This skill produces the skeleton and the plan; feature code comes after and follows the plan.

## 1. Name it

Pick a slug: lowercase, hyphenated, unique in `fork/FEATURES.md`. It becomes the `Fork-Feature:` trailer, the flag key, and the `// fork: <slug>` marker. Check `git log --format=%B main..fork | grep Fork-Feature` for collisions with dropped slugs.

## 2. Registry entry

Add an entry to `fork/FEATURES.md` with every field from its header. Status `planned` until the first commit lands, then `active`. Write the purpose as one line a stranger can test against. Fill "removal condition" honestly; a feature with no removal condition is a feature nobody will delete.

## 3. Flag

Add one entry to `FORK_FLAGS` in `packages/fork-core/src/flags.ts`:

```ts
"<slug>": { description: "...", default: false, scope: "server" | "client" | "both" },
```

Default is `false`. The only exception in the registry is `update-check`; do not add another without a written reason in the entry. Scope `server` for things that spawn, read files, or change env; `client` for pure UI preferences; `both` when the server decides and the client renders. Client-only state persists under a fork-namespaced localStorage key, never in `ClientSettingsSchema`.

## 4. Directories

Create only what the feature needs, under fork-owned locations:

- `apps/server/src/fork/<slug>/` for services, reactors, drivers, RPC handlers
- `apps/web/src/fork/<slug>/`, `apps/mobile/src/fork/<slug>/`, `apps/desktop/src/fork/<slug>/`
- `packages/fork-core/src/<slug>*` for shared types, config schema, fork RPC contracts (fork RPCs are typed here, not in `packages/contracts`)
- `packages/client-runtime` only for logic web and mobile both need

Config the feature reads lives in `~/.q1code/userdata/fork.json` under a `<slug>` key with a schema in `packages/fork-core`. Secrets go through the server secret store, never `fork.json`.

## 5. Seam checklist

For each upstream file the feature must touch, write down: file, the exact extension point, the 3 lines, the flag guard (or why it is inert), and the marker. Prefer the extension points listed in `fork/FORK.md`. Reject any seam that:

- exceeds 3 lines,
- sits in the body of `ChatView.tsx`, `Sidebar.tsx`, or `ChatComposer.tsx` (use a `<ForkSlot />`),
- restructures upstream code (that is an upstream PR first, or `Fork-Seam-Debt: yes` with a deadline in the entry),
- would push `fork/SEAMS.md` over its 40-file budget.

Run `node scripts/fork/seams.ts` after adding seams and paste the resulting rows into the registry entry.

## 6. Hit every surface

Walk the list from `AGENTS.md` and record a decision for each, including "not supported here":

- **Entry points**: chat view, Settings (the q1code section), command palette, keybindings.
- **Clients**: web, desktop, mobile. Shared logic in `packages/client-runtime`; fork UI in each app's `src/fork/`.
- **Providers**: Codex, Claude, Cursor, Grok, OpenCode. One decision per adapter.
- **Contracts**: fork RPCs in `packages/fork-core`; the only `packages/contracts` seam is `forkFlags` unless the entry justifies another optional key.
- **Reverse states**: the flag off must fully undo the feature at runtime, and every action needs its inverse.
- **Connection modes**: local, Tailscale, relay. Multi-environment: what happens when one environment has the flag on and another off.
- **Docs**: user-facing behavior in `fork/docs/<slug>.md` (not `docs/user/`, which is upstream's); design notes in the registry entry.

## 7. Candidate/no split

Before writing code, split the planned commits:

- **`Upstream: candidate`** first: generic changes upstream would plausibly take (a new optional setting, a passthrough, a bug fix, a model manifest entry). No `@q1code/` imports, no flag checks, no fork paths, no markers. Each must build and pass tests on plain `main`. Keep each under the size upstream's CONTRIBUTING.md calls small.
- **`Upstream: no`** after: the flag, the seams, the fork directories, the docs.

Write the split into the registry entry under "upstream" as a list of planned commit titles. If nothing is a candidate, say so; if everything is, the feature may be an upstream PR and not a fork feature at all.

## 8. Tests

List in the entry: behavior tests for the feature (server logic gets focused tests, receipts not sleeps), and one flags-off parity test proving the seam is inert when the flag is off (no process, no env var, no rendered element, no capabilities field).

## 9. Commit the scaffold

One commit: registry entry, flag, empty directories with an index file if the toolchain needs one, the seam checklist as part of the entry. Trailers `Fork-Feature: <slug>`, `Upstream: no`. Then implement in the order the split says.

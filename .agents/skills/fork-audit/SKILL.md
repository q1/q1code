---
name: fork-audit
description: Compare upstream commits since the last audit against the q1code feature registry and report what upstream now provides, what upstream changed near a seam, and which new upstream extension points would shrink a seam. Use after a sync, on a weekly cadence, or before planning fork work, to keep the series small and catch semantic conflicts a clean rebase hides.
---

# Fork Audit

Read `fork/FORK.md` and `fork/FEATURES.md` first. A rebase that applies cleanly can still be wrong: upstream may have renamed the function a seam calls, reimplemented a fork feature, or added the hook a seam was faking. This skill finds those.

## 1. Find the range

The last audit is the newest file in `fork/docs/audits/` (its first line records the upstream SHA it ended at) or, if none, the upstream SHA in the newest `fork/docs/sync-log/*.md`. The range is `<that sha>..main`. If it is empty, say so and stop.

```
git log --oneline --no-merges <last>..main
git diff --stat <last>..main
```

## 2. Per feature, three questions

Walk every `active`, `paused`, and `planned` entry in `fork/FEATURES.md`.

**(a) Does upstream now provide it?** Search the range for commits whose title, touched paths, or contract changes overlap the feature's purpose (settings keys, capabilities fields, provider drivers, workflow files, docs under `docs/user/`). If upstream shipped the same behavior, propose `upstreamed` (drop the fork commits at the next sync) or a narrowing of the feature to what upstream still lacks. If upstream shipped something that makes the feature pointless, propose `dropped`.

**(b) Did upstream change near a seam?** For each seam file in the entry (and in `fork/SEAMS.md`), check whether the range touches it:

```
git log --oneline <last>..main -- <seam file>
git diff <last>..main -- <seam file>
```

Any hit is a semantic conflict risk even when the rebase was clean. Read the hunk against the seam's 3 lines: is the callee still there, same signature, same call order, same guard? Then run that feature's tests as listed in its entry, plus a flags-off parity check for the seam. Report pass or fail with the exact test command.

**(c) New extension points?** Scan the range for additions that a seam could use instead of a hand-placed hook: new optional keys on `ExecutionEnvironmentCapabilities`, new registries or arrays (drivers, settings search items, commands, routes), new slot components, new per-instance settings, new env passthroughs, new `docs/internals/` pages describing an extension mechanism. For each, name the seam it would shrink or delete and whether the change is a fork edit or an upstream candidate.

## 3. Also check

- Upstream workflows added in the range (`.github/workflows/`): confirm they are disabled on q1/q1code (`gh workflow list -R q1/q1code`).
- Upstream changes to `AGENTS.md`, `CONTRIBUTING.md`, `.agents/skills/`: anything that changes how the fork skills should behave.
- Version or packaging changes (`apps/server/package.json`, `pinnedRuntime.ts`, release workflow) that affect the `base` update seams.
- `Upstream: pr:<n>` commits in the series: check PR state with `gh pr view <n> -R pingdotgg/t3code`. Merged means note the SHA for the next sync; closed means decide `no` or retry.

## 4. Output

If an open sync PR exists for this range, append the audit as a comment there. Otherwise write `fork/docs/audits/<utc-stamp>.md` (first line: `Upstream: <end sha>`), commit it on `fork` or the open feature branch with `Fork-Feature: base`, `Upstream: no`.

Format: one section per feature with findings under (a), (b), (c); a final "Proposed changes" list with concrete edits to `fork/FEATURES.md` (status changes, seam list updates) and any follow-up work (a `fork-feature` change, a `fork-upstream-pr` candidate, a test to add). Do not apply status changes yourself unless asked; the sync that drops commits does that.

Keep findings specific: file, line, upstream commit SHA, what breaks or what improves. "Upstream touched ChatView" is not a finding.

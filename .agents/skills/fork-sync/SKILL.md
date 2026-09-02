---
name: fork-sync
description: Rebase the q1code `fork` series onto a freshly fast-forwarded upstream `main` under fixed conflict rules, run the seam, leak, typecheck, and targeted test gates, classify the result with range-diff, then either promote deterministically or open the single sync PR and write the sync-log entry. Use when upstream has moved, when the sync timer or watch workflow reports drift or a conflict, or when a human asks to bring the fork up to date.
---

# Fork Sync

Read `fork/FORK.md` first. This skill implements its Sync section. The deterministic parts are also in `scripts/fork/sync.sh`; run that when possible and step in by hand only where it stops.

Work in a clean checkout with `origin` = q1/q1code and `upstream` = pingdotgg/t3code, `rerere.enabled`, `rerere.autoupdate`, and `rebase.updateRefs` on. Never run this against a checkout that a running q1code serves.

## 1. Fetch and fast-forward

```
git fetch upstream --tags
git switch main
git merge --ff-only upstream/main
git push origin main
```

If `main` cannot fast-forward, stop. Someone committed on `main`. Report it; do not force anything.

## 2. Snapshot

```
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
git tag snap/$STAMP fork
git push origin snap/$STAMP
```

The tag is the rollback point. `scripts/fork/rollback.sh snap/$STAMP` restores `fork` with one force-push.

## 3. Rebase on a throwaway branch

```
git switch -c sync/$STAMP fork
git rebase --rerere-autoupdate --update-refs main sync/$STAMP
```

Record whether the rebase was clean, rerere-replayed, or needed hand resolution. This decides step 7.

## 4. Conflict rules

Apply in order. Never resolve a whole file with `--ours` or `--theirs`.

1. **Upstream wins in upstream files.** Take upstream's version of the hunk unless doing so deletes a seam.
2. **Re-apply seams minimally.** If upstream rewrote the lines around a seam, put the seam back as at most 3 lines with its `// fork: <slug>` marker at the nearest equivalent point. If the extension point moved, move the seam; if it disappeared, stop and report under "needs human eyes".
3. **Drop absorbed commits.** If a fork commit's change now exists upstream (same patch or upstream's reviewed version of it), `git rebase --skip` it. Note the fork commit and the upstream SHA. For `Upstream: pr:<n>` commits whose PR merged, this is expected; set the feature to `upstreamed` in `fork/FEATURES.md` if no commits remain for it, otherwise update the trailer to `merged:<sha>`.
4. **Fork-owned files never conflict with upstream.** If one does, an upstream file was mislabeled; treat it as an upstream file.
5. When unsure, prefer the resolution that keeps `main..sync/$STAMP` smaller.

After each resolution: `git add` the files, `git rebase --continue`. Commit messages and trailers stay as they were; do not reword during a sync.

## 5. Gates

```
node scripts/fork/seams.ts
node scripts/fork/leak-check.ts
```

Then typecheck and run tests for the packages the rebase touched (files changed in `main..sync/$STAMP` plus files upstream changed in the range that sit next to a seam). Use `vp test run <files>` and package-scoped typecheck. Do not run repo-wide checks.

Fix a failing gate by editing the offending fork commit in place: `git commit --fixup <sha>` then `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash main` (interactive rebase is not available to agents, so the sequence editor is bypassed). A fix here counts as hand resolution for step 7.

## 6. Classify

```
node scripts/fork/range-diff-classify.ts snap/$STAMP sync/$STAMP main
```

It wraps `git range-diff main@{1}..snap/$STAMP main..sync/$STAMP` and reports `clean` (only context and offset changes), `content` (any `!` line), or `dropped` (commit count changed). It also lists seam files upstream touched in the range.

## 7. Promote or PR

Push the branch first: `git push origin sync/$STAMP`. `fork-ci.yml` runs on it.

Promote with `scripts/fork/promote.sh sync/$STAMP` only when every one of these holds:

- the rebase was clean or fully rerere-replayed with no hand edits,
- classification is `clean`,
- no seam file was touched by upstream in the range,
- `fork-ci.yml` is green on the pushed branch.

Otherwise open or update the single sync PR `sync/$STAMP` into `fork` on q1/q1code with `gh pr create` (or `gh pr edit` if one is open; close older sync PRs). Body = the sync report: upstream range, dropped commits, conflicts and resolutions, seam files upstream touched, range-diff excerpt, anything needing human eyes. A human promotes by label or approval; the next run executes it.

**The agent never promotes when it resolved conflicts by hand or edited any commit during the gates.** Promotion is for the deterministic path only, no matter how confident the resolution looks.

## 8. Log

Write `fork/docs/sync-log/$STAMP.md` per `fork/docs/sync-log/README.md`. Commit it on `sync/$STAMP` as the last commit (`Fork-Feature: base`, `Upstream: no`) before pushing, so it lands with the promotion or the PR.

## 9. Workflows

```
gh workflow list -R q1/q1code --json name,path,state
```

Disable every enabled workflow whose file does not start with `fork-`: `gh workflow disable -R q1/q1code <path>`. Upstream adds workflows often and each new one starts enabled on the fork. Never delete a workflow file.

## Failure

On any stop condition: leave `sync/$STAMP` pushed, leave the conflict list in the PR body or the report, exit non-zero. Do not touch `fork`. The `snap/` tag stays until the next successful promotion.

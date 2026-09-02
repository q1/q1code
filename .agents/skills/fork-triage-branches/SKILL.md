---
name: fork-triage-branches
description: One-off triage of the legacy fork-only branches on q1/q1code: for each branch report whether it rebases cleanly onto main, whether it is still relevant, and whether its work is an upstream candidate, a fork feature, or a drop; then archive every branch as an `archive/<name>` tag and delete it, ending with a summary table. Use once to clear the pre-fork branches, or again for any stray branch that is not main, fork, up/, sync/, or a series ref.
---

# Fork Triage Branches

Read `fork/FORK.md` first. Nothing is lost: every branch becomes a tag before deletion, so the branch list can be empty without any history disappearing.

The branches to triage are given by the caller. If none are given, use every remote branch that is not `main`, `fork`, `fork/*`, `up/*`, `sync/*`, or `fork-rerere`.

## 1. Facts per branch

```
git fetch origin --prune && git fetch upstream
for b in <branches>; do
  echo "== $b"
  git rev-list --left-right --count origin/$b...main
  git log --oneline main..origin/$b
  git diff --stat main...origin/$b | tail -1
done
```

Record ahead, behind, commit list, files changed, and the merge base date.

## 2. Rebase test

On a throwaway worktree so the main checkout is never disturbed:

```
git worktree add /tmp/triage-<name> origin/<branch>
git -C /tmp/triage-<name> rebase main
```

Record: clean, conflicts (list the files), or already empty (every commit is upstream now; `git rebase` drops them). Abort and remove the worktree afterwards (`git rebase --abort`, `git worktree remove --force`). Do not resolve conflicts here; the question is only whether they exist.

## 3. Relevance

For each branch answer, with evidence:

- **Does upstream already have it?** Search `main` for the same fix or feature (`git log --oneline -S<distinctive string> main`, or the docs page it would have produced). A merged upstream PR from this branch (for example #9078 from `feat/claude-fable-5-1`) means the remaining commits are the only live part.
- **Is the code it touches still there?** A branch that patches a file upstream deleted or rewrote is stale regardless of its idea.
- **Is the idea still wanted?** Check the spec's note for the branch if one exists, and whether a `fork/FEATURES.md` entry covers it.

## 4. Classification

One of:

- **upstream candidate**: small, generic, still applies. Next step is `fork-upstream-pr` from a fresh `up/` branch (re-implement on `main` if the rebase was not clean; do not fight an old branch into shape).
- **fork feature**: wanted, not upstream-shaped. Next step is `fork-feature` with a new slug; the old branch is reference material, not a base.
- **split**: part candidate, part fork. Say which commits go where.
- **drop**: stale, absorbed, or not wanted. The tag keeps it findable.

Say what a re-implementation would cost (files, rough size) for anything not `drop`.

## 5. Archive and delete

Only after the report is written and the caller has seen it, unless told to proceed without review:

```
git tag archive/<name> origin/<branch>
git push origin archive/<name>
git push origin --delete <branch>
```

`archive/<name>` uses the branch name with `/` kept (`archive/t3code/fix-mobile-thread-scrolling`). Confirm each tag resolves to the same SHA the branch had before deleting. Close any open PR from the branch on q1/q1code with a comment pointing at the tag.

## 6. Summary table

End with one table:

| branch | ahead/behind | rebase | relevant | class | next step | tag |
| ------ | ------------ | ------ | -------- | ----- | --------- | --- |

followed by the per-branch reports. If the caller wants it durable, write it to `fork/docs/audits/<utc-stamp>-triage.md` and commit with `Fork-Feature: base`, `Upstream: no`. Any `upstream candidate` or `fork feature` rows become follow-up items for the respective skill; do not start that work inside this one.

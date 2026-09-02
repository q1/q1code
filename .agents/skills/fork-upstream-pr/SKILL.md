---
name: fork-upstream-pr
description: Extract upstream-candidate commits from the q1code fork series onto an up/<topic> branch cut from main, scrub every fork trace, verify the branch builds without fork code, write the PR in upstream's voice with evidence from the up/ build, and open it against pingdotgg/t3code. Use when a fork commit is marked Upstream: candidate, when a bug fix found during fork work belongs upstream, or when a maintainer asks to contribute something back.
---

# Fork Upstream PR

Read `fork/FORK.md` (Upstream PRs without leaks) and upstream's `CONTRIBUTING.md` first. Precedent: pingdotgg/t3code#9078, one JSON object in `model-manifest.json`, from `q1:feat/claude-fable-5-1`. That is the size and shape that gets merged.

## What upstream accepts

From `CONTRIBUTING.md`: contributions are not actively accepted. Most likely merged: small focused bug fixes, small reliability fixes, small performance improvements, tightly scoped maintenance. Least likely: large PRs, drive-by features, rewrites, scope expansion. Non-trivial changes get an Ideas discussion first (`https://github.com/pingdotgg/t3code/discussions/categories/ideas`), not an issue and not a surprise PR. PRs are auto-labeled `size:*` and `vouch:*`; q1 is unvouched. One concern per PR. UI changes need before/after images; motion needs a short video.

If the candidate is not small, stop and propose a discussion post instead.

## 1. Select commits

By trailer:

```
git log --format='%h %s' main..fork --grep='^Fork-Feature: <slug>' --grep='^Upstream: candidate' --all-match
```

or by explicit SHAs. Every selected commit must already be `Upstream: candidate`; a `no` commit is never extracted, it is rewritten as a candidate first on `fork`.

## 2. Cut the branch from main

```
git fetch upstream --tags
git switch main && git merge --ff-only upstream/main && git push origin main
git switch -c up/<topic> main
git cherry-pick -x <sha>...
```

Never branch from `fork`. If a cherry-pick conflicts, the commit depends on fork-only code or on an earlier candidate you did not select; fix the selection or the commit on `fork`, do not patch it here.

## 3. Scrub

Strip trailers from every commit on the branch (`Fork-Feature:`, `Upstream:`, `Fork-Seam-Debt:`), keeping the conventional title and body:

```
git filter-branch --msg-filter 'sed -E "/^(Fork-[A-Za-z-]+|Upstream):/d"' main..HEAD
```

Then:

```
node scripts/fork/leak-check.ts main..HEAD
```

It greps the diff and the messages for `@q1code/`, `/fork/`, `T3FORK_`, `// fork:`, flag keys from the registry, `q1`, `q1code`, and fails on any hit. Fix the commit on `fork` and restart from step 2; do not hand-edit the `up/` branch into shape.

## 4. Verify without fork code

On `up/<topic>` (which has no fork code at all): package-scoped typecheck for the touched packages, `vp test run <touched test files>`, and a build of the touched app when the change is not test-only. Nothing repo-wide.

## 5. PR body

Written from the commits only, in upstream's voice, following their PR conventions from `AGENTS.md`: the problem in a sentence or two, then how it was fixed, then a final line naming the model and harness that did the work. Conventional commit title, plain language, e.g. `fix(web): copying a code block no longer copies backticks`.

Forbidden words anywhere in title, body, commit messages, or screenshots: **fork, downstream, q1code, q1**. Do not mention where the change was found or which product it ships in.

UI evidence is captured from the `up/<topic>` build (`test-t3-app` or `test-t3-mobile` on that branch), never from a fork build, so no fork UI leaks into a screenshot. Upload evidence to GitHub; never commit it.

## 6. Open

```
git push origin up/<topic>
gh pr create -R pingdotgg/t3code --head q1:up/<topic> --title "<title>" --body-file <body>
```

Note the PR number.

## 7. Record on the fork

At the next rebase (or now, with `git commit --amend` on the relevant series commits followed by a normal `fork-sync`), set `Upstream: pr:<n>` on each extracted fork commit and add the PR link to the feature's entry in `fork/FEATURES.md`. When the PR merges, the next `fork-sync` drops the fork commits and sets `merged:<sha>` or `upstreamed`.

## 8. Babysit

Per `AGENTS.md`: poll checks and comments newer than the last push, verify each bot finding against the source, fix real ones by amending on `up/<topic>` (then mirror the fix onto the `fork` commit), dismiss false positives with a reason, stay quiet when nothing is new. Replies follow the same forbidden-word rule as the body.

#!/usr/bin/env bash
# Deterministic sync tier (SPEC section E). Fast-forwards `main` to upstream,
# snapshots `fork`, rebases it onto `main` on a throwaway `sync/<stamp>` branch,
# gates the result, and pushes the branch for fork-ci. Never promotes.
#
#   Q1CODE_SYNC_REPO    checkout to operate on (default: cwd)
#   Q1CODE_SYNC_STATE   lock and last-sync/last-conflict JSON
#                       (default: ~/.local/state/q1code-sync)
#
# Exit codes: 0 done, JSON summary on stdout (gate may still be "fail");
#             3 rebase conflict, details in $Q1CODE_SYNC_STATE/last-conflict.json;
#             4 another sync holds the lock; 5 precondition failed.
set -euo pipefail

repo="${Q1CODE_SYNC_REPO:-$PWD}"
state="${Q1CODE_SYNC_STATE:-$HOME/.local/state/q1code-sync}"
upstream="${Q1CODE_UPSTREAM_REMOTE:-upstream}"
origin="${Q1CODE_ORIGIN_REMOTE:-origin}"

die() {
  echo "sync: $1" >&2
  exit "${2:-5}"
}

mkdir -p "$state"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$state/lock"
  flock -n 9 || die "another sync holds $state/lock" 4
else
  # macOS ships no flock; a mkdir lock is atomic enough for one operator.
  mkdir "$state/lock.d" 2>/dev/null || die "another sync holds $state/lock.d" 4
  trap 'rmdir "$state/lock.d"' EXIT
fi

cd "$repo"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git checkout: $repo"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "working tree has uncommitted changes"
git remote get-url "$upstream" >/dev/null 2>&1 || die "missing remote '$upstream'"
git rev-parse --verify -q refs/heads/main >/dev/null || git branch main "$upstream/main" >/dev/null 2>&1 || git branch main origin/main >/dev/null 2>&1 || die "no local branch 'main' and nothing to create it from"
git rev-parse --verify -q refs/heads/fork >/dev/null || die "no local branch 'fork'"
command -v node >/dev/null 2>&1 || die "node is required"

git fetch -q "$origin" main fork
git fetch -q "$upstream" main
# Detached HEAD lets `git branch -f` move main and fork whatever was checked out.
git checkout -q --detach

git merge-base --is-ancestor fork "$origin/fork" \
  || die "local 'fork' has commits that '$origin/fork' lacks; push or reset it first"
git branch -f fork "$origin/fork"
git merge-base --is-ancestor main "$upstream/main" \
  || die "'main' is not an ancestor of '$upstream/main'; main must stay a pure mirror"
git branch -f main "$upstream/main"
git push -q "$origin" main:main

new_main="$(git rev-parse main)"
fork_before="$(git rev-parse fork)"
# The series base is the upstream commit fork sits on. Taking it against the
# fast-forwarded main is exact even when fork was last synced elsewhere.
old_base="$(git merge-base fork main)"

write_json() {
  # shellcheck disable=SC2016
  node -e '
    const [target] = process.argv.slice(1);
    const env = process.env;
    const list = (value) => (value ?? "").split("\n").filter((line) => line !== "");
    const summary = {
      stamp: env.S_STAMP || null,
      noop: env.S_NOOP === "1",
      upstreamRange: `${env.S_OLD_BASE}..${env.S_NEW_MAIN}`,
      forkBefore: env.S_FORK_BEFORE,
      snapTag: env.S_STAMP ? `snap/${env.S_STAMP}` : null,
      syncBranch: env.S_STAMP ? `sync/${env.S_STAMP}` : null,
      syncTip: env.S_NEW_TIP || null,
      gate: env.S_GATE,
      reasons: list(env.S_REASONS),
      rerereResolved: list(env.S_RERERE),
      seamsTouchedUpstream: list(env.S_OVERLAP),
      rangeDiff: env.S_RANGE_DIFF ? JSON.parse(env.S_RANGE_DIFF) : null,
    };
    const text = JSON.stringify(summary, null, 2) + "\n";
    require("node:fs").writeFileSync(target, text);
    process.stdout.write(text);
  ' "$1"
}

if [[ "$old_base" == "$new_main" ]]; then
  S_STAMP="" S_NOOP=1 S_OLD_BASE="$old_base" S_NEW_MAIN="$new_main" S_FORK_BEFORE="$fork_before" \
    S_NEW_TIP="" S_GATE=pass S_REASONS="fork already sits on $upstream/main" S_RERERE="" S_OVERLAP="" S_RANGE_DIFF="" \
    write_json "$state/last-sync.json"
  git checkout -q fork
  exit 0
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
git tag "snap/$stamp" fork
git push -q "$origin" "refs/tags/snap/$stamp"
git checkout -q -B "sync/$stamp" fork

rerere_resolved=""
rebase_ok=0
if git -c rerere.enabled=true -c rerere.autoupdate=true rebase --rerere-autoupdate --update-refs main; then
  rebase_ok=1
else
  # rerere stages a remembered resolution but still stops; continue while every
  # conflict was resolved that way. A commit it fixed can never auto-promote.
  while [[ -d "$(git rev-parse --git-path rebase-merge)" ]]; do
    [[ -z "$(git diff --name-only --diff-filter=U)" ]] || break
    rerere_resolved+="$(git rev-parse REBASE_HEAD)"$'\n'
    if GIT_EDITOR=true git -c rerere.enabled=true -c rerere.autoupdate=true rebase --continue; then
      rebase_ok=1
      break
    fi
  done
fi

if [[ "$rebase_ok" != 1 ]]; then
  conflict_files="$(git diff --name-only --diff-filter=U)"
  stopped_at="$(git rev-parse -q --verify REBASE_HEAD || true)"
  git rebase --abort
  # shellcheck disable=SC2016
  C_STAMP="$stamp" C_OLD_BASE="$old_base" C_NEW_MAIN="$new_main" C_FORK_BEFORE="$fork_before" \
    C_STOPPED="$stopped_at" C_FILES="$conflict_files" node -e '
    const env = process.env;
    const report = {
      stamp: env.C_STAMP,
      upstreamRange: `${env.C_OLD_BASE}..${env.C_NEW_MAIN}`,
      forkBefore: env.C_FORK_BEFORE,
      snapTag: `snap/${env.C_STAMP}`,
      syncBranch: `sync/${env.C_STAMP}`,
      stoppedAt: env.C_STOPPED || null,
      files: (env.C_FILES ?? "").split("\n").filter((line) => line !== ""),
    };
    const text = JSON.stringify(report, null, 2) + "\n";
    require("node:fs").writeFileSync(process.argv[1], text);
    process.stderr.write(text);
  ' "$state/last-conflict.json"
  echo "sync: rebase conflicted; sync/$stamp is checked out at fork for the agent tier" >&2
  exit 3
fi

new_tip="$(git rev-parse HEAD)"
# --update-refs also moved `fork` (it points at the series tip). The sync
# branch is the only thing that may advance here; fork moves on promote.
git branch -f fork "$fork_before"
reasons=""
gate=pass

range_diff="$(node scripts/fork/range-diff-classify.ts "$old_base" "snap/$stamp" main "sync/$stamp")" \
  || { gate=fail; reasons+="range-diff has content changes, dropped, or added commits"$'\n'; }
if [[ -n "$rerere_resolved" ]]; then
  gate=fail
  reasons+="rerere resolved conflicts in: $(echo "$rerere_resolved" | tr '\n' ' ')"$'\n'
fi
node scripts/fork/seams.ts --check --no-write --base main --head "sync/$stamp" \
  || { gate=fail; reasons+="seams --check failed"$'\n'; }
overlap="$(comm -12 \
  <(git diff --name-only "main...sync/$stamp" | sort) \
  <(git diff --name-only "$old_base" main | sort))"
if [[ -n "$overlap" ]]; then
  gate=fail
  reasons+="upstream touched seam files in this range"$'\n'
fi

git push -q -u "$origin" "sync/$stamp"

S_STAMP="$stamp" S_NOOP=0 S_OLD_BASE="$old_base" S_NEW_MAIN="$new_main" S_FORK_BEFORE="$fork_before" \
  S_NEW_TIP="$new_tip" S_GATE="$gate" S_REASONS="$reasons" S_RERERE="$rerere_resolved" S_OVERLAP="$overlap" \
  S_RANGE_DIFF="$range_diff" write_json "$state/last-sync.json"

#!/usr/bin/env bash
# Promotes a gated sync branch to `fork`: scripts/fork/promote.sh <stamp>
#
# Requires `sync/<stamp>` on origin with a green Fork CI run on its tip, then
# force-pushes it over `fork` with a lease on the current `fork` sha and writes
# a sync-log skeleton (not committed) if none exists.
set -euo pipefail
# Pin gh to the fork even when the clone also has an `upstream` remote.
export GH_REPO="${Q1CODE_GH_REPO:-q1/q1code}"

stamp="${1:-}"
[[ -n "$stamp" ]] || { echo "usage: scripts/fork/promote.sh <stamp>" >&2; exit 64; }
origin="${Q1CODE_ORIGIN_REMOTE:-origin}"
branch="sync/$stamp"
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

die() {
  echo "promote: $1" >&2
  exit "${2:-1}"
}

command -v gh >/dev/null 2>&1 || die "gh is required"
git fetch -q "$origin" fork "refs/heads/$branch:refs/remotes/$origin/$branch" \
  || die "$branch does not exist on $origin"
sha="$(git rev-parse "refs/remotes/$origin/$branch")"
expected="$(git rev-parse "refs/remotes/$origin/fork")"
main_sha="$(git rev-parse "refs/remotes/$origin/main" 2>/dev/null || git rev-parse main)"

if [[ "$sha" == "$expected" ]]; then
  echo "promote: fork already points at $branch ($sha)"
  exit 0
fi

ci="$(gh run list --branch "$branch" --json conclusion,status,workflowName,headSha --limit 30 \
  --jq "[.[] | select(.workflowName == \"Fork CI\" and .headSha == \"$sha\")] | first // empty")"
[[ -n "$ci" ]] || die "no Fork CI run found for $branch at $sha" 2
status="$(printf '%s' "$ci" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).status')"
conclusion="$(printf '%s' "$ci" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).conclusion')"
[[ "$status" == "completed" ]] || die "Fork CI on $branch is still $status" 2
[[ "$conclusion" == "success" ]] || die "Fork CI on $branch concluded $conclusion" 2

git push --force-with-lease="refs/heads/fork:$expected" "$origin" "$sha:refs/heads/fork"
echo "promote: fork $expected -> $sha"

if [[ "$(git rev-parse --abbrev-ref HEAD)" == "fork" ]]; then
  [[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "fork is checked out with local changes; update it by hand"
  git reset -q --hard "$sha"
else
  git branch -f fork "$sha"
fi

log="fork/docs/sync-log/$stamp.md"
if [[ ! -e "$log" ]]; then
  mkdir -p "$(dirname "$log")"
  cat > "$log" <<MD
# Sync $stamp

- Promoted: \`$sha\` (\`sync/$stamp\`)
- Previous fork: \`$expected\` (tag \`snap/$stamp\`)
- Upstream main: \`$main_sha\`

## Upstream range

## Commits dropped (absorbed upstream)

## Conflicts

## Seam files upstream touched

## Needs human eyes
MD
  echo "promote: wrote $log skeleton"
fi

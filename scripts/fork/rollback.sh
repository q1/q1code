#!/usr/bin/env bash
# Rolls `fork` back to a snapshot: scripts/fork/rollback.sh <snap-tag>
#
# Every promotion is preceded by a `snap/<stamp>` tag; this force-pushes `fork`
# back to it with a lease on the current `fork` sha.
set -euo pipefail

tag="${1:-}"
[[ -n "$tag" ]] || { echo "usage: scripts/fork/rollback.sh <snap-tag>" >&2; exit 64; }
[[ "$tag" == snap/* ]] || tag="snap/$tag"
origin="${Q1CODE_ORIGIN_REMOTE:-origin}"
cd "$(git rev-parse --show-toplevel)"

die() {
  echo "rollback: $1" >&2
  exit 1
}

git fetch -q "$origin" fork
git rev-parse -q --verify "refs/tags/$tag^{commit}" >/dev/null \
  || git fetch -q "$origin" "refs/tags/$tag:refs/tags/$tag" \
  || die "tag $tag not found locally or on $origin"
sha="$(git rev-parse "refs/tags/$tag^{commit}")"
expected="$(git rev-parse "refs/remotes/$origin/fork")"

if [[ "$sha" == "$expected" ]]; then
  echo "rollback: fork already points at $tag ($sha)"
  exit 0
fi

git push --force-with-lease="refs/heads/fork:$expected" "$origin" "$sha:refs/heads/fork"
echo "rollback: fork $expected -> $sha ($tag)"

if [[ "$(git rev-parse --abbrev-ref HEAD)" == "fork" ]]; then
  [[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "fork is checked out with local changes; update it by hand"
  git reset -q --hard "$sha"
else
  git branch -f fork "$sha"
fi

#!/bin/sh
# q1code installer, published with every release.
#
#   curl -fsSL https://github.com/q1/q1code/releases/download/v<version>/install.sh | sh -s -- <version>
#
# Downloads q1code-<version>.tgz and checksums.txt from the release, verifies
# the sha256, and installs the tarball into the launcher layout
# ($Q1CODE_HOME/runtime/versions/<version>). Never uses sudo. Fails closed.
set -eu

usage() {
  echo "usage: install.sh <version>" >&2
  exit 64
}

fail() {
  echo "install.sh: $*" >&2
  exit 1
}

[ "$#" -eq 1 ] || usage
version="${1#v}"
case "$version" in
  "" | -*) usage ;;
esac
echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' \
  || fail "not an exact release version: $version"

repo="${Q1CODE_RELEASE_REPO:-q1/q1code}"
# Release assets are named after the product; the npm package inside stays `t3`.
asset_prefix="${Q1CODE_ASSET_PREFIX:-q1code}"
package="${Q1CODE_PACKAGE:-t3}"
home="${Q1CODE_HOME:-$HOME/.q1code}"
base_url="${Q1CODE_RELEASE_BASE_URL:-https://github.com/$repo/releases/download/v$version}"
tarball="$asset_prefix-$version.tgz"
prefix="$home/runtime/versions/$version"
entry="$prefix/node_modules/$package/dist/bin.mjs"

for tool in curl npm node; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"
done

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    fail "sha256sum or shasum is required"
  fi
}

work="$(mktemp -d "${TMPDIR:-/tmp}/q1code-install.XXXXXX")"
trap 'rm -rf "$work"' EXIT INT TERM
cd "$work"

echo "Downloading $tarball from $base_url"
curl -fsSL --retry 3 -o "$tarball" "$base_url/$tarball" || fail "download failed: $base_url/$tarball"
curl -fsSL --retry 3 -o checksums.txt "$base_url/checksums.txt" || fail "download failed: $base_url/checksums.txt"

expected="$(grep -E "^[0-9a-f]{64}[ *]+$tarball\$" checksums.txt | head -n 1 | cut -d' ' -f1)"
[ -n "$expected" ] || fail "$tarball is not listed in checksums.txt"
actual="$(sha256_of "$tarball")"
[ "$actual" = "$expected" ] || fail "sha256 mismatch for $tarball: expected $expected, got $actual"
echo "Verified sha256 $actual"

if [ -e "$entry" ]; then
  echo "$version is already installed at $prefix"
else
  # Install into a staging dir and move it into place so a failed install never
  # leaves a half-populated version directory behind.
  staging="$prefix.installing.$$"
  rm -rf "$staging"
  mkdir -p "$staging" "$(dirname "$prefix")"
  npm install --prefix "$staging" --no-fund --no-audit "./$tarball" \
    || { rm -rf "$staging"; fail "npm install failed"; }
  [ -e "$staging/node_modules/$package/dist/bin.mjs" ] \
    || { rm -rf "$staging"; fail "tarball did not provide node_modules/$package/dist/bin.mjs"; }
  printf '%s\n' "$version" > "$staging/.install-complete"
  mv "$staging" "$prefix"
  echo "Installed $package $version to $prefix"
fi

next="service install"
for other in "$home"/runtime/versions/*/; do
  [ -d "$other" ] || continue
  [ "$other" = "$prefix/" ] && continue
  next="service update"
done
echo
echo "Next step:"
echo "  node \"$entry\" $next"

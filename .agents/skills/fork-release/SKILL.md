---
name: fork-release
description: Cut a q1code release: pick the version from the upstream tag the fork sits on, tag `fork-v<upstreamVersion>-q1.<n>`, trigger `fork-release.yml`, verify the published artifacts (server tarball, web bundle, checksums.txt, install.sh), and hand off to the private deploy step. Use when `fork` is green and a new build should reach Mic's machines, or when a rollback needs the previous release located.
---

# Fork Release

Read `fork/FORK.md` first. Releases are GitHub Releases on q1/q1code only; there is no npm publish and no desktop build. The desktop updater feed and the server's pinned-runtime installer both read from these releases (`T3CODE_DESKTOP_UPDATE_REPOSITORY=q1/q1code`, `pinnedRuntime.ts` seam under `base`).

Deploying is not part of this skill and never happens from a sync or release job. Mic triggers deploys from the private repo.

## 1. Pick the commit

Release from `fork` only, at a commit where `fork-ci.yml` is green:

```
git fetch origin --tags
git switch fork && git pull --ff-only
gh run list -R q1/q1code --workflow fork-ci.yml --branch fork --limit 1
```

Do not release from a `sync/` branch or with an open sync PR unresolved unless the release is explicitly meant to skip that sync.

## 2. Compute the version

`<upstreamVersion>` is the version in `apps/server/package.json` on `main` at the merge base (`git merge-base main fork`), which upstream's nightly tagging keeps current, e.g. `0.0.39-nightly.20260902.1253`. `<n>` starts at 1 per upstream version and increments for each fork release on the same upstream version:

```
git tag -l "fork-v<upstreamVersion>-q1.*" | sort -V | tail -1
```

Tag: `fork-v<upstreamVersion>-q1.<n>`. The release workflow derives the package version and the About label ("q1code <version> on T3 Code <upstream version>") from it.

## 3. Tag and push

```
git tag -a fork-v<upstreamVersion>-q1.<n> -m "q1code <upstreamVersion>-q1.<n>"
git push origin fork-v<upstreamVersion>-q1.<n>
```

The tag push triggers `.github/workflows/fork-release.yml`. If it does not (workflow disabled, or push filter mismatch), `gh workflow run fork-release.yml -R q1/q1code -f tag=<tag>` and fix the trigger afterwards.

## 4. Watch

```
gh run watch -R q1/q1code $(gh run list -R q1/q1code --workflow fork-release.yml --limit 1 --json databaseId -q '.[0].databaseId')
```

On failure, read the log, fix on `fork`, delete the tag locally and remotely, and start over at step 1. Never move a tag that a release already exists for.

## 5. Verify artifacts

```
gh release view <tag> -R q1/q1code --json assets -q '.assets[].name'
```

Required assets:

- `q1code-<version>.tgz`: server plus bundled web. Download it; `tar tzf` shows `package/dist/bin.mjs` and the web bundle under `package/dist/`. `npm pack`-style layout so `npm install <url>` works in the pinned-runtime installer.
- `checksums.txt`: SHA-256 for every other asset. Verify the tarball against it; this is the integrity check `pinnedRuntime.ts` performs, since GitHub releases carry no registry integrity field.
- `install.sh`: the manual install path (`curl -fsSL <asset url> | sh`). Run it with `sh -n` for syntax, and read it: it must install the tarball into the launcher layout under `~/.q1code/runtime/versions/<version>` and nothing else.
- Web bundle archive, if the workflow publishes it separately from the tarball.
- When the `cliproxy` feature ships: the CLIProxyAPI sidecar bundle per platform, checksummed.

Confirm the release notes name the upstream tag and SHA the build sits on. Confirm the release is not marked pre-release unless the tag is a nightly-style build.

## 6. Smoke

On a disposable base directory, run the install path end to end: `sh install.sh` into a temp `HOME`, start the server with `--home-dir <temp>`, check the About label reports the expected q1code and upstream versions, stop it by the PID you captured. Do not point it at `~/.q1code` or `~/.t3`.

## 7. Hand off

Report: tag, release URL, asset list with sizes and checksums, upstream version and SHA, and what changed since the previous `fork-v` tag (`git log --oneline <prev>..<tag>` grouped by `Fork-Feature`). The deploy step lives in the private repo (`services/q1code`, pin in `UPSTREAM.json`, `manage.sh`) and is Mic's call; do not run it, do not restart anything.

## Rollback

A release is never deleted. To roll a machine back, the deploy step pins the previous tag. To fix a bad release, cut `q1.<n+1>`.

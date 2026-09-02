# Feature registry

Every `Fork-Feature: <slug>` trailer in the series points at an entry here. `fork-feature` scaffolds entries; `fork-audit` and `fork-sync` update status.

Fields per entry:

- **status**: `active` (in the series and on), `planned` (entry exists, no code yet), `paused` (code in the series, flag stays off, not maintained through conflicts), `upstreamed` (upstream ships it; fork commits dropped), `dropped` (removed; kept here so the slug stays reserved).
- **purpose**: one line.
- **flags**: keys in `packages/fork-core/src/flags.ts`. `base` has none of its own.
- **owned dirs**: fork-owned locations the feature may create files in.
- **seams**: upstream files touched, each with a `// fork: <slug>` marker. Must agree with `fork/SEAMS.md`.
- **tests**: what proves it works and what proves flags-off parity.
- **upstream**: candidate commits, PR links, merged SHAs.
- **removal condition**: when this entry becomes `upstreamed` or `dropped`.

---

## base

- **status**: active
- **purpose**: everything q1code needs to exist as a fork: flags, brand, home dir, GitHub-only updates, CI, skills.
- **flags**: none. Owns the registry.
- **owned dirs**: `packages/fork-core/`, `apps/server/src/fork/ForkFlags.ts`, `packages/client-runtime` fork flag hook, `apps/web/src/fork/settings/`, `apps/mobile/src/fork/settings/`, `.github/workflows/fork-ci.yml`, `fork-sync-watch.yml`, `fork-release.yml`, `.agents/skills/fork-*/`, `scripts/fork/`, `fork/`.
- **seams**:
  - `CLAUDE.md` (`@fork/FORK.md` line)
  - `packages/contracts/src/environment.ts` (`forkFlags` optional key on `ExecutionEnvironmentCapabilities`)
  - `apps/server/src/environment/ServerEnvironment.ts` (publish flags into capabilities)
  - `apps/server/src/os-jank.ts` (`resolveBaseDir` default `~/.q1code`)
  - `apps/server/src/cloud/pinnedRuntime.ts` (GitHub release tarball install spec, entry path `node_modules/q1code/dist/bin.mjs`, checksum verify)
  - `apps/server/src/cli/invocation.ts` (CLI name)
  - `apps/web/src/versionSkew.ts` (manual update command runs the release `install.sh`)
  - `apps/server/package.json` (name `q1code`, bin `q1code`)
  - `scripts/build-desktop-artifact.ts` (appId `sc.mic.q1code`, product name)
  - `apps/web` title and About label
  - `packages/shared/src/connectAuth.ts` (hosted app URL default from env)
  - `apps/web/src/components/settings/SettingsPanels.tsx` (one `<ForkSettingsSection />`)
  - `apps/web/src/components/settings/settingsSearch.ts` (one entry)
  - `apps/mobile/app.config.ts` (bundle id, team, applinks host; EAS owner and projectId removed) when iOS ships
- **tests**: `packages/fork-core` unit tests for flag resolution order; `apps/server/src/fork/ForkFlags.test.ts`; upstream suites run on `fork` in `fork-ci.yml` for parity; `scripts/fork/seams.ts` budget; `scripts/fork/leak-check.ts` on `up/*`.
- **upstream**: no. Generic pieces that fall out (for example a per-instance extra env var setting) get their own candidate commits under the feature that needs them.
- **removal condition**: never while the fork exists.

## update-check

- **status**: planned
- **purpose**: server polls `https://api.github.com/repos/q1/q1code/releases/latest` daily and surfaces the newest version through capabilities so the existing client update UI works with no hosted web app.
- **flags**: `update-check` (registry default off until implemented; when it lands, decide whether it becomes the one default-on flag, since without it web-mode users hear nothing about updates).
- **owned dirs**: `apps/server/src/fork/updateCheck/`.
- **seams**: none beyond `base` (rides the `forkFlags`/capabilities key; may need one optional capabilities field for the discovered version).
- **tests**: poller unit test with a fake fetch; parity test that the capabilities field is absent when the flag is off.
- **upstream**: no. Upstream's discovery is client-driven by design.
- **removal condition**: upstream adds server-side release discovery for GitHub-provider updates.

## cliproxy

- **status**: active (phase 1: sidecar lifecycle and provider wiring; Accounts UI and cross-machine sync are later phases)
- **purpose**: CLIProxyAPI (router-for-me, MIT, Go) baked into q1code as a managed sidecar so provider CLIs share one pool of accounts with load balancing and cross-machine sync.
- **summary**: `CliProxyBinary` resolves the executable (`fork.json.cliproxy.binaryPath`, then the copy bundled at `dist/cliproxy/<platform-arch>/cli-proxy-api`, then a cached or fresh download of the pinned release under `~/.q1code/cliproxy/bin/<version>/`, sha256-verified against the release `checksums.txt`; pin in `packages/fork-core/src/cliproxy.pin.json`). `CliProxyService` renders `~/.q1code/cliproxy/config.yaml` (loopback host, port from `fork.json`, `auth-dir ~/.q1code/cliproxy/auths`, one API key and one management secret from the server secret store, `allow-remote: false`, control panel, plugins, usage statistics and request logs off), spawns `cli-proxy-api -config <path>`, waits for the port and `GET /v0/management/latest-version`, supervises with capped exponential backoff, and stops when the flag turns off or the server shuts down. Sidecar output goes to the server log at debug level with both secrets redacted. Claude routes through it via the `ClaudeHome.ts` seam (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, only while the proxy is ready). Codex needs no seam: `CodexProxyHome` materializes `~/.q1code/cliproxy/codex-home/` with a `config.toml` that selects `model_providers.q1code` (Responses wire API, bearer header) and symlinks non-auth state from `~/.codex`; register a `codex` instance whose `homePath` is that directory to use it. The user's own `~/.codex/config.toml` is not merged. OpenCode, Cursor, Grok: not wired in phase 1. Config changes to the `cliproxy` section apply on the next sidecar start (flag off/on).
- **later phases**: Accounts panel in Settings (list, enable/disable, weight, delete, add via OAuth, routing strategy, usage) over fork RPCs so the management secret never leaves the box; cross-machine auth-file sync (`primary`/`replica`, encrypted payload over environment auth with a `q1:accounts` scope, then over `relay-selfhost`); provider-instance registration from the UI; proxy status through a fork RPC (capabilities stay untouched).
- **flags**: `cliproxy` (default off; nothing spawns, nothing is written under `~/.q1code/cliproxy`, and no env var is injected when off). Env override `T3FORK_CLIPROXY=1`.
- **config**: `fork.json` `cliproxy: { port?: number (default 8317), routingStrategy?: "round-robin" | "weighted-round-robin" | "fill-first", binaryPath?: string, releaseVersion?: string }`.
- **owned dirs**: `apps/server/src/fork/cliproxy/`, `packages/fork-core/src/cliproxy*`, the sidecar step in `.github/workflows/fork-release.yml`, later `apps/web/src/fork/accounts/` and `apps/mobile/src/fork/accounts/`. Runtime state under `~/.q1code/cliproxy/` (`config.yaml`, `auths/`, `bin/`, `codex-home/`) and secrets `cliproxy-api-key`, `cliproxy-management-secret` in the server secret store.
- **seams**:
  - `apps/server/src/provider/Drivers/ClaudeHome.ts` (`makeClaudeEnvironment`: one import, one call to `withCliProxyClaudeEnvironment`, identity when off)
  - `apps/server/src/environment/ServerEnvironment.ts` (one import, one `Layer.provide(CliProxy.layer)` next to the `base` flags line)
- **tests**: `packages/fork-core/src/cliproxy.test.ts` (asset naming, platform keys, URLs), `config.test.ts` (the `cliproxy` section); `apps/server/src/fork/cliproxy/CliProxyService.test.ts` (fake launcher and readiness: nothing spawns when off, start to ready, restart after exit and after a failed probe, stop on flag off and restart on flag on, endpoint published only while ready), `CliProxyBinary.test.ts` (override, bundled, download with checksum verification and extraction, cache hit, checksum mismatch leaves nothing behind, unsupported platform), `CliProxyConfig.test.ts` (YAML snapshot, atomic 0600 write), `CodexProxyHome.test.ts` (TOML snapshot, shared-state links), `CliProxyEnvironment.test.ts` (Claude seam parity: same env object when off). `fork-release.yml` verifies the three bundled binaries are in the tarball.
- **upstream**: no. Candidates that fall out: per-provider-instance extra environment variables in `ClaudeSettings`/`CodexSettings` (would delete the `ClaudeHome.ts` seam); any `homePath`/`shadowHomePath` bug.
- **removal condition**: upstream ships provider account pooling, or Mic retires the proxy.

## relay-selfhost

- **status**: planned
- **purpose**: run T3 Connect's relay (`infra/relay`: Cloudflare Worker, Postgres, Clerk, APNs) on Mic's own infrastructure so `q1code connect` works off the tailnet and the `cliproxy` sync can ride the managed-endpoint channel.
- **flags**: `relay-selfhost` (default off; `connect` self-hides when relay public config is absent, so off means upstream behavior).
- **owned dirs**: `apps/server/src/fork/relay/`, `packages/fork-core/src/relay*`. Infra definitions stay in the private repo.
- **seams**: TBD at design time; target zero, since relay config is already resolved at release time from env.
- **tests**: TBD. Must include parity: no relay config baked when the flag is off.
- **upstream**: no.
- **removal condition**: Tailscale-only remains sufficient, or upstream makes the relay endpoint configurable without a fork.

## swift-ios

- **status**: planned
- **purpose**: a native SwiftUI iOS client maintained by the fork, built from Mic's own Apple project with Xcode (no EAS).
- **note**: upstream's SwiftUI client lives only on upstream branches `yash/ios-16-swiftui` and `t3code/rebuild-mobile-app-swift` and never landed on `main`. Candidate to resurrect as a fork-maintained app under `apps/swift-ios`. Until then "iOS" means the Expo/React Native app in `apps/mobile` built locally with own team and bundle id (seams listed under `base`).
- **flags**: none on the server; the app is a separate build target, not a runtime toggle.
- **owned dirs**: `apps/swift-ios/`.
- **seams**: none expected. The app speaks the same wire contracts.
- **tests**: Xcode unit tests for the wire layer; `ios-debugger-agent` for simulator verification.
- **upstream**: no unless upstream revives the branch, in which case fork changes become candidates against it.
- **removal condition**: upstream lands a SwiftUI client on `main`, or the RN app is enough.

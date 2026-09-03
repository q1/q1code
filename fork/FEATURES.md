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

- **status**: active (phase 1: sidecar lifecycle and provider wiring; phase 2: accounts HTTP API, client runtime, cross-machine sync; phase 3: the Accounts UI on web, read-only on mobile)
- **purpose**: CLIProxyAPI (router-for-me, MIT, Go) baked into q1code as a managed sidecar so provider CLIs share one pool of accounts with load balancing and cross-machine sync.
- **summary (phase 1)**: `CliProxyBinary` resolves the executable (`fork.json.cliproxy.binaryPath`, then the copy bundled at `dist/cliproxy/<platform-arch>/cli-proxy-api`, then a cached or fresh download of the pinned release under `~/.q1code/cliproxy/bin/<version>/`, sha256-verified against the release `checksums.txt`; pin in `packages/fork-core/src/cliproxy.pin.json`). `CliProxyService` renders `~/.q1code/cliproxy/config.yaml` (loopback host, port from `fork.json`, `auth-dir ~/.q1code/cliproxy/auths`, one API key and one management secret from the server secret store, `allow-remote: false`, control panel, plugins, usage statistics and request logs off), spawns `cli-proxy-api -config <path>`, waits for the port and `GET /v0/management/latest-version`, supervises with capped exponential backoff, and stops when the flag turns off or the server shuts down. Sidecar output goes to the server log at debug level with both secrets redacted. Claude routes through it via the `ClaudeHome.ts` seam (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, only while the proxy is ready). Codex needs no seam: `CodexProxyHome` materializes `~/.q1code/cliproxy/codex-home/` with a `config.toml` that selects `model_providers.q1code` (Responses wire API, bearer header) and symlinks non-auth state from `~/.codex`; register a `codex` instance whose `homePath` is that directory to use it. The user's own `~/.codex/config.toml` is not merged. OpenCode, Cursor, Grok: not wired. Config changes to the `cliproxy` section apply on the next sidecar start (flag off/on).
- **summary (phase 2, server)**: one contract in `packages/fork-core/src/cliproxyApi.ts` (`@q1code/core/cliproxyApi`: schemas, paths, error classes, and the `HttpApi` group with the environment auth middleware attached). `apps/server/src/fork/cliproxy/CliProxyHttpApi.ts` implements it with `HttpApiBuilder` and proxies every call through `CliProxyService.management.request`, so the management secret never leaves the server. The routes mount next to upstream's API in `server.ts`. Endpoints, all under `/api/fork/cliproxy` and all behind environment auth (bearer, DPoP, or session cookie):

  | method    | path                                 | scope                 | does                                                                                                    |
  | --------- | ------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------- |
  | GET       | `status`                             | `orchestration:read`  | sidecar `state`/`port`/`version` plus sync `role`/`lastSyncAt`/`lastSyncError`; works with the flag off |
  | GET       | `accounts`                           | `orchestration:read`  | `GET /auth-files` mapped to `CliProxyAccount` (`updatedAt` from the sidecar or the file mtime)          |
  | POST      | `accounts/login`                     | `access:write`        | `GET /<provider>-auth-url?is_webui=true`; returns `sessionId`, `authUrl`, `flow`, `userCode`            |
  | GET       | `accounts/login/:sessionId`          | `orchestration:read`  | `GET /get-auth-status`; `completed` carries the new `accountId`                                         |
  | POST      | `accounts/login/:sessionId/callback` | `access:write`        | `POST /oauth-callback` with a pasted redirect URL (browser on another machine)                          |
  | DELETE    | `accounts/login/:sessionId`          | `access:write`        | `DELETE /oauth-session`                                                                                 |
  | PATCH     | `accounts/:id`                       | `access:write`        | `PATCH /auth-files/status` (`disabled`) and `/auth-files/fields` (`weight`)                             |
  | DELETE    | `accounts/:id`                       | `access:write`        | `DELETE /auth-files?name=`                                                                              |
  | GET / PUT | `routing`                            | read / `access:write` | `GET`/`PUT /routing/strategy`                                                                           |
  | GET       | `usage`                              | `orchestration:read`  | `GET /api-key-usage` (API-key credentials only; OAuth accounts report nothing here)                     |
  | GET       | `sync/export`                        | `access:write`        | primary: every auth file, encrypted, stamped with its mtime                                             |
  | POST      | `sync/push`                          | `access:write`        | primary: decrypt and write entries newer than the local copy                                            |
  | GET       | `sync/status`                        | `orchestration:read`  | role, primary URL, interval, last sync time and error                                                   |

  With the flag off or the sidecar not ready every endpoint except `status` and `sync/status` answers 503 `CliProxyUnavailableError { reason: "flag-off" | "sidecar-not-ready" | "sync-not-configured", state }`. Sidecar errors relay as 502 `CliProxyUpstreamError { status, message }`; unknown ids are 404 `CliProxyNotFoundError`. The client runtime exposes the same API as plain functions in `packages/client-runtime/src/fork/cliproxyClient.ts` (`@t3tools/client-runtime/fork`: `getCliProxyStatus`, `listCliProxyAccounts`, `startCliProxyLogin`, `getCliProxyLoginStatus`, `completeCliProxyLogin`, `cancelCliProxyLogin`, `patchCliProxyAccount`, `deleteCliProxyAccount`, `getCliProxyRouting`, `setCliProxyRouting`, `getCliProxyUsage`, `getCliProxySyncStatus`), each over the same `PreparedConnection` + DPoP signer the other environment HTTP helpers take; the header comment there is the UI contract.

- **summary (phase 2, sync)**: `apps/server/src/fork/cliproxy/CliProxySync.ts` (I.4 phase 1, tailnet transport). One environment is the primary; replicas pull `sync/export` at startup and every `intervalSeconds`, write files newer than their own into `auths/` (the sidecar hot-reloads), then push back any local file newer than the primary's copy (refreshed tokens). Last writer wins by mtime, equal stamps skip, no tombstones (deletions do not propagate yet). Payload: AES-256-GCM per file with a key derived from the shared secret via HKDF-SHA256 (`CliProxySyncCrypto.ts`), fresh 12-byte nonce per entry, wire form `base64(nonce || tag || data)`; nothing logs plaintext or keys. The replica authenticates with an admin-scoped bearer token issued on the primary. Setup:
  1. On the primary: `q1code auth session issue --label sync --token-only` (administrative scopes; add `--ttl` if the default does not suit). Put the printed token on the replica as `Q1CODE_CLIPROXY_SYNC_TOKEN`.
  2. Pick a shared secret and set `Q1CODE_CLIPROXY_SYNC_KEY` to the same value on every environment.
  3. Primary `fork.json`: `cliproxy: { sync: { role: "primary" } }`. Replica: `cliproxy: { sync: { role: "replica", primaryUrl: "http://<primary-host>:<port>", intervalSeconds?: 300 } }`.
     The `tokenSecretName` / `sharedKeySecretName` keys are read from the server secret store when the env vars are unset, but there is no CLI to store an arbitrary secret yet; that is the follow-up. Role changes and interval changes apply on the next server start.
- **summary (phase 3, UI)**: web Settings → General gains a collapsed "Accounts (CLIProxyAPI)" section, rendered only while `useForkFlag("cliproxy")` is true, in `apps/web/src/fork/cliproxy/`: `CliProxyAccountsSection.tsx` (status header with state badge, port, sidecar version, sync role and last sync; accounts table with enabled switch, weight input committed on blur/Enter, confirm-and-delete, relative `updatedAt`; "Add account" flow with a provider select, the auth URL as an external link plus copy button, the device `userCode` when present, a "paste the redirect URL" input for browsers that cannot reach the server, and cancel; routing-strategy select; API-key usage list), `useCliProxyApi.ts` (the client-runtime functions bound to the primary environment's prepared connection and DPoP signer, every call resolved to a plain ok/error result), and `cliproxyAccountsState.ts` (the login-flow reducer idle → starting → pending → completed/failed/cancelled with the paste-redirect transition, plus the label helpers; usage credentials render only their base URL, never the key). Status polls every 10 s only while the section is expanded and the document is visible; a pending login polls every 2 s; a new account's row is highlighted with a static background for a few seconds. 503 `CliProxyUnavailableError` renders an inline explanation per `reason` with the `T3FORK_CLIPROXY` / `fork.json` hint; 401/403 render as an "Administrative access" row like Connections does. Settings search knows "Accounts (CLIProxyAPI)", "Add account", and "Routing strategy" (no extra visibility predicate, same as the `base` entry). Mobile (`apps/mobile/src/fork/cliproxy/CliProxyAccountsCard.tsx`) shows one read-only card per connected environment with the flag on: sidecar state, port, version, sync role, and the account list with provider, weight, relative update time and Enabled/Disabled; a Refresh button reloads. No mutations on mobile in this phase.
- **later phases**: mobile mutations (enable, weight, remove, sign-in), provider-instance registration from the UI, sync over `relay-selfhost`, sync deletions, persisting a routing-strategy change back into `fork.json` (today a `PUT routing` lasts until the next sidecar start).
- **flags**: `cliproxy` (default off; nothing spawns, nothing is written under `~/.q1code/cliproxy`, no env var is injected, and the sync loop does not start when off). Env override `T3FORK_CLIPROXY=1`.
- **config**: `fork.json` `cliproxy: { port?: number (default 8317), routingStrategy?: "round-robin" | "weighted-round-robin" | "fill-first", binaryPath?: string, releaseVersion?: string, sync?: { role: "primary" | "replica", primaryUrl?: string, tokenSecretName?: string, sharedKeySecretName?: string, intervalSeconds?: number (default 300, minimum 5) } }`. Env: `T3FORK_CLIPROXY`, `Q1CODE_CLIPROXY_SYNC_TOKEN`, `Q1CODE_CLIPROXY_SYNC_KEY`.
- **owned dirs**: `apps/server/src/fork/cliproxy/`, `packages/fork-core/src/cliproxy*`, `packages/client-runtime/src/fork/cliproxyClient*`, `apps/web/src/fork/cliproxy/`, `apps/mobile/src/fork/cliproxy/`, the sidecar step in `.github/workflows/fork-release.yml`. Runtime state under `~/.q1code/cliproxy/` (`config.yaml`, `auths/`, `bin/`, `codex-home/`) and secrets `cliproxy-api-key`, `cliproxy-management-secret` in the server secret store.
- **seams**:
  - `apps/server/src/provider/Drivers/ClaudeHome.ts` (`makeClaudeEnvironment`: one import, one call to `withCliProxyClaudeEnvironment`, identity when off)
  - `apps/server/src/environment/ServerEnvironment.ts` (one import, one `Layer.provide(CliProxy.layer)` next to the `base` flags line)
  - `apps/server/src/server.ts` (one import, one `cliProxyRoutesLayer` entry in `makeRoutesLayer`; the layer re-provides `CliProxy.layer`, which Effect memoizes with the instance above, so no second sidecar spawns)
  - `packages/fork-core/package.json` depends on `@t3tools/contracts` (for the auth middleware and scope error the group declares); `packages/client-runtime/package.json` `./fork` now points at `src/fork/index.ts`
  - `apps/web/src/components/settings/SettingsPanels.tsx` (one import, one `<CliProxyAccountsSection />` next to `<ForkSettingsSection />`)
  - `apps/web/src/components/settings/settingsSearch.ts` (three entries: `cliproxy-accounts`, `cliproxy-add-account`, `cliproxy-routing-strategy`)
  - `apps/mobile/src/features/settings/SettingsRouteScreen.tsx` (one import, one `<CliProxyAccountsCards />` after `<GeneralSettingsSection />` in each of the local and configured screens)
- **tests**: `packages/fork-core/src/cliproxy.test.ts` (asset naming, platform keys, URLs), `cliproxyApi.test.ts` (paths, endpoint set, id pattern, shapes), `config.test.ts` (the `cliproxy` and `sync` sections); `apps/server/src/fork/cliproxy/CliProxyService.test.ts` (fake launcher and readiness: nothing spawns when off, start to ready, restart after exit and after a failed probe, stop on flag off and restart on flag on, endpoint published only while ready), `CliProxyBinary.test.ts` (override, bundled, download with checksum verification and extraction, cache hit, checksum mismatch leaves nothing behind, unsupported platform), `CliProxyConfig.test.ts` (YAML snapshot, atomic 0600 write), `CodexProxyHome.test.ts` (TOML snapshot, shared-state links), `CliProxyEnvironment.test.ts` (Claude seam parity: same env object when off), `CliProxyHttpApi.test.ts` (in-memory `HttpApiTest` client over a scripted sidecar: 401 without a credential, 503 with the state when off, account mapping, scope checks, patch/delete bodies, 404 mapping, login start/poll/complete/cancel, routing PUT, 502 relay), `CliProxySyncCrypto.test.ts` (round trip, unique nonces, tamper/foreign-key/garbage rejection), `CliProxySync.test.ts` (merge plan, primary export and push with newer-wins, missing key and wrong role, replica loop driven by an injected ticker against an in-memory primary, failure recorded in status); `packages/client-runtime/src/fork/cliproxyClient.test.ts` (bearer header and URL, 503 mapping, path encoding and JSON patch, typed 403); `apps/web/src/fork/cliproxy/cliproxyAccountsState.test.ts` (login-flow reducer transitions, stale-session answers ignored, paste-redirect round trip, weight parsing, usage credential masking). Component wiring is not tested. `fork-release.yml` verifies the three bundled binaries are in the tarball.
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

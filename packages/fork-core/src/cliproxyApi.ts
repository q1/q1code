/**
 * The q1code accounts API: the one contract the server (`CliProxyHttpApi.ts`),
 * the client runtime (`cliproxyClient.ts`), and the UI share. It fronts the
 * CLIProxyAPI management API so the management secret never leaves the box.
 *
 * Every endpoint sits behind the environment auth middleware, so clients send
 * the same bearer/DPoP headers they send to every other environment endpoint
 * and decode the same 401/403 errors.
 */
import { EnvironmentAuthenticatedAuth, EnvironmentScopeRequiredError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

import { CliProxyRoutingStrategy } from "./config.ts";

export const CLIPROXY_API_PREFIX = "/api/fork/cliproxy";

export const CLIPROXY_API_PATHS = {
  status: `${CLIPROXY_API_PREFIX}/status`,
  accounts: `${CLIPROXY_API_PREFIX}/accounts`,
  accountsLogin: `${CLIPROXY_API_PREFIX}/accounts/login`,
  accountsLoginSession: `${CLIPROXY_API_PREFIX}/accounts/login/:sessionId`,
  accountsLoginCallback: `${CLIPROXY_API_PREFIX}/accounts/login/:sessionId/callback`,
  account: `${CLIPROXY_API_PREFIX}/accounts/:id`,
  routing: `${CLIPROXY_API_PREFIX}/routing`,
  usage: `${CLIPROXY_API_PREFIX}/usage`,
  syncExport: `${CLIPROXY_API_PREFIX}/sync/export`,
  syncPush: `${CLIPROXY_API_PREFIX}/sync/push`,
  syncStatus: `${CLIPROXY_API_PREFIX}/sync/status`,
} as const;

export const CliProxyState = Schema.Literals(["off", "starting", "ready", "failed"]);
export type CliProxyState = typeof CliProxyState.Type;

export const CliProxyRole = Schema.Literals(["primary", "replica", "standalone"]);
export type CliProxyRole = typeof CliProxyRole.Type;

/** ISO-8601 timestamps travel as strings; every `updatedAt` below is millisecond precision. */
const IsoTimestamp = Schema.String;

export const CliProxyStatus = Schema.Struct({
  state: CliProxyState,
  port: Schema.Number,
  version: Schema.optionalKey(Schema.String),
  role: CliProxyRole,
  lastSyncAt: Schema.optionalKey(IsoTimestamp),
  lastSyncError: Schema.optionalKey(Schema.String),
});
export type CliProxyStatus = typeof CliProxyStatus.Type;

/** An auth file name: one path segment ending in `.json`. */
export const CliProxyAccountId = Schema.String.check(Schema.isPattern(/^[^/\\]+\.json$/));
export type CliProxyAccountId = typeof CliProxyAccountId.Type;

export const CliProxyAccount = Schema.Struct({
  /** The auth file name, unique per sidecar. */
  id: CliProxyAccountId,
  /** Sidecar provider key: `claude`, `codex`, `gemini`, `antigravity`, ... */
  provider: Schema.String,
  label: Schema.String,
  email: Schema.optionalKey(Schema.String),
  disabled: Schema.Boolean,
  weight: Schema.optionalKey(Schema.Number),
  updatedAt: IsoTimestamp,
});
export type CliProxyAccount = typeof CliProxyAccount.Type;

export const CliProxyAccountList = Schema.Struct({
  accounts: Schema.Array(CliProxyAccount),
});
export type CliProxyAccountList = typeof CliProxyAccountList.Type;

export const CliProxyAccountPatch = Schema.Struct({
  disabled: Schema.optionalKey(Schema.Boolean),
  weight: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type CliProxyAccountPatch = typeof CliProxyAccountPatch.Type;

/** The OAuth flows CLIProxyAPI can start from its management API. */
export const CliProxyLoginProvider = Schema.Literals([
  "anthropic",
  "codex",
  "antigravity",
  "xai",
  "kimi",
]);
export type CliProxyLoginProvider = typeof CliProxyLoginProvider.Type;

export const CliProxyLoginStart = Schema.Struct({
  provider: CliProxyLoginProvider,
});
export type CliProxyLoginStart = typeof CliProxyLoginStart.Type;

export const CliProxyLoginStarted = Schema.Struct({
  sessionId: Schema.String,
  /** Open this in a browser. */
  authUrl: Schema.String,
  /** `redirect` flows land on a localhost callback; `device` flows show `userCode` instead. */
  flow: Schema.Literals(["redirect", "device"]),
  userCode: Schema.optionalKey(Schema.String),
});
export type CliProxyLoginStarted = typeof CliProxyLoginStarted.Type;

export const CliProxyLoginState = Schema.Literals(["pending", "completed", "failed", "cancelled"]);
export type CliProxyLoginState = typeof CliProxyLoginState.Type;

export const CliProxyLoginStatus = Schema.Struct({
  sessionId: Schema.String,
  status: CliProxyLoginState,
  /** The auth file the flow produced, once it shows up in the account list. */
  accountId: Schema.optionalKey(CliProxyAccountId),
  error: Schema.optionalKey(Schema.String),
});
export type CliProxyLoginStatus = typeof CliProxyLoginStatus.Type;

/**
 * For redirect flows whose callback landed in a browser on another machine:
 * the user pastes the full `localhost:<port>/callback?code=...&state=...` URL.
 */
export const CliProxyLoginCallback = Schema.Struct({
  redirectUrl: Schema.String,
});
export type CliProxyLoginCallback = typeof CliProxyLoginCallback.Type;

export const CliProxyRouting = Schema.Struct({
  strategy: CliProxyRoutingStrategy,
});
export type CliProxyRouting = typeof CliProxyRouting.Type;

/** One bucket of the sidecar's recent-request histogram; shape is the sidecar's, passed through. */
export const CliProxyUsageBucket = Schema.Record(Schema.String, Schema.Unknown);

export const CliProxyUsageEntry = Schema.Struct({
  success: Schema.Number,
  failed: Schema.Number,
  recentRequests: Schema.Array(CliProxyUsageBucket),
});
export type CliProxyUsageEntry = typeof CliProxyUsageEntry.Type;

/** `GET /api-key-usage`: provider -> `<baseUrl>|<apiKey>` -> counters. Only API-key credentials appear. */
export const CliProxyUsage = Schema.Record(
  Schema.String,
  Schema.Record(Schema.String, CliProxyUsageEntry),
);
export type CliProxyUsage = typeof CliProxyUsage.Type;

export const CliProxySyncEntry = Schema.Struct({
  id: CliProxyAccountId,
  updatedAt: IsoTimestamp,
  /** base64 of `nonce(12) || tag(16) || AES-256-GCM data`. */
  ciphertext: Schema.String,
});
export type CliProxySyncEntry = typeof CliProxySyncEntry.Type;

export const CliProxySyncBundle = Schema.Struct({
  version: Schema.Literal(1),
  generatedAt: IsoTimestamp,
  primaryEnvironmentId: Schema.String,
  entries: Schema.Array(CliProxySyncEntry),
});
export type CliProxySyncBundle = typeof CliProxySyncBundle.Type;

export const CliProxySyncPush = Schema.Struct({
  entries: Schema.Array(CliProxySyncEntry),
});
export type CliProxySyncPush = typeof CliProxySyncPush.Type;

export const CliProxySyncPushResult = Schema.Struct({
  written: Schema.Array(CliProxyAccountId),
  skipped: Schema.Array(CliProxyAccountId),
});
export type CliProxySyncPushResult = typeof CliProxySyncPushResult.Type;

export const CliProxySyncStatus = Schema.Struct({
  role: CliProxyRole,
  primaryUrl: Schema.optionalKey(Schema.String),
  intervalSeconds: Schema.optionalKey(Schema.Number),
  lastSyncAt: Schema.optionalKey(IsoTimestamp),
  lastSyncError: Schema.optionalKey(Schema.String),
});
export type CliProxySyncStatus = typeof CliProxySyncStatus.Type;

export const CliProxyOk = Schema.Struct({ ok: Schema.Literal(true) });
export type CliProxyOk = typeof CliProxyOk.Type;

export const CliProxyUnavailableReason = Schema.Literals([
  "flag-off",
  "sidecar-not-ready",
  "sync-not-configured",
]);
export type CliProxyUnavailableReason = typeof CliProxyUnavailableReason.Type;

/** 503: the flag is off, the sidecar is not ready, or sync is not configured for this role. */
export class CliProxyUnavailableError extends Schema.TaggedErrorClass<CliProxyUnavailableError>()(
  "CliProxyUnavailableError",
  {
    reason: CliProxyUnavailableReason,
    state: CliProxyState,
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(CliProxyUnavailableError)(this, { status: 503 });
  }

  override get message(): string {
    return `CLIProxyAPI is unavailable (${this.reason}, sidecar ${this.state}).`;
  }
}

/** 502: the sidecar answered with an error or could not be reached. `status` is the sidecar's. */
export class CliProxyUpstreamError extends Schema.TaggedErrorClass<CliProxyUpstreamError>()(
  "CliProxyUpstreamError",
  {
    status: Schema.Number,
    message: Schema.String,
  },
  { httpApiStatus: 502 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(CliProxyUpstreamError)(this, { status: 502 });
  }
}

/** 404: no auth file or login session with that id. */
export class CliProxyNotFoundError extends Schema.TaggedErrorClass<CliProxyNotFoundError>()(
  "CliProxyNotFoundError",
  {
    id: Schema.String,
  },
  { httpApiStatus: 404 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(CliProxyNotFoundError)(this, { status: 404 });
  }

  override get message(): string {
    return `CLIProxyAPI has nothing named '${this.id}'.`;
  }
}

export const CliProxySyncFailureReason = Schema.Literals(["crypto", "io", "transport"]);
export type CliProxySyncFailureReason = typeof CliProxySyncFailureReason.Type;

/** 500: a sync export, push, or pull could not complete. Never carries plaintext or keys. */
export class CliProxySyncFailedError extends Schema.TaggedErrorClass<CliProxySyncFailedError>()(
  "CliProxySyncFailedError",
  {
    reason: CliProxySyncFailureReason,
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(CliProxySyncFailedError)(this, { status: 500 });
  }
}

/** Same optional headers every environment endpoint declares, so clients pass bearer/DPoP the same way. */
const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});

const SessionParams = Schema.Struct({ sessionId: Schema.String });
const AccountParams = Schema.Struct({ id: CliProxyAccountId });

const ScopeErrors = [EnvironmentScopeRequiredError] as const;
const ProxyErrors = [...ScopeErrors, CliProxyUnavailableError, CliProxyUpstreamError] as const;
const SyncErrors = [...ScopeErrors, CliProxyUnavailableError, CliProxySyncFailedError] as const;

export class CliProxyHttpApiGroup extends HttpApiGroup.make("cliproxy")
  .add(
    HttpApiEndpoint.get("status", CLIPROXY_API_PATHS.status, {
      headers: OptionalBearerHeaders,
      success: CliProxyStatus,
      error: ScopeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("listAccounts", CLIPROXY_API_PATHS.accounts, {
      headers: OptionalBearerHeaders,
      success: CliProxyAccountList,
      error: ProxyErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("startLogin", CLIPROXY_API_PATHS.accountsLogin, {
      headers: OptionalBearerHeaders,
      payload: CliProxyLoginStart,
      success: CliProxyLoginStarted,
      error: ProxyErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("loginStatus", CLIPROXY_API_PATHS.accountsLoginSession, {
      headers: OptionalBearerHeaders,
      params: SessionParams,
      success: CliProxyLoginStatus,
      error: ProxyErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("loginCallback", CLIPROXY_API_PATHS.accountsLoginCallback, {
      headers: OptionalBearerHeaders,
      params: SessionParams,
      payload: CliProxyLoginCallback,
      success: CliProxyLoginStatus,
      error: ProxyErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("cancelLogin", CLIPROXY_API_PATHS.accountsLoginSession, {
      headers: OptionalBearerHeaders,
      params: SessionParams,
      success: CliProxyLoginStatus,
      error: ProxyErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("patchAccount", CLIPROXY_API_PATHS.account, {
      headers: OptionalBearerHeaders,
      params: AccountParams,
      payload: CliProxyAccountPatch,
      success: CliProxyAccount,
      error: [...ProxyErrors, CliProxyNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteAccount", CLIPROXY_API_PATHS.account, {
      headers: OptionalBearerHeaders,
      params: AccountParams,
      success: CliProxyOk,
      error: [...ProxyErrors, CliProxyNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getRouting", CLIPROXY_API_PATHS.routing, {
      headers: OptionalBearerHeaders,
      success: CliProxyRouting,
      error: ProxyErrors,
    }),
  )
  .add(
    HttpApiEndpoint.put("setRouting", CLIPROXY_API_PATHS.routing, {
      headers: OptionalBearerHeaders,
      payload: CliProxyRouting,
      success: CliProxyRouting,
      error: ProxyErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getUsage", CLIPROXY_API_PATHS.usage, {
      headers: OptionalBearerHeaders,
      success: CliProxyUsage,
      error: ProxyErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("syncExport", CLIPROXY_API_PATHS.syncExport, {
      headers: OptionalBearerHeaders,
      success: CliProxySyncBundle,
      error: SyncErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("syncPush", CLIPROXY_API_PATHS.syncPush, {
      headers: OptionalBearerHeaders,
      payload: CliProxySyncPush,
      success: CliProxySyncPushResult,
      error: SyncErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("syncStatus", CLIPROXY_API_PATHS.syncStatus, {
      headers: OptionalBearerHeaders,
      success: CliProxySyncStatus,
      error: ScopeErrors,
    }),
  )
  .middleware(EnvironmentAuthenticatedAuth) {}

/** The API both `HttpApiBuilder` (server) and `HttpApiClient` (client runtime) build from. */
export class CliProxyHttpApi extends HttpApi.make("q1cliproxy").add(CliProxyHttpApiGroup) {}

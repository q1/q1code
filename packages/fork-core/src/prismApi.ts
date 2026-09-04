/**
 * The q1code accounts API: the one contract the server (`PrismHttpApi.ts`),
 * the client runtime (`prismClient.ts`), and the UI share. It fronts the
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

import { PrismMode, PrismRoutingStrategy } from "./config.ts";

export const PRISM_API_PREFIX = "/api/fork/prism";

/**
 * The `usageLimitSources` id and label Prism publishes its pooled accounts
 * under (upstream's CLI proxy hub kind), so the Limits view can tell the
 * managed source from a hub the user added by hand.
 */
export const PRISM_USAGE_SOURCE_ID = "prism";
export const PRISM_USAGE_SOURCE_LABEL = "Prism";

export const PRISM_API_PATHS = {
  status: `${PRISM_API_PREFIX}/status`,
  restart: `${PRISM_API_PREFIX}/restart`,
  usageSource: `${PRISM_API_PREFIX}/usage-source`,
  accounts: `${PRISM_API_PREFIX}/accounts`,
  accountsLogin: `${PRISM_API_PREFIX}/accounts/login`,
  accountsLoginSession: `${PRISM_API_PREFIX}/accounts/login/:sessionId`,
  accountsLoginCallback: `${PRISM_API_PREFIX}/accounts/login/:sessionId/callback`,
  account: `${PRISM_API_PREFIX}/accounts/:id`,
  routing: `${PRISM_API_PREFIX}/routing`,
  usage: `${PRISM_API_PREFIX}/usage`,
  syncExport: `${PRISM_API_PREFIX}/sync/export`,
  syncPush: `${PRISM_API_PREFIX}/sync/push`,
  syncStatus: `${PRISM_API_PREFIX}/sync/status`,
} as const;

export const PrismState = Schema.Literals(["off", "starting", "ready", "failed"]);
export type PrismState = typeof PrismState.Type;

export const PrismRole = Schema.Literals(["primary", "replica", "standalone"]);
export type PrismRole = typeof PrismRole.Type;

/** ISO-8601 timestamps travel as strings; every `updatedAt` below is millisecond precision. */
const IsoTimestamp = Schema.String;

export const PrismStatus = Schema.Struct({
  state: PrismState,
  port: Schema.Number,
  version: Schema.optionalKey(Schema.String),
  role: PrismRole,
  lastSyncAt: Schema.optionalKey(IsoTimestamp),
  lastSyncError: Schema.optionalKey(Schema.String),
  /** Absent from servers older than this field; treat as `sidecar`. */
  mode: Schema.optionalKey(PrismMode),
  /** The proxy origin provider CLIs are pointed at while `ready`. */
  baseUrl: Schema.optionalKey(Schema.String),
  /** Why the proxy is `failed` or keeps restarting; never contains a secret. */
  lastError: Schema.optionalKey(Schema.String),
  /** Supervisor restarts (sidecar) or reconnects (external) since the flag turned on. */
  restarts: Schema.optionalKey(Schema.Number),
  /** When the current `state` was entered. */
  since: Schema.optionalKey(IsoTimestamp),
  /** Whether the pooled accounts are published to the Limits view (`prism.usageSource`, default true). */
  usageSource: Schema.optionalKey(Schema.Boolean),
});
export type PrismStatus = typeof PrismStatus.Type;

/** An auth file name: one path segment ending in `.json`. */
export const PrismAccountId = Schema.String.check(Schema.isPattern(/^[^/\\]+\.json$/));
export type PrismAccountId = typeof PrismAccountId.Type;

/** Passive provider quota observations the sidecar attaches to an auth file (`observed_at`, `signals`). */
export const PrismAccountQuota = Schema.Struct({
  observedAt: Schema.optionalKey(IsoTimestamp),
  signals: Schema.Record(Schema.String, Schema.String),
});
export type PrismAccountQuota = typeof PrismAccountQuota.Type;

/** Per-account request counters since the sidecar started, from the `/auth-files` entry. */
export const PrismAccountUsage = Schema.Struct({
  success: Schema.Number,
  failed: Schema.Number,
  quota: Schema.optionalKey(PrismAccountQuota),
});
export type PrismAccountUsage = typeof PrismAccountUsage.Type;

/** Optional observations from the gateway; absent timestamps mean unknown. */
export const PrismAccountLifecycle = Schema.Struct({
  status: Schema.optionalKey(Schema.String),
  unavailable: Schema.optionalKey(Schema.Boolean),
  expiresAt: Schema.optionalKey(IsoTimestamp),
  lastRefreshedAt: Schema.optionalKey(IsoTimestamp),
  refreshNotBefore: Schema.optionalKey(IsoTimestamp),
  retryAt: Schema.optionalKey(IsoTimestamp),
  lastErrorStatus: Schema.optionalKey(Schema.Number),
});
export type PrismAccountLifecycle = typeof PrismAccountLifecycle.Type;

export const PrismAccount = Schema.Struct({
  /** The auth file name, unique per sidecar. */
  id: PrismAccountId,
  /** Sidecar provider key: `claude`, `codex`, `gemini`, `antigravity`, ... */
  provider: Schema.String,
  label: Schema.String,
  email: Schema.optionalKey(Schema.String),
  disabled: Schema.Boolean,
  weight: Schema.optionalKey(Schema.Number),
  updatedAt: IsoTimestamp,
  /** Absent when the sidecar reports no counters for the file (older sidecars, disk-only listings). */
  usage: Schema.optionalKey(PrismAccountUsage),
  lifecycle: Schema.optionalKey(PrismAccountLifecycle),
});
export type PrismAccount = typeof PrismAccount.Type;

export const PrismAccountList = Schema.Struct({
  accounts: Schema.Array(PrismAccount),
});
export type PrismAccountList = typeof PrismAccountList.Type;

export const PrismAccountPatch = Schema.Struct({
  disabled: Schema.optionalKey(Schema.Boolean),
  weight: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type PrismAccountPatch = typeof PrismAccountPatch.Type;

/** The OAuth flows CLIProxyAPI can start from its management API. */
export const PrismLoginProvider = Schema.Literals([
  "anthropic",
  "codex",
  "antigravity",
  "xai",
  "kimi",
]);
export type PrismLoginProvider = typeof PrismLoginProvider.Type;

export const PrismLoginStart = Schema.Struct({
  provider: PrismLoginProvider,
});
export type PrismLoginStart = typeof PrismLoginStart.Type;

export const PrismLoginStarted = Schema.Struct({
  sessionId: Schema.String,
  /** Open this in a browser. */
  authUrl: Schema.String,
  /** `redirect` flows land on a localhost callback; `device` flows show `userCode` instead. */
  flow: Schema.Literals(["redirect", "device"]),
  userCode: Schema.optionalKey(Schema.String),
});
export type PrismLoginStarted = typeof PrismLoginStarted.Type;

export const PrismLoginState = Schema.Literals(["pending", "completed", "failed", "cancelled"]);
export type PrismLoginState = typeof PrismLoginState.Type;

export const PrismLoginStatus = Schema.Struct({
  sessionId: Schema.String,
  status: PrismLoginState,
  /** The auth file the flow produced, once it shows up in the account list. */
  accountId: Schema.optionalKey(PrismAccountId),
  error: Schema.optionalKey(Schema.String),
});
export type PrismLoginStatus = typeof PrismLoginStatus.Type;

/**
 * For redirect flows whose callback landed in a browser on another machine:
 * the user pastes the full `localhost:<port>/callback?code=...&state=...` URL.
 */
export const PrismLoginCallback = Schema.Struct({
  redirectUrl: Schema.String,
});
export type PrismLoginCallback = typeof PrismLoginCallback.Type;

export const PrismRouting = Schema.Struct({
  strategy: PrismRoutingStrategy,
});
export type PrismRouting = typeof PrismRouting.Type;

/** One bucket of the sidecar's recent-request histogram; shape is the sidecar's, passed through. */
export const PrismUsageBucket = Schema.Record(Schema.String, Schema.Unknown);

export const PrismUsageEntry = Schema.Struct({
  success: Schema.Number,
  failed: Schema.Number,
  recentRequests: Schema.Array(PrismUsageBucket),
});
export type PrismUsageEntry = typeof PrismUsageEntry.Type;

/** `GET /api-key-usage`: provider -> `<baseUrl>|<apiKey>` -> counters. Only API-key credentials appear. */
export const PrismUsage = Schema.Record(
  Schema.String,
  Schema.Record(Schema.String, PrismUsageEntry),
);
export type PrismUsage = typeof PrismUsage.Type;

export const PrismSyncEntry = Schema.Struct({
  id: PrismAccountId,
  updatedAt: IsoTimestamp,
  /** base64 of `nonce(12) || tag(16) || AES-256-GCM data`. */
  ciphertext: Schema.String,
});
export type PrismSyncEntry = typeof PrismSyncEntry.Type;

/** A deletion that still has to reach the other side. A file stamped strictly later than `deletedAt` beats it. */
export const PrismSyncTombstone = Schema.Struct({
  id: PrismAccountId,
  deletedAt: IsoTimestamp,
});
export type PrismSyncTombstone = typeof PrismSyncTombstone.Type;

/** Version 2 adds `tombstones`; a version 1 bundle (no tombstones) still decodes. */
export const PrismSyncBundle = Schema.Struct({
  version: Schema.Literals([1, 2]),
  generatedAt: IsoTimestamp,
  primaryEnvironmentId: Schema.String,
  entries: Schema.Array(PrismSyncEntry),
  tombstones: Schema.optionalKey(Schema.Array(PrismSyncTombstone)),
});
export type PrismSyncBundle = typeof PrismSyncBundle.Type;

export const PrismSyncPush = Schema.Struct({
  entries: Schema.Array(PrismSyncEntry),
  tombstones: Schema.optionalKey(Schema.Array(PrismSyncTombstone)),
});
export type PrismSyncPush = typeof PrismSyncPush.Type;

export const PrismSyncPushResult = Schema.Struct({
  written: Schema.Array(PrismAccountId),
  skipped: Schema.Array(PrismAccountId),
  /** Files the pushed tombstones removed on the primary. Absent from a version 1 primary. */
  deleted: Schema.optionalKey(Schema.Array(PrismAccountId)),
});
export type PrismSyncPushResult = typeof PrismSyncPushResult.Type;

export const PrismSyncStatus = Schema.Struct({
  role: PrismRole,
  primaryUrl: Schema.optionalKey(Schema.String),
  intervalSeconds: Schema.optionalKey(Schema.Number),
  lastSyncAt: Schema.optionalKey(IsoTimestamp),
  lastSyncError: Schema.optionalKey(Schema.String),
});
export type PrismSyncStatus = typeof PrismSyncStatus.Type;

/** `PUT usage-source` body: whether Prism publishes its pooled accounts to the Limits view. Persisted in `fork.json`. */
export const PrismUsageSource = Schema.Struct({ enabled: Schema.Boolean });
export type PrismUsageSource = typeof PrismUsageSource.Type;

export const PrismOk = Schema.Struct({ ok: Schema.Literal(true) });
export type PrismOk = typeof PrismOk.Type;

export const PrismUnavailableReason = Schema.Literals([
  "flag-off",
  "sidecar-not-ready",
  "sync-not-configured",
]);
export type PrismUnavailableReason = typeof PrismUnavailableReason.Type;

/** 503: the flag is off, the sidecar is not ready, or sync is not configured for this role. */
export class PrismUnavailableError extends Schema.TaggedErrorClass<PrismUnavailableError>()(
  "PrismUnavailableError",
  {
    reason: PrismUnavailableReason,
    state: PrismState,
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(PrismUnavailableError)(this, { status: 503 });
  }

  override get message(): string {
    return `Prism is unavailable (${this.reason}, state ${this.state}).`;
  }
}

/** 502: the sidecar answered with an error or could not be reached. `status` is the sidecar's. */
export class PrismUpstreamError extends Schema.TaggedErrorClass<PrismUpstreamError>()(
  "PrismUpstreamError",
  {
    status: Schema.Number,
    message: Schema.String,
  },
  { httpApiStatus: 502 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(PrismUpstreamError)(this, { status: 502 });
  }
}

/** 404: no auth file or login session with that id. */
export class PrismNotFoundError extends Schema.TaggedErrorClass<PrismNotFoundError>()(
  "PrismNotFoundError",
  {
    id: Schema.String,
  },
  { httpApiStatus: 404 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(PrismNotFoundError)(this, { status: 404 });
  }

  override get message(): string {
    return `Prism has nothing named '${this.id}'.`;
  }
}

/** 500: a change the sidecar accepted could not be persisted into `fork.json`, so it would not survive a restart. */
export class PrismConfigError extends Schema.TaggedErrorClass<PrismConfigError>()(
  "PrismConfigError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(PrismConfigError)(this, { status: 500 });
  }
}

export const PrismSyncFailureReason = Schema.Literals(["crypto", "io", "transport"]);
export type PrismSyncFailureReason = typeof PrismSyncFailureReason.Type;

/** 500: a sync export, push, or pull could not complete. Never carries plaintext or keys. */
export class PrismSyncFailedError extends Schema.TaggedErrorClass<PrismSyncFailedError>()(
  "PrismSyncFailedError",
  {
    reason: PrismSyncFailureReason,
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(PrismSyncFailedError)(this, { status: 500 });
  }
}

/** Same optional headers every environment endpoint declares, so clients pass bearer/DPoP the same way. */
const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});

const SessionParams = Schema.Struct({ sessionId: Schema.String });
const AccountParams = Schema.Struct({ id: PrismAccountId });

const ScopeErrors = [EnvironmentScopeRequiredError] as const;
const ProxyErrors = [...ScopeErrors, PrismUnavailableError, PrismUpstreamError] as const;
const SyncErrors = [...ScopeErrors, PrismUnavailableError, PrismSyncFailedError] as const;

export class PrismHttpApiGroup extends HttpApiGroup.make("prism")
  .add(
    HttpApiEndpoint.get("status", PRISM_API_PATHS.status, {
      headers: OptionalBearerHeaders,
      success: PrismStatus,
      error: ScopeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("restart", PRISM_API_PATHS.restart, {
      headers: OptionalBearerHeaders,
      success: PrismStatus,
      error: [...ScopeErrors, PrismUnavailableError],
    }),
  )
  .add(
    HttpApiEndpoint.put("setUsageSource", PRISM_API_PATHS.usageSource, {
      headers: OptionalBearerHeaders,
      payload: PrismUsageSource,
      success: PrismStatus,
      error: [...ScopeErrors, PrismUnavailableError, PrismConfigError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listAccounts", PRISM_API_PATHS.accounts, {
      headers: OptionalBearerHeaders,
      success: PrismAccountList,
      error: ProxyErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("startLogin", PRISM_API_PATHS.accountsLogin, {
      headers: OptionalBearerHeaders,
      payload: PrismLoginStart,
      success: PrismLoginStarted,
      error: ProxyErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("loginStatus", PRISM_API_PATHS.accountsLoginSession, {
      headers: OptionalBearerHeaders,
      params: SessionParams,
      success: PrismLoginStatus,
      error: ProxyErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("loginCallback", PRISM_API_PATHS.accountsLoginCallback, {
      headers: OptionalBearerHeaders,
      params: SessionParams,
      payload: PrismLoginCallback,
      success: PrismLoginStatus,
      error: ProxyErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("cancelLogin", PRISM_API_PATHS.accountsLoginSession, {
      headers: OptionalBearerHeaders,
      params: SessionParams,
      success: PrismLoginStatus,
      error: ProxyErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("patchAccount", PRISM_API_PATHS.account, {
      headers: OptionalBearerHeaders,
      params: AccountParams,
      payload: PrismAccountPatch,
      success: PrismAccount,
      error: [...ProxyErrors, PrismNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteAccount", PRISM_API_PATHS.account, {
      headers: OptionalBearerHeaders,
      params: AccountParams,
      success: PrismOk,
      error: [...ProxyErrors, PrismNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getRouting", PRISM_API_PATHS.routing, {
      headers: OptionalBearerHeaders,
      success: PrismRouting,
      error: ProxyErrors,
    }),
  )
  .add(
    HttpApiEndpoint.put("setRouting", PRISM_API_PATHS.routing, {
      headers: OptionalBearerHeaders,
      payload: PrismRouting,
      success: PrismRouting,
      error: [...ProxyErrors, PrismConfigError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getUsage", PRISM_API_PATHS.usage, {
      headers: OptionalBearerHeaders,
      success: PrismUsage,
      error: ProxyErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("syncExport", PRISM_API_PATHS.syncExport, {
      headers: OptionalBearerHeaders,
      success: PrismSyncBundle,
      error: SyncErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("syncPush", PRISM_API_PATHS.syncPush, {
      headers: OptionalBearerHeaders,
      payload: PrismSyncPush,
      success: PrismSyncPushResult,
      error: SyncErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("syncStatus", PRISM_API_PATHS.syncStatus, {
      headers: OptionalBearerHeaders,
      success: PrismSyncStatus,
      error: ScopeErrors,
    }),
  )
  .middleware(EnvironmentAuthenticatedAuth) {}

/** The API both `HttpApiBuilder` (server) and `HttpApiClient` (client runtime) build from. */
export class PrismHttpApi extends HttpApi.make("q1prism").add(PrismHttpApiGroup) {}

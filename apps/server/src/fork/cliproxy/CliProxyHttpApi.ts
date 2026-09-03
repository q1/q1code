/**
 * The q1code accounts API over the sidecar's management API. Every handler
 * proxies through `CliProxyService.management.request`, so the management
 * secret never leaves the server; clients authenticate with the same
 * environment auth as every other `/api` endpoint.
 *
 * Reads need `orchestration:read`; mutations, `restart`, and both sync
 * endpoints need `access:write`. With the flag off or the proxy not ready every
 * endpoint except `status` and `sync/status` answers 503 with the proxy state
 * (`restart` only needs the flag: it is how a `failed` proxy is retried).
 *
 * `PUT routing` also writes `cliproxy.routingStrategy` into `fork.json`, so the
 * strategy the sidecar is told now is the one it is started with next time.
 */
import {
  type CliProxyAccount,
  type CliProxyAccountUsage,
  CliProxyConfigError,
  CliProxyHttpApi,
  type CliProxyLoginStatus,
  CliProxyNotFoundError,
  type CliProxyStatus,
  CliProxyUnavailableError,
  CliProxyUpstreamError,
  type CliProxyUsage,
} from "@q1code/core/cliproxyApi";
import { CliProxyRoutingStrategy } from "@q1code/core/config";
import { AuthAccessWriteScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClientResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  environmentAuthenticatedAuthLayer,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ForkFlags from "../ForkFlags.ts";
import { cliproxyDirectories } from "./CliProxyConfig.ts";
import * as CliProxy from "./CliProxyService.ts";
import * as CliProxySync from "./CliProxySync.ts";

/** What we read from the sidecar; everything else it returns is ignored. */
const AuthFileEntry = Schema.Struct({
  name: Schema.String,
  type: Schema.optionalKey(Schema.String),
  provider: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
  disabled: Schema.optionalKey(Schema.Boolean),
  weight: Schema.optionalKey(Schema.Number),
  modtime: Schema.optionalKey(Schema.String),
  updated_at: Schema.optionalKey(Schema.String),
  // Counters and quota observations (`buildAuthFileEntry` in the sidecar); absent from disk-only listings.
  success: Schema.optionalKey(Schema.Number),
  failed: Schema.optionalKey(Schema.Number),
  quota: Schema.optionalKey(
    Schema.Struct({
      observed_at: Schema.optionalKey(Schema.String),
      signals: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
});
const AuthFilesResponse = Schema.Struct({ files: Schema.Array(AuthFileEntry) });
const OAuthStartResponse = Schema.Struct({
  url: Schema.String,
  state: Schema.String,
  flow: Schema.optionalKey(Schema.String),
  user_code: Schema.optionalKey(Schema.String),
});
const OAuthStatusResponse = Schema.Struct({
  status: Schema.String,
  error: Schema.optionalKey(Schema.String),
});
const RoutingResponse = Schema.Struct({ strategy: Schema.String });
const UsageResponse = Schema.Record(
  Schema.String,
  Schema.Record(
    Schema.String,
    Schema.Struct({
      success: Schema.Number,
      failed: Schema.Number,
      recent_requests: Schema.optionalKey(
        Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
      ),
    }),
  ),
);
const ErrorResponse = Schema.Struct({ error: Schema.optionalKey(Schema.String) });
const Ignored = Schema.Unknown;

const isRoutingStrategy = Schema.is(CliProxyRoutingStrategy);

/** Sidecar timestamps arrive as Go `time.Time` (RFC 3339 with nanoseconds); normalize to millisecond ISO. */
const toIso = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? DateTime.formatIso(DateTime.makeUnsafe(millis)) : undefined;
};

/** Counters only when the sidecar reports them; quota only when it observed something. */
const toUsage = (entry: typeof AuthFileEntry.Type): CliProxyAccountUsage | undefined => {
  if (entry.success === undefined || entry.failed === undefined) return undefined;
  const observedAt = toIso(entry.quota?.observed_at);
  const signals = entry.quota?.signals ?? {};
  const quota =
    observedAt !== undefined || Object.keys(signals).length > 0
      ? { ...(observedAt !== undefined ? { observedAt } : {}), signals }
      : undefined;
  return {
    success: entry.success,
    failed: entry.failed,
    ...(quota !== undefined ? { quota } : {}),
  };
};

interface LoginSession {
  readonly before: ReadonlySet<string>;
  readonly cancelled: boolean;
}

type ProxyError = CliProxyUnavailableError | CliProxyUpstreamError;

export const cliProxyHttpApiLayer = HttpApiBuilder.group(
  CliProxyHttpApi,
  "cliproxy",
  Effect.fnUntraced(function* (handlers) {
    const proxy = yield* CliProxy.CliProxyService;
    const sync = yield* CliProxySync.CliProxySyncService;
    const flags = yield* ForkFlags.ForkFlagsService;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { authsDir } = cliproxyDirectories(config.baseDir, path);
    const loginSessions = yield* Ref.make<ReadonlyMap<string, LoginSession>>(new Map());

    const unavailable = (
      reason: CliProxyUnavailableError["reason"],
    ): Effect.Effect<never, CliProxyUnavailableError> =>
      proxy.status.pipe(
        Effect.flatMap((status) =>
          Effect.fail(new CliProxyUnavailableError({ reason, state: status.state })),
        ),
      );

    const requireReady: Effect.Effect<CliProxy.CliProxyStatus, CliProxyUnavailableError> =
      proxy.status.pipe(
        Effect.flatMap((status) =>
          status.state === "ready"
            ? Effect.succeed(status)
            : Effect.fail(
                new CliProxyUnavailableError({
                  reason: status.state === "off" ? "flag-off" : "sidecar-not-ready",
                  state: status.state,
                }),
              ),
        ),
      );

    const requireFlag: Effect.Effect<void, CliProxyUnavailableError> = flags.current.pipe(
      Effect.flatMap((values) => (values.cliproxy ? Effect.void : unavailable("flag-off"))),
    );

    const upstreamMessage = (response: HttpClientResponse.HttpClientResponse) =>
      HttpClientResponse.schemaBodyJson(ErrorResponse)(response).pipe(
        Effect.map((body) => body.error ?? `HTTP ${response.status}`),
        Effect.orElseSucceed(() => `HTTP ${response.status}`),
      );

    /** One management call, decoded. Sidecar errors become 502 with the sidecar's message and status. */
    const call = <S extends Schema.Constraint & Schema.Decoder<unknown, never>>(
      schema: S,
      requestPath: string,
      options?: CliProxy.CliProxyManagementRequestOptions,
    ): Effect.Effect<S["Type"], ProxyError> =>
      proxy.management.request(requestPath, options).pipe(
        Effect.catch(
          (error): Effect.Effect<never, ProxyError> =>
            error.reason === "not-ready"
              ? unavailable("sidecar-not-ready")
              : Effect.fail(new CliProxyUpstreamError({ status: 0, message: error.message })),
        ),
        Effect.flatMap(
          (response): Effect.Effect<S["Type"], ProxyError> =>
            response.status >= 400
              ? upstreamMessage(response).pipe(
                  Effect.flatMap((message) =>
                    Effect.fail(new CliProxyUpstreamError({ status: response.status, message })),
                  ),
                )
              : HttpClientResponse.schemaBodyJson(schema)(response).pipe(
                  Effect.mapError(
                    () =>
                      new CliProxyUpstreamError({
                        status: response.status,
                        message: `unexpected response from ${requestPath}`,
                      }),
                  ),
                ),
        ),
      );

    const json = (
      method: "POST" | "PUT" | "PATCH",
      body: unknown,
    ): CliProxy.CliProxyManagementRequestOptions => ({
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const notFoundAs = (id: string) => (error: ProxyError) =>
      error._tag === "CliProxyUpstreamError" && error.status === 404
        ? new CliProxyNotFoundError({ id })
        : error;

    const fileMtime = (name: string) =>
      fs.stat(path.join(authsDir, name)).pipe(
        Effect.map((info) => Option.map(info.mtime, (date) => date.toISOString())),
        Effect.orElseSucceed(() => Option.none<string>()),
      );

    const toAccount = (entry: typeof AuthFileEntry.Type) =>
      Effect.gen(function* () {
        const provider = entry.provider?.trim() || entry.type?.trim() || "unknown";
        const email = entry.email?.trim() || undefined;
        const label = entry.label?.trim() || email || entry.name.replace(/\.json$/, "");
        const updatedAt =
          toIso(entry.updated_at) ??
          toIso(entry.modtime) ??
          Option.getOrUndefined(yield* fileMtime(entry.name)) ??
          DateTime.formatIso(yield* DateTime.now);
        const usage = toUsage(entry);
        return {
          id: entry.name,
          provider,
          label,
          ...(email !== undefined ? { email } : {}),
          disabled: entry.disabled ?? false,
          ...(entry.weight !== undefined ? { weight: entry.weight } : {}),
          updatedAt,
          ...(usage !== undefined ? { usage } : {}),
        } satisfies CliProxyAccount;
      });

    const listAccounts = call(AuthFilesResponse, "/auth-files").pipe(
      Effect.flatMap((response) =>
        Effect.forEach(
          response.files.filter((entry) => entry.name.endsWith(".json")),
          toAccount,
        ),
      ),
    );

    const loginStatus = (sessionId: string) =>
      Effect.gen(function* () {
        const session = (yield* Ref.get(loginSessions)).get(sessionId);
        if (session?.cancelled) {
          return { sessionId, status: "cancelled" } satisfies CliProxyLoginStatus;
        }
        const response = yield* call(
          OAuthStatusResponse,
          `/get-auth-status?state=${encodeURIComponent(sessionId)}`,
        );
        switch (response.status) {
          case "ok": {
            const accounts = yield* listAccounts;
            const created = accounts.find((account) => !(session?.before.has(account.id) ?? false));
            return {
              sessionId,
              status: "completed",
              ...(created !== undefined ? { accountId: created.id } : {}),
            } satisfies CliProxyLoginStatus;
          }
          case "wait":
            return { sessionId, status: "pending" } satisfies CliProxyLoginStatus;
          default:
            return {
              sessionId,
              status: "failed",
              error: response.error ?? response.status,
            } satisfies CliProxyLoginStatus;
        }
      });

    /** Persist the strategy next to whatever else the file holds; only the one key moves. */
    const persistRoutingStrategy = (strategy: CliProxyRoutingStrategy) =>
      flags
        .update((raw) => ({
          ...raw,
          cliproxy: {
            ...(Predicate.isObject(raw.cliproxy) && !Array.isArray(raw.cliproxy)
              ? raw.cliproxy
              : {}),
            routingStrategy: strategy,
          },
        }))
        .pipe(Effect.mapError((error) => new CliProxyConfigError({ message: error.message })));

    const getRouting = call(RoutingResponse, "/routing/strategy").pipe(
      Effect.flatMap(({ strategy }) =>
        isRoutingStrategy(strategy)
          ? Effect.succeed({ strategy })
          : Effect.fail(
              new CliProxyUpstreamError({
                status: 200,
                message: `unknown routing strategy '${strategy}'`,
              }),
            ),
      ),
    );

    const withRead = <A, E, R>(name: string, body: Effect.Effect<A, E, R>) =>
      annotateEnvironmentRequest(name).pipe(
        Effect.andThen(requireEnvironmentScope(AuthOrchestrationReadScope)),
        Effect.andThen(body),
      );

    const withWrite = <A, E, R>(name: string, body: Effect.Effect<A, E, R>) =>
      annotateEnvironmentRequest(name).pipe(
        Effect.andThen(requireEnvironmentScope(AuthAccessWriteScope)),
        Effect.andThen(body),
      );

    /** The proxy status plus the sync status, in the wire shape. */
    const fullStatus = (status: CliProxy.CliProxyStatus) =>
      sync.status.pipe(
        Effect.map(
          (syncStatus) =>
            ({
              state: status.state,
              port: status.port,
              ...(status.version !== undefined ? { version: status.version } : {}),
              role: syncStatus.role,
              ...(syncStatus.lastSyncAt !== undefined ? { lastSyncAt: syncStatus.lastSyncAt } : {}),
              ...(syncStatus.lastSyncError !== undefined
                ? { lastSyncError: syncStatus.lastSyncError }
                : {}),
              mode: status.mode,
              ...(status.baseUrl !== undefined ? { baseUrl: status.baseUrl } : {}),
              ...(status.lastError !== undefined ? { lastError: status.lastError } : {}),
              restarts: status.restarts,
              since: status.since,
            }) satisfies CliProxyStatus,
        ),
      );

    return handlers
      .handle("status", (args) =>
        withRead(args.endpoint.name, proxy.status.pipe(Effect.flatMap(fullStatus))),
      )
      .handle("restart", (args) =>
        withWrite(
          args.endpoint.name,
          requireFlag.pipe(Effect.andThen(proxy.restart), Effect.flatMap(fullStatus)),
        ),
      )
      .handle("listAccounts", (args) =>
        withRead(
          args.endpoint.name,
          requireReady.pipe(
            Effect.andThen(listAccounts),
            Effect.map((accounts) => ({ accounts })),
          ),
        ),
      )
      .handle("startLogin", (args) =>
        withWrite(
          args.endpoint.name,
          Effect.gen(function* () {
            yield* requireReady;
            const before = new Set((yield* listAccounts).map((account) => account.id));
            const started = yield* call(
              OAuthStartResponse,
              `/${args.payload.provider}-auth-url?is_webui=true`,
            );
            yield* Ref.update(loginSessions, (sessions) =>
              new Map(sessions).set(started.state, { before, cancelled: false }),
            );
            const userCode = started.user_code?.trim() || undefined;
            return {
              sessionId: started.state,
              authUrl: started.url,
              flow: started.flow === "device" ? ("device" as const) : ("redirect" as const),
              ...(userCode !== undefined ? { userCode } : {}),
            };
          }),
        ),
      )
      .handle("loginStatus", (args) =>
        withRead(
          args.endpoint.name,
          requireReady.pipe(Effect.andThen(loginStatus(args.params.sessionId))),
        ),
      )
      .handle("loginCallback", (args) =>
        withWrite(
          args.endpoint.name,
          Effect.gen(function* () {
            yield* requireReady;
            yield* call(
              Ignored,
              "/oauth-callback",
              json("POST", {
                state: args.params.sessionId,
                redirect_url: args.payload.redirectUrl,
              }),
            );
            return yield* loginStatus(args.params.sessionId);
          }),
        ),
      )
      .handle("cancelLogin", (args) =>
        withWrite(
          args.endpoint.name,
          Effect.gen(function* () {
            yield* requireReady;
            const sessionId = args.params.sessionId;
            yield* call(Ignored, `/oauth-session?state=${encodeURIComponent(sessionId)}`, {
              method: "DELETE",
            });
            yield* Ref.update(loginSessions, (sessions) =>
              new Map(sessions).set(sessionId, {
                before: sessions.get(sessionId)?.before ?? new Set(),
                cancelled: true,
              }),
            );
            return { sessionId, status: "cancelled" as const };
          }),
        ),
      )
      .handle("patchAccount", (args) =>
        withWrite(
          args.endpoint.name,
          Effect.gen(function* () {
            yield* requireReady;
            const id = args.params.id;
            if (args.payload.disabled !== undefined) {
              yield* call(
                Ignored,
                "/auth-files/status",
                json("PATCH", { name: id, disabled: args.payload.disabled }),
              ).pipe(Effect.mapError(notFoundAs(id)));
            }
            if (args.payload.weight !== undefined) {
              yield* call(
                Ignored,
                "/auth-files/fields",
                json("PATCH", { name: id, weight: args.payload.weight }),
              ).pipe(Effect.mapError(notFoundAs(id)));
            }
            const account = (yield* listAccounts).find((candidate) => candidate.id === id);
            return account ?? (yield* new CliProxyNotFoundError({ id }));
          }),
        ),
      )
      .handle("deleteAccount", (args) =>
        withWrite(
          args.endpoint.name,
          Effect.gen(function* () {
            yield* requireReady;
            const id = args.params.id;
            yield* call(Ignored, `/auth-files?name=${encodeURIComponent(id)}`, {
              method: "DELETE",
            }).pipe(Effect.mapError(notFoundAs(id)));
            // The sidecar removed the file; the tombstone carries the deletion to the other environments.
            yield* sync.recordTombstone(id).pipe(
              Effect.catch((error) =>
                Effect.logWarning("cliproxy: deletion not recorded for sync", {
                  id,
                  cause: error.message,
                }),
              ),
            );
            return { ok: true as const };
          }),
        ),
      )
      .handle("getRouting", (args) =>
        withRead(args.endpoint.name, requireReady.pipe(Effect.andThen(getRouting))),
      )
      .handle("setRouting", (args) =>
        withWrite(
          args.endpoint.name,
          requireReady.pipe(
            Effect.andThen(
              call(Ignored, "/routing/strategy", json("PUT", { value: args.payload.strategy })),
            ),
            Effect.andThen(persistRoutingStrategy(args.payload.strategy)),
            Effect.andThen(getRouting),
          ),
        ),
      )
      .handle("getUsage", (args) =>
        withRead(
          args.endpoint.name,
          requireReady.pipe(
            Effect.andThen(call(UsageResponse, "/api-key-usage")),
            Effect.map(
              (usage): CliProxyUsage =>
                Object.fromEntries(
                  Object.entries(usage).map(([provider, keys]) => [
                    provider,
                    Object.fromEntries(
                      Object.entries(keys).map(([key, entry]) => [
                        key,
                        {
                          success: entry.success,
                          failed: entry.failed,
                          recentRequests: entry.recent_requests ?? [],
                        },
                      ]),
                    ),
                  ]),
                ),
            ),
          ),
        ),
      )
      .handle("syncExport", (args) =>
        withWrite(
          args.endpoint.name,
          requireFlag.pipe(
            Effect.andThen(sync.exportBundle),
            Effect.catchTag("CliProxySyncNotConfigured", () => unavailable("sync-not-configured")),
          ),
        ),
      )
      .handle("syncPush", (args) =>
        withWrite(
          args.endpoint.name,
          requireFlag.pipe(
            Effect.andThen(sync.applyPush(args.payload.entries, args.payload.tombstones ?? [])),
            Effect.catchTag("CliProxySyncNotConfigured", () => unavailable("sync-not-configured")),
          ),
        ),
      )
      .handle("syncStatus", (args) => withRead(args.endpoint.name, sync.status));
  }),
);

/**
 * The routes for `server.ts`. Every service below is memoized with the
 * instance `ServerEnvironment.layer` already built, so no second sidecar spawns.
 */
export const cliProxyRoutesLayer = HttpApiBuilder.layer(CliProxyHttpApi).pipe(
  Layer.provide(cliProxyHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer),
  Layer.provide(CliProxySync.layer),
  Layer.provide(CliProxy.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(ForkFlags.layer),
  Layer.provide(ServerSecretStore.layer),
);

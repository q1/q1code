import * as NodeServices from "@effect/platform-node/NodeServices";
import { PrismHttpApi, type PrismSyncEntry } from "@q1code/core/prismApi";
import { DEFAULT_FORK_FLAGS, type ForkFlagValues } from "@q1code/core/flags";
import {
  AuthAdministrativeScopes,
  type AuthEnvironmentScope,
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthInvalidError,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { decodeForkConfig } from "@q1code/core/config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  Etag,
  HttpClientRequest,
  HttpClientResponse,
  HttpPlatform,
  HttpServerRequest,
} from "effect/unstable/http";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";

import * as ServerConfig from "../../config.ts";
import { ForkConfigWriteError, ForkFlagsService, type RawForkConfig } from "../ForkFlags.ts";
import { prismHttpApiLayer } from "./PrismHttpApi.ts";
import { PrismService, type PrismStatus } from "./PrismService.ts";
import { PrismSyncNotConfigured, PrismSyncService } from "./PrismSync.ts";

interface SidecarCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** A scripted sidecar: `respond` maps `<METHOD> <path>` to a JSON body and status. */
const makeSidecar = (
  status: PrismStatus,
  respond: (method: string, path: string) => { readonly status?: number; readonly body: unknown },
  overrides: Partial<PrismService["Service"]> = {},
) => {
  const calls: Array<SidecarCall> = [];
  const layer = Layer.succeed(
    PrismService,
    PrismService.of({
      status: Effect.succeed(status),
      changes: Stream.empty,
      endpoint: Effect.succeed(Option.none()),
      // Answers with the status a restart would have settled on.
      restart: Effect.succeed({ ...status, restarts: status.restarts + 1 }),
      reloadUsageSource: Effect.succeed(status),
      management: {
        request: (path, options) =>
          Effect.sync(() => {
            const method = options?.method ?? "GET";
            // The body is inspected as wire JSON, not decoded into a domain value.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            const body = options?.body === undefined ? undefined : JSON.parse(options.body);
            calls.push({ method, path, body });
            const reply = respond(method, path);
            return HttpClientResponse.fromWeb(
              HttpClientRequest.get(`http://sidecar${path}`),
              Response.json(reply.body, { status: reply.status ?? 200 }),
            );
          }),
      },
      codexProxyHomePath: "/unused",
      ...overrides,
    }),
  );
  return { layer, calls };
};

/** Sync that is not configured; `tombstones` collects what `DELETE accounts/:id` records. */
const tombstones: Array<string> = [];
const syncLayer = Layer.succeed(
  PrismSyncService,
  PrismSyncService.of({
    status: Effect.succeed({ role: "standalone" as const }),
    changes: Stream.empty,
    exportBundle: Effect.fail(new PrismSyncNotConfigured({ message: "no sync" })),
    applyPush: (_entries: ReadonlyArray<PrismSyncEntry>) =>
      Effect.fail(new PrismSyncNotConfigured({ message: "no sync" })),
    syncNow: Effect.void,
    recordTombstone: (id) =>
      Effect.sync(() => {
        tombstones.push(id);
      }),
  }),
);

/** Flags with an in-memory `fork.json`: `raw` is what `update` would have written. */
const makeFlags = (prism: boolean, initial: RawForkConfig = {}) => {
  const values: ForkFlagValues = { ...DEFAULT_FORK_FLAGS, prism };
  const file = { raw: initial };
  const layer = Layer.succeed(
    ForkFlagsService,
    ForkFlagsService.of({
      current: Effect.succeed(values),
      reload: Effect.succeed(values),
      changes: Stream.empty,
      config: Effect.succeed({}),
      update: (mutate) =>
        Effect.suspend(() => {
          const next = mutate(file.raw);
          const decoded = decodeForkConfig(next);
          if (Exit.isFailure(decoded)) {
            return Effect.fail(
              new ForkConfigWriteError({ path: "fork.json", reason: "invalid", detail: "test" }),
            );
          }
          file.raw = next;
          return Effect.succeed(decoded.value);
        }),
    }),
  );
  return { layer, file };
};

/** `Bearer read` carries the standard scopes, `Bearer admin` the administrative ones, anything else is 401. */
const authLayer = Layer.succeed(EnvironmentAuthenticatedAuth, (httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const scopes: ReadonlyArray<AuthEnvironmentScope> | undefined =
      request.headers.authorization === "Bearer admin"
        ? AuthAdministrativeScopes
        : request.headers.authorization === "Bearer read"
          ? AuthStandardClientScopes
          : undefined;
    if (scopes === undefined) {
      return yield* new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "missing_credential",
        traceId: "test",
      });
    }
    return yield* httpEffect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("session-1"),
        subject: "test",
        method: "bearer-access-token",
        scopes: new Set(scopes),
      }),
    );
  }),
);

const SINCE = "2026-09-02T09:00:00.000Z";
const READY: PrismStatus = {
  state: "ready",
  mode: "sidecar",
  port: 8317,
  since: SINCE,
  restarts: 0,
  version: "7.2.147",
  pid: 42,
  baseUrl: "http://127.0.0.1:8317",
  usageSource: true,
};
const OFF: PrismStatus = {
  state: "off",
  mode: "sidecar",
  port: 8317,
  since: SINCE,
  restarts: 0,
  usageSource: true,
};

const listing = [
  {
    id: "codex-a@example.com.json",
    name: "codex-a@example.com.json",
    type: "codex",
    provider: "codex",
    label: "",
    email: "a@example.com",
    disabled: false,
    weight: 3,
    updated_at: "2026-09-02T10:00:00.123456789Z",
    success: 12,
    failed: 1,
    quota: { observed_at: "2026-09-02T09:30:00Z", signals: { "5h": "ok" } },
  },
  {
    name: "claude-b.json",
    type: "claude",
    disabled: true,
    modtime: "2026-09-02T11:00:00Z",
    success: 0,
    failed: 0,
    quota: { signals: {} },
  },
  { name: ".oauth-anthropic-x.oauth", type: "" },
];

const makeClient = (
  sidecar: ReturnType<typeof makeSidecar>,
  options: { readonly flag?: boolean; readonly flags?: ReturnType<typeof makeFlags> } = {},
) =>
  HttpApiTest.groups(PrismHttpApi, ["prism"]).pipe(
    Effect.provide(
      prismHttpApiLayer.pipe(
        Layer.provide(sidecar.layer),
        Layer.provide(syncLayer),
        Layer.provide((options.flags ?? makeFlags(options.flag ?? true)).layer),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "q1code-prism-http-" })),
        Layer.provideMerge(authLayer),
        Layer.provideMerge(Layer.mergeAll(HttpPlatform.layer, Etag.layerWeak)),
      ),
    ),
  );

const admin = { headers: { authorization: "Bearer admin" } };
const read = { headers: { authorization: "Bearer read" } };

it.layer(NodeServices.layer, { excludeTestServices: true })("PrismHttpApi", (it) => {
  it.effect("status answers without the sidecar and rejects a missing credential", () =>
    Effect.gen(function* () {
      const client = yield* makeClient(makeSidecar(OFF, () => ({ body: {} })));
      const status = yield* client.prism.status(read);
      assert.deepEqual(status, {
        state: "off",
        port: 8317,
        role: "standalone",
        mode: "sidecar",
        restarts: 0,
        since: SINCE,
        usageSource: true,
      });
      const unauthenticated = yield* client.prism.status({ headers: {} }).pipe(Effect.flip);
      assert.equal(unauthenticated._tag, "EnvironmentAuthInvalidError");
    }),
  );

  it.effect("every proxied endpoint is 503 with the state while the sidecar is not ready", () =>
    Effect.gen(function* () {
      const sidecar = makeSidecar(OFF, () => ({ body: {} }));
      const client = yield* makeClient(sidecar, { flag: false });
      const exit = yield* client.prism.listAccounts(read).pipe(Effect.flip);
      assert.equal(exit._tag, "PrismUnavailableError");
      assert.isTrue(exit._tag === "PrismUnavailableError" && exit.reason === "flag-off");
      assert.isTrue(exit._tag === "PrismUnavailableError" && exit.state === "off");
      const sync = yield* client.prism.syncExport(admin).pipe(Effect.flip);
      assert.equal(sync._tag, "PrismUnavailableError");
      assert.deepEqual(sidecar.calls, []);
    }),
  );

  it.effect("status carries the proxy mode, origin, restarts, and last error", () =>
    Effect.gen(function* () {
      const external: PrismStatus = {
        state: "failed",
        mode: "external",
        port: 8317,
        since: SINCE,
        restarts: 2,
        lastError: "connect ECONNREFUSED",
        usageSource: true,
      };
      const client = yield* makeClient(makeSidecar(external, () => ({ body: {} })));
      const status = yield* client.prism.status(read);
      assert.deepEqual(status, {
        state: "failed",
        port: 8317,
        role: "standalone",
        mode: "external",
        lastError: "connect ECONNREFUSED",
        restarts: 2,
        since: SINCE,
        usageSource: true,
      });
      const ready = yield* makeClient(makeSidecar(READY, () => ({ body: {} })));
      assert.equal((yield* ready.prism.status(read)).baseUrl, "http://127.0.0.1:8317");
    }),
  );

  it.effect("restart needs the flag and access:write, then answers with the settled status", () =>
    Effect.gen(function* () {
      const off = yield* makeClient(
        makeSidecar(OFF, () => ({ body: {} })),
        { flag: false },
      );
      const unavailable = yield* off.prism.restart(admin).pipe(Effect.flip);
      assert.equal(unavailable._tag, "PrismUnavailableError");
      assert.isTrue(
        unavailable._tag === "PrismUnavailableError" && unavailable.reason === "flag-off",
      );

      const client = yield* makeClient(makeSidecar(READY, () => ({ body: {} })));
      const forbidden = yield* client.prism.restart(read).pipe(Effect.flip);
      assert.equal(forbidden._tag, "EnvironmentScopeRequiredError");

      const status = yield* client.prism.restart(admin);
      assert.equal(status.state, "ready");
      assert.equal(status.mode, "sidecar");
      assert.equal(status.restarts, 1);
      assert.equal(status.role, "standalone");
    }),
  );

  it.effect("lists accounts mapped from the sidecar's auth files", () =>
    Effect.gen(function* () {
      const client = yield* makeClient(makeSidecar(READY, () => ({ body: { files: listing } })));
      const { accounts } = yield* client.prism.listAccounts(read);
      assert.deepEqual(accounts, [
        {
          id: "codex-a@example.com.json",
          provider: "codex",
          label: "a@example.com",
          email: "a@example.com",
          disabled: false,
          weight: 3,
          updatedAt: "2026-09-02T10:00:00.123Z",
          usage: {
            success: 12,
            failed: 1,
            quota: { observedAt: "2026-09-02T09:30:00.000Z", signals: { "5h": "ok" } },
          },
        },
        {
          id: "claude-b.json",
          provider: "claude",
          label: "claude-b",
          disabled: true,
          updatedAt: "2026-09-02T11:00:00.000Z",
          usage: { success: 0, failed: 0 },
        },
      ]);
    }),
  );

  it.effect("exposes safe lifecycle observations and omits invalid or unknown expiry", () =>
    Effect.gen(function* () {
      const files = [
        {
          name: "codex.json",
          provider: "codex",
          updated_at: "2026-09-04T10:00:00Z",
          status: "error",
          unavailable: true,
          last_error_status: 401,
          expires_at: "2026-09-04T11:00:00Z",
          last_refresh: "2026-09-04T09:00:00Z",
          next_refresh_after: "2026-09-04T12:00:00Z",
          access_token: "private-access",
          refresh_token: "private-refresh",
          status_message: "private-error",
        },
        {
          name: "claude.json",
          provider: "claude",
          updated_at: "2026-09-04T10:00:00Z",
          expires_at: "invalid",
        },
      ];
      const client = yield* makeClient(makeSidecar(READY, () => ({ body: { files } })));
      const { accounts } = yield* client.prism.listAccounts(read);
      assert.deepEqual(accounts[0]?.lifecycle, {
        status: "error",
        unavailable: true,
        lastErrorStatus: 401,
        expiresAt: "2026-09-04T11:00:00.000Z",
        lastRefreshedAt: "2026-09-04T09:00:00.000Z",
        refreshNotBefore: "2026-09-04T12:00:00.000Z",
      });
      assert.isUndefined(accounts[1]?.lifecycle);
      assert.notProperty(accounts[0], "access_token");
      assert.notProperty(accounts[0], "refresh_token");
      assert.notProperty(accounts[0], "status_message");
    }),
  );

  it.effect("mutations need access:write and map to the sidecar's patch endpoints", () =>
    Effect.gen(function* () {
      const sidecar = makeSidecar(READY, (method, path) =>
        path === "/auth-files" ? { body: { files: listing } } : { body: { status: "ok" } },
      );
      const client = yield* makeClient(sidecar);
      const forbidden = yield* client.prism
        .patchAccount({ ...read, params: { id: "claude-b.json" }, payload: { disabled: false } })
        .pipe(Effect.flip);
      assert.equal(forbidden._tag, "EnvironmentScopeRequiredError");
      assert.deepEqual(sidecar.calls, []);

      const account = yield* client.prism.patchAccount({
        ...admin,
        params: { id: "claude-b.json" },
        payload: { disabled: false, weight: 2 },
      });
      assert.equal(account.id, "claude-b.json");
      assert.deepEqual(
        sidecar.calls.map((call) => [call.method, call.path, call.body]),
        [
          ["PATCH", "/auth-files/status", { name: "claude-b.json", disabled: false }],
          ["PATCH", "/auth-files/fields", { name: "claude-b.json", weight: 2 }],
          ["GET", "/auth-files", undefined],
        ],
      );

      sidecar.calls.length = 0;
      tombstones.length = 0;
      yield* client.prism.deleteAccount({ ...admin, params: { id: "claude-b.json" } });
      assert.deepEqual(sidecar.calls, [
        { method: "DELETE", path: "/auth-files?name=claude-b.json", body: undefined },
      ]);
      assert.deepEqual(tombstones, ["claude-b.json"]);
    }),
  );

  it.effect("turns the sidecar's 404 into a not-found error", () =>
    Effect.gen(function* () {
      const client = yield* makeClient(
        makeSidecar(READY, () => ({ status: 404, body: { error: "auth file not found" } })),
      );
      tombstones.length = 0;
      const missing = yield* client.prism
        .deleteAccount({ ...admin, params: { id: "gone.json" } })
        .pipe(Effect.flip);
      assert.equal(missing._tag, "PrismNotFoundError");
      assert.deepEqual(tombstones, []);
    }),
  );

  it.effect("runs a login: start, poll, complete with the new account, cancel", () =>
    Effect.gen(function* () {
      let files = listing.slice(0, 1);
      let authStatus = "wait";
      const sidecar = makeSidecar(READY, (method, path) => {
        if (path === "/auth-files") return { body: { files } };
        if (path.startsWith("/anthropic-auth-url"))
          return { body: { status: "ok", url: "https://claude.ai/oauth?x", state: "state-1" } };
        if (path.startsWith("/get-auth-status"))
          return { body: authStatus === "wait" ? { status: "wait" } : { status: authStatus } };
        if (path.startsWith("/oauth-session")) return { body: { status: "ok", cancelled: true } };
        return { body: { status: "ok" } };
      });
      const client = yield* makeClient(sidecar);
      const started = yield* client.prism.startLogin({
        ...admin,
        payload: { provider: "anthropic" },
      });
      assert.deepEqual(started, {
        sessionId: "state-1",
        authUrl: "https://claude.ai/oauth?x",
        flow: "redirect",
      });
      assert.equal(sidecar.calls.at(-1)?.path, "/anthropic-auth-url?is_webui=true");

      const pending = yield* client.prism.loginStatus({
        ...read,
        params: { sessionId: "state-1" },
      });
      assert.deepEqual(pending, { sessionId: "state-1", status: "pending" });

      files = listing.slice(0, 2);
      authStatus = "ok";
      const completed = yield* client.prism.loginStatus({
        ...read,
        params: { sessionId: "state-1" },
      });
      assert.deepEqual(completed, {
        sessionId: "state-1",
        status: "completed",
        accountId: "claude-b.json",
      });

      const cancelled = yield* client.prism.cancelLogin({
        ...admin,
        params: { sessionId: "state-1" },
      });
      assert.deepEqual(cancelled, { sessionId: "state-1", status: "cancelled" });
      assert.equal(sidecar.calls.at(-1)?.path, "/oauth-session?state=state-1");
      const afterCancel = yield* client.prism.loginStatus({
        ...read,
        params: { sessionId: "state-1" },
      });
      assert.equal(afterCancel.status, "cancelled");
    }),
  );

  it.effect("sets the routing strategy through PUT, persists it, and reads it back", () =>
    Effect.gen(function* () {
      let strategy = "round-robin";
      const sidecar = makeSidecar(READY, (method, path) => {
        if (path === "/routing/strategy" && method === "PUT") {
          strategy = "fill-first";
          return { body: {} };
        }
        return { body: { strategy } };
      });
      // Keys the schema does not know, next to the one that moves.
      const flags = makeFlags(true, {
        flags: { prism: true },
        prism: { port: 9001, routingStrategy: "round-robin" },
        somethingElse: { nested: true },
      });
      const client = yield* makeClient(sidecar, { flags });
      assert.deepEqual(yield* client.prism.getRouting(read), { strategy: "round-robin" });
      const updated = yield* client.prism.setRouting({
        ...admin,
        payload: { strategy: "fill-first" },
      });
      assert.deepEqual(updated, { strategy: "fill-first" });
      assert.deepEqual(sidecar.calls[1], {
        method: "PUT",
        path: "/routing/strategy",
        body: { value: "fill-first" },
      });
      assert.deepEqual(flags.file.raw, {
        flags: { prism: true },
        prism: { port: 9001, routingStrategy: "fill-first" },
        somethingElse: { nested: true },
      });
    }),
  );

  it.effect("answers 500 when the routing strategy cannot be persisted", () =>
    Effect.gen(function* () {
      const sidecar = makeSidecar(READY, () => ({ body: { strategy: "fill-first" } }));
      // A `prism` section the schema rejects makes the write fail validation.
      const flags = makeFlags(true, { prism: { port: "not-a-port" } });
      const client = yield* makeClient(sidecar, { flags });
      const failure = yield* client.prism
        .setRouting({ ...admin, payload: { strategy: "fill-first" } })
        .pipe(Effect.flip);
      assert.equal(failure._tag, "PrismConfigError");
      assert.deepEqual(flags.file.raw, { prism: { port: "not-a-port" } });
    }),
  );

  it.effect("toggles the usage source through PUT, persists it, and answers the status", () =>
    Effect.gen(function* () {
      const flags = makeFlags(true, {
        flags: { prism: true },
        prism: { port: 9001, routingStrategy: "round-robin" },
        somethingElse: { nested: true },
      });
      // The fake reload reads the toggle back from the file, as the real service does.
      const sidecar = makeSidecar(READY, () => ({ body: {} }), {
        reloadUsageSource: Effect.sync(() => {
          const prism = flags.file.raw.prism as { usageSource?: boolean } | undefined;
          return { ...READY, usageSource: prism?.usageSource ?? true };
        }),
      });
      const client = yield* makeClient(sidecar, { flags });
      const off = yield* client.prism.setUsageSource({ ...admin, payload: { enabled: false } });
      assert.equal(off.usageSource, false);
      assert.equal(off.state, "ready");
      assert.deepEqual(flags.file.raw, {
        flags: { prism: true },
        prism: { port: 9001, routingStrategy: "round-robin", usageSource: false },
        somethingElse: { nested: true },
      });
      const on = yield* client.prism.setUsageSource({ ...admin, payload: { enabled: true } });
      assert.equal(on.usageSource, true);
      assert.deepEqual((flags.file.raw.prism as { usageSource?: boolean }).usageSource, true);
      // Nothing goes to the sidecar: the toggle is a server-side setting.
      assert.deepEqual(sidecar.calls, []);
    }),
  );

  it.effect("usage-source PUT needs the flag and access:write", () =>
    Effect.gen(function* () {
      const flagsOff = makeFlags(false);
      const off = yield* makeClient(
        makeSidecar(OFF, () => ({ body: {} })),
        { flags: flagsOff },
      );
      const unavailable = yield* off.prism
        .setUsageSource({ ...admin, payload: { enabled: false } })
        .pipe(Effect.flip);
      assert.equal(unavailable._tag, "PrismUnavailableError");
      assert.isTrue(
        unavailable._tag === "PrismUnavailableError" && unavailable.reason === "flag-off",
      );
      assert.deepEqual(flagsOff.file.raw, {});

      const flags = makeFlags(true);
      const client = yield* makeClient(
        makeSidecar(READY, () => ({ body: {} })),
        { flags },
      );
      const forbidden = yield* client.prism
        .setUsageSource({ ...read, payload: { enabled: false } })
        .pipe(Effect.flip);
      assert.equal(forbidden._tag, "EnvironmentScopeRequiredError");
      assert.deepEqual(flags.file.raw, {});
    }),
  );

  it.effect("answers 500 when the usage source cannot be persisted", () =>
    Effect.gen(function* () {
      const flags = makeFlags(true, { prism: { port: "not-a-port" } });
      const client = yield* makeClient(
        makeSidecar(READY, () => ({ body: {} })),
        { flags },
      );
      const failure = yield* client.prism
        .setUsageSource({ ...admin, payload: { enabled: false } })
        .pipe(Effect.flip);
      assert.equal(failure._tag, "PrismConfigError");
      assert.deepEqual(flags.file.raw, { prism: { port: "not-a-port" } });
    }),
  );

  it.effect("relays sidecar failures as 502 with the sidecar's message", () =>
    Effect.gen(function* () {
      const client = yield* makeClient(
        makeSidecar(READY, () => ({
          status: 500,
          body: { error: "core auth manager unavailable" },
        })),
      );
      const failure = yield* client.prism.getRouting(read).pipe(Effect.flip);
      assert.equal(failure._tag, "PrismUpstreamError");
      assert.include(String(failure), "core auth manager unavailable");
    }),
  );
});

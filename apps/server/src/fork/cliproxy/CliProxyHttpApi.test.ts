import * as NodeServices from "@effect/platform-node/NodeServices";
import { CliProxyHttpApi, type CliProxySyncEntry } from "@q1code/core/cliproxyApi";
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
import * as Effect from "effect/Effect";
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
import { ForkFlagsService } from "../ForkFlags.ts";
import { cliProxyHttpApiLayer } from "./CliProxyHttpApi.ts";
import { CliProxyService, type CliProxyStatus } from "./CliProxyService.ts";
import { CliProxySyncNotConfigured, CliProxySyncService } from "./CliProxySync.ts";

interface SidecarCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** A scripted sidecar: `respond` maps `<METHOD> <path>` to a JSON body and status. */
const makeSidecar = (
  status: CliProxyStatus,
  respond: (method: string, path: string) => { readonly status?: number; readonly body: unknown },
) => {
  const calls: Array<SidecarCall> = [];
  const layer = Layer.succeed(
    CliProxyService,
    CliProxyService.of({
      status: Effect.succeed(status),
      changes: Stream.empty,
      endpoint: Effect.succeed(Option.none()),
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
    }),
  );
  return { layer, calls };
};

const syncLayer = Layer.succeed(
  CliProxySyncService,
  CliProxySyncService.of({
    status: Effect.succeed({ role: "standalone" as const }),
    changes: Stream.empty,
    exportBundle: Effect.fail(new CliProxySyncNotConfigured({ message: "no sync" })),
    applyPush: (_entries: ReadonlyArray<CliProxySyncEntry>) =>
      Effect.fail(new CliProxySyncNotConfigured({ message: "no sync" })),
    syncNow: Effect.void,
  }),
);

const flagsLayer = (cliproxy: boolean) => {
  const values: ForkFlagValues = { ...DEFAULT_FORK_FLAGS, cliproxy };
  return Layer.succeed(
    ForkFlagsService,
    ForkFlagsService.of({
      current: Effect.succeed(values),
      reload: Effect.succeed(values),
      changes: Stream.empty,
      config: Effect.succeed({}),
    }),
  );
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

const READY: CliProxyStatus = { state: "ready", port: 8317, version: "7.2.147", pid: 42 };
const OFF: CliProxyStatus = { state: "off", port: 8317 };

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
  },
  { name: "claude-b.json", type: "claude", disabled: true, modtime: "2026-09-02T11:00:00Z" },
  { name: ".oauth-anthropic-x.oauth", type: "" },
];

const makeClient = (
  sidecar: ReturnType<typeof makeSidecar>,
  options: { readonly flag?: boolean } = {},
) =>
  HttpApiTest.groups(CliProxyHttpApi, ["cliproxy"]).pipe(
    Effect.provide(
      cliProxyHttpApiLayer.pipe(
        Layer.provide(sidecar.layer),
        Layer.provide(syncLayer),
        Layer.provide(flagsLayer(options.flag ?? true)),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "q1code-cliproxy-http-" })),
        Layer.provideMerge(authLayer),
        Layer.provideMerge(Layer.mergeAll(HttpPlatform.layer, Etag.layerWeak)),
      ),
    ),
  );

const admin = { headers: { authorization: "Bearer admin" } };
const read = { headers: { authorization: "Bearer read" } };

it.layer(NodeServices.layer, { excludeTestServices: true })("CliProxyHttpApi", (it) => {
  it.effect("status answers without the sidecar and rejects a missing credential", () =>
    Effect.gen(function* () {
      const client = yield* makeClient(makeSidecar(OFF, () => ({ body: {} })));
      const status = yield* client.cliproxy.status(read);
      assert.deepEqual(status, { state: "off", port: 8317, role: "standalone" });
      const unauthenticated = yield* client.cliproxy.status({ headers: {} }).pipe(Effect.flip);
      assert.equal(unauthenticated._tag, "EnvironmentAuthInvalidError");
    }),
  );

  it.effect("every proxied endpoint is 503 with the state while the sidecar is not ready", () =>
    Effect.gen(function* () {
      const sidecar = makeSidecar(OFF, () => ({ body: {} }));
      const client = yield* makeClient(sidecar, { flag: false });
      const exit = yield* client.cliproxy.listAccounts(read).pipe(Effect.flip);
      assert.equal(exit._tag, "CliProxyUnavailableError");
      assert.isTrue(exit._tag === "CliProxyUnavailableError" && exit.reason === "flag-off");
      assert.isTrue(exit._tag === "CliProxyUnavailableError" && exit.state === "off");
      const sync = yield* client.cliproxy.syncExport(admin).pipe(Effect.flip);
      assert.equal(sync._tag, "CliProxyUnavailableError");
      assert.deepEqual(sidecar.calls, []);
    }),
  );

  it.effect("lists accounts mapped from the sidecar's auth files", () =>
    Effect.gen(function* () {
      const client = yield* makeClient(makeSidecar(READY, () => ({ body: { files: listing } })));
      const { accounts } = yield* client.cliproxy.listAccounts(read);
      assert.deepEqual(accounts, [
        {
          id: "codex-a@example.com.json",
          provider: "codex",
          label: "a@example.com",
          email: "a@example.com",
          disabled: false,
          weight: 3,
          updatedAt: "2026-09-02T10:00:00.123Z",
        },
        {
          id: "claude-b.json",
          provider: "claude",
          label: "claude-b",
          disabled: true,
          updatedAt: "2026-09-02T11:00:00.000Z",
        },
      ]);
    }),
  );

  it.effect("mutations need access:write and map to the sidecar's patch endpoints", () =>
    Effect.gen(function* () {
      const sidecar = makeSidecar(READY, (method, path) =>
        path === "/auth-files" ? { body: { files: listing } } : { body: { status: "ok" } },
      );
      const client = yield* makeClient(sidecar);
      const forbidden = yield* client.cliproxy
        .patchAccount({ ...read, params: { id: "claude-b.json" }, payload: { disabled: false } })
        .pipe(Effect.flip);
      assert.equal(forbidden._tag, "EnvironmentScopeRequiredError");
      assert.deepEqual(sidecar.calls, []);

      const account = yield* client.cliproxy.patchAccount({
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
      yield* client.cliproxy.deleteAccount({ ...admin, params: { id: "claude-b.json" } });
      assert.deepEqual(sidecar.calls, [
        { method: "DELETE", path: "/auth-files?name=claude-b.json", body: undefined },
      ]);
    }),
  );

  it.effect("turns the sidecar's 404 into a not-found error", () =>
    Effect.gen(function* () {
      const client = yield* makeClient(
        makeSidecar(READY, () => ({ status: 404, body: { error: "auth file not found" } })),
      );
      const missing = yield* client.cliproxy
        .deleteAccount({ ...admin, params: { id: "gone.json" } })
        .pipe(Effect.flip);
      assert.equal(missing._tag, "CliProxyNotFoundError");
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
      const started = yield* client.cliproxy.startLogin({
        ...admin,
        payload: { provider: "anthropic" },
      });
      assert.deepEqual(started, {
        sessionId: "state-1",
        authUrl: "https://claude.ai/oauth?x",
        flow: "redirect",
      });
      assert.equal(sidecar.calls.at(-1)?.path, "/anthropic-auth-url?is_webui=true");

      const pending = yield* client.cliproxy.loginStatus({
        ...read,
        params: { sessionId: "state-1" },
      });
      assert.deepEqual(pending, { sessionId: "state-1", status: "pending" });

      files = listing.slice(0, 2);
      authStatus = "ok";
      const completed = yield* client.cliproxy.loginStatus({
        ...read,
        params: { sessionId: "state-1" },
      });
      assert.deepEqual(completed, {
        sessionId: "state-1",
        status: "completed",
        accountId: "claude-b.json",
      });

      const cancelled = yield* client.cliproxy.cancelLogin({
        ...admin,
        params: { sessionId: "state-1" },
      });
      assert.deepEqual(cancelled, { sessionId: "state-1", status: "cancelled" });
      assert.equal(sidecar.calls.at(-1)?.path, "/oauth-session?state=state-1");
      const afterCancel = yield* client.cliproxy.loginStatus({
        ...read,
        params: { sessionId: "state-1" },
      });
      assert.equal(afterCancel.status, "cancelled");
    }),
  );

  it.effect("sets the routing strategy through PUT and reads it back", () =>
    Effect.gen(function* () {
      let strategy = "round-robin";
      const sidecar = makeSidecar(READY, (method, path) => {
        if (path === "/routing/strategy" && method === "PUT") {
          strategy = "fill-first";
          return { body: {} };
        }
        return { body: { strategy } };
      });
      const client = yield* makeClient(sidecar);
      assert.deepEqual(yield* client.cliproxy.getRouting(read), { strategy: "round-robin" });
      const updated = yield* client.cliproxy.setRouting({
        ...admin,
        payload: { strategy: "fill-first" },
      });
      assert.deepEqual(updated, { strategy: "fill-first" });
      assert.deepEqual(sidecar.calls[1], {
        method: "PUT",
        path: "/routing/strategy",
        body: { value: "fill-first" },
      });
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
      const failure = yield* client.cliproxy.getRouting(read).pipe(Effect.flip);
      assert.equal(failure._tag, "CliProxyUpstreamError");
      assert.include(String(failure), "core auth manager unavailable");
    }),
  );
});

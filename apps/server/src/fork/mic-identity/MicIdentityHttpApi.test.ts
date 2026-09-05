import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_FORK_FLAGS } from "@q1code/core/flags";
import type { ForkConfig } from "@q1code/core/config";
import {
  MIC_IDENTITY_API_PATHS,
  MIC_IDENTITY_SESSION_HEADER,
  MIC_PRISM_PERMISSIONS,
  normalizeMicIdentity,
  type MicIdentityWire,
  type MicPrismDiscoveryWire,
} from "@q1code/core/micIdentity";
import { PrismHttpApi } from "@q1code/core/prismApi";
import {
  AuthAdministrativeScopes,
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthInvalidError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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
import { prismHttpApiLayer } from "../prism/PrismHttpApi.ts";
import { PrismService, type PrismStatus } from "../prism/PrismService.ts";
import { PrismSyncNotConfigured, PrismSyncService } from "../prism/PrismSync.ts";
import { MicIdentityFetch } from "./MicIdentityAccess.ts";

const apiUrl = "https://prism.example.test";
const SESSION: MicIdentityWire = {
  contractVersion: 1,
  subject: "user-1",
  role: "member",
  permissions: ["prism:inference"],
  authorizationRevision: "revision-1",
  authorizationExpiresAt: 4_070_908_800_000,
};
const MANAGER: MicIdentityWire = {
  ...SESSION,
  permissions: [...MIC_PRISM_PERMISSIONS],
};
const DISCOVERY: MicPrismDiscoveryWire = {
  contractVersion: 1,
  selectionRevision: 1,
  service: {
    serviceInstanceId: "prism-pc",
    displayName: "Paired PC",
    apiOrigin: apiUrl,
    inferenceOrigin: apiUrl,
    pairingRevision: 1,
    protocolVersion: 1,
    publicKey: "A".repeat(43),
    status: "paired",
  },
};
const READY: PrismStatus = {
  state: "ready",
  mode: "external",
  port: 8317,
  since: "2026-09-04T00:00:00.000Z",
  restarts: 0,
  version: "7.2.151-prism.1",
  baseUrl: apiUrl,
  usageSource: true,
};
const signedIn = {
  headers: { authorization: "Bearer read", [MIC_IDENTITY_SESSION_HEADER]: "test-mic-session" },
};
const environmentAdmin = {
  headers: { ...signedIn.headers, authorization: "Bearer admin" },
};

const assertUnsupported = (error: { readonly _tag: string; readonly reason?: unknown }) => {
  assert.equal(error._tag, "MicIdentityUnavailableError");
  assert.equal(error.reason, "unsupported-operation");
};

// Environment auth is intentionally independent of the scripted mic.sc authority.
const authLayer = Layer.succeed(EnvironmentAuthenticatedAuth, (httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const scopes =
      request.headers.authorization === "Bearer admin"
        ? AuthAdministrativeScopes
        : request.headers.authorization === "Bearer read"
          ? AuthStandardClientScopes
          : undefined;
    if (!scopes)
      return yield* new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "missing_credential",
        traceId: "test",
      });
    return yield* httpEffect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("environment-session"),
        subject: "environment-user",
        method: "bearer-access-token",
        scopes: new Set(scopes),
      }),
    );
  }),
);

const makeFixture = (
  options: {
    session?: MicIdentityWire;
    identityEnabled?: boolean;
    configuredApiUrl?: string;
  } = {},
) => {
  const state = {
    session: { status: 200, body: options.session ?? (SESSION as unknown) },
    discovery: { status: 200, body: DISCOVERY as unknown },
    transportFailure: false,
    stalledBody: false,
    restarts: 0,
    syncExports: 0,
    syncPushes: 0,
    flagWrites: 0,
  };
  const bodyStarted = Promise.withResolvers<void>();
  const authorityCalls: Array<{ path: string; authorization: string | null }> = [];
  const authorityFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      authorityCalls.push({ path, authorization: new Headers(init?.headers).get("authorization") });
      if (state.transportFailure) throw new Error("Authority offline");
      const response = path === MIC_IDENTITY_API_PATHS.session ? state.session : state.discovery;
      const result = Response.json(response.body, { status: response.status });
      return state.stalledBody
        ? Object.assign(result, {
            json: () => {
              bodyStarted.resolve();
              return new Promise<unknown>(() => {});
            },
          })
        : result;
    },
    { preconnect: () => {} },
  );
  const engineCalls: Array<string> = [];
  const proxyLayer = Layer.succeed(
    PrismService,
    PrismService.of({
      status: Effect.succeed(READY),
      changes: Stream.empty,
      endpoint: Effect.succeed(Option.none()),
      restart: Effect.sync(() => {
        state.restarts++;
        return READY;
      }),
      reloadUsageSource: Effect.succeed(READY),
      codexProxyHomePath: "/unused",
      management: {
        request: (path, request) =>
          Effect.sync(() => {
            engineCalls.push(`${request?.method ?? "GET"} ${path}`);
            const body =
              path === "/auth-files"
                ? {
                    files: [
                      {
                        name: "account.json",
                        type: "codex",
                        email: "private@example.test",
                        disabled: true,
                      },
                    ],
                  }
                : path === "/routing/strategy"
                  ? { strategy: "round-robin" }
                  : {};
            return HttpClientResponse.fromWeb(
              HttpClientRequest.get(`${apiUrl}${path}`),
              Response.json(body),
            );
          }),
      },
    }),
  );
  const config: ForkConfig = {
    prism: { mode: "external", external: { baseUrl: options.configuredApiUrl ?? apiUrl } },
    "mic-identity": {
      authorityUrl: "https://identity.example.test",
      clerkPublishableKey: "pk_test_fixture",
    },
  };
  const flags = {
    ...DEFAULT_FORK_FLAGS,
    prism: true,
    "mic-identity": options.identityEnabled ?? true,
  };
  const flagsLayer = Layer.succeed(
    ForkFlagsService,
    ForkFlagsService.of({
      current: Effect.succeed(flags),
      reload: Effect.succeed(flags),
      changes: Stream.empty,
      config: Effect.succeed(config),
      update: () =>
        Effect.sync(() => {
          state.flagWrites++;
          return config;
        }),
    }),
  );
  const syncLayer = Layer.succeed(
    PrismSyncService,
    PrismSyncService.of({
      status: Effect.succeed({ role: "standalone" }),
      changes: Stream.empty,
      exportBundle: Effect.sync(() => {
        state.syncExports++;
      }).pipe(
        Effect.andThen(Effect.fail(new PrismSyncNotConfigured({ message: "not configured" }))),
      ),
      applyPush: () =>
        Effect.sync(() => {
          state.syncPushes++;
        }).pipe(
          Effect.andThen(Effect.fail(new PrismSyncNotConfigured({ message: "not configured" }))),
        ),
      syncNow: Effect.void,
      recordTombstone: () => Effect.void,
    }),
  );
  const client = HttpApiTest.groups(PrismHttpApi, ["prism"]).pipe(
    Effect.provide(
      prismHttpApiLayer.pipe(
        Layer.provide(proxyLayer),
        Layer.provide(syncLayer),
        Layer.provide(flagsLayer),
        Layer.provide(Layer.succeed(MicIdentityFetch, authorityFetch)),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "q1code-mic-identity-http-" }),
        ),
        Layer.provideMerge(authLayer),
        Layer.provideMerge(Layer.mergeAll(HttpPlatform.layer, Etag.layerWeak)),
      ),
    ),
  );
  return { client, state, authorityCalls, engineCalls, bodyStarted: bodyStarted.promise };
};

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "mic.sc Prism HTTP authorization",
  (it) => {
    it.effect(
      "ordinary users see redacted status but cannot read account details or mutate the pool",
      () =>
        Effect.gen(function* () {
          const fixture = makeFixture();
          const client = yield* fixture.client;
          const status = yield* client.prism.status(signedIn);
          assert.deepEqual(status, {
            state: "ready",
            port: 0,
            role: "standalone",
            capabilities: normalizeMicIdentity(SESSION).capabilities,
          });
          const details = yield* client.prism.listAccounts(signedIn).pipe(Effect.flip);
          assert.equal(details._tag, "MicIdentityForbiddenError");
          const mutation = yield* client.prism
            .deleteAccount({ ...environmentAdmin, params: { id: "account.json" } })
            .pipe(Effect.flip);
          assert.equal(mutation._tag, "MicIdentityForbiddenError");
          assert.deepEqual(fixture.engineCalls, []);
          assert.isTrue(
            fixture.authorityCalls.every(
              (call) => call.authorization === "Bearer test-mic-session",
            ),
          );
        }),
    );

    it.effect(
      "a Prism manager cannot use a mic.sc grant through the shared-key legacy account proxy",
      () =>
        Effect.gen(function* () {
          const fixture = makeFixture({ session: MANAGER });
          const client = yield* fixture.client;
          const error = yield* client.prism
            .patchAccount({
              ...signedIn,
              params: { id: "account.json" },
              payload: { disabled: true },
            })
            .pipe(Effect.flip);
          assertUnsupported(error);
          assert.deepEqual(fixture.engineCalls, []);
          assert.equal(MANAGER.role, "member");
        }),
    );

    it.effect(
      "even combined Prism and environment administration cannot reach legacy management",
      () =>
        Effect.gen(function* () {
          const fixture = makeFixture({ session: MANAGER });
          const client = yield* fixture.client;
          const login = { ...environmentAdmin, params: { sessionId: "fixture-login" } };
          const failures = [
            yield* client.prism.listAccounts(environmentAdmin).pipe(Effect.flip),
            yield* client.prism
              .startLogin({ ...environmentAdmin, payload: { provider: "codex" } })
              .pipe(Effect.flip),
            yield* client.prism.loginStatus(login).pipe(Effect.flip),
            yield* client.prism.cancelLogin(login).pipe(Effect.flip),
            yield* client.prism
              .loginCallback({ ...login, payload: { redirectUrl: "http://localhost/callback" } })
              .pipe(Effect.flip),
            yield* client.prism
              .deleteAccount({ ...environmentAdmin, params: { id: "account.json" } })
              .pipe(Effect.flip),
            yield* client.prism.restart(environmentAdmin).pipe(Effect.flip),
            yield* client.prism.syncExport(environmentAdmin).pipe(Effect.flip),
            yield* client.prism
              .syncPush({ ...environmentAdmin, payload: { entries: [] } })
              .pipe(Effect.flip),
            yield* client.prism.syncStatus(environmentAdmin).pipe(Effect.flip),
            yield* client.prism
              .setUsageSource({ ...environmentAdmin, payload: { enabled: false } })
              .pipe(Effect.flip),
            yield* client.prism.getUsage(environmentAdmin).pipe(Effect.flip),
          ];
          for (const error of failures) assertUnsupported(error);
          assert.deepEqual(fixture.engineCalls, []);
          assert.equal(fixture.state.restarts, 0);
          assert.equal(fixture.state.syncExports, 0);
          assert.equal(fixture.state.syncPushes, 0);
          assert.equal(fixture.state.flagWrites, 0);
        }),
    );

    it.effect(
      "Prism management grants do not authorize environment restart, sync, or local settings",
      () =>
        Effect.gen(function* () {
          const fixture = makeFixture({ session: MANAGER });
          const client = yield* fixture.client;
          const restart = yield* client.prism.restart(signedIn).pipe(Effect.flip);
          const syncExport = yield* client.prism.syncExport(signedIn).pipe(Effect.flip);
          const syncPush = yield* client.prism
            .syncPush({ ...signedIn, payload: { entries: [] } })
            .pipe(Effect.flip);
          const usageSource = yield* client.prism
            .setUsageSource({ ...signedIn, payload: { enabled: false } })
            .pipe(Effect.flip);
          for (const error of [restart, syncExport, syncPush, usageSource])
            assert.equal(error._tag, "EnvironmentScopeRequiredError");
          assert.equal(fixture.state.restarts, 0);
          assert.equal(fixture.state.syncExports, 0);
          assert.equal(fixture.state.syncPushes, 0);
          assert.equal(fixture.state.flagWrites, 0);
        }),
    );

    it.effect(
      "granted legacy routing is unsupported while missing account grants remain forbidden",
      () =>
        Effect.gen(function* () {
          const fixture = makeFixture({
            session: {
              ...SESSION,
              permissions: ["prism:inference", "prism:routing:read", "prism:routing:write"],
            },
          });
          const client = yield* fixture.client;
          assertUnsupported(yield* client.prism.getRouting(signedIn).pipe(Effect.flip));
          assertUnsupported(
            yield* client.prism
              .setRouting({ ...signedIn, payload: { strategy: "round-robin" } })
              .pipe(Effect.flip),
          );
          const before = fixture.engineCalls.length;
          const error = yield* client.prism
            .deleteAccount({ ...signedIn, params: { id: "account.json" } })
            .pipe(Effect.flip);
          assert.equal(error._tag, "MicIdentityForbiddenError");
          assert.equal(before, 0);
          assert.equal(fixture.engineCalls.length, 0);
        }),
    );

    it.effect(
      "account read and write grants remain distinct from each other and from routing",
      () =>
        Effect.gen(function* () {
          const fixture = makeFixture({
            session: { ...SESSION, permissions: ["prism:inference", "prism:accounts:write"] },
          });
          const client = yield* fixture.client;
          assertUnsupported(
            yield* client.prism
              .deleteAccount({ ...signedIn, params: { id: "account.json" } })
              .pipe(Effect.flip),
          );
          assert.equal(
            (yield* client.prism.listAccounts(signedIn).pipe(Effect.flip))._tag,
            "MicIdentityForbiddenError",
          );
          fixture.state.session.body = {
            ...SESSION,
            permissions: ["prism:inference", "prism:accounts:read"],
          };
          assertUnsupported(yield* client.prism.listAccounts(signedIn).pipe(Effect.flip));
          assert.equal(
            (yield* client.prism.getRouting(signedIn).pipe(Effect.flip))._tag,
            "MicIdentityForbiddenError",
          );
          assert.equal(
            (yield* client.prism
              .deleteAccount({ ...signedIn, params: { id: "account.json" } })
              .pipe(Effect.flip))._tag,
            "MicIdentityForbiddenError",
          );
          assert.deepEqual(fixture.engineCalls, []);
        }),
    );

    it.effect("mic.sc identity alone never grants environment access", () =>
      Effect.gen(function* () {
        const fixture = makeFixture({ session: MANAGER });
        const client = yield* fixture.client;
        const error = yield* client.prism
          .status({ headers: { [MIC_IDENTITY_SESSION_HEADER]: "test-mic-session" } })
          .pipe(Effect.flip);
        assert.equal(error._tag, "EnvironmentAuthInvalidError");
        assert.deepEqual(fixture.authorityCalls, []);
        assert.deepEqual(fixture.engineCalls, []);
      }),
    );

    it.effect(
      "a missing identity session rejects an environment administrator before authority or engine access",
      () =>
        Effect.gen(function* () {
          const fixture = makeFixture({ session: MANAGER });
          const client = yield* fixture.client;
          const error = yield* client.prism
            .listAccounts({ headers: { authorization: "Bearer admin" } })
            .pipe(Effect.flip);
          assert.equal(error._tag, "MicIdentityUnauthorizedError");
          assert.deepEqual(fixture.authorityCalls, []);
          assert.deepEqual(fixture.engineCalls, []);
        }),
    );

    it.effect(
      "grant revocation is checked on the next request with the same identity and environment tokens",
      () =>
        Effect.gen(function* () {
          const fixture = makeFixture({ session: MANAGER });
          const client = yield* fixture.client;
          assertUnsupported(
            yield* client.prism
              .deleteAccount({ ...signedIn, params: { id: "account.json" } })
              .pipe(Effect.flip),
          );
          fixture.state.session.body = { ...SESSION, authorizationRevision: "revision-2" };
          const error = yield* client.prism
            .deleteAccount({ ...signedIn, params: { id: "account.json" } })
            .pipe(Effect.flip);
          assert.equal(error._tag, "MicIdentityForbiddenError");
          assert.equal(
            fixture.authorityCalls.filter((call) => call.path === MIC_IDENTITY_API_PATHS.session)
              .length,
            2,
          );
          assert.equal(fixture.engineCalls.length, 0);
        }),
    );

    it.effect("expired and malformed authority sessions fail closed", () =>
      Effect.gen(function* () {
        for (const [body, expected] of [
          [{ ...MANAGER, authorizationExpiresAt: 1 }, "MicIdentityUnauthorizedError"],
          [{ ...MANAGER, authorizationExpiresAt: "tomorrow" }, "MicIdentityUnavailableError"],
          [{ ...MANAGER, permissions: [true] }, "MicIdentityUnavailableError"],
          [{ ...MANAGER, contractVersion: 2 }, "MicIdentityUnavailableError"],
        ] as const) {
          const fixture = makeFixture();
          fixture.state.session.body = body;
          const client = yield* fixture.client;
          const error = yield* client.prism.listAccounts(signedIn).pipe(Effect.flip);
          assert.equal(error._tag, expected);
          assert.deepEqual(fixture.engineCalls, []);
          assert.equal(fixture.authorityCalls.length, 1);
        }
      }),
    );

    it.effect("authority rejection and transport failures never reuse earlier permissions", () =>
      Effect.gen(function* () {
        for (const status of [401, 403, 503]) {
          const fixture = makeFixture({ session: MANAGER });
          const client = yield* fixture.client;
          yield* client.prism.status(signedIn);
          fixture.state.session.status = status;
          const error = yield* client.prism.listAccounts(signedIn).pipe(Effect.flip);
          assert.equal(
            error._tag,
            status === 401
              ? "MicIdentityUnauthorizedError"
              : status === 403
                ? "MicIdentityForbiddenError"
                : "MicIdentityUnavailableError",
          );
          assert.equal(fixture.engineCalls.length, 0);
          fixture.state.transportFailure = true;
          const offline = yield* client.prism.listAccounts(signedIn).pipe(Effect.flip);
          assert.equal(offline._tag, "MicIdentityUnavailableError");
          assert.equal(fixture.engineCalls.length, 0);
        }
      }),
    );

    it.effect("a service association cannot authorize a different configured Prism host", () =>
      Effect.gen(function* () {
        const fixture = makeFixture({
          session: MANAGER,
          configuredApiUrl: "https://other.example.test",
        });
        const client = yield* fixture.client;
        const error = yield* client.prism.status(signedIn).pipe(Effect.flip);
        assert.equal(error._tag, "MicIdentityUnavailableError");
        if (error._tag === "MicIdentityUnavailableError")
          assert.equal(error.reason, "configuration");
        assert.deepEqual(fixture.engineCalls, []);
      }),
    );

    it.effect("an authority response whose body stalls times out without reaching Prism", () =>
      Effect.gen(function* () {
        const fixture = makeFixture({ session: MANAGER });
        fixture.state.stalledBody = true;
        const client = yield* fixture.client;
        const request = yield* client.prism
          .listAccounts(signedIn)
          .pipe(Effect.flip, Effect.forkChild);
        yield* Effect.promise(() => fixture.bodyStarted);
        yield* TestClock.adjust("11 seconds");
        const error = yield* Fiber.join(request);
        assert.equal(error._tag, "MicIdentityUnavailableError");
        assert.deepEqual(fixture.engineCalls, []);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect(
      "missing, revoked, and malformed service discovery never reach the configured gateway",
      () =>
        Effect.gen(function* () {
          for (const body of [
            { contractVersion: 1, selectionRevision: 1, service: null },
            { ...DISCOVERY, service: { ...DISCOVERY.service, status: "revoked" } },
            {
              ...DISCOVERY,
              service: { ...DISCOVERY.service, apiOrigin: "http://public.example.test" },
            },
          ]) {
            const fixture = makeFixture({ session: MANAGER });
            fixture.state.discovery.body = body;
            const client = yield* fixture.client;
            const error = yield* client.prism
              .deleteAccount({ ...signedIn, params: { id: "account.json" } })
              .pipe(Effect.flip);
            assert.equal(error._tag, "MicIdentityUnavailableError");
            assert.deepEqual(fixture.engineCalls, []);
          }
        }),
    );

    it.effect(
      "identity off preserves the existing status response and environment authorization",
      () =>
        Effect.gen(function* () {
          const fixture = makeFixture({ identityEnabled: false });
          fixture.state.transportFailure = true;
          const client = yield* fixture.client;
          const read = { headers: { authorization: "Bearer read" } };
          assert.deepEqual(yield* client.prism.status(read), {
            state: "ready",
            mode: "external",
            port: 8317,
            since: "2026-09-04T00:00:00.000Z",
            restarts: 0,
            version: "7.2.151-prism.1",
            baseUrl: apiUrl,
            usageSource: true,
            role: "standalone",
          });
          const accounts = yield* client.prism.listAccounts(read);
          assert.equal(accounts.accounts.length, 1);
          const error = yield* client.prism
            .deleteAccount({ ...read, params: { id: "account.json" } })
            .pipe(Effect.flip);
          assert.equal(error._tag, "EnvironmentScopeRequiredError");
          assert.deepEqual(fixture.authorityCalls, []);
        }),
    );
  },
);

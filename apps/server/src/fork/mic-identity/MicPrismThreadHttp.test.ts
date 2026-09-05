import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EMPTY_FORK_CONFIG } from "@q1code/core/config";
import { DEFAULT_FORK_FLAGS } from "@q1code/core/flags";
import { MIC_IDENTITY_SESSION_HEADER } from "@q1code/core/micIdentity";
import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest, HttpClient, FetchHttpClient } from "effect/unstable/http";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import { ForkFlagsService } from "../ForkFlags.ts";
import { publishPrismEnabled, publishPrismIdentityRequired } from "../prism/PrismEnvironment.ts";
import { MicIdentityFetch } from "./MicIdentityAccess.ts";
import {
  connectMicPrismThreadRequest,
  disconnectMicPrismThreadRequest,
} from "./MicPrismThreadHttp.ts";
import {
  authorizeMicPrismThread,
  closeAllMicPrismThreads,
  getMicPrismThreadEndpoint,
} from "./MicPrismThreads.ts";

const sessionLayer = () =>
  SessionStore.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("prism-http-test-environment")),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "q1-prism-thread-http-test-" })),
    Layer.provide(NodeServices.layer),
  );
const config = {
  ...EMPTY_FORK_CONFIG,
  "mic-identity": { authorityUrl: "https://authority.example.test", clerkPublishableKey: "" },
};
const flags = { ...DEFAULT_FORK_FLAGS, "mic-identity": true, prism: true };
const flagService = ForkFlagsService.of({
  current: Effect.succeed(flags),
  reload: Effect.succeed(flags),
  changes: Stream.empty,
  config: Effect.succeed(config),
  update: () => Effect.succeed(config),
});
const fakeToken = "fixture-clerk-session-jwt";
const fakeInferenceToken = "msp1.fixture.signature";
let sequence = 0;
const fixture = Effect.fn("test.prismThreadHttp.fixture")(function* (
  options: {
    readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
    readonly missingSid?: boolean;
    readonly credential?: Readonly<Record<string, unknown>>;
    readonly stallCredential?: boolean;
  } = {},
) {
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      publishPrismEnabled(true);
      publishPrismIdentityRequired(true);
    }),
    () =>
      Effect.promise(async () => {
        await closeAllMicPrismThreads();
        publishPrismEnabled(false);
        publishPrismIdentityRequired(false);
      }),
  );
  const sessions = yield* SessionStore.SessionStore;
  const issued = yield* sessions.issue({
    subject: "environment-actor",
    method: "bearer-access-token",
    scopes: options.scopes ?? [AuthOrchestrationOperateScope],
  });
  const verified = yield* sessions.verify(issued.token);
  const threadId = `thread-http-${++sequence}`;
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const expiresAt = now + 60_000;
  const calls: {
    path: string;
    method: string;
    correctAuthorization: boolean;
    hasEnvironmentToken: boolean;
    body: string | null;
  }[] = [];
  const credentialStarted = Promise.withResolvers<void>();
  const credentialAborted = Promise.withResolvers<void>();
  const authorityFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      calls.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        correctAuthorization: headers.get("authorization") === `Bearer ${fakeToken}`,
        hasEnvironmentToken: Array.from(headers.values()).some((value) =>
          value.includes(issued.token),
        ),
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (url.pathname === "/v1/identity")
        return Response.json({
          contractVersion: 1,
          subject: "mic-member",
          ...(options.missingSid ? {} : { sessionId: "clerk-session-one" }),
          role: "member",
          permissions: ["prism:inference"],
          authorizationRevision: "revision-current",
          authorizationExpiresAt: expiresAt,
        });
      if (url.pathname === "/v1/prism/discovery")
        return Response.json({
          contractVersion: 1,
          selectionRevision: 1,
          service: {
            serviceInstanceId: "prism-fixture",
            displayName: "PC fixture",
            apiOrigin: "https://prism.example.test",
            inferenceOrigin: "https://prism.example.test",
            pairingRevision: 1,
            protocolVersion: 1,
            publicKey: "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            status: "paired",
          },
        });
      if (url.pathname !== "/v1/prism/credentials") return new Response(null, { status: 404 });
      if (options.stallCredential) {
        credentialStarted.resolve();
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            credentialAborted.resolve();
            reject(new Error("fixture request cancelled"));
          };
          init?.signal?.addEventListener("abort", abort, { once: true });
          if (init?.signal?.aborted) abort();
        });
      }
      return Response.json({
        version: 1,
        tokenType: "Bearer",
        token: fakeInferenceToken,
        expiresAt,
        serviceInstanceId: "prism-fixture",
        pairingRevision: 1,
        ...options.credential,
      });
    },
    { preconnect: () => {} },
  );
  const provide = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    operation.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: verified.sessionId,
        subject: verified.subject,
        method: verified.method,
        scopes: new Set(verified.scopes),
      }),
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request("http://localhost/api/fork/prism/identity/threads/test", {
            headers: { [MIC_IDENTITY_SESSION_HEADER]: fakeToken },
          }),
        ),
      ),
      Effect.provideService(ForkFlagsService, flagService),
      Effect.provideService(MicIdentityFetch, authorityFetch),
    );
  return {
    threadId,
    sessions,
    issued,
    expiresAt,
    calls,
    credentialStarted,
    credentialAborted,
    connect: provide(connectMicPrismThreadRequest(threadId)),
    disconnect: provide(disconnectMicPrismThreadRequest(threadId)),
  };
});

it.live(
  "registers against a real environment session store without returning or forwarding its secrets",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const receipt = yield* h.connect;
      expect(receipt).toEqual({ threadId: h.threadId, expiresAt: h.expiresAt });
      expect(Object.keys(receipt).sort()).toEqual(["expiresAt", "threadId"]);
      expect(h.calls.map((call) => call.path)).toEqual([
        "/v1/identity",
        "/v1/prism/discovery",
        "/v1/prism/credentials",
      ]);
      expect(h.calls.every((call) => call.correctAuthorization && !call.hasEnvironmentToken)).toBe(
        true,
      );
      expect(h.calls[2]?.body).toBe('{"serviceInstanceId":"prism-fixture","pairingRevision":1}');
      expect(
        Boolean(
          yield* Effect.promise(async () =>
            getMicPrismThreadEndpoint(
              h.threadId,
              await authorizeMicPrismThread(h.threadId, h.issued.sessionId),
            ),
          ),
        ),
      ).toBe(true);
      yield* h.disconnect;
      expect(
        yield* Effect.promise(async () =>
          getMicPrismThreadEndpoint(
            h.threadId,
            await authorizeMicPrismThread(h.threadId, h.issued.sessionId),
          ),
        ),
      ).toBeUndefined();
    }).pipe(Effect.provide(sessionLayer())),
);

it.live("denies an environment reader before contacting the mic.sc authority", () =>
  Effect.gen(function* () {
    const h = yield* fixture({ scopes: ["orchestration:read"] });
    const error = yield* h.connect.pipe(Effect.flip);
    expect(error._tag).toBe("EnvironmentScopeRequiredError");
    expect(h.calls).toHaveLength(0);
    expect(
      yield* Effect.promise(async () =>
        getMicPrismThreadEndpoint(
          h.threadId,
          await authorizeMicPrismThread(h.threadId, h.issued.sessionId),
        ),
      ),
    ).toBeUndefined();
  }).pipe(Effect.provide(sessionLayer())),
);

it.live("requires a verified Clerk session ID, not an unbound template identity", () =>
  Effect.gen(function* () {
    const h = yield* fixture({ missingSid: true });
    const error = yield* h.connect.pipe(Effect.flip);
    expect(error._tag).toBe("MicIdentityUnauthorizedError");
    expect(h.calls.some((call) => call.path.endsWith("/credentials"))).toBe(false);
    expect(
      yield* Effect.promise(async () =>
        getMicPrismThreadEndpoint(
          h.threadId,
          await authorizeMicPrismThread(h.threadId, h.issued.sessionId),
        ),
      ),
    ).toBeUndefined();
  }).pipe(Effect.provide(sessionLayer())),
);

for (const credential of [
  { serviceInstanceId: "wrong-host" },
  { pairingRevision: 2 },
  { expiresAt: 0 },
]) {
  it.live(`rejects a mismatched or expired credential: ${Object.keys(credential)[0]}`, () =>
    Effect.gen(function* () {
      const h = yield* fixture({ credential });
      const error = yield* h.connect.pipe(Effect.flip);
      expect(error._tag).toBe("MicIdentityUnavailableError");
      expect(
        yield* Effect.promise(async () =>
          getMicPrismThreadEndpoint(
            h.threadId,
            await authorizeMicPrismThread(h.threadId, h.issued.sessionId),
          ),
        ),
      ).toBeUndefined();
    }).pipe(Effect.provide(sessionLayer())),
  );
}

it.live("rechecks the environment store after mic.sc authorization before registering", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    yield* h.sessions.revoke(h.issued.sessionId);
    const error = yield* h.connect.pipe(Effect.flip);
    expect(error._tag).toBe("MicIdentityForbiddenError");
    expect(
      yield* Effect.promise(async () =>
        getMicPrismThreadEndpoint(
          h.threadId,
          await authorizeMicPrismThread(h.threadId, h.issued.sessionId),
        ),
      ),
    ).toBeUndefined();
  }).pipe(Effect.provide(sessionLayer())),
);

it.live("rejects broker inference immediately after its real environment session is revoked", () =>
  Effect.gen(function* () {
    const h = yield* fixture();
    yield* h.connect;
    const endpoint = yield* Effect.promise(async () =>
      getMicPrismThreadEndpoint(
        h.threadId,
        await authorizeMicPrismThread(h.threadId, h.issued.sessionId),
      ),
    );
    expect(Boolean(endpoint)).toBe(true);
    if (!endpoint) return;
    yield* h.sessions.revoke(h.issued.sessionId);
    const response = yield* HttpClient.get(`${endpoint.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${endpoint.apiKey}` },
    }).pipe(Effect.provide(FetchHttpClient.layer));
    expect(response.status).toBe(403);
    expect(response.headers["x-prism-fallback-allowed"]).toBe("false");
    yield* h.disconnect;
    expect(
      yield* Effect.promise(async () =>
        getMicPrismThreadEndpoint(
          h.threadId,
          await authorizeMicPrismThread(h.threadId, h.issued.sessionId),
        ),
      ),
    ).toBeUndefined();
  }).pipe(Effect.provide(sessionLayer())),
);

it.live("cancels pending credential exchange without retaining a thread endpoint", () =>
  Effect.gen(function* () {
    const h = yield* fixture({ stallCredential: true });
    const fiber = yield* h.connect.pipe(Effect.forkChild);
    yield* Effect.promise(() => h.credentialStarted.promise);
    yield* Fiber.interrupt(fiber);
    yield* Effect.promise(() => h.credentialAborted.promise);
    expect(
      yield* Effect.promise(async () =>
        getMicPrismThreadEndpoint(
          h.threadId,
          await authorizeMicPrismThread(h.threadId, h.issued.sessionId),
        ),
      ),
    ).toBeUndefined();
  }).pipe(Effect.provide(sessionLayer())),
);

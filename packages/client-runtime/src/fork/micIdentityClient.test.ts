import { describe, expect, it } from "@effect/vitest";
import {
  MicIdentityUnavailableError,
  type MicIdentityWire,
  type MicPrismDiscoveryWire,
} from "@q1code/core/micIdentity";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { remoteHttpClientLayer } from "../rpc/http.ts";
import { getMicIdentityAccess } from "./micIdentityClient.ts";

// Actual v1 contract shapes with synthetic identity, grants and pairing only.
const session = {
  contractVersion: 1,
  subject: "user_fixture",
  role: "member",
  permissions: ["prism:inference"],
  authorizationRevision: '1000:["member","active",[]]',
  authorizationExpiresAt: 4_070_908_800_000,
} satisfies MicIdentityWire;
const discovery = {
  contractVersion: 1,
  selectionRevision: 1,
  service: {
    serviceInstanceId: "prism-pc",
    displayName: "PC Prism",
    apiOrigin: "https://prism.example.test",
    inferenceOrigin: "https://inference.example.test",
    pairingRevision: 1,
    protocolVersion: 1,
    publicKey: "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    status: "paired",
  },
} satisfies MicPrismDiscoveryWire;

const capture = (respond: (url: string, init: RequestInit) => Response) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = ((request, init) => {
    const url = String(request);
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(respond(url, init ?? {}));
  }) satisfies typeof fetch;
  return { calls, layer: remoteHttpClientLayer(fetchFn) };
};
const input = {
  baseUrl: "https://identity.example.test",
  getToken: () => Effect.succeed("fixture-session-token"),
};

describe("mic.sc identity transport", () => {
  it.effect("bounds an unavailable sign-in adapter without making a network request", () =>
    Effect.gen(function* () {
      const server = capture(() => Response.json(session));
      const fiber = yield* getMicIdentityAccess({
        ...input,
        getToken: () => Effect.never,
        timeoutMs: 100,
      }).pipe(Effect.provide(server.layer), Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(100);
      const failure = yield* Fiber.join(fiber);
      expect(failure).toMatchObject({ _tag: "MicIdentityUnavailableError", reason: "transport" });
      expect(server.calls).toHaveLength(0);
    }),
  );

  it.effect("gets fresh identity, permissions and pairing for every operation", () =>
    Effect.gen(function* () {
      let tokenNumber = 0;
      const server = capture((url) =>
        Response.json(url.endsWith("/identity") ? session : discovery),
      );
      const operation = getMicIdentityAccess({
        ...input,
        getToken: () => Effect.sync(() => `fixture-token-${++tokenNumber}`),
      }).pipe(Effect.provide(server.layer));
      const first = yield* operation;
      yield* operation;
      expect(first.session).toMatchObject({
        state: "active",
        subject: session.subject,
        permissions: session.permissions,
        authorizationRevision: session.authorizationRevision,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      expect(first.session).not.toHaveProperty("sessionId");
      expect(first.discovery).toMatchObject({
        selectionRevision: 1,
        service: { id: "prism-pc", apiUrl: discovery.service.apiOrigin, pairingRevision: 1 },
      });
      expect(first.session.capabilities).toEqual({
        inference: true,
        manage: false,
        accountDetails: false,
      });
      expect(
        server.calls.map((call) => new Headers(call.init.headers).get("authorization")),
      ).toEqual([
        "Bearer fixture-token-1",
        "Bearer fixture-token-1",
        "Bearer fixture-token-2",
        "Bearer fixture-token-2",
      ]);
      expect(server.calls.map((call) => call.url)).toEqual([
        "https://identity.example.test/v1/identity",
        "https://identity.example.test/v1/prism/discovery",
        "https://identity.example.test/v1/identity",
        "https://identity.example.test/v1/prism/discovery",
      ]);
      for (const call of server.calls) {
        expect(call.init).toMatchObject({
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
        });
      }
    }),
  );

  it.effect("does not infer grants from global admin or reuse a previously allowed session", () =>
    Effect.gen(function* () {
      let checks = 0;
      const server = capture((url) => {
        if (!url.endsWith("/identity")) return Response.json(discovery);
        checks++;
        return Response.json({
          ...session,
          role: "global_admin",
          authorizationRevision: `revision-${checks}`,
          permissions:
            checks === 1 ? ["prism:inference", "prism:routing:write"] : ["prism:inference"],
        });
      });
      const operation = getMicIdentityAccess({ ...input, permission: "prism:routing:write" }).pipe(
        Effect.provide(server.layer),
      );
      yield* operation;
      const failure = yield* operation.pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "MicIdentityForbiddenError",
        capability: "prism:routing:write",
      });
      expect(server.calls).toHaveLength(3);
    }),
  );

  it.effect("rejects an expired authorization before discovery", () =>
    Effect.gen(function* () {
      const server = capture(() => Response.json({ ...session, authorizationExpiresAt: 0 }));
      const failure = yield* getMicIdentityAccess(input).pipe(
        Effect.provide(server.layer),
        Effect.flip,
      );
      expect(failure._tag).toBe("MicIdentityUnauthorizedError");
      expect(server.calls).toHaveLength(1);
    }),
  );

  it.effect("does not retain a host after pairing revocation", () =>
    Effect.gen(function* () {
      let paired = true;
      const server = capture((url) =>
        Response.json(
          url.endsWith("/identity")
            ? session
            : {
                ...discovery,
                service: paired ? discovery.service : null,
              },
        ),
      );
      const operation = getMicIdentityAccess(input).pipe(Effect.provide(server.layer));
      yield* operation;
      paired = false;
      const failure = yield* operation.pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "MicIdentityUnavailableError",
        reason: "unpaired-service",
      });
      expect(server.calls).toHaveLength(4);
    }),
  );

  it.effect("rejects unpaired discovery and invalid service endpoints", () =>
    Effect.gen(function* () {
      for (const service of [
        null,
        { ...discovery.service, apiOrigin: "not an origin" },
        { ...discovery.service, apiOrigin: "https://user:secret@example.test" },
        { ...discovery.service, apiOrigin: "http://public.example.test" },
        { ...discovery.service, apiOrigin: "https://example.test/arbitrary/path" },
        { ...discovery.service, inferenceOrigin: "https://example.test?key=secret" },
      ]) {
        const server = capture((url) =>
          Response.json(url.endsWith("/identity") ? session : { ...discovery, service }),
        );
        const failure = yield* getMicIdentityAccess(input).pipe(
          Effect.provide(server.layer),
          Effect.flip,
        );
        expect(failure).toMatchObject({
          _tag: "MicIdentityUnavailableError",
          reason: service === null ? "unpaired-service" : "invalid-response",
        });
      }
    }),
  );

  it.effect("fails closed on malformed identity responses without echoing their contents", () =>
    Effect.gen(function* () {
      for (const response of [
        { ...session, contractVersion: 2 },
        { ...session, permissions: [true] },
        { ...session, role: "unknown" },
        { ...session, authorizationExpiresAt: "fixture-secret-not-a-date" },
        { ...session, authorizationExpiresAt: 9_000_000_000_000_000 },
        { ...session, subject: "" },
      ]) {
        const server = capture(() => Response.json(response));
        const failure = yield* getMicIdentityAccess(input).pipe(
          Effect.provide(server.layer),
          Effect.flip,
        );
        expect(failure).toMatchObject({
          _tag: "MicIdentityUnavailableError",
          reason: "invalid-response",
        });
        expect(String(failure)).not.toContain("fixture-secret");
        expect(failure).not.toHaveProperty("cause");
        expect(server.calls).toHaveLength(1);
      }
    }),
  );

  it.effect("never sends a request without a current token", () =>
    Effect.gen(function* () {
      const server = capture(() => Response.json(session));
      const failure = yield* getMicIdentityAccess({
        ...input,
        getToken: () => Effect.succeed(null),
      }).pipe(Effect.provide(server.layer), Effect.flip);
      expect(failure).toMatchObject({
        _tag: "MicIdentityUnauthorizedError",
        reason: "sign-in-required",
      });
      expect(server.calls).toHaveLength(0);
    }),
  );

  it.effect("does not retry rejections, redirects, or server errors", () =>
    Effect.gen(function* () {
      for (const status of [401, 403, 302, 500]) {
        const server = capture(() => new Response("fixture-private-upstream-message", { status }));
        const failure = yield* getMicIdentityAccess(input).pipe(
          Effect.provide(server.layer),
          Effect.flip,
        );
        expect(failure._tag).toBe(
          status === 401
            ? "MicIdentityUnauthorizedError"
            : status === 403
              ? "MicIdentityForbiddenError"
              : "MicIdentityUnavailableError",
        );
        expect(String(failure)).not.toContain("fixture-private");
        expect(failure).not.toHaveProperty("cause");
        expect(server.calls).toHaveLength(1);
      }
    }),
  );

  it.effect("sanitizes sign-in adapter and transport failures", () =>
    Effect.gen(function* () {
      const server = capture(() => Response.json(session));
      const signInFailure = yield* getMicIdentityAccess({
        ...input,
        getToken: () => Effect.fail(new MicIdentityUnavailableError({ reason: "transport" })),
      }).pipe(Effect.provide(server.layer), Effect.flip);
      const fetchFn = (() =>
        Promise.reject(new Error("fixture-private-token"))) satisfies typeof fetch;
      const networkFailure = yield* getMicIdentityAccess(input).pipe(
        Effect.provide(remoteHttpClientLayer(fetchFn)),
        Effect.flip,
      );
      expect(signInFailure).not.toHaveProperty("cause");
      expect(networkFailure).not.toHaveProperty("cause");
      expect(String(networkFailure)).not.toContain("fixture-private-token");
    }),
  );
});

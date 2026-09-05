import { describe, expect, it } from "@effect/vitest";
import type { MicIdentityWire, MicPrismDiscoveryWire } from "@q1code/core/micIdentity";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";

import { remoteHttpClientLayer } from "../rpc/http.ts";
import { getMicPrismRouting, getMicPrismStatus, setMicPrismRouting } from "./micPrismClient.ts";

const identity: MicIdentityWire = {
  contractVersion: 1,
  subject: "user_fixture",
  role: "member",
  permissions: ["prism:inference"],
  authorizationExpiresAt: 4_070_908_800_000,
  authorizationRevision: '1000:["member","active",[]]',
};
const discovery: MicPrismDiscoveryWire = {
  contractVersion: 1,
  selectionRevision: 1,
  service: {
    serviceInstanceId: "prism-pc",
    displayName: "PC Prism",
    apiOrigin: "https://gateway.example.test",
    inferenceOrigin: "https://gateway.example.test",
    pairingRevision: 1,
    protocolVersion: 1,
    publicKey: "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    status: "paired",
  },
};
const status = {
  serviceInstanceId: "prism-pc",
  pairingRevision: 1,
  authorization: "current",
  engineHealth: "unknown",
};

const harness = (
  options: {
    permissions?: ReadonlyArray<string>;
    gateway?: (url: string, init: RequestInit) => Response;
    discovery?: () => MicPrismDiscoveryWire;
  } = {},
) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let tokenNumber = 0;
  const fetchFn = ((request, init) => {
    const url = String(request);
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(
      url.endsWith("/v1/identity")
        ? Response.json({ ...identity, permissions: options.permissions ?? identity.permissions })
        : url.endsWith("/v1/prism/discovery")
          ? Response.json(options.discovery?.() ?? discovery)
          : (options.gateway?.(url, init ?? {}) ?? Response.json(status)),
    );
  }) satisfies typeof fetch;
  return {
    calls,
    layer: remoteHttpClientLayer(fetchFn),
    input: {
      baseUrl: "https://identity.example.test",
      getToken: () => Effect.sync(() => `fixture-token-${++tokenNumber}`),
    },
  };
};

describe("direct mic.sc Prism gateway", () => {
  it.effect(
    "keeps trace headers out of cross-origin service requests without disabling other tracing",
    () =>
      Effect.gen(function* () {
        const h = harness();
        yield* Effect.gen(function* () {
          yield* getMicPrismStatus(h.input);
          // The scoped service override must not alter ordinary environment HTTP.
          const client = yield* HttpClient.HttpClient;
          yield* client.get("https://control.example.test");
        }).pipe(
          Effect.withSpan("mic-identity-cors-regression"),
          Effect.withTracerEnabled(true),
          Effect.provideService(HttpClient.TracerPropagationEnabled, true),
          Effect.provide(h.layer),
        );
        expect(h.calls).toHaveLength(4);
        for (const request of h.calls.slice(0, 3)) {
          const headers = new Headers(request.init.headers);
          expect(headers.get("authorization")).toMatch(/^Bearer fixture-token-/);
          expect(headers.has("b3")).toBe(false);
          expect(headers.has("traceparent")).toBe(false);
        }
        const controlHeaders = new Headers(h.calls[3]?.init.headers);
        expect(controlHeaders.has("b3")).toBe(true);
        expect(controlHeaders.has("traceparent")).toBe(true);
      }),
  );

  it.effect("uses admitted identity without issuing or sending environment credentials", () =>
    Effect.gen(function* () {
      const h = harness();
      expect(yield* getMicPrismStatus(h.input).pipe(Effect.provide(h.layer))).toEqual(status);
      expect(h.calls.map((call) => call.url)).toEqual([
        "https://identity.example.test/v1/identity",
        "https://identity.example.test/v1/prism/discovery",
        "https://gateway.example.test/prism/v1/status",
      ]);
      expect(h.calls.map((call) => new Headers(call.init.headers).get("authorization"))).toEqual([
        "Bearer fixture-token-1",
        "Bearer fixture-token-1",
        "Bearer fixture-token-2",
      ]);
      const headers = new Headers(h.calls[2]?.init.headers);
      expect(headers.has("dpop")).toBe(false);
      expect(headers.has("x-mic-sc-session")).toBe(false);
      expect(h.calls[2]?.init).toMatchObject({
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      });
    }),
  );

  it.effect("requires routing read and write independently", () =>
    Effect.gen(function* () {
      const h = harness({
        permissions: ["prism:inference", "prism:routing:read"],
        gateway: () => Response.json({ strategy: "round-robin" }),
      });
      expect(yield* getMicPrismRouting(h.input).pipe(Effect.provide(h.layer))).toEqual({
        strategy: "round-robin",
      });
      const failure = yield* setMicPrismRouting({ ...h.input, strategy: "fill-first" }).pipe(
        Effect.provide(h.layer),
        Effect.flip,
      );
      expect(failure).toMatchObject({
        _tag: "MicIdentityForbiddenError",
        capability: "prism:routing:write",
      });
      expect(h.calls).toHaveLength(4);
      expect(h.calls.some((call) => call.init.method === "PUT")).toBe(false);
    }),
  );

  it.effect("does not turn account or routing write grants into routing read", () =>
    Effect.gen(function* () {
      for (const permission of ["prism:accounts:read", "prism:routing:write"]) {
        const h = harness({ permissions: ["prism:inference", permission] });
        const failure = yield* getMicPrismRouting(h.input).pipe(
          Effect.provide(h.layer),
          Effect.flip,
        );
        expect(failure).toMatchObject({
          _tag: "MicIdentityForbiddenError",
          capability: "prism:routing:read",
        });
        expect(h.calls).toHaveLength(1);
      }
    }),
  );

  it.effect("sends one supported routing mutation and verifies the applied strategy", () =>
    Effect.gen(function* () {
      const h = harness({
        permissions: ["prism:inference", "prism:routing:write"],
        gateway: () => Response.json({ strategy: "fill-first" }),
      });
      expect(
        yield* setMicPrismRouting({ ...h.input, strategy: "fill-first" }).pipe(
          Effect.provide(h.layer),
        ),
      ).toEqual({ strategy: "fill-first" });
      const request = h.calls[2];
      expect(request?.init.method).toBe("PUT");
      const body = request?.init.body;
      expect(typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array)).toBe(
        '{"strategy":"fill-first"}',
      );
      expect(h.calls).toHaveLength(3);
    }),
  );

  it.effect("rejects status from a different instance or pairing revision", () =>
    Effect.gen(function* () {
      for (const change of [{ serviceInstanceId: "another-instance" }, { pairingRevision: 2 }]) {
        const h = harness({ gateway: () => Response.json({ ...status, ...change }) });
        const failure = yield* getMicPrismStatus(h.input).pipe(
          Effect.provide(h.layer),
          Effect.flip,
        );
        expect(failure).toMatchObject({
          _tag: "MicIdentityUnavailableError",
          reason: "revoked-service",
        });
      }
    }),
  );

  it.effect("does not replay a rejected or unconfirmed mutation", () =>
    Effect.gen(function* () {
      for (const response of [
        Response.json({ error: { code: "access_revoked" } }, { status: 403 }),
        Response.json({ strategy: "round-robin" }),
        Response.json({ error: { code: "upstream_unavailable" } }, { status: 503 }),
      ]) {
        const h = harness({
          permissions: ["prism:inference", "prism:routing:write"],
          gateway: () => response,
        });
        const failure = yield* setMicPrismRouting({ ...h.input, strategy: "fill-first" }).pipe(
          Effect.provide(h.layer),
          Effect.flip,
        );
        expect(["MicIdentityForbiddenError", "MicIdentityUnavailableError"]).toContain(
          failure._tag,
        );
        expect(h.calls.filter((call) => call.init.method === "PUT")).toHaveLength(1);
      }
    }),
  );

  it.effect("reports an unsupported adapter instead of falling back to shared management", () =>
    Effect.gen(function* () {
      const h = harness({
        permissions: ["prism:inference", "prism:routing:read"],
        gateway: () =>
          Response.json({ error: { type: "prism_route_not_available" } }, { status: 404 }),
      });
      const failure = yield* getMicPrismRouting(h.input).pipe(Effect.provide(h.layer), Effect.flip);
      expect(failure).toMatchObject({
        _tag: "MicIdentityUnavailableError",
        reason: "unsupported-operation",
      });
      expect(h.calls).toHaveLength(3);
      expect(
        h.calls.some(
          (call) => call.url.includes("/api/fork/prism") || call.url.includes("/v0/management"),
        ),
      ).toBe(false);
    }),
  );

  it.effect("discovers the current selected origin on every operation", () =>
    Effect.gen(function* () {
      let instance = 0;
      const h = harness({
        discovery: () => {
          instance++;
          return {
            ...discovery,
            selectionRevision: instance,
            service: {
              ...discovery.service!,
              serviceInstanceId: `instance-${instance}`,
              apiOrigin: `https://gateway-${instance}.example.test`,
            },
          };
        },
        gateway: () => Response.json({ ...status, serviceInstanceId: `instance-${instance}` }),
      });
      yield* getMicPrismStatus(h.input).pipe(Effect.provide(h.layer));
      yield* getMicPrismStatus(h.input).pipe(Effect.provide(h.layer));
      expect(
        h.calls.filter((call) => call.url.includes("/prism/v1/status")).map((call) => call.url),
      ).toEqual([
        "https://gateway-1.example.test/prism/v1/status",
        "https://gateway-2.example.test/prism/v1/status",
      ]);
    }),
  );
});

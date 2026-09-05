import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import {
  completeMicPrismPairing,
  revokeMicPrismInstance,
  selectMicPrismInstance,
  startMicPrismPairing,
} from "./micPrismPairing.ts";

const publicKey = "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const origin = "https://host.example.test";
const challengeId = "12345678-1234-4234-8234-123456789012";
const start = { origin, publicKey, label: "PC Prism" };
function challenge(now: number, overrides: Record<string, unknown> = {}) {
  const proof = {
    domain: "mic.sc/prism-pairing/v1",
    challengeId,
    nonce: "a".repeat(43),
    subject: "member",
    origin,
    publicKey,
    expiresAt: now + 300_000,
    expectedServiceInstanceId: null,
    expectedPairingRevision: 0,
    ...overrides,
  };
  return {
    challengeId,
    challenge: JSON.stringify(proof, null, 2),
    origin,
    publicKey,
    expiresAt: now + 300_000,
  };
}
function harness(
  reply: (path: string) => Response,
  permissions = ["prism:inference", "prism:instances:manage"],
) {
  const calls: { url: string; init: RequestInit }[] = [];
  let current = true;
  let tokens = 0;
  const fetchFn = ((request, init) => {
    const url = String(request);
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(
      url.endsWith("/v1/identity")
        ? Response.json({
            contractVersion: 1,
            subject: "member",
            role: "member",
            permissions,
            authorizationExpiresAt: 4_070_908_800_000,
            authorizationRevision: "fixture-revision",
          })
        : url.endsWith("/v1/prism/discovery")
          ? Response.json({ contractVersion: 1, selectionRevision: 3, service: null })
          : reply(new URL(url).pathname),
    );
  }) satisfies typeof fetch;
  return {
    calls,
    switchAccount: () => {
      current = false;
    },
    layer: remoteHttpClientLayer(fetchFn),
    input: {
      baseUrl: "https://authority.example.test",
      getToken: () => Effect.sync(() => `session-${++tokens}`),
      isCurrent: () => current,
    },
  };
}

function decodedBody(body: BodyInit | null | undefined): unknown {
  return JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array));
}

describe("mic.sc account-level Prism host administration", () => {
  it.effect(
    "starts pairing without a selected/reachable host and preserves the exact challenge",
    () =>
      Effect.gen(function* () {
        const expected = challenge(DateTime.toEpochMillis(yield* DateTime.now));
        const h = harness(() => Response.json(expected));
        expect(
          yield* startMicPrismPairing({ ...h.input, ...start }).pipe(Effect.provide(h.layer)),
        ).toEqual(expected);
        expect(h.calls.map((call) => call.url)).toEqual([
          "https://authority.example.test/v1/identity",
          "https://authority.example.test/v1/prism/discovery",
          "https://authority.example.test/v1/prism/pairings/start",
        ]);
        expect(new Headers(h.calls[2]?.init.headers).get("authorization")).toBe("Bearer session-2");
        expect(h.calls[2]?.init).toMatchObject({
          method: "POST",
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
        });
        expect(decodedBody(h.calls[2]?.init.body)).toEqual(start);
      }),
  );

  it.effect("uses explicit completion and revision-bound selection/revocation operations", () =>
    Effect.gen(function* () {
      const h = harness((path) =>
        Response.json(
          path.endsWith("/complete")
            ? { serviceInstanceId: "instance", pairingRevision: 2 }
            : path.endsWith("/select")
              ? { serviceInstanceId: "instance", selectionRevision: 4 }
              : { serviceInstanceId: "instance", pairingRevision: 3, selectionRevision: 5 },
        ),
      );
      yield* completeMicPrismPairing({ ...h.input, challengeId, signature: "a".repeat(86) }).pipe(
        Effect.provide(h.layer),
      );
      expect(h.calls.filter((call) => call.init.method === "POST")).toHaveLength(1);
      yield* selectMicPrismInstance({
        ...h.input,
        serviceInstanceId: "instance",
        expectedSelectionRevision: 3,
      }).pipe(Effect.provide(h.layer));
      yield* revokeMicPrismInstance({
        ...h.input,
        serviceInstanceId: "instance",
        expectedPairingRevision: 2,
      }).pipe(Effect.provide(h.layer));
      expect(
        h.calls
          .filter((call) => call.init.method === "POST")
          .map((call) => decodedBody(call.init.body)),
      ).toEqual([
        { challengeId, signature: "a".repeat(86) },
        { serviceInstanceId: "instance", expectedSelectionRevision: 3 },
        { serviceInstanceId: "instance", expectedPairingRevision: 2 },
      ]);
      expect(h.calls.every((call) => call.url.startsWith(h.input.baseUrl))).toBe(true);
    }),
  );

  it.effect("requires the exact host-management grant, not broad management presentation", () =>
    Effect.gen(function* () {
      const h = harness(() => Response.json({}), ["prism:inference", "prism:routing:write"]);
      const error = yield* startMicPrismPairing({ ...h.input, ...start }).pipe(
        Effect.provide(h.layer),
        Effect.flip,
      );
      expect(error._tag).toBe("MicIdentityForbiddenError");
      expect(h.calls).toHaveLength(1);
    }),
  );

  it.effect("rejects private-key text and invalid origins before network access", () =>
    Effect.gen(function* () {
      const h = harness(() => Response.json({}));
      for (const change of [
        { publicKey: "-----BEGIN PRIVATE KEY-----" },
        { origin: "https://host.example.test/path" },
        { origin: "http://remote.example.test" },
      ]) {
        const error = yield* startMicPrismPairing({ ...h.input, ...start, ...change }).pipe(
          Effect.provide(h.layer),
          Effect.flip,
        );
        expect(error._tag).toBe("MicPrismPairingError");
      }
      expect(h.calls).toHaveLength(0);
    }),
  );

  it.effect("rejects challenge payload substitution and expired challenges", () =>
    Effect.gen(function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      for (const changes of [
        { subject: "other-user" },
        { origin: "https://other.example.test" },
        { expiresAt: now - 1 },
      ]) {
        const h = harness(() => Response.json(challenge(now, changes)));
        const error = yield* startMicPrismPairing({ ...h.input, ...start }).pipe(
          Effect.provide(h.layer),
          Effect.flip,
        );
        expect(error._tag).toBe("MicPrismPairingError");
      }
    }),
  );

  it.effect("stops mutation when the signed-in account changes during fresh-token renewal", () =>
    Effect.gen(function* () {
      const h = harness(() => Response.json({}));
      let count = 0;
      const getToken = () =>
        Effect.sync(() => {
          if (++count === 2) h.switchAccount();
          return "session-fixture";
        });
      const error = yield* revokeMicPrismInstance({
        ...h.input,
        getToken,
        serviceInstanceId: "instance",
        expectedPairingRevision: 2,
      }).pipe(Effect.provide(h.layer), Effect.flip);
      expect(error._tag).toBe("MicIdentityUnauthorizedError");
      expect(h.calls.some((call) => call.init.method === "POST")).toBe(false);
    }),
  );

  it.effect("does not retry conflicts, rejected access, or an unavailable authority", () =>
    Effect.gen(function* () {
      for (const status of [401, 403, 409, 503]) {
        const h = harness(() => new Response("private backend diagnostic", { status }));
        const error = yield* selectMicPrismInstance({
          ...h.input,
          serviceInstanceId: "instance",
          expectedSelectionRevision: 3,
        }).pipe(Effect.provide(h.layer), Effect.flip);
        expect(error.message).not.toContain("private backend diagnostic");
        expect(h.calls.filter((call) => call.init.method === "POST")).toHaveLength(1);
        if (status === 409)
          expect(error._tag === "MicPrismPairingError" && error.reason).toBe("conflict");
      }
    }),
  );

  it.effect("rejects acknowledgement for another host or stale revision", () =>
    Effect.gen(function* () {
      for (const response of [
        { serviceInstanceId: "other", selectionRevision: 4 },
        { serviceInstanceId: "instance", selectionRevision: 2 },
      ]) {
        const h = harness(() => Response.json(response));
        const error = yield* selectMicPrismInstance({
          ...h.input,
          serviceInstanceId: "instance",
          expectedSelectionRevision: 3,
        }).pipe(Effect.provide(h.layer), Effect.flip);
        expect(error._tag).toBe("MicPrismPairingError");
      }
    }),
  );
});

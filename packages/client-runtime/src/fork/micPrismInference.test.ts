import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { getMicIdentityAccess } from "./micIdentityClient.ts";
import {
  listMicPrismModels,
  mintMicPrismCredential,
  streamMicPrismChat,
} from "./micPrismInference.ts";

const identity = {
  contractVersion: 1,
  subject: "user_test",
  sessionId: "sess_test",
  role: "member",
  permissions: ["prism:inference"],
  authorizationRevision: "r1",
  authorizationExpiresAt: 4_070_908_800_000,
};
const service = {
  serviceInstanceId: "host_test",
  displayName: "Test Prism",
  apiOrigin: "https://gateway.example.test",
  inferenceOrigin: "https://gateway.example.test",
  pairingRevision: 2,
  protocolVersion: 1,
  publicKey: "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  status: "paired",
};
const credential = {
  version: 1,
  tokenType: "Bearer",
  token: "msp1.test.signature",
  expiresAt: 800_000,
  serviceInstanceId: "host_test",
  pairingRevision: 2,
};
const input = {
  baseUrl: "https://identity.example.test",
  getToken: () => Effect.succeed("session-token"),
};
const chat = {
  ...input,
  model: "test-model",
  messages: [{ role: "user" as const, content: "Hello" }],
};
const sse = (text = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n') =>
  new Response(text, { headers: { "content-type": "text/event-stream" } });
function harness(overrides: Partial<Record<string, () => Response>> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const layer = remoteHttpClientLayer(async (url, init) => {
    calls.push({
      url: String(url),
      init: { ...init, ...(init?.body ? { body: await new Response(init.body).text() } : {}) },
    });
    const path = new URL(String(url)).pathname;
    return (
      overrides[path]?.() ??
      (path === "/v1/identity"
        ? Response.json(identity)
        : path === "/v1/prism/discovery"
          ? Response.json({ contractVersion: 1, selectionRevision: 3, service })
          : path === "/v1/prism/credentials"
            ? Response.json(credential)
            : path === "/v1/models"
              ? Response.json({ data: [{ id: "b", account: "private" }, { id: "a" }, { id: "b" }] })
              : sse())
    );
  });
  return { calls, layer };
}

describe("mic.sc inference integration", () => {
  it.effect("accepts bounded authority clock skew on a normal fifteen-minute credential", () =>
    Effect.gen(function* () {
      const h = harness({
        "/v1/prism/credentials": () => Response.json({ ...credential, expiresAt: 901_000 }),
      });
      const value = yield* mintMicPrismCredential(input).pipe(Effect.provide(h.layer));
      expect(value.expiresAt).toBe(901_000);
    }),
  );
  it.effect("finishes at the protocol terminator even when the server keeps its socket open", () =>
    Effect.gen(function* () {
      let cancelled = false;
      const h = harness({
        "/v1/chat/completions": () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
                  ),
                );
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
      const text = yield* Stream.runCollect(streamMicPrismChat(chat)).pipe(Effect.provide(h.layer));
      expect(text.join("")).toBe("done");
      expect(cancelled).toBe(true);
    }),
  );
  it.effect("rejects an unterminated oversized SSE line without retaining unlimited text", () =>
    Effect.gen(function* () {
      const h = harness({ "/v1/chat/completions": () => sse("data: " + "x".repeat(1_048_576)) });
      const error = yield* Stream.runCollect(streamMicPrismChat(chat)).pipe(
        Effect.provide(h.layer),
        Effect.flip,
      );
      expect(error).toMatchObject({ _tag: "MicPrismInferenceError", reason: "invalid-response" });
    }),
  );
  it.effect("retains verified identity when no host has been paired", () =>
    Effect.gen(function* () {
      const h = harness({
        "/v1/prism/discovery": () =>
          Response.json({ contractVersion: 1, selectionRevision: 0, service: null }),
      });
      const access = yield* getMicIdentityAccess({ ...input, allowUnpaired: true }).pipe(
        Effect.provide(h.layer),
      );
      expect(access.session.sessionId).toBe("sess_test");
      expect(access.discovery.service).toBeNull();
    }),
  );
  it.effect("exchanges a fresh session for a redacted host-bound credential", () =>
    Effect.gen(function* () {
      const h = harness();
      const result = yield* mintMicPrismCredential(input).pipe(Effect.provide(h.layer));
      expect(Redacted.value(result.token)).toBe(credential.token);
      expect(String(result.token)).not.toContain(credential.token);
      expect(
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
          String(h.calls.at(-1)!.init.body),
        ),
      ).toEqual({ serviceInstanceId: "host_test", pairingRevision: 2 });
    }),
  );
  it.effect("exposes model identifiers only and renews before each request", () =>
    Effect.gen(function* () {
      const h = harness();
      const models = yield* listMicPrismModels(input).pipe(Effect.provide(h.layer));
      yield* listMicPrismModels(input).pipe(Effect.provide(h.layer));
      expect(models).toEqual(["a", "b"]);
      expect(h.calls.filter(({ url }) => url.endsWith("/credentials"))).toHaveLength(2);
      for (const request of h.calls.filter(({ url }) => url.endsWith("/models"))) {
        expect(new Headers(request.init.headers).get("authorization")).toBe(
          `Bearer ${credential.token}`,
        );
        expect(request.init.redirect).toBe("error");
        expect(new Headers(request.init.headers).has("traceparent")).toBe(false);
      }
    }),
  );
  for (const patch of [
    { pairingRevision: 1 },
    { serviceInstanceId: "wrong" },
    { expiresAt: 0 },
    { expiresAt: 1_000_000 },
  ]) {
    it.effect(`rejects invalid credential binding ${JSON.stringify(patch)}`, () =>
      Effect.gen(function* () {
        const h = harness({
          "/v1/prism/credentials": () => Response.json({ ...credential, ...patch }),
        });
        const error = yield* listMicPrismModels(input).pipe(Effect.provide(h.layer), Effect.flip);
        expect(error._tag).toBe("MicIdentityUnavailableError");
        expect(h.calls.some(({ url }) => url.endsWith("/models"))).toBe(false);
      }),
    );
  }
  it.effect("streams text without changing the requested model", () =>
    Effect.gen(function* () {
      const h = harness();
      const chunks = yield* Stream.runCollect(streamMicPrismChat(chat)).pipe(
        Effect.provide(h.layer),
      );
      expect(chunks.join("")).toBe("Hello");
      expect(
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
          String(h.calls.at(-1)!.init.body),
        ),
      ).toEqual({ model: "test-model", messages: chat.messages, stream: true });
    }),
  );
  for (const status of [401, 403, 429, 503]) {
    it.effect(`rejects inference ${status} without retry or provider diagnostics`, () =>
      Effect.gen(function* () {
        const h = harness({
          "/v1/chat/completions": () =>
            Response.json({ error: "secret provider diagnostic" }, { status }),
        });
        const error = yield* Stream.runCollect(streamMicPrismChat(chat)).pipe(
          Effect.provide(h.layer),
          Effect.flip,
        );
        expect(error.message).not.toContain("secret");
        expect(h.calls.filter(({ url }) => url.endsWith("/chat/completions"))).toHaveLength(1);
      }),
    );
  }
  it.effect("reports abrupt EOF as interrupted, retaining no false completion", () =>
    Effect.gen(function* () {
      const h = harness({
        "/v1/chat/completions": () =>
          sse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
      });
      const error = yield* Stream.runCollect(streamMicPrismChat(chat)).pipe(
        Effect.provide(h.layer),
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: "MicPrismInferenceError",
        reason: "interrupted",
        fallbackAllowed: false,
      });
    }),
  );
  it.effect("rejects a credential minted after the initiating account changes", () =>
    Effect.gen(function* () {
      let current = true;
      const h = harness({
        "/v1/prism/credentials": () => {
          current = false;
          return Response.json(credential);
        },
      });
      const error = yield* listMicPrismModels({ ...input, isCurrent: () => current }).pipe(
        Effect.provide(h.layer),
        Effect.flip,
      );
      expect(error._tag).toBe("MicIdentityUnauthorizedError");
      expect(h.calls).toHaveLength(3);
    }),
  );
});

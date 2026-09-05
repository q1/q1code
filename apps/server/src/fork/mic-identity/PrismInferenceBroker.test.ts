// @effect-diagnostics globalDate:off globalFetch:off - Exercises the real loopback HTTP boundary and epoch-based credential expiry.
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  createPrismInferenceBroker,
  type PrismInferenceBinding,
  type PrismInferenceBrokerOptions,
} from "./PrismInferenceBroker.ts";

const binding: PrismInferenceBinding = {
  environmentSessionId: "env-session",
  subject: "member",
  sessionId: "clerk-session",
  threadId: "thread-one",
  serviceInstanceId: "prism-one",
  pairingRevision: 1,
  inferenceOrigin: "https://prism.example.test",
};
const token = "msp1.fixture.signature";
const brokers: Awaited<ReturnType<typeof createPrismInferenceBroker>>[] = [];
afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
});
async function make(overrides: Partial<PrismInferenceBrokerOptions> = {}) {
  const broker = await createPrismInferenceBroker({
    binding,
    verifyBinding: async () => true,
    getCredential: async () => ({ binding, token, expiresAt: Date.now() + 60_000 }),
    fetch: async () =>
      new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
    ...overrides,
  });
  brokers.push(broker);
  return broker;
}
function call(broker: Awaited<ReturnType<typeof make>>, path = "/v1/models", init?: RequestInit) {
  return fetch(broker.endpoint.baseUrl + path, {
    ...init,
    headers: { authorization: `Bearer ${broker.endpoint.apiKey}`, ...init?.headers },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("Prism per-thread inference broker", () => {
  it("renews each request, forwards exact inference bytes, and strips unrelated credentials", async () => {
    const calls: { url: string; headers: Headers; body?: string }[] = [];
    let renewals = 0;
    const broker = await make({
      getCredential: async () => ({
        binding,
        token: `msp1.fixture${++renewals}.signature`,
        expiresAt: Date.now() + 60_000,
      }),
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          headers: new Headers(init?.headers),
          ...(init?.body ? { body: Buffer.from(init.body as Uint8Array).toString() } : {}),
        });
        expect(init?.redirect).toBe("error");
        return new Response("data: complete\n\n", {
          headers: {
            "content-type": "text/event-stream",
            "set-cookie": "private=fixture",
            location: "https://elsewhere.test",
          },
        });
      },
    });
    const payload =
      '{"model":"chosen-model","messages":[{"role":"tool","content":"exact result"}]}';
    const first = await call(broker, "/v1/messages?beta=true", {
      method: "POST",
      body: payload,
      headers: {
        "content-type": "application/json",
        cookie: "environment=fixture",
        "x-forwarded-for": "attacker",
        "anthropic-version": "2023-06-01",
      },
    });
    expect(await first.text()).toBe("data: complete\n\n");
    expect(first.headers.get("set-cookie")).toBeNull();
    expect(first.headers.get("location")).toBeNull();
    expect(first.headers.get("x-prism-fallback-allowed")).toBe("false");
    await (await call(broker)).text();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(binding.inferenceOrigin + "/v1/messages?beta=true");
    expect(calls[0]?.body).toBe(payload);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer msp1.fixture1.signature");
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer msp1.fixture2.signature");
    expect(calls[0]?.headers.get("cookie")).toBeNull();
    expect(calls[0]?.headers.get("x-forwarded-for")).toBeNull();
  });

  it("denies management, alternate paths, browser origins and missing/wrong local keys before authority", async () => {
    let verified = 0;
    const broker = await make({
      verifyBinding: async () => {
        verified++;
        return true;
      },
    });
    for (const path of [
      "/prism/v1/routing",
      "/v0/management/auth-files",
      "/v1/models?url=elsewhere",
      "/v1/%6dodels",
      "/v1/responses/",
    ]) {
      expect((await call(broker, path)).status).toBe(404);
    }
    expect((await fetch(broker.endpoint.baseUrl + "/v1/models")).status).toBe(401);
    expect(
      (await call(broker, undefined, { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    expect(
      (await call(broker, undefined, { headers: { origin: "https://browser.test" } })).status,
    ).toBe(403);
    expect(verified).toBe(0);
  });

  it("never substitutes another environment, actor, session, thread or host", async () => {
    let forwarded = 0;
    for (const change of [
      { environmentSessionId: "different" },
      { subject: "different" },
      { sessionId: "different" },
      { threadId: "different" },
      { serviceInstanceId: "different" },
      { pairingRevision: 2 },
      { inferenceOrigin: "https://different.test" },
    ]) {
      const broker = await make({
        getCredential: async () => ({
          binding: { ...binding, ...change },
          token,
          expiresAt: Date.now() + 60_000,
        }),
        fetch: async () => {
          forwarded++;
          return new Response("bad");
        },
      });
      expect((await call(broker)).status).toBe(403);
    }
    expect(forwarded).toBe(0);
  });

  it("rejects expired credentials and failed authority without a retry or token-bearing errors", async () => {
    let forwarded = 0;
    const expired = await make({
      getCredential: async () => ({ binding, token, expiresAt: Date.now() - 1 }),
      fetch: async () => {
        forwarded++;
        return new Response("bad");
      },
    });
    expect((await call(expired)).status).toBe(403);
    let renewed = 0;
    const failed = await make({
      getCredential: async () => {
        renewed++;
        throw new Error(token);
      },
    });
    const response = await call(failed);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(token);
    expect(renewed).toBe(1);
    expect(forwarded).toBe(0);
    const denied = await make({
      verifyBinding: async () => false,
      getCredential: async () => {
        renewed++;
        throw new Error("must not renew");
      },
    });
    expect((await call(denied)).status).toBe(403);
    expect(renewed).toBe(1);
  });

  it("preserves quota errors and refuses automatic fallback", async () => {
    let calls = 0;
    const broker = await make({
      fetch: async () => {
        calls++;
        return new Response('{"error":{"code":"quota_exhausted"}}', {
          status: 429,
          headers: { "retry-after": "60" },
        });
      },
    });
    const response = await call(broker);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("x-prism-fallback-allowed")).toBe("false");
    expect(await response.json()).toEqual({ error: { code: "quota_exhausted" } });
    expect(calls).toBe(1);
  });

  it("redacts known credentials split across streamed chunks", async () => {
    const broker = await make({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("prefix msp1.fix"));
              controller.enqueue(new TextEncoder().encode("ture.signature suffix"));
              controller.close();
            },
          }),
        ),
    });
    expect(await (await call(broker)).text()).toBe("prefix [redacted] suffix");
  });

  it("revocation aborts active upstream and downstream streams and rejects new requests", async () => {
    const cancelled = deferred<void>();
    const broker = await make({
      fetch: async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: first\n\n"));
              init?.signal?.addEventListener(
                "abort",
                () => {
                  controller.error(new Error("revoked"));
                  cancelled.resolve();
                },
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const response = await call(broker);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    broker.revoke();
    await cancelled.promise;
    await expect(reader.read()).rejects.toThrow();
    expect((await call(broker)).status).toBe(403);
    await broker.close();
    await broker.close();
  });

  it("propagates provider disconnect upstream without replay", async () => {
    const cancelled = deferred<void>();
    let calls = 0;
    const broker = await make({
      fetch: async (_url, init) => {
        calls++;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: first\n\n"));
              init.signal?.addEventListener(
                "abort",
                () => {
                  controller.error(new Error("disconnected"));
                  cancelled.resolve();
                },
                { once: true },
              );
            },
          }),
        );
      },
    });
    const response = await call(broker);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await cancelled.promise;
    expect(calls).toBe(1);
  });

  it("cancels an in-flight renewal on close without starting inference", async () => {
    const entered = deferred<void>();
    const cancelled = deferred<void>();
    let calls = 0;
    const broker = await make({
      getCredential: async (_binding, signal) => {
        signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
        entered.resolve();
        return new Promise(() => {});
      },
      fetch: async () => {
        calls++;
        return new Response("bad");
      },
    });
    const result = call(broker).then(
      (response) => response.status,
      () => 0,
    );
    await entered.promise;
    await broker.close();
    await cancelled.promise;
    expect([0, 403]).toContain(await result);
    expect(calls).toBe(0);
  });

  it("isolates provider bearer keys between concurrent thread brokers", async () => {
    const one = await make();
    const two = await make({ binding: { ...binding, threadId: "thread-two" } });
    const response = await fetch(two.endpoint.baseUrl + "/v1/models", {
      headers: { authorization: `Bearer ${one.endpoint.apiKey}` },
    });
    expect(response.status).toBe(401);
  });
});

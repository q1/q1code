import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import { BROWSER_IDENTITY_PATH as PATH, BrowserIdentityRelay } from "./BrowserIdentityRelay.ts";

const ORIGIN = "http://localhost:54321",
  AUTHORITY = "https://identity.mic.sc";
const now = () => Math.floor(performance.timeOrigin + performance.now());
const token = "msc1.11111111-1111-4111-8111-111111111111." + "A".repeat(43);
function fixture(exchangeGate?: () => Promise<void>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let revoked = false,
    offline = false;
  const relay = new BrowserIdentityRelay(async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (offline) throw new Error("offline");
    if (url.endsWith("/exchange")) {
      await exchangeGate?.();
      return Response.json({
        version: 1,
        tokenType: "PrismClient",
        token,
        expiresAt: now() + 60_000,
      });
    }
    if (url.endsWith("/revoke")) {
      revoked = true;
      return Response.json({ revoked: true });
    }
    if (revoked) return Response.json({}, { status: 401 });
    if (url.endsWith("/v1/identity"))
      return Response.json({
        contractVersion: 1,
        subject: "user_test",
        sessionId: "sess_test",
        role: "member",
        permissions: ["prism:inference"],
        authorizationExpiresAt: now() + 60_000,
        authorizationRevision: "r1",
      });
    if (url.endsWith("/v1/prism/discovery"))
      return Response.json({
        contractVersion: 1,
        selectionRevision: 1,
        service: {
          serviceInstanceId: "spark",
          displayName: "Spark",
          apiOrigin: "https://prism.mic.sc",
          inferenceOrigin: "https://prism.mic.sc",
          pairingRevision: 1,
          protocolVersion: 1,
          publicKey: "A".repeat(43),
          status: "paired",
        },
      });
    return Response.json({ ok: true });
  });
  let cookie = "",
    generation = "";
  const call = async (
    operation: string,
    body: unknown = {},
    options: { environment?: string; origin?: string; cookie?: string; generation?: string } = {},
  ) =>
    relay.handle(
      new Request(ORIGIN + PATH + "/" + operation, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: options.origin ?? ORIGIN,
          cookie: options.cookie ?? cookie,
          "x-q1-prism-generation": options.generation ?? generation,
        },
        body: JSON.stringify(body),
      }),
      options.environment ?? "environment-session-1",
      AUTHORITY,
    );
  const start = async () => {
    const response = await call("start");
    expect(response.status).toBe(200);
    cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    expect(response.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    const { loginUrl } = (await response.json()) as { loginUrl: string };
    const url = new URL(loginUrl);
    expect(url.origin + url.pathname).toBe("https://prism.mic.sc/browser-login");
    expect(url.search).toBe("");
    const params = new URLSearchParams(url.hash.slice(1));
    expect(params.get("redirectUri")).toBe(ORIGIN + PATH + "/callback");
    return {
      code: "B".repeat(43),
      state: params.get("state"),
      requestId: params.get("requestId"),
      challenge: params.get("challenge"),
    };
  };
  const login = async () => {
    const values = await start();
    const response = await call("complete", values);
    expect(response.status).toBe(200);
    generation = ((await response.json()) as { generation: string }).generation;
    return values;
  };
  return {
    call,
    start,
    login,
    relay,
    calls,
    revoke: () => {
      revoked = true;
    },
    offline: () => {
      offline = true;
    },
  };
}
describe("browser identity relay", () => {
  it("revokes a grant issued after logout wins the exchange race", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(async () => {
      entered();
      await paused;
    });
    const values = await f.start();
    const completing = f.call("complete", values);
    await started;
    expect((await f.call("revoke")).status).toBe(200);
    release();
    expect((await completing).status).toBe(401);
    const revocation = f.calls.find((call) => call.url.endsWith("/cli/revoke"));
    expect(new Headers(revocation?.init?.headers).get("x-prism-client")).toBe(token);
    expect(await (await f.call("status")).json()).toEqual({ generation: null });
  });
  it("exchanges PKCE once and returns only a nonsecret handle", async () => {
    const f = fixture(),
      values = await f.login();
    const exchange = f.calls.find((x) => x.url.endsWith("/exchange"))!;
    const body = JSON.parse(String(exchange.init!.body));
    expect(NodeCrypto.createHash("sha256").update(body.verifier).digest("base64url")).toBe(
      values.challenge,
    );
    const status = await f.call("status");
    expect(await status.text()).not.toContain("msc1.");
    expect((await f.call("complete", values)).status).toBe(403);
  });
  it("requires origin, private cookie and the initiating environment", async () => {
    const f = fixture();
    await f.login();
    expect((await f.call("proxy", {}, { cookie: "" })).status).toBe(401);
    expect((await f.call("proxy", {}, { environment: "other" })).status).toBe(401);
    expect((await f.call("status", {}, { origin: "https://evil.example" })).status).toBe(403);
    expect(
      (
        await f.call(
          "proxy",
          { url: AUTHORITY + "/v1/identity", method: "GET" },
          { generation: "q1br_wrong" },
        )
      ).status,
    ).toBe(403);
  });
  it("rejects a wrong state without consuming the pending code", async () => {
    const f = fixture(),
      values = await f.start();
    expect((await f.call("complete", { ...values, state: "wrong" })).status).toBe(403);
    expect((await f.call("complete", values)).status).toBe(200);
  });
  it("attaches grants only to finite authority or discovered gateway paths", async () => {
    const f = fixture();
    await f.login();
    for (const url of [
      "https://evil.example/prism/v1/accounts",
      AUTHORITY + "/admin",
      "https://prism.mic.sc/prism/v1/secrets",
      AUTHORITY + "/v1/identity?leak=1",
    ])
      expect((await f.call("proxy", { url, method: "GET" })).status).toBe(403);
    expect(
      (
        await f.call("proxy", {
          url: "https://prism.mic.sc/prism/v1/accounts/login/session-1/callback",
          method: "POST",
          body: '{"redirectUrl":"https://callback.example"}',
        })
      ).status,
    ).toBe(200);
    const upstream = f.calls.at(-1)!;
    expect(new Headers(upstream.init!.headers).get("authorization")).toBe("Bearer " + token);
    expect(new Headers(upstream.init!.headers).get("cookie")).toBeNull();
    expect(upstream.init!.body).toContain("redirectUrl");
    expect((await f.call("proxy", { url: AUTHORITY + "/v1/identity", method: "GET" })).status).toBe(
      200,
    );
    expect(new Headers(f.calls.at(-1)!.init!.headers).get("x-prism-client")).toBe(token);
  });
  it("fails closed offline and after upstream revocation", async () => {
    const f = fixture();
    await f.login();
    f.revoke();
    expect((await f.call("status")).status).toBe(401);
    expect(await (await f.call("status")).json()).toEqual({ generation: null });
    const g = fixture();
    await g.login();
    g.offline();
    expect((await g.call("status")).status).toBe(503);
  });
  it("logout clears browser access and revokes the upstream native grant", async () => {
    const f = fixture();
    await f.login();
    expect((await f.call("revoke")).status).toBe(200);
    expect(await (await f.call("status")).json()).toEqual({ generation: null });
    expect(f.calls.some((x) => x.url.endsWith("/cli/revoke"))).toBe(true);
  });
  it("callback removes fragment before exact-origin opener delivery and never contacts the server", async () => {
    const response = fixture().relay.callback(),
      html = await response.text();
    expect(html.indexOf("history.replaceState")).toBeLessThan(html.indexOf("postMessage"));
    expect(html).toContain("},location.origin)");
    expect(html).not.toContain("fetch(");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});

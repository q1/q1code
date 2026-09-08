import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import {
  bindBrowserIdentityRelay,
  browserIdentityFetch,
  browserIdentityRequest,
} from "./browserIdentityRelay";

afterEach(() => vi.unstubAllGlobals());
describe("browser identity transport", () => {
  it("routes handles using environment auth and private cookies, preserving encoded JSON bodies", async () => {
    const transport = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", transport);
    const dispose = bindBrowserIdentityRelay({
      authority: "https://identity.mic.sc",
      authorization: "Bearer environment-fixture",
    });
    try {
      const response = await browserIdentityFetch("https://identity.mic.sc/v1/prism/credentials", {
        method: "POST",
        headers: { authorization: "Bearer q1br_generation" },
        body: new TextEncoder().encode('{"pairingRevision":1}'),
      });
      expect(response.status).toBe(200);
      const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("/api/fork/prism/identity/browser/proxy");
      expect(init.credentials).toBe("same-origin");
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer environment-fixture");
      expect(headers.get("x-q1-prism-generation")).toBe("q1br_generation");
      expect(JSON.parse(String(init.body)).body).toBe('{"pairingRevision":1}');
    } finally {
      dispose();
    }
  });
  it("leaves native SDK and short-lived inference requests on their existing transport", async () => {
    const transport = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", transport);
    const init = { headers: { authorization: "Bearer msp1.fixture.signature" } };
    await browserIdentityFetch("https://prism.mic.sc/v1/models", init);
    expect(transport).toHaveBeenCalledWith("https://prism.mic.sc/v1/models", init);
  });
  it("fails a pending operation when the environment binding changes", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const dispose = bindBrowserIdentityRelay({
      authority: "https://identity.mic.sc",
      authorization: null,
    });
    const pending = browserIdentityRequest("status");
    dispose();
    finish(Response.json({ generation: "q1br_old" }));
    await expect(pending).rejects.toThrow("Environment connection changed");
  });
});

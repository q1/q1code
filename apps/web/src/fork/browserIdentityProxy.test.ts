import { describe, expect, it } from "vite-plus/test";
import { withBrowserIdentityProxy } from "./browserIdentityProxy";

describe("browser identity development proxy", () => {
  it("preserves ordinary and websocket proxy settings while retaining the identity origin", () => {
    const target = "http://127.0.0.1:4000";
    const rpc = { target, changeOrigin: true };
    const socket = { target, changeOrigin: true, ws: true };
    const original = { "/api": rpc, "/ws": socket };
    const result = withBrowserIdentityProxy(target, original);
    expect(result["/api"]).toBe(rpc);
    expect(result["/ws"]).toBe(socket);
    expect(result["/api/fork/prism/identity/browser"]).toEqual({ target, changeOrigin: false });
    expect(Object.keys(original)).toEqual(["/api", "/ws"]);
  });
});

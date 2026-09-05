import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { micPrismBinding, withMicPrismReadiness, withoutPrismRoute } from "./PrismRouting.ts";

describe("identity provider readiness", () => {
  const signedOut = {
    enabled: true,
    installed: true,
    status: "error",
    auth: { status: "unauthenticated" },
    message: "Log in locally",
  };
  it("makes an installed pooled provider selectable without direct-provider login", () => {
    expect(withMicPrismReadiness(signedOut, true)).toMatchObject({
      status: "ready",
      auth: { status: "authenticated", type: "prism" },
    });
  });
  it("retains flags-off, disabled and not-installed states", () => {
    expect(withMicPrismReadiness(signedOut, false)).toBe(signedOut);
    const missing = { ...signedOut, installed: false };
    expect(withMicPrismReadiness(missing, true)).toBe(missing);
    const disabled = { ...signedOut, enabled: false };
    expect(withMicPrismReadiness(disabled, true)).toBe(disabled);
  });
  it("reads the server handle but never sends it or the routing option to a provider", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("test"),
      model: "model",
      options: [
        { id: "q1.mic-binding", value: "opaque-handle" },
        { id: "prism-route", value: "prism" },
        { id: "effort", value: "high" },
      ],
    };
    expect(micPrismBinding(selection)).toBe("opaque-handle");
    expect(withoutPrismRoute(selection)?.options).toEqual([{ id: "effort", value: "high" }]);
  });
});

import { describe, expect, it } from "vite-plus/test";
import { createMicPrismThreadConnections, micPrismThreadKey } from "./micPrismThreadConnections";
import type { PrismApi } from "../prism/usePrismApi";
const config = {
  enabled: true,
  authorityUrl: "https://identity.example.test",
  clerkPublishableKey: "pk_test_example",
};
const key = micPrismThreadKey("env", "thread");
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function api(
  overrides: Partial<Pick<PrismApi, "connectThread" | "disconnectThread" | "identityConfig">> = {},
) {
  const calls: string[] = [];
  const value: Pick<PrismApi, "connectThread" | "disconnectThread" | "identityConfig"> = {
    identityConfig: async () => ({ _tag: "ok", value: config }),
    connectThread: async () => {
      calls.push("PUT");
      return { _tag: "ok", value: { threadId: "thread", expiresAt: 50000 } };
    },
    disconnectThread: async () => {
      calls.push("DELETE");
      return { _tag: "ok", value: { threadId: "thread", expiresAt: 0 } };
    },
    ...overrides,
  };
  return { value, calls };
}

describe("web Prism thread connection lifecycle", () => {
  it("disconnects late registration after unmount", async () => {
    const started = gate<void>();
    const receipt = gate<Awaited<ReturnType<PrismApi["connectThread"]>>>();
    const transport = api({
      connectThread: () => {
        started.resolve();
        return receipt.promise;
      },
    });
    const connections = createMicPrismThreadConnections(() => true);
    const connecting = connections.connect("env", "thread", transport.value, config);
    await started.promise;
    const disposed = connections.dispose();
    receipt.resolve({ _tag: "ok", value: { threadId: "thread", expiresAt: 50000 } });
    await Promise.all([connecting, disposed]);
    expect(transport.calls).toEqual(["DELETE"]);
    expect(connections.snapshot().has(key)).toBe(false);
  });
  it("serializes disconnect behind an in-flight renewal and suppresses further renewals", async () => {
    const transport = api();
    const connections = createMicPrismThreadConnections(() => true);
    await connections.connect("env", "thread", transport.value, config);
    const started = gate<void>();
    const receipt = gate<Awaited<ReturnType<PrismApi["connectThread"]>>>();
    transport.value.connectThread = () => {
      transport.calls.push("renew PUT");
      started.resolve();
      return receipt.promise;
    };
    const renew = connections.renew();
    await started.promise;
    const disconnect = connections.disconnect("env", "thread");
    expect(connections.snapshot().get(key)?.status).toBe("disconnecting");
    await connections.renew();
    receipt.resolve({ _tag: "ok", value: { threadId: "thread", expiresAt: 70000 } });
    await Promise.all([renew, disconnect]);
    expect(transport.calls).toEqual(["PUT", "renew PUT", "DELETE"]);
  });
  it("finishes old-account cleanup before permitting a new controller to register the thread", async () => {
    const deleting = gate<void>();
    const deleted = gate<Awaited<ReturnType<PrismApi["disconnectThread"]>>>();
    const oldTransport = api({
      disconnectThread: () => {
        deleting.resolve();
        return deleted.promise;
      },
    });
    const old = createMicPrismThreadConnections(() => true);
    await old.connect("env", "thread", oldTransport.value, config);
    const disposal = old.dispose();
    await deleting.promise;
    const nextTransport = api();
    const next = createMicPrismThreadConnections(() => true);
    const connecting = next.connect("env", "thread", nextTransport.value, config);
    expect(nextTransport.calls).toEqual([]);
    deleted.resolve({ _tag: "ok", value: { threadId: "thread", expiresAt: 0 } });
    await Promise.all([disposal, connecting]);
    expect(nextTransport.calls).toEqual(["PUT"]);
    expect(next.snapshot().get(key)?.status).toBe("connected");
    await next.dispose();
  });
  it("disconnects on transport change and requires an explicit reconnect", async () => {
    const transport = api();
    const connections = createMicPrismThreadConnections(() => true);
    const source = {};
    await connections.connect("env", "thread", transport.value, config, source);
    connections.updateEnvironment("env", transport.value, config, {});
    await connections.disconnect("env", "thread");
    expect(transport.calls).toEqual(["PUT", "DELETE"]);
    expect(connections.snapshot().get(key)?.status).toBe("error");
    await connections.dispose();
  });
  it("does not treat separate API wrappers around the same prepared transport as a reconnect", async () => {
    const transport = api();
    const source = {};
    const connections = createMicPrismThreadConnections(() => true);
    await connections.connect("env", "thread", transport.value, config, source);
    connections.updateEnvironment("env", api().value, config, source);
    expect(connections.snapshot().get(key)?.status).toBe("connected");
    expect(transport.calls).toEqual(["PUT"]);
    await connections.dispose();
  });
  it("rejects changed authority before registering or renewing", async () => {
    const transport = api({
      identityConfig: async () => ({
        _tag: "ok",
        value: { ...config, authorityUrl: "https://other.example.test" },
      }),
    });
    const connections = createMicPrismThreadConnections(() => true);
    await connections.connect("env", "thread", transport.value, config);
    expect(transport.calls).toEqual(["DELETE"]);
    expect(connections.snapshot().get(key)?.status).toBe("error");
    await connections.dispose();
  });
  it("retains other connected threads during navigation and clears removed environments", async () => {
    const transport = api();
    const connections = createMicPrismThreadConnections(() => true);
    await connections.connect("env", "thread", transport.value, config);
    await connections.connect("other", "second", transport.value, config);
    connections.updateEnvironment("env", null, null);
    await connections.disconnect("env", "thread");
    expect(connections.snapshot().get(micPrismThreadKey("other", "second"))?.status).toBe(
      "connected",
    );
    await connections.dispose();
  });
  it("supports the React effect cleanup/setup rehearsal before user interaction", async () => {
    const transport = api();
    const connections = createMicPrismThreadConnections(() => true);
    await connections.dispose();
    connections.activate();
    await connections.connect("env", "thread", transport.value, config);
    expect(connections.snapshot().get(key)?.status).toBe("connected");
    await connections.dispose();
  });
});

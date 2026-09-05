import type { MicIdentityPublicConfig } from "@q1code/core/micIdentityApi";
import type { PrismApi, PrismCallError } from "../prism/usePrismApi";

type Api = Pick<PrismApi, "connectThread" | "disconnectThread" | "identityConfig">;
export type ThreadConnectionState = {
  readonly status: "connecting" | "connected" | "disconnecting" | "error";
  readonly error: string | null;
};
type Entry = {
  readonly environmentId: string;
  readonly threadId: string;
  readonly api: Api;
  readonly config: MicIdentityPublicConfig;
  readonly source: unknown;
  desired: boolean;
  pending: boolean;
  state: ThreadConnectionState;
};
export const micPrismThreadKey = (environmentId: string, threadId: string) =>
  `${environmentId}/${threadId}`;

// Serialize across identity-controller lifetimes: an old DELETE must finish before a new user's PUT.
const lanes = new Map<string, Promise<void>>();
function enqueue(key: string, operation: () => Promise<void>) {
  const queued = (lanes.get(key) ?? Promise.resolve()).then(operation, operation);
  const settled = queued.catch(() => {});
  lanes.set(key, settled);
  void settled.finally(() => {
    if (lanes.get(key) === settled) lanes.delete(key);
  });
  return queued;
}
const sameConfig = (a: MicIdentityPublicConfig, b: MicIdentityPublicConfig) =>
  a.enabled &&
  b.enabled &&
  a.authorityUrl === b.authorityUrl &&
  a.clerkPublishableKey === b.clerkPublishableKey;

/** A component-independent lifecycle so unmount and account changes also clean pending registrations. */
export function createMicPrismThreadConnections(
  isCurrent: () => boolean,
  describeError: (error: PrismCallError) => string = () =>
    "Prism access could not be verified. Check sign-in and environment permissions, then reconnect.",
) {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyMap<string, ThreadConnectionState> = new Map();
  let closed = false;
  const publish = () => {
    snapshot = new Map([...entries].map(([key, entry]) => [key, entry.state]));
    for (const listener of listeners) listener();
  };
  const current = (key: string, entry: Entry) =>
    !closed && isCurrent() && entries.get(key) === entry && entry.desired;
  const disconnect = (environmentId: string, threadId: string, message: string | null = null) => {
    const key = micPrismThreadKey(environmentId, threadId);
    const entry = entries.get(key);
    if (!entry || entry.state.status === "disconnecting")
      return lanes.get(key) ?? Promise.resolve();
    entry.desired = false;
    entry.state = { status: "disconnecting", error: message };
    publish();
    return enqueue(key, async () => {
      const result = await entry.api.disconnectThread(threadId);
      if (entries.get(key) !== entry) return;
      if (result._tag === "error" || message) {
        entry.state = {
          status: "error",
          error:
            message ?? "Could not confirm disconnection. Retry; access will expire unless renewed.",
        };
        entry.pending = false;
      } else entries.delete(key);
      publish();
    });
  };
  const run = (key: string, entry: Entry) => {
    entry.pending = true;
    return enqueue(key, async () => {
      try {
        if (!current(key, entry)) return;
        const config = await entry.api.identityConfig();
        if (!current(key, entry)) return;
        if (config._tag !== "ok" || !sameConfig(config.value, entry.config))
          throw new Error(
            "The mic.sc authority changed or could not be verified. Check sign-in before reconnecting.",
          );
        const result = await entry.api.connectThread(entry.threadId);
        if (!current(key, entry)) return;
        if (result._tag === "error") throw new Error(describeError(result.error));
        entry.state = { status: "connected", error: null };
      } catch (error) {
        if (!current(key, entry)) return;
        entry.desired = false;
        await entry.api.disconnectThread(entry.threadId);
        if (entries.get(key) === entry)
          entry.state = {
            status: "error",
            error: error instanceof Error ? error.message : "Prism could not connect. Try again.",
          };
      } finally {
        entry.pending = false;
        publish();
      }
    });
  };
  return {
    activate: () => {
      closed = false;
    },
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect: (
      environmentId: string,
      threadId: string,
      api: Api,
      config: MicIdentityPublicConfig,
      source: unknown = api,
    ) => {
      const key = micPrismThreadKey(environmentId, threadId);
      const existing = entries.get(key);
      if (closed || !isCurrent() || existing?.pending || existing?.state.status === "disconnecting")
        return Promise.resolve();
      const entry: Entry = {
        environmentId,
        threadId,
        api,
        config,
        source,
        desired: true,
        pending: false,
        state: { status: "connecting", error: null },
      };
      entries.set(key, entry);
      publish();
      return run(key, entry);
    },
    disconnect,
    renew: () =>
      Promise.all(
        [...entries]
          .filter(([, entry]) => entry.desired && !entry.pending)
          .map(([key, entry]) => run(key, entry)),
      ).then(() => {}),
    updateEnvironment: (
      environmentId: string,
      api: Api | null,
      config: MicIdentityPublicConfig | null,
      source: unknown = api,
    ) => {
      for (const entry of entries.values()) {
        if (
          entry.environmentId === environmentId &&
          entry.desired &&
          (!api || entry.source !== source || !config || !sameConfig(entry.config, config))
        )
          void disconnect(
            environmentId,
            entry.threadId,
            "The environment connection changed. Reconnect this thread to Prism.",
          );
      }
    },
    environments: () => [...new Set([...entries.values()].map((entry) => entry.environmentId))],
    dispose: () => {
      closed = true;
      return Promise.all(
        [...entries.values()].map((entry) => disconnect(entry.environmentId, entry.threadId)),
      ).then(() => {});
    },
  };
}

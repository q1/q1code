import { ClerkProvider, useAuth } from "@clerk/expo";
import type { MicIdentityPublicConfig } from "@q1code/core/micIdentityApi";
import { readForkFlag } from "@t3tools/client-runtime/fork";
import type { EnvironmentId } from "@t3tools/contracts";
import * as SecureStore from "expo-secure-store";
import {
  createContext,
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";

import { resolveCloudPublicConfig } from "../../features/cloud/publicConfig";
import { useServerConfigs } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { freshMicMobileToken, resolveMicMobileIdentityMode } from "./micIdentity.logic";
import { MicPrismTokenContext } from "./micIdentityContext";
import { type PrismApi, usePrismApi } from "./usePrismApi";

type Binding = {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly expiresAt: number;
};
type ThreadBridge = {
  readonly config: MicIdentityPublicConfig;
  readonly bindings: ReadonlyMap<string, Binding>;
  readonly error: string | null;
  readonly active: boolean;
  readonly connect: (environmentId: EnvironmentId, threadId: string) => Promise<void>;
  readonly disconnect: (environmentId: EnvironmentId, threadId: string) => Promise<void>;
  readonly invalidate: () => void;
};
export const MicPrismThreadBridgeContext = createContext<ThreadBridge | null>(null);
export const MicPrismRootPresentContext = createContext(false);

const tokenCache = {
  getToken: (key: string) => SecureStore.getItemAsync(`q1code.mic-sc.${key}`),
  saveToken: (key: string, value: string) =>
    SecureStore.setItemAsync(`q1code.mic-sc.${key}`, value),
  clearToken: (key: string) => SecureStore.deleteItemAsync(`q1code.mic-sc.${key}`),
};
const bindingKey = (environmentId: EnvironmentId, threadId: string) =>
  `${environmentId}/${threadId}`;

/** Existing navigation layout seam keeps credentials and renewal alive while changing screens. */
export function withMicPrismIdentity<P extends { children: ReactNode }>(Layout: ComponentType<P>) {
  return function MicPrismLayout(props: P) {
    return (
      <MicPrismRootPresentContext.Provider value={true}>
        <PersistentIdentity>
          <Layout {...props} />
        </PersistentIdentity>
      </MicPrismRootPresentContext.Provider>
    );
  };
}

function PersistentIdentity(props: { readonly children: ReactNode }) {
  const { environments } = useEnvironments();
  const configs = useServerConfigs();
  const targets = environments
    .filter(({ environmentId }) =>
      readForkFlag(configs.get(environmentId)?.environment.capabilities, "mic-identity"),
    )
    .map(({ environmentId }) => environmentId)
    .sort();
  return targets[0] ? (
    <ConfiguredIdentity environmentId={targets[0]} targets={targets}>
      {props.children}
    </ConfiguredIdentity>
  ) : (
    props.children
  );
}

function ConfiguredIdentity(props: {
  readonly environmentId: EnvironmentId;
  readonly targets: ReadonlyArray<EnvironmentId>;
  readonly children: ReactNode;
}) {
  const api = usePrismApi(props.environmentId);
  const [loaded, setLoaded] = useState<{
    readonly source: PrismApi;
    readonly environmentId: EnvironmentId;
    readonly config: MicIdentityPublicConfig;
  } | null>(null);
  const config =
    loaded?.source === api && loaded.environmentId === props.environmentId ? loaded.config : null;
  useEffect(() => {
    let current = true;
    if (api)
      void api.identityConfig().then((result) => {
        if (current)
          setLoaded(
            result._tag === "ok"
              ? { source: api, environmentId: props.environmentId, config: result.value }
              : null,
          );
      });
    return () => {
      current = false;
    };
  }, [api, props.environmentId]);
  if (!config) return props.children;
  const cloud = resolveCloudPublicConfig();
  const mode = resolveMicMobileIdentityMode(
    config,
    cloud.relay.url ? cloud.clerk.publishableKey : null,
    true,
  );
  if (mode !== "local" && mode !== "shared") return props.children;
  const content = (
    <IdentitySession
      key={`${config.authorityUrl}:${config.clerkPublishableKey}`}
      config={config}
      targets={props.targets}
    >
      {props.children}
    </IdentitySession>
  );
  return mode === "shared" ? (
    content
  ) : (
    <ClerkProvider publishableKey={config.clerkPublishableKey!} tokenCache={tokenCache}>
      {content}
    </ClerkProvider>
  );
}

function IdentitySession(props: {
  readonly config: MicIdentityPublicConfig;
  readonly targets: ReadonlyArray<EnvironmentId>;
  readonly children: ReactNode;
}) {
  const { isSignedIn, sessionId, userId, getToken } = useAuth();
  const key = isSignedIn && sessionId && userId ? `${userId}:${sessionId}` : "signed-out";
  return (
    <ThreadBridgeProvider
      key={key}
      identityKey={key}
      config={props.config}
      targets={props.targets}
      getToken={getToken}
    >
      {props.children}
    </ThreadBridgeProvider>
  );
}

function ThreadBridgeProvider(props: {
  readonly identityKey: string;
  readonly config: MicIdentityPublicConfig;
  readonly targets: ReadonlyArray<EnvironmentId>;
  readonly getToken: (options: { skipCache: boolean }) => Promise<string | null>;
  readonly children: ReactNode;
}) {
  const apis = useRef(new Map<EnvironmentId, PrismApi>());
  const bindings = useRef(new Map<string, Binding>());
  const pending = useRef(new Set<string>());
  const generations = useRef(new Map<string, number>());
  const valid = useRef(props.identityKey !== "signed-out");
  const invalidated = useRef(false);
  const [active, setActive] = useState(props.identityKey !== "signed-out");
  const [snapshot, setSnapshot] = useState<ReadonlyMap<string, Binding>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const isCurrent = useCallback(() => valid.current, []);
  const source = useCallback(
    () => freshMicMobileToken(props.getToken, isCurrent)(),
    [props.getToken, isCurrent],
  );
  const disconnect = useCallback(async (environmentId: EnvironmentId, threadId: string) => {
    const key = bindingKey(environmentId, threadId);
    generations.current.set(key, (generations.current.get(key) ?? 0) + 1);
    bindings.current.delete(key);
    setSnapshot(new Map(bindings.current));
    const result = await apis.current.get(environmentId)?.disconnectIdentityThread(threadId);
    if (result?._tag === "error")
      setError("Could not confirm disconnection. Prism access will expire unless renewed.");
  }, []);
  const connect = useCallback(
    async (environmentId: EnvironmentId, threadId: string) => {
      const api = apis.current.get(environmentId);
      const key = bindingKey(environmentId, threadId);
      if (!valid.current || !api || pending.current.has(key)) return;
      pending.current.add(key);
      const generation = generations.current.get(key) ?? 0;
      try {
        const config = await api.identityConfig();
        if (
          config._tag !== "ok" ||
          config.value.authorityUrl !== props.config.authorityUrl ||
          config.value.clerkPublishableKey !== props.config.clerkPublishableKey
        ) {
          await disconnect(environmentId, threadId);
          setError(
            "The mic.sc authority changed. Refresh sign-in before reconnecting this thread.",
          );
          return;
        }
        if (!valid.current || generation !== (generations.current.get(key) ?? 0)) return;
        const result = await api.connectIdentityThread(threadId);
        if (!valid.current || generation !== (generations.current.get(key) ?? 0)) {
          await api.disconnectIdentityThread(threadId);
          return;
        }
        if (result._tag === "error") {
          await disconnect(environmentId, threadId);
          setError(
            "Prism access could not be renewed for this thread. Reconnect after checking sign-in and environment permissions.",
          );
          return;
        }
        bindings.current.set(key, { environmentId, threadId, expiresAt: result.value.expiresAt });
        setSnapshot(new Map(bindings.current));
        setError(null);
      } finally {
        pending.current.delete(key);
      }
    },
    [disconnect, props.config.authorityUrl, props.config.clerkPublishableKey],
  );
  const invalidate = useCallback(() => {
    invalidated.current = true;
    valid.current = false;
    setActive(false);
    for (const binding of bindings.current.values())
      void disconnect(binding.environmentId, binding.threadId);
  }, [disconnect]);
  useLayoutEffect(() => {
    valid.current = !invalidated.current && props.identityKey !== "signed-out";
    return () => {
      valid.current = false;
    };
  }, [props.identityKey]);
  useEffect(() => {
    valid.current = !invalidated.current && props.identityKey !== "signed-out";
    const renew = () => {
      if (valid.current && AppState.currentState === "active")
        for (const binding of bindings.current.values())
          void connect(binding.environmentId, binding.threadId);
    };
    const timer = setInterval(renew, 45_000);
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") renew();
    });
    return () => {
      valid.current = false;
      clearInterval(timer);
      listener.remove();
      for (const binding of bindings.current.values())
        void apis.current.get(binding.environmentId)?.disconnectIdentityThread(binding.threadId);
    };
  }, [connect, props.identityKey]);
  const register = useCallback((environmentId: EnvironmentId, api: PrismApi | null) => {
    if (api) {
      apis.current.set(environmentId, api);
      return;
    }
    const previous = apis.current.get(environmentId);
    apis.current.delete(environmentId);
    for (const key of pending.current) {
      if (key.startsWith(`${environmentId}/`))
        generations.current.set(key, (generations.current.get(key) ?? 0) + 1);
    }
    let changed = false;
    for (const [key, binding] of bindings.current) {
      if (binding.environmentId !== environmentId) continue;
      generations.current.set(key, (generations.current.get(key) ?? 0) + 1);
      bindings.current.delete(key);
      changed = true;
      void previous?.disconnectIdentityThread(binding.threadId);
    }
    if (changed) setSnapshot(new Map(bindings.current));
  }, []);
  const value = useMemo(
    () => ({
      config: props.config,
      bindings: snapshot,
      active,
      error,
      connect,
      disconnect,
      invalidate,
    }),
    [props.config, snapshot, active, error, connect, disconnect, invalidate],
  );
  return (
    <MicPrismTokenContext.Provider value={source}>
      <MicPrismThreadBridgeContext.Provider value={value}>
        {props.targets.map((environmentId) => (
          <BridgeEnvironment
            key={environmentId}
            environmentId={environmentId}
            register={register}
          />
        ))}
        {props.children}
      </MicPrismThreadBridgeContext.Provider>
    </MicPrismTokenContext.Provider>
  );
}

function BridgeEnvironment(props: {
  readonly environmentId: EnvironmentId;
  readonly register: (environmentId: EnvironmentId, api: PrismApi | null) => void;
}) {
  const { environmentId, register } = props;
  const api = usePrismApi(environmentId);
  useLayoutEffect(() => {
    register(environmentId, api);
  }, [api, environmentId, register]);
  useLayoutEffect(() => () => register(environmentId, null), [environmentId, register]);
  return null;
}

import { ClerkProvider, useAuth } from "@clerk/expo";
import { AuthView } from "@clerk/expo/native";
import type { MicIdentityAccess, MicIdentityPublicConfig } from "@q1code/core/micIdentityApi";
import type { PrismRoutingStrategy } from "@q1code/core/config";
import {
  getMicIdentityAccess,
  getMicPrismStatus,
  getMicPrismRouting,
  setMicPrismRouting,
} from "@t3tools/client-runtime/fork";
import { useIsFocused } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SecureStore from "expo-secure-store";
import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, Modal, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { resolveCloudPublicConfig } from "../../features/cloud/publicConfig";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { runtime } from "../../lib/runtime";
import { freshMicMobileToken, resolveMicMobileIdentityMode } from "./micIdentity.logic";
import {
  MicPrismRootPresentContext,
  MicPrismThreadBridgeContext,
} from "./PersistentMicPrismIdentity";
import { MicPrismThreadSection } from "./MicPrismThreadSection";
import { MicPrismInferenceSection } from "./MicPrismInferenceSection";
import { MicPrismTokenContext } from "./micIdentityContext";
import { describePrismError, PRISM_ROUTING_OPTIONS } from "./prismSettings.logic";
import { usePrismApi } from "./usePrismApi";

const micTokenCache = {
  getToken: (key: string) => SecureStore.getItemAsync(`q1code.mic-sc.${key}`),
  saveToken: (key: string, value: string) =>
    SecureStore.setItemAsync(`q1code.mic-sc.${key}`, value),
  clearToken: (key: string) => SecureStore.deleteItemAsync(`q1code.mic-sc.${key}`),
};

export function PrismIdentityBoundary(props: {
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
  readonly allowLocalProvider: boolean;
  readonly children: ReactNode;
}) {
  return props.enabled ? <ConfiguredBoundary {...props} /> : props.children;
}

function ConfiguredBoundary(props: Parameters<typeof PrismIdentityBoundary>[0]) {
  const persistent = useContext(MicPrismThreadBridgeContext);
  const rootPresent = useContext(MicPrismRootPresentContext);
  const api = usePrismApi(props.environmentId);
  const [config, setConfig] = useState<MicIdentityPublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.identityConfig().then((result) => {
      if (cancelled) return;
      if (result._tag === "ok") {
        setConfig(result.value);
        setError(null);
      } else setError(describePrismError(result.error));
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (config === null) {
    return <IdentityNotice message={error ?? "Loading mic.sc sign-in…"} />;
  }
  const cloud = resolveCloudPublicConfig();
  const mode = persistent
    ? "shared"
    : resolveMicMobileIdentityMode(
        config,
        cloud.relay.url ? cloud.clerk.publishableKey : null,
        props.allowLocalProvider,
      );
  if (mode === "off") return props.children;
  if (mode === "unconfigured")
    return <IdentityNotice message="mic.sc sign-in is not configured on this environment." />;
  if (mode === "incompatible")
    return (
      <IdentityNotice message="This mobile build uses another sign-in service. Open q1code in a browser configured for mic.sc, or use a mobile build configured for the same mic.sc account service." />
    );
  if (
    persistent &&
    (persistent.config.authorityUrl !== config.authorityUrl ||
      persistent.config.clerkPublishableKey !== config.clerkPublishableKey)
  )
    return (
      <IdentityNotice message="This environment uses a different mic.sc authority. Use a matching connection to manage Prism." />
    );
  if (rootPresent && !persistent) return <IdentityNotice message="Preparing mic.sc sign-in…" />;
  const content = (
    <SignedIdentity
      key={`${config.authorityUrl}:${config.clerkPublishableKey}`}
      config={config}
      environmentId={props.environmentId}
    />
  );
  return persistent || mode === "shared" ? (
    content
  ) : (
    <ClerkProvider publishableKey={config.clerkPublishableKey!} tokenCache={micTokenCache}>
      {content}
    </ClerkProvider>
  );
}

function SignedIdentity(props: {
  readonly config: MicIdentityPublicConfig;
  readonly environmentId: EnvironmentId;
}) {
  const persistent = useContext(MicPrismThreadBridgeContext);
  const { isLoaded, isSignedIn, userId, sessionId, getToken, signOut } = useAuth();
  const [authOpen, setAuthOpen] = useState(false);
  const [locallySignedOutSession, setLocallySignedOutSession] = useState<string | null>(null);
  const locallySignedOut =
    (sessionId != null && locallySignedOutSession === sessionId) || persistent?.active === false;
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const identityKey =
    !locallySignedOut && isSignedIn && userId && sessionId
      ? `${userId}:${sessionId}`
      : "signed-out";
  const currentIdentity = useRef(identityKey);
  useLayoutEffect(() => {
    currentIdentity.current = identityKey;
    return () => {
      currentIdentity.current = "unmounted";
    };
  }, [identityKey]);
  const isCurrent = useCallback(
    () => identityKey !== "signed-out" && currentIdentity.current === identityKey,
    [identityKey],
  );
  const source = useCallback(
    () => freshMicMobileToken(getToken, isCurrent)(),
    [getToken, isCurrent],
  );
  return (
    <MicPrismTokenContext.Provider value={source}>
      <SettingsSection title="mic.sc account">
        <View className="gap-3 p-4">
          <Text className="text-sm text-foreground-muted">
            mic.sc gives you access to the shared Prism service. Environment connections keep their
            own permissions.
          </Text>
          {isSignedIn ? (
            <IdentityButton
              label={locallySignedOut ? "Retry sign out" : "Sign out of mic.sc"}
              onPress={() => {
                persistent?.invalidate();
                currentIdentity.current = "signed-out";
                setLocallySignedOutSession(sessionId ?? null);
                setSignOutError(null);
                void signOut().catch(() =>
                  setSignOutError(
                    "Could not finish signing out. Retry when the account service is available.",
                  ),
                );
              }}
            />
          ) : (
            <IdentityButton
              label={isLoaded ? "Sign in with mic.sc" : "Loading sign-in…"}
              disabled={!isLoaded}
              onPress={() => setAuthOpen(true)}
            />
          )}
          {signOutError ? (
            <Text className="text-sm text-adaptive-rose-700-300">{signOutError}</Text>
          ) : null}
        </View>
      </SettingsSection>
      <Modal
        visible={authOpen && !isSignedIn}
        animationType="slide"
        onRequestClose={() => setAuthOpen(false)}
      >
        <View className="flex-1 bg-sheet">
          <AuthView
            mode="signIn"
            isDismissible
            onDismiss={() => setAuthOpen(false)}
            onHostBack={() => setAuthOpen(false)}
          />
        </View>
      </Modal>
      {isSignedIn && !locallySignedOut ? (
        <MicPrismThreadSection environmentId={props.environmentId} />
      ) : null}
      {isSignedIn && !locallySignedOut ? (
        <MicService key={identityKey} config={props.config} source={source} isCurrent={isCurrent} />
      ) : null}
    </MicPrismTokenContext.Provider>
  );
}

function MicService(props: {
  readonly config: MicIdentityPublicConfig;
  readonly source: ReturnType<typeof freshMicMobileToken>;
  readonly isCurrent: () => boolean;
}) {
  const focused = useIsFocused();
  const [access, setAccess] = useState<MicIdentityAccess | null>(null);
  const [gateway, setGateway] = useState<Effect.Success<
    ReturnType<typeof getMicPrismStatus>
  > | null>(null);
  const [strategy, setStrategy] = useState<PrismRoutingStrategy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refreshGeneration = useRef(0);
  const changingRouting = useRef(false);
  const refreshInFlight = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const input = useMemo(
    () => ({
      baseUrl: props.config.authorityUrl!,
      getToken: props.source,
      isCurrent: props.isCurrent,
    }),
    [props.config.authorityUrl, props.source, props.isCurrent],
  );
  const serviceId = access?.discovery.service?.id;
  const servicePairingRevision = access?.discovery.service?.pairingRevision;
  const serviceApiUrl = access?.discovery.service?.apiUrl;
  const serviceInferenceUrl = access?.discovery.service?.inferenceUrl;
  const boundInput = useMemo(
    () => ({
      ...input,
      ...(serviceId && servicePairingRevision !== undefined
        ? {
            expectedService: {
              id: serviceId,
              pairingRevision: servicePairingRevision,
              apiUrl: serviceApiUrl,
              inferenceUrl: serviceInferenceUrl,
            },
          }
        : {}),
    }),
    [input, serviceId, servicePairingRevision, serviceApiUrl, serviceInferenceUrl],
  );
  const refresh = useCallback(async () => {
    if (changingRouting.current || refreshInFlight.current) return;
    refreshInFlight.current = true;
    const generation = ++refreshGeneration.current;
    const current = () =>
      mounted.current && generation === refreshGeneration.current && input.isCurrent();
    setRefreshing(true);
    const fail = (failure: { readonly _tag: string }) => {
      if (
        failure._tag === "MicIdentityUnauthorizedError" ||
        failure._tag === "MicIdentityForbiddenError"
      ) {
        setAccess(null);
        setGateway(null);
        setStrategy(null);
      }
    };
    try {
      const result = await runtime.runPromise(getMicIdentityAccess(input).pipe(Effect.result));
      if (!current()) return;
      if (result._tag === "Failure") {
        fail(result.failure);
        setRefreshing(false);
        setError(describePrismError(result.failure));
        return;
      }
      setAccess(result.success);
      const status = await runtime.runPromise(getMicPrismStatus(input).pipe(Effect.result));
      if (!current()) return;
      if (status._tag === "Failure") {
        fail(status.failure);
        setRefreshing(false);
        setError(describePrismError(status.failure));
        return;
      }
      setGateway(status.success);
      setError(null);
      if (result.success.session.permissions.includes("prism:routing:read")) {
        const routing = await runtime.runPromise(getMicPrismRouting(input).pipe(Effect.result));
        if (!current()) return;
        if (routing._tag === "Success") setStrategy(routing.success.strategy);
        else {
          fail(routing.failure);
          setError(describePrismError(routing.failure));
        }
      } else setStrategy(null);
    } finally {
      refreshInFlight.current = false;
      if (current()) setRefreshing(false);
    }
  }, [input]);
  useEffect(() => {
    if (!focused) return;
    void refresh();
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void refresh();
    }, 10_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [refresh, focused]);
  const canRoute =
    error === null &&
    !refreshing &&
    gateway !== null &&
    access !== null &&
    access.session.permissions.includes("prism:routing:write");
  useEffect(() => {
    if (!access) return;
    const expires = setTimeout(
      () => setError("Prism access needs to be refreshed."),
      Math.max(0, access.session.authorizationExpiresAt - Date.now()),
    );
    return () => clearTimeout(expires);
  }, [access]);
  const changeRouting = async (next: PrismRoutingStrategy) => {
    if (!canRoute || changingRouting.current) return;
    changingRouting.current = true;
    ++refreshGeneration.current;
    setBusy(true);
    const result = await runtime.runPromise(
      setMicPrismRouting({ ...boundInput, strategy: next }).pipe(Effect.result),
    );
    changingRouting.current = false;
    if (!mounted.current || !input.isCurrent()) return;
    setBusy(false);
    if (result._tag === "Failure") {
      if (
        result.failure._tag === "MicIdentityUnauthorizedError" ||
        result.failure._tag === "MicIdentityForbiddenError"
      ) {
        setAccess(null);
        setGateway(null);
        setStrategy(null);
      }
      setError(describePrismError(result.failure));
      return;
    }
    setStrategy(result.success.strategy);
    await refresh();
  };
  return (
    <>
      <SettingsSection title="Paired Prism service">
        <View className="gap-3 p-4">
          {access ? (
            <>
              <Text className="text-sm text-foreground">{access.session.subject}</Text>
              <Text className="text-base text-foreground">
                {access.discovery.service?.label ?? "No paired service"}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {gateway && !error
                  ? "Access verified. Engine health is not reported by this gateway."
                  : "Service health has not been verified."}
              </Text>
            </>
          ) : (
            <Text className="text-sm text-foreground-muted">
              {error ? "Prism access unavailable" : "Checking Prism access…"}
            </Text>
          )}
          {error ? (
            <Text className="text-sm text-adaptive-rose-700-300">
              {access ? "Last known service. " : ""}
              {error}
            </Text>
          ) : null}
          <IdentityButton
            label={refreshing ? "Refreshing…" : "Refresh Prism access"}
            disabled={busy || refreshing}
            onPress={() => void refresh()}
          />
          {access?.session.permissions.includes("prism:routing:read") ? (
            <View className="flex-row flex-wrap gap-2">
              {PRISM_ROUTING_OPTIONS.map((option) => (
                <IdentityButton
                  key={option.value}
                  label={`${strategy === option.value ? "✓ " : ""}${option.label}`}
                  disabled={!canRoute || busy}
                  onPress={() => void changeRouting(option.value)}
                />
              ))}
            </View>
          ) : null}
        </View>
      </SettingsSection>
      {access && gateway ? (
        <MicPrismInferenceSection
          key={`${serviceId}:${servicePairingRevision}:${serviceApiUrl}:${serviceInferenceUrl}`}
          input={boundInput}
          enabled={error === null}
        />
      ) : null}
    </>
  );
}

function IdentityNotice(props: { readonly message: string }) {
  return (
    <SettingsSection title="mic.sc account">
      <Text className="p-4 text-sm text-foreground-muted">{props.message}</Text>
    </SettingsSection>
  );
}

function IdentityButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="rounded-full bg-subtle px-4 py-2"
    >
      <Text
        className={props.disabled ? "text-sm text-foreground-muted" : "text-sm text-foreground"}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

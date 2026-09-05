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
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SecureStore from "expo-secure-store";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Modal, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { resolveCloudPublicConfig } from "../../features/cloud/publicConfig";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { runtime } from "../../lib/runtime";
import { freshMicMobileToken, resolveMicMobileIdentityMode } from "./micIdentity.logic";
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
    return (
      <>
        <IdentityNotice message={error ?? "Loading mic.sc sign-in…"} />
        {props.children}
      </>
    );
  }
  const cloud = resolveCloudPublicConfig();
  const mode = resolveMicMobileIdentityMode(
    config,
    cloud.relay.url ? cloud.clerk.publishableKey : null,
    props.allowLocalProvider,
  );
  if (mode === "off") return props.children;
  if (mode === "unconfigured")
    return (
      <>
        <IdentityNotice message="mic.sc sign-in is not configured on this environment." />
        {props.children}
      </>
    );
  if (mode === "incompatible")
    return (
      <>
        <IdentityNotice message="This mobile build uses another sign-in service. Open q1code in a browser configured for mic.sc, or use a mobile build configured for the same mic.sc account service." />
        {props.children}
      </>
    );
  const content = (
    <SignedIdentity config={config} environmentId={props.environmentId}>
      {props.children}
    </SignedIdentity>
  );
  return mode === "shared" ? (
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
  readonly children: ReactNode;
}) {
  const { isLoaded, isSignedIn, userId, sessionId, getToken, signOut } = useAuth();
  const [authOpen, setAuthOpen] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const identityKey = isSignedIn && userId && sessionId ? `${userId}:${sessionId}` : "signed-out";
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
              label="Sign out of mic.sc"
              onPress={() => {
                currentIdentity.current = "signed-out";
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
      {isSignedIn ? (
        <MicService key={identityKey} config={props.config} source={source} isCurrent={isCurrent} />
      ) : null}
      <Fragment key={identityKey}>{props.children}</Fragment>
    </MicPrismTokenContext.Provider>
  );
}

function MicService(props: {
  readonly config: MicIdentityPublicConfig;
  readonly source: ReturnType<typeof freshMicMobileToken>;
  readonly isCurrent: () => boolean;
}) {
  const [access, setAccess] = useState<MicIdentityAccess | null>(null);
  const [gateway, setGateway] = useState<Effect.Success<
    ReturnType<typeof getMicPrismStatus>
  > | null>(null);
  const [strategy, setStrategy] = useState<PrismRoutingStrategy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refreshGeneration = useRef(0);
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
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const current = () =>
      mounted.current && generation === refreshGeneration.current && input.isCurrent();
    const result = await runtime.runPromise(getMicIdentityAccess(input).pipe(Effect.result));
    if (!current()) return;
    if (result._tag === "Failure") {
      setError(describePrismError(result.failure));
      return;
    }
    setAccess(result.success);
    const status = await runtime.runPromise(getMicPrismStatus(input).pipe(Effect.result));
    if (!current()) return;
    if (status._tag === "Failure") {
      setError(describePrismError(status.failure));
      return;
    }
    setGateway(status.success);
    setError(null);
    if (result.success.session.permissions.includes("prism:routing:read")) {
      const routing = await runtime.runPromise(getMicPrismRouting(input).pipe(Effect.result));
      if (!current()) return;
      if (routing._tag === "Success") setStrategy(routing.success.strategy);
      else setError(describePrismError(routing.failure));
    } else setStrategy(null);
  }, [input]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const canRoute =
    error === null &&
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
    if (!canRoute || busy) return;
    setBusy(true);
    const result = await runtime.runPromise(
      setMicPrismRouting({ ...input, strategy: next }).pipe(Effect.result),
    );
    if (!mounted.current) return;
    setBusy(false);
    if (result._tag === "Failure") {
      setError(describePrismError(result.failure));
      return;
    }
    setStrategy(result.success.strategy);
  };
  return (
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
          <Text className="text-sm text-foreground-muted">Checking Prism access…</Text>
        )}
        {error ? (
          <Text className="text-sm text-adaptive-rose-700-300">
            {access ? "Last known service. " : ""}
            {error}
          </Text>
        ) : null}
        <IdentityButton label="Refresh Prism access" onPress={() => void refresh()} />
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

/**
 * Settings → Prism: the CLIProxyAPI account pool of every connected
 * environment with the `cliproxy` flag on. Per environment: proxy status with
 * a restart, the accounts with enable/remove, the "Add account" sign-in flow,
 * and the routing strategy. Reachable by deep link even with the flag off
 * everywhere; it then explains how to turn Prism on.
 */
import type {
  CliProxyAccount,
  CliProxyLoginProvider,
  CliProxyStatus,
} from "@q1code/core/cliproxyApi";
import type { CliProxyRoutingStrategy } from "@q1code/core/config";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { createNativeStackScreen } from "@react-navigation/native-stack";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  Alert,
  AppState,
  type ColorValue,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { withUniwind } from "uniwind";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { CopyTextButton } from "../../components/CopyTextButton";
import { StatusPill } from "../../components/StatusPill";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useServerConfigs } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import {
  CLIPROXY_LOGIN_POLL_MS,
  CLIPROXY_LOGIN_PROVIDERS,
  CLIPROXY_OFF_HINT,
  CLIPROXY_RESTART_POLL_MS,
  CLIPROXY_ROUTING_OPTIONS,
  CLIPROXY_STATUS_POLL_MS,
  cliProxyStateTone,
  describeCliProxyAccount,
  describeCliProxyError,
  describeCliProxyStatus,
  IDLE_LOGIN_FLOW,
  INITIAL_ACCOUNTS_STATE,
  labelCliProxyLoginProvider,
  nextRestartStep,
  pendingCliProxyLoginSession,
  reduceCliProxyAccounts,
  reduceCliProxyLoginFlow,
  selectCliProxyEnvironments,
  shouldPollCliProxyStatus,
} from "./cliproxySettings.logic";
import { type CliProxyApi, useCliProxyApi } from "./useCliProxyApi";

type Reloader = () => Promise<void>;

// CopyTextButton takes a native tint; map a className onto it like ControlPill does for its menu.
const ThemedCopyTextButton = withUniwind(
  function TintedCopyTextButton({
    tintColor,
    ...props
  }: Omit<ComponentProps<typeof CopyTextButton>, "tintColor"> & {
    readonly tintColor?: ColorValue;
  }) {
    return <CopyTextButton {...props} tintColor={tintColor ?? "currentColor"} />;
  },
  { tintColor: { fromClassName: "tintColorClassName", styleProperty: "accentColor" } },
);

export function CliProxySettingsScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const configs = useServerConfigs();
  const targets = useMemo(
    () =>
      selectCliProxyEnvironments(
        environments,
        (environmentId) => configs.get(environmentId)?.environment.capabilities,
      ),
    [configs, environments],
  );
  // Each panel registers its reload so pull-to-refresh can wait on all of them.
  const reloaders = useRef(new Map<EnvironmentId, Reloader>());
  const [refreshing, setRefreshing] = useState(false);
  const registerReloader = useCallback((environmentId: EnvironmentId, reload: Reloader | null) => {
    if (reload) reloaders.current.set(environmentId, reload);
    else reloaders.current.delete(environmentId);
  }, []);
  const refreshAll = useCallback(() => {
    setRefreshing(true);
    void Promise.all([...reloaders.current.values()].map((reload) => reload())).finally(() =>
      setRefreshing(false),
    );
  }, []);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Prism" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshAll} />}
      >
        {targets.length === 0 ? (
          <View className="rounded-[24px] bg-card p-5">
            <Text className="text-lg font-t3-medium text-foreground">Prism is off</Text>
            <Text className="mt-2 text-sm leading-relaxed text-foreground-muted">
              {CLIPROXY_OFF_HINT}
            </Text>
          </View>
        ) : (
          targets.map((target) => (
            <EnvironmentPanel
              key={target.environmentId}
              environmentId={target.environmentId}
              label={targets.length > 1 ? target.label : null}
              registerReloader={registerReloader}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

/** Registered in `Stack.tsx` under `SettingsPrism`; one line there, everything else here. */
export const cliProxySettingsStackScreen = createNativeStackScreen({
  screen: CliProxySettingsScreen,
  linking: "prism",
  options: {
    title: "Prism",
  },
});

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface RestartState {
  readonly running: boolean;
  readonly note: string | null;
}

function EnvironmentPanel(props: {
  readonly environmentId: EnvironmentId;
  /** Shown above the sections when more than one environment is listed. */
  readonly label: string | null;
  readonly registerReloader: (environmentId: EnvironmentId, reload: Reloader | null) => void;
}) {
  const { environmentId, registerReloader } = props;
  const api = useCliProxyApi(environmentId);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const [status, setStatus] = useState<CliProxyStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [restart, setRestart] = useState<RestartState>({ running: false, note: null });
  const [accounts, dispatchAccounts] = useReducer(reduceCliProxyAccounts, INITIAL_ACCOUNTS_STATE);
  const [routing, setRouting] = useState<CliProxyRoutingStrategy | null>(null);
  const [routingError, setRoutingError] = useState<string | null>(null);
  const [routingBusy, setRoutingBusy] = useState(false);
  const [login, dispatchLogin] = useReducer(reduceCliProxyLoginFlow, IDLE_LOGIN_FLOW);

  const loadStatus = useCallback(async () => {
    if (!api) return;
    const result = await api.status();
    if (!mounted.current) return;
    if (result._tag === "ok") {
      setStatus(result.value);
      setStatusError(null);
    } else {
      setStatusError(describeCliProxyError(result.error));
    }
  }, [api]);

  const loadAccounts = useCallback(async () => {
    if (!api) return;
    const result = await api.listAccounts();
    if (!mounted.current) return;
    dispatchAccounts(
      result._tag === "ok"
        ? { type: "loaded", accounts: result.value }
        : { type: "loadFailed", error: describeCliProxyError(result.error) },
    );
  }, [api]);

  const loadRouting = useCallback(async () => {
    if (!api) return;
    const result = await api.getRouting();
    if (!mounted.current) return;
    if (result._tag === "ok") {
      setRouting(result.value.strategy);
      setRoutingError(null);
    } else {
      setRoutingError(describeCliProxyError(result.error));
    }
  }, [api]);

  const loadAll = useCallback(async () => {
    await Promise.all([loadStatus(), loadAccounts(), loadRouting()]);
  }, [loadAccounts, loadRouting, loadStatus]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    registerReloader(environmentId, loadAll);
    return () => registerReloader(environmentId, null);
  }, [environmentId, loadAll, registerReloader]);

  useStatusPolling(api !== null && !restart.running, loadStatus);

  const confirmRestart = () => {
    Alert.alert(
      "Restart the proxy?",
      "Provider CLIs lose their connection until it is ready again.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Restart", style: "destructive", onPress: () => void runRestart() },
      ],
    );
  };

  const runRestart = async () => {
    if (!api) return;
    setRestart({ running: true, note: null });
    const result = await api.restart();
    if (!mounted.current) return;
    if (result._tag === "error") {
      setRestart({ running: false, note: describeCliProxyError(result.error) });
      return;
    }
    setStatus(result.value);
    const startedAt = Date.now();
    let step = nextRestartStep({ state: result.value.state, elapsedMs: 0 });
    while (step === "poll") {
      await delay(CLIPROXY_RESTART_POLL_MS);
      if (!mounted.current) return;
      const polled = await api.status();
      if (!mounted.current) return;
      if (polled._tag === "ok") setStatus(polled.value);
      step = nextRestartStep({
        state: polled._tag === "ok" ? polled.value.state : "starting",
        elapsedMs: Date.now() - startedAt,
      });
    }
    setRestart({
      running: false,
      note: step === "timeout" ? "Still starting after 30 s. Pull to refresh later." : null,
    });
    if (step === "settled") void loadAccounts();
  };

  const toggleAccount = (account: CliProxyAccount, enabled: boolean) => {
    if (!api) return;
    dispatchAccounts({ type: "toggle", id: account.id, disabled: !enabled });
    void api.patchAccount(account.id, { disabled: !enabled }).then((result) => {
      if (!mounted.current) return;
      dispatchAccounts(
        result._tag === "ok"
          ? { type: "toggled", id: account.id, account: result.value }
          : { type: "toggleFailed", id: account.id, error: describeCliProxyError(result.error) },
      );
    });
  };

  const confirmRemove = (account: CliProxyAccount) => {
    Alert.alert(
      `Remove ${account.email ?? account.label}?`,
      "The auth file is deleted from the proxy and the removal syncs to the other environments.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            if (!api) return;
            dispatchAccounts({ type: "remove", id: account.id });
            void api.deleteAccount(account.id).then((result) => {
              if (!mounted.current) return;
              dispatchAccounts(
                result._tag === "ok"
                  ? { type: "removed", id: account.id }
                  : {
                      type: "removeFailed",
                      id: account.id,
                      error: describeCliProxyError(result.error),
                    },
              );
            });
          },
        },
      ],
    );
  };

  const selectRouting = (strategy: CliProxyRoutingStrategy) => {
    if (!api || routingBusy || strategy === routing) return;
    const previous = routing;
    setRouting(strategy);
    setRoutingError(null);
    setRoutingBusy(true);
    void api.setRouting(strategy).then((result) => {
      if (!mounted.current) return;
      setRoutingBusy(false);
      if (result._tag === "ok") {
        setRouting(result.value.strategy);
      } else {
        setRouting(previous);
        setRoutingError(describeCliProxyError(result.error));
      }
    });
  };

  if (!api) {
    return (
      <PanelFrame label={props.label}>
        <SettingsSection title="Status">
          <Text className="p-4 text-base text-foreground-muted">Connecting…</Text>
        </SettingsSection>
      </PanelFrame>
    );
  }

  return (
    <PanelFrame label={props.label}>
      <StatusSection
        status={status}
        error={statusError}
        restart={restart}
        onRestart={confirmRestart}
      />
      <AccountsSection
        state={accounts}
        onToggle={toggleAccount}
        onRemove={confirmRemove}
        onRetry={() => void loadAccounts()}
      />
      <AddAccountSection
        api={api}
        login={login}
        dispatch={dispatchLogin}
        onCompleted={() => void loadAccounts()}
      />
      <RoutingSection
        strategy={routing}
        error={routingError}
        busy={routingBusy}
        onSelect={selectRouting}
      />
    </PanelFrame>
  );
}

function PanelFrame(props: { readonly label: string | null; readonly children: React.ReactNode }) {
  return (
    <View className="gap-6">
      {props.label ? (
        <Text className="px-2 text-lg font-t3-medium text-foreground" numberOfLines={1}>
          {props.label}
        </Text>
      ) : null}
      {props.children}
    </View>
  );
}

/** Status polls only while this screen is on top and the app is in the foreground. */
function useStatusPolling(enabled: boolean, poll: () => Promise<void>) {
  const focused = useIsFocused();
  const [appState, setAppState] = useState<string>(AppState.currentState ?? "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", setAppState);
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!enabled || !shouldPollCliProxyStatus({ focused, appState })) return;
    const interval = setInterval(() => void poll(), CLIPROXY_STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [appState, enabled, focused, poll]);
}

function StatusSection(props: {
  readonly status: CliProxyStatus | null;
  readonly error: string | null;
  readonly restart: RestartState;
  readonly onRestart: () => void;
}) {
  const { status } = props;
  return (
    <SettingsSection title="Status">
      {status === null ? (
        props.error ? (
          <Text className="p-4 text-base text-foreground-muted">{props.error}</Text>
        ) : (
          <SkeletonRows count={2} />
        )
      ) : (
        <View className="gap-3 p-4">
          <View className="flex-row items-center gap-3">
            <StatusPill {...cliProxyStateTone(status.state)} />
            <View className="flex-1" />
            <PillButton
              label={props.restart.running ? "Restarting…" : "Restart"}
              disabled={props.restart.running}
              onPress={props.onRestart}
            />
          </View>
          {describeCliProxyStatus(status, relativeTime).map((line) => (
            <View key={line.label} className="flex-row gap-3">
              <Text className="w-24 shrink-0 text-sm text-foreground-muted">{line.label}</Text>
              <Text className="min-w-0 flex-1 text-sm text-foreground" selectable>
                {line.value}
              </Text>
            </View>
          ))}
          {props.error ? <ErrorText>{props.error}</ErrorText> : null}
          {props.restart.note ? <ErrorText>{props.restart.note}</ErrorText> : null}
        </View>
      )}
    </SettingsSection>
  );
}

function AccountsSection(props: {
  readonly state: ReturnType<typeof reduceCliProxyAccounts>;
  readonly onToggle: (account: CliProxyAccount, enabled: boolean) => void;
  readonly onRemove: (account: CliProxyAccount) => void;
  readonly onRetry: () => void;
}) {
  const { state } = props;
  return (
    <SettingsSection title="Accounts">
      {state.error ? (
        <View className="flex-row items-center gap-3 p-4">
          <Text className="min-w-0 flex-1 text-sm text-adaptive-rose-700-300">{state.error}</Text>
          <PillButton label="Retry" onPress={props.onRetry} />
        </View>
      ) : null}
      {state.accounts === null ? (
        state.error ? null : (
          <SkeletonRows count={3} />
        )
      ) : state.accounts.length === 0 ? (
        <Text
          className={cn(
            "p-4 text-base text-foreground-muted",
            state.error && "border-t border-border-subtle",
          )}
        >
          No accounts yet. Add one below.
        </Text>
      ) : (
        state.accounts.map((account, index) => (
          <AccountRow
            key={account.id}
            account={account}
            first={index === 0 && !state.error}
            pending={account.id in state.pending}
            error={state.rowErrors[account.id] ?? null}
            onToggle={(enabled) => props.onToggle(account, enabled)}
            onRemove={() => props.onRemove(account)}
          />
        ))
      )}
      {state.accounts !== null && state.accounts.length > 0 ? (
        <Text className="border-t border-border-subtle px-4 py-3 text-xs text-foreground-muted">
          Long-press an account to remove it.
        </Text>
      ) : null}
    </SettingsSection>
  );
}

function AccountRow(props: {
  readonly account: CliProxyAccount;
  readonly first: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onToggle: (enabled: boolean) => void;
  readonly onRemove: () => void;
}) {
  const { account } = props;
  return (
    <Pressable
      accessibilityLabel={`${account.email ?? account.label}, long-press to remove`}
      onLongPress={props.onRemove}
      disabled={props.pending}
      className={cn(
        "flex-row items-center gap-4 p-4 active:bg-subtle",
        !props.first && "border-t border-border-subtle",
        props.pending && "opacity-[0.6]",
      )}
    >
      <View className="min-w-0 flex-1">
        <Text className="text-lg text-foreground" numberOfLines={1}>
          {account.email ?? account.label}
        </Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {describeCliProxyAccount(account, relativeTime)}
        </Text>
        {props.error ? <ErrorText>{props.error}</ErrorText> : null}
      </View>
      <ThemedSwitch
        accessibilityLabel={`${account.email ?? account.label} enabled`}
        disabled={props.pending}
        value={!account.disabled}
        onValueChange={props.onToggle}
      />
    </Pressable>
  );
}

function AddAccountSection(props: {
  readonly api: CliProxyApi;
  readonly login: ReturnType<typeof reduceCliProxyLoginFlow>;
  readonly dispatch: (event: Parameters<typeof reduceCliProxyLoginFlow>[1]) => void;
  readonly onCompleted: () => void;
}) {
  const { api, login, dispatch, onCompleted } = props;
  const [redirectDraft, setRedirectDraft] = useState("");
  const pendingSession = pendingCliProxyLoginSession(login);

  useEffect(() => {
    if (!pendingSession) return;
    let cancelled = false;
    const tick = async () => {
      const result = await api.loginStatus(pendingSession);
      if (cancelled || result._tag !== "ok") return;
      dispatch({ type: "status", status: result.value });
      if (result.value.status === "completed") onCompleted();
    };
    const interval = setInterval(() => void tick(), CLIPROXY_LOGIN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [api, dispatch, onCompleted, pendingSession]);

  const start = (provider: CliProxyLoginProvider) => {
    dispatch({ type: "start", provider });
    setRedirectDraft("");
    void api.startLogin(provider).then((result) => {
      if (result._tag === "error") {
        dispatch({ type: "startFailed", error: describeCliProxyError(result.error) });
        return;
      }
      dispatch({ type: "started", started: result.value });
      void Linking.openURL(result.value.authUrl).catch(() => undefined);
    });
  };

  const submitRedirect = () => {
    if (login._tag !== "pending") return;
    const redirectUrl = redirectDraft.trim();
    if (redirectUrl.length === 0) return;
    const { sessionId } = login;
    dispatch({ type: "pasteRedirect" });
    void api.completeLogin(sessionId, redirectUrl).then((result) => {
      if (result._tag === "ok") {
        dispatch({ type: "status", status: result.value });
        if (result.value.status === "completed") onCompleted();
      } else {
        dispatch({ type: "redirectFailed", sessionId, error: describeCliProxyError(result.error) });
      }
    });
  };

  const cancel = () => {
    if (login._tag === "pending") void api.cancelLogin(login.sessionId);
    dispatch({ type: "cancel" });
  };

  return (
    <SettingsSection title="Add account">
      <View className="gap-3 p-4">
        {login._tag === "idle" ? (
          <>
            <Text className="text-sm text-foreground-muted">Sign in with a provider:</Text>
            <View className="flex-row flex-wrap gap-2">
              {CLIPROXY_LOGIN_PROVIDERS.map((provider) => (
                <Chip
                  key={provider.value}
                  label={provider.label}
                  onPress={() => start(provider.value)}
                />
              ))}
            </View>
          </>
        ) : login._tag === "starting" ? (
          <Text className="text-base text-foreground-muted">
            Starting {labelCliProxyLoginProvider(login.provider)} sign-in…
          </Text>
        ) : login._tag === "pending" ? (
          <>
            <Text className="text-base text-foreground">
              Finish the {labelCliProxyLoginProvider(login.provider)} sign-in in your browser.
            </Text>
            {login.userCode ? (
              <View className="flex-row items-center gap-3 rounded-2xl bg-subtle px-4 py-3">
                <Text className="flex-1 font-mono text-2xl text-foreground" selectable>
                  {login.userCode}
                </Text>
                <ThemedCopyTextButton
                  accessibilityLabel="Copy code"
                  text={login.userCode}
                  tintColorClassName="accent-icon"
                />
              </View>
            ) : null}
            <View className="flex-row flex-wrap gap-2">
              <PillButton
                label="Open browser"
                onPress={() => void Linking.openURL(login.authUrl).catch(() => undefined)}
              />
              <PillButton label="Cancel" onPress={cancel} />
            </View>
            <Text className="text-xs text-foreground-muted">
              If the browser cannot reach the server, paste the URL it redirected to:
            </Text>
            <View className="flex-row items-center gap-2">
              <TextInput
                className="min-h-11 flex-1 py-2"
                accessibilityLabel="Redirect URL"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="http://localhost:…/callback?code=…"
                value={redirectDraft}
                onChangeText={setRedirectDraft}
                onSubmitEditing={submitRedirect}
                returnKeyType="send"
                editable={!login.submittingRedirect}
              />
              <PillButton
                label={login.submittingRedirect ? "…" : "Submit"}
                disabled={login.submittingRedirect || redirectDraft.trim().length === 0}
                onPress={submitRedirect}
              />
            </View>
            {login.redirectError ? <ErrorText>{login.redirectError}</ErrorText> : null}
          </>
        ) : (
          <>
            {login._tag === "completed" ? (
              <Text className="text-base text-foreground">
                {labelCliProxyLoginProvider(login.provider)} account added
                {login.accountId ? ` (${login.accountId})` : ""}.
              </Text>
            ) : login._tag === "failed" ? (
              <ErrorText>{login.error}</ErrorText>
            ) : (
              <Text className="text-base text-foreground-muted">Sign-in cancelled.</Text>
            )}
            <PillButton label="Done" onPress={() => dispatch({ type: "reset" })} />
          </>
        )}
      </View>
    </SettingsSection>
  );
}

function RoutingSection(props: {
  readonly strategy: CliProxyRoutingStrategy | null;
  readonly error: string | null;
  readonly busy: boolean;
  readonly onSelect: (strategy: CliProxyRoutingStrategy) => void;
}) {
  return (
    <SettingsSection title="Routing">
      <View className="gap-3 p-4">
        <View className="flex-row flex-wrap gap-2">
          {CLIPROXY_ROUTING_OPTIONS.map((option) => (
            <Chip
              key={option.value}
              label={option.label}
              selected={option.value === props.strategy}
              disabled={props.busy || props.strategy === null}
              onPress={() => props.onSelect(option.value)}
            />
          ))}
        </View>
        {props.error ? <ErrorText>{props.error}</ErrorText> : null}
      </View>
    </SettingsSection>
  );
}

function Chip(props: {
  readonly label: string;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected === true, disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "rounded-full border px-3.5 py-2 active:opacity-70",
        props.selected ? "border-primary bg-subtle-strong" : "border-border bg-card",
        props.disabled && "opacity-[0.45]",
      )}
    >
      <Text
        className={
          props.selected ? "text-sm font-t3-medium text-foreground" : "text-sm text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function PillButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "rounded-full bg-subtle px-4 py-2 active:opacity-70",
        props.disabled && "opacity-[0.45]",
      )}
    >
      <Text className="text-base font-t3-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}

function ErrorText(props: { readonly children: string }) {
  return <Text className="text-sm text-adaptive-rose-700-300">{props.children}</Text>;
}

/** Static placeholder rows for the first load; no animation, so nothing repaints. */
function SkeletonRows(props: { readonly count: number }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: props.count }, (_, index) => (
        <View
          key={index}
          className={cn("gap-2 p-4", index !== 0 && "border-t border-border-subtle")}
        >
          <View className="h-4 w-2/5 rounded-full bg-subtle" />
          <View className="h-3 w-3/5 rounded-full bg-subtle" />
        </View>
      ))}
    </View>
  );
}

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, AppState, Pressable } from "react-native";
import { CommonActions, useNavigation } from "@react-navigation/native";
import * as Effect from "effect/Effect";
import {
  describeMicPrismAvailability,
  describeMicPrismWarning,
  getMicPrismAvailability,
  type MicIdentityClientInput,
} from "@t3tools/client-runtime/fork";
import type { ModelSelection, ServerConfig } from "@t3tools/contracts";
import type { ModelOption } from "../../lib/modelOptions";
import { runtime } from "../../lib/runtime";
import { AppText as Text } from "../../components/AppText";

import {
  applyMicPrismModelAvailability,
  isMicPrismModel,
  type MicPrismModelObservation as Observation,
} from "./micPrismModelOptions.logic";
export { isMicPrismModel } from "./micPrismModelOptions.logic";
const Context = createContext<Observation>({ value: null, error: null });
const signedOutObservation: Observation = {
  value: null,
  error: "Sign in with mic.sc to check Prism.",
};

/** The signed-in app owns one aggregate observation; no provider identities enter coding views. */
export function MicPrismAvailabilityProvider(props: {
  input: MicIdentityClientInput;
  active: boolean;
  children: ReactNode;
}) {
  const [observation, setObservation] = useState<Observation>({ value: null, error: null });
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => listener.remove();
  }, []);
  useEffect(() => {
    if (!props.active || !foreground) return;
    const abort = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await runtime.runPromise(
          getMicPrismAvailability(props.input).pipe(Effect.result),
          { signal: abort.signal },
        );
        if (abort.signal.aborted || props.input.isCurrent?.() === false) return;
        setObservation((previous) =>
          result._tag === "Success"
            ? { value: result.success, error: null }
            : { ...previous, error: result.failure.message },
        );
      } catch {
        if (!abort.signal.aborted)
          setObservation((previous) => ({
            ...previous,
            error: "Prism availability could not be checked.",
          }));
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [props.active, props.input, foreground]);
  return (
    <Context.Provider value={props.active ? observation : signedOutObservation}>
      {props.children}
    </Context.Provider>
  );
}

export function useMicPrismModelOptions(
  config: ServerConfig | null | undefined,
  options: ReadonlyArray<ModelOption>,
  selection: ModelSelection | null = null,
) {
  const observation = useContext(Context);
  return useMemo(
    () => applyMicPrismModelAvailability(config, options, selection, observation),
    [config, options, selection, observation],
  );
}

export function MicPrismModelStatus(props: {
  config: ServerConfig | null | undefined;
  selection: ModelSelection | null;
}) {
  const observation = useContext(Context);
  const navigation = useNavigation();
  if (!isMicPrismModel(props.config, props.selection)) return null;
  const status = observation.value?.models.find((model) => model.id === props.selection?.model);
  const label = observation.error
    ? "Offline"
    : status
      ? `${status.available ? "Ready" : "Unavailable"} · ${status.usableAccounts}`
      : observation.value
        ? "Unavailable · 0"
        : "Checking…";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Prism ${label}`}
      className="px-2 py-1"
      onPress={() =>
        Alert.alert(
          "Prism",
          observation.error ??
            (status
              ? [
                  describeMicPrismAvailability(status),
                  ...status.warnings.map(describeMicPrismWarning),
                ].join("\n")
              : "The selected model has no verified Prism eligibility."),
          [
            { text: "Close", style: "cancel" },
            {
              text: "Accounts and settings",
              onPress: () =>
                navigation.dispatch(
                  CommonActions.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "SettingsPrism" },
                  }),
                ),
            },
          ],
        )
      }
    >
      <Text className="text-xs text-foreground-muted">Prism · {label}</Text>
    </Pressable>
  );
}

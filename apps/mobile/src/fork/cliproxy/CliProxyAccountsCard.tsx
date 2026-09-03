/**
 * Read-only view of the CLIProxyAPI account pool, one card per connected
 * environment whose `cliproxy` flag is on. Mobile shows status and the list;
 * enabling, weights, sign-in, and removal stay on web for now.
 */
import type { CliProxyAccount, CliProxyStatus } from "@q1code/core/cliproxyApi";
import {
  type CliProxyClientError,
  type CliProxyClientInput,
  getCliProxyStatus,
  listCliProxyAccounts,
} from "@t3tools/client-runtime/fork";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { HttpClient } from "effect/unstable/http";
import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { runtime } from "../../lib/runtime";
import { relativeTime } from "../../lib/time";
import { useEnvironments } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import { useForkFlag } from "../useForkFlag";

const STATE_LABELS: Readonly<Record<CliProxyStatus["state"], string>> = {
  off: "Off",
  starting: "Starting",
  ready: "Ready",
  failed: "Failed",
};

type CardState =
  | { readonly _tag: "loading" }
  | {
      readonly _tag: "loaded";
      readonly status: CliProxyStatus;
      readonly accounts: ReadonlyArray<CliProxyAccount> | null;
      /** Why the list is missing when `accounts` is null. */
      readonly note: string | null;
    }
  | { readonly _tag: "error"; readonly message: string };

function describeError(error: CliProxyClientError): string {
  switch (error._tag) {
    case "CliProxyUnavailableError":
      return error.reason === "flag-off"
        ? "The cliproxy feature is off on this environment."
        : `The sidecar is ${STATE_LABELS[error.state].toLowerCase()}.`;
    case "CliProxyUpstreamError":
      return `CLIProxyAPI answered ${error.status}.`;
    case "EnvironmentScopeRequiredError":
      return `Requires the ${error.requiredScope} scope.`;
    case "EnvironmentAuthInvalidError":
      return "This environment session is no longer valid.";
    default:
      return "Could not reach the environment.";
  }
}

const load = (prepared: CliProxyClientInput["prepared"]) =>
  Effect.gen(function* () {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const input: CliProxyClientInput = { prepared, signer };
    const status = yield* getCliProxyStatus(input);
    const accounts = yield* listCliProxyAccounts(input).pipe(
      Effect.map((list): CardState => ({ _tag: "loaded", status, accounts: list, note: null })),
      Effect.catch((error) =>
        Effect.succeed<CardState>({
          _tag: "loaded",
          status,
          accounts: null,
          note: describeError(error),
        }),
      ),
    );
    return accounts;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed<CardState>({ _tag: "error", message: describeError(error) }),
    ),
  ) satisfies Effect.Effect<CardState, never, HttpClient.HttpClient>;

/** One card per connected environment with the flag on; renders nothing otherwise. */
export function CliProxyAccountsCards() {
  const { environments } = useEnvironments();
  const connected = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  if (connected.length === 0) return null;
  return (
    <>
      {connected.map((environment) => (
        <CliProxyAccountsCard
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
          showLabel={connected.length > 1}
        />
      ))}
    </>
  );
}

function CliProxyAccountsCard({
  environmentId,
  label,
  showLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly showLabel: boolean;
}) {
  const enabled = useForkFlag(environmentId, "cliproxy");
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const [state, setState] = useState<CardState>({ _tag: "loading" });

  const refresh = useCallback(() => {
    if (!prepared) return () => undefined;
    let cancelled = false;
    void runtime.runPromise(load(prepared)).then(
      (next) => {
        if (!cancelled) setState(next);
      },
      () => {
        if (!cancelled) setState({ _tag: "error", message: "The request failed unexpectedly." });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [prepared]);

  useEffect(() => {
    if (!enabled) return;
    return refresh();
  }, [enabled, refresh]);

  if (!enabled) return null;

  return (
    <SettingsSection
      title={showLabel ? `Accounts (CLIProxyAPI) · ${label}` : "Accounts (CLIProxyAPI)"}
    >
      {state._tag === "loading" ? (
        <View className="p-4">
          <Text className="text-base text-foreground-muted">Loading…</Text>
        </View>
      ) : state._tag === "error" ? (
        <View className="p-4">
          <Text className="text-base text-foreground-muted">{state.message}</Text>
        </View>
      ) : (
        <>
          <View className="flex-row items-center gap-4 p-4">
            <View className="min-w-0 flex-1">
              <Text className="text-lg text-foreground">
                Sidecar {STATE_LABELS[state.status.state]}
              </Text>
              <Text className="text-sm text-foreground-muted">{describeStatus(state.status)}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh accounts"
              onPress={() => {
                setState({ _tag: "loading" });
                refresh();
              }}
              className="rounded-full bg-subtle px-4 py-2 active:opacity-70"
            >
              <Text className="text-base font-t3-medium text-foreground">Refresh</Text>
            </Pressable>
          </View>
          {state.accounts === null ? (
            <View className="border-t border-border-subtle p-4">
              <Text className="text-base text-foreground-muted">{state.note}</Text>
            </View>
          ) : state.accounts.length === 0 ? (
            <View className="border-t border-border-subtle p-4">
              <Text className="text-base text-foreground-muted">
                No accounts yet. Add one from the web app.
              </Text>
            </View>
          ) : (
            state.accounts.map((account) => (
              <View
                key={account.id}
                className="flex-row items-center gap-4 border-t border-border-subtle p-4"
              >
                <View className="min-w-0 flex-1">
                  <Text className="text-lg text-foreground" numberOfLines={1}>
                    {account.email ?? account.label}
                  </Text>
                  <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                    {account.provider}
                    {account.weight !== undefined ? ` · weight ${account.weight}` : ""}
                    {` · ${relativeTime(account.updatedAt)}`}
                  </Text>
                </View>
                <Text
                  className={
                    account.disabled
                      ? "text-base text-foreground-muted"
                      : "text-base font-t3-medium text-foreground"
                  }
                >
                  {account.disabled ? "Disabled" : "Enabled"}
                </Text>
              </View>
            ))
          )}
        </>
      )}
    </SettingsSection>
  );
}

function describeStatus(status: CliProxyStatus): string {
  const parts = [`port ${status.port}`];
  if (status.version) parts.push(`v${status.version}`);
  parts.push(`sync ${status.role}`);
  if (status.lastSyncAt) parts.push(`synced ${relativeTime(status.lastSyncAt)} ago`);
  if (status.lastSyncError) parts.push(`sync error: ${status.lastSyncError}`);
  return parts.join(" · ");
}

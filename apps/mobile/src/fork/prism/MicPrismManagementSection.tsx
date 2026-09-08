import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AppState, Linking, Pressable, Switch, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import {
  createMicPrismManagementController,
  describeMicPrismAvailability,
  describeMicPrismWarning,
  type MicIdentityClientInput,
} from "@t3tools/client-runtime/fork";
import type {
  MicPrismManagedAccount,
  MicPrismSettings,
  MicPrismSettingsState,
} from "@q1code/core/micPrismApi";
import { MicPrismStrategy } from "@q1code/core/micPrismApi";
import { prismAccountHealth, PRISM_ACCOUNT_HEALTH_LABELS } from "@q1code/core/prism";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { runtime } from "../../lib/runtime";

const strategies = {
  "round-robin": "Round robin",
  "weighted-round-robin": "Weighted round robin",
  "fill-first": "Fill first",
  "reset-priority": "Reset priority",
};

/** Native clients use the same revision, readback and cancellation rules as web. */
export function MicPrismManagementSection(props: {
  readonly input: MicIdentityClientInput & {
    readonly expectedService: NonNullable<MicIdentityClientInput["expectedService"]>;
  };
  readonly permissions: ReadonlyArray<string>;
  readonly enabled: boolean;
  readonly hostName: string;
}) {
  const focused = useIsFocused();
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  }, [props]);
  const [controller] = useState(() =>
    createMicPrismManagementController({
      input: {
        ...props.input,
        getToken: () => latest.current.input.getToken(),
        isCurrent: () => latest.current.enabled && latest.current.input.isCurrent?.() !== false,
      },
      permissions: props.permissions,
      run: (effect, signal) => runtime.runPromise(effect, { signal }),
    }),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useLayoutEffect(() => {
    controller.updatePermissions(props.permissions);
  }, [controller, props.permissions]);
  useEffect(() => {
    controller.activate();
    return () => controller.dispose();
  }, [controller]);
  const loginPending =
    state.login !== null && (!state.loginStatus || state.loginStatus.status === "pending");
  useEffect(() => {
    if (!focused || !props.enabled) return;
    const refresh = () => {
      if (AppState.currentState === "active") void controller.refresh();
    };
    refresh();
    const timer = setInterval(refresh, loginPending ? 2_000 : 10_000);
    const appState = AppState.addEventListener("change", refresh);
    return () => {
      clearInterval(timer);
      appState.remove();
    };
  }, [controller, focused, props.enabled, loginPending]);
  const [callback, setCallback] = useState("");
  const pending = state.busy || state.loading;
  const writable = props.enabled && !pending && !state.error;
  const accountWrite = writable && props.permissions.includes("prism:accounts:write");
  return (
    <>
      <SettingsSection title="Prism management">
        <View className="gap-3 p-4">
          <Text className="text-sm text-foreground-muted">
            {!props.enabled || state.error
              ? "Last known state. Changes are paused until Prism reconnects."
              : `Manage ${props.hostName}. Changes are confirmed by the host.`}
          </Text>
          {state.error ? (
            <Text accessibilityLiveRegion="polite" className="text-sm text-adaptive-rose-700-300">
              {state.error}
            </Text>
          ) : null}
          {state.notice ? (
            <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
              {state.notice}
            </Text>
          ) : null}
          <Action
            label={state.loading ? "Refreshing…" : "Refresh state"}
            disabled={pending || !props.enabled}
            onPress={() => void controller.refresh()}
          />
        </View>
      </SettingsSection>
      {state.availability ? (
        <SettingsSection title="Model availability">
          <View className="gap-3 p-4">
            {state.availability.models.length === 0 ? (
              <Text className="text-sm text-foreground-muted">No configured models.</Text>
            ) : null}
            {state.availability.models.map((model) => (
              <View key={model.id} className="gap-1">
                <Text className="text-sm text-foreground">{model.id}</Text>
                <Text className="text-xs text-foreground-muted">
                  {describeMicPrismAvailability(model)}
                </Text>
                {model.warnings.map((warning) => (
                  <Text key={warning} className="text-xs text-foreground-muted">
                    {describeMicPrismWarning(warning)}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </SettingsSection>
      ) : null}
      {state.accounts ? (
        <SettingsSection title="Provider accounts">
          <View className="gap-5 p-4">
            {state.accounts.accounts.length === 0 ? (
              <Text className="text-sm text-foreground-muted">
                Add a subscription to start the pool.
              </Text>
            ) : null}
            {state.accounts.accounts.map((account) => (
              <Account
                key={account.id}
                account={account}
                revision={state.accounts!.settingsRevision}
                observedAt={state.receivedAt}
                disabled={!accountWrite}
                save={(patch, revision) =>
                  controller.patchAccount(account.id, patch, revision)
                }
                remove={() => {
                  const revision = state.accounts!.settingsRevision;
                  Alert.alert(
                    `Remove ${account.email ?? account.label}?`,
                    "Sign in again to restore this account.",
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Remove",
                        style: "destructive",
                        onPress: () => void controller.deleteAccount(account.id, revision),
                      },
                    ],
                  );
                }}
              />
            ))}
          </View>
        </SettingsSection>
      ) : null}
      {state.accounts && props.permissions.includes("prism:accounts:write") ? (
        <SettingsSection title="Add or reconnect account">
          <View className="gap-3 p-4">
            <Text className="text-sm text-foreground-muted">
              Provider sign-in is saved on {props.hostName}.
            </Text>
            {!state.login ? (
              <View className="flex-row flex-wrap gap-2">
                {(
                  [
                    ["anthropic", "Claude"],
                    ["codex", "ChatGPT / Codex"],
                    ["xai", "Grok"],
                  ] as const
                ).map(([provider, label]) => (
                  <Action
                    key={provider}
                    label={label}
                    disabled={!accountWrite}
                    onPress={() => {
                      setCallback("");
                      void controller.startLogin(provider, state.accounts!.settingsRevision);
                    }}
                  />
                ))}
              </View>
            ) : (
              <>
                <Text className="text-sm text-foreground">
                  {state.loginStatus?.status === "completed"
                    ? "Sign-in saved. Check account health and model availability before using it."
                    : state.loginStatus?.status === "failed"
                      ? "Sign-in failed. Start another login to reconnect."
                      : state.loginStatus?.status === "cancelled"
                        ? "Sign-in cancelled."
                        : "Complete provider sign-in and check its result here."}
                </Text>
                {loginPending ? (
                  <>
                    {state.login.userCode ? (
                      <Text selectable className="text-lg font-mono text-foreground">
                        {state.login.userCode}
                      </Text>
                    ) : null}
                    <Action
                      label="Open provider sign-in"
                      disabled={!accountWrite}
                      onPress={() =>
                        void Linking.openURL(state.login!.authUrl).catch(() =>
                          Alert.alert("Could not open provider sign-in", "Try opening it again."),
                        )
                      }
                    />
                    {state.login.flow === "redirect" ? (
                      <>
                        <Field
                          label="Completed callback URL"
                          value={callback}
                          disabled={!accountWrite}
                          onChange={setCallback}
                        />
                        <Action
                          label="Complete sign-in"
                          disabled={!accountWrite || !callback.trim()}
                          onPress={() => {
                            void controller.completeLogin(callback);
                            setCallback("");
                          }}
                        />
                      </>
                    ) : null}
                    <Action
                      label="Cancel sign-in"
                      disabled={!accountWrite}
                      onPress={() => void controller.cancelLogin()}
                    />
                  </>
                ) : (
                  <Action
                    label="Add another account"
                    disabled={pending}
                    onPress={() => controller.clearLogin()}
                  />
                )}
              </>
            )}
          </View>
        </SettingsSection>
      ) : null}
      {state.settings ? (
        <Settings
          state={state.settings}
          disabled={!writable || !props.permissions.includes("prism:settings:write")}
          save={(settings, revision) => controller.setSettings(settings, revision)}
        />
      ) : null}
    </>
  );
}

function Account({
  account,
  revision,
  observedAt,
  disabled,
  save,
  remove,
}: {
  account: MicPrismManagedAccount;
  revision: string;
  observedAt: number;
  disabled: boolean;
  save: (
    patch: { disabled: boolean; reservePercent: number | null; weight: number },
    revision: string,
  ) => Promise<boolean>;
  remove: () => void;
}) {
  const current = {
    revision,
    enabled: !account.disabled,
    reserve: account.reservePercent === null ? "" : String(account.reservePercent),
    weight: String(account.weight ?? 1),
    dirty: false,
  };
  const [edit, setDraft] = useState<typeof current | null>(null);
  const draft = edit ?? current;
  const valid =
    (draft.reserve === "" ||
      (Number.isFinite(Number(draft.reserve)) &&
        Number(draft.reserve) >= 0 &&
        Number(draft.reserve) <= 100)) &&
    /^\d+$/.test(draft.weight) &&
    Number(draft.weight) <= 1000000;
  return (
    <View className="gap-2">
      <Text className="text-sm font-t3-medium text-foreground">
        {account.email ?? account.label}
      </Text>
      <Text className="text-xs text-foreground-muted">
        {account.provider} · {PRISM_ACCOUNT_HEALTH_LABELS[prismAccountHealth(account, observedAt)]}
      </Text>
      <Text className="text-xs text-foreground-muted">
        {account.eligibility?.available
          ? "Eligible to serve"
          : describeMicPrismWarning(account.eligibility?.reason ?? "Eligibility unverified")}
      </Text>
      {account.quotaWindows?.map((window) => (
        <Text key={window.id} className="text-xs text-foreground-muted">
          {window.id}: {(window.utilization * 100).toFixed(1)}% used
          {window.resetAt ? ` · resets ${new Date(window.resetAt).toLocaleString()}` : ""}
        </Text>
      ))}
      <View className="flex-row items-center justify-between">
        <Text className="text-sm text-foreground">Enabled</Text>
        <Switch
          accessibilityLabel="Account enabled"
          disabled={disabled}
          value={draft.enabled}
          onValueChange={(enabled) => setDraft({ ...draft, enabled, dirty: true })}
        />
      </View>
      <Field
        label="Soft reserve % (empty turns it off)"
        value={draft.reserve}
        disabled={disabled}
        numeric
        onChange={(reserve) => setDraft({ ...draft, reserve, dirty: true })}
      />
      <Field
        label="Weight"
        value={draft.weight}
        disabled={disabled}
        numeric
        onChange={(weight) => setDraft({ ...draft, weight, dirty: true })}
      />
      {draft.dirty && draft.revision !== revision ? (
        <Action
          label="Prism changed — load current values"
          onPress={() => setDraft(null)}
        />
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <Action
          label="Save account"
          disabled={disabled || !valid || !draft.dirty}
          onPress={() => {
            void save(
              {
                disabled: !draft.enabled,
                reservePercent: draft.reserve === "" ? null : Number(draft.reserve),
                weight: Number(draft.weight),
              },
              draft.revision,
            ).then((confirmed) => {
              if (confirmed) setDraft(null);
            });
          }}
        />
        <Action label="Remove account" disabled={disabled} onPress={remove} />
      </View>
    </View>
  );
}

function Settings({
  state,
  disabled,
  save,
}: {
  state: MicPrismSettingsState;
  disabled: boolean;
  save: (settings: MicPrismSettings, revision: string) => Promise<boolean>;
}) {
  const current = {
    settings: state.settings,
    revision: state.settingsRevision,
    dirty: false,
  };
  const [edit, setDraft] = useState<typeof current | null>(null);
  const draft = edit ?? current;
  const [advanced, setAdvanced] = useState(false);
  const change = (patch: Partial<MicPrismSettings>) =>
    setDraft({ ...draft, settings: { ...draft.settings, ...patch }, dirty: true });
  const valid =
    Number.isInteger(draft.settings.requestRetry) &&
    draft.settings.requestRetry >= 0 &&
    draft.settings.requestRetry <= 10 &&
    Number.isInteger(draft.settings.maxRetryInterval) &&
    draft.settings.maxRetryInterval >= 0 &&
    draft.settings.maxRetryInterval <= 300;
  return (
    <SettingsSection title="Pool settings">
      <View className="gap-3 p-4">
        <Text className="text-sm text-foreground">Account selection</Text>
        <View className="flex-row flex-wrap gap-2">
          {MicPrismStrategy.literals.map((strategy) => (
            <Action
              key={strategy}
              label={`${draft.settings.strategy === strategy ? "✓ " : ""}${strategies[strategy]}`}
              disabled={disabled}
              onPress={() => change({ strategy })}
            />
          ))}
        </View>
        <Action
          label={advanced ? "Hide advanced settings" : "Advanced settings"}
          onPress={() => setAdvanced(!advanced)}
        />
        {advanced ? (
          <>
            <View className="flex-row items-center justify-between">
              <Text className="flex-1 text-sm text-foreground">
                Prefer the same account within a session
              </Text>
              <Switch
                disabled={disabled}
                value={draft.settings.sessionAffinity}
                onValueChange={(sessionAffinity) => change({ sessionAffinity })}
              />
            </View>
            <Field
              label="Extra retry rounds (0–10)"
              numeric
              value={String(draft.settings.requestRetry)}
              disabled={disabled}
              onChange={(value) => change({ requestRetry: value === "" ? NaN : Number(value) })}
            />
            <Field
              label="Maximum retry interval (0–300 seconds)"
              numeric
              value={String(draft.settings.maxRetryInterval)}
              disabled={disabled}
              onChange={(value) => change({ maxRetryInterval: value === "" ? NaN : Number(value) })}
            />
          </>
        ) : null}
        {draft.dirty && draft.revision !== state.settingsRevision ? (
          <Action
            label="Prism changed — load current values"
            onPress={() => setDraft(null)}
          />
        ) : null}
        <Action
          label="Save settings"
          disabled={disabled || !draft.dirty || !valid}
          onPress={() => {
            void save(draft.settings, draft.revision).then((confirmed) => {
              if (confirmed) setDraft(null);
            });
          }}
        />
      </View>
    </SettingsSection>
  );
}

function Action(props: { label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="self-start rounded-full bg-subtle px-4 py-2"
    >
      <Text
        className={props.disabled ? "text-sm text-foreground-muted" : "text-sm text-foreground"}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
function Field(props: {
  label: string;
  value: string;
  disabled: boolean;
  numeric?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <View className="gap-1">
      <Text className="text-xs text-foreground-muted">{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={props.numeric ? "decimal-pad" : "default"}
        value={props.value}
        editable={!props.disabled}
        onChangeText={props.onChange}
        className="rounded-lg bg-subtle px-3 py-2 text-foreground"
      />
    </View>
  );
}

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  createMicPrismManagementController,
  describeMicPrismAvailability,
  describeMicPrismWarning,
} from "@t3tools/client-runtime/fork";
import type { MicPrismService } from "@q1code/core/micIdentity";
import type {
  MicPrismManagedAccount,
  MicPrismSettings,
  MicPrismSettingsState,
} from "@q1code/core/micPrismApi";
import { MicPrismStrategy } from "@q1code/core/micPrismApi";
import { prismAccountHealth, PRISM_ACCOUNT_HEALTH_LABELS } from "@q1code/core/prism";
import { Button } from "~/components/ui/button";
import { SettingsSection } from "~/components/settings/settingsLayout";
import { ensureLocalApi } from "~/localApi";
import { runtime } from "~/lib/runtime";
import { useDocumentVisible } from "../prism/prismUi";
import { micIdentityGeneration, readMicIdentityToken } from "./micIdentitySession";

const inputClass =
  "rounded-md border border-border bg-background px-2 py-1.5 text-sm disabled:opacity-50";
export const MIC_PRISM_STRATEGY_LABELS: Readonly<Record<MicPrismSettings["strategy"], string>> = {
  "round-robin": "Round robin",
  "weighted-round-robin": "Weighted round robin",
  "fill-first": "Fill first",
  "reset-priority": "Reset priority",
};

/** Key this component by human session and selected service; no prior user's account results survive. */
export function MicPrismManagementPanel(props: {
  readonly authorityUrl: string;
  readonly service: MicPrismService;
  readonly generation: number;
  readonly permissions: ReadonlyArray<string>;
  readonly disabled: boolean;
}) {
  const visible = useDocumentVisible();
  const current = useRef(props);
  useLayoutEffect(() => {
    current.current = props;
  }, [props]);
  const [controller] = useState(() =>
    createMicPrismManagementController({
      input: {
        baseUrl: props.authorityUrl,
        expectedService: props.service,
        getToken: readMicIdentityToken,
        isCurrent: () => micIdentityGeneration() === props.generation && !current.current.disabled,
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
    if (!visible || props.disabled) return;
    void controller.refresh();
    const timer = window.setInterval(
      () => void controller.refresh(),
      loginPending ? 2_000 : 10_000,
    );
    return () => window.clearInterval(timer);
  }, [controller, visible, props.disabled, loginPending]);
  const pending = state.busy || state.loading;
  const writable = !pending && !props.disabled && !state.error;
  const accountsWritable = writable && props.permissions.includes("prism:accounts:write");
  const [callback, setCallback] = useState("");
  const remove = async (account: MicPrismManagedAccount, revision: string) => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Remove ${account.email ?? account.label} from ${props.service.label}? Sign in again to restore this account.`,
      { variant: "destructive" },
    );
    if (confirmed) await controller.deleteAccount(account.id, revision);
  };
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {props.disabled || state.error
            ? "Last known state. Changes are paused until Prism reconnects."
            : state.receivedAt
              ? `Updated ${new Date(state.receivedAt).toLocaleTimeString()}`
              : "Checking the selected host…"}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || props.disabled}
          onClick={() => void controller.refresh()}
        >
          Refresh
        </Button>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {state.notice}
        </p>
      ) : null}
      {state.availability ? (
        <SettingsSection title="Model availability">
          <div className="divide-y divide-border">
            {state.availability.models.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No models are configured.</p>
            ) : null}
            {state.availability.models.map((model) => (
              <div key={model.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">{model.id}</span>
                  <span className="text-xs text-muted-foreground">
                    {describeMicPrismAvailability(model)}
                  </span>
                </div>
                {model.warnings.map((warning) => (
                  <p key={warning} className="mt-1 text-xs text-muted-foreground">
                    {describeMicPrismWarning(warning)}
                  </p>
                ))}
                {model.nextEligibleAt ? (
                  <p className="text-xs text-muted-foreground">
                    Next reset: {new Date(model.nextEligibleAt).toLocaleString()}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </SettingsSection>
      ) : null}
      {state.accounts ? (
        <SettingsSection title="Provider accounts">
          <div className="divide-y divide-border">
            {state.accounts.accounts.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                No accounts yet. Add a subscription below.
              </p>
            ) : null}
            {state.accounts.accounts.map((account) => (
              <AccountEditor
                key={account.id}
                account={account}
                revision={state.accounts!.settingsRevision}
                observedAt={state.receivedAt}
                disabled={!accountsWritable}
                onSave={(patch, revision) => controller.patchAccount(account.id, patch, revision)}
                onRemove={() => void remove(account, state.accounts!.settingsRevision)}
              />
            ))}
          </div>
        </SettingsSection>
      ) : null}
      {props.permissions.includes("prism:accounts:write") && state.accounts ? (
        <SettingsSection title="Add or reconnect an account">
          <div className="space-y-3 p-4">
            <p className="text-sm text-muted-foreground">
              Sign-in is saved on {props.service.label}. Reconnect an account that requires a new
              login here.
            </p>
            {!state.login ? (
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["anthropic", "Claude"],
                    ["codex", "ChatGPT / Codex"],
                    ["xai", "Grok"],
                  ] as const
                ).map(([provider, label]) => (
                  <Button
                    key={provider}
                    size="sm"
                    variant="outline"
                    disabled={!accountsWritable}
                    onClick={() => {
                      setCallback("");
                      void controller.startLogin(provider, state.accounts!.settingsRevision);
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            ) : (
              <>
                <p className="text-sm">
                  {state.loginStatus?.status === "completed"
                    ? "Sign-in saved. Account health and model availability show whether it can serve requests."
                    : state.loginStatus?.status === "cancelled"
                      ? "Sign-in cancelled."
                      : state.loginStatus?.status === "failed"
                        ? "Sign-in failed. Start a new login to reconnect."
                        : "Complete the provider sign-in, then check its result here."}
                </p>
                {loginPending ? (
                  <>
                    {state.login.userCode ? (
                      <p className="font-mono text-lg tracking-wider">{state.login.userCode}</p>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!accountsWritable}
                      onClick={() => void ensureLocalApi().shell.openExternal(state.login!.authUrl)}
                    >
                      Open provider sign-in
                    </Button>
                    {state.login.flow === "redirect" ? (
                      <form
                        className="flex flex-wrap gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void controller.completeLogin(callback);
                          setCallback("");
                        }}
                      >
                        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                          Completed callback URL
                          <input
                            type="text"
                            autoComplete="off"
                            value={callback}
                            onChange={(event) => setCallback(event.target.value)}
                            className={inputClass}
                            disabled={!accountsWritable}
                          />
                        </label>
                        <Button
                          size="sm"
                          type="submit"
                          disabled={!accountsWritable || callback.trim() === ""}
                        >
                          Complete sign-in
                        </Button>
                      </form>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!accountsWritable}
                      onClick={() => void controller.cancelLogin()}
                    >
                      Cancel sign-in
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => controller.clearLogin()}
                  >
                    Add another account
                  </Button>
                )}
              </>
            )}
          </div>
        </SettingsSection>
      ) : null}
      {state.settings ? (
        <SettingsEditor
          state={state.settings}
          disabled={!writable || !props.permissions.includes("prism:settings:write")}
          onSave={(settings, revision) => controller.setSettings(settings, revision)}
        />
      ) : null}
    </div>
  );
}

function AccountEditor({
  account,
  revision,
  observedAt,
  disabled,
  onSave,
  onRemove,
}: {
  account: MicPrismManagedAccount;
  revision: string;
  observedAt: number;
  disabled: boolean;
  onSave: (
    patch: { disabled: boolean; reservePercent: number | null; weight: number },
    revision: string,
  ) => Promise<boolean>;
  onRemove: () => void;
}) {
  const current = {
    revision,
    disabled: account.disabled,
    reserve: account.reservePercent === null ? "" : String(account.reservePercent),
    weight: String(account.weight ?? 1),
    dirty: false,
  };
  const [edit, setDraft] = useState<typeof current | null>(null);
  const draft = edit ?? current;
  return (
    <form
      className="space-y-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(
          {
            disabled: draft.disabled,
            reservePercent: draft.reserve === "" ? null : Number(draft.reserve),
            weight: Number(draft.weight),
          },
          draft.revision,
        ).then((confirmed) => {
          if (confirmed) setDraft(null);
        });
      }}
    >
      <div className="flex flex-wrap justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{account.email ?? account.label}</p>
          <p className="text-xs text-muted-foreground">
            {account.provider} ·{" "}
            {PRISM_ACCOUNT_HEALTH_LABELS[prismAccountHealth(account, observedAt)]}
          </p>
        </div>
        <Button size="sm" variant="ghost" type="button" disabled={disabled} onClick={onRemove}>
          Remove
        </Button>
      </div>
      {account.eligibility ? (
        <p className="text-xs text-muted-foreground">
          {account.eligibility.available
            ? "Eligible to serve"
            : describeMicPrismWarning(account.eligibility.reason ?? "Eligibility unavailable")}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Serving eligibility has not been reported.</p>
      )}
      {account.quotaWindows?.map((window) => (
        <p key={window.id} className="text-xs text-muted-foreground">
          {window.id}: {(100 * window.utilization).toFixed(1)}% used
          {window.resetAt ? ` · resets ${new Date(window.resetAt).toLocaleString()}` : ""}
        </p>
      ))}
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 py-2 text-sm">
          <input
            type="checkbox"
            checked={!draft.disabled}
            disabled={disabled}
            onChange={(event) =>
              setDraft({ ...draft, disabled: !event.target.checked, dirty: true })
            }
          />
          Enabled
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Soft reserve (%)
          <input
            className={`${inputClass} w-28`}
            type="number"
            min={0}
            max={100}
            step="0.1"
            placeholder="Off"
            value={draft.reserve}
            disabled={disabled}
            onChange={(event) => setDraft({ ...draft, reserve: event.target.value, dirty: true })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Weight
          <input
            className={`${inputClass} w-24`}
            type="number"
            required
            min={0}
            max={1000000}
            step={1}
            value={draft.weight}
            disabled={disabled}
            onChange={(event) => setDraft({ ...draft, weight: event.target.value, dirty: true })}
          />
        </label>
        <Button type="submit" size="sm" disabled={disabled || !draft.dirty}>
          Save account
        </Button>
      </div>
      {draft.dirty && draft.revision !== revision ? (
        <p className="text-xs text-destructive">
          Prism changed while you were editing.{" "}
          <button type="button" onClick={() => setDraft(null)}>
            Load current values
          </button>{" "}
          before saving.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Clear reserve to turn it off. Reserve avoidance uses observed quota and cannot guarantee
        exact remaining capacity.
      </p>
    </form>
  );
}

function SettingsEditor({
  state,
  disabled,
  onSave,
}: {
  state: MicPrismSettingsState;
  disabled: boolean;
  onSave: (settings: MicPrismSettings, revision: string) => Promise<boolean>;
}) {
  const current = {
    settings: state.settings,
    revision: state.settingsRevision,
    dirty: false,
  };
  const [edit, setDraft] = useState<typeof current | null>(null);
  const draft = edit ?? current;
  const change = (patch: Partial<MicPrismSettings>) =>
    setDraft({ ...draft, settings: { ...draft.settings, ...patch }, dirty: true });
  return (
    <SettingsSection title="Pool settings">
      <form
        className="space-y-4 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave(draft.settings, draft.revision).then((confirmed) => {
            if (confirmed) setDraft(null);
          });
        }}
      >
        <label className="flex flex-col items-start gap-1 text-sm">
          Account selection
          <select
            className={inputClass}
            value={draft.settings.strategy}
            disabled={disabled}
            onChange={(event) =>
              change({ strategy: event.target.value as MicPrismSettings["strategy"] })
            }
          >
            {MicPrismStrategy.literals.map((strategy) => (
              <option key={strategy} value={strategy}>
                {MIC_PRISM_STRATEGY_LABELS[strategy]}
              </option>
            ))}
          </select>
        </label>
        <details>
          <summary className="cursor-pointer text-sm font-medium">Advanced settings</summary>
          <div className="mt-3 space-y-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.settings.sessionAffinity}
                disabled={disabled}
                onChange={(event) => change({ sessionAffinity: event.target.checked })}
              />
              Prefer the same account within a session
            </label>
            <p className="text-xs text-muted-foreground">
              Account eligibility and reserves still apply to every request.
            </p>
            <label className="flex flex-col items-start gap-1 text-sm">
              Extra retry rounds
              <input
                className={`${inputClass} w-24`}
                type="number"
                required
                min={0}
                max={10}
                step={1}
                value={draft.settings.requestRetry}
                disabled={disabled}
                onChange={(event) => change({ requestRetry: event.target.valueAsNumber })}
              />
            </label>
            <label className="flex flex-col items-start gap-1 text-sm">
              Maximum retry interval (seconds)
              <input
                className={`${inputClass} w-24`}
                type="number"
                required
                min={0}
                max={300}
                step={1}
                value={draft.settings.maxRetryInterval}
                disabled={disabled}
                onChange={(event) => change({ maxRetryInterval: event.target.valueAsNumber })}
              />
            </label>
          </div>
        </details>
        {draft.dirty && draft.revision !== state.settingsRevision ? (
          <p className="text-xs text-destructive">
            Prism changed while you were editing.{" "}
            <button type="button" onClick={() => setDraft(null)}>
              Load current values
            </button>{" "}
            before saving.
          </p>
        ) : null}
        <Button size="sm" type="submit" disabled={disabled || !draft.dirty}>
          Save settings
        </Button>
      </form>
    </SettingsSection>
  );
}

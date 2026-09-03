import { useAtomValue } from "@effect/atom-react";
import type {
  CliProxyAccount,
  CliProxyState,
  CliProxyStatus,
  CliProxySyncStatus,
  CliProxyUnavailableReason,
} from "@q1code/core/cliproxyApi";
import { CliProxyRoutingStrategy, FORK_CONFIG_FILENAME } from "@q1code/core/config";
import { readForkFlag } from "@t3tools/client-runtime/fork";
import { AlertCircleIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";
import { ensureLocalApi } from "~/localApi";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { primaryServerConfigAtom } from "~/state/server";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { CliProxyAddAccountSection } from "./CliProxyAddAccount";
import {
  CliProxyAccountsEmpty,
  CliProxyAccountsSkeleton,
  CliProxyAccountsTable,
} from "./CliProxyAccountsTable";
import { CliProxyStatusSection } from "./CliProxyStatusSection";
import {
  type CliProxyUsageRow,
  describeCliProxyRestart,
  describeCliProxyUnavailable,
  flattenCliProxyUsage,
  formatCliProxySyncInterval,
  INITIAL_CLIPROXY_ACCOUNTS,
  labelCliProxyProvider,
  reduceCliProxyAccounts,
  resolveCliProxyMode,
} from "./cliproxyAccountsState";
import {
  describeCliProxyAccount,
  MonoValue,
  reportCliProxyError,
  useDocumentVisible,
} from "./cliproxyUi";
import {
  type CliProxyApi,
  describeCliProxyCallError,
  isCliProxyPermissionError,
  useCliProxyApi,
} from "./useCliProxyApi";

const STATUS_POLL_MS = 10_000;
/** While a restart is in flight the status poll tightens until the proxy settles. */
const RESTART_POLL_MS = 1_000;
/** A restart that has not settled by then stops looking pending; the badge keeps telling the truth. */
const RESTART_PENDING_MAX_MS = 90_000;
const NEW_ACCOUNT_HIGHLIGHT_MS = 6_000;

const ROUTING_LABELS: Readonly<Record<CliProxyRoutingStrategy, string>> = {
  "round-robin": "Round robin",
  "weighted-round-robin": "Weighted round robin",
  "fill-first": "Fill first",
};

type PanelData =
  | { readonly _tag: "idle" }
  | {
      readonly _tag: "ready";
      readonly routing: CliProxyRoutingStrategy | null;
      readonly usage: ReadonlyArray<CliProxyUsageRow> | null;
    }
  | {
      readonly _tag: "unavailable";
      readonly reason: CliProxyUnavailableReason;
      readonly state: CliProxyState;
    }
  | { readonly _tag: "forbidden"; readonly message: string };

type SyncView =
  | { readonly _tag: "idle" }
  | { readonly _tag: "ready"; readonly value: CliProxySyncStatus }
  | {
      readonly _tag: "unavailable";
      readonly reason: CliProxyUnavailableReason;
      readonly state: CliProxyState;
    }
  | { readonly _tag: "error"; readonly message: string };

/** The Prism tab. Off flag, missing primary, and the live panel each get a calm page of their own. */
export function CliProxySettingsPanel() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const config = useAtomValue(primaryServerConfigAtom);
  if (primaryEnvironmentId === null) {
    return (
      <PrismNotice
        title="Prism needs a primary environment"
        description="Prism runs on the primary environment's server. Pair one from Connections, or open the server's own address."
      />
    );
  }
  if (!config) {
    return (
      <PrismNotice
        title="Waiting for the primary environment"
        description="Prism settings come from the primary environment's server and load once it is connected."
      />
    );
  }
  if (!readForkFlag(config.environment.capabilities, "cliproxy")) {
    return (
      <PrismNotice
        title="Prism is off"
        description={`Prism is q1code's CLIProxyAPI gateway: one pool of provider accounts shared by Claude and Codex, with load balancing and cross-machine sync. ${describeCliProxyUnavailable("flag-off", "off")}`}
      />
    );
  }
  return <CliProxySettingsPanelBody />;
}

function PrismNotice({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <SettingsPageContainer>
      <SettingsSection title="Prism">
        <SettingsRow title={title} description={description} />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function CliProxySettingsPanelBody() {
  const api = useCliProxyApi();
  const visible = useDocumentVisible();

  const [statusView, setStatusView] = useState<{
    readonly status: CliProxyStatus;
    readonly receivedAt: number;
  } | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncView>({ _tag: "idle" });
  const [restart, setRestart] = useState<{ readonly startedAt: number } | null>(null);

  const [data, setData] = useState<PanelData>({ _tag: "idle" });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [accounts, dispatchAccounts] = useReducer(
    reduceCliProxyAccounts,
    INITIAL_CLIPROXY_ACCOUNTS,
  );
  // Set once the list loaded (or the server said no); cleared to force a reload.
  const dataLoadedRef = useRef(false);
  const loadGenerationRef = useRef(0);

  const loadData = useCallback(async () => {
    if (api === null) return;
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    const [accountsResult, routing, usage] = await Promise.all([
      api.listAccounts(),
      api.getRouting(),
      api.getUsage(),
    ]);
    if (generation !== loadGenerationRef.current) return;
    setLoading(false);
    if (accountsResult._tag === "error") {
      const error = accountsResult.error;
      if (error._tag === "CliProxyUnavailableError") {
        setData({ _tag: "unavailable", reason: error.reason, state: error.state });
      } else if (isCliProxyPermissionError(error)) {
        dataLoadedRef.current = true;
        setData({ _tag: "forbidden", message: describeCliProxyCallError(error) });
      } else {
        setLoadError(describeCliProxyCallError(error));
      }
      return;
    }
    dataLoadedRef.current = true;
    setLoadError(null);
    dispatchAccounts({ type: "loaded", accounts: accountsResult.value });
    setData({
      _tag: "ready",
      routing: routing._tag === "ok" ? routing.value.strategy : null,
      usage: usage._tag === "ok" ? flattenCliProxyUsage(usage.value) : null,
    });
  }, [api]);

  // What every status answer means for the rest of the panel: the list loads
  // once the proxy is ready, goes away when it is not, and a pending restart
  // settles on ready or failed.
  const applyStatus = useCallback(
    (status: CliProxyStatus) => {
      if (status.state !== "ready") {
        dataLoadedRef.current = false;
        setData({ _tag: "unavailable", reason: "sidecar-not-ready", state: status.state });
      } else if (!dataLoadedRef.current) {
        void loadData();
      }
      setRestart((current) =>
        current !== null &&
        (status.state === "ready" ||
          status.state === "failed" ||
          Date.now() - current.startedAt > RESTART_PENDING_MAX_MS)
          ? null
          : current,
      );
    },
    [loadData],
  );

  const restarting = restart !== null;

  // Status and sync poll only while the panel is mounted and the document is visible.
  useEffect(() => {
    if (!visible || api === null) return;
    let cancelled = false;
    const tick = async () => {
      const [statusResult, syncResult] = await Promise.all([api.status(), api.syncStatus()]);
      if (cancelled) return;
      if (syncResult._tag === "ok") {
        setSync({ _tag: "ready", value: syncResult.value });
      } else if (syncResult.error._tag === "CliProxyUnavailableError") {
        setSync({
          _tag: "unavailable",
          reason: syncResult.error.reason,
          state: syncResult.error.state,
        });
      } else {
        setSync({ _tag: "error", message: describeCliProxyCallError(syncResult.error) });
      }
      if (statusResult._tag === "error") {
        setStatusError(describeCliProxyCallError(statusResult.error));
        return;
      }
      setStatusError(null);
      setStatusView({ status: statusResult.value, receivedAt: Date.now() });
      applyStatus(statusResult.value);
    };
    void tick();
    const interval = window.setInterval(
      () => void tick(),
      restarting ? RESTART_POLL_MS : STATUS_POLL_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      loadGenerationRef.current += 1;
    };
  }, [visible, api, applyStatus, restarting]);

  const restartProxy = async () => {
    if (api === null || restarting || statusView === null) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      describeCliProxyRestart(resolveCliProxyMode(statusView.status)),
    );
    if (!confirmed) return;
    setRestart({ startedAt: Date.now() });
    const result = await api.restart();
    if (result._tag === "error") {
      setRestart(null);
      reportCliProxyError("Could not restart the proxy", result.error);
      return;
    }
    setStatusView({ status: result.value, receivedAt: Date.now() });
    applyStatus(result.value);
  };

  const refreshAccounts = useCallback(async () => {
    if (api === null) return;
    const result = await api.listAccounts();
    if (result._tag === "error") {
      reportCliProxyError("Could not refresh accounts", result.error);
      return;
    }
    dispatchAccounts({ type: "loaded", accounts: result.value });
  }, [api]);

  const [highlightedAccountId, setHighlightedAccountId] = useState<string | null>(null);
  useEffect(() => {
    if (highlightedAccountId === null) return;
    const timeout = window.setTimeout(
      () => setHighlightedAccountId(null),
      NEW_ACCOUNT_HIGHLIGHT_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [highlightedAccountId]);

  const handleLoginCompleted = useCallback(
    (accountId: string | null) => {
      setHighlightedAccountId(accountId);
      void refreshAccounts();
    },
    [refreshAccounts],
  );

  const patchAccount = async (
    account: CliProxyAccount,
    patch: Parameters<CliProxyApi["patchAccount"]>[1],
    failureTitle: string,
  ) => {
    if (api === null) return;
    dispatchAccounts({ type: "patchStarted", id: account.id, patch });
    const result = await api.patchAccount(account.id, patch);
    if (result._tag === "error") {
      dispatchAccounts({ type: "patchFailed", id: account.id });
      reportCliProxyError(failureTitle, result.error);
      return;
    }
    dispatchAccounts({ type: "patchSucceeded", id: account.id, account: result.value });
  };

  const deleteAccount = async (account: CliProxyAccount) => {
    if (api === null) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Remove ${describeCliProxyAccount(account)} from Prism? Its auth file is deleted on the server; sign in again to add it back.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    dispatchAccounts({ type: "deleteStarted", id: account.id });
    const result = await api.deleteAccount(account.id);
    if (result._tag === "error") {
      dispatchAccounts({ type: "deleteFailed", id: account.id });
      reportCliProxyError("Could not remove account", result.error);
      return;
    }
    dispatchAccounts({ type: "deleteSucceeded", id: account.id });
  };

  const [routingBusy, setRoutingBusy] = useState(false);
  const changeRouting = async (strategy: CliProxyRoutingStrategy) => {
    if (api === null) return;
    setRoutingBusy(true);
    const result = await api.setRouting(strategy);
    setRoutingBusy(false);
    if (result._tag === "error") {
      reportCliProxyError("Could not change routing strategy", result.error);
      return;
    }
    setData((previous) =>
      previous._tag === "ready" ? { ...previous, routing: result.value.strategy } : previous,
    );
  };

  const writable = data._tag === "ready";
  const showList = data._tag === "idle" || data._tag === "ready";

  return (
    <SettingsPageContainer>
      <CliProxyStatusSection
        status={statusView?.status ?? null}
        receivedAt={statusView?.receivedAt ?? 0}
        statusError={statusError}
        canRestart={api !== null}
        restarting={restarting}
        onRestart={() => void restartProxy()}
      />

      <SettingsSection
        {...searchableSetting("cliproxy-accounts")}
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label="Refresh accounts"
            disabled={api === null || loading || !showList}
            onClick={() => {
              dataLoadedRef.current = false;
              void loadData();
            }}
          >
            <RefreshCwIcon className="size-3" />
            Refresh
          </Button>
        }
      >
        {data._tag === "unavailable" ? (
          <SettingsRow
            title="Unavailable"
            description={describeCliProxyUnavailable(data.reason, data.state)}
          />
        ) : data._tag === "forbidden" ? (
          <SettingsRow title="Administrative access" description={data.message} />
        ) : (
          <>
            {loadError ? (
              <Alert variant="error" className="mx-3 mb-2 sm:mx-4">
                <AlertCircleIcon />
                <AlertTitle>Could not load accounts</AlertTitle>
                <AlertDescription>{loadError}</AlertDescription>
                <AlertAction>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={loading}
                    onClick={() => {
                      dataLoadedRef.current = false;
                      void loadData();
                    }}
                  >
                    {loading ? "Retrying…" : "Retry"}
                  </Button>
                </AlertAction>
              </Alert>
            ) : null}
            {accounts.accounts === null ? (
              loadError ? null : (
                <CliProxyAccountsSkeleton />
              )
            ) : accounts.accounts.length === 0 ? (
              <CliProxyAccountsEmpty />
            ) : (
              <SettingsRow
                title="Pool"
                description={`${accounts.accounts.length} account${accounts.accounts.length === 1 ? "" : "s"}. Disabled accounts stay on disk but take no requests; weight only matters for weighted round robin.`}
              >
                <CliProxyAccountsTable
                  state={accounts}
                  accounts={accounts.accounts}
                  highlightedAccountId={highlightedAccountId}
                  onToggle={(account, enabled) =>
                    void patchAccount(
                      account,
                      { disabled: !enabled },
                      enabled ? "Could not enable account" : "Could not disable account",
                    )
                  }
                  onWeight={(account, weight) =>
                    void patchAccount(account, { weight }, "Could not change weight")
                  }
                  onDelete={(account) => void deleteAccount(account)}
                />
              </SettingsRow>
            )}
          </>
        )}
      </SettingsSection>

      <CliProxyAddAccountSection api={api} writable={writable} onCompleted={handleLoginCompleted} />

      <SettingsSection {...searchableSetting("cliproxy-routing-strategy")}>
        <SettingsRow
          title="Strategy"
          description={`How the proxy picks an account per request. Applies immediately and is saved as cliproxy.routingStrategy in ${FORK_CONFIG_FILENAME}.`}
          control={
            <Select
              value={writable ? data.routing : null}
              onValueChange={(value) => {
                if (value === null) return;
                void changeRouting(value as CliProxyRoutingStrategy);
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-48"
                aria-label="Routing strategy"
                disabled={!writable || data.routing === null || routingBusy}
              >
                <SelectValue>
                  {writable && data.routing ? ROUTING_LABELS[data.routing] : "Unknown"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {CliProxyRoutingStrategy.literals.map((strategy) => (
                  <SelectItem key={strategy} hideIndicator value={strategy}>
                    {ROUTING_LABELS[strategy]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <CliProxySyncSection sync={sync} />

      <SettingsSection title="Usage">
        <SettingsRow
          title="API-key credentials"
          description={
            writable && data.usage && data.usage.length > 0
              ? "Requests per API-key credential since the proxy started. OAuth accounts report nothing here."
              : "No API-key usage recorded."
          }
        >
          {writable && data.usage && data.usage.length > 0 ? (
            <ul className="mb-2 space-y-0.5 text-xs text-muted-foreground">
              {data.usage.map((row) => (
                <li key={row.id} className="flex items-baseline gap-2">
                  <span className="text-foreground/90">{labelCliProxyProvider(row.provider)}</span>
                  <span className="min-w-0 truncate font-mono">{row.credential}</span>
                  <span className="ml-auto shrink-0 tabular-nums">
                    {row.success} ok · {row.failed} failed
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

/** Read-only view of cross-machine sync; configured in fork.json, never from the UI. */
function CliProxySyncSection({ sync }: { readonly sync: SyncView }) {
  return (
    <SettingsSection {...searchableSetting("cliproxy-sync")}>
      {sync._tag === "idle" ? (
        <SettingsRow title="Role" status="Checking…" />
      ) : sync._tag === "unavailable" ? (
        <SettingsRow
          title="Not configured"
          description={describeCliProxyUnavailable(sync.reason, sync.state)}
        />
      ) : sync._tag === "error" ? (
        <SettingsRow
          title="Sync status unavailable"
          description={<span className="text-destructive">{sync.message}</span>}
        />
      ) : (
        <>
          <SettingsRow
            title="Role"
            description={`Set as cliproxy.sync.role in ${FORK_CONFIG_FILENAME}; changes apply on the next server start.`}
            control={<MonoValue>{sync.value.role}</MonoValue>}
          />
          {sync.value.primaryUrl ? (
            <SettingsRow
              title="Primary"
              description="The environment this replica pulls auth files from and pushes refreshed tokens to."
              control={<MonoValue className="max-w-72">{sync.value.primaryUrl}</MonoValue>}
            />
          ) : null}
          {sync.value.intervalSeconds !== undefined ? (
            <SettingsRow
              title="Interval"
              control={
                <MonoValue>{formatCliProxySyncInterval(sync.value.intervalSeconds)}</MonoValue>
              }
            />
          ) : null}
          <SettingsRow
            title="Last sync"
            control={
              <MonoValue muted={!sync.value.lastSyncAt}>
                {sync.value.lastSyncAt
                  ? formatRelativeTimeLabel(sync.value.lastSyncAt) || sync.value.lastSyncAt
                  : "Never"}
              </MonoValue>
            }
          />
          {sync.value.lastSyncError ? (
            <SettingsRow
              title="Last error"
              description={
                <span className="font-mono whitespace-pre-wrap break-all text-destructive">
                  {sync.value.lastSyncError}
                </span>
              }
            />
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

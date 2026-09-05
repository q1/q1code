import { useAtomValue } from "@effect/atom-react";
import type {
  PrismAccount,
  PrismState,
  PrismStatus,
  PrismSyncStatus,
  PrismUnavailableReason,
} from "@q1code/core/prismApi";
import { PrismRoutingStrategy, FORK_CONFIG_FILENAME } from "@q1code/core/config";
import {
  INITIAL_PRISM_HEALTH,
  readForkFlag,
  reducePrismHealth,
  resolvePrismAccess,
} from "@t3tools/client-runtime/fork";
import { AlertCircleIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";

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
import { usePrimarySessionState } from "~/environments/primary";
import { usePrimaryEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { MicIdentityPanel } from "../mic-identity/MicIdentityPanel";
import { readMicIdentityBuildConfig } from "../mic-identity/publicConfig";
import { primaryServerConfigAtom } from "~/state/server";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { PrismAddAccountSection } from "./PrismAddAccount";
import {
  PrismAccountsEmpty,
  PrismAccountsSkeleton,
  PrismAccountsTable,
} from "./PrismAccountsTable";
import { PrismStatusSection } from "./PrismStatusSection";
import {
  describePrismRestart,
  describePrismUnavailable,
  formatPrismSyncInterval,
  INITIAL_PRISM_ACCOUNTS,
  reducePrismAccounts,
  resolvePrismMode,
  resolvePrismUsageSource,
} from "./prismAccountsState";
import { describePrismAccount, MonoValue, reportPrismError, useDocumentVisible } from "./prismUi";
import {
  type PrismApi,
  describePrismCallError,
  isPrismPermissionError,
  usePrismApi,
} from "./usePrismApi";

const STATUS_POLL_MS = 10_000;
/** While a restart is in flight the status poll tightens until the proxy settles. */
const RESTART_POLL_MS = 1_000;
/** A restart that has not settled by then stops looking pending; the badge keeps telling the truth. */
const RESTART_PENDING_MAX_MS = 90_000;
const NEW_ACCOUNT_HIGHLIGHT_MS = 6_000;

const ROUTING_LABELS: Readonly<Record<PrismRoutingStrategy, string>> = {
  "round-robin": "Round robin",
  "weighted-round-robin": "Weighted round robin",
  "fill-first": "Fill first",
};

type PanelData =
  | { readonly _tag: "idle" }
  | { readonly _tag: "ready"; readonly routing: PrismRoutingStrategy | null }
  | {
      readonly _tag: "unavailable";
      readonly reason: PrismUnavailableReason;
      readonly state: PrismState;
    }
  | { readonly _tag: "forbidden"; readonly message: string };

type SyncView =
  | { readonly _tag: "idle" }
  | { readonly _tag: "ready"; readonly value: PrismSyncStatus }
  | {
      readonly _tag: "unavailable";
      readonly reason: PrismUnavailableReason;
      readonly state: PrismState;
    }
  | { readonly _tag: "error"; readonly message: string };

/** The Prism tab. Off flag, missing primary, and the live panel each get a calm page of their own. */
export function PrismSettingsPanel() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const config = useAtomValue(primaryServerConfigAtom);
  if (readMicIdentityBuildConfig()._tag !== "disabled") return <MicIdentityPanel />;
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
  if (readForkFlag(config.environment.capabilities, "mic-identity")) return <MicIdentityPanel />;
  if (!readForkFlag(config.environment.capabilities, "prism")) {
    return (
      <PrismNotice
        title="Prism is off"
        description={`Prism is q1code's account proxy: one pool of provider accounts shared by Claude and Codex, with load balancing and cross-machine sync. ${describePrismUnavailable("flag-off", "off")}`}
      />
    );
  }
  return <PrismSettingsPanelBody key={primaryEnvironmentId} />;
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

function PrismSettingsPanelBody() {
  const api = usePrismApi();
  const visible = useDocumentVisible();
  const environment = usePrimaryEnvironment();
  const connected = api !== null && environment?.connection.phase === "connected";

  const session = usePrimarySessionState();
  const [health, dispatchHealth] = useReducer(reducePrismHealth, INITIAL_PRISM_HEALTH);
  const access = resolvePrismAccess({
    health,
    connected,
    session: session.data,
    sessionError: session.error !== null,
  });
  // Confirmation dialogs may remain open across a failed health check or permission change.
  const accessRef = useRef(access);
  useLayoutEffect(() => {
    accessRef.current = access;
  }, [access]);
  const [sync, setSync] = useState<SyncView>({ _tag: "idle" });
  const [restart, setRestart] = useState<{ readonly startedAt: number } | null>(null);

  const [data, setData] = useState<PanelData>({ _tag: "idle" });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [accounts, dispatchAccounts] = useReducer(reducePrismAccounts, INITIAL_PRISM_ACCOUNTS);
  // Set once the list loaded (or the server said no); cleared to force a reload.
  const dataLoadedRef = useRef(false);
  const loadGenerationRef = useRef(0);

  const loadData = useCallback(async () => {
    if (api === null) return;
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    const [accountsResult, routing] = await Promise.all([api.listAccounts(), api.getRouting()]);
    if (generation !== loadGenerationRef.current) return;
    setLoading(false);
    if (accountsResult._tag === "error") {
      const error = accountsResult.error;
      if (error._tag === "PrismUnavailableError") {
        setData({ _tag: "unavailable", reason: error.reason, state: error.state });
      } else if (isPrismPermissionError(error)) {
        dataLoadedRef.current = true;
        setData({ _tag: "forbidden", message: describePrismCallError(error) });
      } else {
        setLoadError(describePrismCallError(error));
      }
      return;
    }
    dataLoadedRef.current = true;
    setLoadError(null);
    dispatchAccounts({ type: "loaded", accounts: accountsResult.value });
    setData({ _tag: "ready", routing: routing._tag === "ok" ? routing.value.strategy : null });
  }, [api]);

  // What every status answer means for the rest of the panel: the list loads
  // once the proxy is ready, goes away when it is not, and a pending restart
  // settles on ready or failed.
  const applyStatus = useCallback(
    (status: PrismStatus) => {
      if (status.state !== "ready") {
        dataLoadedRef.current = false;
        setData({ _tag: "unavailable", reason: "sidecar-not-ready", state: status.state });
      } else if (status.capabilities?.accountDetails === false) {
        dataLoadedRef.current = false;
        setData({
          _tag: "forbidden",
          message: "Your account can use Prism without access to pooled account details.",
        });
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
      const statusResult = await api.status();
      if (cancelled) return;
      if (statusResult._tag === "error") {
        dispatchHealth({ type: "failed", error: describePrismCallError(statusResult.error) });
        return;
      }
      dispatchHealth({ type: "received", status: statusResult.value, receivedAt: Date.now() });
      applyStatus(statusResult.value);
      const syncResult =
        statusResult.value.capabilities?.accountDetails !== false ? await api.syncStatus() : null;
      if (cancelled) return;
      if (syncResult?._tag === "ok") {
        setSync({ _tag: "ready", value: syncResult.value });
      } else if (
        syncResult?._tag === "error" &&
        syncResult.error._tag === "PrismUnavailableError"
      ) {
        setSync({
          _tag: "unavailable",
          reason: syncResult.error.reason,
          state: syncResult.error.state,
        });
      } else if (syncResult?._tag === "error") {
        setSync({ _tag: "error", message: describePrismCallError(syncResult.error) });
      }
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
    if (api === null || restarting || health.status === null || !accessRef.current.configure)
      return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      describePrismRestart(resolvePrismMode(health.status)),
    );
    if (!confirmed || !accessRef.current.configure) return;
    setRestart({ startedAt: Date.now() });
    const result = await api.restart();
    if (result._tag === "error") {
      setRestart(null);
      reportPrismError("Could not restart the proxy", result.error);
      return;
    }
    dispatchHealth({ type: "received", status: result.value, receivedAt: Date.now() });
    applyStatus(result.value);
  };

  const refreshAccounts = useCallback(async () => {
    if (api === null) return;
    const result = await api.listAccounts();
    if (result._tag === "error") {
      reportPrismError("Could not refresh accounts", result.error);
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
    account: PrismAccount,
    patch: Parameters<PrismApi["patchAccount"]>[1],
    failureTitle: string,
  ) => {
    if (api === null || !accessRef.current.accounts) return;
    dispatchAccounts({ type: "patchStarted", id: account.id, patch });
    const result = await api.patchAccount(account.id, patch);
    if (result._tag === "error") {
      dispatchAccounts({ type: "patchFailed", id: account.id });
      reportPrismError(failureTitle, result.error);
      return;
    }
    dispatchAccounts({ type: "patchSucceeded", id: account.id, account: result.value });
  };

  const deleteAccount = async (account: PrismAccount) => {
    if (api === null || !accessRef.current.accounts) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Remove ${describePrismAccount(account)} from Prism? Its auth file is deleted on the server; sign in again to add it back.`,
      { variant: "destructive" },
    );
    if (!confirmed || !accessRef.current.accounts) return;
    dispatchAccounts({ type: "deleteStarted", id: account.id });
    const result = await api.deleteAccount(account.id);
    if (result._tag === "error") {
      dispatchAccounts({ type: "deleteFailed", id: account.id });
      reportPrismError("Could not remove account", result.error);
      return;
    }
    dispatchAccounts({ type: "deleteSucceeded", id: account.id });
  };

  // The switch flips at once and holds the requested value until the server
  // answers; a failure drops it, so the switch falls back to the last status.
  const [usageSourceRequest, setUsageSourceRequest] = useState<boolean | null>(null);
  const changeUsageSource = async (enabled: boolean) => {
    if (api === null || usageSourceRequest !== null || !accessRef.current.configure) return;
    setUsageSourceRequest(enabled);
    const result = await api.setUsageSource(enabled);
    setUsageSourceRequest(null);
    if (result._tag === "error") {
      reportPrismError(
        enabled ? "Could not show accounts on Usage" : "Could not hide accounts from Usage",
        result.error,
      );
      return;
    }
    dispatchHealth({ type: "received", status: result.value, receivedAt: Date.now() });
  };

  const [routingBusy, setRoutingBusy] = useState(false);
  const changeRouting = async (strategy: PrismRoutingStrategy) => {
    if (api === null || !accessRef.current.routing || routingBusy) return;
    setRoutingBusy(true);
    const result = await api.setRouting(strategy);
    setRoutingBusy(false);
    if (result._tag === "error") {
      reportPrismError("Could not change routing strategy", result.error);
      return;
    }
    setData((previous) =>
      previous._tag === "ready" ? { ...previous, routing: result.value.strategy } : previous,
    );
  };

  const accountWritable = data._tag === "ready" && access.accounts;
  const routing = data._tag === "ready" ? data.routing : null;
  const showList = data._tag === "idle" || data._tag === "ready";

  return (
    <SettingsPageContainer>
      <PrismStatusSection
        status={health.status}
        receivedAt={health.receivedAt}
        statusError={health.error ?? (!connected ? "The environment is disconnected." : null)}
        canRestart={access.configure}
        restarting={restarting}
        onRestart={() => void restartProxy()}
        usageSource={
          usageSourceRequest ??
          (health.status === null ? null : resolvePrismUsageSource(health.status))
        }
        usageSourcePending={usageSourceRequest !== null}
        canConfigure={access.configure}
        onUsageSourceChange={(enabled) => void changeUsageSource(enabled)}
      />

      {access.accountDetails ? (
        <>
          <SettingsSection
            {...searchableSetting("prism-accounts")}
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
                description={describePrismUnavailable(data.reason, data.state)}
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
                    <PrismAccountsSkeleton />
                  )
                ) : accounts.accounts.length === 0 ? (
                  <PrismAccountsEmpty />
                ) : (
                  <SettingsRow
                    title="Pool"
                    description={`${accounts.accounts.length} account${accounts.accounts.length === 1 ? "" : "s"}. Disabled accounts stay on disk but take no requests; weight only matters for weighted round robin.`}
                  >
                    <PrismAccountsTable
                      readOnly={!accountWritable}
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

          <PrismAddAccountSection
            api={api}
            writable={accountWritable}
            onCompleted={handleLoginCompleted}
          />

          <SettingsSection {...searchableSetting("prism-routing-strategy")}>
            <SettingsRow
              title="Strategy"
              description={`How the proxy picks an account per request. Applies immediately and is saved as prism.routingStrategy in ${FORK_CONFIG_FILENAME}.`}
              control={
                <Select
                  value={routing}
                  onValueChange={(value) => {
                    if (value === null) return;
                    void changeRouting(value as PrismRoutingStrategy);
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full sm:w-48"
                    aria-label="Routing strategy"
                    disabled={!access.routing || routing === null || routingBusy}
                  >
                    <SelectValue>{routing ? ROUTING_LABELS[routing] : "Unknown"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {PrismRoutingStrategy.literals.map((strategy) => (
                      <SelectItem key={strategy} hideIndicator value={strategy}>
                        {ROUTING_LABELS[strategy]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          </SettingsSection>

          <PrismSyncSection sync={sync} />
        </>
      ) : health.status ? (
        <SettingsSection title="Prism access">
          <SettingsRow
            title={access.inference ? "Ready for inference" : "Inference unavailable"}
            description="Pooled account details and management require administrative access."
          />
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

/** Read-only view of cross-machine sync; configured in fork.json, never from the UI. */
function PrismSyncSection({ sync }: { readonly sync: SyncView }) {
  return (
    <SettingsSection {...searchableSetting("prism-sync")}>
      {sync._tag === "idle" ? (
        <SettingsRow title="Role" status="Checking…" />
      ) : sync._tag === "unavailable" ? (
        <SettingsRow
          title="Not configured"
          description={describePrismUnavailable(sync.reason, sync.state)}
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
            description={`Set as prism.sync.role in ${FORK_CONFIG_FILENAME}; changes apply on the next server start.`}
            control={<MonoValue>{sync.value.role}</MonoValue>}
          />
          {sync.value.primaryUrl ? (
            <SettingsRow
              title="Primary"
              description="The primary owns sign-in, account changes, and token refresh. This gateway receives encrypted serving credentials."
              control={<MonoValue className="max-w-72">{sync.value.primaryUrl}</MonoValue>}
            />
          ) : null}
          {sync.value.intervalSeconds !== undefined ? (
            <SettingsRow
              title="Interval"
              control={<MonoValue>{formatPrismSyncInterval(sync.value.intervalSeconds)}</MonoValue>}
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

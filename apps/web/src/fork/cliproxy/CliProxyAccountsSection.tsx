import type {
  CliProxyAccount,
  CliProxyLoginProvider,
  CliProxyState,
  CliProxyStatus,
  CliProxyUnavailableReason,
} from "@q1code/core/cliproxyApi";
import { CliProxyRoutingStrategy } from "@q1code/core/config";
import { FORK_CONFIG_FILENAME } from "@q1code/core/config";
import { CheckIcon, ChevronRightIcon, CopyIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "~/components/ui/anchoredCopyToast";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { SettingsRow, useSettingsSearchTargetId } from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { ensureLocalApi } from "~/localApi";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { useForkFlag } from "../useForkFlag";
import {
  CLIPROXY_LOGIN_PROVIDER_LABELS,
  CLIPROXY_LOGIN_PROVIDERS,
  CLIPROXY_STATE_LABELS,
  type CliProxyUsageRow,
  describeCliProxyAccountQuota,
  describeCliProxyUnavailable,
  flattenCliProxyUsage,
  IDLE_LOGIN_FLOW,
  labelCliProxyProvider,
  parseCliProxyWeight,
  pendingCliProxyLoginSession,
  reduceCliProxyLoginFlow,
} from "./cliproxyAccountsState";
import {
  type CliProxyApi,
  type CliProxyCallError,
  describeCliProxyCallError,
  isCliProxyPermissionError,
  useCliProxyApi,
} from "./useCliProxyApi";

const SEARCH_IDS = {
  section: "cliproxy-accounts",
  addAccount: "cliproxy-add-account",
  routing: "cliproxy-routing-strategy",
} as const;
const SEARCH_TARGET_IDS = new Set<string>(Object.values(SEARCH_IDS));

const STATUS_POLL_MS = 10_000;
const LOGIN_POLL_MS = 2_000;
const NEW_ACCOUNT_HIGHLIGHT_MS = 6_000;

const STATE_BADGE_VARIANT: Readonly<
  Record<CliProxyState, "outline" | "warning" | "success" | "error">
> = {
  off: "outline",
  starting: "warning",
  ready: "success",
  failed: "error",
};

const ROUTING_LABELS: Readonly<Record<CliProxyRoutingStrategy, string>> = {
  "round-robin": "Round robin",
  "weighted-round-robin": "Weighted round robin",
  "fill-first": "Fill first",
};

type SectionData =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | {
      readonly _tag: "ready";
      readonly accounts: ReadonlyArray<CliProxyAccount>;
      readonly routing: CliProxyRoutingStrategy | null;
      readonly usage: ReadonlyArray<CliProxyUsageRow> | null;
    }
  | {
      readonly _tag: "unavailable";
      readonly reason: CliProxyUnavailableReason;
      readonly state: CliProxyState;
    }
  | { readonly _tag: "forbidden"; readonly message: string }
  | { readonly _tag: "error"; readonly message: string };

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "visible",
    () => true,
  );
}

function reportError(title: string, error: CliProxyCallError) {
  toastManager.add(
    stackedThreadToast({ type: "error", title, description: describeCliProxyCallError(error) }),
  );
}

function openExternal(url: string) {
  void ensureLocalApi()
    .shell.openExternal(url)
    .catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not open the sign-in page",
          description: error instanceof Error ? error.message : "Copy the link instead.",
        }),
      );
    });
}

/** Accounts pooled by the CLIProxyAPI sidecar on the primary environment. Renders only behind the flag. */
export function CliProxyAccountsSection() {
  const enabled = useForkFlag("cliproxy");
  if (!enabled) return null;
  return <CliProxyAccountsSectionBody />;
}

function CliProxyAccountsSectionBody() {
  const api = useCliProxyApi();
  const visible = useDocumentVisible();
  const [open, setOpen] = useState(false);
  const searchTargetId = useSettingsSearchTargetId();
  const lastExpandedTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (searchTargetId === null) {
      lastExpandedTargetRef.current = null;
      return;
    }
    if (!SEARCH_TARGET_IDS.has(searchTargetId)) return;
    if (lastExpandedTargetRef.current === searchTargetId) return;
    lastExpandedTargetRef.current = searchTargetId;
    setOpen(true);
  }, [searchTargetId]);

  const [status, setStatus] = useState<CliProxyStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [data, setData] = useState<SectionData>({ _tag: "idle" });
  // Set once accounts loaded (or the server said no); cleared to force a reload.
  const dataLoadedRef = useRef(false);
  const loadGenerationRef = useRef(0);

  const loadData = useCallback(async () => {
    if (api === null) return;
    const generation = ++loadGenerationRef.current;
    setData((previous) => (previous._tag === "ready" ? previous : { _tag: "loading" }));
    const [accounts, routing, usage] = await Promise.all([
      api.listAccounts(),
      api.getRouting(),
      api.getUsage(),
    ]);
    if (generation !== loadGenerationRef.current) return;
    if (accounts._tag === "error") {
      const error = accounts.error;
      if (error._tag === "CliProxyUnavailableError") {
        setData({ _tag: "unavailable", reason: error.reason, state: error.state });
      } else if (isCliProxyPermissionError(error)) {
        dataLoadedRef.current = true;
        setData({ _tag: "forbidden", message: describeCliProxyCallError(error) });
      } else {
        setData({ _tag: "error", message: describeCliProxyCallError(error) });
      }
      return;
    }
    dataLoadedRef.current = true;
    setData({
      _tag: "ready",
      accounts: accounts.value,
      routing: routing._tag === "ok" ? routing.value.strategy : null,
      usage: usage._tag === "ok" ? flattenCliProxyUsage(usage.value) : null,
    });
  }, [api]);

  // Status polls only while expanded and visible; the accounts list loads once
  // the sidecar reports ready and again after each mutation.
  useEffect(() => {
    if (!open || !visible || api === null) return;
    let cancelled = false;
    const tick = async () => {
      const result = await api.status();
      if (cancelled) return;
      if (result._tag === "error") {
        setStatusError(describeCliProxyCallError(result.error));
        return;
      }
      setStatusError(null);
      setStatus(result.value);
      if (result.value.state !== "ready") {
        dataLoadedRef.current = false;
        setData({ _tag: "unavailable", reason: "sidecar-not-ready", state: result.value.state });
      } else if (!dataLoadedRef.current) {
        void loadData();
      }
    };
    void tick();
    const interval = window.setInterval(() => void tick(), STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      loadGenerationRef.current += 1;
    };
  }, [open, visible, api, loadData]);

  useEffect(() => {
    if (!open) dataLoadedRef.current = false;
  }, [open]);

  const refreshAccounts = useCallback(async () => {
    if (api === null) return;
    const result = await api.listAccounts();
    if (result._tag === "error") {
      reportError("Could not refresh accounts", result.error);
      return;
    }
    setData((previous) =>
      previous._tag === "ready" ? { ...previous, accounts: result.value } : previous,
    );
  }, [api]);

  const replaceAccount = (account: CliProxyAccount) =>
    setData((previous) =>
      previous._tag === "ready"
        ? {
            ...previous,
            accounts: previous.accounts.map((entry) => (entry.id === account.id ? account : entry)),
          }
        : previous,
    );

  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [highlightedAccountId, setHighlightedAccountId] = useState<string | null>(null);

  const patchAccount = async (
    account: CliProxyAccount,
    patch: Parameters<CliProxyApi["patchAccount"]>[1],
    failureTitle: string,
  ) => {
    if (api === null) return;
    setBusyAccountId(account.id);
    const result = await api.patchAccount(account.id, patch);
    setBusyAccountId((current) => (current === account.id ? null : current));
    if (result._tag === "error") {
      reportError(failureTitle, result.error);
      return;
    }
    replaceAccount(result.value);
  };

  const deleteAccount = async (account: CliProxyAccount) => {
    if (api === null) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Remove ${describeAccount(account)} from CLIProxyAPI? Its auth file is deleted on the server; sign in again to add it back.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setBusyAccountId(account.id);
    const result = await api.deleteAccount(account.id);
    setBusyAccountId((current) => (current === account.id ? null : current));
    if (result._tag === "error") {
      reportError("Could not remove account", result.error);
      return;
    }
    setData((previous) =>
      previous._tag === "ready"
        ? { ...previous, accounts: previous.accounts.filter((entry) => entry.id !== account.id) }
        : previous,
    );
  };

  const [routingBusy, setRoutingBusy] = useState(false);
  const changeRouting = async (strategy: CliProxyRoutingStrategy) => {
    if (api === null) return;
    setRoutingBusy(true);
    const result = await api.setRouting(strategy);
    setRoutingBusy(false);
    if (result._tag === "error") {
      reportError("Could not change routing strategy", result.error);
      return;
    }
    setData((previous) =>
      previous._tag === "ready" ? { ...previous, routing: result.value.strategy } : previous,
    );
  };

  // Login flow: the reducer owns the transitions; effects only poll and refresh.
  const [flow, dispatch] = useReducer(reduceCliProxyLoginFlow, IDLE_LOGIN_FLOW);
  const [provider, setProvider] = useState<CliProxyLoginProvider>("codex");
  const [redirectDraft, setRedirectDraft] = useState("");
  const pendingSession = pendingCliProxyLoginSession(flow);

  useEffect(() => {
    if (pendingSession === null || api === null) return;
    let cancelled = false;
    const poll = async () => {
      const result = await api.loginStatus(pendingSession);
      if (cancelled) return;
      if (result._tag === "ok") {
        dispatch({ type: "status", status: result.value });
      } else if (result.error._tag === "CliProxyNotFoundError") {
        dispatch({
          type: "status",
          status: {
            sessionId: pendingSession,
            status: "failed",
            error: "The sign-in session expired before it finished.",
          },
        });
      }
    };
    const interval = window.setInterval(() => void poll(), LOGIN_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [pendingSession, api]);

  useEffect(() => {
    if (flow._tag !== "completed") return;
    setRedirectDraft("");
    setHighlightedAccountId(flow.accountId);
    void refreshAccounts();
    const timeout = window.setTimeout(
      () => setHighlightedAccountId(null),
      NEW_ACCOUNT_HIGHLIGHT_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [flow, refreshAccounts]);

  const startLogin = async () => {
    if (api === null) return;
    dispatch({ type: "start", provider });
    const result = await api.startLogin(provider);
    if (result._tag === "error") {
      dispatch({ type: "startFailed", error: describeCliProxyCallError(result.error) });
      return;
    }
    dispatch({ type: "started", started: result.value });
  };

  const cancelLogin = async () => {
    if (api === null || flow._tag !== "pending") return;
    const sessionId = flow.sessionId;
    dispatch({ type: "cancel" });
    setRedirectDraft("");
    const result = await api.cancelLogin(sessionId);
    if (result._tag === "error" && result.error._tag !== "CliProxyNotFoundError") {
      reportError("Could not cancel the sign-in", result.error);
    }
  };

  const submitRedirect = async () => {
    if (api === null || flow._tag !== "pending" || flow.submittingRedirect) return;
    const redirectUrl = redirectDraft.trim();
    if (redirectUrl.length === 0) return;
    const sessionId = flow.sessionId;
    dispatch({ type: "pasteRedirect" });
    const result = await api.completeLogin(sessionId, redirectUrl);
    if (result._tag === "error") {
      dispatch({
        type: "redirectFailed",
        sessionId,
        error: describeCliProxyCallError(result.error),
      });
      return;
    }
    dispatch({ type: "status", status: result.value });
  };

  const loginBusy = flow._tag === "starting" || flow._tag === "pending";
  const writable = data._tag === "ready";

  return (
    <section className="space-y-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex min-h-8 w-full items-center gap-2 px-3 sm:px-4">
          <h2 className="text-lg font-semibold tracking-[-0.025em] text-muted-foreground transition-colors group-hover:text-foreground">
            Accounts (CLIProxyAPI)
          </h2>
          <ChevronRightIcon className="size-4 text-muted-foreground transition-transform duration-200 group-data-panel-open:rotate-90" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="relative space-y-1 overflow-visible pt-3 text-foreground">
            <SettingsRow
              {...searchableSetting(SEARCH_IDS.section)}
              description="Provider accounts pooled by the CLIProxyAPI sidecar on the primary environment. Claude and Codex instances that route through the proxy share this pool."
              status={
                statusError ? (
                  <span className="text-destructive">{statusError}</span>
                ) : status ? (
                  <StatusLine status={status} />
                ) : api === null ? (
                  "Waiting for the primary environment."
                ) : (
                  "Checking the sidecar…"
                )
              }
              control={
                <>
                  {status ? (
                    <Badge variant={STATE_BADGE_VARIANT[status.state]}>
                      {CLIPROXY_STATE_LABELS[status.state]}
                    </Badge>
                  ) : null}
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    aria-label="Refresh accounts"
                    disabled={api === null || data._tag === "loading"}
                    onClick={() => {
                      dataLoadedRef.current = false;
                      void loadData();
                    }}
                  >
                    <RefreshCwIcon className="size-3" />
                    Refresh
                  </Button>
                </>
              }
            />

            {data._tag === "unavailable" ? (
              <SettingsRow
                title="Unavailable"
                description={describeCliProxyUnavailable(data.reason, data.state)}
              />
            ) : data._tag === "forbidden" ? (
              <SettingsRow title="Administrative access" description={data.message} />
            ) : data._tag === "error" ? (
              <SettingsRow
                title="Could not load accounts"
                description={<span className="text-destructive">{data.message}</span>}
              />
            ) : data._tag === "loading" || data._tag === "idle" ? (
              <SettingsRow title="Accounts" description="Loading…" />
            ) : (
              <SettingsRow
                title="Accounts"
                description={
                  data.accounts.length === 0
                    ? "No accounts yet. Add one below."
                    : `${data.accounts.length} account${data.accounts.length === 1 ? "" : "s"}. Disabled accounts stay on disk but take no requests; weight only matters for weighted round robin.`
                }
              >
                {data.accounts.length > 0 ? (
                  <AccountsTable
                    accounts={data.accounts}
                    busyAccountId={busyAccountId}
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
                ) : null}
              </SettingsRow>
            )}

            <SettingsRow
              {...searchableSetting(SEARCH_IDS.addAccount)}
              description="Starts an OAuth sign-in on the server. Open the link in any browser; if that browser cannot reach this server, paste the URL it lands on back here."
              control={
                <>
                  <Select
                    value={provider}
                    onValueChange={(value) => setProvider(value as CliProxyLoginProvider)}
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-full sm:w-44"
                      aria-label="Provider"
                      disabled={loginBusy || !writable}
                    >
                      <SelectValue>{CLIPROXY_LOGIN_PROVIDER_LABELS[provider]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {CLIPROXY_LOGIN_PROVIDERS.map((entry) => (
                        <SelectItem key={entry} hideIndicator value={entry}>
                          {CLIPROXY_LOGIN_PROVIDER_LABELS[entry]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={loginBusy || !writable}
                    onClick={() => void startLogin()}
                  >
                    {flow._tag === "starting" ? "Starting…" : "Sign in"}
                  </Button>
                </>
              }
            >
              {flow._tag === "pending" ? (
                <div className="mt-2 mb-2 space-y-3 rounded-lg border border-border/60 bg-muted/30 p-3 text-xs">
                  <div className="space-y-1">
                    <p className="font-medium text-foreground">
                      Finish signing in to {CLIPROXY_LOGIN_PROVIDER_LABELS[flow.provider]}
                    </p>
                    <div className="flex min-w-0 items-center gap-1">
                      <a
                        href={flow.authUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-w-0 truncate font-mono text-primary underline-offset-4 hover:underline"
                        onClick={(event) => {
                          event.preventDefault();
                          openExternal(flow.authUrl);
                        }}
                      >
                        {flow.authUrl}
                      </a>
                      <CopyValueButton value={flow.authUrl} label="Copy sign-in link" />
                    </div>
                    {flow.userCode ? (
                      <div className="flex items-center gap-1 text-muted-foreground">
                        Enter code
                        <code className="rounded bg-background px-1.5 py-0.5 font-mono text-sm text-foreground">
                          {flow.userCode}
                        </code>
                        <CopyValueButton value={flow.userCode} label="Copy code" />
                      </div>
                    ) : null}
                    <p className="text-muted-foreground">
                      Waiting for the provider to call back. This checks every few seconds.
                    </p>
                  </div>
                  {flow.flow === "redirect" ? (
                    <div className="space-y-1">
                      <label
                        className="text-muted-foreground"
                        htmlFor="cliproxy-login-redirect-url"
                      >
                        Signed in from another machine? Paste the redirect URL the browser landed
                        on.
                      </label>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Input
                          id="cliproxy-login-redirect-url"
                          size="sm"
                          value={redirectDraft}
                          placeholder="http://localhost:.../callback?code=…&state=…"
                          spellCheck={false}
                          disabled={flow.submittingRedirect}
                          onChange={(event) => setRedirectDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            void submitRedirect();
                          }}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          className="shrink-0"
                          disabled={flow.submittingRedirect || redirectDraft.trim().length === 0}
                          onClick={() => void submitRedirect()}
                        >
                          {flow.submittingRedirect ? "Submitting…" : "Complete"}
                        </Button>
                      </div>
                      {flow.redirectError ? (
                        <p className="text-destructive">{flow.redirectError}</p>
                      ) : null}
                    </div>
                  ) : null}
                  <div>
                    <Button size="sm" variant="ghost" onClick={() => void cancelLogin()}>
                      Cancel sign-in
                    </Button>
                  </div>
                </div>
              ) : flow._tag === "completed" ? (
                <FlowNotice
                  tone="success"
                  text={`Signed in to ${CLIPROXY_LOGIN_PROVIDER_LABELS[flow.provider]}${flow.accountId ? ` as ${flow.accountId}` : ""}.`}
                  onDismiss={() => dispatch({ type: "reset" })}
                />
              ) : flow._tag === "failed" ? (
                <FlowNotice
                  tone="error"
                  text={`Sign-in to ${CLIPROXY_LOGIN_PROVIDER_LABELS[flow.provider]} failed: ${flow.error}`}
                  onDismiss={() => dispatch({ type: "reset" })}
                />
              ) : flow._tag === "cancelled" ? (
                <FlowNotice
                  tone="muted"
                  text="Sign-in cancelled."
                  onDismiss={() => dispatch({ type: "reset" })}
                />
              ) : null}
            </SettingsRow>

            <SettingsRow
              {...searchableSetting(SEARCH_IDS.routing)}
              description={`How the sidecar picks an account per request. Applies immediately and is saved as cliproxy.routingStrategy in ${FORK_CONFIG_FILENAME}.`}
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

            <SettingsRow
              title="Usage"
              description={
                writable && data.usage && data.usage.length > 0
                  ? "Requests per API-key credential since the sidecar started. OAuth accounts report nothing here."
                  : "No API-key usage recorded."
              }
            >
              {writable && data.usage && data.usage.length > 0 ? (
                <ul className="mb-2 space-y-0.5 text-xs text-muted-foreground">
                  {data.usage.map((row) => (
                    <li key={row.id} className="flex items-baseline gap-2">
                      <span className="text-foreground/90">
                        {labelCliProxyProvider(row.provider)}
                      </span>
                      <span className="min-w-0 truncate font-mono">{row.credential}</span>
                      <span className="ml-auto shrink-0 tabular-nums">
                        {row.success} ok · {row.failed} failed
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </SettingsRow>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

function describeAccount(account: CliProxyAccount): string {
  const name = account.email ?? account.label;
  return `${labelCliProxyProvider(account.provider)} account ${name}`;
}

function StatusLine({ status }: { readonly status: CliProxyStatus }) {
  const parts: Array<string> = [`port ${status.port}`];
  if (status.version) parts.push(`v${status.version}`);
  parts.push(`sync: ${status.role}`);
  if (status.lastSyncAt) {
    const label = formatRelativeTimeLabel(status.lastSyncAt);
    if (label) parts.push(`last sync ${label}`);
  }
  return (
    <span className="font-mono">
      {parts.join(" · ")}
      {status.lastSyncError ? (
        <>
          {" · "}
          <span className="text-destructive">sync error: {status.lastSyncError}</span>
        </>
      ) : null}
    </span>
  );
}

function FlowNotice({
  tone,
  text,
  onDismiss,
}: {
  readonly tone: "success" | "error" | "muted";
  readonly text: string;
  readonly onDismiss: () => void;
}) {
  return (
    <div className="mt-2 mb-2 flex items-center gap-2 text-xs">
      <span
        className={cn(
          "min-w-0 flex-1",
          tone === "success" && "text-success-foreground",
          tone === "error" && "text-destructive",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {text}
      </span>
      <Button size="xs" variant="ghost-muted" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

function CopyValueButton({ value, label }: { readonly value: string; readonly label: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
  });
  return (
    <Button
      ref={ref}
      size="icon-micro"
      variant="ghost-muted"
      aria-label={label}
      onClick={() => copyToClipboard(value, undefined)}
    >
      {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
    </Button>
  );
}

function AccountsTable({
  accounts,
  busyAccountId,
  highlightedAccountId,
  onToggle,
  onWeight,
  onDelete,
}: {
  readonly accounts: ReadonlyArray<CliProxyAccount>;
  readonly busyAccountId: string | null;
  readonly highlightedAccountId: string | null;
  readonly onToggle: (account: CliProxyAccount, enabled: boolean) => void;
  readonly onWeight: (account: CliProxyAccount, weight: number) => void;
  readonly onDelete: (account: CliProxyAccount) => void;
}) {
  const showUsage = accounts.some((account) => account.usage !== undefined);
  return (
    <div className="mt-1 mb-2 -mx-2">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Provider</TableHead>
            <TableHead>Account</TableHead>
            <TableHead>Enabled</TableHead>
            <TableHead>Weight</TableHead>
            {showUsage ? <TableHead>Requests</TableHead> : null}
            <TableHead>Updated</TableHead>
            <TableHead className="w-8" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {accounts.map((account) => {
            const busy = busyAccountId === account.id;
            const updated = formatRelativeTimeLabel(account.updatedAt);
            return (
              <TableRow
                key={account.id}
                className={cn(
                  account.disabled && "text-muted-foreground",
                  highlightedAccountId === account.id && "bg-success/8 hover:bg-success/8",
                )}
              >
                <TableCell>{labelCliProxyProvider(account.provider)}</TableCell>
                <TableCell className="max-w-64">
                  <span className="block truncate">{account.email ?? account.label}</span>
                  {account.email && account.email !== account.label ? (
                    <span className="block truncate text-[11px] text-muted-foreground/70">
                      {account.label}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Switch
                    size="sm"
                    checked={!account.disabled}
                    disabled={busy}
                    onCheckedChange={(checked) => onToggle(account, Boolean(checked))}
                    aria-label={`${account.disabled ? "Enable" : "Disable"} ${describeAccount(account)}`}
                  />
                </TableCell>
                <TableCell>
                  <WeightInput
                    account={account}
                    disabled={busy}
                    onCommit={(weight) => onWeight(account, weight)}
                  />
                </TableCell>
                {showUsage ? (
                  <TableCell
                    className="text-muted-foreground tabular-nums whitespace-nowrap"
                    title={describeCliProxyAccountQuota(account.usage)}
                  >
                    {account.usage
                      ? `${account.usage.success} ok · ${account.usage.failed} failed`
                      : "—"}
                  </TableCell>
                ) : null}
                <TableCell className="text-muted-foreground">{updated || "—"}</TableCell>
                <TableCell>
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label={`Remove ${describeAccount(account)}`}
                    disabled={busy}
                    onClick={() => onDelete(account)}
                  >
                    <Trash2Icon className="size-3" />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** Draft while focused; the value only travels on blur or Enter, and only when it changed. */
function WeightInput({
  account,
  disabled,
  onCommit,
}: {
  readonly account: CliProxyAccount;
  readonly disabled: boolean;
  readonly onCommit: (weight: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Escape blurs the input, and that blur must not commit the abandoned draft.
  const discardRef = useRef(false);
  const commit = () => {
    if (discardRef.current) {
      discardRef.current = false;
      return;
    }
    if (draft === null) return;
    const parsed = parseCliProxyWeight(draft, account.weight);
    setDraft(null);
    if (parsed !== null) onCommit(parsed);
  };
  return (
    <Input
      size="compact"
      className="w-16 text-right tabular-nums"
      inputMode="numeric"
      value={draft ?? (account.weight === undefined ? "" : String(account.weight))}
      placeholder="1"
      disabled={disabled}
      aria-label={`Weight for ${describeAccount(account)}`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          discardRef.current = true;
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

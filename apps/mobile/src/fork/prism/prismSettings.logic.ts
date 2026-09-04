/**
 * Pure state and labels for the Prism settings screen (the pooled provider
 * accounts on mobile): which environments show it, status and error
 * descriptions, the login-flow reducer, the optimistic accounts reducer, and
 * the polling decisions. No React, no network; the screen wires these to
 * `@t3tools/client-runtime/fork`.
 */
import type {
  PrismAccount,
  PrismLoginProvider,
  PrismLoginStarted,
  PrismLoginStatus,
  PrismState,
  PrismStatus,
  PrismUnavailableReason,
} from "@q1code/core/prismApi";
import { FORK_CONFIG_FILENAME, type PrismRoutingStrategy } from "@q1code/core/config";
import { envVarForFlag } from "@q1code/core/flags";
import { type PrismClientError, readForkFlag } from "@t3tools/client-runtime/fork";
import type { EnvironmentId, ExecutionEnvironmentCapabilities } from "@t3tools/contracts";

import type { StatusTone } from "../../components/StatusPill";

// Environments

export interface PrismEnvironmentRef {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** Connected environments whose `prism` flag is on, in catalog order. */
export function selectPrismEnvironments(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly connection: { readonly phase: string };
  }>,
  capabilitiesOf: (
    environmentId: EnvironmentId,
  ) => Pick<ExecutionEnvironmentCapabilities, "forkFlags"> | null | undefined,
): ReadonlyArray<PrismEnvironmentRef> {
  return environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        readForkFlag(capabilitiesOf(environment.environmentId), "prism"),
    )
    .map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
    }));
}

/** The calm explanation the screen shows when no connected environment has the flag on. */
export const PRISM_OFF_HINT = `Prism is off. Set ${envVarForFlag("prism")}=1 or flags.prism in ${FORK_CONFIG_FILENAME} on the server, restart it, and this screen fills in.`;

// Status

export const PRISM_STATE_LABELS: Readonly<Record<PrismState, string>> = {
  off: "Off",
  starting: "Starting",
  ready: "Ready",
  failed: "Failed",
};

export function prismStateTone(state: PrismState): StatusTone {
  switch (state) {
    case "ready":
      return {
        label: PRISM_STATE_LABELS.ready,
        pillClassName: "bg-adaptive-emerald-500-a12-a16",
        textClassName: "text-adaptive-emerald-700-300",
      };
    case "starting":
      return {
        label: PRISM_STATE_LABELS.starting,
        pillClassName: "bg-adaptive-amber-500-a12-a16",
        textClassName: "text-adaptive-amber-700-300",
      };
    case "failed":
      return {
        label: PRISM_STATE_LABELS.failed,
        pillClassName: "bg-adaptive-rose-500-a12-a16",
        textClassName: "text-adaptive-rose-700-300",
      };
    case "off":
      return {
        label: PRISM_STATE_LABELS.off,
        pillClassName: "bg-adaptive-neutral-500-a10-a16",
        textClassName: "text-adaptive-neutral-600-300",
      };
  }
}

export interface PrismStatusLine {
  readonly label: string;
  readonly value: string;
}

/** "CLIProxyAPI v7.2.147 (bundled)": the engine behind Prism, named only here. */
export function describePrismEngine(status: Pick<PrismStatus, "mode" | "version">): string {
  const release = status.version ? ` v${status.version}` : "";
  return `CLIProxyAPI${release} (${status.mode === "external" ? "external" : "bundled"})`;
}

/**
 * The key/value rows under the state pill. `relative` renders an ISO
 * timestamp as "5m" so the caller controls the clock.
 */
export function describePrismStatus(
  status: PrismStatus,
  relative: (iso: string) => string,
): ReadonlyArray<PrismStatusLine> {
  const lines: Array<PrismStatusLine> = [
    { label: "Mode", value: status.mode === "external" ? "External" : "Sidecar" },
    { label: "Base URL", value: status.baseUrl ?? `port ${status.port}` },
  ];
  lines.push({ label: "Engine", value: describePrismEngine(status) });
  if (status.since) lines.push({ label: "Since", value: `${relative(status.since)} ago` });
  if (status.restarts !== undefined) {
    lines.push({ label: "Restarts", value: String(status.restarts) });
  }
  if (status.lastError) lines.push({ label: "Last error", value: status.lastError });
  const sync: Array<string> = [status.role];
  if (status.lastSyncAt) sync.push(`synced ${relative(status.lastSyncAt)} ago`);
  if (status.lastSyncError) sync.push(`error: ${status.lastSyncError}`);
  lines.push({ label: "Sync", value: sync.join(" · ") });
  return lines;
}

// Usage source

/** `usageSource` arrived after the first release; a status without it means the default, on. */
export function isPrismUsageSourceOn(status: Pick<PrismStatus, "usageSource"> | null): boolean {
  return status?.usageSource ?? true;
}

export const PRISM_USAGE_SOURCE_LABEL = "Show pooled accounts on Usage → Limits";

export interface PrismUsageSourceState {
  /** What the switch shows: the optimistic value while a save is in flight, else the server's. `null` until the status arrived. */
  readonly enabled: boolean | null;
  /** The server's value to fall back to while a save is in flight; `null` when idle. */
  readonly rollback: boolean | null;
  /** Why the last save failed; cleared on the next attempt. */
  readonly error: string | null;
}

export const INITIAL_USAGE_SOURCE_STATE: PrismUsageSourceState = {
  enabled: null,
  rollback: null,
  error: null,
};

export type PrismUsageSourceEvent =
  /** Any status load; ignored while a save is in flight so a stale poll cannot undo the optimistic value. */
  | { readonly type: "status"; readonly status: PrismStatus }
  | { readonly type: "toggle"; readonly enabled: boolean }
  | { readonly type: "saved"; readonly status: PrismStatus }
  | { readonly type: "saveFailed"; readonly error: string };

export function reducePrismUsageSource(
  state: PrismUsageSourceState,
  event: PrismUsageSourceEvent,
): PrismUsageSourceState {
  switch (event.type) {
    case "status":
      if (state.rollback !== null) return state;
      return { ...state, enabled: isPrismUsageSourceOn(event.status) };
    case "toggle": {
      if (state.enabled === null || state.rollback !== null || state.enabled === event.enabled) {
        return state;
      }
      return { enabled: event.enabled, rollback: state.enabled, error: null };
    }
    case "saved":
      return { enabled: isPrismUsageSourceOn(event.status), rollback: null, error: null };
    case "saveFailed":
      if (state.rollback === null) return state;
      return { enabled: state.rollback, rollback: null, error: event.error };
  }
}

// Errors

/** What a call resolved to when it did not succeed; `UnknownError` is a defect the runtime rejected with. */
export type PrismCallError = PrismClientError | { readonly _tag: "UnknownError" };

export const ADMIN_ACCESS_REQUIRED = "Administrative access required";

export function isPrismPermissionError(error: PrismCallError): boolean {
  return (
    error._tag === "EnvironmentScopeRequiredError" || error._tag === "EnvironmentAuthInvalidError"
  );
}

export function describePrismUnavailable(
  reason: PrismUnavailableReason,
  state: PrismState,
): string {
  switch (reason) {
    case "flag-off":
      return PRISM_OFF_HINT;
    case "sidecar-not-ready":
      return state === "failed"
        ? `Prism failed to start. Check the server log and the prism section of ${FORK_CONFIG_FILENAME}.`
        : `Prism is ${PRISM_STATE_LABELS[state].toLowerCase()}. Accounts appear once it is ready.`;
    case "replica-read-only":
      return "Manage pooled accounts on the primary environment. This gateway receives serving credentials only.";
    case "sync-not-configured":
      return `Cross-machine sync is not configured for this role. Set prism.sync in ${FORK_CONFIG_FILENAME}.`;
  }
}

/** Inline text for a failed call. Never includes a token or a management secret. */
export function describePrismError(error: PrismCallError): string {
  switch (error._tag) {
    case "PrismUnavailableError":
      return describePrismUnavailable(error.reason, error.state);
    case "PrismUpstreamError":
      return `Prism answered ${error.status}: ${error.message}`;
    case "PrismNotFoundError":
    case "PrismConfigError":
    case "PrismSyncFailedError":
      return error.message;
    case "EnvironmentScopeRequiredError":
      return `${ADMIN_ACCESS_REQUIRED} (${error.requiredScope ?? "access:write"} scope).`;
    case "EnvironmentAuthInvalidError":
      return `${ADMIN_ACCESS_REQUIRED}: this environment session is no longer valid. Pair again.`;
    case "UnknownError":
      return "The request failed unexpectedly.";
    default:
      return "Could not reach the environment.";
  }
}

// Accounts

/** Sidecar provider keys are lowercase words; show the ones we know by name. */
const ACCOUNT_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  claude: "Claude",
  anthropic: "Claude",
  codex: "Codex",
  openai: "Codex",
  gemini: "Gemini",
  antigravity: "Antigravity",
  xai: "Grok",
  grok: "Grok",
  kimi: "Kimi",
};

export function labelPrismProvider(provider: string): string {
  return ACCOUNT_PROVIDER_LABELS[provider.toLowerCase()] ?? provider;
}

/** The subtitle under an account's name: provider, weight, age, and counters when the sidecar reports them. */
export function describePrismAccount(
  account: PrismAccount,
  relative: (iso: string) => string,
): string {
  const parts = [labelPrismProvider(account.provider)];
  if (account.weight !== undefined) parts.push(`weight ${account.weight}`);
  parts.push(relative(account.updatedAt));
  if (account.usage) parts.push(`${account.usage.success} ok · ${account.usage.failed} failed`);
  return parts.join(" · ");
}

type PendingAccountOperation =
  | { readonly _tag: "toggle"; readonly previousDisabled: boolean }
  | { readonly _tag: "remove" };

export interface PrismAccountsState {
  /** `null` until the first list arrives; the list survives later load failures. */
  readonly accounts: ReadonlyArray<PrismAccount> | null;
  /** Why the last load failed, shown above whatever list is still there. */
  readonly error: string | null;
  /** In-flight per-account operations; a toggle remembers what to roll back to. */
  readonly pending: Readonly<Record<string, PendingAccountOperation>>;
  /** The last failed operation per account; cleared on the next attempt. */
  readonly rowErrors: Readonly<Record<string, string>>;
}

export const INITIAL_ACCOUNTS_STATE: PrismAccountsState = {
  accounts: null,
  error: null,
  pending: {},
  rowErrors: {},
};

export type PrismAccountsEvent =
  | { readonly type: "loaded"; readonly accounts: ReadonlyArray<PrismAccount> }
  | { readonly type: "loadFailed"; readonly error: string }
  | { readonly type: "toggle"; readonly id: string; readonly disabled: boolean }
  | { readonly type: "toggled"; readonly id: string; readonly account: PrismAccount }
  | { readonly type: "toggleFailed"; readonly id: string; readonly error: string }
  | { readonly type: "remove"; readonly id: string }
  | { readonly type: "removed"; readonly id: string }
  | { readonly type: "removeFailed"; readonly id: string; readonly error: string };

const without = <V>(record: Readonly<Record<string, V>>, key: string): Record<string, V> => {
  const { [key]: _dropped, ...rest } = record;
  return rest;
};

const replaceAccount = (
  accounts: ReadonlyArray<PrismAccount>,
  id: string,
  update: (account: PrismAccount) => PrismAccount,
): ReadonlyArray<PrismAccount> =>
  accounts.map((account) => (account.id === id ? update(account) : account));

export function reducePrismAccounts(
  state: PrismAccountsState,
  event: PrismAccountsEvent,
): PrismAccountsState {
  switch (event.type) {
    case "loaded": {
      // A list fetched while a toggle is in flight may predate it; keep the optimistic value.
      const accounts = event.accounts.map((account) => {
        const pending = state.pending[account.id];
        return pending?._tag === "toggle" && account.disabled === pending.previousDisabled
          ? { ...account, disabled: !pending.previousDisabled }
          : account;
      });
      return { ...state, accounts, error: null };
    }
    case "loadFailed":
      return { ...state, error: event.error };
    case "toggle": {
      const current = state.accounts?.find((account) => account.id === event.id);
      if (!current || state.pending[event.id] || current.disabled === event.disabled) return state;
      return {
        ...state,
        accounts: replaceAccount(state.accounts ?? [], event.id, (account) => ({
          ...account,
          disabled: event.disabled,
        })),
        pending: {
          ...state.pending,
          [event.id]: { _tag: "toggle", previousDisabled: current.disabled },
        },
        rowErrors: without(state.rowErrors, event.id),
      };
    }
    case "toggled":
      if (state.pending[event.id]?._tag !== "toggle") return state;
      return {
        ...state,
        accounts: replaceAccount(state.accounts ?? [], event.id, () => event.account),
        pending: without(state.pending, event.id),
      };
    case "toggleFailed": {
      const pending = state.pending[event.id];
      if (pending?._tag !== "toggle") return state;
      return {
        ...state,
        accounts: replaceAccount(state.accounts ?? [], event.id, (account) => ({
          ...account,
          disabled: pending.previousDisabled,
        })),
        pending: without(state.pending, event.id),
        rowErrors: { ...state.rowErrors, [event.id]: event.error },
      };
    }
    case "remove":
      if (state.pending[event.id]) return state;
      return {
        ...state,
        pending: { ...state.pending, [event.id]: { _tag: "remove" } },
        rowErrors: without(state.rowErrors, event.id),
      };
    case "removed":
      return {
        ...state,
        accounts: (state.accounts ?? []).filter((account) => account.id !== event.id),
        pending: without(state.pending, event.id),
        rowErrors: without(state.rowErrors, event.id),
      };
    case "removeFailed":
      if (state.pending[event.id]?._tag !== "remove") return state;
      return {
        ...state,
        pending: without(state.pending, event.id),
        rowErrors: { ...state.rowErrors, [event.id]: event.error },
      };
  }
}

// Add account

export const PRISM_LOGIN_PROVIDERS: ReadonlyArray<{
  readonly value: PrismLoginProvider;
  readonly label: string;
}> = [
  { value: "codex", label: "Codex" },
  { value: "anthropic", label: "Claude" },
  { value: "antigravity", label: "Antigravity" },
  { value: "xai", label: "Grok" },
  { value: "kimi", label: "Kimi" },
];

export function labelPrismLoginProvider(provider: PrismLoginProvider): string {
  return PRISM_LOGIN_PROVIDERS.find((entry) => entry.value === provider)?.label ?? provider;
}

export type PrismLoginFlowState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "starting"; readonly provider: PrismLoginProvider }
  | {
      readonly _tag: "pending";
      readonly provider: PrismLoginProvider;
      readonly sessionId: string;
      readonly authUrl: string;
      readonly flow: PrismLoginStarted["flow"];
      readonly userCode: string | null;
      /** A pasted redirect URL is in flight; polling keeps going meanwhile. */
      readonly submittingRedirect: boolean;
      /** The last pasted redirect the sidecar rejected; cleared on the next paste. */
      readonly redirectError: string | null;
    }
  | {
      readonly _tag: "completed";
      readonly provider: PrismLoginProvider;
      readonly accountId: string | null;
    }
  | { readonly _tag: "failed"; readonly provider: PrismLoginProvider; readonly error: string }
  | { readonly _tag: "cancelled"; readonly provider: PrismLoginProvider };

export type PrismLoginFlowEvent =
  | { readonly type: "start"; readonly provider: PrismLoginProvider }
  | { readonly type: "started"; readonly started: PrismLoginStarted }
  | { readonly type: "startFailed"; readonly error: string }
  /** A poll, callback, or cancel answer. Answers for another session are ignored. */
  | { readonly type: "status"; readonly status: PrismLoginStatus }
  | { readonly type: "pasteRedirect" }
  | { readonly type: "redirectFailed"; readonly sessionId: string; readonly error: string }
  | { readonly type: "cancel" }
  | { readonly type: "reset" };

export const IDLE_LOGIN_FLOW: PrismLoginFlowState = { _tag: "idle" };

const GENERIC_LOGIN_FAILURE = "The sign-in did not complete.";

export function reducePrismLoginFlow(
  state: PrismLoginFlowState,
  event: PrismLoginFlowEvent,
): PrismLoginFlowState {
  switch (event.type) {
    case "start":
      // A flow already waiting on the browser keeps its session; cancel first.
      if (state._tag === "starting" || state._tag === "pending") return state;
      return { _tag: "starting", provider: event.provider };
    case "started":
      if (state._tag !== "starting") return state;
      return {
        _tag: "pending",
        provider: state.provider,
        sessionId: event.started.sessionId,
        authUrl: event.started.authUrl,
        flow: event.started.flow,
        userCode: event.started.userCode ?? null,
        submittingRedirect: false,
        redirectError: null,
      };
    case "startFailed":
      if (state._tag !== "starting") return state;
      return { _tag: "failed", provider: state.provider, error: event.error };
    case "status": {
      if (state._tag !== "pending" || state.sessionId !== event.status.sessionId) return state;
      switch (event.status.status) {
        case "pending":
          return state.submittingRedirect ? { ...state, submittingRedirect: false } : state;
        case "completed":
          return {
            _tag: "completed",
            provider: state.provider,
            accountId: event.status.accountId ?? null,
          };
        case "failed":
          return {
            _tag: "failed",
            provider: state.provider,
            error: event.status.error ?? GENERIC_LOGIN_FAILURE,
          };
        case "cancelled":
          return { _tag: "cancelled", provider: state.provider };
      }
      return state;
    }
    case "pasteRedirect":
      if (state._tag !== "pending" || state.submittingRedirect) return state;
      return { ...state, submittingRedirect: true, redirectError: null };
    case "redirectFailed":
      if (state._tag !== "pending" || state.sessionId !== event.sessionId) return state;
      return { ...state, submittingRedirect: false, redirectError: event.error };
    case "cancel":
      // Optimistic: polling stops at once, and a late "cancelled" answer for
      // the old session is dropped by the session check above.
      if (state._tag !== "pending" && state._tag !== "starting") return state;
      return { _tag: "cancelled", provider: state.provider };
    case "reset":
      return IDLE_LOGIN_FLOW;
  }
}

/** The session the screen should keep polling, if any. */
export function pendingPrismLoginSession(state: PrismLoginFlowState): string | null {
  return state._tag === "pending" ? state.sessionId : null;
}

// Routing

export const PRISM_ROUTING_OPTIONS: ReadonlyArray<{
  readonly value: PrismRoutingStrategy;
  readonly label: string;
}> = [
  { value: "round-robin", label: "Round robin" },
  { value: "weighted-round-robin", label: "Weighted" },
  { value: "fill-first", label: "Fill first" },
];

// Polling

export const PRISM_STATUS_POLL_MS = 10_000;
export const PRISM_LOGIN_POLL_MS = 2_000;
export const PRISM_RESTART_POLL_MS = 2_000;
export const PRISM_RESTART_TIMEOUT_MS = 30_000;

/** Background status polling only costs a request while someone can see the answer. */
export function shouldPollPrismStatus(input: {
  readonly focused: boolean;
  readonly appState: string;
}): boolean {
  return input.focused && input.appState === "active";
}

/** After a restart: keep polling until the proxy settles, or give up at the deadline. */
export function nextRestartStep(input: {
  readonly state: PrismState;
  readonly elapsedMs: number;
}): "settled" | "poll" | "timeout" {
  if (input.state === "ready" || input.state === "failed") return "settled";
  return input.elapsedMs >= PRISM_RESTART_TIMEOUT_MS ? "timeout" : "poll";
}

// Settings row

export type PrismOverview =
  | { readonly _tag: "loading" }
  | { readonly _tag: "error" }
  | {
      readonly _tag: "loaded";
      readonly state: PrismState;
      /** `null` when the list could not be fetched (proxy not ready, no scope). */
      readonly accountCount: number | null;
    };

/**
 * The trailing value of the "Accounts" row: the pooled count once every
 * environment answered, else the state that explains why there is no count.
 * `undefined` keeps the row's value slot empty while answers are still coming.
 */
export function summarizePrismOverviews(
  overviews: ReadonlyArray<PrismOverview>,
): string | undefined {
  if (overviews.length === 0 || overviews.some((overview) => overview._tag === "loading")) {
    return undefined;
  }
  const loaded = overviews.filter(
    (overview): overview is Extract<PrismOverview, { _tag: "loaded" }> =>
      overview._tag === "loaded",
  );
  const counted = loaded.filter((overview) => overview.accountCount !== null);
  if (counted.length > 0) {
    const total = counted.reduce((sum, overview) => sum + (overview.accountCount ?? 0), 0);
    return total === 1 ? "1 account" : `${total} accounts`;
  }
  const notReady = loaded.find((overview) => overview.state !== "ready");
  if (notReady) return PRISM_STATE_LABELS[notReady.state];
  return loaded.length > 0 ? "Unavailable" : "Unreachable";
}

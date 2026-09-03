/**
 * Pure state for the Prism settings tab: the "Add account" login flow and the
 * accounts list (optimistic edits with rollback) as reducers, plus the label
 * helpers the tab and the mobile card render from. No React, no network; the
 * tab wires these to `@t3tools/client-runtime/fork`.
 */
import type {
  CliProxyAccount,
  CliProxyAccountPatch,
  CliProxyAccountUsage,
  CliProxyLoginProvider,
  CliProxyLoginStarted,
  CliProxyLoginStatus,
  CliProxyState,
  CliProxyStatus,
  CliProxyUnavailableReason,
} from "@q1code/core/cliproxyApi";
import { type CliProxyMode, FORK_CONFIG_FILENAME } from "@q1code/core/config";
import { envVarForFlag } from "@q1code/core/flags";

import { formatElapsedDurationLabel } from "~/timestampFormat";

export const CLIPROXY_LOGIN_PROVIDERS: ReadonlyArray<CliProxyLoginProvider> = [
  "codex",
  "anthropic",
  "antigravity",
  "xai",
  "kimi",
];

export const CLIPROXY_LOGIN_PROVIDER_LABELS: Readonly<Record<CliProxyLoginProvider, string>> = {
  codex: "Codex (OpenAI)",
  anthropic: "Anthropic (Claude)",
  antigravity: "Antigravity (Google)",
  xai: "xAI (Grok)",
  kimi: "Kimi (Moonshot)",
};

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

export function labelCliProxyProvider(provider: string): string {
  return ACCOUNT_PROVIDER_LABELS[provider.toLowerCase()] ?? provider;
}

export type CliProxyLoginFlowState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "starting"; readonly provider: CliProxyLoginProvider }
  | {
      readonly _tag: "pending";
      readonly provider: CliProxyLoginProvider;
      readonly sessionId: string;
      readonly authUrl: string;
      readonly flow: CliProxyLoginStarted["flow"];
      readonly userCode: string | null;
      /** A pasted redirect URL is in flight; polling keeps going meanwhile. */
      readonly submittingRedirect: boolean;
      /** The last pasted redirect the sidecar rejected; cleared on the next paste. */
      readonly redirectError: string | null;
    }
  | {
      readonly _tag: "completed";
      readonly provider: CliProxyLoginProvider;
      readonly accountId: string | null;
    }
  | { readonly _tag: "failed"; readonly provider: CliProxyLoginProvider; readonly error: string }
  | { readonly _tag: "cancelled"; readonly provider: CliProxyLoginProvider };

export type CliProxyLoginFlowEvent =
  | { readonly type: "start"; readonly provider: CliProxyLoginProvider }
  | { readonly type: "started"; readonly started: CliProxyLoginStarted }
  | { readonly type: "startFailed"; readonly error: string }
  /** A poll, callback, or cancel answer. Answers for another session are ignored. */
  | { readonly type: "status"; readonly status: CliProxyLoginStatus }
  | { readonly type: "pasteRedirect" }
  | { readonly type: "redirectFailed"; readonly sessionId: string; readonly error: string }
  | { readonly type: "cancel" }
  | { readonly type: "reset" };

export const IDLE_LOGIN_FLOW: CliProxyLoginFlowState = { _tag: "idle" };

const GENERIC_LOGIN_FAILURE = "The sign-in did not complete.";

export function reduceCliProxyLoginFlow(
  state: CliProxyLoginFlowState,
  event: CliProxyLoginFlowEvent,
): CliProxyLoginFlowState {
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
      // Optimistic: the section stops polling at once, and a late "cancelled"
      // answer for the old session is dropped by the session check above.
      if (state._tag !== "pending" && state._tag !== "starting") return state;
      return { _tag: "cancelled", provider: state.provider };
    case "reset":
      return IDLE_LOGIN_FLOW;
  }
}

/** The session the section should keep polling, if any. */
export function pendingCliProxyLoginSession(state: CliProxyLoginFlowState): string | null {
  return state._tag === "pending" ? state.sessionId : null;
}

export const CLIPROXY_STATE_LABELS: Readonly<Record<CliProxyState, string>> = {
  off: "Off",
  starting: "Starting",
  ready: "Ready",
  failed: "Failed",
};

export function describeCliProxyUnavailable(
  reason: CliProxyUnavailableReason,
  state: CliProxyState,
): string {
  switch (reason) {
    case "flag-off":
      return `The cliproxy feature is off. Set ${envVarForFlag("cliproxy")}=1 or flags.cliproxy in ${FORK_CONFIG_FILENAME}, then restart the server.`;
    case "sidecar-not-ready":
      return state === "failed"
        ? `CLIProxyAPI failed to start. Check the server log and the cliproxy section of ${FORK_CONFIG_FILENAME} (binaryPath, port).`
        : `CLIProxyAPI is ${CLIPROXY_STATE_LABELS[state].toLowerCase()}. Accounts appear once the sidecar is ready.`;
    case "sync-not-configured":
      return `Cross-machine sync is not configured for this role. Set cliproxy.sync in ${FORK_CONFIG_FILENAME}.`;
  }
}

/**
 * Text for a permission failure, phrased like the other settings sections:
 * name the scope, never the token.
 */
export function describeCliProxyPermissionError(input: {
  readonly _tag: "EnvironmentScopeRequiredError" | "EnvironmentAuthInvalidError";
  readonly requiredScope?: string;
}): string {
  return input._tag === "EnvironmentScopeRequiredError"
    ? `Managing accounts requires the ${input.requiredScope ?? "access:write"} scope for this backend.`
    : "This environment session is no longer valid. Refresh the page or pair again.";
}

/**
 * Weight input: integer at or above zero; `null` when unchanged or invalid so
 * the caller can drop the edit instead of sending it.
 */
export function parseCliProxyWeight(raw: string, current: number | undefined): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value === current) return null;
  return value;
}

/**
 * Usage rows are keyed `<baseUrl>|<apiKey>` by the sidecar. Only the base URL
 * part is ever shown; a key with no separator is an API key on its own and
 * renders as a generic label.
 */
/** Tooltip for the requests column: the sidecar's quota signals, or nothing when it observed none. */
export function describeCliProxyAccountQuota(
  usage: CliProxyAccountUsage | undefined,
): string | undefined {
  const quota = usage?.quota;
  if (quota === undefined) return undefined;
  const signals = Object.entries(quota.signals).map(([key, value]) => `${key}: ${value}`);
  return signals.length === 0 ? undefined : `Quota ${signals.join(", ")}`;
}

export function labelCliProxyUsageCredential(key: string, index: number): string {
  const separator = key.indexOf("|");
  const baseUrl = separator === -1 ? "" : key.slice(0, separator).trim();
  return baseUrl.length > 0 ? baseUrl : `API key ${index + 1}`;
}

export interface CliProxyUsageRow {
  /** Stable render key: provider plus the credential's position. */
  readonly id: string;
  readonly provider: string;
  readonly credential: string;
  readonly success: number;
  readonly failed: number;
}

export function flattenCliProxyUsage(
  usage: Readonly<
    Record<string, Readonly<Record<string, { readonly success: number; readonly failed: number }>>>
  >,
): ReadonlyArray<CliProxyUsageRow> {
  const rows: Array<CliProxyUsageRow> = [];
  for (const [provider, credentials] of Object.entries(usage)) {
    Object.entries(credentials).forEach(([key, entry], index) => {
      rows.push({
        id: `${provider}:${index}`,
        provider,
        credential: labelCliProxyUsageCredential(key, index),
        success: entry.success,
        failed: entry.failed,
      });
    });
  }
  return rows;
}

export const CLIPROXY_MODE_LABELS: Readonly<Record<CliProxyMode, string>> = {
  sidecar: "Sidecar",
  external: "External",
};

/** Servers older than the `mode` field run the bundled sidecar. */
export function resolveCliProxyMode(status: Pick<CliProxyStatus, "mode">): CliProxyMode {
  return status.mode ?? "sidecar";
}

export function describeCliProxyMode(mode: CliProxyMode): string {
  switch (mode) {
    case "sidecar":
      return "q1code starts the bundled CLIProxyAPI on the primary environment and supervises it; restart stops and relaunches it.";
    case "external":
      return "q1code manages a proxy something else runs; restart re-checks the connection.";
  }
}

/** Confirm-dialog text for the Restart button. */
export function describeCliProxyRestart(mode: CliProxyMode): string {
  return mode === "external"
    ? "Re-check the connection to the external proxy? Accounts and routing reload once it answers."
    : "Restart the Prism sidecar? Claude and Codex instances routed through it fail requests until it is ready again.";
}

/** "for 3m" after `since`, "just now" right after a state change, `null` without a usable timestamp. */
export function formatCliProxySince(since: string | undefined, nowMs: number): string | null {
  if (since === undefined) return null;
  const elapsed = formatElapsedDurationLabel(since, nowMs);
  if (elapsed === "") return null;
  return elapsed === "just now" ? elapsed : `for ${elapsed}`;
}

/** One line under the state badge: "Ready for 3m · 2 restarts". */
export function summarizeCliProxyStatus(
  status: Pick<CliProxyStatus, "state" | "since" | "restarts">,
  nowMs: number,
): string {
  const label = CLIPROXY_STATE_LABELS[status.state];
  const since = formatCliProxySince(status.since, nowMs);
  const parts = [since === null ? label : `${label} ${since}`];
  if (status.restarts !== undefined && status.restarts > 0) {
    parts.push(`${status.restarts} restart${status.restarts === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

/** Sync interval as people configure it: whole minutes when even, seconds otherwise. */
export function formatCliProxySyncInterval(seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `every ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `every ${seconds} second${seconds === 1 ? "" : "s"}`;
}

export interface CliProxyAccountsState {
  /** `null` until the first list arrives, so the table can tell "loading" from "empty". */
  readonly accounts: ReadonlyArray<CliProxyAccount> | null;
  /** Rows with a mutation in flight, keyed by id, holding the row as it was before the optimistic change. */
  readonly pending: ReadonlyMap<string, CliProxyAccount>;
}

export type CliProxyAccountsEvent =
  | { readonly type: "loaded"; readonly accounts: ReadonlyArray<CliProxyAccount> }
  /** Applies the patch to the row at once; `patchFailed` puts the old row back. */
  | { readonly type: "patchStarted"; readonly id: string; readonly patch: CliProxyAccountPatch }
  | { readonly type: "patchSucceeded"; readonly id: string; readonly account: CliProxyAccount }
  | { readonly type: "patchFailed"; readonly id: string }
  /** The row stays visible but inert until the server confirms; nothing to roll back. */
  | { readonly type: "deleteStarted"; readonly id: string }
  | { readonly type: "deleteSucceeded"; readonly id: string }
  | { readonly type: "deleteFailed"; readonly id: string };

export const INITIAL_CLIPROXY_ACCOUNTS: CliProxyAccountsState = {
  accounts: null,
  pending: new Map(),
};

function withoutPending(
  pending: CliProxyAccountsState["pending"],
  id: string,
): CliProxyAccountsState["pending"] {
  if (!pending.has(id)) return pending;
  const next = new Map(pending);
  next.delete(id);
  return next;
}

function replaceAccount(
  accounts: ReadonlyArray<CliProxyAccount>,
  account: CliProxyAccount,
): ReadonlyArray<CliProxyAccount> {
  return accounts.map((entry) => (entry.id === account.id ? account : entry));
}

export function reduceCliProxyAccounts(
  state: CliProxyAccountsState,
  event: CliProxyAccountsEvent,
): CliProxyAccountsState {
  switch (event.type) {
    case "loaded":
      return { ...state, accounts: event.accounts };
    case "patchStarted": {
      const current = state.accounts?.find((entry) => entry.id === event.id);
      // One mutation per row at a time; the row's controls are disabled meanwhile.
      if (current === undefined || state.pending.has(event.id)) return state;
      const optimistic: CliProxyAccount = {
        ...current,
        ...(event.patch.disabled === undefined ? {} : { disabled: event.patch.disabled }),
        ...(event.patch.weight === undefined ? {} : { weight: event.patch.weight }),
      };
      return {
        accounts: replaceAccount(state.accounts ?? [], optimistic),
        pending: new Map(state.pending).set(event.id, current),
      };
    }
    case "patchSucceeded":
      return {
        accounts: state.accounts === null ? null : replaceAccount(state.accounts, event.account),
        pending: withoutPending(state.pending, event.id),
      };
    case "patchFailed": {
      const snapshot = state.pending.get(event.id);
      return {
        accounts:
          state.accounts === null || snapshot === undefined
            ? state.accounts
            : replaceAccount(state.accounts, snapshot),
        pending: withoutPending(state.pending, event.id),
      };
    }
    case "deleteStarted": {
      const current = state.accounts?.find((entry) => entry.id === event.id);
      if (current === undefined || state.pending.has(event.id)) return state;
      return { ...state, pending: new Map(state.pending).set(event.id, current) };
    }
    case "deleteSucceeded":
      return {
        accounts: state.accounts?.filter((entry) => entry.id !== event.id) ?? null,
        pending: withoutPending(state.pending, event.id),
      };
    case "deleteFailed":
      return { ...state, pending: withoutPending(state.pending, event.id) };
  }
}

export function isCliProxyAccountPending(state: CliProxyAccountsState, id: string): boolean {
  return state.pending.has(id);
}

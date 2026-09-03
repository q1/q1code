/**
 * Pure state for the Accounts (CLIProxyAPI) settings section: the "Add
 * account" login flow as a reducer, plus the label helpers the section and the
 * mobile card render from. No React, no network; the section wires these to
 * `@t3tools/client-runtime/fork`.
 */
import type {
  CliProxyLoginProvider,
  CliProxyLoginStarted,
  CliProxyLoginStatus,
  CliProxyState,
  CliProxyUnavailableReason,
} from "@q1code/core/cliproxyApi";
import { FORK_CONFIG_FILENAME } from "@q1code/core/config";
import { envVarForFlag } from "@q1code/core/flags";

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

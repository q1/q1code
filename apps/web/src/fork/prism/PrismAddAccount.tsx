import type { PrismLoginProvider } from "@q1code/core/prismApi";
import { useEffect, useReducer, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";
import { cn } from "~/lib/utils";

import {
  PRISM_LOGIN_PROVIDER_LABELS,
  PRISM_LOGIN_PROVIDERS,
  IDLE_LOGIN_FLOW,
  pendingPrismLoginSession,
  reducePrismLoginFlow,
} from "./prismAccountsState";
import { CopyValueButton, openExternalUrl, reportPrismError } from "./prismUi";
import { type PrismApi, describePrismCallError } from "./usePrismApi";

const LOGIN_POLL_MS = 2_000;

/**
 * The OAuth sign-in flow. The reducer owns the transitions; effects only poll
 * and hand a finished sign-in to the parent through `onCompleted`.
 */
export function PrismAddAccountSection({
  api,
  writable,
  onCompleted,
}: {
  readonly api: PrismApi | null;
  /** The accounts list loaded, so a new sign-in has somewhere to land. */
  readonly writable: boolean;
  /** Called once per completed sign-in with the new account id when the sidecar reports it. Keep it stable. */
  readonly onCompleted: (accountId: string | null) => void;
}) {
  const [flow, dispatch] = useReducer(reducePrismLoginFlow, IDLE_LOGIN_FLOW);
  const [provider, setProvider] = useState<PrismLoginProvider>("codex");
  const [redirectDraft, setRedirectDraft] = useState("");
  const pendingSession = pendingPrismLoginSession(flow);

  useEffect(() => {
    if (pendingSession === null || api === null) return;
    let cancelled = false;
    const poll = async () => {
      const result = await api.loginStatus(pendingSession);
      if (cancelled) return;
      if (result._tag === "ok") {
        dispatch({ type: "status", status: result.value });
      } else if (result.error._tag === "PrismNotFoundError") {
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
    onCompleted(flow.accountId);
  }, [flow, onCompleted]);

  const startLogin = async () => {
    if (api === null) return;
    dispatch({ type: "start", provider });
    const result = await api.startLogin(provider);
    if (result._tag === "error") {
      dispatch({ type: "startFailed", error: describePrismCallError(result.error) });
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
    if (result._tag === "error" && result.error._tag !== "PrismNotFoundError") {
      reportPrismError("Could not cancel the sign-in", result.error);
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
        error: describePrismCallError(result.error),
      });
      return;
    }
    dispatch({ type: "status", status: result.value });
  };

  const loginBusy = flow._tag === "starting" || flow._tag === "pending";

  return (
    <SettingsSection {...searchableSetting("prism-add-account")}>
      <SettingsRow
        title="Sign in"
        description="Starts an OAuth sign-in on the server. Open the link in any browser; if that browser cannot reach this server, paste the URL it lands on back here."
        control={
          <>
            <Select
              value={provider}
              onValueChange={(value) => setProvider(value as PrismLoginProvider)}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-44"
                aria-label="Provider"
                disabled={loginBusy || !writable}
              >
                <SelectValue>{PRISM_LOGIN_PROVIDER_LABELS[provider]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {PRISM_LOGIN_PROVIDERS.map((entry) => (
                  <SelectItem key={entry} hideIndicator value={entry}>
                    {PRISM_LOGIN_PROVIDER_LABELS[entry]}
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
                Finish signing in to {PRISM_LOGIN_PROVIDER_LABELS[flow.provider]}
              </p>
              <div className="flex min-w-0 items-center gap-1">
                <a
                  href={flow.authUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 truncate font-mono text-primary underline-offset-4 hover:underline"
                  onClick={(event) => {
                    event.preventDefault();
                    openExternalUrl(flow.authUrl);
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
                <label className="text-muted-foreground" htmlFor="prism-login-redirect-url">
                  Signed in from another machine? Paste the redirect URL the browser landed on.
                </label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="prism-login-redirect-url"
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
            text={`Signed in to ${PRISM_LOGIN_PROVIDER_LABELS[flow.provider]}${flow.accountId ? ` as ${flow.accountId}` : ""}.`}
            onDismiss={() => dispatch({ type: "reset" })}
          />
        ) : flow._tag === "failed" ? (
          <FlowNotice
            tone="error"
            text={`Sign-in to ${PRISM_LOGIN_PROVIDER_LABELS[flow.provider]} failed: ${flow.error}`}
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
    </SettingsSection>
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

import { describe, expect, it } from "vite-plus/test";

import type { CliProxyAccount } from "@q1code/core/cliproxyApi";

import {
  IDLE_LOGIN_FLOW,
  INITIAL_CLIPROXY_ACCOUNTS,
  type CliProxyLoginFlowState,
  describeCliProxyMode,
  describeCliProxyRestart,
  describeCliProxyUnavailable,
  describeCliProxyAccountQuota,
  flattenCliProxyUsage,
  formatCliProxySince,
  formatCliProxySyncInterval,
  isCliProxyAccountPending,
  labelCliProxyUsageCredential,
  parseCliProxyWeight,
  pendingCliProxyLoginSession,
  reduceCliProxyAccounts,
  reduceCliProxyLoginFlow,
  resolveCliProxyMode,
  summarizeCliProxyStatus,
} from "./cliproxyAccountsState.ts";

const started = {
  sessionId: "session-1",
  authUrl: "https://auth.example.test/start",
  flow: "redirect" as const,
};

function pending(): CliProxyLoginFlowState {
  return reduceCliProxyLoginFlow(
    reduceCliProxyLoginFlow(IDLE_LOGIN_FLOW, { type: "start", provider: "codex" }),
    { type: "started", started },
  );
}

describe("cliproxy login flow", () => {
  it("walks idle -> starting -> pending -> completed with the new account id", () => {
    const starting = reduceCliProxyLoginFlow(IDLE_LOGIN_FLOW, {
      type: "start",
      provider: "anthropic",
    });
    expect(starting).toEqual({ _tag: "starting", provider: "anthropic" });

    const waiting = reduceCliProxyLoginFlow(starting, {
      type: "started",
      started: { ...started, flow: "device", userCode: "ABCD-EFGH" },
    });
    expect(waiting).toMatchObject({
      _tag: "pending",
      provider: "anthropic",
      sessionId: "session-1",
      flow: "device",
      userCode: "ABCD-EFGH",
      submittingRedirect: false,
    });
    expect(pendingCliProxyLoginSession(waiting)).toBe("session-1");

    const done = reduceCliProxyLoginFlow(waiting, {
      type: "status",
      status: { sessionId: "session-1", status: "completed", accountId: "claude-1.json" },
    });
    expect(done).toEqual({ _tag: "completed", provider: "anthropic", accountId: "claude-1.json" });
    expect(pendingCliProxyLoginSession(done)).toBeNull();
  });

  it("ignores answers for another session", () => {
    const waiting = pending();
    const stale = reduceCliProxyLoginFlow(waiting, {
      type: "status",
      status: { sessionId: "session-0", status: "completed", accountId: "old.json" },
    });
    expect(stale).toBe(waiting);
    expect(
      reduceCliProxyLoginFlow(waiting, {
        type: "redirectFailed",
        sessionId: "session-0",
        error: "nope",
      }),
    ).toBe(waiting);
  });

  it("keeps polling through a pasted redirect and surfaces a rejected one", () => {
    const submitting = reduceCliProxyLoginFlow(pending(), { type: "pasteRedirect" });
    expect(submitting).toMatchObject({ _tag: "pending", submittingRedirect: true });
    expect(pendingCliProxyLoginSession(submitting)).toBe("session-1");

    const stillPending = reduceCliProxyLoginFlow(submitting, {
      type: "status",
      status: { sessionId: "session-1", status: "pending" },
    });
    expect(stillPending).toMatchObject({ _tag: "pending", submittingRedirect: false });

    const rejected = reduceCliProxyLoginFlow(
      reduceCliProxyLoginFlow(stillPending, { type: "pasteRedirect" }),
      { type: "redirectFailed", sessionId: "session-1", error: "state mismatch" },
    );
    expect(rejected).toMatchObject({
      _tag: "pending",
      submittingRedirect: false,
      redirectError: "state mismatch",
    });
    // The next paste clears the old rejection.
    expect(reduceCliProxyLoginFlow(rejected, { type: "pasteRedirect" })).toMatchObject({
      redirectError: null,
      submittingRedirect: true,
    });
  });

  it("maps failed and cancelled answers, defaulting the failure text", () => {
    expect(
      reduceCliProxyLoginFlow(pending(), {
        type: "status",
        status: { sessionId: "session-1", status: "failed" },
      }),
    ).toEqual({ _tag: "failed", provider: "codex", error: "The sign-in did not complete." });
    expect(
      reduceCliProxyLoginFlow(pending(), {
        type: "status",
        status: { sessionId: "session-1", status: "cancelled" },
      }),
    ).toEqual({ _tag: "cancelled", provider: "codex" });
    expect(
      reduceCliProxyLoginFlow(
        { _tag: "starting", provider: "xai" },
        { type: "startFailed", error: "sidecar down" },
      ),
    ).toEqual({ _tag: "failed", provider: "xai", error: "sidecar down" });
  });

  it("cancels optimistically from starting or pending and resets to idle", () => {
    const cancelled = reduceCliProxyLoginFlow(pending(), { type: "cancel" });
    expect(cancelled).toEqual({ _tag: "cancelled", provider: "codex" });
    expect(pendingCliProxyLoginSession(cancelled)).toBeNull();
    expect(
      reduceCliProxyLoginFlow({ _tag: "starting", provider: "kimi" }, { type: "cancel" }),
    ).toEqual({
      _tag: "cancelled",
      provider: "kimi",
    });
    expect(reduceCliProxyLoginFlow(cancelled, { type: "cancel" })).toBe(cancelled);
    expect(reduceCliProxyLoginFlow(cancelled, { type: "reset" })).toBe(IDLE_LOGIN_FLOW);
  });

  it("refuses a second start while one flow is waiting", () => {
    const waiting = pending();
    expect(reduceCliProxyLoginFlow(waiting, { type: "start", provider: "xai" })).toBe(waiting);
    // Terminal states can start over.
    expect(
      reduceCliProxyLoginFlow(
        { _tag: "failed", provider: "codex", error: "x" },
        { type: "start", provider: "xai" },
      ),
    ).toEqual({ _tag: "starting", provider: "xai" });
  });

  it("drops events that do not apply to the current state", () => {
    expect(reduceCliProxyLoginFlow(IDLE_LOGIN_FLOW, { type: "started", started })).toBe(
      IDLE_LOGIN_FLOW,
    );
    expect(reduceCliProxyLoginFlow(IDLE_LOGIN_FLOW, { type: "pasteRedirect" })).toBe(
      IDLE_LOGIN_FLOW,
    );
  });
});

describe("cliproxy label helpers", () => {
  it("explains each unavailable reason with the env/config hint", () => {
    expect(describeCliProxyUnavailable("flag-off", "off")).toContain("T3FORK_CLIPROXY=1");
    expect(describeCliProxyUnavailable("flag-off", "off")).toContain("fork.json");
    expect(describeCliProxyUnavailable("sidecar-not-ready", "starting")).toContain("starting");
    expect(describeCliProxyUnavailable("sidecar-not-ready", "failed")).toContain("failed to start");
    expect(describeCliProxyUnavailable("sync-not-configured", "ready")).toContain("cliproxy.sync");
  });

  it("accepts only changed non-negative integers as weights", () => {
    expect(parseCliProxyWeight("3", 1)).toBe(3);
    expect(parseCliProxyWeight(" 0 ", undefined)).toBe(0);
    expect(parseCliProxyWeight("3", 3)).toBeNull();
    expect(parseCliProxyWeight("-1", 1)).toBeNull();
    expect(parseCliProxyWeight("1.5", 1)).toBeNull();
    expect(parseCliProxyWeight("", 1)).toBeNull();
    expect(parseCliProxyWeight("abc", 1)).toBeNull();
  });

  it("never surfaces the API key part of a usage credential", () => {
    expect(labelCliProxyUsageCredential("https://api.example.test|sk-secret-123", 0)).toBe(
      "https://api.example.test",
    );
    expect(labelCliProxyUsageCredential("sk-secret-123", 2)).toBe("API key 3");
    expect(labelCliProxyUsageCredential("|sk-secret-123", 0)).toBe("API key 1");
    const rows = flattenCliProxyUsage({
      openai: {
        "https://api.openai.com|sk-abc": { success: 4, failed: 1 },
        "sk-only": { success: 0, failed: 2 },
      },
    });
    expect(rows).toEqual([
      {
        id: "openai:0",
        provider: "openai",
        credential: "https://api.openai.com",
        success: 4,
        failed: 1,
      },
      { id: "openai:1", provider: "openai", credential: "API key 2", success: 0, failed: 2 },
    ]);
    expect(JSON.stringify(rows)).not.toContain("sk-");
  });

  it("describes an account's quota signals only when the sidecar observed some", () => {
    expect(describeCliProxyAccountQuota(undefined)).toBeUndefined();
    expect(describeCliProxyAccountQuota({ success: 1, failed: 0 })).toBeUndefined();
    expect(
      describeCliProxyAccountQuota({ success: 1, failed: 0, quota: { signals: {} } }),
    ).toBeUndefined();
    expect(
      describeCliProxyAccountQuota({
        success: 1,
        failed: 0,
        quota: { observedAt: "2026-09-02T00:00:00.000Z", signals: { "5h": "ok", "7d": "low" } },
      }),
    ).toBe("Quota 5h: ok, 7d: low");
  });
});

describe("cliproxy status helpers", () => {
  const nowMs = Date.parse("2026-09-02T12:00:00.000Z");

  it("treats a status without a mode as the sidecar", () => {
    expect(resolveCliProxyMode({})).toBe("sidecar");
    expect(resolveCliProxyMode({ mode: "external" })).toBe("external");
    expect(describeCliProxyMode("external")).toContain("restart re-checks the connection");
    expect(describeCliProxyMode("sidecar")).toContain("relaunches");
    expect(describeCliProxyRestart("sidecar")).toContain("Restart");
    expect(describeCliProxyRestart("external")).toContain("Re-check");
  });

  it("formats since as an elapsed duration and skips it when absent", () => {
    expect(formatCliProxySince(undefined, nowMs)).toBeNull();
    expect(formatCliProxySince("not a date", nowMs)).toBeNull();
    expect(formatCliProxySince("2026-09-02T11:59:59.000Z", nowMs)).toBe("just now");
    expect(formatCliProxySince("2026-09-02T11:57:00.000Z", nowMs)).toBe("for 3m");
    expect(formatCliProxySince("2026-09-01T12:00:00.000Z", nowMs)).toBe("for 1d");
  });

  it("summarizes state, uptime, and restarts on one line", () => {
    expect(summarizeCliProxyStatus({ state: "ready" }, nowMs)).toBe("Ready");
    expect(
      summarizeCliProxyStatus(
        { state: "ready", since: "2026-09-02T11:57:00.000Z", restarts: 0 },
        nowMs,
      ),
    ).toBe("Ready for 3m");
    expect(
      summarizeCliProxyStatus(
        { state: "starting", since: "2026-09-02T11:59:50.000Z", restarts: 1 },
        nowMs,
      ),
    ).toBe("Starting for 10s · 1 restart");
    expect(summarizeCliProxyStatus({ state: "failed", restarts: 4 }, nowMs)).toBe(
      "Failed · 4 restarts",
    );
  });

  it("formats the sync interval in minutes when even", () => {
    expect(formatCliProxySyncInterval(300)).toBe("every 5 minutes");
    expect(formatCliProxySyncInterval(60)).toBe("every 1 minute");
    expect(formatCliProxySyncInterval(90)).toBe("every 90 seconds");
    expect(formatCliProxySyncInterval(1)).toBe("every 1 second");
  });
});

describe("cliproxy accounts reducer", () => {
  const claude: CliProxyAccount = {
    id: "claude-1.json",
    provider: "claude",
    label: "claude-1",
    email: "a@example.test",
    disabled: false,
    weight: 1,
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
  const codex: CliProxyAccount = {
    id: "codex-1.json",
    provider: "codex",
    label: "codex-1",
    disabled: true,
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
  const loaded = reduceCliProxyAccounts(INITIAL_CLIPROXY_ACCOUNTS, {
    type: "loaded",
    accounts: [claude, codex],
  });

  it("starts without a list and takes the first one as is", () => {
    expect(INITIAL_CLIPROXY_ACCOUNTS.accounts).toBeNull();
    expect(loaded.accounts).toEqual([claude, codex]);
    expect(loaded.pending.size).toBe(0);
  });

  it("applies a toggle at once, then keeps the server's row", () => {
    const started = reduceCliProxyAccounts(loaded, {
      type: "patchStarted",
      id: claude.id,
      patch: { disabled: true },
    });
    expect(started.accounts?.[0]).toEqual({ ...claude, disabled: true });
    expect(isCliProxyAccountPending(started, claude.id)).toBe(true);
    expect(isCliProxyAccountPending(started, codex.id)).toBe(false);

    const fromServer = { ...claude, disabled: true, updatedAt: "2026-09-02T00:00:01.000Z" };
    const done = reduceCliProxyAccounts(started, {
      type: "patchSucceeded",
      id: claude.id,
      account: fromServer,
    });
    expect(done.accounts?.[0]).toBe(fromServer);
    expect(isCliProxyAccountPending(done, claude.id)).toBe(false);
  });

  it("rolls a failed patch back to the row it replaced", () => {
    const started = reduceCliProxyAccounts(loaded, {
      type: "patchStarted",
      id: claude.id,
      patch: { weight: 5 },
    });
    expect(started.accounts?.[0]?.weight).toBe(5);
    const rolledBack = reduceCliProxyAccounts(started, { type: "patchFailed", id: claude.id });
    expect(rolledBack.accounts?.[0]).toBe(claude);
    expect(rolledBack.pending.size).toBe(0);
  });

  it("allows one mutation per row at a time and ignores unknown rows", () => {
    const started = reduceCliProxyAccounts(loaded, {
      type: "patchStarted",
      id: claude.id,
      patch: { disabled: true },
    });
    expect(
      reduceCliProxyAccounts(started, {
        type: "patchStarted",
        id: claude.id,
        patch: { disabled: false },
      }),
    ).toBe(started);
    expect(reduceCliProxyAccounts(started, { type: "deleteStarted", id: claude.id })).toBe(started);
    expect(
      reduceCliProxyAccounts(loaded, {
        type: "patchStarted",
        id: "missing.json",
        patch: { disabled: true },
      }),
    ).toBe(loaded);
    expect(reduceCliProxyAccounts(loaded, { type: "patchFailed", id: "missing.json" })).toEqual(
      loaded,
    );
  });

  it("keeps a row inert through a delete and drops it only once the server confirms", () => {
    const started = reduceCliProxyAccounts(loaded, { type: "deleteStarted", id: codex.id });
    expect(started.accounts).toEqual([claude, codex]);
    expect(isCliProxyAccountPending(started, codex.id)).toBe(true);

    const failed = reduceCliProxyAccounts(started, { type: "deleteFailed", id: codex.id });
    expect(failed.accounts).toEqual([claude, codex]);
    expect(failed.pending.size).toBe(0);

    const removed = reduceCliProxyAccounts(started, { type: "deleteSucceeded", id: codex.id });
    expect(removed.accounts).toEqual([claude]);
    expect(removed.pending.size).toBe(0);
  });

  it("does not invent a list when a mutation answers before the first load", () => {
    const succeeded = reduceCliProxyAccounts(INITIAL_CLIPROXY_ACCOUNTS, {
      type: "patchSucceeded",
      id: claude.id,
      account: claude,
    });
    expect(succeeded.accounts).toBeNull();
    expect(
      reduceCliProxyAccounts(INITIAL_CLIPROXY_ACCOUNTS, { type: "deleteSucceeded", id: claude.id })
        .accounts,
    ).toBeNull();
  });
});

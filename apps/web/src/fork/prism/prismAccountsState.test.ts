import { describe, expect, it } from "vite-plus/test";

import type { PrismAccount } from "@q1code/core/prismApi";
import { UsageLimitSourceId } from "@t3tools/contracts";

import {
  IDLE_LOGIN_FLOW,
  INITIAL_PRISM_ACCOUNTS,
  type PrismLoginFlowState,
  describePrismEngine,
  describePrismMode,
  describePrismRestart,
  describePrismUnavailable,
  describePrismUsageProvider,
  formatPrismSince,
  formatPrismSyncInterval,
  isPrismAccountPending,
  parsePrismWeight,
  pendingPrismLoginSession,
  prismUsageSourceKindLabel,
  reducePrismAccounts,
  reducePrismLoginFlow,
  resolvePrismMode,
  resolvePrismUsageSource,
  summarizePrismStatus,
} from "./prismAccountsState.ts";

const started = {
  sessionId: "session-1",
  authUrl: "https://auth.example.test/start",
  flow: "redirect" as const,
};

function pending(): PrismLoginFlowState {
  return reducePrismLoginFlow(
    reducePrismLoginFlow(IDLE_LOGIN_FLOW, { type: "start", provider: "codex" }),
    { type: "started", started },
  );
}

describe("prism login flow", () => {
  it("walks idle -> starting -> pending -> completed with the new account id", () => {
    const starting = reducePrismLoginFlow(IDLE_LOGIN_FLOW, {
      type: "start",
      provider: "anthropic",
    });
    expect(starting).toEqual({ _tag: "starting", provider: "anthropic" });

    const waiting = reducePrismLoginFlow(starting, {
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
    expect(pendingPrismLoginSession(waiting)).toBe("session-1");

    const done = reducePrismLoginFlow(waiting, {
      type: "status",
      status: { sessionId: "session-1", status: "completed", accountId: "claude-1.json" },
    });
    expect(done).toEqual({ _tag: "completed", provider: "anthropic", accountId: "claude-1.json" });
    expect(pendingPrismLoginSession(done)).toBeNull();
  });

  it("ignores answers for another session", () => {
    const waiting = pending();
    const stale = reducePrismLoginFlow(waiting, {
      type: "status",
      status: { sessionId: "session-0", status: "completed", accountId: "old.json" },
    });
    expect(stale).toBe(waiting);
    expect(
      reducePrismLoginFlow(waiting, {
        type: "redirectFailed",
        sessionId: "session-0",
        error: "nope",
      }),
    ).toBe(waiting);
  });

  it("keeps polling through a pasted redirect and surfaces a rejected one", () => {
    const submitting = reducePrismLoginFlow(pending(), { type: "pasteRedirect" });
    expect(submitting).toMatchObject({ _tag: "pending", submittingRedirect: true });
    expect(pendingPrismLoginSession(submitting)).toBe("session-1");

    const stillPending = reducePrismLoginFlow(submitting, {
      type: "status",
      status: { sessionId: "session-1", status: "pending" },
    });
    expect(stillPending).toMatchObject({ _tag: "pending", submittingRedirect: false });

    const rejected = reducePrismLoginFlow(
      reducePrismLoginFlow(stillPending, { type: "pasteRedirect" }),
      { type: "redirectFailed", sessionId: "session-1", error: "state mismatch" },
    );
    expect(rejected).toMatchObject({
      _tag: "pending",
      submittingRedirect: false,
      redirectError: "state mismatch",
    });
    // The next paste clears the old rejection.
    expect(reducePrismLoginFlow(rejected, { type: "pasteRedirect" })).toMatchObject({
      redirectError: null,
      submittingRedirect: true,
    });
  });

  it("maps failed and cancelled answers, defaulting the failure text", () => {
    expect(
      reducePrismLoginFlow(pending(), {
        type: "status",
        status: { sessionId: "session-1", status: "failed" },
      }),
    ).toEqual({ _tag: "failed", provider: "codex", error: "The sign-in did not complete." });
    expect(
      reducePrismLoginFlow(pending(), {
        type: "status",
        status: { sessionId: "session-1", status: "cancelled" },
      }),
    ).toEqual({ _tag: "cancelled", provider: "codex" });
    expect(
      reducePrismLoginFlow(
        { _tag: "starting", provider: "xai" },
        { type: "startFailed", error: "sidecar down" },
      ),
    ).toEqual({ _tag: "failed", provider: "xai", error: "sidecar down" });
  });

  it("cancels optimistically from starting or pending and resets to idle", () => {
    const cancelled = reducePrismLoginFlow(pending(), { type: "cancel" });
    expect(cancelled).toEqual({ _tag: "cancelled", provider: "codex" });
    expect(pendingPrismLoginSession(cancelled)).toBeNull();
    expect(
      reducePrismLoginFlow({ _tag: "starting", provider: "kimi" }, { type: "cancel" }),
    ).toEqual({
      _tag: "cancelled",
      provider: "kimi",
    });
    expect(reducePrismLoginFlow(cancelled, { type: "cancel" })).toBe(cancelled);
    expect(reducePrismLoginFlow(cancelled, { type: "reset" })).toBe(IDLE_LOGIN_FLOW);
  });

  it("refuses a second start while one flow is waiting", () => {
    const waiting = pending();
    expect(reducePrismLoginFlow(waiting, { type: "start", provider: "xai" })).toBe(waiting);
    // Terminal states can start over.
    expect(
      reducePrismLoginFlow(
        { _tag: "failed", provider: "codex", error: "x" },
        { type: "start", provider: "xai" },
      ),
    ).toEqual({ _tag: "starting", provider: "xai" });
  });

  it("drops events that do not apply to the current state", () => {
    expect(reducePrismLoginFlow(IDLE_LOGIN_FLOW, { type: "started", started })).toBe(
      IDLE_LOGIN_FLOW,
    );
    expect(reducePrismLoginFlow(IDLE_LOGIN_FLOW, { type: "pasteRedirect" })).toBe(IDLE_LOGIN_FLOW);
  });
});

describe("prism label helpers", () => {
  it("explains each unavailable reason with the env/config hint", () => {
    expect(describePrismUnavailable("flag-off", "off")).toContain("T3FORK_PRISM=1");
    expect(describePrismUnavailable("flag-off", "off")).toContain("fork.json");
    expect(describePrismUnavailable("sidecar-not-ready", "starting")).toContain("starting");
    expect(describePrismUnavailable("sidecar-not-ready", "failed")).toContain("failed to start");
    expect(describePrismUnavailable("sync-not-configured", "ready")).toContain("prism.sync");
  });

  it("names the engine with its release and where it runs", () => {
    expect(describePrismEngine({ mode: "sidecar", version: "7.2.147" })).toBe(
      "CLIProxyAPI v7.2.147 (bundled)",
    );
    expect(describePrismEngine({ mode: "external", version: "7.1.0" })).toBe(
      "CLIProxyAPI v7.1.0 (external)",
    );
    expect(describePrismEngine({})).toBe("CLIProxyAPI (bundled)");
  });

  it("accepts only changed non-negative integers as weights", () => {
    expect(parsePrismWeight("3", 1)).toBe(3);
    expect(parsePrismWeight(" 0 ", undefined)).toBe(0);
    expect(parsePrismWeight("3", 3)).toBeNull();
    expect(parsePrismWeight("-1", 1)).toBeNull();
    expect(parsePrismWeight("1.5", 1)).toBeNull();
    expect(parsePrismWeight("", 1)).toBeNull();
    expect(parsePrismWeight("abc", 1)).toBeNull();
  });

  it("labels only the managed usage source as Prism", () => {
    expect(prismUsageSourceKindLabel({ id: UsageLimitSourceId.make("prism") })).toBe("Prism");
    expect(prismUsageSourceKindLabel({ id: UsageLimitSourceId.make("my-hub") })).toBeUndefined();
  });
});

describe("prism usage provider row", () => {
  it("treats a status without the toggle as publishing", () => {
    expect(resolvePrismUsageSource({})).toBe(true);
    expect(resolvePrismUsageSource({ usageSource: false })).toBe(false);
  });

  it("describes the managed source, its origin, and whether it publishes", () => {
    expect(describePrismUsageProvider(null)).toEqual({
      description: "Managed by q1code",
      status: "Checking the proxy…",
    });
    expect(
      describePrismUsageProvider({ state: "ready", baseUrl: "http://127.0.0.1:8317" }),
    ).toEqual({
      description: "Managed by q1code · http://127.0.0.1:8317",
      status: "Pooled accounts are shown on Usage → Limits.",
    });
    expect(
      describePrismUsageProvider({
        state: "ready",
        baseUrl: "http://127.0.0.1:8317",
        usageSource: false,
      }).status,
    ).toContain("Not shown on Usage → Limits");
    const starting = describePrismUsageProvider({ state: "starting" });
    expect(starting.description).toBe("Managed by q1code");
    expect(starting.status).toContain("Proxy starting");
    expect(describePrismUsageProvider({ state: "failed" }).status).toContain("Proxy failed");
  });
});

describe("prism status helpers", () => {
  const nowMs = Date.parse("2026-09-02T12:00:00.000Z");

  it("treats a status without a mode as the sidecar", () => {
    expect(resolvePrismMode({})).toBe("sidecar");
    expect(resolvePrismMode({ mode: "external" })).toBe("external");
    expect(describePrismMode("external")).toContain("restart re-checks the connection");
    expect(describePrismMode("sidecar")).toContain("relaunches");
    expect(describePrismRestart("sidecar")).toContain("Restart");
    expect(describePrismRestart("external")).toContain("Re-check");
  });

  it("formats since as an elapsed duration and skips it when absent", () => {
    expect(formatPrismSince(undefined, nowMs)).toBeNull();
    expect(formatPrismSince("not a date", nowMs)).toBeNull();
    expect(formatPrismSince("2026-09-02T11:59:59.000Z", nowMs)).toBe("just now");
    expect(formatPrismSince("2026-09-02T11:57:00.000Z", nowMs)).toBe("for 3m");
    expect(formatPrismSince("2026-09-01T12:00:00.000Z", nowMs)).toBe("for 1d");
  });

  it("summarizes state, uptime, and restarts on one line", () => {
    expect(summarizePrismStatus({ state: "ready" }, nowMs)).toBe("Ready");
    expect(
      summarizePrismStatus(
        { state: "ready", since: "2026-09-02T11:57:00.000Z", restarts: 0 },
        nowMs,
      ),
    ).toBe("Ready for 3m");
    expect(
      summarizePrismStatus(
        { state: "starting", since: "2026-09-02T11:59:50.000Z", restarts: 1 },
        nowMs,
      ),
    ).toBe("Starting for 10s · 1 restart");
    expect(summarizePrismStatus({ state: "failed", restarts: 4 }, nowMs)).toBe(
      "Failed · 4 restarts",
    );
  });

  it("formats the sync interval in minutes when even", () => {
    expect(formatPrismSyncInterval(300)).toBe("every 5 minutes");
    expect(formatPrismSyncInterval(60)).toBe("every 1 minute");
    expect(formatPrismSyncInterval(90)).toBe("every 90 seconds");
    expect(formatPrismSyncInterval(1)).toBe("every 1 second");
  });
});

describe("prism accounts reducer", () => {
  const claude: PrismAccount = {
    id: "claude-1.json",
    provider: "claude",
    label: "claude-1",
    email: "a@example.test",
    disabled: false,
    weight: 1,
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
  const codex: PrismAccount = {
    id: "codex-1.json",
    provider: "codex",
    label: "codex-1",
    disabled: true,
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
  const loaded = reducePrismAccounts(INITIAL_PRISM_ACCOUNTS, {
    type: "loaded",
    accounts: [claude, codex],
  });

  it("starts without a list and takes the first one as is", () => {
    expect(INITIAL_PRISM_ACCOUNTS.accounts).toBeNull();
    expect(loaded.accounts).toEqual([claude, codex]);
    expect(loaded.pending.size).toBe(0);
  });

  it("applies a toggle at once, then keeps the server's row", () => {
    const started = reducePrismAccounts(loaded, {
      type: "patchStarted",
      id: claude.id,
      patch: { disabled: true },
    });
    expect(started.accounts?.[0]).toEqual({ ...claude, disabled: true });
    expect(isPrismAccountPending(started, claude.id)).toBe(true);
    expect(isPrismAccountPending(started, codex.id)).toBe(false);

    const fromServer = { ...claude, disabled: true, updatedAt: "2026-09-02T00:00:01.000Z" };
    const done = reducePrismAccounts(started, {
      type: "patchSucceeded",
      id: claude.id,
      account: fromServer,
    });
    expect(done.accounts?.[0]).toBe(fromServer);
    expect(isPrismAccountPending(done, claude.id)).toBe(false);
  });

  it("rolls a failed patch back to the row it replaced", () => {
    const started = reducePrismAccounts(loaded, {
      type: "patchStarted",
      id: claude.id,
      patch: { weight: 5 },
    });
    expect(started.accounts?.[0]?.weight).toBe(5);
    const rolledBack = reducePrismAccounts(started, { type: "patchFailed", id: claude.id });
    expect(rolledBack.accounts?.[0]).toBe(claude);
    expect(rolledBack.pending.size).toBe(0);
  });

  it("allows one mutation per row at a time and ignores unknown rows", () => {
    const started = reducePrismAccounts(loaded, {
      type: "patchStarted",
      id: claude.id,
      patch: { disabled: true },
    });
    expect(
      reducePrismAccounts(started, {
        type: "patchStarted",
        id: claude.id,
        patch: { disabled: false },
      }),
    ).toBe(started);
    expect(reducePrismAccounts(started, { type: "deleteStarted", id: claude.id })).toBe(started);
    expect(
      reducePrismAccounts(loaded, {
        type: "patchStarted",
        id: "missing.json",
        patch: { disabled: true },
      }),
    ).toBe(loaded);
    expect(reducePrismAccounts(loaded, { type: "patchFailed", id: "missing.json" })).toEqual(
      loaded,
    );
  });

  it("keeps a row inert through a delete and drops it only once the server confirms", () => {
    const started = reducePrismAccounts(loaded, { type: "deleteStarted", id: codex.id });
    expect(started.accounts).toEqual([claude, codex]);
    expect(isPrismAccountPending(started, codex.id)).toBe(true);

    const failed = reducePrismAccounts(started, { type: "deleteFailed", id: codex.id });
    expect(failed.accounts).toEqual([claude, codex]);
    expect(failed.pending.size).toBe(0);

    const removed = reducePrismAccounts(started, { type: "deleteSucceeded", id: codex.id });
    expect(removed.accounts).toEqual([claude]);
    expect(removed.pending.size).toBe(0);
  });

  it("does not invent a list when a mutation answers before the first load", () => {
    const succeeded = reducePrismAccounts(INITIAL_PRISM_ACCOUNTS, {
      type: "patchSucceeded",
      id: claude.id,
      account: claude,
    });
    expect(succeeded.accounts).toBeNull();
    expect(
      reducePrismAccounts(INITIAL_PRISM_ACCOUNTS, { type: "deleteSucceeded", id: claude.id })
        .accounts,
    ).toBeNull();
  });
});

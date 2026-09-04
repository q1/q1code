import { describe, expect, it } from "vite-plus/test";

import type { PrismAccount, PrismStatus } from "@q1code/core/prismApi";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  ADMIN_ACCESS_REQUIRED,
  PRISM_RESTART_TIMEOUT_MS,
  type PrismLoginFlowState,
  describePrismAccount,
  describePrismError,
  describePrismStatus,
  IDLE_LOGIN_FLOW,
  INITIAL_ACCOUNTS_STATE,
  INITIAL_USAGE_SOURCE_STATE,
  isPrismUsageSourceOn,
  nextRestartStep,
  pendingPrismLoginSession,
  reducePrismAccounts,
  reducePrismLoginFlow,
  reducePrismUsageSource,
  selectPrismEnvironments,
  shouldPollPrismStatus,
  summarizePrismOverviews,
} from "./prismSettings.logic";

const environment = (id: string, phase: string) => ({
  environmentId: id as EnvironmentId,
  label: `env ${id}`,
  connection: { phase },
});

describe("selectPrismEnvironments", () => {
  it("keeps only connected environments whose flag is on", () => {
    const flags: Record<string, boolean | undefined> = { a: true, b: false, c: true, d: true };
    const selected = selectPrismEnvironments(
      [
        environment("a", "connected"),
        environment("b", "connected"),
        environment("c", "connecting"),
        environment("d", "connected"),
        environment("e", "connected"),
      ],
      (id) => (flags[id] === undefined ? null : { forkFlags: { prism: flags[id] } }),
    );
    expect(selected.map((entry) => entry.environmentId)).toEqual(["a", "d"]);
    expect(selected[0]?.label).toBe("env a");
  });

  it("reads the registry default (off) against upstream servers with no forkFlags", () => {
    expect(selectPrismEnvironments([environment("a", "connected")], () => ({}))).toEqual([]);
  });
});

describe("describePrismStatus", () => {
  const relative = (iso: string) => `rel(${iso})`;
  const base: PrismStatus = { state: "ready", port: 8317, role: "standalone" };

  it("treats a status without the newer fields as a sidecar on its port", () => {
    expect(describePrismStatus(base, relative)).toEqual([
      { label: "Mode", value: "Sidecar" },
      { label: "Base URL", value: "port 8317" },
      { label: "Engine", value: "CLIProxyAPI (bundled)" },
      { label: "Sync", value: "standalone" },
    ]);
  });

  it("lists mode, base URL, engine, since, restarts, last error, and sync details", () => {
    expect(
      describePrismStatus(
        {
          ...base,
          state: "failed",
          mode: "external",
          baseUrl: "http://proxy.local:9000",
          version: "6.1.0",
          since: "2026-09-02T10:00:00.000Z",
          restarts: 3,
          lastError: "connection refused",
          role: "replica",
          lastSyncAt: "2026-09-02T09:55:00.000Z",
          lastSyncError: "401",
        },
        relative,
      ),
    ).toEqual([
      { label: "Mode", value: "External" },
      { label: "Base URL", value: "http://proxy.local:9000" },
      { label: "Engine", value: "CLIProxyAPI v6.1.0 (external)" },
      { label: "Since", value: "rel(2026-09-02T10:00:00.000Z) ago" },
      { label: "Restarts", value: "3" },
      { label: "Last error", value: "connection refused" },
      { label: "Sync", value: "replica · synced rel(2026-09-02T09:55:00.000Z) ago · error: 401" },
    ]);
  });
});

describe("describePrismError", () => {
  it("explains a 503 by its reason and state", () => {
    expect(
      describePrismError({
        _tag: "PrismUnavailableError",
        reason: "sidecar-not-ready",
        state: "starting",
      } as never),
    ).toContain("starting");
    expect(
      describePrismError({
        _tag: "PrismUnavailableError",
        reason: "flag-off",
        state: "off",
      } as never),
    ).toContain("T3FORK_PRISM=1");
  });

  it("phrases 401 and 403 as an administrative-access problem without leaking a token", () => {
    const forbidden = describePrismError({
      _tag: "EnvironmentScopeRequiredError",
      requiredScope: "access:write",
    } as never);
    expect(forbidden).toContain(ADMIN_ACCESS_REQUIRED);
    expect(forbidden).toContain("access:write");
    expect(describePrismError({ _tag: "EnvironmentAuthInvalidError" } as never)).toContain(
      ADMIN_ACCESS_REQUIRED,
    );
  });
});

describe("describePrismAccount", () => {
  const relative = () => "5m";
  it("joins provider, weight, age, and counters when present", () => {
    const account: PrismAccount = {
      id: "codex-1.json",
      provider: "codex",
      label: "codex-1",
      disabled: false,
      weight: 2,
      updatedAt: "2026-09-02T10:00:00.000Z",
      usage: { success: 12, failed: 1 },
    };
    expect(describePrismAccount(account, relative)).toBe(
      "Codex · weight 2 · 5m · 12 ok · 1 failed",
    );
    expect(
      describePrismAccount({ ...account, weight: undefined, usage: undefined }, relative),
    ).toBe("Codex · 5m");
  });
});

describe("reducePrismAccounts", () => {
  const account = (id: string, disabled = false): PrismAccount => ({
    id,
    provider: "claude",
    label: id,
    disabled,
    updatedAt: "2026-09-02T10:00:00.000Z",
  });
  const loaded = reducePrismAccounts(INITIAL_ACCOUNTS_STATE, {
    type: "loaded",
    accounts: [account("a.json"), account("b.json", true)],
  });

  it("applies a toggle optimistically and confirms it with the server's account", () => {
    const toggled = reducePrismAccounts(loaded, {
      type: "toggle",
      id: "a.json",
      disabled: true,
    });
    expect(toggled.accounts?.[0]?.disabled).toBe(true);
    expect(toggled.pending["a.json"]).toEqual({ _tag: "toggle", previousDisabled: false });

    const confirmed = reducePrismAccounts(toggled, {
      type: "toggled",
      id: "a.json",
      account: { ...account("a.json", true), weight: 4 },
    });
    expect(confirmed.accounts?.[0]).toMatchObject({ disabled: true, weight: 4 });
    expect(confirmed.pending).toEqual({});
  });

  it("rolls a failed toggle back and keeps the error on that row only", () => {
    const toggled = reducePrismAccounts(loaded, {
      type: "toggle",
      id: "b.json",
      disabled: false,
    });
    const failed = reducePrismAccounts(toggled, {
      type: "toggleFailed",
      id: "b.json",
      error: "nope",
    });
    expect(failed.accounts?.[1]?.disabled).toBe(true);
    expect(failed.pending).toEqual({});
    expect(failed.rowErrors).toEqual({ "b.json": "nope" });

    const retried = reducePrismAccounts(failed, {
      type: "toggle",
      id: "b.json",
      disabled: false,
    });
    expect(retried.rowErrors).toEqual({});
  });

  it("ignores a second toggle while one is in flight and a stray confirmation", () => {
    const toggled = reducePrismAccounts(loaded, {
      type: "toggle",
      id: "a.json",
      disabled: true,
    });
    expect(reducePrismAccounts(toggled, { type: "toggle", id: "a.json", disabled: false })).toBe(
      toggled,
    );
    expect(reducePrismAccounts(loaded, { type: "toggleFailed", id: "a.json", error: "late" })).toBe(
      loaded,
    );
  });

  it("keeps the optimistic value when a list fetched mid-toggle still has the old one", () => {
    const toggled = reducePrismAccounts(loaded, {
      type: "toggle",
      id: "a.json",
      disabled: true,
    });
    const reloaded = reducePrismAccounts(toggled, {
      type: "loaded",
      accounts: [account("a.json"), account("b.json", true)],
    });
    expect(reloaded.accounts?.[0]?.disabled).toBe(true);
    expect(reloaded.pending["a.json"]).toBeDefined();
  });

  it("removes an account on success and reports a failed removal inline", () => {
    const removing = reducePrismAccounts(loaded, { type: "remove", id: "a.json" });
    expect(removing.pending["a.json"]).toEqual({ _tag: "remove" });
    const removed = reducePrismAccounts(removing, { type: "removed", id: "a.json" });
    expect(removed.accounts?.map((entry) => entry.id)).toEqual(["b.json"]);
    expect(removed.pending).toEqual({});

    const failed = reducePrismAccounts(removing, {
      type: "removeFailed",
      id: "a.json",
      error: "sidecar refused",
    });
    expect(failed.accounts?.length).toBe(2);
    expect(failed.rowErrors).toEqual({ "a.json": "sidecar refused" });
  });

  it("keeps the last list when a reload fails, and clears the error on the next success", () => {
    const failed = reducePrismAccounts(loaded, { type: "loadFailed", error: "offline" });
    expect(failed.accounts?.length).toBe(2);
    expect(failed.error).toBe("offline");
    expect(reducePrismAccounts(failed, { type: "loaded", accounts: [] }).error).toBeNull();
  });
});

describe("reducePrismLoginFlow", () => {
  const started = {
    sessionId: "session-1",
    authUrl: "https://auth.example.test/start",
    flow: "redirect" as const,
  };
  const pending = (): PrismLoginFlowState =>
    reducePrismLoginFlow(
      reducePrismLoginFlow(IDLE_LOGIN_FLOW, { type: "start", provider: "codex" }),
      { type: "started", started },
    );

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
    expect(waiting).toMatchObject({ _tag: "pending", flow: "device", userCode: "ABCD-EFGH" });
    expect(pendingPrismLoginSession(waiting)).toBe("session-1");
    const done = reducePrismLoginFlow(waiting, {
      type: "status",
      status: { sessionId: "session-1", status: "completed", accountId: "claude-1.json" },
    });
    expect(done).toEqual({ _tag: "completed", provider: "anthropic", accountId: "claude-1.json" });
    expect(pendingPrismLoginSession(done)).toBeNull();
  });

  it("ignores answers for another session and a second start while pending", () => {
    const waiting = pending();
    expect(
      reducePrismLoginFlow(waiting, {
        type: "status",
        status: { sessionId: "session-0", status: "completed" },
      }),
    ).toBe(waiting);
    expect(reducePrismLoginFlow(waiting, { type: "start", provider: "xai" })).toBe(waiting);
  });

  it("keeps polling through a pasted redirect and surfaces a rejected one", () => {
    const submitting = reducePrismLoginFlow(pending(), { type: "pasteRedirect" });
    expect(submitting).toMatchObject({ _tag: "pending", submittingRedirect: true });
    expect(pendingPrismLoginSession(submitting)).toBe("session-1");
    const rejected = reducePrismLoginFlow(submitting, {
      type: "redirectFailed",
      sessionId: "session-1",
      error: "bad state",
    });
    expect(rejected).toMatchObject({ submittingRedirect: false, redirectError: "bad state" });
    expect(reducePrismLoginFlow(rejected, { type: "pasteRedirect" })).toMatchObject({
      submittingRedirect: true,
      redirectError: null,
    });
  });

  it("cancels optimistically, reports failures, and resets to idle", () => {
    expect(reducePrismLoginFlow(pending(), { type: "cancel" })).toEqual({
      _tag: "cancelled",
      provider: "codex",
    });
    expect(
      reducePrismLoginFlow(pending(), {
        type: "status",
        status: { sessionId: "session-1", status: "failed" },
      }),
    ).toMatchObject({ _tag: "failed", error: expect.any(String) });
    expect(
      reducePrismLoginFlow(
        reducePrismLoginFlow(IDLE_LOGIN_FLOW, { type: "start", provider: "kimi" }),
        { type: "startFailed", error: "503" },
      ),
    ).toEqual({ _tag: "failed", provider: "kimi", error: "503" });
    expect(reducePrismLoginFlow(pending(), { type: "reset" })).toBe(IDLE_LOGIN_FLOW);
  });
});

describe("reducePrismUsageSource", () => {
  const status = (usageSource?: boolean): PrismStatus => ({
    state: "ready",
    port: 8317,
    role: "standalone",
    ...(usageSource === undefined ? {} : { usageSource }),
  });

  it("treats a status without the field as on and follows later loads while idle", () => {
    expect(isPrismUsageSourceOn(null)).toBe(true);
    expect(isPrismUsageSourceOn(status())).toBe(true);
    expect(isPrismUsageSourceOn(status(false))).toBe(false);
    const loaded = reducePrismUsageSource(INITIAL_USAGE_SOURCE_STATE, {
      type: "status",
      status: status(),
    });
    expect(loaded).toEqual({ enabled: true, rollback: null, error: null });
    expect(reducePrismUsageSource(loaded, { type: "status", status: status(false) }).enabled).toBe(
      false,
    );
  });

  it("flips optimistically, ignores a stale poll meanwhile, and settles on the saved status", () => {
    const loaded = reducePrismUsageSource(INITIAL_USAGE_SOURCE_STATE, {
      type: "status",
      status: status(true),
    });
    const flipped = reducePrismUsageSource(loaded, { type: "toggle", enabled: false });
    expect(flipped).toEqual({ enabled: false, rollback: true, error: null });
    expect(reducePrismUsageSource(flipped, { type: "status", status: status(true) })).toBe(flipped);
    expect(reducePrismUsageSource(flipped, { type: "toggle", enabled: true })).toBe(flipped);
    expect(reducePrismUsageSource(flipped, { type: "saved", status: status(false) })).toEqual({
      enabled: false,
      rollback: null,
      error: null,
    });
  });

  it("rolls back with the error when the save fails, and clears it on the next attempt", () => {
    const loaded = reducePrismUsageSource(INITIAL_USAGE_SOURCE_STATE, {
      type: "status",
      status: status(false),
    });
    const flipped = reducePrismUsageSource(loaded, { type: "toggle", enabled: true });
    const failed = reducePrismUsageSource(flipped, { type: "saveFailed", error: "403" });
    expect(failed).toEqual({ enabled: false, rollback: null, error: "403" });
    expect(reducePrismUsageSource(failed, { type: "toggle", enabled: true }).error).toBeNull();
  });

  it("does nothing before the status arrived or when the value would not change", () => {
    expect(
      reducePrismUsageSource(INITIAL_USAGE_SOURCE_STATE, { type: "toggle", enabled: false }),
    ).toBe(INITIAL_USAGE_SOURCE_STATE);
    const loaded = reducePrismUsageSource(INITIAL_USAGE_SOURCE_STATE, {
      type: "status",
      status: status(true),
    });
    expect(reducePrismUsageSource(loaded, { type: "toggle", enabled: true })).toBe(loaded);
    expect(reducePrismUsageSource(loaded, { type: "saveFailed", error: "late" })).toBe(loaded);
  });
});

describe("polling decisions", () => {
  it("polls status only while focused and the app is active", () => {
    expect(shouldPollPrismStatus({ focused: true, appState: "active" })).toBe(true);
    expect(shouldPollPrismStatus({ focused: false, appState: "active" })).toBe(false);
    expect(shouldPollPrismStatus({ focused: true, appState: "background" })).toBe(false);
    expect(shouldPollPrismStatus({ focused: true, appState: "inactive" })).toBe(false);
  });

  it("keeps polling a restart until ready or failed, then gives up at the deadline", () => {
    expect(nextRestartStep({ state: "starting", elapsedMs: 0 })).toBe("poll");
    expect(nextRestartStep({ state: "off", elapsedMs: 4_000 })).toBe("poll");
    expect(nextRestartStep({ state: "ready", elapsedMs: 4_000 })).toBe("settled");
    expect(nextRestartStep({ state: "failed", elapsedMs: 4_000 })).toBe("settled");
    expect(nextRestartStep({ state: "starting", elapsedMs: PRISM_RESTART_TIMEOUT_MS })).toBe(
      "timeout",
    );
    expect(nextRestartStep({ state: "ready", elapsedMs: PRISM_RESTART_TIMEOUT_MS + 1 })).toBe(
      "settled",
    );
  });
});

describe("summarizePrismOverviews", () => {
  it("stays empty until every environment answered", () => {
    expect(summarizePrismOverviews([])).toBeUndefined();
    expect(
      summarizePrismOverviews([
        { _tag: "loaded", state: "ready", accountCount: 2 },
        { _tag: "loading" },
      ]),
    ).toBeUndefined();
  });

  it("sums the counts across environments", () => {
    expect(
      summarizePrismOverviews([
        { _tag: "loaded", state: "ready", accountCount: 2 },
        { _tag: "loaded", state: "starting", accountCount: null },
        { _tag: "loaded", state: "ready", accountCount: 1 },
      ]),
    ).toBe("3 accounts");
    expect(summarizePrismOverviews([{ _tag: "loaded", state: "ready", accountCount: 1 }])).toBe(
      "1 account",
    );
  });

  it("falls back to the state that explains a missing count", () => {
    expect(
      summarizePrismOverviews([{ _tag: "loaded", state: "starting", accountCount: null }]),
    ).toBe("Starting");
    expect(summarizePrismOverviews([{ _tag: "loaded", state: "ready", accountCount: null }])).toBe(
      "Unavailable",
    );
    expect(summarizePrismOverviews([{ _tag: "error" }])).toBe("Unreachable");
  });
});

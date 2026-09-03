import { describe, expect, it } from "vite-plus/test";

import type { CliProxyAccount, CliProxyStatus } from "@q1code/core/cliproxyApi";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  ADMIN_ACCESS_REQUIRED,
  CLIPROXY_RESTART_TIMEOUT_MS,
  type CliProxyLoginFlowState,
  describeCliProxyAccount,
  describeCliProxyError,
  describeCliProxyStatus,
  IDLE_LOGIN_FLOW,
  INITIAL_ACCOUNTS_STATE,
  nextRestartStep,
  pendingCliProxyLoginSession,
  reduceCliProxyAccounts,
  reduceCliProxyLoginFlow,
  selectCliProxyEnvironments,
  shouldPollCliProxyStatus,
  summarizeCliProxyOverviews,
} from "./cliproxySettings.logic";

const environment = (id: string, phase: string) => ({
  environmentId: id as EnvironmentId,
  label: `env ${id}`,
  connection: { phase },
});

describe("selectCliProxyEnvironments", () => {
  it("keeps only connected environments whose flag is on", () => {
    const flags: Record<string, boolean | undefined> = { a: true, b: false, c: true, d: true };
    const selected = selectCliProxyEnvironments(
      [
        environment("a", "connected"),
        environment("b", "connected"),
        environment("c", "connecting"),
        environment("d", "connected"),
        environment("e", "connected"),
      ],
      (id) => (flags[id] === undefined ? null : { forkFlags: { cliproxy: flags[id] } }),
    );
    expect(selected.map((entry) => entry.environmentId)).toEqual(["a", "d"]);
    expect(selected[0]?.label).toBe("env a");
  });

  it("reads the registry default (off) against upstream servers with no forkFlags", () => {
    expect(selectCliProxyEnvironments([environment("a", "connected")], () => ({}))).toEqual([]);
  });
});

describe("describeCliProxyStatus", () => {
  const relative = (iso: string) => `rel(${iso})`;
  const base: CliProxyStatus = { state: "ready", port: 8317, role: "standalone" };

  it("treats a status without the newer fields as a sidecar on its port", () => {
    expect(describeCliProxyStatus(base, relative)).toEqual([
      { label: "Mode", value: "Sidecar" },
      { label: "Base URL", value: "port 8317" },
      { label: "Sync", value: "standalone" },
    ]);
  });

  it("lists mode, base URL, version, since, restarts, last error, and sync details", () => {
    expect(
      describeCliProxyStatus(
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
      { label: "Version", value: "6.1.0" },
      { label: "Since", value: "rel(2026-09-02T10:00:00.000Z) ago" },
      { label: "Restarts", value: "3" },
      { label: "Last error", value: "connection refused" },
      { label: "Sync", value: "replica · synced rel(2026-09-02T09:55:00.000Z) ago · error: 401" },
    ]);
  });
});

describe("describeCliProxyError", () => {
  it("explains a 503 by its reason and state", () => {
    expect(
      describeCliProxyError({
        _tag: "CliProxyUnavailableError",
        reason: "sidecar-not-ready",
        state: "starting",
      } as never),
    ).toContain("starting");
    expect(
      describeCliProxyError({
        _tag: "CliProxyUnavailableError",
        reason: "flag-off",
        state: "off",
      } as never),
    ).toContain("T3FORK_CLIPROXY=1");
  });

  it("phrases 401 and 403 as an administrative-access problem without leaking a token", () => {
    const forbidden = describeCliProxyError({
      _tag: "EnvironmentScopeRequiredError",
      requiredScope: "access:write",
    } as never);
    expect(forbidden).toContain(ADMIN_ACCESS_REQUIRED);
    expect(forbidden).toContain("access:write");
    expect(describeCliProxyError({ _tag: "EnvironmentAuthInvalidError" } as never)).toContain(
      ADMIN_ACCESS_REQUIRED,
    );
  });
});

describe("describeCliProxyAccount", () => {
  const relative = () => "5m";
  it("joins provider, weight, age, and counters when present", () => {
    const account: CliProxyAccount = {
      id: "codex-1.json",
      provider: "codex",
      label: "codex-1",
      disabled: false,
      weight: 2,
      updatedAt: "2026-09-02T10:00:00.000Z",
      usage: { success: 12, failed: 1 },
    };
    expect(describeCliProxyAccount(account, relative)).toBe(
      "Codex · weight 2 · 5m · 12 ok · 1 failed",
    );
    expect(
      describeCliProxyAccount({ ...account, weight: undefined, usage: undefined }, relative),
    ).toBe("Codex · 5m");
  });
});

describe("reduceCliProxyAccounts", () => {
  const account = (id: string, disabled = false): CliProxyAccount => ({
    id,
    provider: "claude",
    label: id,
    disabled,
    updatedAt: "2026-09-02T10:00:00.000Z",
  });
  const loaded = reduceCliProxyAccounts(INITIAL_ACCOUNTS_STATE, {
    type: "loaded",
    accounts: [account("a.json"), account("b.json", true)],
  });

  it("applies a toggle optimistically and confirms it with the server's account", () => {
    const toggled = reduceCliProxyAccounts(loaded, {
      type: "toggle",
      id: "a.json",
      disabled: true,
    });
    expect(toggled.accounts?.[0]?.disabled).toBe(true);
    expect(toggled.pending["a.json"]).toEqual({ _tag: "toggle", previousDisabled: false });

    const confirmed = reduceCliProxyAccounts(toggled, {
      type: "toggled",
      id: "a.json",
      account: { ...account("a.json", true), weight: 4 },
    });
    expect(confirmed.accounts?.[0]).toMatchObject({ disabled: true, weight: 4 });
    expect(confirmed.pending).toEqual({});
  });

  it("rolls a failed toggle back and keeps the error on that row only", () => {
    const toggled = reduceCliProxyAccounts(loaded, {
      type: "toggle",
      id: "b.json",
      disabled: false,
    });
    const failed = reduceCliProxyAccounts(toggled, {
      type: "toggleFailed",
      id: "b.json",
      error: "nope",
    });
    expect(failed.accounts?.[1]?.disabled).toBe(true);
    expect(failed.pending).toEqual({});
    expect(failed.rowErrors).toEqual({ "b.json": "nope" });

    const retried = reduceCliProxyAccounts(failed, {
      type: "toggle",
      id: "b.json",
      disabled: false,
    });
    expect(retried.rowErrors).toEqual({});
  });

  it("ignores a second toggle while one is in flight and a stray confirmation", () => {
    const toggled = reduceCliProxyAccounts(loaded, {
      type: "toggle",
      id: "a.json",
      disabled: true,
    });
    expect(reduceCliProxyAccounts(toggled, { type: "toggle", id: "a.json", disabled: false })).toBe(
      toggled,
    );
    expect(
      reduceCliProxyAccounts(loaded, { type: "toggleFailed", id: "a.json", error: "late" }),
    ).toBe(loaded);
  });

  it("keeps the optimistic value when a list fetched mid-toggle still has the old one", () => {
    const toggled = reduceCliProxyAccounts(loaded, {
      type: "toggle",
      id: "a.json",
      disabled: true,
    });
    const reloaded = reduceCliProxyAccounts(toggled, {
      type: "loaded",
      accounts: [account("a.json"), account("b.json", true)],
    });
    expect(reloaded.accounts?.[0]?.disabled).toBe(true);
    expect(reloaded.pending["a.json"]).toBeDefined();
  });

  it("removes an account on success and reports a failed removal inline", () => {
    const removing = reduceCliProxyAccounts(loaded, { type: "remove", id: "a.json" });
    expect(removing.pending["a.json"]).toEqual({ _tag: "remove" });
    const removed = reduceCliProxyAccounts(removing, { type: "removed", id: "a.json" });
    expect(removed.accounts?.map((entry) => entry.id)).toEqual(["b.json"]);
    expect(removed.pending).toEqual({});

    const failed = reduceCliProxyAccounts(removing, {
      type: "removeFailed",
      id: "a.json",
      error: "sidecar refused",
    });
    expect(failed.accounts?.length).toBe(2);
    expect(failed.rowErrors).toEqual({ "a.json": "sidecar refused" });
  });

  it("keeps the last list when a reload fails, and clears the error on the next success", () => {
    const failed = reduceCliProxyAccounts(loaded, { type: "loadFailed", error: "offline" });
    expect(failed.accounts?.length).toBe(2);
    expect(failed.error).toBe("offline");
    expect(reduceCliProxyAccounts(failed, { type: "loaded", accounts: [] }).error).toBeNull();
  });
});

describe("reduceCliProxyLoginFlow", () => {
  const started = {
    sessionId: "session-1",
    authUrl: "https://auth.example.test/start",
    flow: "redirect" as const,
  };
  const pending = (): CliProxyLoginFlowState =>
    reduceCliProxyLoginFlow(
      reduceCliProxyLoginFlow(IDLE_LOGIN_FLOW, { type: "start", provider: "codex" }),
      { type: "started", started },
    );

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
    expect(waiting).toMatchObject({ _tag: "pending", flow: "device", userCode: "ABCD-EFGH" });
    expect(pendingCliProxyLoginSession(waiting)).toBe("session-1");
    const done = reduceCliProxyLoginFlow(waiting, {
      type: "status",
      status: { sessionId: "session-1", status: "completed", accountId: "claude-1.json" },
    });
    expect(done).toEqual({ _tag: "completed", provider: "anthropic", accountId: "claude-1.json" });
    expect(pendingCliProxyLoginSession(done)).toBeNull();
  });

  it("ignores answers for another session and a second start while pending", () => {
    const waiting = pending();
    expect(
      reduceCliProxyLoginFlow(waiting, {
        type: "status",
        status: { sessionId: "session-0", status: "completed" },
      }),
    ).toBe(waiting);
    expect(reduceCliProxyLoginFlow(waiting, { type: "start", provider: "xai" })).toBe(waiting);
  });

  it("keeps polling through a pasted redirect and surfaces a rejected one", () => {
    const submitting = reduceCliProxyLoginFlow(pending(), { type: "pasteRedirect" });
    expect(submitting).toMatchObject({ _tag: "pending", submittingRedirect: true });
    expect(pendingCliProxyLoginSession(submitting)).toBe("session-1");
    const rejected = reduceCliProxyLoginFlow(submitting, {
      type: "redirectFailed",
      sessionId: "session-1",
      error: "bad state",
    });
    expect(rejected).toMatchObject({ submittingRedirect: false, redirectError: "bad state" });
    expect(reduceCliProxyLoginFlow(rejected, { type: "pasteRedirect" })).toMatchObject({
      submittingRedirect: true,
      redirectError: null,
    });
  });

  it("cancels optimistically, reports failures, and resets to idle", () => {
    expect(reduceCliProxyLoginFlow(pending(), { type: "cancel" })).toEqual({
      _tag: "cancelled",
      provider: "codex",
    });
    expect(
      reduceCliProxyLoginFlow(pending(), {
        type: "status",
        status: { sessionId: "session-1", status: "failed" },
      }),
    ).toMatchObject({ _tag: "failed", error: expect.any(String) });
    expect(
      reduceCliProxyLoginFlow(
        reduceCliProxyLoginFlow(IDLE_LOGIN_FLOW, { type: "start", provider: "kimi" }),
        { type: "startFailed", error: "503" },
      ),
    ).toEqual({ _tag: "failed", provider: "kimi", error: "503" });
    expect(reduceCliProxyLoginFlow(pending(), { type: "reset" })).toBe(IDLE_LOGIN_FLOW);
  });
});

describe("polling decisions", () => {
  it("polls status only while focused and the app is active", () => {
    expect(shouldPollCliProxyStatus({ focused: true, appState: "active" })).toBe(true);
    expect(shouldPollCliProxyStatus({ focused: false, appState: "active" })).toBe(false);
    expect(shouldPollCliProxyStatus({ focused: true, appState: "background" })).toBe(false);
    expect(shouldPollCliProxyStatus({ focused: true, appState: "inactive" })).toBe(false);
  });

  it("keeps polling a restart until ready or failed, then gives up at the deadline", () => {
    expect(nextRestartStep({ state: "starting", elapsedMs: 0 })).toBe("poll");
    expect(nextRestartStep({ state: "off", elapsedMs: 4_000 })).toBe("poll");
    expect(nextRestartStep({ state: "ready", elapsedMs: 4_000 })).toBe("settled");
    expect(nextRestartStep({ state: "failed", elapsedMs: 4_000 })).toBe("settled");
    expect(nextRestartStep({ state: "starting", elapsedMs: CLIPROXY_RESTART_TIMEOUT_MS })).toBe(
      "timeout",
    );
    expect(nextRestartStep({ state: "ready", elapsedMs: CLIPROXY_RESTART_TIMEOUT_MS + 1 })).toBe(
      "settled",
    );
  });
});

describe("summarizeCliProxyOverviews", () => {
  it("stays empty until every environment answered", () => {
    expect(summarizeCliProxyOverviews([])).toBeUndefined();
    expect(
      summarizeCliProxyOverviews([
        { _tag: "loaded", state: "ready", accountCount: 2 },
        { _tag: "loading" },
      ]),
    ).toBeUndefined();
  });

  it("sums the counts across environments", () => {
    expect(
      summarizeCliProxyOverviews([
        { _tag: "loaded", state: "ready", accountCount: 2 },
        { _tag: "loaded", state: "starting", accountCount: null },
        { _tag: "loaded", state: "ready", accountCount: 1 },
      ]),
    ).toBe("3 accounts");
    expect(summarizeCliProxyOverviews([{ _tag: "loaded", state: "ready", accountCount: 1 }])).toBe(
      "1 account",
    );
  });

  it("falls back to the state that explains a missing count", () => {
    expect(
      summarizeCliProxyOverviews([{ _tag: "loaded", state: "starting", accountCount: null }]),
    ).toBe("Starting");
    expect(
      summarizeCliProxyOverviews([{ _tag: "loaded", state: "ready", accountCount: null }]),
    ).toBe("Unavailable");
    expect(summarizeCliProxyOverviews([{ _tag: "error" }])).toBe("Unreachable");
  });
});

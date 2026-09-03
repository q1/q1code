import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  CLIPROXY_API_PATHS,
  CliProxyAccount,
  CliProxyAccountId,
  CliProxyHttpApi,
  CliProxyStatus,
  CliProxySyncBundle,
  CliProxyUnavailableError,
} from "./cliproxyApi.ts";

const decodeAccountId = Schema.decodeUnknownExit(CliProxyAccountId);
const decodeStatus = Schema.decodeUnknownExit(CliProxyStatus);
const decodeAccount = Schema.decodeUnknownExit(CliProxyAccount);
const decodeBundle = Schema.decodeUnknownExit(CliProxySyncBundle);
const encodeUnavailable = Schema.encodeUnknownSync(CliProxyUnavailableError);

describe("cliproxy api contract", () => {
  it("keeps every path under the fork prefix", () => {
    for (const path of Object.values(CLIPROXY_API_PATHS)) {
      expect(path.startsWith("/api/fork/cliproxy/")).toBe(true);
    }
  });

  it("declares every endpoint the client runtime calls", () => {
    const group = CliProxyHttpApi.groups.cliproxy;
    expect(Object.keys(group.endpoints).sort()).toEqual(
      [
        "cancelLogin",
        "deleteAccount",
        "getRouting",
        "getUsage",
        "listAccounts",
        "loginCallback",
        "loginStatus",
        "patchAccount",
        "restart",
        "setRouting",
        "startLogin",
        "status",
        "syncExport",
        "syncPush",
        "syncStatus",
      ].sort(),
    );
  });

  it("accepts only single-segment .json account ids", () => {
    expect(Exit.isSuccess(decodeAccountId("claude-me@example.com.json"))).toBe(true);
    expect(Exit.isFailure(decodeAccountId("../escape.json"))).toBe(true);
    expect(Exit.isFailure(decodeAccountId("nested/file.json"))).toBe(true);
    expect(Exit.isFailure(decodeAccountId("config.yaml"))).toBe(true);
  });

  it("round-trips the status, account, and sync bundle shapes", () => {
    const status = decodeStatus({
      state: "ready",
      port: 8317,
      version: "7.2.147",
      role: "replica",
      lastSyncAt: "2026-09-02T00:00:00.000Z",
    });
    expect(Exit.isSuccess(status)).toBe(true);
    const account = decodeAccount({
      id: "codex-a.json",
      provider: "codex",
      label: "a@example.com",
      disabled: false,
      updatedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(Exit.isSuccess(account)).toBe(true);
    const withUsage = decodeAccount({
      id: "codex-a.json",
      provider: "codex",
      label: "a@example.com",
      disabled: false,
      updatedAt: "2026-09-02T00:00:00.000Z",
      usage: { success: 12, failed: 1, quota: { signals: { "5h": "ok" } } },
    });
    expect(Exit.isSuccess(withUsage) && withUsage.value.usage?.success).toBe(12);
    const bundle = decodeBundle({
      version: 2,
      generatedAt: "2026-09-02T00:00:00.000Z",
      primaryEnvironmentId: "env-1",
      entries: [{ id: "codex-a.json", updatedAt: "2026-09-02T00:00:00.000Z", ciphertext: "AA==" }],
      tombstones: [{ id: "gone.json", deletedAt: "2026-09-01T00:00:00.000Z" }],
    });
    expect(Exit.isSuccess(bundle)).toBe(true);
    expect(Exit.isFailure(decodeBundle({ version: 3 }))).toBe(true);
  });

  it("still decodes a version 1 bundle, which has no tombstones", () => {
    const bundle = decodeBundle({
      version: 1,
      generatedAt: "2026-09-02T00:00:00.000Z",
      primaryEnvironmentId: "env-1",
      entries: [],
    });
    expect(Exit.isSuccess(bundle) && bundle.value.tombstones).toBeUndefined();
    expect(Exit.isSuccess(bundle)).toBe(true);
    expect(
      Exit.isFailure(
        decodeBundle({
          version: 2,
          generatedAt: "2026-09-02T00:00:00.000Z",
          primaryEnvironmentId: "env-1",
          entries: [],
          tombstones: [{ id: "../escape.json", deletedAt: "2026-09-01T00:00:00.000Z" }],
        }),
      ),
    ).toBe(true);
  });

  it("serializes the unavailable error with its reason and state", () => {
    const error = new CliProxyUnavailableError({ reason: "flag-off", state: "off" });
    expect(encodeUnavailable(error)).toEqual({
      _tag: "CliProxyUnavailableError",
      reason: "flag-off",
      state: "off",
    });
    expect(error.message).toContain("flag-off");
  });
});

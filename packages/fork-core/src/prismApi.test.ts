import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  PRISM_API_PATHS,
  PrismAccount,
  PrismAccountId,
  PrismHttpApi,
  PrismStatus,
  PrismSyncBundle,
  PrismUnavailableError,
} from "./prismApi.ts";

const decodeAccountId = Schema.decodeUnknownExit(PrismAccountId);
const decodeStatus = Schema.decodeUnknownExit(PrismStatus);
const decodeAccount = Schema.decodeUnknownExit(PrismAccount);
const decodeBundle = Schema.decodeUnknownExit(PrismSyncBundle);
const encodeUnavailable = Schema.encodeUnknownSync(PrismUnavailableError);

describe("prism api contract", () => {
  it("keeps every path under the fork prefix", () => {
    for (const path of Object.values(PRISM_API_PATHS)) {
      expect(path.startsWith("/api/fork/prism/")).toBe(true);
    }
  });

  it("declares every endpoint the client runtime calls", () => {
    const group = PrismHttpApi.groups.prism;
    expect(Object.keys(group.endpoints).sort()).toEqual(
      [
        "cancelLogin",
        "deleteAccount",
        "getRouting",
        "getUsage",
        "identityAccess",
        "identityConfig",
        "listAccounts",
        "loginCallback",
        "loginStatus",
        "patchAccount",
        "restart",
        "setUsageSource",
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
    const error = new PrismUnavailableError({ reason: "flag-off", state: "off" });
    expect(encodeUnavailable(error)).toEqual({
      _tag: "PrismUnavailableError",
      reason: "flag-off",
      state: "off",
    });
    expect(error.message).toContain("flag-off");
  });
});

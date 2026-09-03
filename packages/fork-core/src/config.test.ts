import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";
import {
  CLIPROXY_DEFAULT_API_KEY_SECRET_NAME,
  CLIPROXY_DEFAULT_MANAGEMENT_SECRET_NAME,
  decodeForkConfig,
  decodeForkConfigJson,
} from "./config.ts";

describe("fork config", () => {
  it("decodes a flags section", () => {
    const exit = decodeForkConfig({ flags: { "update-check": true } });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ flags: { "update-check": true } });
  });

  it("accepts an empty object", () => {
    expect(Exit.isSuccess(decodeForkConfig({}))).toBe(true);
  });

  it("drops unknown sections and unknown flag keys", () => {
    const exit = decodeForkConfig({
      flags: { cliproxy: true, "not-a-flag": "whatever" },
      future: { anything: 1 },
    });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ flags: { cliproxy: true } });
  });

  it("rejects non-boolean values for known flags", () => {
    expect(Exit.isFailure(decodeForkConfig({ flags: { cliproxy: "yes" } }))).toBe(true);
  });

  it("decodes raw JSON text and rejects malformed text", () => {
    const ok = decodeForkConfigJson('{"flags":{"cliproxy":true}}');
    expect(Exit.isSuccess(ok) && ok.value).toEqual({ flags: { cliproxy: true } });
    expect(Exit.isFailure(decodeForkConfigJson("{not json"))).toBe(true);
  });

  it("decodes the cliproxy section and drops unknown keys inside it", () => {
    const exit = decodeForkConfig({
      cliproxy: {
        port: 9000,
        routingStrategy: "fill-first",
        binaryPath: "/opt/cli-proxy-api",
        releaseVersion: "7.2.200",
        future: true,
      },
    });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      cliproxy: {
        port: 9000,
        routingStrategy: "fill-first",
        binaryPath: "/opt/cli-proxy-api",
        releaseVersion: "7.2.200",
      },
    });
  });

  it("decodes the cliproxy sync section and rejects a bad role or interval", () => {
    const exit = decodeForkConfig({
      cliproxy: {
        sync: {
          role: "replica",
          primaryUrl: "http://spark-01:3774",
          tokenSecretName: "cliproxy-sync-token",
          intervalSeconds: 60,
          extra: 1,
        },
      },
    });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      cliproxy: {
        sync: {
          role: "replica",
          primaryUrl: "http://spark-01:3774",
          tokenSecretName: "cliproxy-sync-token",
          intervalSeconds: 60,
        },
      },
    });
    expect(Exit.isFailure(decodeForkConfig({ cliproxy: { sync: { role: "leader" } } }))).toBe(true);
    expect(
      Exit.isFailure(
        decodeForkConfig({ cliproxy: { sync: { role: "primary", intervalSeconds: 1 } } }),
      ),
    ).toBe(true);
  });

  it("decodes the cliproxy mode and external section, leaving the mode unset by default", () => {
    const exit = decodeForkConfig({
      cliproxy: {
        mode: "external",
        external: {
          baseUrl: "http://127.0.0.1:8317",
          managementSecretName: "prism-management",
          authDir: "/var/lib/prism/auths",
          extra: 1,
        },
      },
    });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      cliproxy: {
        mode: "external",
        external: {
          baseUrl: "http://127.0.0.1:8317",
          managementSecretName: "prism-management",
          authDir: "/var/lib/prism/auths",
        },
      },
    });
    const sidecar = decodeForkConfig({ cliproxy: { port: 9000 } });
    expect(Exit.isSuccess(sidecar) && sidecar.value.cliproxy?.mode).toBeUndefined();
    expect(Exit.isFailure(decodeForkConfig({ cliproxy: { mode: "container" } }))).toBe(true);
    expect(Exit.isFailure(decodeForkConfig({ cliproxy: { external: {} } }))).toBe(true);
    expect(CLIPROXY_DEFAULT_MANAGEMENT_SECRET_NAME).toBe("cliproxy-management-secret");
    expect(CLIPROXY_DEFAULT_API_KEY_SECRET_NAME).toBe("cliproxy-api-key");
  });

  it("rejects an out-of-range port or an unknown routing strategy", () => {
    expect(Exit.isFailure(decodeForkConfig({ cliproxy: { port: 70000 } }))).toBe(true);
    expect(Exit.isFailure(decodeForkConfig({ cliproxy: { port: 80.5 } }))).toBe(true);
    expect(Exit.isFailure(decodeForkConfig({ cliproxy: { routingStrategy: "random" } }))).toBe(
      true,
    );
  });
});

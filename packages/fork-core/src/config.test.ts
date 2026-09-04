import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";
import {
  PRISM_DEFAULT_API_KEY_SECRET_NAME,
  PRISM_DEFAULT_MANAGEMENT_SECRET_NAME,
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
      flags: { prism: true, "not-a-flag": "whatever" },
      future: { anything: 1 },
    });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ flags: { prism: true } });
  });

  it("rejects non-boolean values for known flags", () => {
    expect(Exit.isFailure(decodeForkConfig({ flags: { prism: "yes" } }))).toBe(true);
  });

  it("decodes raw JSON text and rejects malformed text", () => {
    const ok = decodeForkConfigJson('{"flags":{"prism":true}}');
    expect(Exit.isSuccess(ok) && ok.value).toEqual({ flags: { prism: true } });
    expect(Exit.isFailure(decodeForkConfigJson("{not json"))).toBe(true);
  });

  it("decodes the prism section and drops unknown keys inside it", () => {
    const exit = decodeForkConfig({
      prism: {
        port: 9000,
        routingStrategy: "fill-first",
        binaryPath: "/opt/cli-proxy-api",
        releaseVersion: "7.2.200",
        future: true,
      },
    });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      prism: {
        port: 9000,
        routingStrategy: "fill-first",
        binaryPath: "/opt/cli-proxy-api",
        releaseVersion: "7.2.200",
      },
    });
  });

  it("decodes the prism sync section and rejects a bad role or interval", () => {
    const exit = decodeForkConfig({
      prism: {
        sync: {
          role: "replica",
          primaryUrl: "http://spark-01:3774",
          tokenSecretName: "prism-sync-token",
          intervalSeconds: 60,
          extra: 1,
        },
      },
    });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      prism: {
        sync: {
          role: "replica",
          primaryUrl: "http://spark-01:3774",
          tokenSecretName: "prism-sync-token",
          intervalSeconds: 60,
        },
      },
    });
    expect(Exit.isFailure(decodeForkConfig({ prism: { sync: { role: "leader" } } }))).toBe(true);
    expect(
      Exit.isFailure(
        decodeForkConfig({ prism: { sync: { role: "primary", intervalSeconds: 1 } } }),
      ),
    ).toBe(true);
  });

  it("decodes the prism mode and external section, leaving the mode unset by default", () => {
    const exit = decodeForkConfig({
      prism: {
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
      prism: {
        mode: "external",
        external: {
          baseUrl: "http://127.0.0.1:8317",
          managementSecretName: "prism-management",
          authDir: "/var/lib/prism/auths",
        },
      },
    });
    const sidecar = decodeForkConfig({ prism: { port: 9000 } });
    expect(Exit.isSuccess(sidecar) && sidecar.value.prism?.mode).toBeUndefined();
    expect(Exit.isFailure(decodeForkConfig({ prism: { mode: "container" } }))).toBe(true);
    expect(Exit.isFailure(decodeForkConfig({ prism: { external: {} } }))).toBe(true);
    expect(PRISM_DEFAULT_MANAGEMENT_SECRET_NAME).toBe("prism-management-secret");
    expect(PRISM_DEFAULT_API_KEY_SECRET_NAME).toBe("prism-api-key");
  });

  it("rejects an out-of-range port or an unknown routing strategy", () => {
    expect(Exit.isFailure(decodeForkConfig({ prism: { port: 70000 } }))).toBe(true);
    expect(Exit.isFailure(decodeForkConfig({ prism: { port: 80.5 } }))).toBe(true);
    expect(Exit.isFailure(decodeForkConfig({ prism: { routingStrategy: "random" } }))).toBe(true);
  });
});

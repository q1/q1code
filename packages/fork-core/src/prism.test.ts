import { assert, it } from "@effect/vitest";

import {
  PRISM_PIN,
  prismAssetName,
  prismChecksumsUrl,
  prismExecutableName,
  prismPlatformKey,
  prismReleaseUrl,
  prismAccountHealth,
} from "./prism.ts";

it("distinguishes renewal, reauthentication, cooldown, and unknown account state", () => {
  const now = Date.parse("2026-09-04T12:00:00Z");
  assert.equal(prismAccountHealth({ disabled: false }, now), "unknown");
  assert.equal(
    prismAccountHealth({ disabled: false, lifecycle: { status: "active" } }, now),
    "ready",
  );
  assert.equal(
    prismAccountHealth(
      { disabled: false, lifecycle: { status: "active", expiresAt: "2026-09-04T11:00:00Z" } },
      now,
    ),
    "expired",
  );
  assert.equal(
    prismAccountHealth(
      {
        disabled: false,
        lifecycle: {
          status: "error",
          unavailable: true,
          lastErrorStatus: 401,
          requiresLogin: true,
        },
      },
      now,
    ),
    "needs-login",
  );
  assert.equal(
    prismAccountHealth(
      {
        disabled: false,
        lifecycle: { unavailable: true, lastErrorStatus: 429, retryAt: "2026-09-04T13:00:00Z" },
      },
      now,
    ),
    "cooldown",
  );
  assert.equal(
    prismAccountHealth(
      { disabled: false, lifecycle: { unavailable: true, lastErrorStatus: 503 } },
      now,
    ),
    "unavailable",
  );
  assert.equal(
    prismAccountHealth({ disabled: true, lifecycle: { status: "active" } }, now),
    "disabled",
  );
});

it("maps host platforms to release targets the way the resource monitor does", () => {
  assert.equal(prismPlatformKey("darwin", "arm64"), "darwin-arm64");
  assert.equal(prismPlatformKey("linux", "x64"), "linux-x64");
  assert.equal(prismPlatformKey("linux", "arm64"), "linux-arm64");
  assert.equal(prismPlatformKey("win32", "x64"), "win32-x64");
  assert.equal(prismPlatformKey("freebsd", "x64"), undefined);
  assert.equal(prismPlatformKey("linux", "ia32"), undefined);
});

it("names assets from the pin and an explicit version", () => {
  assert.equal(
    prismAssetName("darwin", "arm64"),
    `CLIProxyAPI_${PRISM_PIN.version}_darwin_aarch64.tar.gz`,
  );
  assert.equal(prismAssetName("linux", "x64", "1.2.3"), "CLIProxyAPI_1.2.3_linux_amd64.tar.gz");
  assert.equal(prismAssetName("win32", "x64", "1.2.3"), "CLIProxyAPI_1.2.3_windows_amd64.zip");
  assert.equal(prismAssetName("aix", "x64"), undefined);
});

it("builds release URLs under the pinned repository tag", () => {
  assert.equal(
    prismReleaseUrl("linux", "arm64", "7.2.147"),
    "https://github.com/q1/prism/releases/download/v7.2.147/CLIProxyAPI_7.2.147_linux_aarch64.tar.gz",
  );
  assert.equal(
    prismChecksumsUrl("7.2.147"),
    "https://github.com/q1/prism/releases/download/v7.2.147/checksums.txt",
  );
  assert.equal(prismReleaseUrl("sunos", "x64"), undefined);
});

it("uses the archive's executable name per platform", () => {
  assert.equal(prismExecutableName("linux"), "cli-proxy-api");
  assert.equal(prismExecutableName("win32"), "cli-proxy-api.exe");
});

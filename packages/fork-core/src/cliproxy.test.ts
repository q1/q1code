import { assert, it } from "@effect/vitest";

import {
  CLIPROXY_PIN,
  cliproxyAssetName,
  cliproxyChecksumsUrl,
  cliproxyExecutableName,
  cliproxyPlatformKey,
  cliproxyReleaseUrl,
} from "./cliproxy.ts";

it("maps host platforms to release targets the way the resource monitor does", () => {
  assert.equal(cliproxyPlatformKey("darwin", "arm64"), "darwin-arm64");
  assert.equal(cliproxyPlatformKey("linux", "x64"), "linux-x64");
  assert.equal(cliproxyPlatformKey("linux", "arm64"), "linux-arm64");
  assert.equal(cliproxyPlatformKey("win32", "x64"), "win32-x64");
  assert.equal(cliproxyPlatformKey("freebsd", "x64"), undefined);
  assert.equal(cliproxyPlatformKey("linux", "ia32"), undefined);
});

it("names assets from the pin and an explicit version", () => {
  assert.equal(
    cliproxyAssetName("darwin", "arm64"),
    `CLIProxyAPI_${CLIPROXY_PIN.version}_darwin_aarch64.tar.gz`,
  );
  assert.equal(cliproxyAssetName("linux", "x64", "1.2.3"), "CLIProxyAPI_1.2.3_linux_amd64.tar.gz");
  assert.equal(cliproxyAssetName("win32", "x64", "1.2.3"), "CLIProxyAPI_1.2.3_windows_amd64.zip");
  assert.equal(cliproxyAssetName("aix", "x64"), undefined);
});

it("builds release URLs under the pinned repository tag", () => {
  assert.equal(
    cliproxyReleaseUrl("linux", "arm64", "7.2.147"),
    "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.147/CLIProxyAPI_7.2.147_linux_aarch64.tar.gz",
  );
  assert.equal(
    cliproxyChecksumsUrl("7.2.147"),
    "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.147/checksums.txt",
  );
  assert.equal(cliproxyReleaseUrl("sunos", "x64"), undefined);
});

it("uses the archive's executable name per platform", () => {
  assert.equal(cliproxyExecutableName("linux"), "cli-proxy-api");
  assert.equal(cliproxyExecutableName("win32"), "cli-proxy-api.exe");
});

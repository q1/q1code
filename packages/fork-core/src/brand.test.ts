import { assert, it } from "@effect/vitest";

import {
  BRAND,
  formatAboutVersion,
  manualInstallCommand,
  releaseChecksumsUrl,
  releaseInstallScriptUrl,
  releaseTarballName,
  releaseTarballUrl,
  upstreamVersionOf,
} from "./brand.ts";

it("derives release asset URLs from the exact version", () => {
  assert.equal(releaseTarballName("0.0.39-q1.3"), "q1code-0.0.39-q1.3.tgz");
  assert.equal(
    releaseTarballUrl("0.0.39-q1.3"),
    "https://github.com/q1/q1code/releases/download/v0.0.39-q1.3/q1code-0.0.39-q1.3.tgz",
  );
  assert.equal(
    releaseChecksumsUrl("0.0.39-q1.3"),
    "https://github.com/q1/q1code/releases/download/v0.0.39-q1.3/checksums.txt",
  );
  assert.equal(
    releaseInstallScriptUrl("0.0.39-q1.3"),
    "https://github.com/q1/q1code/releases/download/v0.0.39-q1.3/install.sh",
  );
});

it("renders the manual install command with the pinned version", () => {
  assert.equal(
    manualInstallCommand("0.0.39-q1.3"),
    "curl -fsSL https://github.com/q1/q1code/releases/download/v0.0.39-q1.3/install.sh | sh -s -- 0.0.39-q1.3",
  );
});

it("maps q1code versions back to their upstream version", () => {
  assert.equal(upstreamVersionOf("0.0.39-q1.3"), "0.0.39");
  assert.equal(upstreamVersionOf("0.0.39-q1nightly.20260901.12"), "0.0.39");
  assert.equal(upstreamVersionOf("0.0.39"), "0.0.39");
  assert.equal(upstreamVersionOf("0.0.39-nightly.20260901.12"), "0.0.39-nightly.20260901.12");
  assert.equal(formatAboutVersion("0.0.39-q1.3"), "0.0.39-q1.3 on T3 Code 0.0.39");
});

it("keeps the identity frozen", () => {
  assert.isTrue(Object.isFrozen(BRAND));
  assert.equal(BRAND.runtimeEntryRelativePath, `node_modules/${BRAND.packageName}/dist/bin.mjs`);
});

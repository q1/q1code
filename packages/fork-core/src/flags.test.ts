import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_FORK_FLAGS,
  FORK_FLAGS,
  envVarForFlag,
  isForkFlagKey,
  resolveForkFlags,
} from "./flags.ts";

describe("fork flags", () => {
  it("derives env var names from slugs", () => {
    expect(envVarForFlag("update-check")).toBe("T3FORK_UPDATE_CHECK");
    expect(envVarForFlag("prism")).toBe("T3FORK_PRISM");
  });

  it("falls back to registry defaults when nothing is set", () => {
    expect(resolveForkFlags({})).toEqual(DEFAULT_FORK_FLAGS);
    expect(DEFAULT_FORK_FLAGS["update-check"]).toBe(FORK_FLAGS["update-check"].default);
  });

  it("file values beat defaults", () => {
    expect(resolveForkFlags({ file: { "update-check": true } })["update-check"]).toBe(true);
  });

  it("env beats file, accepting 1/0 and true/false", () => {
    const file = { "update-check": true, prism: true };
    expect(resolveForkFlags({ env: { T3FORK_UPDATE_CHECK: "0" }, file })["update-check"]).toBe(
      false,
    );
    expect(resolveForkFlags({ env: { T3FORK_PRISM: "false" }, file }).prism).toBe(false);
    expect(resolveForkFlags({ env: { T3FORK_UPDATE_CHECK: "1" } })["update-check"]).toBe(true);
    expect(resolveForkFlags({ env: { T3FORK_PRISM: "TRUE" } }).prism).toBe(true);
  });

  it("ignores unparseable env values and falls through to the file", () => {
    expect(
      resolveForkFlags({ env: { T3FORK_UPDATE_CHECK: "yes" }, file: { "update-check": true } })[
        "update-check"
      ],
    ).toBe(true);
  });

  it("ignores unknown keys in env and file", () => {
    const resolved = resolveForkFlags({
      env: { T3FORK_NOT_A_FLAG: "1" },
      file: { "not-a-flag": true },
    });
    expect(resolved).toEqual(DEFAULT_FORK_FLAGS);
    expect(Object.keys(resolved)).toEqual(Object.keys(FORK_FLAGS));
    expect(isForkFlagKey("not-a-flag")).toBe(false);
    expect(isForkFlagKey("prism")).toBe(true);
  });
});

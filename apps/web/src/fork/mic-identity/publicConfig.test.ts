import { describe, expect, it } from "vite-plus/test";

import { resolveMicIdentityBuildConfig } from "./publicConfig";

const configured = {
  hosted: true,
  enabled: "1",
  authorityUrl: "https://identity.example.test",
  clerkPublishableKey: "pk_test_cHVibGljLWtleQ",
};

describe("hosted mic.sc identity bootstrap", () => {
  it("stays off by default even when public configuration is present", () => {
    expect(resolveMicIdentityBuildConfig({ hosted: true })).toEqual({ _tag: "disabled" });
    expect(resolveMicIdentityBuildConfig({ ...configured, enabled: "" })).toEqual({
      _tag: "disabled",
    });
    expect(resolveMicIdentityBuildConfig({ ...configured, enabled: "false" })).toEqual({
      _tag: "disabled",
    });
  });

  it("does not bypass the local app's environment pairing", () => {
    expect(resolveMicIdentityBuildConfig({ ...configured, hosted: false })).toEqual({
      _tag: "disabled",
    });
  });

  it("provides a complete hosted bootstrap without an environment or connection credential", () => {
    expect(resolveMicIdentityBuildConfig(configured)).toEqual({
      _tag: "configured",
      config: {
        enabled: true,
        authorityUrl: configured.authorityUrl,
        clerkPublishableKey: configured.clerkPublishableKey,
      },
    });
  });

  it("normalizes explicit opt-in and surrounding whitespace", () => {
    const result = resolveMicIdentityBuildConfig({
      ...configured,
      enabled: " TRUE ",
      authorityUrl: ` ${configured.authorityUrl}/ `,
      clerkPublishableKey: ` ${configured.clerkPublishableKey} `,
    });
    expect(result).toEqual(resolveMicIdentityBuildConfig(configured));
  });

  it.each([
    undefined,
    "http://identity.example.test",
    "https://user:password@identity.example.test",
    "https://identity.example.test?token=value",
    "https://identity.example.test/#other",
    "/identity",
  ])("rejects unsafe or incomplete authority configuration: %s", (authorityUrl) => {
    expect(
      resolveMicIdentityBuildConfig({
        ...configured,
        ...(authorityUrl === undefined ? { authorityUrl: "" } : { authorityUrl }),
      })._tag,
    ).toBe("invalid");
  });

  it("allows a loopback authority for isolated hosted acceptance", () => {
    expect(
      resolveMicIdentityBuildConfig({ ...configured, authorityUrl: "http://127.0.0.1:8318" })._tag,
    ).toBe("configured");
  });

  it.each(["", "sk_test_not-public", "pk_live_<script>"])(
    "does not accept missing or non-publishable Clerk keys: %s",
    (clerkPublishableKey) => {
      expect(resolveMicIdentityBuildConfig({ ...configured, clerkPublishableKey })._tag).toBe(
        "invalid",
      );
    },
  );
});

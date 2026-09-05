import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { freshMicMobileToken, resolveMicMobileIdentityMode } from "./micIdentity.logic";

const config = {
  enabled: true,
  clerkPublishableKey: "mic-key",
  authorityUrl: "https://identity.example.test",
};

describe("mobile mic.sc identity boundary", () => {
  it("leaves an off feature inert, even with a different existing identity", () => {
    expect(resolveMicMobileIdentityMode({ enabled: false }, "t3-key", true)).toBe("off");
  });

  it("reuses only the exact mic.sc account service configured by the authenticated environment", () => {
    expect(resolveMicMobileIdentityMode(config, "mic-key", false)).toBe("shared");
    expect(resolveMicMobileIdentityMode(config, "t3-key", true)).toBe("incompatible");
  });

  it("permits a local provider only when it cannot replace another Clerk singleton", () => {
    expect(resolveMicMobileIdentityMode(config, null, true)).toBe("local");
    expect(resolveMicMobileIdentityMode(config, null, false)).toBe("incompatible");
    expect(resolveMicMobileIdentityMode({ enabled: true }, null, true)).toBe("unconfigured");
  });

  it.effect("mints a fresh Convex JWT for each operation", () =>
    Effect.gen(function* () {
      const options: Array<{ template: string; skipCache: boolean }> = [];
      const source = freshMicMobileToken(
        async (input) => {
          options.push(input);
          return `token-${options.length}`;
        },
        () => true,
      );
      expect(yield* source()).toBe("token-1");
      expect(yield* source()).toBe("token-2");
      expect(options).toEqual([
        { template: "convex", skipCache: true },
        { template: "convex", skipCache: true },
      ]);
    }),
  );

  it.effect("does not ask Clerk for a previous account's token after sign-out", () =>
    Effect.gen(function* () {
      let reads = 0;
      const source = freshMicMobileToken(
        async () => {
          reads += 1;
          return "token";
        },
        () => false,
      );
      expect(yield* source()).toBeNull();
      expect(reads).toBe(0);
    }),
  );

  it.effect("discards a token minted while an account switch was in progress", () =>
    Effect.gen(function* () {
      let current = true;
      const source = freshMicMobileToken(
        async () => {
          current = false;
          return "previous-account-token";
        },
        () => current,
      );
      expect(yield* source()).toBeNull();
    }),
  );

  it.effect("reports sign-in failure without carrying SDK errors or credentials", () =>
    Effect.gen(function* () {
      const source = freshMicMobileToken(
        async () => {
          throw new Error("private-sdk-detail");
        },
        () => true,
      );
      const result = yield* source().pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.message).toBe("Sign in to mic.sc to continue.");
    }),
  );
});

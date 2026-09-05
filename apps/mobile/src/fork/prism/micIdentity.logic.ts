import { MicIdentityUnauthorizedError } from "@q1code/core/micIdentity";
import type { MicIdentityPublicConfig } from "@q1code/core/micIdentityApi";
import type { MicIdentityTokenSource } from "@t3tools/client-runtime/fork";
import * as Effect from "effect/Effect";

/** Clerk's native singleton cannot serve two issuers at once. */
export function resolveMicMobileIdentityMode(
  config: MicIdentityPublicConfig,
  existingProviderKey: string | null,
  allowLocalProvider: boolean,
): "off" | "unconfigured" | "shared" | "local" | "incompatible" {
  if (!config.enabled) return "off";
  if (!config.clerkPublishableKey || !config.authorityUrl) return "unconfigured";
  if (existingProviderKey === config.clerkPublishableKey) return "shared";
  if (existingProviderKey !== null || !allowLocalProvider) return "incompatible";
  return "local";
}

/** The authority requires the default session JWT (including sid), never a Convex template. */
export function freshMicMobileToken(
  read: (options: { skipCache: boolean }) => Promise<string | null>,
  isCurrent: () => boolean,
): MicIdentityTokenSource {
  return () =>
    Effect.tryPromise({
      try: async () => {
        if (!isCurrent()) return null;
        const token = await read({ skipCache: true });
        return isCurrent() ? token : null;
      },
      catch: () => new MicIdentityUnauthorizedError({ reason: "sign-in-required" }),
    });
}

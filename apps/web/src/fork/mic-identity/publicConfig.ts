import type { MicIdentityPublicConfig } from "@q1code/core/micIdentityApi";
import { MicIdentityServiceUrl } from "@q1code/core/micIdentity";
import * as Schema from "effect/Schema";

import { isElectron } from "~/env";
import { isHostedStaticApp } from "~/hostedPairing";

export type MicIdentityBuildConfig =
  | { readonly _tag: "disabled" }
  | { readonly _tag: "invalid"; readonly error: string }
  | { readonly _tag: "configured"; readonly config: MicIdentityPublicConfig };

const isMicIdentityServiceUrl = Schema.is(MicIdentityServiceUrl);

/** Public build settings authorize no environment access and are inert outside the hosted app. */
export function resolveMicIdentityBuildConfig(input: {
  readonly hosted: boolean;
  readonly enabled?: string;
  readonly authorityUrl?: string;
  readonly clerkPublishableKey?: string;
}): MicIdentityBuildConfig {
  if (!input.hosted || !["1", "true"].includes(input.enabled?.trim().toLowerCase() ?? "")) {
    return { _tag: "disabled" };
  }
  const authorityUrl = input.authorityUrl?.trim();
  const clerkPublishableKey = input.clerkPublishableKey?.trim();
  if (!authorityUrl || !isMicIdentityServiceUrl(authorityUrl)) {
    return {
      _tag: "invalid",
      error: "The hosted app's mic.sc identity service URL is missing or invalid.",
    };
  }
  if (!clerkPublishableKey || !/^pk_(?:test|live)_[A-Za-z0-9_+/=-]+$/.test(clerkPublishableKey)) {
    return { _tag: "invalid", error: "The hosted app's mic.sc sign-in key is missing or invalid." };
  }
  return {
    _tag: "configured",
    config: { enabled: true, authorityUrl: authorityUrl.replace(/\/$/, ""), clerkPublishableKey },
  };
}

export function readMicIdentityBuildConfig(): MicIdentityBuildConfig {
  return resolveMicIdentityBuildConfig({
    hosted: !isElectron && isHostedStaticApp(),
    enabled: import.meta.env.VITE_T3FORK_MIC_IDENTITY,
    authorityUrl: import.meta.env.VITE_MIC_SC_AUTHORITY_URL,
    clerkPublishableKey: import.meta.env.VITE_MIC_SC_CLERK_PUBLISHABLE_KEY,
  });
}

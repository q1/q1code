import * as Schema from "effect/Schema";
import { MicIdentitySession, MicPrismDiscovery } from "./micIdentity.ts";

export const MicIdentityPublicConfig = Schema.Struct({
  enabled: Schema.Boolean,
  clerkPublishableKey: Schema.optionalKey(Schema.String),
  authorityUrl: Schema.optionalKey(Schema.String),
});
export type MicIdentityPublicConfig = typeof MicIdentityPublicConfig.Type;

export const MicIdentityAccess = Schema.Struct({
  session: MicIdentitySession,
  discovery: MicPrismDiscovery,
});
export type MicIdentityAccess = typeof MicIdentityAccess.Type;

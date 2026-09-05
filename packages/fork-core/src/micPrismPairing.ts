import * as Schema from "effect/Schema";
import { MicIdentityServiceUrl } from "./micIdentity.ts";

const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:~-]{1,256}$/));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PairingRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const EpochMillis = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }),
);
export const MicPrismHostOrigin = MicIdentityServiceUrl.check(
  Schema.isMaxLength(256),
  Schema.makeFilter((value) => new URL(value).origin === value),
);
export const MicPrismHostPublicKey = Schema.String.check(
  Schema.isPattern(/^MCowBQYDK2VwAyEA[A-Za-z0-9_-]{43}$/),
);
const ChallengeId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);
const Label = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.makeFilter(
    (value) =>
      value === value.trim() &&
      Array.from(value).every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
  ),
);

export const MIC_PRISM_PAIRING_PATHS = {
  start: "/v1/prism/pairings/start",
  complete: "/v1/prism/pairings/complete",
  select: "/v1/prism/instances/select",
  revoke: "/v1/prism/instances/revoke",
} as const;
export const MicPrismPairingStart = Schema.Struct({
  origin: MicPrismHostOrigin,
  publicKey: MicPrismHostPublicKey,
  label: Label,
});
export type MicPrismPairingStart = typeof MicPrismPairingStart.Type;
export const MicPrismPairingChallenge = Schema.Struct({
  challengeId: ChallengeId,
  challenge: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  origin: MicPrismHostOrigin,
  publicKey: MicPrismHostPublicKey,
  expiresAt: EpochMillis,
});
export type MicPrismPairingChallenge = typeof MicPrismPairingChallenge.Type;
export const MicPrismPairingChallengePayload = Schema.Struct({
  domain: Schema.Literal("mic.sc/prism-pairing/v1"),
  challengeId: ChallengeId,
  nonce: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  subject: Identifier,
  origin: MicPrismHostOrigin,
  publicKey: MicPrismHostPublicKey,
  expiresAt: EpochMillis,
  expectedServiceInstanceId: Schema.NullOr(Identifier),
  expectedPairingRevision: Revision,
});
export const MicPrismPairingComplete = Schema.Struct({
  challengeId: ChallengeId,
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/)),
});
export type MicPrismPairingComplete = typeof MicPrismPairingComplete.Type;
export const MicPrismPairedInstance = Schema.Struct({
  serviceInstanceId: Identifier,
  pairingRevision: PairingRevision,
});
export type MicPrismPairedInstance = typeof MicPrismPairedInstance.Type;
export const MicPrismInstanceSelect = Schema.Struct({
  serviceInstanceId: Identifier,
  expectedSelectionRevision: Revision,
});
export type MicPrismInstanceSelect = typeof MicPrismInstanceSelect.Type;
export const MicPrismSelectedInstance = Schema.Struct({
  serviceInstanceId: Identifier,
  selectionRevision: Revision,
});
export type MicPrismSelectedInstance = typeof MicPrismSelectedInstance.Type;
export const MicPrismInstanceRevoke = Schema.Struct({
  serviceInstanceId: Identifier,
  expectedPairingRevision: PairingRevision,
});
export type MicPrismInstanceRevoke = typeof MicPrismInstanceRevoke.Type;
export const MicPrismRevokedInstance = Schema.Struct({
  serviceInstanceId: Identifier,
  pairingRevision: PairingRevision,
  selectionRevision: Revision,
});
export type MicPrismRevokedInstance = typeof MicPrismRevokedInstance.Type;

export class MicPrismPairingError extends Schema.TaggedErrorClass<MicPrismPairingError>()(
  "MicPrismPairingError",
  {
    reason: Schema.Literals([
      "invalid-input",
      "invalid-response",
      "conflict",
      "not-found",
      "host-unavailable",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid-input":
        return "Check the host origin, public key and pairing proof.";
      case "invalid-response":
        return "The host change could not be confirmed. Refresh its status before continuing.";
      case "conflict":
        return "The host or pairing changed. Refresh and start again.";
      case "not-found":
        return "This host or pairing request is no longer available.";
      case "host-unavailable":
        return "The host proof could not be reached. Check that it is served at the approved origin.";
    }
  }
}

/** Named adapters currently implemented by the independently authorized Prism gateway. */
import * as Schema from "effect/Schema";
import { PrismRoutingStrategy } from "./config.ts";

export const MIC_PRISM_API_PATHS = {
  status: "/prism/v1/status",
  routing: "/prism/v1/routing",
} as const;

export const MicPrismGatewayStatus = Schema.Struct({
  serviceInstanceId: Schema.String.check(Schema.isNonEmpty()),
  pairingRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  authorization: Schema.Literal("current"),
  // The initial gateway does not probe engine readiness or model eligibility.
  engineHealth: Schema.Literal("unknown"),
});
export type MicPrismGatewayStatus = typeof MicPrismGatewayStatus.Type;

export const MicPrismGatewayRouting = Schema.Struct({ strategy: PrismRoutingStrategy });
export type MicPrismGatewayRouting = typeof MicPrismGatewayRouting.Type;

export const MicPrismCredential = Schema.Struct({
  version: Schema.Literal(1),
  tokenType: Schema.Literal("Bearer"),
  token: Schema.String.check(Schema.isPattern(/^msp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)),
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
  serviceInstanceId: Schema.String.check(Schema.isNonEmpty()),
  pairingRevision: Schema.Int.check(Schema.isGreaterThan(0)),
});

/** Only catalogue identifiers are exposed; a listing is not a quota/eligibility claim. */
export const MicPrismModels = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)) }),
  ).check(Schema.isMaxLength(4096)),
});

export const MicPrismChatInput = Schema.Struct({
  model: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["user", "assistant"]),
      content: Schema.String.check(Schema.isMaxLength(131072)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
export type MicPrismChatInput = typeof MicPrismChatInput.Type;

export const MicPrismChatChunk = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      delta: Schema.Struct({ content: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
      finish_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});

export class MicPrismInferenceError extends Schema.TaggedErrorClass<MicPrismInferenceError>()(
  "MicPrismInferenceError",
  { status: Schema.Int, reason: Schema.Literals(["provider", "interrupted", "invalid-response"]) },
) {
  readonly fallbackAllowed = false;
  override get message(): string {
    if (this.reason === "interrupted")
      return "The response was interrupted. Check your access before trying again.";
    if (this.status === 429)
      return "Prism has no capacity for this request right now. Try again later.";
    if (this.status === 404)
      return "This model is unavailable. Choose another model or try again later.";
    return "Prism could not complete this request. No automatic retry was made.";
  }
}

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

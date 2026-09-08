/** Named adapters currently implemented by the independently authorized Prism gateway. */
import * as Schema from "effect/Schema";
import { PrismRoutingStrategy } from "./config.ts";
import { PrismAccount, PrismAccountId, PrismLoginStatus } from "./prismApi.ts";

export const MIC_PRISM_API_PATHS = {
  status: "/prism/v1/status",
  routing: "/prism/v1/routing",
  accounts: "/prism/v1/accounts",
  login: "/prism/v1/accounts/login",
  settings: "/prism/v1/settings",
  availability: "/prism/v1/models/availability",
} as const;

const Identifier = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
const Revision = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
const Percent = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
const Binding = {
  serviceInstanceId: Identifier,
  pairingRevision: Schema.Int.check(Schema.isGreaterThan(0)),
};
const StateBinding = { ...Binding, settingsRevision: Revision };

/** The independent service supports reset priority in addition to the legacy strategies. */
export const MicPrismStrategy = Schema.Literals([
  "round-robin", "weighted-round-robin", "fill-first", "reset-priority",
]);
export type MicPrismStrategy = typeof MicPrismStrategy.Type;

export const MicPrismSettings = Schema.Struct({
  strategy: MicPrismStrategy,
  sessionAffinity: Schema.Boolean,
  requestRetry: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
  maxRetryInterval: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 300 })),
});
export type MicPrismSettings = typeof MicPrismSettings.Type;
export const MicPrismSettingsState = Schema.Struct({ ...StateBinding, settings: MicPrismSettings });
export type MicPrismSettingsState = typeof MicPrismSettingsState.Type;

export const MicPrismManagedAccount = Schema.Struct({
  ...PrismAccount.fields,
  /** Null explicitly disables reserve avoidance; the gateway supplies its 3% default. */
  reservePercent: Schema.NullOr(Percent),
  quotaWindows: Schema.optionalKey(Schema.Array(Schema.Struct({
    id: Identifier,
    utilization: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    resetAt: Schema.optionalKey(Schema.String),
    observedAt: Schema.String,
  }))),
  eligibility: Schema.optionalKey(Schema.Struct({
    available: Schema.Boolean,
    reason: Schema.optionalKey(Schema.String),
  })),
});
export type MicPrismManagedAccount = typeof MicPrismManagedAccount.Type;
export const MicPrismAccountsState = Schema.Struct({
  ...StateBinding, accounts: Schema.Array(MicPrismManagedAccount),
});
export type MicPrismAccountsState = typeof MicPrismAccountsState.Type;

export const MicPrismAccountPatch = Schema.Struct({
  disabled: Schema.optionalKey(Schema.Boolean),
  weight: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000000 }))),
  reservePercent: Schema.optionalKey(Schema.NullOr(Percent)),
});
export type MicPrismAccountPatch = typeof MicPrismAccountPatch.Type;

export const MicPrismOperation = Schema.Struct({
  ...Binding,
  operationId: Schema.String.check(Schema.isUUID()),
  expectedSettingsRevision: Revision,
});
export type MicPrismOperation = typeof MicPrismOperation.Type;
export const MicPrismApplied = Schema.Struct({
  ...StateBinding,
  operationId: Schema.String.check(Schema.isUUID()),
  status: Schema.Literal("applied"),
  settings: Schema.optionalKey(MicPrismSettings),
  accounts: Schema.optionalKey(Schema.Array(MicPrismManagedAccount)),
});
export type MicPrismApplied = typeof MicPrismApplied.Type;

export const MicPrismLoginProvider = Schema.Literals(["anthropic", "codex", "xai"]);
export type MicPrismLoginProvider = typeof MicPrismLoginProvider.Type;
export const MicPrismLoginStarted = Schema.Struct({
  ...StateBinding,
  operationId: Schema.String.check(Schema.isUUID()),
  sessionId: Identifier,
  authUrl: Schema.String.check(Schema.isNonEmpty()),
  flow: Schema.Literals(["redirect", "device"]),
  userCode: Schema.optionalKey(Schema.String),
});
export type MicPrismLoginStarted = typeof MicPrismLoginStarted.Type;
export const MicPrismManagedLoginStatus = Schema.Struct({
  ...StateBinding,
  ...PrismLoginStatus.fields,
  operationId: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
});
export type MicPrismManagedLoginStatus = typeof MicPrismManagedLoginStatus.Type;

/** Safe for inference users: model-specific capacity without provider account identities. */
export const MicPrismModelAvailability = Schema.Struct({
  id: Identifier,
  provider: Identifier,
  available: Schema.Boolean,
  usableAccounts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  warnings: Schema.Array(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  nextEligibleAt: Schema.optionalKey(Schema.String),
});
export type MicPrismModelAvailability = typeof MicPrismModelAvailability.Type;
export const MicPrismAvailability = Schema.Struct({
  ...Binding,
  observedAt: Schema.String,
  models: Schema.Array(MicPrismModelAvailability),
});
export type MicPrismAvailability = typeof MicPrismAvailability.Type;

export const MicPrismSettingsWrite = Schema.Struct({
  ...MicPrismOperation.fields, settings: MicPrismSettings,
});
export const MicPrismAccountWrite = Schema.Struct({
  ...MicPrismOperation.fields, patch: MicPrismAccountPatch,
});
export const MicPrismLoginWrite = Schema.Struct({
  ...MicPrismOperation.fields, provider: MicPrismLoginProvider,
});
export const MicPrismCallbackWrite = Schema.Struct({
  ...MicPrismOperation.fields, redirectUrl: Schema.String.check(Schema.isNonEmpty()),
});
export { PrismAccountId as MicPrismAccountId };

export class MicPrismManagementError extends Schema.TaggedErrorClass<MicPrismManagementError>()(
  "MicPrismManagementError",
  { reason: Schema.Literals(["conflict", "invalid-input", "unconfirmed"]) },
) {
  override get message(): string {
    if (this.reason === "conflict")
      return "Prism changed since this view loaded. Refresh and review the current values before trying again.";
    if (this.reason === "invalid-input")
      return "Prism could not accept these values. Check the settings and try again.";
    return "Prism did not confirm this change. Refresh to check its current state before trying again.";
  }
}

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

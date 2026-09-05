/**
 * mic.sc identity/discovery v1 contract, coordinated with mic.sc PR140.
 * Capabilities are supplied by the identity authority; clients never derive
 * grants from Clerk claims or treat a cached discovery record as authorization.
 */
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const MIC_IDENTITY_SESSION_HEADER = "x-mic-sc-session";
export const MIC_IDENTITY_CLERK_TEMPLATE = "convex";
export const MIC_IDENTITY_API_PATHS = {
  session: "/v1/identity",
  prismService: "/v1/prism/discovery",
} as const;

const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:~-]{1,256}$/));
const AuthorizationRevision = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(16_384));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const EpochMillis = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }),
);
const Permissions = Schema.Array(
  Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
).check(Schema.isMaxLength(64));
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
  Schema.makeFilter((value) => Option.isSome(DateTime.make(value))),
);

/** Service endpoints allow TLS or disposable loopback development servers. */
export const MicIdentityServiceUrl = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  }),
);

export const MicPrismCapability = Schema.Literals(["inference", "manage", "accountDetails"]);
export type MicPrismCapability = typeof MicPrismCapability.Type;

export const MIC_PRISM_PERMISSIONS = [
  "prism:inference",
  "prism:accounts:read",
  "prism:accounts:write",
  "prism:routing:read",
  "prism:routing:write",
  "prism:settings:read",
  "prism:settings:write",
  "prism:instances:manage",
] as const;
export const MicPrismPermission = Schema.Literals(MIC_PRISM_PERMISSIONS);
export type MicPrismPermission = typeof MicPrismPermission.Type;

const ServiceOrigin = MicIdentityServiceUrl.check(
  Schema.makeFilter((value) => {
    try {
      return new URL(value).pathname === "/";
    } catch {
      return false;
    }
  }),
);

/** Actual authority response; no session binding or role claims are inferred. */
export const MicIdentityWire = Schema.Struct({
  contractVersion: Schema.Literal(1),
  subject: Identifier,
  role: Schema.Literals(["global_admin", "member"]),
  permissions: Permissions,
  authorizationExpiresAt: EpochMillis,
  authorizationRevision: AuthorizationRevision,
});
export type MicIdentityWire = typeof MicIdentityWire.Type;

export const MicPrismDiscoveryWire = Schema.Struct({
  contractVersion: Schema.Literal(1),
  selectionRevision: Revision,
  service: Schema.NullOr(
    Schema.Struct({
      serviceInstanceId: Identifier,
      displayName: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
      apiOrigin: ServiceOrigin,
      inferenceOrigin: ServiceOrigin,
      pairingRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      protocolVersion: Schema.Literal(1),
      publicKey: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{40,256}$/)),
      status: Schema.Literal("paired"),
    }),
  ),
});
export type MicPrismDiscoveryWire = typeof MicPrismDiscoveryWire.Type;

export const MicIdentityCapabilities = Schema.Struct({
  inference: Schema.Boolean,
  manage: Schema.Boolean,
  accountDetails: Schema.Boolean,
});
export type MicIdentityCapabilities = typeof MicIdentityCapabilities.Type;

export const MicIdentitySession = Schema.Struct({
  version: Schema.Literal(1),
  subject: Identifier,
  /** Older local adapters may supply this; the identity authority does not. */
  sessionId: Schema.optionalKey(Identifier),
  state: Schema.Literals(["active", "disabled", "revoked"]),
  globalAdmin: Schema.Boolean,
  capabilities: MicIdentityCapabilities,
  permissions: Permissions,
  authorizationRevision: AuthorizationRevision,
  authorizationExpiresAt: EpochMillis,
  expiresAt: Timestamp,
});
export type MicIdentitySession = typeof MicIdentitySession.Type;

export const MicPrismService = Schema.Struct({
  id: Identifier,
  label: Schema.String.check(Schema.isNonEmpty()),
  apiUrl: MicIdentityServiceUrl,
  inferenceUrl: MicIdentityServiceUrl,
  revision: Identifier,
  pairingRevision: Revision,
  protocolVersion: Schema.Literal(1),
  publicKey: Schema.String,
  status: Schema.Literals(["paired", "revoked"]),
});
export type MicPrismService = typeof MicPrismService.Type;

export const MicPrismDiscovery = Schema.Struct({
  version: Schema.Literal(1),
  selectionRevision: Revision,
  service: Schema.NullOr(MicPrismService),
});
export type MicPrismDiscovery = typeof MicPrismDiscovery.Type;

/** Exact operation grants remain distinct even when the UI shows an admin summary. */
export function hasMicPrismPermission(
  identity: Pick<MicIdentitySession, "permissions">,
  permission: MicPrismPermission,
): boolean {
  return identity.permissions.includes(permission);
}

export function normalizeMicIdentity(identity: MicIdentityWire): MicIdentitySession {
  const permissions = [...new Set(identity.permissions)];
  return {
    version: 1,
    subject: identity.subject,
    state: "active",
    globalAdmin: identity.role === "global_admin",
    permissions,
    capabilities: {
      inference: permissions.includes("prism:inference"),
      // Presentation summary only. Every operation still checks its exact grant.
      manage: MIC_PRISM_PERMISSIONS.filter((permission) => permission !== "prism:inference").every(
        (permission) => permissions.includes(permission),
      ),
      accountDetails: permissions.includes("prism:accounts:read"),
    },
    authorizationRevision: identity.authorizationRevision,
    authorizationExpiresAt: identity.authorizationExpiresAt,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(identity.authorizationExpiresAt)),
  };
}

export function normalizeMicPrismDiscovery(discovery: MicPrismDiscoveryWire): MicPrismDiscovery {
  const service = discovery.service;
  return {
    version: 1,
    selectionRevision: discovery.selectionRevision,
    service:
      service === null
        ? null
        : {
            id: service.serviceInstanceId,
            label: service.displayName,
            apiUrl: service.apiOrigin,
            inferenceUrl: service.inferenceOrigin,
            revision: String(service.pairingRevision),
            pairingRevision: service.pairingRevision,
            protocolVersion: service.protocolVersion,
            publicKey: service.publicKey,
            status: service.status,
          },
  };
}

export class MicIdentityUnauthorizedError extends Schema.TaggedErrorClass<MicIdentityUnauthorizedError>()(
  "MicIdentityUnauthorizedError",
  {
    reason: Schema.Literals([
      "sign-in-required",
      "invalid-session",
      "expired-session",
      "revoked-session",
    ]),
  },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(MicIdentityUnauthorizedError)(this, { status: 401 });
  }

  override get message(): string {
    return "Sign in to mic.sc to continue.";
  }
}

export class MicIdentityForbiddenError extends Schema.TaggedErrorClass<MicIdentityForbiddenError>()(
  "MicIdentityForbiddenError",
  { capability: Schema.Union([MicPrismCapability, MicPrismPermission]) },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(MicIdentityForbiddenError)(this, { status: 403 });
  }

  override get message(): string {
    return "Your mic.sc account does not have permission for this Prism operation.";
  }
}

export class MicIdentityUnavailableError extends Schema.TaggedErrorClass<MicIdentityUnavailableError>()(
  "MicIdentityUnavailableError",
  {
    reason: Schema.Literals([
      "configuration",
      "transport",
      "invalid-response",
      "unpaired-service",
      "revoked-service",
      "unsupported-operation",
    ]),
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(MicIdentityUnavailableError)(this, { status: 503 });
  }

  override get message(): string {
    switch (this.reason) {
      case "configuration":
        return "mic.sc sign-in is not configured for this environment.";
      case "unpaired-service":
        return "No Prism service is paired with this account.";
      case "revoked-service":
        return "Access to the paired Prism service has been revoked.";
      case "unsupported-operation":
        return "This Prism service does not support that operation yet.";
      default:
        return "mic.sc could not verify Prism access. Try again when it is available.";
    }
  }
}

export const MicIdentityError = Schema.Union([
  MicIdentityUnauthorizedError,
  MicIdentityForbiddenError,
  MicIdentityUnavailableError,
]);
export type MicIdentityClientError = typeof MicIdentityError.Type;

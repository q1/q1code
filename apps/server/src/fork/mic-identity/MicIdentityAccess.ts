import {
  MIC_IDENTITY_API_PATHS,
  MIC_IDENTITY_SESSION_HEADER,
  MicIdentityForbiddenError,
  MicIdentityServiceUrl,
  MicIdentityWire,
  MicIdentityUnauthorizedError,
  MicIdentityUnavailableError,
  MicPrismDiscoveryWire,
  normalizeMicIdentity,
  normalizeMicPrismDiscovery,
  type MicPrismCapability,
  type MicPrismPermission,
  hasMicPrismPermission,
} from "@q1code/core/micIdentity";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as Headers from "effect/unstable/http/Headers";

import { ForkFlagsService } from "../ForkFlags.ts";

const isServiceUrl = Schema.is(MicIdentityServiceUrl);

/** Injection point for isolated authority contract tests; no session or grant cache. */
export const MicIdentityFetch = Context.Reference<typeof fetch>("q1code/MicIdentityFetch", {
  defaultValue: () => globalThis.fetch,
});

export const micIdentityPublicConfig = Effect.gen(function* () {
  const flags = yield* ForkFlagsService;
  if (!(yield* flags.current)["mic-identity"]) return { enabled: false };
  const config = (yield* flags.config)["mic-identity"];
  if (!config || !isServiceUrl(config.authorityUrl)) {
    return yield* new MicIdentityUnavailableError({ reason: "configuration" });
  }
  return {
    enabled: true,
    clerkPublishableKey: config.clerkPublishableKey,
    authorityUrl: config.authorityUrl,
  };
});

/** A current authority response supplements, and never replaces, environment authentication. */
export const requireMicIdentity = (
  permission: MicPrismCapability | MicPrismPermission = "inference",
) =>
  Effect.gen(function* () {
    const capability: MicPrismCapability =
      permission === "inference" || permission === "prism:inference"
        ? "inference"
        : permission === "accountDetails" || permission.endsWith(":read")
          ? "accountDetails"
          : "manage";
    const flags = yield* ForkFlagsService;
    if (!(yield* flags.current)["mic-identity"]) return undefined;
    const config = (yield* flags.config)["mic-identity"];
    if (!config || !isServiceUrl(config.authorityUrl)) {
      return yield* new MicIdentityUnavailableError({ reason: "configuration" });
    }
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = request.headers[MIC_IDENTITY_SESSION_HEADER];
    if (!token || /[\r\n]/.test(token)) {
      return yield* new MicIdentityUnauthorizedError({ reason: "sign-in-required" });
    }
    const fetchAuthority = yield* MicIdentityFetch;
    const read = <S extends Schema.Constraint & Schema.Decoder<unknown, never>>(
      path: string,
      schema: S,
    ) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetchAuthority(`${config.authorityUrl.replace(/\/$/, "")}${path}`, {
              headers: { authorization: `Bearer ${token}` },
              redirect: "error",
              cache: "no-store",
              signal,
            }),
          catch: () => new MicIdentityUnavailableError({ reason: "transport" }),
        });
        if (response.status === 401) {
          return yield* new MicIdentityUnauthorizedError({ reason: "invalid-session" });
        }
        if (response.status === 403)
          return yield* new MicIdentityForbiddenError({ capability: permission });
        if (!response.ok) return yield* new MicIdentityUnavailableError({ reason: "transport" });
        const body = yield* Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: () => new MicIdentityUnavailableError({ reason: "invalid-response" }),
        });
        return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
          Effect.mapError(() => new MicIdentityUnavailableError({ reason: "invalid-response" })),
        );
      }).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail(new MicIdentityUnavailableError({ reason: "transport" })),
        }),
      );
    const session = normalizeMicIdentity(
      yield* read(MIC_IDENTITY_API_PATHS.session, MicIdentityWire),
    );
    if (session.state !== "active") {
      return yield* new MicIdentityUnauthorizedError({ reason: "revoked-session" });
    }
    if (Date.parse(session.expiresAt) <= DateTime.toEpochMillis(yield* DateTime.now)) {
      return yield* new MicIdentityUnauthorizedError({ reason: "expired-session" });
    }
    if (
      !(permission.startsWith("prism:")
        ? hasMicPrismPermission(session, permission as MicPrismPermission)
        : session.capabilities[capability])
    ) {
      return yield* new MicIdentityForbiddenError({ capability: permission });
    }
    const discovery = normalizeMicPrismDiscovery(
      yield* read(MIC_IDENTITY_API_PATHS.prismService, MicPrismDiscoveryWire),
    );
    if (!discovery.service) {
      return yield* new MicIdentityUnavailableError({ reason: "unpaired-service" });
    }
    if (discovery.service.status !== "paired") {
      return yield* new MicIdentityUnavailableError({ reason: "revoked-service" });
    }
    if (Date.parse(session.expiresAt) <= DateTime.toEpochMillis(yield* DateTime.now)) {
      return yield* new MicIdentityUnauthorizedError({ reason: "expired-session" });
    }
    return { session, discovery };
  }).pipe(
    Effect.provideServiceEffect(
      Headers.CurrentRedactedNames,
      Effect.map(Headers.CurrentRedactedNames, (names) => [...names, MIC_IDENTITY_SESSION_HEADER]),
    ),
  );

/** Legacy management is allowed only for the authority's paired external service during migration. */
export const requirePairedPrismTarget = (apiUrl: string) =>
  Effect.gen(function* () {
    const flags = yield* ForkFlagsService;
    const prism = (yield* flags.config).prism;
    if (
      prism?.mode !== "external" ||
      !prism.external ||
      prism.external.baseUrl.replace(/\/$/, "") !== apiUrl.replace(/\/$/, "")
    ) {
      return yield* new MicIdentityUnavailableError({ reason: "configuration" });
    }
  });

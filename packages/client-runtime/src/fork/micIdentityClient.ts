/** Request-time access checks against the mic.sc v1 identity authority. */
import {
  MIC_IDENTITY_API_PATHS,
  MicIdentityForbiddenError,
  MicIdentityServiceUrl,
  type MicIdentitySession,
  MicIdentityWire,
  MicIdentityUnauthorizedError,
  MicIdentityUnavailableError,
  type MicPrismDiscovery,
  MicPrismDiscoveryWire,
  hasMicPrismPermission,
  normalizeMicIdentity,
  normalizeMicPrismDiscovery,
  type MicIdentityClientError,
  type MicPrismCapability,
  type MicPrismPermission,
} from "@q1code/core/micIdentity";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";

export type { MicIdentityClientError } from "@q1code/core/micIdentity";

/** The sign-in adapter resolves the current token; callers must not cache it. */
export type MicIdentityTokenSource = () => Effect.Effect<string | null, MicIdentityClientError>;

export interface MicIdentityClientInput {
  readonly baseUrl: string;
  readonly getToken: MicIdentityTokenSource;
  readonly capability?: MicPrismCapability;
  /** Prefer exact permissions for gateway operations; capability is presentation compatibility. */
  readonly permission?: MicPrismPermission;
  readonly timeoutMs?: number;
  /** Binds an operation to the initiating signed-in account across async steps. */
  readonly isCurrent?: () => boolean;
  /** Discovery screens must distinguish a signed-in account from an unpaired host. */
  readonly allowUnpaired?: boolean;
  /** Preserve the host the user saw when initiating an operation. */
  readonly expectedService?: {
    readonly id: string;
    readonly pairingRevision: number;
    readonly apiUrl?: string;
    readonly inferenceUrl?: string;
  };
}

const decodeServiceUrl = Schema.decodeUnknownEffect(MicIdentityServiceUrl);

export const requireCurrentMicIdentity = Effect.fn("requireCurrentMicIdentity")(function* (
  input: Pick<MicIdentityClientInput, "isCurrent">,
) {
  if (input.isCurrent && !input.isCurrent()) {
    return yield* new MicIdentityUnauthorizedError({ reason: "revoked-session" });
  }
});

export const resolveMicIdentityToken = Effect.fn("resolveMicIdentityToken")(function* (
  getToken: MicIdentityTokenSource,
) {
  const token = yield* Effect.suspend(getToken).pipe(
    Effect.mapError(() => new MicIdentityUnauthorizedError({ reason: "sign-in-required" })),
  );
  if (token === null || token.length === 0) {
    return yield* new MicIdentityUnauthorizedError({ reason: "sign-in-required" });
  }
  if (!/^[A-Za-z0-9._~-]+$/.test(token)) {
    return yield* new MicIdentityUnauthorizedError({ reason: "invalid-session" });
  }
  return token;
});

/** Both the UI and server verify the authority's explicit grants and expiry. */
export const requireMicIdentityCapability = Effect.fn("requireMicIdentityCapability")(function* (
  session: MicIdentitySession,
  capability: MicPrismCapability | MicPrismPermission,
) {
  if (session.state !== "active") {
    return yield* new MicIdentityUnauthorizedError({ reason: "revoked-session" });
  }
  const now = yield* DateTime.now;
  if (
    DateTime.toEpochMillis(DateTime.makeUnsafe(session.expiresAt)) <= DateTime.toEpochMillis(now)
  ) {
    return yield* new MicIdentityUnauthorizedError({ reason: "expired-session" });
  }
  const permitted =
    capability === "inference" || capability === "manage" || capability === "accountDetails"
      ? session.capabilities[capability]
      : hasMicPrismPermission(session, capability);
  if (!permitted) {
    return yield* new MicIdentityForbiddenError({ capability });
  }
});

/** No stored authorization, retries, redirect following, or provider credentials. */
export const getMicIdentityAccess = Effect.fn("getMicIdentityAccess")(
  function* (
    input: MicIdentityClientInput,
  ): Effect.fn.Return<
    { readonly session: MicIdentitySession; readonly discovery: MicPrismDiscovery },
    MicIdentityClientError,
    HttpClient.HttpClient
  > {
    yield* requireCurrentMicIdentity(input);
    const baseUrl = yield* decodeServiceUrl(input.baseUrl).pipe(
      Effect.mapError(() => new MicIdentityUnavailableError({ reason: "configuration" })),
    );
    const token = yield* resolveMicIdentityToken(input.getToken);
    yield* requireCurrentMicIdentity(input);
    const client = yield* HttpClient.HttpClient;
    const capability = input.permission ?? input.capability ?? "prism:inference";

    const read = <S extends Schema.Constraint & Schema.Decoder<unknown, never>>(
      path: string,
      schema: S,
    ) =>
      Effect.gen(function* () {
        yield* requireCurrentMicIdentity(input);
        const response = yield* client
          .get(`${baseUrl.replace(/\/$/, "")}${path}`, {
            headers: { authorization: `Bearer ${token}`, accept: "application/json" },
          })
          .pipe(
            // The service CORS contract permits authentication, not trace headers.
            Effect.provideService(HttpClient.TracerPropagationEnabled, false),
            Effect.mapError(() => new MicIdentityUnavailableError({ reason: "transport" })),
          );
        yield* requireCurrentMicIdentity(input);
        if (response.status === 401) {
          return yield* new MicIdentityUnauthorizedError({ reason: "invalid-session" });
        }
        if (response.status === 403) return yield* new MicIdentityForbiddenError({ capability });
        if (response.status < 200 || response.status >= 300) {
          return yield* new MicIdentityUnavailableError({ reason: "transport" });
        }
        const body = yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
          Effect.mapError(() => new MicIdentityUnavailableError({ reason: "invalid-response" })),
        );
        yield* requireCurrentMicIdentity(input);
        return body;
      });

    return yield* Effect.gen(function* () {
      const session = normalizeMicIdentity(
        yield* read(MIC_IDENTITY_API_PATHS.session, MicIdentityWire),
      );
      yield* requireMicIdentityCapability(session, capability);
      const discovery = normalizeMicPrismDiscovery(
        yield* read(MIC_IDENTITY_API_PATHS.prismService, MicPrismDiscoveryWire),
      );
      if (
        input.expectedService &&
        (discovery.service?.id !== input.expectedService.id ||
          discovery.service.pairingRevision !== input.expectedService.pairingRevision ||
          (input.expectedService.apiUrl !== undefined &&
            discovery.service.apiUrl !== input.expectedService.apiUrl) ||
          (input.expectedService.inferenceUrl !== undefined &&
            discovery.service.inferenceUrl !== input.expectedService.inferenceUrl))
      ) {
        return yield* new MicIdentityUnavailableError({ reason: "revoked-service" });
      }
      if (discovery.service === null && !input.allowUnpaired) {
        return yield* new MicIdentityUnavailableError({ reason: "unpaired-service" });
      }
      if (discovery.service && discovery.service.status !== "paired") {
        return yield* new MicIdentityUnavailableError({ reason: "revoked-service" });
      }
      // A slow discovery call cannot extend the authority's expiry.
      yield* requireMicIdentityCapability(session, capability);
      return { session, discovery };
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      }),
    );
  },
  (effect, input) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: input.timeoutMs ?? 15_000,
        orElse: () => Effect.fail(new MicIdentityUnavailableError({ reason: "transport" })),
      }),
    ),
);

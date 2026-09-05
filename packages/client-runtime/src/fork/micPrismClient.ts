import type { PrismRoutingStrategy } from "@q1code/core/config";
import {
  MicIdentityForbiddenError,
  MicIdentityUnauthorizedError,
  MicIdentityUnavailableError,
  type MicIdentityClientError,
  type MicPrismPermission,
  type MicPrismService,
} from "@q1code/core/micIdentity";
import {
  MIC_PRISM_API_PATHS,
  MicPrismGatewayRouting,
  MicPrismGatewayStatus,
} from "@q1code/core/micPrismApi";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  getMicIdentityAccess,
  requireMicIdentityCapability,
  requireCurrentMicIdentity,
  resolveMicIdentityToken,
  type MicIdentityClientInput,
} from "./micIdentityClient.ts";

export type { MicPrismGatewayRouting, MicPrismGatewayStatus } from "@q1code/core/micPrismApi";

/** Each named operation resolves current identity/pairing and uses only Prism grants. */
const call = Effect.fn("micPrismClient.call")(
  function* <S extends Schema.Constraint & Schema.Decoder<unknown, never>>(
    input: MicIdentityClientInput,
    permission: MicPrismPermission,
    path: string,
    schema: S,
    strategy?: PrismRoutingStrategy,
  ): Effect.fn.Return<
    { readonly value: S["Type"]; readonly service: MicPrismService },
    MicIdentityClientError,
    HttpClient.HttpClient
  > {
    const access = yield* getMicIdentityAccess({ ...input, permission });
    const service = access.discovery.service;
    if (service === null)
      return yield* new MicIdentityUnavailableError({ reason: "unpaired-service" });
    const token = yield* resolveMicIdentityToken(input.getToken);
    yield* requireCurrentMicIdentity(input);
    yield* requireMicIdentityCapability(access.session, permission);
    const url = `${service.apiUrl.replace(/\/$/, "")}${path}`;
    const client = yield* HttpClient.HttpClient;
    const request = (
      strategy === undefined ? HttpClientRequest.get(url) : HttpClientRequest.put(url)
    ).pipe(
      HttpClientRequest.setHeaders({
        authorization: `Bearer ${token}`,
        accept: "application/json",
      }),
    );
    const encoded =
      strategy === undefined
        ? request
        : yield* HttpClientRequest.schemaBodyJson(MicPrismGatewayRouting)(request, {
            strategy,
          }).pipe(
            Effect.mapError(() => new MicIdentityUnavailableError({ reason: "invalid-response" })),
          );
    yield* requireCurrentMicIdentity(input);
    const response = yield* client.execute(encoded).pipe(
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provideService(FetchHttpClient.RequestInit, {
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      }),
      Effect.mapError(() => new MicIdentityUnavailableError({ reason: "transport" })),
    );
    yield* requireCurrentMicIdentity(input);
    if (response.status === 401)
      return yield* new MicIdentityUnauthorizedError({ reason: "invalid-session" });
    if (response.status === 403)
      return yield* new MicIdentityForbiddenError({ capability: permission });
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      return yield* new MicIdentityUnavailableError({ reason: "unsupported-operation" });
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new MicIdentityUnavailableError({ reason: "transport" });
    }
    const value = yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(() => new MicIdentityUnavailableError({ reason: "invalid-response" })),
    );
    yield* requireCurrentMicIdentity(input);
    yield* requireMicIdentityCapability(access.session, permission);
    return { value, service };
  },
  (effect, input) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: input.timeoutMs ?? 15_000,
        orElse: () => Effect.fail(new MicIdentityUnavailableError({ reason: "transport" })),
      }),
    ),
);

export const getMicPrismStatus = Effect.fn("getMicPrismStatus")(function* (
  input: MicIdentityClientInput,
) {
  const { value, service } = yield* call(
    input,
    "prism:inference",
    MIC_PRISM_API_PATHS.status,
    MicPrismGatewayStatus,
  );
  if (value.serviceInstanceId !== service.id || value.pairingRevision !== service.pairingRevision) {
    return yield* new MicIdentityUnavailableError({ reason: "revoked-service" });
  }
  return value;
});

export const getMicPrismRouting = Effect.fn("getMicPrismRouting")(function* (
  input: MicIdentityClientInput,
) {
  const { value } = yield* call(
    input,
    "prism:routing:read",
    MIC_PRISM_API_PATHS.routing,
    MicPrismGatewayRouting,
  );
  return value;
});

export const setMicPrismRouting = Effect.fn("setMicPrismRouting")(function* (
  input: MicIdentityClientInput & { readonly strategy: PrismRoutingStrategy },
) {
  const { value } = yield* call(
    input,
    "prism:routing:write",
    MIC_PRISM_API_PATHS.routing,
    MicPrismGatewayRouting,
    input.strategy,
  );
  if (value.strategy !== input.strategy) {
    return yield* new MicIdentityUnavailableError({ reason: "invalid-response" });
  }
  return value;
});

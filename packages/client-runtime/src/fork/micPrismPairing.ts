import {
  MicIdentityForbiddenError,
  MicIdentityUnauthorizedError,
  MicIdentityUnavailableError,
  type MicIdentityClientError,
} from "@q1code/core/micIdentity";
import {
  MIC_PRISM_PAIRING_PATHS,
  MicPrismPairingStart,
  MicPrismPairingChallenge,
  MicPrismPairingChallengePayload,
  MicPrismPairingComplete,
  MicPrismPairedInstance,
  MicPrismInstanceSelect,
  MicPrismSelectedInstance,
  MicPrismInstanceRevoke,
  MicPrismRevokedInstance,
  MicPrismPairingError,
} from "@q1code/core/micPrismPairing";
import * as DateTime from "effect/DateTime";
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
  requireCurrentMicIdentity,
  requireMicIdentityCapability,
  resolveMicIdentityToken,
  type MicIdentityClientInput,
} from "./micIdentityClient.ts";

export { MicPrismPairingError } from "@q1code/core/micPrismPairing";
export type MicPrismPairingClientInput = Pick<
  MicIdentityClientInput,
  "baseUrl" | "getToken" | "timeoutMs"
> & { readonly isCurrent: () => boolean };
export type MicPrismPairingClientError = MicIdentityClientError | MicPrismPairingError;
const permission = "prism:instances:manage";
const decodeChallengePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MicPrismPairingChallengePayload),
);

/** Account-level recovery talks only to mic.sc, so the old host may be absent or offline. */
const call = Effect.fn("micPrismPairing.call")(
  function* <
    I extends Schema.Constraint & Schema.Decoder<unknown, never> & Schema.Encoder<unknown, never>,
    O extends Schema.Constraint & Schema.Decoder<unknown, never>,
  >(
    input: MicPrismPairingClientInput,
    path: string,
    inputSchema: I,
    payload: I["Type"],
    outputSchema: O,
  ): Effect.fn.Return<
    { readonly value: O["Type"]; readonly subject: string },
    MicPrismPairingClientError,
    HttpClient.HttpClient
  > {
    const body = yield* Schema.decodeUnknownEffect(inputSchema)(payload).pipe(
      Effect.mapError(() => new MicPrismPairingError({ reason: "invalid-input" })),
    );
    const access = yield* getMicIdentityAccess({
      baseUrl: input.baseUrl,
      getToken: input.getToken,
      isCurrent: input.isCurrent,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      permission,
      allowUnpaired: true,
    });
    const token = yield* resolveMicIdentityToken(input.getToken);
    yield* requireCurrentMicIdentity(input);
    yield* requireMicIdentityCapability(access.session, permission);
    const request = yield* HttpClientRequest.schemaBodyJson(inputSchema)(
      HttpClientRequest.post(`${input.baseUrl.replace(/\/$/, "")}${path}`).pipe(
        HttpClientRequest.setHeaders({
          authorization: `Bearer ${token}`,
          accept: "application/json",
        }),
      ),
      body,
    ).pipe(Effect.mapError(() => new MicPrismPairingError({ reason: "invalid-input" })));
    yield* requireCurrentMicIdentity(input);
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request).pipe(
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
    if (response.status === 409) return yield* new MicPrismPairingError({ reason: "conflict" });
    if (response.status === 404) return yield* new MicPrismPairingError({ reason: "not-found" });
    if (response.status === 400)
      return yield* new MicPrismPairingError({ reason: "invalid-input" });
    if (response.status < 200 || response.status >= 300)
      return yield* new MicIdentityUnavailableError({ reason: "transport" });
    const value = yield* HttpClientResponse.schemaBodyJson(outputSchema)(response).pipe(
      Effect.mapError(() => new MicPrismPairingError({ reason: "invalid-response" })),
    );
    yield* requireCurrentMicIdentity(input);
    yield* requireMicIdentityCapability(access.session, permission);
    return { value, subject: access.session.subject };
  },
  (effect, input) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: input.timeoutMs ?? 15_000,
        orElse: () => Effect.fail(new MicIdentityUnavailableError({ reason: "transport" })),
      }),
    ),
);

export const startMicPrismPairing = Effect.fn("startMicPrismPairing")(function* (
  input: MicPrismPairingClientInput & MicPrismPairingStart,
) {
  const { value, subject } = yield* call(
    input,
    MIC_PRISM_PAIRING_PATHS.start,
    MicPrismPairingStart,
    { origin: input.origin, publicKey: input.publicKey, label: input.label },
    MicPrismPairingChallenge,
  );
  const proof = yield* decodeChallengePayload(value.challenge).pipe(
    Effect.mapError(() => new MicPrismPairingError({ reason: "invalid-response" })),
  );
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  if (
    value.origin !== input.origin ||
    value.publicKey !== input.publicKey ||
    value.expiresAt <= now ||
    value.expiresAt > now + 330_000 ||
    proof.subject !== subject ||
    proof.challengeId !== value.challengeId ||
    proof.origin !== value.origin ||
    proof.publicKey !== value.publicKey ||
    proof.expiresAt !== value.expiresAt
  )
    return yield* new MicPrismPairingError({ reason: "invalid-response" });
  // Sign/export this exact string; serializing the parsed payload would change the proof.
  return value;
});
export const completeMicPrismPairing = Effect.fn("completeMicPrismPairing")(function* (
  input: MicPrismPairingClientInput & MicPrismPairingComplete,
) {
  const { value } = yield* call(
    input,
    MIC_PRISM_PAIRING_PATHS.complete,
    MicPrismPairingComplete,
    { challengeId: input.challengeId, signature: input.signature },
    MicPrismPairedInstance,
  );
  return value;
});
export const selectMicPrismInstance = Effect.fn("selectMicPrismInstance")(function* (
  input: MicPrismPairingClientInput & MicPrismInstanceSelect,
) {
  const { value } = yield* call(
    input,
    MIC_PRISM_PAIRING_PATHS.select,
    MicPrismInstanceSelect,
    {
      serviceInstanceId: input.serviceInstanceId,
      expectedSelectionRevision: input.expectedSelectionRevision,
    },
    MicPrismSelectedInstance,
  );
  if (
    value.serviceInstanceId !== input.serviceInstanceId ||
    ![input.expectedSelectionRevision, input.expectedSelectionRevision + 1].includes(
      value.selectionRevision,
    )
  )
    return yield* new MicPrismPairingError({ reason: "invalid-response" });
  return value;
});
export const revokeMicPrismInstance = Effect.fn("revokeMicPrismInstance")(function* (
  input: MicPrismPairingClientInput & MicPrismInstanceRevoke,
) {
  const { value } = yield* call(
    input,
    MIC_PRISM_PAIRING_PATHS.revoke,
    MicPrismInstanceRevoke,
    {
      serviceInstanceId: input.serviceInstanceId,
      expectedPairingRevision: input.expectedPairingRevision,
    },
    MicPrismRevokedInstance,
  );
  if (
    value.serviceInstanceId !== input.serviceInstanceId ||
    value.pairingRevision !== input.expectedPairingRevision + 1
  )
    return yield* new MicPrismPairingError({ reason: "invalid-response" });
  return value;
});

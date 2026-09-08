/** Named, revisioned Prism operations. No engine keys or q1code environment grants cross this API. */
import {
  MIC_PRISM_API_PATHS,
  MicPrismAccountsState,
  MicPrismAccountId,
  MicPrismAccountWrite,
  MicPrismApplied,
  MicPrismAvailability,
  MicPrismCallbackWrite,
  MicPrismLoginStarted,
  MicPrismLoginWrite,
  MicPrismManagedLoginStatus,
  MicPrismManagementError,
  MicPrismOperation,
  MicPrismSettingsState,
  MicPrismSettingsWrite,
  type MicPrismAccountPatch,
  type MicPrismLoginProvider,
  type MicPrismSettings,
} from "@q1code/core/micPrismApi";
import {
  MicIdentityForbiddenError,
  MicIdentityUnauthorizedError,
  MicIdentityUnavailableError,
  type MicIdentityClientError,
  type MicPrismPermission,
} from "@q1code/core/micIdentity";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  getMicIdentityAccess,
  requireCurrentMicIdentity,
  requireMicIdentityCapability,
  resolveMicIdentityToken,
  type MicIdentityClientInput,
} from "./micIdentityClient.ts";

export type MicPrismManagementClientError = MicIdentityClientError | MicPrismManagementError;
export type MicPrismMutationInput = MicIdentityClientInput & {
  readonly expectedService: NonNullable<MicIdentityClientInput["expectedService"]>;
  readonly expectedSettingsRevision: string;
  /** A caller may retain the ID to correlate a receipt, but never replay automatically. */
  readonly operationId?: string;
};

type Bound = { readonly serviceInstanceId: string; readonly pairingRevision: number };
type Codec = Schema.Constraint & Schema.Decoder<unknown, never>;

const call = Effect.fn("micPrismManagement.call")(
  function* <S extends Codec>(
    input: MicIdentityClientInput,
    permission: MicPrismPermission,
    path: string,
    schema: S,
    write?: {
      readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
      readonly body: unknown;
      readonly operationId: string;
    },
  ): Effect.fn.Return<S["Type"], MicPrismManagementClientError, HttpClient.HttpClient> {
    const access = yield* getMicIdentityAccess({ ...input, permission });
    const service = access.discovery.service;
    if (!service) return yield* new MicIdentityUnavailableError({ reason: "unpaired-service" });
    const token = yield* resolveMicIdentityToken(input.getToken);
    yield* requireCurrentMicIdentity(input);
    yield* requireMicIdentityCapability(access.session, permission);
    const request = HttpClientRequest.make(write?.method ?? "GET")(
      `${service.apiUrl.replace(/\/$/, "")}${path}`,
    ).pipe(HttpClientRequest.setHeaders({ authorization: `Bearer ${token}`, accept: "application/json" }));
    const encoded = write
      ? yield* HttpClientRequest.bodyJson(request, write.body).pipe(
          Effect.mapError(() => new MicPrismManagementError({ reason: "invalid-input" })),
        )
      : request;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(encoded).pipe(
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provideService(FetchHttpClient.RequestInit, {
        credentials: "omit", redirect: "error", cache: "no-store",
      }),
      Effect.mapError(() => write
        ? new MicPrismManagementError({ reason: "unconfirmed" })
        : new MicIdentityUnavailableError({ reason: "transport" })),
    );
    yield* requireCurrentMicIdentity(input);
    if (response.status === 401) return yield* new MicIdentityUnauthorizedError({ reason: "invalid-session" });
    if (response.status === 403) return yield* new MicIdentityForbiddenError({ capability: permission });
    if (response.status === 409) return yield* new MicPrismManagementError({ reason: "conflict" });
    if (response.status === 400 || response.status === 422)
      return yield* new MicPrismManagementError({ reason: "invalid-input" });
    if ([404, 405, 501].includes(response.status))
      return yield* new MicIdentityUnavailableError({ reason: "unsupported-operation" });
    if (response.status < 200 || response.status >= 300)
      return yield* (write
        ? new MicPrismManagementError({ reason: "unconfirmed" })
        : new MicIdentityUnavailableError({ reason: "transport" }));
    const value = yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(() => new MicIdentityUnavailableError({ reason: "invalid-response" })),
    );
    yield* requireCurrentMicIdentity(input);
    yield* requireMicIdentityCapability(access.session, permission);
    const bound = value as Bound;
    if (bound.serviceInstanceId !== service.id || bound.pairingRevision !== service.pairingRevision)
      return yield* new MicIdentityUnavailableError({ reason: "revoked-service" });
    if (write && (value as { operationId?: string }).operationId !== write.operationId)
      return yield* new MicPrismManagementError({ reason: "unconfirmed" });
    return value;
  },
  (effect, input, _permission, _path, _schema, write) => effect.pipe(
    Effect.timeoutOrElse({
      duration: input.timeoutMs ?? 15_000,
      orElse: () => Effect.fail(write
        ? new MicPrismManagementError({ reason: "unconfirmed" })
        : new MicIdentityUnavailableError({ reason: "transport" })),
    }),
  ),
);

const decodeAccountId = Schema.decodeUnknownEffect(MicPrismAccountId);
const decodeOperation = Schema.decodeUnknownEffect(MicPrismOperation);
const decodeSettingsWrite = Schema.decodeUnknownEffect(MicPrismSettingsWrite);
const decodeAccountWrite = Schema.decodeUnknownEffect(MicPrismAccountWrite);
const decodeLoginWrite = Schema.decodeUnknownEffect(MicPrismLoginWrite);
const decodeCallbackWrite = Schema.decodeUnknownEffect(MicPrismCallbackWrite);
const invalidInput = () => new MicPrismManagementError({ reason: "invalid-input" });

const operation = Effect.fn("micPrismManagement.operation")(function* (input: MicPrismMutationInput) {
  const operationId = input.operationId ?? (yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.mapError(invalidInput)));
  return yield* decodeOperation({
    operationId,
    serviceInstanceId: input.expectedService.id,
    pairingRevision: input.expectedService.pairingRevision,
    expectedSettingsRevision: input.expectedSettingsRevision,
  }).pipe(Effect.mapError(invalidInput));
});
const accountPath = Effect.fn("micPrismManagement.accountPath")(function* (id: string) {
  const safe = yield* decodeAccountId(id).pipe(Effect.mapError(invalidInput));
  return `${MIC_PRISM_API_PATHS.accounts}/${encodeURIComponent(safe)}`;
});
const loginPath = (sessionId: string) => `${MIC_PRISM_API_PATHS.login}/${encodeURIComponent(sessionId)}`;

export const getMicPrismAccounts = (input: MicIdentityClientInput) =>
  call(input, "prism:accounts:read", MIC_PRISM_API_PATHS.accounts, MicPrismAccountsState, undefined);
export const getMicPrismSettings = (input: MicIdentityClientInput) =>
  call(input, "prism:settings:read", MIC_PRISM_API_PATHS.settings, MicPrismSettingsState, undefined);
export const getMicPrismAvailability = (input: MicIdentityClientInput) =>
  call(input, "prism:inference", MIC_PRISM_API_PATHS.availability, MicPrismAvailability, undefined);

export const setMicPrismSettings = Effect.fn("setMicPrismSettings")(function* (
  input: MicPrismMutationInput & { readonly settings: MicPrismSettings },
) {
  const op = yield* operation(input);
  const body = yield* decodeSettingsWrite({ ...op, settings: input.settings }).pipe(Effect.mapError(invalidInput));
  const receipt = yield* call(input, "prism:settings:write", MIC_PRISM_API_PATHS.settings, MicPrismApplied,
    { method: "PUT", body, operationId: op.operationId });
  if (receipt.settings && Object.entries(input.settings).some(([key, value]) => receipt.settings![key as keyof MicPrismSettings] !== value))
    return yield* new MicPrismManagementError({ reason: "unconfirmed" });
  return receipt;
});

export const patchMicPrismAccount = Effect.fn("patchMicPrismAccount")(function* (
  input: MicPrismMutationInput & { readonly id: string; readonly patch: MicPrismAccountPatch },
) {
  const path = yield* accountPath(input.id);
  const op = yield* operation(input);
  const body = yield* decodeAccountWrite({ ...op, patch: input.patch }).pipe(Effect.mapError(invalidInput));
  if (Object.keys(body.patch).length === 0) return yield* invalidInput();
  const receipt = yield* call(input, "prism:accounts:write", path, MicPrismApplied,
    { method: "PATCH", body, operationId: op.operationId });
  if (receipt.accounts) {
    const account = receipt.accounts.find((entry) => entry.id === input.id);
    if (!account || Object.entries(input.patch).some(([key, value]) => account[key as keyof MicPrismAccountPatch] !== value))
      return yield* new MicPrismManagementError({ reason: "unconfirmed" });
  }
  return receipt;
});

export const deleteMicPrismAccount = Effect.fn("deleteMicPrismAccount")(function* (
  input: MicPrismMutationInput & { readonly id: string },
) {
  const path = yield* accountPath(input.id);
  const body = yield* operation(input);
  const receipt = yield* call(input, "prism:accounts:write", path, MicPrismApplied,
    { method: "DELETE", body, operationId: body.operationId });
  if (receipt.accounts?.some((entry) => entry.id === input.id))
    return yield* new MicPrismManagementError({ reason: "unconfirmed" });
  return receipt;
});

export const startMicPrismLogin = Effect.fn("startMicPrismLogin")(function* (
  input: MicPrismMutationInput & { readonly provider: MicPrismLoginProvider },
) {
  const op = yield* operation(input);
  const body = yield* decodeLoginWrite({ ...op, provider: input.provider }).pipe(Effect.mapError(invalidInput));
  const started = yield* call(input, "prism:accounts:write", MIC_PRISM_API_PATHS.login, MicPrismLoginStarted,
    { method: "POST", body, operationId: op.operationId });
  try {
    const url = new URL(started.authUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      return yield* new MicIdentityUnavailableError({ reason: "invalid-response" });
  } catch {
    return yield* new MicIdentityUnavailableError({ reason: "invalid-response" });
  }
  return started;
});
export const getMicPrismLoginStatus = Effect.fn("getMicPrismLoginStatus")(function* (
  input: MicIdentityClientInput & { readonly sessionId: string },
) {
  const status = yield* call(input, "prism:accounts:write", loginPath(input.sessionId), MicPrismManagedLoginStatus, undefined);
  if (status.sessionId !== input.sessionId)
    return yield* new MicIdentityUnavailableError({ reason: "invalid-response" });
  return status;
});

export const completeMicPrismLogin = Effect.fn("completeMicPrismLogin")(function* (
  input: MicPrismMutationInput & { readonly sessionId: string; readonly redirectUrl: string },
) {
  const op = yield* operation(input);
  const body = yield* decodeCallbackWrite({ ...op, redirectUrl: input.redirectUrl }).pipe(Effect.mapError(invalidInput));
  return yield* call(input, "prism:accounts:write", `${loginPath(input.sessionId)}/callback`, MicPrismManagedLoginStatus,
    { method: "POST", body, operationId: op.operationId });
});
export const cancelMicPrismLogin = Effect.fn("cancelMicPrismLogin")(function* (
  input: MicPrismMutationInput & { readonly sessionId: string },
) {
  const body = yield* operation(input);
  return yield* call(input, "prism:accounts:write", loginPath(input.sessionId), MicPrismManagedLoginStatus,
    { method: "DELETE", body, operationId: body.operationId });
});

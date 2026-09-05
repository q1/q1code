/**
 * Typed client for the q1code accounts API (`/api/fork/prism/...`). This is
 * the contract the Accounts UI codes against; no React here.
 *
 * Every function takes the same `prepared` connection the other environment
 * HTTP helpers take (`PreparedConnection` from the connection supervisor) plus
 * the optional DPoP `signer` for relay connections, and needs an
 * `HttpClient.HttpClient` in context (`remoteHttpClientLayer(fetch)` or the
 * app runtime's). Results are decoded `@q1code/core/prismApi` types.
 *
 * Failures are `PrismClientError`:
 * - `PrismUnavailableError` (HTTP 503): flag off, sidecar not ready, or
 *   sync not configured. Read `reason` and `state`; the UI should show the
 *   sidecar state instead of an error toast.
 * - `PrismUpstreamError` (502): the sidecar refused; `message` is its text.
 * - `PrismNotFoundError` (404): unknown account or login session.
 * - `PrismConfigError` (500): the sidecar took the change but `fork.json`
 *   could not be written, so it will not survive a restart.
 * - `PrismSyncFailedError` (500): a sync export or push failed.
 * - `EnvironmentAuthInvalidError` (401) / `EnvironmentScopeRequiredError`
 *   (403) and the transport errors every environment request can raise.
 *
 * Reads need `orchestration:read`; `patch`, `delete`, `startLogin`,
 * `cancelLogin`, `completeLogin`, `setRouting`, and `restart` need
 * `access:write`. `restartPrism` restarts the sidecar (or re-probes an
 * external proxy) and answers with the status right after; poll
 * `getPrismStatus` until `ready` or `failed`. With the flag off it is a 503.
 *
 * Login flow: `startPrismLogin` -> open `authUrl` (show `userCode` for
 * device flows) -> poll `getPrismLoginStatus` until `completed` (then
 * `accountId` names the new account) or `failed`. When the browser that
 * finished the OAuth redirect is not on the server machine, the user pastes
 * the redirect URL into `completePrismLogin`. `cancelPrismLogin` stops a
 * pending flow.
 */
import {
  type PrismAccount,
  type PrismAccountId,
  type PrismAccountPatch,
  type PrismConfigError,
  PrismHttpApi,
  type PrismLoginProvider,
  type PrismLoginStarted,
  type PrismLoginStatus,
  type PrismNotFoundError,
  type PrismRouting,
  type PrismStatus,
  type PrismSyncFailedError,
  type PrismSyncStatus,
  type PrismUnavailableError,
  type PrismUpstreamError,
  type PrismUsage,
} from "@q1code/core/prismApi";
import type { PrismRoutingStrategy } from "@q1code/core/config";
import type { MicIdentityAccess, MicIdentityPublicConfig } from "@q1code/core/micIdentityApi";
import {
  MIC_IDENTITY_SESSION_HEADER,
  MicIdentityUnavailableError,
  type MicIdentityClientError,
} from "@q1code/core/micIdentity";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FetchHttpClient, Headers, type HttpClient, type HttpMethod } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";
import { resolveMicIdentityToken, type MicIdentityTokenSource } from "./micIdentityClient.ts";

export type {
  PrismAccount,
  PrismAccountId,
  PrismAccountPatch,
  PrismLoginProvider,
  PrismLoginStarted,
  PrismLoginStatus,
  PrismRouting,
  PrismStatus,
  PrismSyncStatus,
  PrismUsage,
} from "@q1code/core/prismApi";

export interface PrismClientInput {
  readonly prepared: PreparedConnection;
  /** Only needed for relay (DPoP) connections; pass `Option.none()` otherwise. */
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
  /** Additional human authorization; environment bearer/DPoP/cookies remain required. */
  readonly micScToken?: MicIdentityTokenSource;
}

type DeclaredError =
  | PrismUnavailableError
  | PrismUpstreamError
  | PrismNotFoundError
  | PrismConfigError
  | PrismSyncFailedError
  | MicIdentityClientError;

export type PrismClientError = DeclaredError | RemoteEnvironmentRequestError;

const DEFAULT_TIMEOUT_MS = 15_000;

/** Errors the API declares, which the generated client decodes into instances and we pass through. */
const DECLARED_TAGS = new Set([
  "PrismUnavailableError",
  "PrismUpstreamError",
  "PrismNotFoundError",
  "PrismConfigError",
  "PrismSyncFailedError",
  "MicIdentityUnauthorizedError",
  "MicIdentityForbiddenError",
  "MicIdentityUnavailableError",
]);

const isDeclaredError = (error: unknown): error is DeclaredError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof error._tag === "string" &&
  DECLARED_TAGS.has(error._tag);

type Api = HttpApiClient.ForApi<typeof PrismHttpApi>;

type Outcome<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "declared"; readonly error: DeclaredError };

/**
 * One authenticated call: build the request URL for the DPoP proof exactly the
 * way the client will send it, attach credentials, run with the shared
 * timeout/transport error mapping, and let the fork's own typed errors through.
 */
const call = <A, E, R>(
  input: PrismClientInput,
  method: HttpMethod.HttpMethod,
  endpoint: string & keyof Api["prism"],
  request: (
    client: Api,
    headers: {
      readonly authorization?: string;
      readonly dpop?: string;
      readonly "x-mic-sc-session"?: string;
    },
  ) => Effect.Effect<A, E, R>,
  params?: Record<string, string>,
): Effect.Effect<A, PrismClientError, R | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const remoteAuthorization =
      input.remoteAuthorization ?? (yield* Effect.serviceOption(RemoteEnvironmentAuthorization));
    const redactedHeaders = yield* Headers.CurrentRedactedNames;
    // Upstream may refresh the relay origin without replacing the prepared socket.
    // Build the fork client from the same origin used for each request's proof.
    let currentBaseUrl = input.prepared.httpBaseUrl;
    const outcome = yield* executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      remoteAuthorization,
      method,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      url: (httpBaseUrl) => {
        const baseUrl = new URL(httpBaseUrl);
        baseUrl.pathname = "/";
        baseUrl.search = "";
        baseUrl.hash = "";
        currentBaseUrl = baseUrl.toString();
        const urls = HttpApiClient.urlBuilder(PrismHttpApi, { baseUrl: currentBaseUrl });
        const buildUrl = (
          urls.prism as unknown as Record<string, (request?: { readonly params?: unknown }) => URL>
        )[endpoint]!;
        return String(buildUrl(params === undefined ? undefined : { params }));
      },
      request: ({ headers }) =>
        Effect.gen(function* () {
          const micToken =
            input.micScToken === undefined
              ? undefined
              : yield* resolveMicIdentityToken(input.micScToken);
          const client = yield* HttpApiClient.make(PrismHttpApi, { baseUrl: currentBaseUrl });
          const operation = request(
            client,
            micToken === undefined
              ? headers
              : { ...headers, [MIC_IDENTITY_SESSION_HEADER]: micToken },
          );
          const requestInit = Option.getOrElse(
            yield* Effect.serviceOption(FetchHttpClient.RequestInit),
            () => ({}),
          );
          return yield* micToken === undefined
            ? operation
            : operation.pipe(
                Effect.provideService(FetchHttpClient.RequestInit, {
                  ...requestInit,
                  redirect: "error",
                  cache: "no-store",
                }),
              );
        }).pipe(
          Effect.map((value): Outcome<A> => ({ _tag: "ok", value })),
          Effect.catch((error) =>
            isDeclaredError(error)
              ? Effect.succeed<Outcome<A>>({ _tag: "declared", error })
              : Effect.fail(error),
          ),
        ),
    }).pipe(
      Effect.provideService(Headers.CurrentRedactedNames, [
        ...redactedHeaders,
        MIC_IDENTITY_SESSION_HEADER,
      ]),
      // Effect transport errors retain request headers. Do not put a human
      // session token into a UI error, log, or serialized failure cause.
      Effect.mapError((error) =>
        input.micScToken === undefined
          ? error
          : new MicIdentityUnavailableError({ reason: "transport" }),
      ),
    );
    if (outcome._tag === "ok") return outcome.value;
    return yield* outcome.error;
  });

export const getPrismStatus = (
  input: PrismClientInput,
): Effect.Effect<PrismStatus, PrismClientError, HttpClient.HttpClient> =>
  call(input, "GET", "status", (client, headers) => client.prism.status({ headers }));

/** Sign-in bootstrap still requires environment access, but not a human session. */
export const getPrismIdentityConfig = (
  input: PrismClientInput,
): Effect.Effect<MicIdentityPublicConfig, PrismClientError, HttpClient.HttpClient> => {
  const { micScToken: _micScToken, ...environmentInput } = input;
  return call(environmentInput, "GET", "identityConfig", (client, headers) =>
    client.prism.identityConfig({ headers }),
  );
};

export const getPrismIdentityAccess = (
  input: PrismClientInput,
): Effect.Effect<MicIdentityAccess, PrismClientError, HttpClient.HttpClient> =>
  call(input, "GET", "identityAccess", (client, headers) =>
    client.prism.identityAccess({ headers }),
  );

/** Turn the Limits-view publication of Prism's accounts on or off; answers with the status (`usageSource` reflects the new value). */
export const setPrismUsageSource = (
  input: PrismClientInput & { readonly enabled: boolean },
): Effect.Effect<PrismStatus, PrismClientError, HttpClient.HttpClient> =>
  call(input, "PUT", "setUsageSource", (client, headers) =>
    client.prism.setUsageSource({ headers, payload: { enabled: input.enabled } }),
  );

export const restartPrism = (
  input: PrismClientInput,
): Effect.Effect<PrismStatus, PrismClientError, HttpClient.HttpClient> =>
  call(input, "POST", "restart", (client, headers) => client.prism.restart({ headers }));

export const listPrismAccounts = (
  input: PrismClientInput,
): Effect.Effect<ReadonlyArray<PrismAccount>, PrismClientError, HttpClient.HttpClient> =>
  call(input, "GET", "listAccounts", (client, headers) =>
    client.prism.listAccounts({ headers }).pipe(Effect.map((result) => result.accounts)),
  );

export const startPrismLogin = (
  input: PrismClientInput & { readonly provider: PrismLoginProvider },
): Effect.Effect<PrismLoginStarted, PrismClientError, HttpClient.HttpClient> =>
  call(input, "POST", "startLogin", (client, headers) =>
    client.prism.startLogin({ headers, payload: { provider: input.provider } }),
  );

export const getPrismLoginStatus = (
  input: PrismClientInput & { readonly sessionId: string },
): Effect.Effect<PrismLoginStatus, PrismClientError, HttpClient.HttpClient> =>
  call(
    input,
    "GET",
    "loginStatus",
    (client, headers) =>
      client.prism.loginStatus({ headers, params: { sessionId: input.sessionId } }),
    { sessionId: input.sessionId },
  );

/** For redirect flows finished in a browser off the server box: hand over the pasted redirect URL. */
export const completePrismLogin = (
  input: PrismClientInput & { readonly sessionId: string; readonly redirectUrl: string },
): Effect.Effect<PrismLoginStatus, PrismClientError, HttpClient.HttpClient> =>
  call(
    input,
    "POST",
    "loginCallback",
    (client, headers) =>
      client.prism.loginCallback({
        headers,
        params: { sessionId: input.sessionId },
        payload: { redirectUrl: input.redirectUrl },
      }),
    { sessionId: input.sessionId },
  );

export const cancelPrismLogin = (
  input: PrismClientInput & { readonly sessionId: string },
): Effect.Effect<PrismLoginStatus, PrismClientError, HttpClient.HttpClient> =>
  call(
    input,
    "DELETE",
    "cancelLogin",
    (client, headers) =>
      client.prism.cancelLogin({ headers, params: { sessionId: input.sessionId } }),
    { sessionId: input.sessionId },
  );

export const patchPrismAccount = (
  input: PrismClientInput & {
    readonly id: PrismAccountId;
    readonly patch: PrismAccountPatch;
  },
): Effect.Effect<PrismAccount, PrismClientError, HttpClient.HttpClient> =>
  call(
    input,
    "PATCH",
    "patchAccount",
    (client, headers) =>
      client.prism.patchAccount({ headers, params: { id: input.id }, payload: input.patch }),
    { id: input.id },
  );

export const deletePrismAccount = (
  input: PrismClientInput & { readonly id: PrismAccountId },
): Effect.Effect<void, PrismClientError, HttpClient.HttpClient> =>
  call(
    input,
    "DELETE",
    "deleteAccount",
    (client, headers) =>
      client.prism.deleteAccount({ headers, params: { id: input.id } }).pipe(Effect.asVoid),
    { id: input.id },
  );

export const getPrismRouting = (
  input: PrismClientInput,
): Effect.Effect<PrismRouting, PrismClientError, HttpClient.HttpClient> =>
  call(input, "GET", "getRouting", (client, headers) => client.prism.getRouting({ headers }));

export const setPrismRouting = (
  input: PrismClientInput & { readonly strategy: PrismRoutingStrategy },
): Effect.Effect<PrismRouting, PrismClientError, HttpClient.HttpClient> =>
  call(input, "PUT", "setRouting", (client, headers) =>
    client.prism.setRouting({ headers, payload: { strategy: input.strategy } }),
  );

export const getPrismUsage = (
  input: PrismClientInput,
): Effect.Effect<PrismUsage, PrismClientError, HttpClient.HttpClient> =>
  call(input, "GET", "getUsage", (client, headers) => client.prism.getUsage({ headers }));

export const getPrismSyncStatus = (
  input: PrismClientInput,
): Effect.Effect<PrismSyncStatus, PrismClientError, HttpClient.HttpClient> =>
  call(input, "GET", "syncStatus", (client, headers) => client.prism.syncStatus({ headers }));

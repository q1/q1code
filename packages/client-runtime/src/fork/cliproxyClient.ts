/**
 * Typed client for the q1code accounts API (`/api/fork/cliproxy/...`). This is
 * the contract the Accounts UI codes against; no React here.
 *
 * Every function takes the same `prepared` connection the other environment
 * HTTP helpers take (`PreparedConnection` from the connection supervisor) plus
 * the optional DPoP `signer` for relay connections, and needs an
 * `HttpClient.HttpClient` in context (`remoteHttpClientLayer(fetch)` or the
 * app runtime's). Results are decoded `@q1code/core/cliproxyApi` types.
 *
 * Failures are `CliProxyClientError`:
 * - `CliProxyUnavailableError` (HTTP 503): flag off, sidecar not ready, or
 *   sync not configured. Read `reason` and `state`; the UI should show the
 *   sidecar state instead of an error toast.
 * - `CliProxyUpstreamError` (502): the sidecar refused; `message` is its text.
 * - `CliProxyNotFoundError` (404): unknown account or login session.
 * - `CliProxyConfigError` (500): the sidecar took the change but `fork.json`
 *   could not be written, so it will not survive a restart.
 * - `CliProxySyncFailedError` (500): a sync export or push failed.
 * - `EnvironmentAuthInvalidError` (401) / `EnvironmentScopeRequiredError`
 *   (403) and the transport errors every environment request can raise.
 *
 * Reads need `orchestration:read`; `patch`, `delete`, `startLogin`,
 * `cancelLogin`, `completeLogin`, and `setRouting` need `access:write`.
 *
 * Login flow: `startCliProxyLogin` -> open `authUrl` (show `userCode` for
 * device flows) -> poll `getCliProxyLoginStatus` until `completed` (then
 * `accountId` names the new account) or `failed`. When the browser that
 * finished the OAuth redirect is not on the server machine, the user pastes
 * the redirect URL into `completeCliProxyLogin`. `cancelCliProxyLogin` stops a
 * pending flow.
 */
import {
  type CliProxyAccount,
  type CliProxyAccountId,
  type CliProxyAccountPatch,
  type CliProxyConfigError,
  CliProxyHttpApi,
  type CliProxyLoginProvider,
  type CliProxyLoginStarted,
  type CliProxyLoginStatus,
  type CliProxyNotFoundError,
  type CliProxyRouting,
  type CliProxyStatus,
  type CliProxySyncFailedError,
  type CliProxySyncStatus,
  type CliProxyUnavailableError,
  type CliProxyUpstreamError,
  type CliProxyUsage,
} from "@q1code/core/cliproxyApi";
import type { CliProxyRoutingStrategy } from "@q1code/core/config";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { HttpClient, HttpMethod } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import type { PreparedConnection } from "../connection/model.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, type RemoteEnvironmentRequestError } from "../rpc/http.ts";
import {
  buildEnvironmentAuthHeaders,
  withEnvironmentCredentials,
} from "../state/environmentHttpAuth.ts";

export type {
  CliProxyAccount,
  CliProxyAccountId,
  CliProxyAccountPatch,
  CliProxyLoginProvider,
  CliProxyLoginStarted,
  CliProxyLoginStatus,
  CliProxyRouting,
  CliProxyStatus,
  CliProxySyncStatus,
  CliProxyUsage,
} from "@q1code/core/cliproxyApi";

export interface CliProxyClientInput {
  readonly prepared: PreparedConnection;
  /** Only needed for relay (DPoP) connections; pass `Option.none()` otherwise. */
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}

type DeclaredError =
  | CliProxyUnavailableError
  | CliProxyUpstreamError
  | CliProxyNotFoundError
  | CliProxyConfigError
  | CliProxySyncFailedError;

export type CliProxyClientError = DeclaredError | RemoteEnvironmentRequestError;

const DEFAULT_TIMEOUT_MS = 15_000;

/** Errors the API declares, which the generated client decodes into instances and we pass through. */
const DECLARED_TAGS = new Set([
  "CliProxyUnavailableError",
  "CliProxyUpstreamError",
  "CliProxyNotFoundError",
  "CliProxyConfigError",
  "CliProxySyncFailedError",
]);

const isDeclaredError = (error: unknown): error is DeclaredError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof error._tag === "string" &&
  DECLARED_TAGS.has(error._tag);

type Api = HttpApiClient.ForApi<typeof CliProxyHttpApi>;

type Outcome<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "declared"; readonly error: DeclaredError };

/**
 * One authenticated call: build the request URL for the DPoP proof exactly the
 * way the client will send it, attach credentials, run with the shared
 * timeout/transport error mapping, and let the fork's own typed errors through.
 */
const call = <A, E, R>(
  input: CliProxyClientInput,
  method: HttpMethod.HttpMethod,
  endpoint: string & keyof Api["cliproxy"],
  request: (
    client: Api,
    headers: { readonly authorization?: string; readonly dpop?: string },
  ) => Effect.Effect<A, E, R>,
  params?: Record<string, string>,
): Effect.Effect<A, CliProxyClientError, R | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const baseUrl = new URL(input.prepared.httpBaseUrl);
    baseUrl.pathname = "/";
    baseUrl.search = "";
    baseUrl.hash = "";
    const client = yield* HttpApiClient.make(CliProxyHttpApi, { baseUrl: baseUrl.toString() });
    const urls = HttpApiClient.urlBuilder(CliProxyHttpApi, { baseUrl: baseUrl.toString() });
    const buildUrl = (
      urls.cliproxy as unknown as Record<string, (request?: { readonly params?: unknown }) => URL>
    )[endpoint]!;
    const requestUrl = String(buildUrl(params === undefined ? undefined : { params }));
    const headers = yield* buildEnvironmentAuthHeaders(
      input.prepared.httpAuthorization,
      method,
      requestUrl,
      input.signer,
    );
    const outcome = yield* executeEnvironmentHttpRequest(
      requestUrl,
      input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      withEnvironmentCredentials(
        input.prepared.httpAuthorization,
        request(client, headers).pipe(
          Effect.map((value): Outcome<A> => ({ _tag: "ok", value })),
          Effect.catch((error) =>
            isDeclaredError(error)
              ? Effect.succeed<Outcome<A>>({ _tag: "declared", error })
              : Effect.fail(error),
          ),
        ),
      ),
    );
    if (outcome._tag === "ok") return outcome.value;
    return yield* outcome.error;
  });

export const getCliProxyStatus = (
  input: CliProxyClientInput,
): Effect.Effect<CliProxyStatus, CliProxyClientError, HttpClient.HttpClient> =>
  call(input, "GET", "status", (client, headers) => client.cliproxy.status({ headers }));

export const listCliProxyAccounts = (
  input: CliProxyClientInput,
): Effect.Effect<ReadonlyArray<CliProxyAccount>, CliProxyClientError, HttpClient.HttpClient> =>
  call(input, "GET", "listAccounts", (client, headers) =>
    client.cliproxy.listAccounts({ headers }).pipe(Effect.map((result) => result.accounts)),
  );

export const startCliProxyLogin = (
  input: CliProxyClientInput & { readonly provider: CliProxyLoginProvider },
): Effect.Effect<CliProxyLoginStarted, CliProxyClientError, HttpClient.HttpClient> =>
  call(input, "POST", "startLogin", (client, headers) =>
    client.cliproxy.startLogin({ headers, payload: { provider: input.provider } }),
  );

export const getCliProxyLoginStatus = (
  input: CliProxyClientInput & { readonly sessionId: string },
): Effect.Effect<CliProxyLoginStatus, CliProxyClientError, HttpClient.HttpClient> =>
  call(
    input,
    "GET",
    "loginStatus",
    (client, headers) =>
      client.cliproxy.loginStatus({ headers, params: { sessionId: input.sessionId } }),
    { sessionId: input.sessionId },
  );

/** For redirect flows finished in a browser off the server box: hand over the pasted redirect URL. */
export const completeCliProxyLogin = (
  input: CliProxyClientInput & { readonly sessionId: string; readonly redirectUrl: string },
): Effect.Effect<CliProxyLoginStatus, CliProxyClientError, HttpClient.HttpClient> =>
  call(
    input,
    "POST",
    "loginCallback",
    (client, headers) =>
      client.cliproxy.loginCallback({
        headers,
        params: { sessionId: input.sessionId },
        payload: { redirectUrl: input.redirectUrl },
      }),
    { sessionId: input.sessionId },
  );

export const cancelCliProxyLogin = (
  input: CliProxyClientInput & { readonly sessionId: string },
): Effect.Effect<CliProxyLoginStatus, CliProxyClientError, HttpClient.HttpClient> =>
  call(
    input,
    "DELETE",
    "cancelLogin",
    (client, headers) =>
      client.cliproxy.cancelLogin({ headers, params: { sessionId: input.sessionId } }),
    { sessionId: input.sessionId },
  );

export const patchCliProxyAccount = (
  input: CliProxyClientInput & {
    readonly id: CliProxyAccountId;
    readonly patch: CliProxyAccountPatch;
  },
): Effect.Effect<CliProxyAccount, CliProxyClientError, HttpClient.HttpClient> =>
  call(
    input,
    "PATCH",
    "patchAccount",
    (client, headers) =>
      client.cliproxy.patchAccount({ headers, params: { id: input.id }, payload: input.patch }),
    { id: input.id },
  );

export const deleteCliProxyAccount = (
  input: CliProxyClientInput & { readonly id: CliProxyAccountId },
): Effect.Effect<void, CliProxyClientError, HttpClient.HttpClient> =>
  call(
    input,
    "DELETE",
    "deleteAccount",
    (client, headers) =>
      client.cliproxy.deleteAccount({ headers, params: { id: input.id } }).pipe(Effect.asVoid),
    { id: input.id },
  );

export const getCliProxyRouting = (
  input: CliProxyClientInput,
): Effect.Effect<CliProxyRouting, CliProxyClientError, HttpClient.HttpClient> =>
  call(input, "GET", "getRouting", (client, headers) => client.cliproxy.getRouting({ headers }));

export const setCliProxyRouting = (
  input: CliProxyClientInput & { readonly strategy: CliProxyRoutingStrategy },
): Effect.Effect<CliProxyRouting, CliProxyClientError, HttpClient.HttpClient> =>
  call(input, "PUT", "setRouting", (client, headers) =>
    client.cliproxy.setRouting({ headers, payload: { strategy: input.strategy } }),
  );

export const getCliProxyUsage = (
  input: CliProxyClientInput,
): Effect.Effect<CliProxyUsage, CliProxyClientError, HttpClient.HttpClient> =>
  call(input, "GET", "getUsage", (client, headers) => client.cliproxy.getUsage({ headers }));

export const getCliProxySyncStatus = (
  input: CliProxyClientInput,
): Effect.Effect<CliProxySyncStatus, CliProxyClientError, HttpClient.HttpClient> =>
  call(input, "GET", "syncStatus", (client, headers) => client.cliproxy.syncStatus({ headers }));

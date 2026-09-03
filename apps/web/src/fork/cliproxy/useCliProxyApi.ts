/**
 * The Prism client bound to the primary environment's prepared connection.
 * Every call resolves to a plain result so the panel never `try`s: typed
 * failures land in `error`, and only a defect rejects the promise.
 */
import {
  cancelCliProxyLogin,
  type CliProxyAccountId,
  type CliProxyAccountPatch,
  type CliProxyClientError,
  type CliProxyClientInput,
  type CliProxyLoginProvider,
  completeCliProxyLogin,
  deleteCliProxyAccount,
  getCliProxyLoginStatus,
  getCliProxyRouting,
  getCliProxyStatus,
  getCliProxySyncStatus,
  getCliProxyUsage,
  listCliProxyAccounts,
  patchCliProxyAccount,
  restartCliProxy,
  setCliProxyRouting,
  startCliProxyLogin,
} from "@t3tools/client-runtime/fork";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import type { CliProxyRoutingStrategy } from "@q1code/core/config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { HttpClient } from "effect/unstable/http";
import { useMemo } from "react";

import { runtime } from "~/lib/runtime";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { usePreparedConnection } from "~/state/session";

import { describeCliProxyPermissionError } from "./cliproxyAccountsState";

export type CliProxyCallError = CliProxyClientError | { readonly _tag: "UnknownError" };

export type CliProxyResult<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "error"; readonly error: CliProxyCallError };

type Call<A> = (
  input: CliProxyClientInput,
) => Effect.Effect<A, CliProxyClientError, HttpClient.HttpClient>;

const bindCalls = (prepared: CliProxyClientInput["prepared"]) => {
  const run = <A>(call: Call<A>): Promise<CliProxyResult<A>> =>
    runtime
      .runPromise(
        Effect.gen(function* () {
          const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
          return yield* call({ prepared, signer });
        }).pipe(
          Effect.match({
            onFailure: (error): CliProxyResult<A> => ({ _tag: "error", error }),
            onSuccess: (value): CliProxyResult<A> => ({ _tag: "ok", value }),
          }),
        ),
      )
      .catch((): CliProxyResult<A> => ({ _tag: "error", error: { _tag: "UnknownError" } }));

  return {
    status: () => run(getCliProxyStatus),
    /** Answers with the status right after; poll `status` until `ready` or `failed`. */
    restart: () => run(restartCliProxy),
    syncStatus: () => run(getCliProxySyncStatus),
    listAccounts: () => run(listCliProxyAccounts),
    startLogin: (provider: CliProxyLoginProvider) =>
      run((input) => startCliProxyLogin({ ...input, provider })),
    loginStatus: (sessionId: string) =>
      run((input) => getCliProxyLoginStatus({ ...input, sessionId })),
    completeLogin: (sessionId: string, redirectUrl: string) =>
      run((input) => completeCliProxyLogin({ ...input, sessionId, redirectUrl })),
    cancelLogin: (sessionId: string) =>
      run((input) => cancelCliProxyLogin({ ...input, sessionId })),
    patchAccount: (id: CliProxyAccountId, patch: CliProxyAccountPatch) =>
      run((input) => patchCliProxyAccount({ ...input, id, patch })),
    deleteAccount: (id: CliProxyAccountId) =>
      run((input) => deleteCliProxyAccount({ ...input, id })),
    getRouting: () => run(getCliProxyRouting),
    setRouting: (strategy: CliProxyRoutingStrategy) =>
      run((input) => setCliProxyRouting({ ...input, strategy })),
    getUsage: () => run(getCliProxyUsage),
  };
};

export type CliProxyApi = ReturnType<typeof bindCalls>;

/** `null` until the primary environment has a prepared connection. */
export function useCliProxyApi(): CliProxyApi | null {
  const environmentId = usePrimaryEnvironmentId();
  const prepared = usePreparedConnection(environmentId);
  const preparedValue = Option.getOrNull(prepared);
  return useMemo(() => (preparedValue ? bindCalls(preparedValue) : null), [preparedValue]);
}

export function isCliProxyPermissionError(
  error: CliProxyCallError,
): error is Extract<
  CliProxyCallError,
  { _tag: "EnvironmentScopeRequiredError" | "EnvironmentAuthInvalidError" }
> {
  return (
    error._tag === "EnvironmentScopeRequiredError" || error._tag === "EnvironmentAuthInvalidError"
  );
}

/** Toast/inline text for a failed call. Never includes a token or a management secret. */
export function describeCliProxyCallError(error: CliProxyCallError): string {
  switch (error._tag) {
    case "CliProxyUnavailableError":
      return error.message;
    case "CliProxyUpstreamError":
      return `CLIProxyAPI answered ${error.status}: ${error.message}`;
    case "CliProxyNotFoundError":
      return error.message;
    case "CliProxyConfigError":
      return error.message;
    case "CliProxySyncFailedError":
      return error.message;
    case "EnvironmentScopeRequiredError":
    case "EnvironmentAuthInvalidError":
      return describeCliProxyPermissionError(error);
    case "UnknownError":
      return "The request failed unexpectedly.";
    default:
      return "message" in error && typeof error.message === "string"
        ? error.message
        : "The request failed.";
  }
}

/**
 * The accounts client bound to one environment's prepared connection. Every
 * call resolves to a plain result so the screen never `try`s: typed failures
 * land in `error`, and only a defect becomes `UnknownError`.
 */
import type { CliProxyRoutingStrategy } from "@q1code/core/config";
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
  listCliProxyAccounts,
  patchCliProxyAccount,
  restartCliProxy,
  setCliProxyRouting,
  startCliProxyLogin,
} from "@t3tools/client-runtime/fork";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { HttpClient } from "effect/unstable/http";
import { useMemo } from "react";

import { runtime } from "../../lib/runtime";
import { usePreparedConnection } from "../../state/session";
import type { CliProxyCallError } from "./cliproxySettings.logic";

export type CliProxyResult<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "error"; readonly error: CliProxyCallError };

type Call<A> = (
  input: CliProxyClientInput,
) => Effect.Effect<A, CliProxyClientError, HttpClient.HttpClient>;

export function bindCliProxyCalls(prepared: CliProxyClientInput["prepared"]) {
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
    restart: () => run(restartCliProxy),
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
  };
}

export type CliProxyApi = ReturnType<typeof bindCliProxyCalls>;

/** `null` until the environment has a prepared connection. */
export function useCliProxyApi(environmentId: EnvironmentId): CliProxyApi | null {
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  return useMemo(() => (prepared ? bindCliProxyCalls(prepared) : null), [prepared]);
}

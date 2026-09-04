/**
 * The accounts client bound to one environment's prepared connection. Every
 * call resolves to a plain result so the screen never `try`s: typed failures
 * land in `error`, and only a defect becomes `UnknownError`.
 */
import type { PrismRoutingStrategy } from "@q1code/core/config";
import {
  cancelPrismLogin,
  type PrismAccountId,
  type PrismAccountPatch,
  type PrismClientError,
  type PrismClientInput,
  type PrismLoginProvider,
  completePrismLogin,
  deletePrismAccount,
  getPrismLoginStatus,
  getPrismRouting,
  getPrismStatus,
  listPrismAccounts,
  patchPrismAccount,
  restartPrism,
  setPrismRouting,
  startPrismLogin,
} from "@t3tools/client-runtime/fork";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { HttpClient } from "effect/unstable/http";
import { useMemo } from "react";

import { runtime } from "../../lib/runtime";
import { usePreparedConnection } from "../../state/session";
import type { PrismCallError } from "./prismSettings.logic";

export type PrismResult<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "error"; readonly error: PrismCallError };

type Call<A> = (
  input: PrismClientInput,
) => Effect.Effect<A, PrismClientError, HttpClient.HttpClient>;

export function bindPrismCalls(prepared: PrismClientInput["prepared"]) {
  const run = <A>(call: Call<A>): Promise<PrismResult<A>> =>
    runtime
      .runPromise(
        Effect.gen(function* () {
          const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
          return yield* call({ prepared, signer });
        }).pipe(
          Effect.match({
            onFailure: (error): PrismResult<A> => ({ _tag: "error", error }),
            onSuccess: (value): PrismResult<A> => ({ _tag: "ok", value }),
          }),
        ),
      )
      .catch((): PrismResult<A> => ({ _tag: "error", error: { _tag: "UnknownError" } }));

  return {
    status: () => run(getPrismStatus),
    restart: () => run(restartPrism),
    listAccounts: () => run(listPrismAccounts),
    startLogin: (provider: PrismLoginProvider) =>
      run((input) => startPrismLogin({ ...input, provider })),
    loginStatus: (sessionId: string) =>
      run((input) => getPrismLoginStatus({ ...input, sessionId })),
    completeLogin: (sessionId: string, redirectUrl: string) =>
      run((input) => completePrismLogin({ ...input, sessionId, redirectUrl })),
    cancelLogin: (sessionId: string) => run((input) => cancelPrismLogin({ ...input, sessionId })),
    patchAccount: (id: PrismAccountId, patch: PrismAccountPatch) =>
      run((input) => patchPrismAccount({ ...input, id, patch })),
    deleteAccount: (id: PrismAccountId) => run((input) => deletePrismAccount({ ...input, id })),
    getRouting: () => run(getPrismRouting),
    setRouting: (strategy: PrismRoutingStrategy) =>
      run((input) => setPrismRouting({ ...input, strategy })),
  };
}

export type PrismApi = ReturnType<typeof bindPrismCalls>;

/** `null` until the environment has a prepared connection. */
export function usePrismApi(environmentId: EnvironmentId): PrismApi | null {
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  return useMemo(() => (prepared ? bindPrismCalls(prepared) : null), [prepared]);
}

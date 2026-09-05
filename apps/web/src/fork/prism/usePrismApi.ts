/**
 * The Prism client bound to one environment's prepared connection (the
 * primary environment unless the caller names another). Every call resolves
 * to a plain result so the panel never `try`s: typed failures land in
 * `error`, and only a defect rejects the promise.
 */
import {
  cancelPrismLogin,
  connectMicPrismThread,
  disconnectMicPrismThread,
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
  getPrismSyncStatus,
  getPrismIdentityConfig,
  getPrismIdentityAccess,
  readForkFlag,
  listPrismAccounts,
  patchPrismAccount,
  restartPrism,
  setPrismRouting,
  setPrismUsageSource,
  startPrismLogin,
} from "@t3tools/client-runtime/fork";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import type { PrismRoutingStrategy } from "@q1code/core/config";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { HttpClient } from "effect/unstable/http";
import { useMemo, useSyncExternalStore } from "react";
import { useAtomValue } from "@effect/atom-react";
import { MicIdentityUnauthorizedError } from "@q1code/core/micIdentity";

import { runtime } from "~/lib/runtime";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { usePreparedConnection } from "~/state/session";
import { primaryServerConfigAtom, serverEnvironment } from "~/state/server";
import {
  micIdentityGeneration,
  readMicIdentityToken,
  subscribeMicIdentity,
} from "../mic-identity/micIdentitySession";

import { describePrismPermissionError } from "./prismAccountsState";

export type PrismCallError = PrismClientError | { readonly _tag: "UnknownError" };

export type PrismResult<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "error"; readonly error: PrismCallError };

type Call<A> = (
  input: PrismClientInput,
) => Effect.Effect<A, PrismClientError, HttpClient.HttpClient>;

const bindCalls = (
  prepared: PrismClientInput["prepared"],
  identity: boolean,
  generation: number,
) => {
  const run = <A>(call: Call<A>, human = identity): Promise<PrismResult<A>> =>
    runtime
      .runPromise(
        Effect.gen(function* () {
          if (human && micIdentityGeneration() !== generation) {
            return yield* new MicIdentityUnauthorizedError({ reason: "sign-in-required" });
          }
          const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
          return yield* call({
            prepared,
            signer,
            ...(human ? { micScToken: readMicIdentityToken } : {}),
          });
        }).pipe(
          Effect.match({
            onFailure: (error): PrismResult<A> => ({ _tag: "error", error }),
            onSuccess: (value): PrismResult<A> => ({ _tag: "ok", value }),
          }),
        ),
      )
      .catch((): PrismResult<A> => ({ _tag: "error", error: { _tag: "UnknownError" } }));

  return {
    connectThread: (threadId: string) =>
      run((input) => connectMicPrismThread({ ...input, threadId })),
    disconnectThread: (threadId: string) =>
      run((input) => disconnectMicPrismThread({ ...input, threadId }), false),
    identityConfig: () => run(getPrismIdentityConfig),
    identityAccess: () => run(getPrismIdentityAccess),
    status: () => run(getPrismStatus),
    /** Answers with the status right after; poll `status` until `ready` or `failed`. */
    restart: () => run(restartPrism),
    /** Answers with the status; `usageSource` carries the new value. */
    setUsageSource: (enabled: boolean) =>
      run((input) => setPrismUsageSource({ ...input, enabled })),
    syncStatus: () => run(getPrismSyncStatus),
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
};

export type PrismApi = ReturnType<typeof bindCalls>;

/** `null` until the environment (the primary one by default) has a prepared connection. */
export function usePrismApi(
  environmentId?: EnvironmentId | null,
  bootstrap = false,
): PrismApi | null {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const targetId = environmentId === undefined ? primaryEnvironmentId : environmentId;
  const prepared = usePreparedConnection(targetId);
  const config = useAtomValue(
    targetId === null ? primaryServerConfigAtom : serverEnvironment.configValueAtom(targetId),
  );
  const identity = readForkFlag(config?.environment.capabilities, "mic-identity");
  const sessionGeneration = useSyncExternalStore(subscribeMicIdentity, micIdentityGeneration);
  const generation = identity && !bootstrap ? sessionGeneration : 0;
  const preparedValue = Option.getOrNull(prepared);
  return useMemo(() => {
    return preparedValue ? bindCalls(preparedValue, identity && !bootstrap, generation) : null;
  }, [preparedValue, identity, bootstrap, generation]);
}

export function isPrismPermissionError(error: PrismCallError): error is Extract<
  PrismCallError,
  {
    _tag:
      | "EnvironmentScopeRequiredError"
      | "EnvironmentAuthInvalidError"
      | "MicIdentityUnauthorizedError"
      | "MicIdentityForbiddenError";
  }
> {
  return (
    error._tag === "EnvironmentScopeRequiredError" ||
    error._tag === "EnvironmentAuthInvalidError" ||
    error._tag === "MicIdentityUnauthorizedError" ||
    error._tag === "MicIdentityForbiddenError"
  );
}

/** Toast/inline text for a failed call. Never includes a token or a management secret. */
export function describePrismCallError(error: PrismCallError): string {
  switch (error._tag) {
    case "PrismUnavailableError":
      return error.message;
    case "PrismUpstreamError":
      return `Prism answered ${error.status}: ${error.message}`;
    case "PrismNotFoundError":
      return error.message;
    case "PrismConfigError":
      return error.message;
    case "PrismSyncFailedError":
      return error.message;
    case "EnvironmentScopeRequiredError":
    case "EnvironmentAuthInvalidError":
      return describePrismPermissionError(error);
    case "UnknownError":
      return "The request failed unexpectedly.";
    default:
      return "message" in error && typeof error.message === "string"
        ? error.message
        : "The request failed.";
  }
}

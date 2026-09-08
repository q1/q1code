import type {
  MicPrismAccountPatch,
  MicPrismAccountsState,
  MicPrismAvailability,
  MicPrismLoginProvider,
  MicPrismLoginStarted,
  MicPrismManagedLoginStatus,
  MicPrismSettings,
  MicPrismSettingsState,
} from "@q1code/core/micPrismApi";
import type { MicPrismPermission } from "@q1code/core/micIdentity";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/unstable/http";
import type { MicIdentityClientInput } from "./micIdentityClient.ts";
import {
  cancelMicPrismLogin,
  completeMicPrismLogin,
  deleteMicPrismAccount,
  getMicPrismAccounts,
  getMicPrismAvailability,
  getMicPrismLoginStatus,
  getMicPrismSettings,
  patchMicPrismAccount,
  setMicPrismSettings,
  startMicPrismLogin,
  type MicPrismManagementClientError,
} from "./micPrismManagement.ts";

export interface MicPrismManagementState {
  readonly accounts: MicPrismAccountsState | null;
  readonly settings: MicPrismSettingsState | null;
  readonly availability: MicPrismAvailability | null;
  readonly login: MicPrismLoginStarted | null;
  readonly loginStatus: MicPrismManagedLoginStatus | null;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly notice: string | null;
  readonly receivedAt: number;
}
export type MicPrismManagementRunner = <A>(
  effect: Effect.Effect<A, MicPrismManagementClientError, HttpClient.HttpClient | Crypto.Crypto>,
  signal: AbortSignal,
) => Promise<A>;

/** One controller per signed-in account and host. Reads retain stale state; mutations never queue or replay. */
export function createMicPrismManagementController(options: {
  readonly input: MicIdentityClientInput & {
    readonly expectedService: NonNullable<MicIdentityClientInput["expectedService"]>;
  };
  readonly permissions: ReadonlyArray<string>;
  readonly run: MicPrismManagementRunner;
}) {
  let state: MicPrismManagementState = {
    accounts: null,
    settings: null,
    availability: null,
    login: null,
    loginStatus: null,
    loading: false,
    busy: false,
    error: null,
    notice: null,
    receivedAt: 0,
  };
  let active = false;
  let sequence = 0;
  let controller: AbortController | null = null;
  let permissions = options.permissions;
  const listeners = new Set<() => void>();
  const emit = (patch: Partial<MicPrismManagementState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const isCurrent = () => active && options.input.isCurrent?.() !== false;
  const input = { ...options.input, isCurrent };
  const allowed = (permission: MicPrismPermission) => permissions.includes(permission);
  const message = (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "Prism could not be reached. Refresh to check its current state.";
  const valid = (ticket: number) => isCurrent() && ticket === sequence;

  const refresh = async (afterWrite = false) => {
    if (!isCurrent() || state.loading || (state.busy && !afterWrite)) return;
    const ticket = ++sequence;
    controller?.abort();
    controller = new AbortController();
    emit({ loading: true });
    try {
      const values = await options.run(
        Effect.all(
          {
            accounts: allowed("prism:accounts:read")
              ? getMicPrismAccounts(input).pipe(Effect.result)
              : Effect.succeed(null),
            settings: allowed("prism:settings:read")
              ? getMicPrismSettings(input).pipe(Effect.result)
              : Effect.succeed(null),
            availability: allowed("prism:inference")
              ? getMicPrismAvailability(input).pipe(Effect.result)
              : Effect.succeed(null),
            loginStatus:
              state.login && allowed("prism:accounts:write")
                ? getMicPrismLoginStatus({ ...input, sessionId: state.login.sessionId }).pipe(
                    Effect.result,
                  )
                : Effect.succeed(null),
          },
          { concurrency: "unbounded" },
        ),
        controller.signal,
      );
      if (!valid(ticket)) {
        if (active && ticket === sequence) emit({ loading: false, busy: false });
        return;
      }
      const failures = Object.values(values).filter((result) => result?._tag === "Failure");
      emit({
        accounts: values.accounts?._tag === "Success" ? values.accounts.success : state.accounts,
        settings: values.settings?._tag === "Success" ? values.settings.success : state.settings,
        availability:
          values.availability?._tag === "Success"
            ? values.availability.success
            : state.availability,
        loginStatus:
          values.loginStatus?._tag === "Success" ? values.loginStatus.success : state.loginStatus,
        error: failures.length > 0 ? message(failures[0]!.failure) : null,
        loading: false,
        receivedAt: failures.length === 0 ? Date.now() : state.receivedAt,
      });
    } catch (error) {
      if (valid(ticket)) emit({ loading: false, error: message(error) });
    }
  };

  const write = async <A>(
    permission: MicPrismPermission,
    effect: Effect.Effect<A, MicPrismManagementClientError, HttpClient.HttpClient | Crypto.Crypto>,
    accept: (value: A) => Partial<MicPrismManagementState> = () => ({
      notice: "Confirmed by Prism.",
    }),
  ) => {
    if (!isCurrent() || !allowed(permission) || state.busy || state.loading || state.error)
      return false;
    const ticket = ++sequence;
    controller?.abort();
    controller = new AbortController();
    emit({ busy: true, error: null, notice: null });
    try {
      const value = await options.run(effect, controller.signal);
      if (!valid(ticket)) {
        if (active && ticket === sequence) emit({ loading: false, busy: false });
        return false;
      }
      emit(accept(value));
      await refresh(true);
      return isCurrent();
    } catch (error) {
      if (valid(ticket)) emit({ error: message(error) });
      return false;
    } finally {
      if (isCurrent()) emit({ busy: false });
    }
  };
  const mutation = (revision: string) => ({ ...input, expectedSettingsRevision: revision });
  const loginMutation = (action: "callback" | "cancel", redirectUrl = "") => {
    const sessionId = state.login?.sessionId;
    if (!sessionId) return Promise.resolve();
    return write(
      "prism:accounts:write",
      Effect.gen(function* () {
        const latest = yield* getMicPrismLoginStatus({ ...input, sessionId });
        if (latest.status !== "pending") return latest;
        const request = { ...mutation(latest.settingsRevision), sessionId };
        return yield* action === "callback"
          ? completeMicPrismLogin({ ...request, redirectUrl })
          : cancelMicPrismLogin(request);
      }),
      (loginStatus) => ({
        loginStatus,
        notice:
          loginStatus.status === "completed"
            ? "Sign-in saved. Check account health and model availability before using it."
            : loginStatus.status === "cancelled"
              ? "Sign-in cancelled."
              : "Callback sent. Waiting for the provider.",
      }),
    );
  };

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    activate: () => {
      active = true;
    },
    dispose: () => {
      active = false;
      sequence++;
      controller?.abort();
      state = { ...state, loading: false, busy: false };
    },
    updatePermissions: (next: ReadonlyArray<string>) => {
      if (permissions.length === next.length && permissions.every((value) => next.includes(value)))
        return;
      permissions = next;
      sequence++;
      controller?.abort();
      emit({
        loading: false,
        busy: false,
        ...(!allowed("prism:accounts:read") ? { accounts: null } : {}),
        ...(!allowed("prism:settings:read") ? { settings: null } : {}),
        ...(!allowed("prism:inference") ? { availability: null } : {}),
        ...(!allowed("prism:accounts:write") ? { login: null, loginStatus: null } : {}),
      });
    },
    refresh: () => refresh(),
    setSettings: (settings: MicPrismSettings, revision: string) =>
      write("prism:settings:write", setMicPrismSettings({ ...mutation(revision), settings })),
    patchAccount: (id: string, patch: MicPrismAccountPatch, revision: string) =>
      write("prism:accounts:write", patchMicPrismAccount({ ...mutation(revision), id, patch })),
    deleteAccount: (id: string, revision: string) =>
      write("prism:accounts:write", deleteMicPrismAccount({ ...mutation(revision), id })),
    startLogin: (provider: MicPrismLoginProvider, revision: string) =>
      write(
        "prism:accounts:write",
        startMicPrismLogin({ ...mutation(revision), provider }),
        (login) => ({ login, loginStatus: null, notice: null }),
      ),
    completeLogin: (redirectUrl: string) => loginMutation("callback", redirectUrl),
    cancelLogin: () => loginMutation("cancel"),
    clearLogin: () => {
      if (!state.busy) emit({ login: null, loginStatus: null, notice: null });
    },
  };
}

export const describeMicPrismAvailability = (model: MicPrismAvailability["models"][number]) =>
  `${model.available ? "Available" : "Unavailable"} · ${model.usableAccounts} usable account${model.usableAccounts === 1 ? "" : "s"}`;

export const describeMicPrismWarning = (warning: string) =>
  ({
    prism_soft_reserve: "Accounts are at their soft reserve.",
    provider_quota_exhausted: "The provider limit has been reached.",
    prism_usage_unknown: "Usable quota has not been verified.",
    prism_usage_stale: "Usage is stale; accounts are being checked.",
    requires_login: "An account needs a new sign-in.",
  })[warning] ?? warning.replaceAll("_", " ");

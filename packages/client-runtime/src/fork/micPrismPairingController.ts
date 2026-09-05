import type { MicIdentityAccess } from "@q1code/core/micIdentityApi";
import type {
  MicPrismPairedInstance,
  MicPrismPairingChallenge,
  MicPrismPairingStart,
} from "@q1code/core/micPrismPairing";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/unstable/http";
import {
  completeMicPrismPairing,
  revokeMicPrismInstance,
  selectMicPrismInstance,
  startMicPrismPairing,
  type MicPrismPairingClientError,
  type MicPrismPairingClientInput,
} from "./micPrismPairing.ts";

type Operation = "start" | "complete" | "select" | "revoke";
export interface MicPrismPairingState {
  readonly busy: boolean;
  readonly operation: Operation | null;
  readonly challenge: MicPrismPairingChallenge | null;
  readonly paired: MicPrismPairedInstance | null;
  readonly confirmation: {
    readonly id: string;
    readonly pairingRevision: number;
    readonly selectionRevision: number;
    readonly label: string;
  } | null;
  readonly error: string | null;
  readonly notice: string | null;
}
const initial: MicPrismPairingState = {
  busy: false,
  operation: null,
  challenge: null,
  paired: null,
  confirmation: null,
  error: null,
  notice: null,
};

/** One account-level pairing ceremony. Refreshes update facts without replaying mutations. */
export function createMicPrismPairingController(options: {
  readonly input: MicPrismPairingClientInput;
  readonly access: MicIdentityAccess;
  readonly run: <A>(
    effect: Effect.Effect<A, never, HttpClient.HttpClient>,
    signal: AbortSignal,
  ) => Promise<A>;
  readonly onChanged: () => void;
  readonly now?: () => number;
}) {
  let access = options.access;
  let state = initial;
  let active = true;
  let pending: AbortController | null = null;
  const listeners = new Set<() => void>();
  const now = options.now ?? Date.now;
  const publish = (patch: Partial<MicPrismPairingState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const current = () => active && options.input.isCurrent();
  const permitted = () =>
    access.session.state === "active" &&
    access.session.permissions.includes("prism:instances:manage");
  const ready = () => {
    if (!current() || pending) return false;
    if (!permitted()) {
      publish({ error: "Host administration permission is required." });
      return false;
    }
    return true;
  };
  const refresh = () => {
    // The committed mutation remains confirmed even if a UI refresh itself fails.
    try {
      options.onChanged();
    } catch {
      /* The consumer owns refresh errors. */
    }
  };
  const cancel = () => {
    pending?.abort();
    pending = null;
    publish(initial);
  };
  const run = async <A>(
    operation: Operation,
    effect: Effect.Effect<A, MicPrismPairingClientError, HttpClient.HttpClient>,
    accept: (result: A) => void,
  ) => {
    if (!ready()) return false;
    const controller = new AbortController();
    pending = controller;
    publish({ busy: true, operation, error: null, notice: null });
    try {
      const result = await options.run(effect.pipe(Effect.result), controller.signal);
      if (!current() || controller.signal.aborted || pending !== controller) return false;
      if (result._tag === "Failure") {
        publish({ error: result.failure.message });
        refresh();
        return false;
      }
      accept(result.success);
      return true;
    } catch {
      if (current() && !controller.signal.aborted)
        publish({
          error: "This change could not be confirmed. Refresh the connection before trying again.",
        });
      return false;
    } finally {
      if (pending === controller) {
        pending = null;
        if (current()) publish({ busy: false, operation: null });
      }
    }
  };
  const input = { ...options.input, isCurrent: current };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activate() {
      active = true;
    },
    dispose() {
      active = false;
      cancel();
    },
    updateAccess(next: MicIdentityAccess) {
      const identityChanged =
        next.session.subject !== access.session.subject ||
        next.session.sessionId !== access.session.sessionId;
      access = next;
      if (identityChanged || !permitted() || !options.input.isCurrent()) cancel();
    },
    setError(error: string) {
      if (current()) publish({ error });
    },
    resetPairing() {
      if (ready()) publish({ challenge: null, paired: null, error: null, notice: null });
    },
    start(payload: MicPrismPairingStart) {
      return run("start", startMicPrismPairing({ ...input, ...payload }), (challenge) => {
        publish({ challenge, paired: null, confirmation: null });
      });
    },
    complete(signature: string) {
      if (!ready()) return Promise.resolve(false);
      const challenge = state.challenge;
      if (!challenge || challenge.expiresAt <= now()) {
        publish({ error: "This pairing challenge has expired. Start again to prepare a new one." });
        return Promise.resolve(false);
      }
      return run(
        "complete",
        completeMicPrismPairing({
          ...input,
          challengeId: challenge.challengeId,
          signature,
        }),
        (paired) => {
          publish({
            challenge: null,
            paired,
            notice:
              "Host paired. Select it below when you are ready to change the shared connection.",
          });
          refresh();
        },
      );
    },
    select(expectedSelectionRevision: number) {
      if (!ready()) return Promise.resolve(false);
      const paired = state.paired;
      if (!paired) return Promise.resolve(false);
      if (expectedSelectionRevision !== access.discovery.selectionRevision) {
        publish({
          error: "The shared host changed. Review its current selection before continuing.",
        });
        refresh();
        return Promise.resolve(false);
      }
      return run(
        "select",
        selectMicPrismInstance({
          ...input,
          serviceInstanceId: paired.serviceInstanceId,
          expectedSelectionRevision,
        }),
        () => {
          publish({ paired: null, confirmation: null, notice: "Shared Prism host updated." });
          refresh();
        },
      );
    },
    prepareRevoke() {
      if (!ready()) return;
      const service = access.discovery.service;
      if (!service) return;
      publish({
        confirmation: {
          id: service.id,
          label: service.label,
          pairingRevision: service.pairingRevision,
          selectionRevision: access.discovery.selectionRevision,
        },
        error: null,
        notice: null,
      });
    },
    cancelRevoke() {
      if (!pending) publish({ confirmation: null });
    },
    revoke() {
      if (!ready()) return Promise.resolve(false);
      const confirmation = state.confirmation;
      const service = access.discovery.service;
      if (!confirmation) return Promise.resolve(false);
      if (
        !service ||
        service.id !== confirmation.id ||
        service.pairingRevision !== confirmation.pairingRevision ||
        access.discovery.selectionRevision !== confirmation.selectionRevision
      ) {
        publish({
          confirmation: null,
          error: "The shared host changed. Review it before revoking access.",
        });
        refresh();
        return Promise.resolve(false);
      }
      return run(
        "revoke",
        revokeMicPrismInstance({
          ...input,
          serviceInstanceId: confirmation.id,
          expectedPairingRevision: confirmation.pairingRevision,
          expectedSelectionRevision: confirmation.selectionRevision,
        }),
        () => {
          publish({ confirmation: null, notice: "Host access revoked." });
          refresh();
        },
      );
    },
  };
}

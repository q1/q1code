import { MicIdentityUnauthorizedError } from "@q1code/core/micIdentity";
import * as Effect from "effect/Effect";

let generation = 0;
let readToken: (() => Promise<string | null>) | undefined;
const listeners = new Set<() => void>();

export interface MicIdentitySessionSnapshot {
  readonly status: "unavailable" | "loading" | "signed-out" | "signed-in" | "signing-out";
  readonly error: string | null;
  readonly signIn?: () => Promise<void>;
  readonly signOut?: () => Promise<void>;
}

const unavailable: MicIdentitySessionSnapshot = { status: "unavailable", error: null };
let snapshot = unavailable;
export const micIdentitySessionSnapshot = () => snapshot;

function publish(next: MicIdentitySessionSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

export const subscribeMicIdentity = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const micIdentityGeneration = () => generation;

/** Retain the SDK getter, never its token. An account switch invalidates in-flight reads. */
export function bindMicIdentitySession(
  getToken?: () => Promise<string | null>,
  controls?: {
    readonly loaded: boolean;
    readonly signIn: () => void | Promise<void>;
    readonly signOut: () => void | Promise<void>;
  },
) {
  readToken = getToken;
  let boundGeneration = ++generation;
  const signIn = controls
    ? async () => {
        if (generation !== boundGeneration || !controls.loaded) return;
        try {
          await controls.signIn();
        } catch {
          if (generation === boundGeneration) {
            publish({ ...snapshot, error: "Sign-in could not open. Please try again." });
          }
        }
      }
    : undefined;
  const signOut = controls
    ? async () => {
        if (generation !== boundGeneration || !controls.loaded || snapshot.status === "signing-out")
          return;
        // Revoke local access before waiting for the SDK/network. Never restore a token on failure.
        readToken = undefined;
        boundGeneration = ++generation;
        publish({ status: "signing-out", error: null });
        try {
          await controls.signOut();
          if (generation === boundGeneration) {
            publish({ status: "signed-out", error: null, ...(signIn ? { signIn } : {}) });
          }
        } catch {
          if (generation === boundGeneration) {
            publish({
              status: "signed-out",
              error: "Prism access is paused. Sign-out could not finish; please try again.",
              ...(signOut ? { signOut } : {}),
            });
          }
        }
      }
    : undefined;
  publish({
    status:
      controls && !controls.loaded
        ? "loading"
        : getToken
          ? "signed-in"
          : controls
            ? "signed-out"
            : "unavailable",
    error: null,
    ...(controls?.loaded && signIn && signOut ? (getToken ? { signOut } : { signIn }) : {}),
  });
  return () => {
    if (generation !== boundGeneration) return;
    readToken = undefined;
    generation++;
    publish(unavailable);
  };
}

export const readMicIdentityToken = () =>
  Effect.tryPromise({
    try: async () => {
      const started = generation;
      const token = await readToken?.();
      return generation === started ? (token ?? null) : null;
    },
    catch: () => new MicIdentityUnauthorizedError({ reason: "sign-in-required" }),
  });

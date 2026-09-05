import { MicIdentityUnauthorizedError } from "@q1code/core/micIdentity";
import * as Effect from "effect/Effect";

let generation = 0;
let readToken: (() => Promise<string | null>) | undefined;
const listeners = new Set<() => void>();

export const subscribeMicIdentity = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const micIdentityGeneration = () => generation;

/** Retain the SDK getter, never its token. An account switch invalidates in-flight reads. */
export function bindMicIdentitySession(getToken?: () => Promise<string | null>) {
  readToken = getToken;
  const boundGeneration = ++generation;
  for (const listener of listeners) listener();
  return () => {
    if (generation !== boundGeneration) return;
    readToken = undefined;
    generation++;
    for (const listener of listeners) listener();
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

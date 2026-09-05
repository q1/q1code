import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { getMicIdentityAccess, setMicPrismRouting } from "@t3tools/client-runtime/fork";
import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";

import {
  bindMicIdentitySession,
  micIdentityGeneration,
  micIdentitySessionSnapshot,
  subscribeMicIdentity,
  readMicIdentityToken,
} from "./micIdentitySession";

afterEach(() => {
  bindMicIdentitySession();
});

const promiseGate = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const identity = {
  contractVersion: 1,
  subject: "user_fixture",
  role: "member",
  permissions: ["prism:inference", "prism:routing:write"],
  authorizationExpiresAt: 4_070_908_800_000,
  authorizationRevision: '1000:["member","active",["prism/routing:write"]]',
};
const discovery = {
  contractVersion: 1,
  selectionRevision: 1,
  service: {
    serviceInstanceId: "prism-pc",
    displayName: "PC Prism",
    apiOrigin: "https://gateway.example.test",
    inferenceOrigin: "https://gateway.example.test",
    pairingRevision: 1,
    protocolVersion: 1,
    publicKey: "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    status: "paired",
  },
};

const currentInput = () => {
  const generation = micIdentityGeneration();
  return {
    baseUrl: "https://identity.example.test",
    getToken: readMicIdentityToken,
    isCurrent: () => micIdentityGeneration() === generation,
  };
};

describe("mic.sc account changes", () => {
  it.effect(
    "clears access immediately while sign-out is pending and never restores it after failure",
    () =>
      Effect.gen(function* () {
        const pending = promiseGate<void>();
        let attempts = 0;
        bindMicIdentitySession(() => Promise.resolve("fixture-admin-token"), {
          loaded: true,
          signIn: () => {},
          signOut: async () => {
            attempts++;
            await pending.promise;
            throw new Error("SDK diagnostic containing a fixture credential");
          },
        });
        const signingOut = micIdentitySessionSnapshot().signOut!();
        expect(micIdentitySessionSnapshot().status).toBe("signing-out");
        expect(yield* readMicIdentityToken()).toBeNull();
        pending.resolve();
        yield* Effect.promise(() => signingOut);
        expect(micIdentitySessionSnapshot()).toMatchObject({
          status: "signed-out",
          error: "Prism access is paused. Sign-out could not finish; please try again.",
        });
        expect(micIdentitySessionSnapshot().signIn).toBeUndefined();
        expect(yield* readMicIdentityToken()).toBeNull();
        yield* Effect.promise(() => micIdentitySessionSnapshot().signOut!());
        expect(attempts).toBe(2);
      }),
  );

  it.effect("a previous account's sign-out completion cannot overwrite the new session", () =>
    Effect.gen(function* () {
      const pending = promiseGate<void>();
      bindMicIdentitySession(() => Promise.resolve("fixture-old-token"), {
        loaded: true,
        signIn: () => {},
        signOut: () => pending.promise,
      });
      const oldSignOut = micIdentitySessionSnapshot().signOut!;
      const signingOut = oldSignOut();
      bindMicIdentitySession(() => Promise.resolve("fixture-current-token"));
      pending.resolve();
      yield* Effect.promise(() => signingOut);
      yield* Effect.promise(oldSignOut);
      expect(micIdentitySessionSnapshot().status).toBe("signed-in");
      expect(yield* readMicIdentityToken()).toBe("fixture-current-token");
    }),
  );

  it("offers sign-in after a successful sign-out and sanitizes SDK errors", async () => {
    let opened = 0;
    bindMicIdentitySession(() => Promise.resolve("fixture-token"), {
      loaded: true,
      signIn: () => {
        opened++;
        throw new Error("private SDK diagnostics");
      },
      signOut: () => {},
    });
    await micIdentitySessionSnapshot().signOut!();
    expect(micIdentitySessionSnapshot().status).toBe("signed-out");
    await micIdentitySessionSnapshot().signIn!();
    expect(opened).toBe(1);
    expect(micIdentitySessionSnapshot().error).toBe("Sign-in could not open. Please try again.");
    expect(micIdentitySessionSnapshot().signOut).toBeUndefined();
  });

  it("publishes loading and cleanup without enabling actions or leaving listeners behind", () => {
    let notifications = 0;
    const unsubscribe = subscribeMicIdentity(() => {
      notifications++;
    });
    const cleanup = bindMicIdentitySession(undefined, {
      loaded: false,
      signIn: () => {},
      signOut: () => {},
    });
    expect(micIdentitySessionSnapshot()).toEqual({ status: "loading", error: null });
    cleanup();
    expect(micIdentitySessionSnapshot()).toEqual({ status: "unavailable", error: null });
    expect(notifications).toBe(2);
    unsubscribe();
    bindMicIdentitySession();
    expect(notifications).toBe(2);
  });

  it.effect("discards a token whose account signs out while the SDK is resolving it", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const pending = promiseGate<string | null>();
      bindMicIdentitySession(() => {
        Deferred.doneUnsafe(started, Effect.void);
        return pending.promise;
      });
      const token = yield* readMicIdentityToken().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      bindMicIdentitySession();
      pending.resolve("fixture-old-account-token");
      expect(yield* Fiber.join(token)).toBeNull();
    }),
  );

  it.effect("old component cleanup cannot sign out a newly bound account", () =>
    Effect.gen(function* () {
      const oldCleanup = bindMicIdentitySession(() => Promise.resolve("fixture-old-account-token"));
      bindMicIdentitySession(() => Promise.resolve("fixture-current-account-token"));
      oldCleanup();
      expect(yield* readMicIdentityToken()).toBe("fixture-current-account-token");
    }),
  );

  it.effect("resolves the current SDK token for every call without retaining credentials", () =>
    Effect.gen(function* () {
      let reads = 0;
      bindMicIdentitySession(() => Promise.resolve(`fixture-token-${++reads}`));
      expect(yield* readMicIdentityToken()).toBe("fixture-token-1");
      expect(yield* readMicIdentityToken()).toBe("fixture-token-2");
      expect(reads).toBe(2);
    }),
  );

  it.effect("discards in-flight admin access when another account signs in", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const pending = promiseGate<Response>();
      const calls: string[] = [];
      const fetchFn = ((request) => {
        calls.push(String(request));
        Deferred.doneUnsafe(started, Effect.void);
        return pending.promise;
      }) satisfies typeof fetch;
      bindMicIdentitySession(() => Promise.resolve("fixture-admin-token"));
      const result = yield* getMicIdentityAccess(currentInput()).pipe(
        Effect.provide(remoteHttpClientLayer(fetchFn)),
        Effect.flip,
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      bindMicIdentitySession(() => Promise.resolve("fixture-member-token"));
      pending.resolve(Response.json(identity));
      expect(yield* Fiber.join(result)).toMatchObject({
        _tag: "MicIdentityUnauthorizedError",
        reason: "revoked-session",
      });
      expect(calls).toEqual(["https://identity.example.test/v1/identity"]);
    }),
  );

  it.effect("does not send an admin mutation after an account switch during discovery", () =>
    Effect.gen(function* () {
      const discovering = yield* Deferred.make<void>();
      const pending = promiseGate<Response>();
      const methods: Array<string | undefined> = [];
      const fetchFn = ((request, init) => {
        methods.push(init?.method);
        if (String(request).endsWith("/identity")) return Promise.resolve(Response.json(identity));
        Deferred.doneUnsafe(discovering, Effect.void);
        return pending.promise;
      }) satisfies typeof fetch;
      bindMicIdentitySession(() => Promise.resolve("fixture-admin-token"));
      const result = yield* setMicPrismRouting({ ...currentInput(), strategy: "fill-first" }).pipe(
        Effect.provide(remoteHttpClientLayer(fetchFn)),
        Effect.flip,
        Effect.forkChild,
      );
      yield* Deferred.await(discovering);
      bindMicIdentitySession(() => Promise.resolve("fixture-other-admin-token"));
      pending.resolve(Response.json(discovery));
      expect(yield* Fiber.join(result)).toMatchObject({
        _tag: "MicIdentityUnauthorizedError",
        reason: "revoked-session",
      });
      expect(methods).toEqual(["GET", "GET"]);
    }),
  );

  it.effect("discards a mutation result after sign-out without replaying the write", () =>
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const pending = promiseGate<Response>();
      let writes = 0;
      const fetchFn = ((request, init) => {
        const url = String(request);
        if (url.endsWith("/identity")) return Promise.resolve(Response.json(identity));
        if (url.endsWith("/discovery")) return Promise.resolve(Response.json(discovery));
        if (init?.method === "PUT") writes++;
        Deferred.doneUnsafe(writing, Effect.void);
        return pending.promise;
      }) satisfies typeof fetch;
      bindMicIdentitySession(() => Promise.resolve("fixture-admin-token"));
      const result = yield* setMicPrismRouting({ ...currentInput(), strategy: "fill-first" }).pipe(
        Effect.provide(remoteHttpClientLayer(fetchFn)),
        Effect.flip,
        Effect.forkChild,
      );
      yield* Deferred.await(writing);
      bindMicIdentitySession();
      pending.resolve(Response.json({ strategy: "fill-first" }));
      expect(yield* Fiber.join(result)).toMatchObject({
        _tag: "MicIdentityUnauthorizedError",
        reason: "revoked-session",
      });
      expect(writes).toBe(1);
    }),
  );
});

import { afterEach, describe, expect, it } from "@effect/vitest";
import { OrchestrationCommand, ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { guardMicPrismDispatch, makeMicPrismThreadRegistry } from "./MicPrismThreads.ts";
import type { PrismInferenceBinding, PrismInferenceBrokerOptions } from "./PrismInferenceBroker.ts";

const binding: PrismInferenceBinding = {
  environmentSessionId: "env-a",
  subject: "member-a",
  sessionId: "clerk-a",
  threadId: "thread-a",
  serviceInstanceId: "host-a",
  pairingRevision: 1,
  inferenceOrigin: "https://prism.example.test",
};
const credential = { binding, token: "msp1.fixture.signature", expiresAt: 50_000 };
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const registries: ReturnType<typeof makeMicPrismThreadRegistry>[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.closeAll()));
});
function harness(changes?: Stream.Stream<void>, emitChange = () => {}, createGate?: Promise<void>) {
  let enabled = true;
  let now = 1_000;
  let closed = 0;
  const closing = gate<void>();
  const creating = gate<void>();
  const calls: PrismInferenceBrokerOptions[] = [];
  const registry = makeMicPrismThreadRegistry({
    enabled: () => enabled,
    now: () => now,
    ...(changes ? { changes } : {}),
    createBroker: async (options) => {
      calls.push(options);
      creating.resolve();
      if (createGate) await createGate;
      return {
        binding: options.binding,
        endpoint: { baseUrl: "http://127.0.0.1:1234", apiKey: "local-fixture" },
        revoke: () => {},
        close: async () => {
          closed++;
          closing.resolve();
        },
      };
    },
  });
  registries.push(registry);
  return {
    registry,
    calls,
    closing,
    creating,
    closed: () => closed,
    setNow: (value: number) => {
      now = value;
    },
    disable: () => {
      enabled = false;
      emitChange();
    },
  };
}
const registerInput = { binding, credential, verifyEnvironment: async () => true };
const decodeCommand = Schema.decodeUnknownSync(OrchestrationCommand);
const encodeCommandJson = Schema.encodeEffect(Schema.fromJsonString(OrchestrationCommand));
const turn = decodeCommand({
  type: "thread.turn.start",
  commandId: "command-a",
  threadId: binding.threadId,
  message: { messageId: "message-a", role: "user", text: "hello", attachments: [] },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-09-05T00:00:00.000Z",
});
function engine() {
  const dispatched: OrchestrationCommand[] = [];
  const value: OrchestrationEngineShape = {
    readEvents: () => Stream.empty,
    readThreadEvents: () => Stream.empty,
    getThreadReplayStats: () => Effect.die("not used"),
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
    streamDomainEvents: Stream.empty,
    subscribeDomainEvents: Effect.succeed(Stream.empty),
    latestSequence: Effect.succeed(0),
  };
  return { value, dispatched };
}

describe("mic.sc thread credential ownership", () => {
  it("renews only the same complete binding and never rolls a newer credential back", async () => {
    const h = harness();
    await h.registry.register(registerInput);
    const next = { ...credential, token: "msp1.renewed.signature", expiresAt: 80_000 };
    await h.registry.register({ ...registerInput, credential: next });
    expect(await h.registry.register(registerInput)).toEqual({
      threadId: binding.threadId,
      expiresAt: next.expiresAt,
    });
    expect(await h.calls[0]!.getCredential(binding, new AbortController().signal)).toEqual(next);
    expect(h.calls).toHaveLength(1);
  });
  for (const patch of [
    { subject: "member-b" },
    { sessionId: "clerk-b" },
    { serviceInstanceId: "host-b" },
    { pairingRevision: 2 },
    { inferenceOrigin: "https://other.example.test" },
  ]) {
    it(`rejects binding replacement ${JSON.stringify(patch)}`, async () => {
      const h = harness();
      await h.registry.register(registerInput);
      const changed = { ...binding, ...patch };
      await expect(
        h.registry.register({
          ...registerInput,
          binding: changed,
          credential: { ...credential, binding: changed },
        }),
      ).rejects.toThrow("Prism thread authorization");
      expect(h.calls).toHaveLength(1);
    });
  }
  it("reserves ownership before concurrent verification and cannot resurrect a revoked registration", async () => {
    const h = harness();
    const pending = gate<boolean>();
    const registering = h.registry.register({
      ...registerInput,
      verifyEnvironment: () => pending.promise,
    });
    const changed = { ...binding, subject: "other" };
    await expect(
      h.registry.register({
        ...registerInput,
        binding: changed,
        credential: { ...credential, binding: changed },
      }),
    ).rejects.toThrow();
    const rejected = expect(registering).rejects.toThrow();
    const revoke = h.registry.revoke(binding.threadId, binding.environmentSessionId);
    pending.resolve(true);
    await Promise.all([revoke, rejected]);
    expect(
      h.registry.endpoint(
        binding.threadId,
        (await h.registry.authorize(binding.threadId, binding.environmentSessionId)) ?? "",
      ),
    ).toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });
  it("denies unauthorized deletion and expired credentials without releasing ownership", async () => {
    const h = harness();
    await h.registry.register(registerInput);
    await h.registry.revoke(binding.threadId, "env-b");
    expect(await h.registry.owns(binding.threadId, binding.environmentSessionId)).toBe(true);
    h.setNow(credential.expiresAt);
    expect(
      h.registry.endpoint(
        binding.threadId,
        (await h.registry.authorize(binding.threadId, binding.environmentSessionId)) ?? "",
      ),
    ).toBeUndefined();
    expect(h.registry.has(binding.threadId)).toBe(true);
    await expect(h.registry.register(registerInput)).rejects.toThrow();
    await expect(
      h.calls[0]!.getCredential(binding, new AbortController().signal),
    ).rejects.toThrow();
  });
  it.effect("closes brokers when flags turn off without another inference request", () =>
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<void>();
      const h = harness(Stream.fromPubSub(changes), () => {
        PubSub.publishUnsafe(changes, undefined);
      });
      yield* Effect.promise(() => h.registry.register(registerInput));
      h.disable();
      yield* Effect.promise(() => h.closing.promise);
      expect(h.registry.has(binding.threadId)).toBe(true);
      expect(h.closed()).toBeGreaterThan(0);
      yield* Effect.promise(() => expect(h.registry.register(registerInput)).rejects.toThrow());
    }),
  );
  it("keeps an immutable owner after manual revoke while allowing the same actor to reconnect", async () => {
    const h = harness();
    await h.registry.register(registerInput);
    await h.registry.revoke(binding.threadId, binding.environmentSessionId);
    expect(
      h.registry.endpoint(
        binding.threadId,
        (await h.registry.authorize(binding.threadId, binding.environmentSessionId)) ?? "",
      ),
    ).toBeUndefined();
    expect(await h.registry.owns(binding.threadId, binding.environmentSessionId)).toBe(false);
    const other = { ...binding, subject: "other" };
    await expect(
      h.registry.register({
        ...registerInput,
        binding: other,
        credential: { ...credential, binding: other },
      }),
    ).rejects.toThrow();
    await h.registry.register(registerInput);
    expect(
      h.registry.endpoint(
        binding.threadId,
        (await h.registry.authorize(binding.threadId, binding.environmentSessionId)) ?? "",
      ),
    ).toBeDefined();
    expect(h.calls).toHaveLength(2);
  });
  for (const patch of [
    { sessionId: "clerk-renewed" },
    {
      serviceInstanceId: "host-b",
      pairingRevision: 2,
      inferenceOrigin: "https://replacement.example.test",
    },
  ]) {
    it(`reconnects the same stable actor after explicit revoke ${JSON.stringify(patch)}`, async () => {
      const h = harness();
      await h.registry.register(registerInput);
      const changed = { ...binding, ...patch };
      const reconnect = {
        ...registerInput,
        binding: changed,
        credential: { ...credential, binding: changed },
      };
      await expect(h.registry.register(reconnect)).rejects.toThrow();
      await h.registry.revoke(binding.threadId, binding.environmentSessionId);
      await expect(h.registry.register(reconnect)).resolves.toEqual({
        threadId: binding.threadId,
        expiresAt: credential.expiresAt,
      });
      expect(h.calls.at(-1)!.binding).toEqual(changed);
    });
  }
  it("permits the same mic.sc user to connect from another independently authorized environment session", async () => {
    const h = harness();
    await h.registry.register(registerInput);
    const firstId = await h.registry.authorize(binding.threadId, binding.environmentSessionId);
    const second = {
      ...binding,
      environmentSessionId: "env-device-b",
      sessionId: "clerk-device-b",
    };
    await h.registry.register({
      ...registerInput,
      binding: second,
      credential: { ...credential, binding: second },
    });
    const secondId = await h.registry.authorize(second.threadId, second.environmentSessionId);
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);
    await h.registry.revoke(binding.threadId, binding.environmentSessionId);
    expect(h.registry.endpoint(binding.threadId, firstId)).toBeUndefined();
    expect(h.registry.endpoint(second.threadId, secondId)).toBeDefined();
  });
  it("rolls back a cancelled registration and closes its late broker without revoking a subsequent connection", async () => {
    const opening = gate<void>();
    const h = harness(undefined, undefined, opening.promise);
    const controller = new AbortController();
    const registering = h.registry.register({ ...registerInput, signal: controller.signal });
    await h.creating.promise;
    const failed = expect(registering).rejects.toThrow();
    controller.abort();
    await failed;
    expect(
      h.registry.endpoint(
        binding.threadId,
        (await h.registry.authorize(binding.threadId, binding.environmentSessionId)) ?? "",
      ),
    ).toBeUndefined();
    const reconnecting = h.registry.register(registerInput);
    opening.resolve();
    await reconnecting;
    await h.closing.promise;
    expect(
      h.registry.endpoint(
        binding.threadId,
        (await h.registry.authorize(binding.threadId, binding.environmentSessionId)) ?? "",
      ),
    ).toBeDefined();
    expect(h.closed()).toBe(1);
  });
  it("cancels pending environment verification without allocating a broker", async () => {
    const h = harness();
    const verifying = gate<void>();
    const permission = gate<boolean>();
    const controller = new AbortController();
    const registering = h.registry.register({
      ...registerInput,
      signal: controller.signal,
      verifyEnvironment: () => {
        verifying.resolve();
        return permission.promise;
      },
    });
    await verifying.promise;
    const failed = expect(registering).rejects.toThrow();
    controller.abort();
    await failed;
    permission.resolve(true);
    expect(
      h.registry.endpoint(
        binding.threadId,
        (await h.registry.authorize(binding.threadId, binding.environmentSessionId)) ?? "",
      ),
    ).toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });
  it("does not roll back a successful concurrent renewal when an older renewal is cancelled", async () => {
    const h = harness();
    await h.registry.register(registerInput);
    const permission = gate<boolean>();
    const verifying = gate<void>();
    const controller = new AbortController();
    const cancelled = h.registry.register({
      ...registerInput,
      credential: { ...credential, expiresAt: 90_000 },
      signal: controller.signal,
      verifyEnvironment: () => {
        verifying.resolve();
        return permission.promise;
      },
    });
    await verifying.promise;
    await h.registry.register({
      ...registerInput,
      credential: { ...credential, expiresAt: 80_000 },
    });
    const failed = expect(cancelled).rejects.toThrow();
    controller.abort();
    await failed;
    permission.resolve(true);
    expect((await h.calls[0]!.getCredential(binding, new AbortController().signal)).expiresAt).toBe(
      80_000,
    );
  });
  it("environment removal closes every owned broker and preserves unrelated sessions", async () => {
    const h = harness();
    await h.registry.register(registerInput);
    const second = { ...binding, threadId: "thread-b" };
    await h.registry.register({
      ...registerInput,
      binding: second,
      credential: { ...credential, binding: second },
    });
    const unrelated = { ...binding, threadId: "thread-c", environmentSessionId: "env-other" };
    await h.registry.register({
      ...registerInput,
      binding: unrelated,
      credential: { ...credential, binding: unrelated },
    });
    await h.registry.revokeEnvironment(binding.environmentSessionId);
    expect(
      h.registry.endpoint(
        binding.threadId,
        (await h.registry.authorize(binding.threadId, binding.environmentSessionId)) ?? "",
      ),
    ).toBeUndefined();
    expect(
      h.registry.endpoint(
        second.threadId,
        (await h.registry.authorize(second.threadId, second.environmentSessionId)) ?? "",
      ),
    ).toBeUndefined();
    expect(
      h.registry.endpoint(
        unrelated.threadId,
        (await h.registry.authorize(unrelated.threadId, unrelated.environmentSessionId)) ?? "",
      ),
    ).toBeDefined();
    expect(h.closed()).toBe(2);
  });
  it("does not return successful registration when authorization verification outlives the credential", async () => {
    const h = harness();
    await expect(
      h.registry.register({
        ...registerInput,
        verifyEnvironment: async () => {
          h.setNow(credential.expiresAt);
          return true;
        },
      }),
    ).rejects.toThrow();
    expect(
      h.registry.endpoint(
        binding.threadId,
        (await h.registry.authorize(binding.threadId, binding.environmentSessionId)) ?? "",
      ),
    ).toBeUndefined();
  });
  it("does not retain provider activation state with identity integration disabled", () => {
    const h = harness();
    h.disable();
    h.registry.publishActive(binding.threadId, "direct", selection);
    expect(h.registry.activeBinding(binding.threadId)).toBeUndefined();
    expect(h.registry.activeSelection(binding.threadId)).toBeUndefined();
  });
  it("rechecks environment revocation before admitting execution", async () => {
    const h = harness();
    let allowed = true;
    await h.registry.register({ ...registerInput, verifyEnvironment: async () => allowed });
    expect(await h.registry.owns(binding.threadId, "env-a")).toBe(true);
    allowed = false;
    expect(await h.registry.owns(binding.threadId, "env-a")).toBe(false);
  });
});

const selection = Schema.decodeUnknownSync(ModelSelection)({
  instanceId: "custom-codex",
  model: "example",
});
const selectedTurn = (value: ModelSelection) => decodeCommand({ ...turn, modelSelection: value });
const withHandle = (id: string, route = "prism") => ({
  ...selection,
  options: [
    { id: "prism-route", value: route },
    { id: "q1.mic-binding", value: id },
  ],
});
const approval = decodeCommand({
  ...turn,
  type: "thread.approval.respond",
  requestId: "request-a",
  decision: "accept",
});
function guarded(
  h: ReturnType<typeof harness>,
  e: ReturnType<typeof engine>,
  env = "env-a",
  persisted = selection,
  enabled = true,
) {
  return guardMicPrismDispatch(e.value, env, {
    enabled: () => enabled,
    registry: h.registry,
    resolveSelection: (command) =>
      Effect.succeed({
        selection:
          ("modelSelection" in command ? command.modelSelection : undefined) ??
          h.registry.activeSelection(binding.threadId) ??
          persisted,
        routed: true,
      }),
  });
}

describe("authenticated Prism dispatch handles", () => {
  it.effect(
    "stays inert with flags off without reading ownership or changing command metadata",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const e = engine();
        const wrapped = guardMicPrismDispatch(e.value, "env-b", {
          enabled: () => false,
          registry: h.registry,
          resolveSelection: () => Effect.die("must stay inert"),
        });
        const forged = selectedTurn(withHandle("client-value"));
        yield* wrapped.dispatch(forged);
        expect(e.dispatched).toEqual([forged]);
      }),
  );
  it.effect(
    "rejects unregistered actors even with omitted model selection or a forged handle",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const e = engine();
        yield* Effect.promise(() => h.registry.register(registerInput));
        const ownerId = yield* Effect.promise(() =>
          h.registry.authorize(binding.threadId, "env-a"),
        );
        for (const command of [turn, selectedTurn(withHandle(ownerId!))]) {
          const error = yield* guarded(h, e, "env-b").dispatch(command).pipe(Effect.flip);
          expect(error._tag).toBe("OrchestrationCommandInvariantError");
          expect(error.message).not.toContain(binding.subject);
        }
        expect(e.dispatched).toEqual([]);
      }),
  );
  it.effect(
    "stamps a noncredential handle onto resolved omitted selections and replaces client values",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const e = engine();
        yield* Effect.promise(() => h.registry.register(registerInput));
        const handle = yield* Effect.promise(() => h.registry.authorize(binding.threadId, "env-a"));
        for (const command of [turn, selectedTurn(withHandle("client-forged"))])
          yield* guarded(h, e).dispatch(command);
        for (const command of e.dispatched) {
          expect(
            "modelSelection" in command &&
              command.modelSelection?.options?.find((option) => option.id === "q1.mic-binding")
                ?.value,
          ).toBe(handle);
          const persisted = yield* encodeCommandJson(command);
          expect(persisted).not.toContain(credential.token);
          expect(persisted).not.toContain(binding.subject);
          expect(persisted).not.toContain(binding.environmentSessionId);
        }
      }),
  );
  it.effect(
    "old queued commands cannot use a new broker after same-user session or device replacement",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const e = engine();
        yield* Effect.promise(() => h.registry.register(registerInput));
        yield* guarded(h, e).dispatch(turn);
        const oldHandle = yield* Effect.promise(() =>
          h.registry.authorize(binding.threadId, "env-a"),
        );
        yield* Effect.promise(() => h.registry.revoke(binding.threadId, "env-a"));
        const replacement = { ...binding, sessionId: "new-clerk-session" };
        yield* Effect.promise(() =>
          h.registry.register({
            ...registerInput,
            binding: replacement,
            credential: { ...credential, binding: replacement },
          }),
        );
        const newHandle = yield* Effect.promise(() =>
          h.registry.authorize(binding.threadId, "env-a"),
        );
        expect(newHandle).not.toBe(oldHandle);
        expect(h.registry.endpoint(binding.threadId, oldHandle)).toBeUndefined();
        expect(h.registry.endpoint(binding.threadId, newHandle)).toBeDefined();
      }),
  );
  it.effect(
    "supports independently authorized turns from two devices of the same mic.sc user",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const e = engine();
        yield* Effect.promise(() => h.registry.register(registerInput));
        const otherDevice = { ...binding, environmentSessionId: "env-b", sessionId: "clerk-b" };
        yield* Effect.promise(() =>
          h.registry.register({
            ...registerInput,
            binding: otherDevice,
            credential: { ...credential, binding: otherDevice },
          }),
        );
        yield* guarded(h, e, "env-a").dispatch(turn);
        yield* guarded(h, e, "env-b").dispatch(turn);
        const first = e.dispatched[0]!;
        const second = e.dispatched[1]!;
        expect("modelSelection" in first && first.modelSelection).not.toEqual(
          "modelSelection" in second && second.modelSelection,
        );
      }),
  );
  it.effect(
    "keeps approvals on their initiating device until a new turn establishes another binding",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const e = engine();
        yield* Effect.promise(() => h.registry.register(registerInput));
        const firstId = yield* Effect.promise(() =>
          h.registry.authorize(binding.threadId, "env-a"),
        );
        const otherDevice = { ...binding, environmentSessionId: "env-b", sessionId: "clerk-b" };
        yield* Effect.promise(() =>
          h.registry.register({
            ...registerInput,
            binding: otherDevice,
            credential: { ...credential, binding: otherDevice },
          }),
        );
        h.registry.publishActive(binding.threadId, firstId, withHandle(firstId!));
        yield* guarded(h, e, "env-a", selection).dispatch(approval);
        const error = yield* guarded(h, e, "env-b", withHandle(firstId!))
          .dispatch(approval)
          .pipe(Effect.flip);
        expect(error.message).toContain("initiating device");
        expect(e.dispatched).toEqual([approval]);
      }),
  );
  it.effect("stamps explicit direct recovery and permits its subsequent native approvals", () =>
    Effect.gen(function* () {
      const h = harness();
      const e = engine();
      yield* Effect.promise(() => h.registry.register(registerInput));
      yield* Effect.promise(() => h.registry.revoke(binding.threadId, "env-a"));
      const direct = selectedTurn(withHandle("forged", "direct"));
      yield* guarded(h, e, "env-b").dispatch(direct);
      expect("modelSelection" in e.dispatched[0]! && e.dispatched[0].modelSelection).toEqual(
        withHandle("direct", "direct"),
      );
      expect((yield* guarded(h, e, "env-b").dispatch(approval).pipe(Effect.flip))._tag).toBe(
        "OrchestrationCommandInvariantError",
      );
      h.registry.publishActive(binding.threadId, "direct", withHandle("direct", "direct"));
      yield* guarded(h, e, "env-b", selection).dispatch(approval);
      expect(e.dispatched).toHaveLength(2);
    }),
  );
  it.effect(
    "strips fake direct proof from metadata updates and refuses a continuation without server proof",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const e = engine();
        yield* Effect.promise(() => h.registry.register(registerInput));
        const metadata = decodeCommand({
          ...turn,
          type: "thread.meta.update",
          modelSelection: withHandle("direct", "direct"),
        });
        yield* guarded(h, e, "env-b").dispatch(metadata);
        const clean = e.dispatched[0]!;
        const persisted = "modelSelection" in clean ? clean.modelSelection! : selection;
        expect(persisted.options?.some((option) => option.id === "q1.mic-binding")).toBe(false);
        expect(
          (yield* guarded(h, e, "env-b", persisted).dispatch(approval).pipe(Effect.flip))._tag,
        ).toBe("OrchestrationCommandInvariantError");
      }),
  );
  it.effect(
    "an accepted queued turn does not transfer active approvals until provider activation",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const e = engine();
        yield* Effect.promise(() => h.registry.register(registerInput));
        const a = yield* Effect.promise(() => h.registry.authorize(binding.threadId, "env-a"));
        h.registry.publishActive(binding.threadId, a, withHandle(a!));
        const device = { ...binding, environmentSessionId: "env-b", sessionId: "clerk-b" };
        yield* Effect.promise(() =>
          h.registry.register({
            ...registerInput,
            binding: device,
            credential: { ...credential, binding: device },
          }),
        );
        const b = yield* Effect.promise(() => h.registry.authorize(binding.threadId, "env-b"));
        yield* guarded(h, e, "env-b").dispatch(turn);
        expect(h.registry.activeBinding(binding.threadId)).toBe(a);
        expect((yield* guarded(h, e, "env-b").dispatch(approval).pipe(Effect.flip))._tag).toBe(
          "OrchestrationCommandInvariantError",
        );
        h.registry.publishActive(binding.threadId, b, withHandle(b!));
        yield* guarded(h, e, "env-b").dispatch(approval);
        expect((yield* guarded(h, e, "env-a").dispatch(approval).pipe(Effect.flip))._tag).toBe(
          "OrchestrationCommandInvariantError",
        );
      }),
  );
  it.effect(
    "omitted turn selections preserve the active direct route despite a stale Prism shell",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const e = engine();
        yield* Effect.promise(() => h.registry.register(registerInput));
        yield* Effect.promise(() => h.registry.revoke(binding.threadId, "env-a"));
        h.registry.publishActive(binding.threadId, "direct", withHandle("direct", "direct"));
        yield* guarded(h, e, "env-a", selection).dispatch(turn);
        expect("modelSelection" in e.dispatched[0]! && e.dispatched[0].modelSelection).toEqual(
          withHandle("direct", "direct"),
        );
        h.registry.publishActive(binding.threadId, undefined);
        expect((yield* guarded(h, e, "env-a").dispatch(approval).pipe(Effect.flip))._tag).toBe(
          "OrchestrationCommandInvariantError",
        );
      }),
  );
  it.effect("denies default Prism turns with an expired credential", () =>
    Effect.gen(function* () {
      const h = harness();
      const e = engine();
      yield* Effect.promise(() => h.registry.register(registerInput));
      h.setNow(credential.expiresAt);
      expect((yield* guarded(h, e).dispatch(turn).pipe(Effect.flip))._tag).toBe(
        "OrchestrationCommandInvariantError",
      );
      expect(e.dispatched).toEqual([]);
    }),
  );
});

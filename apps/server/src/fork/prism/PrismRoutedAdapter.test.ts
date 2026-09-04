import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderAdapterShape } from "../../provider/Services/ProviderAdapter.ts";
import { makePrismRoutedAdapter } from "./PrismRoutedAdapter.ts";
import { PRISM_ROUTE_OPTION } from "./PrismRouting.ts";

const threadId = ThreadId.make("thread-1");
const provider = ProviderDriverKind.make("codex");
const at = "2026-09-04T00:00:00.000Z";
const start: ProviderSessionStartInput = {
  threadId,
  provider,
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access",
};
const failure = new ProviderAdapterRequestError({
  provider,
  method: "turn",
  detail: "test failure",
});
const fake = Effect.fn("test.fakeAdapter")(function* (name: string, reject = false) {
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sent = yield* Queue.unbounded<ProviderSendTurnInput>();
  const starts: ProviderSessionStartInput[] = [];
  const turns: ProviderSendTurnInput[] = [];
  const active = new Map<ThreadId, ProviderSession>();
  let stops = 0;
  const adapter: ProviderAdapterShape<ProviderAdapterRequestError> = {
    provider,
    capabilities: { sessionModelSwitch: "in-session" },
    streamEvents: Stream.fromPubSub(events),
    startSession: (input) =>
      Effect.sync(() => {
        starts.push(input);
        const session: ProviderSession = {
          ...start,
          threadId: input.threadId,
          provider,
          status: "ready",
          createdAt: at,
          updatedAt: at,
          resumeCursor: input.resumeCursor ?? { sessionId: "native-history" },
        };
        active.set(input.threadId, session);
        return session;
      }),
    sendTurn: (input) =>
      Effect.gen(function* () {
        turns.push(input);
        yield* Queue.offer(sent, input);
        if (reject) return yield* failure;
        return { threadId: input.threadId, turnId: TurnId.make(name) };
      }),
    stopSession: (id) =>
      Effect.sync(() => {
        stops++;
        active.delete(id);
      }),
    stopAll: () => Effect.sync(() => active.clear()),
    listSessions: () => Effect.sync(() => [...active.values()]),
    hasSession: (id) => Effect.sync(() => active.has(id)),
    interruptTurn: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    readThread: (id) => Effect.succeed({ threadId: id, turns: [] }),
    rollbackThread: (id) => Effect.succeed({ threadId: id, turns: [] }),
  };
  const complete = (state: "completed" | "failed" | "cancelled" = "completed") =>
    PubSub.publish(events, {
      eventId: EventId.make(`${name}-${state}`),
      provider,
      threadId,
      createdAt: at,
      turnId: TurnId.make(name),
      type: "turn.completed",
      payload: { state },
    });
  return { adapter, starts, turns, sent, complete, stops: () => stops };
});

const observe = Effect.fn("test.observe")(function* (
  adapter: Pick<ProviderAdapterShape<ProviderAdapterRequestError>, "streamEvents">,
) {
  const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(queue, event)).pipe(
    Effect.forkScoped({ startImmediately: true }),
  );
  return queue;
});

it.layer(NodeServices.layer)("Prism routed adapter", (it) => {
  it.effect(
    "flags off and explicit direct both avoid creating a proxy and strip the routing option",
    () =>
      Effect.gen(function* () {
        for (const enabled of [false, true]) {
          const direct = yield* fake("direct");
          const adapter = yield* makePrismRoutedAdapter({
            direct: direct.adapter,
            enabled: () => enabled,
            proxy: () => Effect.die("proxy must not be created"),
          });
          const modelSelection = {
            instanceId: ProviderInstanceId.make("codex"),
            model: "test-model",
            options: [{ id: PRISM_ROUTE_OPTION, value: "direct" }],
          };
          yield* adapter.startSession({ ...start, ...(enabled ? { modelSelection } : {}) });
          yield* adapter.sendTurn({ threadId, input: "hello", modelSelection });
          assert.equal(direct.turns.length, 1);
          assert.deepEqual(direct.turns[0]?.modelSelection?.options, []);
          yield* adapter.stopAll();
          assert.deepEqual(yield* adapter.listSessions(), []);
        }
      }),
  );

  it.effect("an unavailable gateway starts directly with local credentials", () =>
    Effect.gen(function* () {
      const direct = yield* fake("direct");
      const adapter = yield* makePrismRoutedAdapter({
        direct: direct.adapter,
        enabled: () => true,
        proxy: () => Effect.succeed(undefined),
      });
      yield* adapter.startSession(start);
      const result = yield* adapter.sendTurn({ threadId, input: "hello" });
      assert.equal(result.turnId, "direct");
    }),
  );

  it.effect(
    "a failed Prism turn resumes native history and emits one logical completion after a direct retry",
    () =>
      Effect.gen(function* () {
        const direct = yield* fake("direct");
        const proxy = yield* fake("proxy");
        const adapter = yield* makePrismRoutedAdapter({
          direct: direct.adapter,
          enabled: () => true,
          proxy: () => Effect.succeed(proxy.adapter),
        });
        const events = yield* observe(adapter);
        yield* adapter.startSession(start);
        const result = yield* adapter.sendTurn({ threadId, input: "hello" });
        yield* proxy.complete("failed");
        yield* Queue.take(direct.sent);
        yield* direct.complete();
        const warning = yield* Queue.take(events);
        assert.equal(warning.type, "runtime.warning");
        const completion = yield* Queue.take(events);
        assert.equal(completion.type, "turn.completed");
        assert.equal(completion.turnId, result.turnId);
        assert.equal(proxy.stops(), 1);
        assert.deepEqual(direct.starts[0]?.resumeCursor, { sessionId: "native-history" });
        assert.equal(direct.turns.length, 1);
      }),
  );

  it.effect("direct failure terminates the turn without looping back to Prism", () =>
    Effect.gen(function* () {
      const direct = yield* fake("direct", true);
      const proxy = yield* fake("proxy");
      const adapter = yield* makePrismRoutedAdapter({
        direct: direct.adapter,
        enabled: () => true,
        proxy: () => Effect.succeed(proxy.adapter),
      });
      const events = yield* observe(adapter);
      yield* adapter.startSession(start);
      yield* adapter.sendTurn({ threadId, input: "hello" });
      yield* proxy.complete("failed");
      yield* Queue.take(events);
      const completion = yield* Queue.take(events);
      assert.equal(completion.type, "turn.completed");
      if (completion.type === "turn.completed") assert.equal(completion.payload.state, "failed");
      assert.equal(direct.turns.length, 1);
      assert.equal(proxy.turns.length, 1);
    }),
  );

  it.effect("cancellation never retries and a later turn may choose direct", () =>
    Effect.gen(function* () {
      const direct = yield* fake("direct");
      const proxy = yield* fake("proxy");
      const adapter = yield* makePrismRoutedAdapter({
        direct: direct.adapter,
        enabled: () => true,
        proxy: () => Effect.succeed(proxy.adapter),
      });
      const events = yield* observe(adapter);
      yield* adapter.startSession(start);
      yield* adapter.sendTurn({ threadId, input: "hello" });
      yield* adapter.interruptTurn(threadId);
      yield* proxy.complete("failed");
      yield* Queue.take(events);
      assert.equal(direct.turns.length, 0);
      yield* adapter.sendTurn({
        threadId,
        input: "next",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "test-model",
          options: [{ id: PRISM_ROUTE_OPTION, value: "direct" }],
        },
      });
      assert.equal(direct.turns.length, 1);
      assert.equal(proxy.stops(), 1);
    }),
  );

  it.effect("a synchronous Prism failure retries directly once", () =>
    Effect.gen(function* () {
      const direct = yield* fake("direct");
      const proxy = yield* fake("proxy", true);
      const adapter = yield* makePrismRoutedAdapter({
        direct: direct.adapter,
        enabled: () => true,
        proxy: () => Effect.succeed(proxy.adapter),
      });
      yield* adapter.startSession(start);
      const result = yield* adapter.sendTurn({ threadId, input: "hello" });
      assert.equal(result.turnId, "direct");
      assert.equal(direct.turns.length, 1);
      assert.equal(proxy.turns.length, 1);
    }),
  );
  it.effect("an early failed event and send rejection share one direct retry", () =>
    Effect.gen(function* () {
      const direct = yield* fake("direct");
      const proxy = yield* fake("proxy");
      const release = yield* Deferred.make<void>();
      const originalSend = proxy.adapter.sendTurn;
      const earlyProxy = {
        ...proxy.adapter,
        sendTurn: (input: ProviderSendTurnInput) =>
          originalSend(input).pipe(
            Effect.andThen(proxy.complete("failed")),
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.fail(failure)),
          ),
      };
      const adapter = yield* makePrismRoutedAdapter({
        direct: direct.adapter,
        enabled: () => true,
        proxy: () => Effect.succeed(earlyProxy),
      });
      yield* adapter.startSession(start);
      const sending = yield* adapter.sendTurn({ threadId, input: "hello" }).pipe(Effect.forkChild);
      yield* Queue.take(direct.sent);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(sending);
      assert.equal(result.turnId, "proxy");
      assert.equal(direct.turns.length, 1);
    }),
  );

  it.effect("stopAll during fallback startup cannot launch another turn or orphan a session", () =>
    Effect.gen(function* () {
      const direct = yield* fake("direct");
      const proxy = yield* fake("proxy", true);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const originalStart = direct.adapter.startSession;
      const delayedDirect = {
        ...direct.adapter,
        startSession: (input: ProviderSessionStartInput) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(originalStart(input)),
          ),
      };
      const adapter = yield* makePrismRoutedAdapter({
        direct: delayedDirect,
        enabled: () => true,
        proxy: () => Effect.succeed(proxy.adapter),
      });
      yield* adapter.startSession(start);
      const sending = yield* adapter
        .sendTurn({ threadId, input: "hello" })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* adapter.stopAll();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(sending);
      assert.equal(direct.turns.length, 0);
      assert.deepEqual(yield* direct.adapter.listSessions(), []);
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );
});

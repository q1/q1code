import {
  EventId,
  type ThreadId,
  type TurnId,
  type ProviderRuntimeEvent,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../../provider/Errors.ts";
import type { ProviderAdapterShape } from "../../provider/Services/ProviderAdapter.ts";
import { prismRoute, withoutPrismRoute } from "./PrismRouting.ts";

type Adapter = ProviderAdapterShape<ProviderAdapterError>;
interface SessionRoute {
  adapter: Adapter;
  start: ProviderSessionStartInput;
  turn?: {
    input: ProviderSendTurnInput;
    logicalId?: TurnId;
    nativeId?: TurnId;
    retried: boolean;
    cancelled: boolean;
    retryDone: Deferred.Deferred<ProviderTurnStartResult | undefined, ProviderAdapterError>;
  };
}

/** One provider instance, with routing kept at the adapter boundary and one logical turn across fallback. */
export const makePrismRoutedAdapter = Effect.fn("prism.routedAdapter")(function* (input: {
  direct: Adapter;
  enabled: () => boolean;
  proxy: () => Effect.Effect<Adapter | undefined, ProviderAdapterError>;
}) {
  const scope = yield* Scope.Scope;
  const crypto = yield* Crypto.Crypto;
  const nextEventId = crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(EventId.make));
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, SessionRoute>();
  const subscribed = new Set<Adapter>();
  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(events, event).pipe(Effect.asVoid);
  const cleanStart = (start: ProviderSessionStartInput) => ({
    ...start,
    modelSelection: withoutPrismRoute(start.modelSelection),
  });
  const cleanTurn = (turn: ProviderSendTurnInput) => ({
    ...turn,
    modelSelection: withoutPrismRoute(turn.modelSelection),
  });
  const routeFor = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const route = sessions.get(threadId);
      return route
        ? Effect.succeed(route)
        : Effect.fail(
            new ProviderAdapterSessionNotFoundError({ provider: input.direct.provider, threadId }),
          );
    });

  const move = Effect.fn("prism.moveSession")(function* (route: SessionRoute, adapter: Adapter) {
    if (route.adapter === adapter) return;
    const old = route.adapter;
    const current = (yield* old.listSessions()).find(
      (session) => session.threadId === route.start.threadId,
    );
    // Select the new source before stopping the old one, so its exit cannot end the retry.
    route.adapter = adapter;
    yield* old.stopSession(route.start.threadId);
    yield* adapter.startSession(
      cleanStart({
        ...route.start,
        ...(current?.resumeCursor !== undefined ? { resumeCursor: current.resumeCursor } : {}),
      }),
    );
    if (sessions.get(route.start.threadId) !== route)
      yield* adapter.stopSession(route.start.threadId);
  });

  const warning = Effect.fn("prism.warning")(function* (route: SessionRoute, message: string) {
    yield* publish({
      type: "runtime.warning",
      eventId: yield* nextEventId,
      provider: input.direct.provider,
      threadId: route.start.threadId,
      ...(route.start.providerInstanceId
        ? { providerInstanceId: route.start.providerInstanceId }
        : {}),
      ...(route.turn?.logicalId ? { turnId: route.turn.logicalId } : {}),
      createdAt: DateTime.formatIso(yield* DateTime.now),
      payload: { message },
    });
  });

  const retryDirect = Effect.fn("prism.retryDirect")(function* (route: SessionRoute) {
    const turn = route.turn;
    if (!turn || turn.cancelled) return undefined;
    if (turn.retried) return yield* Deferred.await(turn.retryDone);
    if (route.adapter === input.direct) return undefined;
    turn.retried = true;
    return yield* Effect.gen(function* () {
      yield* warning(route, "Prism failed. Retrying once with local direct-provider credentials.");
      yield* move(route, input.direct);
      if (turn.cancelled || sessions.get(route.start.threadId) !== route) return undefined;
      delete turn.nativeId;
      const result = yield* input.direct.sendTurn(cleanTurn(turn.input));
      turn.nativeId = result.turnId;
      turn.logicalId ??= result.turnId;
      return { ...result, turnId: turn.logicalId };
    }).pipe(
      Effect.exit,
      Effect.flatMap((exit) => Deferred.done(turn.retryDone, exit)),
      Effect.andThen(Deferred.await(turn.retryDone)),
    );
  });

  const receive = Effect.fn("prism.receive")(function* (
    source: Adapter,
    event: ProviderRuntimeEvent,
  ) {
    const route = sessions.get(event.threadId);
    if (!route || route.adapter !== source) return;
    const turn = route.turn;
    if (turn && event.turnId !== undefined) {
      if (turn.nativeId !== undefined && turn.nativeId !== event.turnId) return;
      turn.logicalId ??= event.turnId;
      turn.nativeId = event.turnId;
    }
    const failed =
      event.type === "runtime.error" ||
      event.type === "session.exited" ||
      (event.type === "turn.completed" &&
        (event.payload.state === "failed" || event.payload.state === "interrupted"));
    if (failed && turn && !turn.cancelled && !turn.retried && source !== input.direct) {
      const retried = yield* retryDirect(route).pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (retried !== undefined) return;
      // A failed direct start still produces a terminal event for the original turn.
      yield* publish({
        type: "turn.completed",
        eventId: yield* nextEventId,
        provider: event.provider,
        threadId: event.threadId,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        ...(event.providerInstanceId ? { providerInstanceId: event.providerInstanceId } : {}),
        ...(turn.logicalId ? { turnId: turn.logicalId } : {}),
        payload: {
          state: turn.cancelled ? "cancelled" : "failed",
          errorMessage: "Prism and local direct-provider fallback did not complete the turn.",
        },
      });
      delete route.turn;
      return;
    }
    const mapped = turn?.logicalId && event.turnId ? { ...event, turnId: turn.logicalId } : event;
    yield* publish(mapped);
    if (event.type === "turn.completed" || event.type === "turn.aborted") delete route.turn;
  });

  const subscribe = Effect.fn("prism.subscribeAdapter")(function* (adapter: Adapter) {
    if (subscribed.has(adapter)) return;
    subscribed.add(adapter);
    yield* Stream.runForEach(adapter.streamEvents, (event) => receive(adapter, event)).pipe(
      Effect.forkIn(scope, { startImmediately: true }),
    );
  });
  yield* subscribe(input.direct);
  const select = Effect.fn("prism.selectAdapter")(function* (
    selection: ProviderSessionStartInput["modelSelection"],
  ) {
    if (!input.enabled() || prismRoute(selection) === "direct") return input.direct;
    const proxy = yield* input.proxy();
    if (!proxy) return input.direct;
    yield* subscribe(proxy);
    return proxy;
  });

  const adapter: Adapter = {
    ...input.direct,
    streamEvents: Stream.fromPubSub(events),
    startSession: Effect.fn("prism.startSession")(function* (start) {
      const selected = yield* select(start.modelSelection).pipe(
        Effect.catch(() => Effect.succeed(input.direct)),
      );
      // Install before starting: native adapters can emit their first event during startSession.
      const route: SessionRoute = { adapter: selected, start };
      sessions.set(start.threadId, route);
      if (
        selected === input.direct &&
        input.enabled() &&
        prismRoute(start.modelSelection) === "prism"
      ) {
        yield* warning(route, "Prism is unavailable. Using local direct-provider credentials.");
      }
      const result = yield* selected.startSession(cleanStart(start)).pipe(
        Effect.catch((error) => {
          if (selected === input.direct) return Effect.fail(error);
          route.adapter = input.direct;
          return selected
            .stopSession(start.threadId)
            .pipe(Effect.ignore, Effect.andThen(input.direct.startSession(cleanStart(start))));
        }),
        Effect.tapError(() =>
          Effect.sync(() => {
            sessions.delete(start.threadId);
          }),
        ),
      );
      return result;
    }),
    sendTurn: Effect.fn("prism.sendTurn")(function* (turnInput) {
      const route = yield* routeFor(turnInput.threadId);
      const selection = turnInput.modelSelection ?? route.start.modelSelection;
      route.start = { ...route.start, modelSelection: selection };
      const selected = yield* select(selection).pipe(
        Effect.catch(() => Effect.succeed(input.direct)),
      );
      yield* move(route, selected).pipe(
        Effect.catch((error) => {
          if (selected === input.direct) return Effect.fail(error);
          return warning(
            route,
            "Prism could not start. Using local direct-provider credentials.",
          ).pipe(Effect.andThen(move(route, input.direct)));
        }),
      );
      const turn: NonNullable<SessionRoute["turn"]> = {
        input: turnInput,
        retried: false,
        cancelled: false,
        retryDone: yield* Deferred.make<
          ProviderTurnStartResult | undefined,
          ProviderAdapterError
        >(),
      };
      route.turn = turn;
      const result = yield* route.adapter
        .sendTurn(cleanTurn(turnInput))
        .pipe(
          Effect.catch((error) =>
            retryDirect(route).pipe(
              Effect.flatMap((result) => (result ? Effect.succeed(result) : Effect.fail(error))),
            ),
          ),
        );
      const completedStart = turn.retried
        ? ((yield* Deferred.await(turn.retryDone)) ?? result)
        : result;
      turn.logicalId ??= completedStart.turnId;
      if (!turn.retried) turn.nativeId = result.turnId;
      return { ...completedStart, turnId: turn.logicalId };
    }),
    interruptTurn: (id) =>
      routeFor(id).pipe(
        Effect.flatMap((route) => {
          if (route.turn) route.turn.cancelled = true;
          return route.adapter.interruptTurn(id, route.turn?.nativeId);
        }),
      ),
    stopSession: (id) =>
      routeFor(id).pipe(
        Effect.flatMap((route) => {
          if (route.turn) route.turn.cancelled = true;
          sessions.delete(id);
          return route.adapter.stopSession(id);
        }),
      ),
    stopAll: () =>
      Effect.gen(function* () {
        for (const route of sessions.values()) {
          if (route.turn) route.turn.cancelled = true;
        }
        sessions.clear();
        yield* Effect.forEach(subscribed, (adapter) => adapter.stopAll(), { discard: true });
      }),
    listSessions: () =>
      Effect.forEach(subscribed, (adapter) => adapter.listSessions()).pipe(
        Effect.map((groups) => groups.flat().filter((session) => sessions.has(session.threadId))),
      ),
    hasSession: (id) => Effect.sync(() => sessions.has(id)),
    readThread: (id) => routeFor(id).pipe(Effect.flatMap((route) => route.adapter.readThread(id))),
    rollbackThread: (id, count) =>
      routeFor(id).pipe(Effect.flatMap((route) => route.adapter.rollbackThread(id, count))),
    respondToRequest: (id, requestId, decision) =>
      routeFor(id).pipe(
        Effect.flatMap((route) => route.adapter.respondToRequest(id, requestId, decision)),
      ),
    respondToUserInput: (id, requestId, answers) =>
      routeFor(id).pipe(
        Effect.flatMap((route) => route.adapter.respondToUserInput(id, requestId, answers)),
      ),
    compactThread: (id, selection) =>
      routeFor(id).pipe(
        Effect.flatMap(
          (route) => route.adapter.compactThread?.(id, withoutPrismRoute(selection)) ?? Effect.void,
        ),
      ),
    ...(input.direct.uploadFeedback
      ? {
          uploadFeedback: (feedback: Parameters<NonNullable<Adapter["uploadFeedback"]>>[0]) =>
            routeFor(feedback.threadId).pipe(
              Effect.flatMap((route) => route.adapter.uploadFeedback!(feedback)),
            ),
        }
      : {}),
  };
  return adapter;
});

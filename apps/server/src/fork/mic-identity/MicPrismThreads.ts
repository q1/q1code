// @effect-diagnostics globalDate:off - Broker credential expiry uses the native HTTP clock.
import * as NodeCrypto from "node:crypto";
import type { ModelSelection, OrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { OrchestrationCommandInvariantError } from "../../orchestration/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import {
  isPrismEnabled,
  isPrismIdentityRequired,
  prismEndpointChanges,
} from "../prism/PrismEnvironment.ts";
import { prismRoute, MIC_PRISM_BINDING_OPTION } from "../prism/PrismRouting.ts";
import {
  createPrismInferenceBroker,
  type PrismBrokerCredential,
  type PrismInferenceBinding,
} from "./PrismInferenceBroker.ts";

const fields = [
  "environmentSessionId",
  "subject",
  "sessionId",
  "threadId",
  "serviceInstanceId",
  "pairingRevision",
  "inferenceOrigin",
] as const;
const sameBinding = (a: PrismInferenceBinding, b: PrismInferenceBinding) =>
  fields.every((key) => a[key] === b[key]);
const unavailable = () =>
  new Error("Prism thread authorization is unavailable. Reconnect your mic.sc session.");
async function waitForRegistration<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  let abort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(unavailable());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
type Broker = Awaited<ReturnType<typeof createPrismInferenceBroker>>;
type Registration = {
  readonly binding: PrismInferenceBinding;
  readonly credential: PrismBrokerCredential;
  readonly verifyEnvironment: () => Promise<boolean>;
  readonly signal?: AbortSignal;
};
type Entry = {
  readonly bindingId: string;
  readonly binding: PrismInferenceBinding;
  credential: PrismBrokerCredential;
  readonly verifyEnvironment: () => Promise<boolean>;
  broker?: Broker;
  ready: Promise<void>;
};

/** Memory-only ownership survives credential expiry, preventing another actor from renewing a thread. */
export function makeMicPrismThreadRegistry(options: {
  readonly enabled: () => boolean;
  readonly changes?: Stream.Stream<void>;
  readonly now?: () => number;
  readonly createBroker?: typeof createPrismInferenceBroker;
}) {
  const entries = new Map<string, Entry>();
  const handles = new Map<string, Entry>();
  const active = new Map<
    string,
    { readonly bindingId: string; readonly selection?: ModelSelection }
  >();
  const entryKey = (threadId: string, environmentSessionId: string) =>
    JSON.stringify([threadId, environmentSessionId]);
  // A queued command may outlive revocation. Never attach another actor's credential to its thread.
  const owners = new Map<string, string>();
  const now = options.now ?? Date.now;
  const createBroker = options.createBroker ?? createPrismInferenceBroker;
  let watcher: { controller: AbortController; ready: Promise<void> } | undefined;
  const closeAll = async () => {
    const current = [...entries.values()];
    entries.clear();
    handles.clear();
    active.clear();
    const previous = watcher;
    watcher = undefined;
    previous?.controller.abort();
    await Promise.all(
      current.map(async (entry) => {
        entry.broker?.revoke();
        await entry.ready.catch(() => {});
        await entry.broker?.close();
      }),
    );
  };
  const watch = () => {
    if (!watcher && options.changes) {
      const controller = new AbortController();
      let subscribed!: () => void;
      const ready = new Promise<void>((resolve) => {
        subscribed = resolve;
      });
      watcher = { controller, ready };
      void Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const pull = yield* Stream.toPull(options.changes!);
            subscribed();
            while (true) {
              yield* pull;
              if (!options.enabled()) yield* Effect.promise(closeAll);
            }
          }),
        ),
        { signal: controller.signal },
      ).catch(() => {
        subscribed();
      });
    }
    return watcher?.ready ?? Promise.resolve();
  };
  const valid = (credential: PrismBrokerCredential, binding: PrismInferenceBinding) =>
    sameBinding(credential.binding, binding) &&
    Number.isSafeInteger(credential.expiresAt) &&
    credential.expiresAt > now() &&
    credential.expiresAt <= now() + 930_000 &&
    credential.token.length <= 8192 &&
    /^msp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credential.token);
  const register = async (input: Registration) => {
    if (input.signal?.aborted || !options.enabled() || !valid(input.credential, input.binding))
      throw unavailable();
    const owner = owners.get(input.binding.threadId);
    if (owner && owner !== input.binding.subject) throw unavailable();
    if (
      [...entries.values()].some(
        (entry) =>
          entry.binding.threadId === input.binding.threadId &&
          entry.binding.subject !== input.binding.subject,
      )
    )
      throw unavailable();
    const key = entryKey(input.binding.threadId, input.binding.environmentSessionId);
    const existing = entries.get(key);
    if (existing && !sameBinding(existing.binding, input.binding)) throw unavailable();
    if (existing) {
      if (
        !(await waitForRegistration(
          input.verifyEnvironment().catch(() => false),
          input.signal,
        ))
      )
        throw unavailable();
      await waitForRegistration(existing.ready, input.signal);
      if (
        input.signal?.aborted ||
        entries.get(key) !== existing ||
        !options.enabled() ||
        !valid(input.credential, input.binding)
      )
        throw unavailable();
      if (input.credential.expiresAt > existing.credential.expiresAt)
        existing.credential = { ...input.credential, binding: existing.binding };
      return { threadId: existing.binding.threadId, expiresAt: existing.credential.expiresAt };
    }
    const binding = Object.freeze({ ...input.binding });
    const entry: Entry = {
      bindingId: NodeCrypto.randomUUID(),
      binding,
      credential: { ...input.credential, binding },
      verifyEnvironment: input.verifyEnvironment,
      ready: Promise.resolve(),
    };
    // Reserve synchronously before any verification or socket allocation can yield.
    entries.set(key, entry);
    const cancel = () => {
      if (entries.get(key) !== entry) return;
      entries.delete(key);
      handles.delete(entry.bindingId);
      entry.broker?.revoke();
      void entry.broker?.close();
    };
    input.signal?.addEventListener("abort", cancel, { once: true });
    if (input.signal?.aborted) cancel();
    entry.ready = (async () => {
      await waitForRegistration(watch(), input.signal);
      if (
        !(await waitForRegistration(
          entry.verifyEnvironment().catch(() => false),
          input.signal,
        ))
      )
        throw unavailable();
      if (entries.get(key) !== entry || !options.enabled()) throw unavailable();
      const establishedOwner = owners.get(binding.threadId);
      if (establishedOwner && establishedOwner !== binding.subject) throw unavailable();
      owners.set(binding.threadId, binding.subject);
      const broker = await waitForRegistration(
        createBroker({
          binding,
          verifyBinding: async () =>
            options.enabled() &&
            entries.get(key) === entry &&
            (await entry.verifyEnvironment().catch(() => false)),
          getCredential: async () => {
            if (
              !options.enabled() ||
              entries.get(key) !== entry ||
              !valid(entry.credential, binding)
            )
              throw unavailable();
            return entry.credential;
          },
        }).then(async (created) => {
          if (input.signal?.aborted || entries.get(key) !== entry || !options.enabled()) {
            await created.close();
            throw unavailable();
          }
          return created;
        }),
        input.signal,
      );
      entry.broker = broker;
      handles.set(entry.bindingId, entry);
      if (entries.get(key) !== entry || !options.enabled()) {
        await broker.close();
        throw unavailable();
      }
    })();
    try {
      await entry.ready;
      if (input.signal?.aborted || !valid(entry.credential, binding)) throw unavailable();
      return { threadId: binding.threadId, expiresAt: entry.credential.expiresAt };
    } catch {
      if (entries.get(key) === entry) entries.delete(key);
      handles.delete(entry.bindingId);
      await entry.broker?.close();
      throw unavailable();
    } finally {
      input.signal?.removeEventListener("abort", cancel);
    }
  };
  const revoke = async (threadId: string, environmentSessionId: string) => {
    const key = entryKey(threadId, environmentSessionId);
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    handles.delete(entry.bindingId);
    entry.broker?.revoke();
    await entry.ready.catch(() => {});
    await entry.broker?.close();
  };
  const revokeEnvironment = async (environmentSessionId: string) => {
    await Promise.all(
      [...entries.values()]
        .filter((entry) => entry.binding.environmentSessionId === environmentSessionId)
        .map((entry) => revoke(entry.binding.threadId, environmentSessionId)),
    );
  };
  const endpoint = (threadId: string, bindingId: string | undefined) => {
    if (!bindingId) return undefined;
    if (!options.enabled()) {
      void closeAll();
      return undefined;
    }
    const entry = handles.get(bindingId);
    return entry &&
      entry.binding.threadId === threadId &&
      entries.get(entryKey(threadId, entry.binding.environmentSessionId)) === entry &&
      valid(entry.credential, entry.binding)
      ? entry.broker?.endpoint
      : undefined;
  };
  const authorize = async (threadId: string, environmentSessionId: string) => {
    const entry = entries.get(entryKey(threadId, environmentSessionId));
    if (!entry || !endpoint(threadId, entry.bindingId)) return undefined;
    const verified = await entry.verifyEnvironment().catch(() => false);
    return verified &&
      options.enabled() &&
      entries.get(entryKey(threadId, environmentSessionId)) === entry &&
      endpoint(threadId, entry.bindingId)
      ? entry.bindingId
      : undefined;
  };
  return {
    publishActive: (
      threadId: string,
      bindingId: string | undefined,
      selection?: ModelSelection,
    ) => {
      if (!options.enabled() || bindingId === undefined) active.delete(threadId);
      else active.set(threadId, { bindingId, ...(selection ? { selection } : {}) });
    },
    activeBinding: (threadId: string) => active.get(threadId)?.bindingId,
    activeSelection: (threadId: string) => active.get(threadId)?.selection,
    register,
    revoke,
    revokeEnvironment,
    endpoint,
    authorize,
    owns: async (threadId: string, environmentSessionId: string) =>
      Boolean(await authorize(threadId, environmentSessionId)),
    has: (threadId: string) =>
      owners.has(threadId) ||
      [...entries.values()].some((entry) => entry.binding.threadId === threadId),
    closeAll,
  };
}

const registry = makeMicPrismThreadRegistry({
  enabled: () => isPrismEnabled() && isPrismIdentityRequired(),
  changes: prismEndpointChanges,
});
export const registerMicPrismThread = registry.register;
/** Server-only actor check; the returned handle conveys no authority outside this process. */
export const authorizeMicPrismThread = registry.authorize;
export const revokeMicPrismThread = registry.revoke;
export const getMicPrismThreadEndpoint = registry.endpoint;
export const revokeMicPrismEnvironmentSession = registry.revokeEnvironment;
export const closeAllMicPrismThreads = registry.closeAll;
export const publishMicPrismActiveBinding = registry.publishActive;

const executes = new Set([
  "thread.turn.start",
  "thread.approval.respond",
  "thread.user-input.respond",
  "thread.checkpoint.revert",
  "thread.runtime-mode.set",
]);

type ResolvedSelection = {
  readonly selection: ModelSelection | undefined;
  readonly routed: boolean;
};
const stripBinding = (selection: ModelSelection): ModelSelection => ({
  ...selection,
  ...(selection.options
    ? { options: selection.options.filter((option) => option.id !== MIC_PRISM_BINDING_OPTION) }
    : {}),
});
const stampedSelection = (selection: ModelSelection, bindingId: string): ModelSelection => ({
  ...selection,
  options: [
    ...(selection.options ?? []).filter((option) => option.id !== MIC_PRISM_BINDING_OPTION),
    { id: MIC_PRISM_BINDING_OPTION, value: bindingId },
  ],
});
function stripClientBindings(command: OrchestrationCommand): OrchestrationCommand {
  let clean =
    "modelSelection" in command && command.modelSelection
      ? { ...command, modelSelection: stripBinding(command.modelSelection) }
      : command;
  if (clean.type === "thread.turn.start" && clean.bootstrap?.createThread) {
    clean = {
      ...clean,
      bootstrap: {
        ...clean.bootstrap,
        createThread: {
          ...clean.bootstrap.createThread,
          modelSelection: stripBinding(clean.bootstrap.createThread.modelSelection),
        },
      },
    };
  }
  return clean;
}

/** Stamp a noncredential handle before persistence; queued commands can never borrow a replacement broker. */
export const withMicPrismDispatch = Effect.fn("withMicPrismDispatch")(function* (
  engine: OrchestrationEngineShape,
  environmentSessionId: string,
) {
  const snapshots = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderInstanceRegistry;
  return guardMicPrismDispatch(engine, environmentSessionId, {
    enabled: () => isPrismEnabled() && isPrismIdentityRequired(),
    registry,
    resolveSelection: (command) =>
      Effect.gen(function* () {
        if (!("threadId" in command)) return { selection: undefined, routed: false };
        let selection: ModelSelection | undefined =
          "modelSelection" in command ? command.modelSelection : undefined;
        if (!selection && command.type === "thread.turn.start")
          selection = command.bootstrap?.createThread?.modelSelection;
        if (!selection) selection = registry.activeSelection(command.threadId);
        if (!selection) {
          const shell = yield* snapshots
            .getThreadShellById(command.threadId)
            .pipe(Effect.mapError(() => unavailable()));
          selection = Option.isSome(shell) ? shell.value.modelSelection : undefined;
        }
        const provider = selection ? yield* providers.getInstance(selection.instanceId) : undefined;
        return {
          selection,
          routed: provider?.driverKind === "codex" || provider?.driverKind === "claudeAgent",
        };
      }),
  });
});

export function guardMicPrismDispatch(
  engine: OrchestrationEngineShape,
  environmentSessionId: string,
  options: {
    readonly enabled: () => boolean;
    readonly registry: Pick<
      ReturnType<typeof makeMicPrismThreadRegistry>,
      "has" | "authorize" | "activeBinding"
    >;
    readonly resolveSelection: (
      command: OrchestrationCommand,
    ) => Effect.Effect<ResolvedSelection, Error>;
  },
): OrchestrationEngineShape {
  return {
    ...engine,
    dispatch: (input, dispatchOptions) =>
      Effect.gen(function* () {
        if (!options.enabled()) return yield* engine.dispatch(input, dispatchOptions);
        const command = stripClientBindings(input);
        if (!("threadId" in command) || !executes.has(command.type))
          return yield* engine.dispatch(command, dispatchOptions);
        const reject = (continuation = false) =>
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: continuation
              ? "Continue this approval or session action from its initiating device, or start a new turn with Prism connected on this device."
              : "Prism authorization required for this environment session. Reconnect mic.sc for this thread.",
          });
        const resolved = yield* options
          .resolveSelection(command)
          .pipe(Effect.mapError(() => reject()));
        if (command.type === "thread.turn.start") {
          if (!resolved.routed || !resolved.selection)
            return yield* engine.dispatch(command, dispatchOptions);
          if (prismRoute(resolved.selection) === "direct") {
            return yield* engine.dispatch(
              { ...command, modelSelection: stampedSelection(resolved.selection, "direct") },
              dispatchOptions,
            );
          }
          const bindingId = yield* Effect.tryPromise({
            try: () => options.registry.authorize(command.threadId, environmentSessionId),
            catch: () => reject(),
          });
          if (!bindingId) return yield* reject();
          return yield* engine.dispatch(
            { ...command, modelSelection: stampedSelection(resolved.selection, bindingId) },
            dispatchOptions,
          );
        }
        if (options.registry.has(command.threadId) || resolved.routed) {
          const activeHandle = options.registry.activeBinding(command.threadId);
          if (activeHandle === "direct") return yield* engine.dispatch(command, dispatchOptions);
          const bindingId = yield* Effect.tryPromise({
            try: () => options.registry.authorize(command.threadId, environmentSessionId),
            catch: () => reject(true),
          });
          if (!bindingId || bindingId !== activeHandle) return yield* reject(true);
        }
        return yield* engine.dispatch(command, dispatchOptions);
      }),
  };
}

export const micPrismEngineForSession = (environmentSessionId: string) =>
  Effect.flatMap(OrchestrationEngineService, (engine) =>
    withMicPrismDispatch(engine, environmentSessionId),
  );

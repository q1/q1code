/**
 * ForkFlags - Server-side resolution of the fork feature-flag registry.
 *
 * Reads `<userdata>/fork.json`, overlays `T3FORK_*` environment variables, and
 * falls back to registry defaults when the file is missing or malformed (one
 * warning per breakage, never a failure). The file is watched like
 * `serverSettings.ts` watches `settings.json`, so edits land without a restart.
 * Clients receive the resolved values through `ExecutionEnvironmentCapabilities.forkFlags`.
 *
 * `update` is the one writer: it edits the raw JSON so unknown keys survive,
 * validates the result against the schema, writes temp + fsync + rename, and
 * re-reads, so a feature that persists a setting (prism routing) never
 * clobbers what another feature or the user put in the file.
 */
import {
  EMPTY_FORK_CONFIG,
  FORK_CONFIG_FILENAME,
  type ForkConfig,
  decodeForkConfig,
  decodeForkConfigJson,
} from "@q1code/core/config";
import {
  DEFAULT_FORK_FLAGS,
  FORK_FLAG_KEYS,
  type ForkFlagValues,
  resolveForkFlags,
} from "@q1code/core/flags";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";

/** The file as JSON, before schema decoding: what `update` mutates so unknown keys are kept. */
export type RawForkConfig = Readonly<Record<string, unknown>>;

export class ForkConfigWriteError extends Schema.TaggedErrorClass<ForkConfigWriteError>()(
  "ForkConfigWriteError",
  {
    path: Schema.String,
    /** `malformed`: the file on disk is not a JSON object. `invalid`: the mutation broke the schema. `io`: the write failed. */
    reason: Schema.Literals(["malformed", "invalid", "io"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to update ${this.path} (${this.reason}): ${this.detail}`;
  }
}

export class ForkFlagsService extends Context.Service<
  ForkFlagsService,
  {
    /** Resolved values for every registry flag. */
    readonly current: Effect.Effect<ForkFlagValues>;
    /** Re-read the file now; publishes to `changes` when a value moved. */
    readonly reload: Effect.Effect<ForkFlagValues>;
    /** Emits the full flag set each time a value changes. */
    readonly changes: Stream.Stream<ForkFlagValues>;
    /** The whole decoded `fork.json` as of the last reload (feature sections live next to `flags`). */
    readonly config: Effect.Effect<ForkConfig>;
    /**
     * Rewrite `fork.json` through `mutate` (raw JSON in, raw JSON out), keeping
     * keys the schema does not know, then reload. Atomic: temp file, fsync,
     * rename. A missing file starts from `{}`.
     */
    readonly update: (
      mutate: (raw: RawForkConfig) => RawForkConfig,
    ) => Effect.Effect<ForkConfig, ForkConfigWriteError>;
  }
>()("t3/fork/ForkFlags/ForkFlagsService") {}

/** Injectable process environment so tests can override `T3FORK_*` without touching `process.env`. */
export const ForkFlagsEnvironment = Context.Reference<Readonly<Record<string, string | undefined>>>(
  "t3/fork/ForkFlags/ForkFlagsEnvironment",
  { defaultValue: () => process.env },
);

export const forkConfigPath = (stateDir: string, path: Path.Path) =>
  path.join(stateDir, FORK_CONFIG_FILENAME);

const sameFlags = (left: ForkFlagValues, right: ForkFlagValues) =>
  FORK_FLAG_KEYS.every((key) => left[key] === right[key]);

/** The `prism` feature was called `cliproxy`; these spellings are ignored and warned about once at start. */
const LEGACY_PRISM_ENV_VARS = [
  "T3FORK_CLIPROXY",
  "Q1CODE_CLIPROXY_SYNC_TOKEN",
  "Q1CODE_CLIPROXY_SYNC_KEY",
] as const;

const RawJsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeRawJsonObject = Schema.decodeUnknownExit(RawJsonObject);

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = yield* ForkFlagsEnvironment;
  const configPath = forkConfigPath(stateDir, path);
  const valuesRef = yield* Ref.make<ForkFlagValues>(DEFAULT_FORK_FLAGS);
  const configRef = yield* Ref.make<ForkConfig>(EMPTY_FORK_CONFIG);
  const warnedRef = yield* Ref.make(false);
  const reloadSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* PubSub.unbounded<ForkFlagValues>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  // Missing file -> no file overrides. Malformed file -> warn once, no file
  // overrides. The warning re-arms after the file parses again.
  const readFileConfig = Effect.gen(function* () {
    if (!(yield* fs.exists(configPath))) {
      return undefined;
    }
    const decoded = decodeForkConfigJson(yield* fs.readFileString(configPath));
    if (Exit.isSuccess(decoded)) {
      yield* Ref.set(warnedRef, false);
      return decoded.value;
    }
    if (yield* Ref.getAndSet(warnedRef, true)) {
      return undefined;
    }
    yield* Effect.logWarning("failed to parse fork.json, using defaults", {
      path: configPath,
      issues: Cause.pretty(decoded.cause),
    });
    return undefined;
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to read fork.json, using defaults", {
        path: configPath,
        cause: error,
      }).pipe(Effect.as(undefined)),
    ),
  );

  const reloadUnlocked = Effect.gen(function* () {
    const fileConfig = yield* readFileConfig;
    yield* Ref.set(configRef, fileConfig ?? EMPTY_FORK_CONFIG);
    const next = resolveForkFlags({ env, file: fileConfig?.flags });
    const previous = yield* Ref.getAndSet(valuesRef, next);
    if (!sameFlags(previous, next)) {
      yield* PubSub.publish(changesPubSub, next);
    }
    return next;
  });

  const reload = reloadSemaphore.withPermits(1)(reloadUnlocked);

  const writeError = (reason: ForkConfigWriteError["reason"]) => (cause: unknown) =>
    new ForkConfigWriteError({
      path: configPath,
      reason,
      detail: cause instanceof Error ? cause.message : String(cause),
    });

  const readRaw: Effect.Effect<RawForkConfig, ForkConfigWriteError> = Effect.gen(function* () {
    const exists = yield* fs.exists(configPath).pipe(Effect.mapError(writeError("io")));
    if (!exists) return {};
    const text = yield* fs.readFileString(configPath).pipe(Effect.mapError(writeError("io")));
    const decoded = decodeRawJsonObject(text);
    return Exit.isSuccess(decoded)
      ? decoded.value
      : yield* writeError("malformed")(Cause.squash(decoded.cause));
  });

  // Temp file in the same directory, fsync, rename: a crash mid-write leaves
  // the old file intact, and the watcher only ever sees a complete file.
  const writeRaw = (raw: RawForkConfig) =>
    Effect.gen(function* () {
      const tempPath = `${configPath}.${process.pid}.tmp`;
      // Formatting is the point here: the user edits this file by hand.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const contents = `${JSON.stringify(raw, null, 2)}\n`;
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(tempPath, { flag: "w" });
          yield* file.writeAll(new TextEncoder().encode(contents));
          yield* file.sync;
        }),
      ).pipe(Effect.onError(() => fs.remove(tempPath).pipe(Effect.ignore)));
      yield* fs.rename(tempPath, configPath);
    }).pipe(Effect.mapError(writeError("io")));

  const update = (mutate: (raw: RawForkConfig) => RawForkConfig) =>
    reloadSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const next = mutate(yield* readRaw);
        const validated = decodeForkConfig(next);
        if (Exit.isFailure(validated)) {
          return yield* writeError("invalid")(Cause.squash(validated.cause));
        }
        yield* writeRaw(next);
        yield* reloadUnlocked;
        return yield* Ref.get(configRef);
      }),
    );

  const startWatcher = Effect.gen(function* () {
    yield* fs.makeDirectory(stateDir, { recursive: true });
    const configFile = path.basename(configPath);
    const configPathResolved = path.resolve(configPath);
    // Same debounce as serverSettings: editors emit several events per save.
    const debouncedEvents = fs.watch(stateDir).pipe(
      Stream.filter(
        (event) =>
          event.path === configFile ||
          event.path === configPath ||
          path.resolve(stateDir, event.path) === configPathResolved,
      ),
      Stream.debounce(Duration.millis(100)),
    );
    yield* Stream.runForEach(debouncedEvents, () => reload).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
    );
  }).pipe(Effect.ignoreCause({ log: true }));

  // A renamed key or env var silently does nothing, so name it once at start.
  const warnLegacyPrismNames = Effect.gen(function* () {
    const raw = yield* readRaw.pipe(Effect.orElseSucceed((): RawForkConfig => ({})));
    if (Object.prototype.hasOwnProperty.call(raw, "cliproxy")) {
      yield* Effect.logWarning(
        'prism: fork.json key "cliproxy" was renamed to "prism" and is ignored',
        { path: configPath },
      );
    }
    for (const name of LEGACY_PRISM_ENV_VARS) {
      if (env[name] === undefined) continue;
      yield* Effect.logWarning(
        `prism: environment variable ${name} was renamed to ${name.replace("CLIPROXY", "PRISM")} and is ignored`,
      );
    }
  });

  yield* reload;
  yield* warnLegacyPrismNames;
  yield* startWatcher;

  return ForkFlagsService.of({
    current: Ref.get(valuesRef),
    reload,
    changes: Stream.fromPubSub(changesPubSub),
    config: Ref.get(configRef),
    update,
  });
});

export const layer = Layer.effect(ForkFlagsService, make);

/** Stamp the current flag values onto a descriptor's capabilities (the ServerEnvironment seam). */
export const attachForkFlags = (
  descriptor: ExecutionEnvironmentDescriptor,
  flags: ForkFlagsService["Service"],
): Effect.Effect<ExecutionEnvironmentDescriptor> =>
  Effect.map(flags.current, (forkFlags) => ({
    ...descriptor,
    capabilities: { ...descriptor.capabilities, forkFlags },
  }));

/** Fixed flags and config; `update` applies the mutation in memory and answers the decoded result. */
export const layerTest = (
  overrides: Partial<ForkFlagValues> = {},
  config: ForkConfig = EMPTY_FORK_CONFIG,
) =>
  Layer.succeed(
    ForkFlagsService,
    ForkFlagsService.of({
      current: Effect.succeed({ ...DEFAULT_FORK_FLAGS, ...overrides }),
      reload: Effect.succeed({ ...DEFAULT_FORK_FLAGS, ...overrides }),
      changes: Stream.empty,
      config: Effect.succeed(config),
      update: (mutate) => {
        const decoded = decodeForkConfig(mutate(config as RawForkConfig));
        return Exit.isSuccess(decoded)
          ? Effect.succeed(decoded.value)
          : Effect.fail(
              new ForkConfigWriteError({
                path: FORK_CONFIG_FILENAME,
                reason: "invalid",
                detail: Cause.pretty(decoded.cause),
              }),
            );
      },
    }),
  );

/**
 * Cross-machine auth-file sync (phase 1: environment to environment over the
 * tailnet). One environment is the primary; replicas pull its `auths/` on a
 * timer, write files that are newer than their own, then push back any local
 * file that is newer than the primary's copy (refreshed tokens). Last writer
 * wins by file mtime; equal stamps are skipped; there are no tombstones.
 *
 * Every entry crosses the wire encrypted with a key both sides derive from a
 * shared secret (`CliProxySyncCrypto.ts`). The replica authenticates to the
 * primary with an admin-scoped bearer token. Both secrets come from the
 * environment (`Q1CODE_CLIPROXY_SYNC_TOKEN`, `Q1CODE_CLIPROXY_SYNC_KEY`) or
 * from the server secret store under the names in `fork.json`.
 *
 * The transport and the ticker are services so tests wire two sync services
 * together in memory and drive the loop without a clock.
 */
import {
  CLIPROXY_API_PATHS,
  CliProxySyncBundle,
  type CliProxySyncEntry,
  CliProxySyncFailedError,
  CliProxySyncPushResult,
  type CliProxySyncStatus,
} from "@q1code/core/cliproxyApi";
import {
  CLIPROXY_SYNC_DEFAULT_INTERVAL_SECONDS,
  type CliProxySyncConfig,
} from "@q1code/core/config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ForkFlags from "../ForkFlags.ts";
import { cliproxyDirectories } from "./CliProxyConfig.ts";
import {
  decryptSyncEntry,
  deriveSyncKey,
  encryptSyncEntry,
  type SyncKey,
} from "./CliProxySyncCrypto.ts";

export const SYNC_TOKEN_ENV = "Q1CODE_CLIPROXY_SYNC_TOKEN";
export const SYNC_KEY_ENV = "Q1CODE_CLIPROXY_SYNC_KEY";

/** Sync has no usable configuration for the requested role. The message never names a secret value. */
export class CliProxySyncNotConfigured extends Schema.TaggedErrorClass<CliProxySyncNotConfigured>()(
  "CliProxySyncNotConfigured",
  {
    message: Schema.String,
  },
) {}

export type CliProxySyncError = CliProxySyncNotConfigured | CliProxySyncFailedError;

export interface SyncStamp {
  readonly id: string;
  readonly updatedAt: string;
}

export interface SyncPlan {
  /** Ids whose remote copy is newer than (or missing from) the local set. */
  readonly pull: ReadonlyArray<string>;
  /** Ids whose local copy is newer than (or missing from) the remote set. */
  readonly push: ReadonlyArray<string>;
}

const stampMillis = (stamp: SyncStamp): number => {
  const millis = Date.parse(stamp.updatedAt);
  return Number.isFinite(millis) ? millis : 0;
};

/** Pure: newer wins on each side, equal stamps move nowhere. */
export const planSyncMerge = (
  local: ReadonlyArray<SyncStamp>,
  remote: ReadonlyArray<SyncStamp>,
): SyncPlan => {
  const localById = new Map(local.map((stamp) => [stamp.id, stampMillis(stamp)]));
  const remoteById = new Map(remote.map((stamp) => [stamp.id, stampMillis(stamp)]));
  const pull: Array<string> = [];
  const push: Array<string> = [];
  for (const [id, remoteMillis] of remoteById) {
    const localMillis = localById.get(id);
    if (localMillis === undefined || remoteMillis > localMillis) pull.push(id);
  }
  for (const [id, localMillis] of localById) {
    const remoteMillis = remoteById.get(id);
    if (remoteMillis === undefined || localMillis > remoteMillis) push.push(id);
  }
  return { pull, push };
};

export interface CliProxySyncTransportInput {
  readonly primaryUrl: string;
  readonly token: string;
}

/** The replica's view of the primary. Tests provide one backed by another sync service. */
export class CliProxySyncTransport extends Context.Service<
  CliProxySyncTransport,
  {
    readonly fetchExport: (
      input: CliProxySyncTransportInput,
    ) => Effect.Effect<CliProxySyncBundle, CliProxySyncFailedError>;
    readonly push: (
      input: CliProxySyncTransportInput & { readonly entries: ReadonlyArray<CliProxySyncEntry> },
    ) => Effect.Effect<CliProxySyncPushResult, CliProxySyncFailedError>;
  }
>()("t3/fork/cliproxy/CliProxySync/CliProxySyncTransport") {}

/** Emits once per replica cycle; the first emission is the startup sync. Tests inject a PubSub. */
export const CliProxySyncTicker = Context.Reference<
  (interval: Duration.Duration) => Stream.Stream<unknown>
>("t3/fork/cliproxy/CliProxySync/CliProxySyncTicker", {
  defaultValue: () => (interval) => Stream.tick(interval),
});

export class CliProxySyncService extends Context.Service<
  CliProxySyncService,
  {
    readonly status: Effect.Effect<CliProxySyncStatus>;
    /** Emits the status after every replica cycle, success or failure. */
    readonly changes: Stream.Stream<CliProxySyncStatus>;
    /** Primary: every auth file, encrypted, stamped with its mtime. */
    readonly exportBundle: Effect.Effect<CliProxySyncBundle, CliProxySyncError>;
    /** Primary: decrypt and write the entries that are newer than the local copies. */
    readonly applyPush: (
      entries: ReadonlyArray<CliProxySyncEntry>,
    ) => Effect.Effect<CliProxySyncPushResult, CliProxySyncError>;
    /** Replica: one pull-then-push cycle against the primary. */
    readonly syncNow: Effect.Effect<void, CliProxySyncError>;
  }
>()("t3/fork/cliproxy/CliProxySync/CliProxySyncService") {}

interface ResolvedSync {
  readonly role: CliProxySyncConfig["role"];
  readonly key: SyncKey;
  readonly primaryUrl: string | undefined;
  readonly token: string | undefined;
  readonly interval: Duration.Duration;
}

const isAuthFileName = (name: string) => name.endsWith(".json") && !name.startsWith(".");

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const trimOrigin = (url: string) => url.replace(/\/+$/, "");

const ioError = (message: string) => (cause: unknown) =>
  new CliProxySyncFailedError({
    reason: "io",
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const flags = yield* ForkFlags.ForkFlagsService;
  const env = yield* ForkFlags.ForkFlagsEnvironment;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const transport = yield* CliProxySyncTransport;
  const ticker = yield* CliProxySyncTicker;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { authsDir } = cliproxyDirectories(config.baseDir, path);

  const lastSyncRef = yield* Ref.make<{ at?: string; error?: string }>({});
  const changesPubSub = yield* PubSub.unbounded<CliProxySyncStatus>();
  const loopRef = yield* Ref.make<Option.Option<Fiber.Fiber<void>>>(Option.none());
  const lifecycle = yield* Semaphore.make(1);
  const cycleLock = yield* Semaphore.make(1);
  const runScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(runScope, Exit.void));

  const section = flags.config.pipe(Effect.map((forkConfig) => forkConfig.cliproxy?.sync));

  const readSecret = (envName: string, storeName: string | undefined) =>
    Effect.gen(function* () {
      const fromEnv = env[envName]?.trim();
      if (fromEnv) return fromEnv;
      if (storeName === undefined) return undefined;
      const stored = yield* secrets
        .get(storeName)
        .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
      return Option.isSome(stored) ? new TextDecoder().decode(stored.value).trim() : undefined;
    });

  const resolve = Effect.gen(function* () {
    const sync = yield* section;
    if (sync === undefined) {
      return yield* new CliProxySyncNotConfigured({ message: "fork.json has no cliproxy.sync" });
    }
    const sharedSecret = yield* readSecret(SYNC_KEY_ENV, sync.sharedKeySecretName);
    if (sharedSecret === undefined || sharedSecret.length === 0) {
      return yield* new CliProxySyncNotConfigured({
        message: `no shared key (${SYNC_KEY_ENV} or cliproxy.sync.sharedKeySecretName)`,
      });
    }
    const token = yield* readSecret(SYNC_TOKEN_ENV, sync.tokenSecretName);
    const resolved: ResolvedSync = {
      role: sync.role,
      key: deriveSyncKey(sharedSecret),
      primaryUrl: sync.primaryUrl === undefined ? undefined : trimOrigin(sync.primaryUrl),
      token,
      interval: Duration.seconds(sync.intervalSeconds ?? CLIPROXY_SYNC_DEFAULT_INTERVAL_SECONDS),
    };
    return resolved;
  });

  const requireRole = (role: CliProxySyncConfig["role"]) =>
    resolve.pipe(
      Effect.filterOrFail(
        (resolved) => resolved.role === role,
        (resolved) =>
          new CliProxySyncNotConfigured({
            message: `cliproxy.sync.role is '${resolved.role}', this needs '${role}'`,
          }),
      ),
    );

  const listLocal = Effect.gen(function* () {
    const exists = yield* fs.exists(authsDir).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return [] as Array<SyncStamp>;
    const names = yield* fs.readDirectory(authsDir).pipe(Effect.mapError(ioError("read auths")));
    return yield* Effect.forEach(names.filter(isAuthFileName), (name) =>
      fs.stat(path.join(authsDir, name)).pipe(
        Effect.map(
          (info): SyncStamp => ({
            id: name,
            updatedAt: Option.match(info.mtime, {
              onNone: () => EPOCH_ISO,
              onSome: (date) => date.toISOString(),
            }),
          }),
        ),
        Effect.mapError(ioError(`stat ${name}`)),
      ),
    );
  });

  const readEntry = (key: SyncKey, stamp: SyncStamp) =>
    fs.readFile(path.join(authsDir, stamp.id)).pipe(
      Effect.mapError(ioError(`read ${stamp.id}`)),
      Effect.flatMap((bytes) => encryptSyncEntry(key, bytes)),
      Effect.mapError((error) =>
        error._tag === "CliProxySyncCryptoError"
          ? new CliProxySyncFailedError({ reason: "crypto", message: error.message })
          : error,
      ),
      Effect.map((ciphertext): CliProxySyncEntry => ({ ...stamp, ciphertext })),
    );

  // Temp file without the `.json` suffix so the sidecar's watcher never sees a
  // half-written credential; the mtime is set to the entry's stamp so the next
  // comparison is exact on both sides.
  const writeEntry = (id: string, bytes: Uint8Array, updatedAt: string) =>
    Effect.gen(function* () {
      const target = path.join(authsDir, id);
      const temp = path.join(authsDir, `.sync-${id}.tmp`);
      // Numeric `utimes` arguments are seconds; the stamp keeps millisecond precision.
      const stampSeconds = Date.parse(updatedAt) / 1000;
      yield* fs.makeDirectory(authsDir, { recursive: true });
      yield* fs.writeFile(temp, bytes, { mode: 0o600 });
      yield* fs.chmod(temp, 0o600);
      yield* fs.rename(temp, target);
      yield* fs.utimes(target, stampSeconds, stampSeconds);
    }).pipe(Effect.mapError(ioError(`write ${id}`)));

  const decryptAll = (key: SyncKey, entries: ReadonlyArray<CliProxySyncEntry>) =>
    Effect.forEach(entries, (entry) =>
      decryptSyncEntry(key, entry.ciphertext).pipe(
        Effect.map((bytes) => ({ entry, bytes })),
        Effect.mapError(
          (error) =>
            new CliProxySyncFailedError({
              reason: "crypto",
              message: `${entry.id}: ${error.message}`,
            }),
        ),
      ),
    );

  const exportBundle = Effect.gen(function* () {
    const resolved = yield* requireRole("primary");
    const local = yield* listLocal;
    const entries = yield* Effect.forEach(local, (stamp) => readEntry(resolved.key, stamp));
    const primaryEnvironmentId = yield* identity.getEnvironmentId;
    return {
      version: 1,
      generatedAt: yield* nowIso,
      primaryEnvironmentId,
      entries,
    } satisfies CliProxySyncBundle;
  });

  const applyPush = (entries: ReadonlyArray<CliProxySyncEntry>) =>
    Effect.gen(function* () {
      const resolved = yield* requireRole("primary");
      const decrypted = yield* decryptAll(resolved.key, entries);
      const local = yield* listLocal;
      const plan = planSyncMerge(local, entries);
      const pull = new Set(plan.pull);
      const written: Array<string> = [];
      const skipped: Array<string> = [];
      for (const { entry, bytes } of decrypted) {
        if (pull.has(entry.id)) {
          yield* writeEntry(entry.id, bytes, entry.updatedAt);
          written.push(entry.id);
        } else {
          skipped.push(entry.id);
        }
      }
      return { written, skipped } satisfies CliProxySyncPushResult;
    });

  const status = Effect.gen(function* () {
    const sync = yield* section;
    const last = yield* Ref.get(lastSyncRef);
    return {
      role: sync?.role ?? "standalone",
      ...(sync?.primaryUrl !== undefined ? { primaryUrl: trimOrigin(sync.primaryUrl) } : {}),
      ...(sync !== undefined
        ? { intervalSeconds: sync.intervalSeconds ?? CLIPROXY_SYNC_DEFAULT_INTERVAL_SECONDS }
        : {}),
      ...(last.at !== undefined ? { lastSyncAt: last.at } : {}),
      ...(last.error !== undefined ? { lastSyncError: last.error } : {}),
    } satisfies CliProxySyncStatus;
  });

  const publishStatus = status.pipe(
    Effect.flatMap((current) => PubSub.publish(changesPubSub, current)),
  );

  const syncNow = cycleLock.withPermits(1)(
    Effect.gen(function* () {
      const resolved = yield* requireRole("replica");
      if (resolved.primaryUrl === undefined || resolved.token === undefined) {
        return yield* new CliProxySyncNotConfigured({
          message: `replica needs cliproxy.sync.primaryUrl and ${SYNC_TOKEN_ENV}`,
        });
      }
      const target = { primaryUrl: resolved.primaryUrl, token: resolved.token };
      const bundle = yield* transport.fetchExport(target);
      const local = yield* listLocal;
      const plan = planSyncMerge(local, bundle.entries);
      const remoteById = new Map(bundle.entries.map((entry) => [entry.id, entry]));
      const pulled = yield* decryptAll(
        resolved.key,
        plan.pull.flatMap((id) => {
          const entry = remoteById.get(id);
          return entry === undefined ? [] : [entry];
        }),
      );
      for (const { entry, bytes } of pulled) {
        yield* writeEntry(entry.id, bytes, entry.updatedAt);
      }
      const localById = new Map(local.map((stamp) => [stamp.id, stamp]));
      const pushes = yield* Effect.forEach(
        plan.push.flatMap((id) => {
          const stamp = localById.get(id);
          return stamp === undefined ? [] : [stamp];
        }),
        (stamp) => readEntry(resolved.key, stamp),
      );
      if (pushes.length > 0) {
        yield* transport.push({ ...target, entries: pushes });
      }
      yield* Ref.set(lastSyncRef, { at: yield* nowIso });
      yield* Effect.logInfo("cliproxy sync: cycle complete", {
        pulled: pulled.length,
        pushed: pushes.length,
      });
    }).pipe(
      Effect.tapError((error) =>
        Ref.update(lastSyncRef, (last) => ({ ...last, error: error.message })),
      ),
      Effect.ensuring(publishStatus),
    ),
  );

  const loop = Effect.gen(function* () {
    const resolved = yield* resolve;
    if (resolved.role !== "replica") return;
    yield* ticker(resolved.interval).pipe(
      Stream.runForEach(() =>
        syncNow.pipe(
          Effect.catch((error) =>
            Effect.logWarning("cliproxy sync: cycle failed", { cause: error.message }),
          ),
        ),
      ),
    );
  }).pipe(
    Effect.catchTag("CliProxySyncNotConfigured", (error) =>
      Effect.logInfo("cliproxy sync: idle", { cause: error.message }),
    ),
  );

  const start = Effect.gen(function* () {
    if (Option.isSome(yield* Ref.get(loopRef))) return;
    const fiber = yield* loop.pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(runScope));
    yield* Ref.set(loopRef, Option.some(fiber));
  });

  const stop = Effect.gen(function* () {
    const fiber = yield* Ref.getAndSet(loopRef, Option.none());
    if (Option.isSome(fiber)) yield* Fiber.interrupt(fiber.value);
  });

  const apply = (values: { readonly cliproxy: boolean }) =>
    lifecycle.withPermits(1)(values.cliproxy ? start : stop);

  yield* apply(yield* flags.current);
  yield* flags.changes.pipe(
    Stream.runForEach(apply),
    Effect.ignoreCause({ log: true }),
    Effect.forkIn(runScope),
  );

  return CliProxySyncService.of({
    status,
    changes: Stream.fromPubSub(changesPubSub),
    exportBundle,
    applyPush,
    syncNow,
  });
});

const transportError = (message: string) => (cause: unknown) =>
  new CliProxySyncFailedError({
    reason: "transport",
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

/** Plain bearer HTTP against the primary's environment origin. Loopback or tailnet; no TLS assumed. */
export const transportLayer = Layer.succeed(
  CliProxySyncTransport,
  CliProxySyncTransport.of({
    fetchExport: (input) =>
      HttpClient.HttpClient.pipe(
        Effect.flatMap((client) =>
          client.get(`${input.primaryUrl}${CLIPROXY_API_PATHS.syncExport}`, {
            headers: { Authorization: `Bearer ${input.token}` },
          }),
        ),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(CliProxySyncBundle)),
        Effect.mapError(transportError("sync export")),
        Effect.provide(FetchHttpClient.layer),
      ),
    push: (input) =>
      HttpClient.HttpClient.pipe(
        Effect.flatMap((client) =>
          client.execute(
            HttpClientRequest.post(`${input.primaryUrl}${CLIPROXY_API_PATHS.syncPush}`, {
              headers: {
                Authorization: `Bearer ${input.token}`,
                "content-type": "application/json",
              },
            }).pipe(HttpClientRequest.bodyText(JSON.stringify({ entries: input.entries }))),
          ),
        ),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(CliProxySyncPushResult)),
        Effect.mapError(transportError("sync push")),
        Effect.provide(FetchHttpClient.layer),
      ),
  }),
);

/** Production wiring. Needs ServerConfig, ForkFlagsService, ServerSecretStore, ServerEnvironmentIdentity, and the Node services. */
export const layer = Layer.effect(CliProxySyncService, make).pipe(Layer.provide(transportLayer));

/** The service body alone; tests supply the transport and ticker. */
export const layerWithoutRuntime = Layer.effect(CliProxySyncService, make);

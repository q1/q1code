import * as NodeServices from "@effect/platform-node/NodeServices";
import { CliProxySyncFailedError, type CliProxySyncEntry } from "@q1code/core/cliproxyApi";
import { DEFAULT_FORK_FLAGS, type ForkFlagValues } from "@q1code/core/flags";
import type { ForkConfig } from "@q1code/core/config";
import { EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { ForkFlagsEnvironment, ForkFlagsService } from "../ForkFlags.ts";
import { cliproxyDirectories } from "./CliProxyConfig.ts";
import { deriveSyncKey, encryptSyncEntry } from "./CliProxySyncCrypto.ts";
import {
  CliProxySyncService,
  CliProxySyncTicker,
  CliProxySyncTransport,
  layerWithoutRuntime,
  planSyncMerge,
  pruneSyncTombstones,
  SYNC_TOMBSTONE_TTL_MILLIS,
} from "./CliProxySync.ts";

const T0 = "2026-09-02T10:00:00.000Z";
const T1 = "2026-09-02T11:00:00.000Z";
const T2 = "2026-09-02T12:00:00.000Z";
const T3 = "2026-09-02T13:00:00.000Z";

it("planSyncMerge pulls newer or missing remote files and pushes newer or missing local ones", () => {
  const plan = planSyncMerge(
    {
      files: [
        { id: "same.json", updatedAt: T1 },
        { id: "local-newer.json", updatedAt: T2 },
        { id: "remote-newer.json", updatedAt: T0 },
        { id: "local-only.json", updatedAt: T0 },
      ],
    },
    {
      files: [
        { id: "same.json", updatedAt: T1 },
        { id: "local-newer.json", updatedAt: T1 },
        { id: "remote-newer.json", updatedAt: T1 },
        { id: "remote-only.json", updatedAt: T0 },
      ],
    },
  );
  assert.deepEqual([...plan.pull].sort(), ["remote-newer.json", "remote-only.json"]);
  assert.deepEqual([...plan.push].sort(), ["local-newer.json", "local-only.json"]);
  assert.deepEqual(plan.deleteLocal, []);
  assert.deepEqual(plan.deleteRemote, []);
  assert.deepEqual(plan.tombstones, []);
});

it("planSyncMerge treats an unparseable stamp as older than everything", () => {
  const plan = planSyncMerge(
    { files: [{ id: "a.json", updatedAt: "garbage" }] },
    { files: [{ id: "a.json", updatedAt: T0 }] },
  );
  assert.deepEqual(plan, {
    pull: ["a.json"],
    push: [],
    deleteLocal: [],
    deleteRemote: [],
    tombstones: [],
  });
});

it("planSyncMerge lets a tombstone bury files on both sides unless a newer file beats it", () => {
  const plan = planSyncMerge(
    {
      files: [
        { id: "remote-deleted.json", updatedAt: T0 },
        { id: "local-deleted.json", updatedAt: T0 },
        { id: "recreated-here.json", updatedAt: T3 },
        { id: "kept.json", updatedAt: T1 },
      ],
      tombstones: [
        { id: "local-deleted.json", deletedAt: T1 },
        { id: "recreated-there.json", deletedAt: T1 },
        { id: "same-both.json", deletedAt: T0 },
      ],
    },
    {
      files: [
        { id: "local-deleted.json", updatedAt: T1 },
        { id: "recreated-there.json", updatedAt: T2 },
        { id: "kept.json", updatedAt: T0 },
      ],
      tombstones: [
        { id: "remote-deleted.json", deletedAt: T2 },
        { id: "recreated-here.json", deletedAt: T2 },
        { id: "same-both.json", deletedAt: T1 },
      ],
    },
  );
  // A file stamped at the tombstone's time is still buried; only strictly newer wins.
  assert.deepEqual(plan.deleteLocal, ["local-deleted.json", "remote-deleted.json"]);
  assert.deepEqual(plan.deleteRemote, ["local-deleted.json"]);
  assert.deepEqual(plan.tombstones, [
    { id: "local-deleted.json", deletedAt: T1 },
    { id: "remote-deleted.json", deletedAt: T2 },
    { id: "same-both.json", deletedAt: T1 },
  ]);
  assert.deepEqual([...plan.pull].sort(), ["recreated-there.json"]);
  assert.deepEqual([...plan.push].sort(), ["kept.json", "recreated-here.json"]);
});

it("pruneSyncTombstones drops tombstones older than the TTL", () => {
  const now = Date.parse(T2);
  const stale = DateTime.formatIso(DateTime.makeUnsafe(now - SYNC_TOMBSTONE_TTL_MILLIS - 1));
  const fresh = DateTime.formatIso(DateTime.makeUnsafe(now - SYNC_TOMBSTONE_TTL_MILLIS + 1));
  assert.deepEqual(
    pruneSyncTombstones(
      [
        { id: "stale.json", deletedAt: stale },
        { id: "fresh.json", deletedAt: fresh },
        { id: "garbage.json", deletedAt: "garbage" },
      ],
      now,
    ),
    [{ id: "fresh.json", deletedAt: fresh }],
  );
});

const flagsLayer = (config: ForkConfig, cliproxy = true) => {
  const values: ForkFlagValues = { ...DEFAULT_FORK_FLAGS, cliproxy };
  return Layer.succeed(
    ForkFlagsService,
    ForkFlagsService.of({
      current: Effect.succeed(values),
      reload: Effect.succeed(values),
      changes: Stream.empty,
      config: Effect.succeed(config),
      update: () => Effect.die("unexpected fork.json update"),
    }),
  );
};

const identityLayer = (id: string) =>
  Layer.succeed(
    ServerEnvironment.ServerEnvironmentIdentity,
    ServerEnvironment.ServerEnvironmentIdentity.of({
      getEnvironmentId: Effect.succeed(EnvironmentId.make(id)),
    }),
  );

/**
 * One sync service on its own temp base dir. `Layer.fresh` keeps two nodes
 * built in one test from sharing a memoized service instance.
 */
const makeNode = (input: {
  readonly id: string;
  readonly config: ForkConfig;
  readonly env: Record<string, string | undefined>;
  readonly transport: Layer.Layer<CliProxySyncTransport>;
  readonly ticker?: (interval: unknown) => Stream.Stream<unknown>;
}) =>
  Layer.fresh(layerWithoutRuntime).pipe(
    Layer.provide(flagsLayer(input.config)),
    Layer.provide(identityLayer(input.id)),
    Layer.provide(Layer.succeed(ForkFlagsEnvironment, input.env)),
    Layer.provide(input.transport),
    Layer.provide(
      input.ticker === undefined
        ? Layer.empty
        : Layer.succeed(CliProxySyncTicker, input.ticker as never),
    ),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: `q1code-sync-${input.id}-` })),
    ),
  );

const noTransport = Layer.succeed(
  CliProxySyncTransport,
  CliProxySyncTransport.of({
    fetchExport: () => Effect.die("unexpected fetchExport"),
    push: () => Effect.die("unexpected push"),
  }),
);

const writeAuth = (name: string, contents: string, at: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { baseDir } = yield* ServerConfig.ServerConfig;
    const { authsDir } = cliproxyDirectories(baseDir, path);
    yield* fs.makeDirectory(authsDir, { recursive: true });
    const file = path.join(authsDir, name);
    yield* fs.writeFileString(file, contents);
    yield* fs.utimes(file, Date.parse(at) / 1000, Date.parse(at) / 1000);
  });

const readTombstoneFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const { tombstonesPath } = cliproxyDirectories(baseDir, path);
  if (!(yield* fs.exists(tombstonesPath))) return null;
  // Inspected as raw wire JSON so the test sees exactly what is on disk.
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  return JSON.parse(yield* fs.readFileString(tombstonesPath)) as Record<string, string>;
});

const readAuths = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const { authsDir } = cliproxyDirectories(baseDir, path);
  const exists = yield* fs.exists(authsDir);
  if (!exists) return {} as Record<string, string>;
  const names = (yield* fs.readDirectory(authsDir)).filter((name) => name.endsWith(".json"));
  const entries = yield* Effect.forEach(names, (name) =>
    fs.readFileString(path.join(authsDir, name)).pipe(Effect.map((text) => [name, text] as const)),
  );
  return Object.fromEntries(entries);
});

const KEY = "shared-secret";

it.layer(NodeServices.layer, { excludeTestServices: true })("CliProxySync", (it) => {
  it.effect("primary exports encrypted entries and applies only newer pushes", () =>
    Effect.gen(function* () {
      const primary = makeNode({
        id: "primary",
        config: { cliproxy: { sync: { role: "primary" } } },
        env: { Q1CODE_CLIPROXY_SYNC_KEY: KEY },
        transport: noTransport,
      });
      yield* Effect.gen(function* () {
        const service = yield* CliProxySyncService;
        yield* writeAuth("a.json", '{"v":"a1"}', T1);
        yield* writeAuth("b.json", '{"v":"b1"}', T1);
        const bundle = yield* service.exportBundle;
        assert.equal(bundle.primaryEnvironmentId, "primary");
        assert.deepEqual(bundle.entries.map((entry) => [entry.id, entry.updatedAt]).sort(), [
          ["a.json", T1],
          ["b.json", T1],
        ]);
        assert.isFalse(bundle.entries.some((entry) => entry.ciphertext.includes("a1")));

        // Re-encrypt the exported entries under new stamps to simulate a replica push.
        const aOld = { ...bundle.entries.find((entry) => entry.id === "a.json")!, updatedAt: T0 };
        const bNew = { ...bundle.entries.find((entry) => entry.id === "b.json")!, updatedAt: T2 };
        const result = yield* service.applyPush([aOld, bNew]);
        assert.deepEqual(result, { written: ["b.json"], skipped: ["a.json"], deleted: [] });

        const rejected = yield* service
          .applyPush([{ id: "c.json", updatedAt: T2, ciphertext: "AAAA" }])
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(rejected));
        assert.deepEqual(Object.keys(yield* readAuths).sort(), ["a.json", "b.json"]);
      }).pipe(Effect.provide(primary));
    }),
  );

  it.effect("primary records, exports, and applies tombstones; a newer file wins over one", () =>
    Effect.gen(function* () {
      const primary = makeNode({
        id: "primary-tombstones",
        config: { cliproxy: { sync: { role: "primary" } } },
        env: { Q1CODE_CLIPROXY_SYNC_KEY: KEY },
        transport: noTransport,
      });
      yield* Effect.gen(function* () {
        const service = yield* CliProxySyncService;
        yield* writeAuth("old.json", '{"v":"old"}', T0);
        yield* writeAuth("refreshed.json", '{"v":"new"}', T3);
        yield* writeAuth("keep.json", '{"v":"keep"}', T1);

        // A deletion made here (the sidecar already removed the file).
        yield* service.recordTombstone("gone.json");
        const bundle = yield* service.exportBundle;
        assert.equal(bundle.version, 2);
        assert.deepEqual(
          bundle.tombstones?.map((tombstone) => tombstone.id),
          ["gone.json"],
        );
        const file = yield* readTombstoneFile;
        assert.deepEqual(Object.keys(file ?? {}), ["gone.json"]);

        // A replica push: bury `old.json` (older than the tombstone), fail to bury
        // `refreshed.json` (newer than its tombstone), bring `keep.json` along.
        const keep = bundle.entries.find((entry) => entry.id === "keep.json")!;
        const result = yield* service.applyPush(
          [keep],
          [
            { id: "old.json", deletedAt: T1 },
            { id: "refreshed.json", deletedAt: T2 },
          ],
        );
        assert.deepEqual(result, { written: [], skipped: ["keep.json"], deleted: ["old.json"] });
        assert.deepEqual(Object.keys(yield* readAuths).sort(), ["keep.json", "refreshed.json"]);
        assert.deepEqual(Object.keys((yield* readTombstoneFile) ?? {}).sort(), [
          "gone.json",
          "old.json",
        ]);
      }).pipe(Effect.provide(primary));
    }),
  );

  it.effect("reads the shared key from the secret store before the environment", () =>
    Effect.gen(function* () {
      // Default secret name, no env: the store alone configures the primary.
      const stored = makeNode({
        id: "stored-key",
        config: { cliproxy: { sync: { role: "primary" } } },
        env: {},
        transport: noTransport,
      });
      yield* Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        yield* secrets.set("cliproxy-sync-key", new TextEncoder().encode(`${KEY}\n`));
        const service = yield* CliProxySyncService;
        yield* writeAuth("a.json", '{"v":"a"}', T1);
        const bundle = yield* service.exportBundle;
        assert.equal(bundle.entries.length, 1);
      }).pipe(Effect.provide(stored));

      // A configured name beats the default, and the store beats the env var:
      // an entry encrypted under the env key must not decrypt.
      const named = makeNode({
        id: "named-key",
        config: { cliproxy: { sync: { role: "primary", sharedKeySecretName: "my-key" } } },
        env: { Q1CODE_CLIPROXY_SYNC_KEY: "env-key" },
        transport: noTransport,
      });
      yield* Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        yield* secrets.set("my-key", new TextEncoder().encode("store-key"));
        const service = yield* CliProxySyncService;
        yield* writeAuth("a.json", '{"v":"a"}', T1);
        const entry = (yield* service.exportBundle).entries[0]!;
        const underEnvKey = yield* encryptSyncEntry(
          deriveSyncKey("env-key"),
          new TextEncoder().encode('{"v":"b"}'),
        );
        const rejected = yield* service
          .applyPush([{ ...entry, updatedAt: T2, ciphertext: underEnvKey }])
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(rejected));
        const underStoreKey = yield* encryptSyncEntry(
          deriveSyncKey("store-key"),
          new TextEncoder().encode('{"v":"b"}'),
        );
        const accepted = yield* service.applyPush([
          { ...entry, updatedAt: T2, ciphertext: underStoreKey },
        ]);
        assert.deepEqual(accepted.written, ["a.json"]);
      }).pipe(Effect.provide(named));
    }),
  );

  it.effect("refuses to export without a shared key or when the role is replica", () =>
    Effect.gen(function* () {
      const noKey = makeNode({
        id: "nokey",
        config: { cliproxy: { sync: { role: "primary" } } },
        env: {},
        transport: noTransport,
      });
      yield* Effect.gen(function* () {
        const service = yield* CliProxySyncService;
        const exit = yield* service.exportBundle.pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        assert.equal((yield* service.status).role, "primary");
      }).pipe(Effect.provide(noKey));

      const replica = makeNode({
        id: "replica-export",
        config: { cliproxy: { sync: { role: "replica", primaryUrl: "http://primary:1/" } } },
        env: { Q1CODE_CLIPROXY_SYNC_KEY: KEY, Q1CODE_CLIPROXY_SYNC_TOKEN: "t" },
        transport: noTransport,
      });
      yield* Effect.gen(function* () {
        const service = yield* CliProxySyncService;
        const exit = yield* service.exportBundle.pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        const status = yield* service.status;
        assert.equal(status.primaryUrl, "http://primary:1");
        assert.equal(status.intervalSeconds, 300);
      }).pipe(Effect.provide(replica));
    }),
  );

  it.effect(
    "replica loop pulls newer files, pushes back newer local ones, and reports status",
    () =>
      Effect.gen(function* () {
        const ticks = yield* Queue.unbounded<void>();
        const pushes: Array<ReadonlyArray<CliProxySyncEntry>> = [];
        const primaryReady = yield* Deferred.make<CliProxySyncService["Service"]>();

        // The replica's transport talks to the primary service directly.
        const transport = Layer.succeed(
          CliProxySyncTransport,
          CliProxySyncTransport.of({
            fetchExport: () =>
              Deferred.await(primaryReady).pipe(
                Effect.flatMap((primary) => primary.exportBundle),
                Effect.orDie,
              ),
            push: ({ entries, tombstones }) =>
              Deferred.await(primaryReady).pipe(
                Effect.flatMap((primary) => {
                  pushes.push(entries);
                  return primary.applyPush(entries, tombstones);
                }),
                Effect.orDie,
              ),
          }),
        );

        const primary = makeNode({
          id: "primary",
          config: { cliproxy: { sync: { role: "primary" } } },
          env: { Q1CODE_CLIPROXY_SYNC_KEY: KEY },
          transport: noTransport,
        });
        const replica = makeNode({
          id: "replica",
          config: {
            cliproxy: {
              sync: { role: "replica", primaryUrl: "http://primary", intervalSeconds: 5 },
            },
          },
          env: { Q1CODE_CLIPROXY_SYNC_KEY: KEY, Q1CODE_CLIPROXY_SYNC_TOKEN: "token" },
          transport,
          ticker: () => Stream.fromQueue(ticks),
        });

        yield* Effect.gen(function* () {
          const primaryService = yield* CliProxySyncService;
          yield* writeAuth("shared.json", '{"v":"primary-old"}', T0);
          yield* writeAuth("primary-only.json", '{"v":"p"}', T1);
          yield* writeAuth("deleted-on-replica.json", '{"v":"d"}', T0);
          // Deleted on the primary; the replica still holds an older copy.
          yield* primaryService.recordTombstone("deleted-on-primary.json");
          yield* Deferred.succeed(primaryReady, primaryService);

          yield* Effect.gen(function* () {
            const replicaService = yield* CliProxySyncService;
            yield* writeAuth("shared.json", '{"v":"replica-new"}', T2);
            yield* writeAuth("replica-only.json", '{"v":"r"}', T1);
            yield* writeAuth("deleted-on-primary.json", '{"v":"stale"}', T0);
            yield* replicaService.recordTombstone("deleted-on-replica.json");

            // Each tick runs one cycle; subscribe to `changes` before offering the
            // tick so the completion cannot be missed, then await it.
            const awaitCycle = Effect.gen(function* () {
              const done = yield* replicaService.changes.pipe(
                Stream.take(1),
                Stream.runCollect,
                Effect.forkChild,
              );
              yield* Effect.yieldNow;
              yield* Queue.offer(ticks, undefined);
              yield* Fiber.join(done);
            });

            yield* awaitCycle;
            const replicaFiles = yield* readAuths;
            assert.equal(replicaFiles["primary-only.json"], '{"v":"p"}');
            assert.equal(replicaFiles["shared.json"], '{"v":"replica-new"}');
            assert.isUndefined(replicaFiles["deleted-on-primary.json"]);
            assert.isUndefined(replicaFiles["deleted-on-replica.json"]);
            assert.deepEqual(Object.keys((yield* readTombstoneFile) ?? {}).sort(), [
              "deleted-on-primary.json",
              "deleted-on-replica.json",
            ]);
            assert.equal(pushes.length, 1);
            assert.deepEqual(pushes[0]!.map((entry) => entry.id).sort(), [
              "replica-only.json",
              "shared.json",
            ]);
            const status = yield* replicaService.status;
            assert.equal(status.role, "replica");
            assert.isUndefined(status.lastSyncError);

            // A second cycle with nothing new moves no files.
            yield* awaitCycle;
            assert.equal(pushes.length, 1);
          }).pipe(Effect.provide(replica));

          const primaryFiles = yield* readAuths;
          assert.equal(primaryFiles["shared.json"], '{"v":"replica-new"}');
          assert.equal(primaryFiles["replica-only.json"], '{"v":"r"}');
          assert.equal(primaryFiles["primary-only.json"], '{"v":"p"}');
          assert.isUndefined(primaryFiles["deleted-on-replica.json"]);
          assert.deepEqual(Object.keys((yield* readTombstoneFile) ?? {}).sort(), [
            "deleted-on-primary.json",
            "deleted-on-replica.json",
          ]);
        }).pipe(Effect.provide(primary));
      }),
  );

  it.effect("replica records the failure when the primary is unreachable", () =>
    Effect.gen(function* () {
      const failing = Layer.succeed(
        CliProxySyncTransport,
        CliProxySyncTransport.of({
          fetchExport: () =>
            Effect.fail(
              new CliProxySyncFailedError({ reason: "transport", message: "connection refused" }),
            ),
          push: () => Effect.die("unexpected push"),
        }),
      );
      const replica = makeNode({
        id: "replica-fail",
        config: { cliproxy: { sync: { role: "replica", primaryUrl: "http://primary" } } },
        env: { Q1CODE_CLIPROXY_SYNC_KEY: KEY, Q1CODE_CLIPROXY_SYNC_TOKEN: "token" },
        transport: failing,
        ticker: () => Stream.empty,
      });
      yield* Effect.gen(function* () {
        const service = yield* CliProxySyncService;
        const exit = yield* service.syncNow.pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        assert.equal((yield* service.status).lastSyncError, "connection refused");
      }).pipe(Effect.provide(replica));
    }),
  );
});

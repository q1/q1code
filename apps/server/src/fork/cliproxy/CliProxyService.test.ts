import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_FORK_FLAGS, type ForkFlagValues } from "@q1code/core/flags";
import type { CliProxyExternalConfig, ForkConfig } from "@q1code/core/config";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { ForkFlagsService } from "../ForkFlags.ts";
import { CliProxyBinary } from "./CliProxyBinary.ts";
import { cliproxyDirectories } from "./CliProxyConfig.ts";
import { currentCliProxyEndpoint } from "./CliProxyEnvironment.ts";
import {
  type CliProxyChild,
  CliProxyHealthInterval,
  CliProxyLauncher,
  CliProxyNotReady,
  CliProxyProbeFailed,
  CliProxyReadiness,
  CliProxyRestartSchedule,
  CliProxyService,
  type CliProxyStatus,
  layerWithoutRuntime,
  parseCliProxyBaseUrl,
  redactSecrets,
} from "./CliProxyService.ts";

interface FakeLaunch {
  readonly pid: number;
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly exit: Deferred.Deferred<number>;
  killed: boolean;
}

/** A ForkFlagsService whose `changes` the test drives through `set`. */
const makeFlags = (initial: boolean, config: ForkConfig = {}) => {
  let current: ForkFlagValues = { ...DEFAULT_FORK_FLAGS, cliproxy: initial };
  let publish: (values: ForkFlagValues) => Effect.Effect<void> = () => Effect.void;
  const layer = Layer.effect(
    ForkFlagsService,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<ForkFlagValues>();
      publish = (values) => PubSub.publish(pubsub, values).pipe(Effect.asVoid);
      return ForkFlagsService.of({
        current: Effect.sync(() => current),
        reload: Effect.sync(() => current),
        changes: Stream.fromPubSub(pubsub),
        config: Effect.succeed(config),
        update: () => Effect.die("unexpected fork.json update"),
      });
    }),
  );
  const set = (cliproxy: boolean) =>
    Effect.suspend(() => {
      current = { ...current, cliproxy };
      return publish(current);
    });
  return { layer, set };
};

const makeHarness = (options: {
  readonly flag: boolean;
  readonly config?: ForkConfig;
  /** Consumed one per readiness call; `Effect.void` once exhausted. */
  readonly readiness?: Array<Effect.Effect<void, CliProxyNotReady>>;
  /** Consumed one per external probe; `Effect.void` once exhausted. */
  readonly probes?: Array<Effect.Effect<void, CliProxyProbeFailed>>;
  /** Stored before the service starts, as external mode expects. */
  readonly secrets?: Record<string, string>;
  readonly output?: ReadonlyArray<string>;
}) => {
  const launches: Array<FakeLaunch> = [];
  const probeInputs: Array<{ baseUrl: string; managementSecret: string }> = [];
  const flags = makeFlags(options.flag, options.config);
  const readinessScript = [...(options.readiness ?? [])];
  const probeScript = [...(options.probes ?? [])];
  const launcher = Layer.succeed(
    CliProxyLauncher,
    CliProxyLauncher.of({
      launch: (input) =>
        Effect.gen(function* () {
          const exit = yield* Deferred.make<number>();
          const record: FakeLaunch = {
            pid: 1000 + launches.length,
            binaryPath: input.binaryPath,
            args: input.args,
            exit,
            killed: false,
          };
          launches.push(record);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              record.killed = true;
            }).pipe(Effect.andThen(Deferred.succeed(exit, 143)), Effect.asVoid),
          );
          return {
            pid: record.pid,
            output: Stream.fromIterable(options.output ?? []),
            exit: Deferred.await(exit),
          } satisfies CliProxyChild;
        }),
    }),
  );
  const readiness = Layer.succeed(
    CliProxyReadiness,
    CliProxyReadiness.of({
      awaitReady: () => readinessScript.shift() ?? Effect.void,
      probe: (input) =>
        Effect.suspend(() => {
          probeInputs.push(input);
          return probeScript.shift() ?? Effect.void;
        }),
    }),
  );
  const seededSecrets = Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* ServerSecretStore.ServerSecretStore;
      for (const [name, value] of Object.entries(options.secrets ?? {})) {
        yield* store.set(name, new TextEncoder().encode(value));
      }
    }),
  );
  const binary = Layer.succeed(
    CliProxyBinary,
    CliProxyBinary.of({
      resolve: () =>
        Effect.succeed({ path: "/fake/cli-proxy-api", version: "7.2.147", source: "override" }),
    }),
  );
  const layer = layerWithoutRuntime.pipe(
    Layer.provide(seededSecrets),
    Layer.provide(flags.layer),
    Layer.provide(binary),
    Layer.provide(launcher),
    Layer.provide(readiness),
    Layer.provide(Layer.succeed(CliProxyRestartSchedule, Schedule.recurs(5))),
    Layer.provide(Layer.succeed(CliProxyHealthInterval, Duration.millis(10))),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "q1code-cliproxy-service-" })),
    ),
  );
  return { layer, launches, probeInputs, setFlag: flags.set };
};

const isIsoTimestamp = (value: string | undefined) =>
  value !== undefined && Number.isFinite(Date.parse(value));

const EXTERNAL_BASE_URL = "http://127.0.0.1:9317";
const EXTERNAL_SECRETS = {
  "cliproxy-management-secret": "mgmt-secret\n",
  "cliproxy-api-key": "client-key",
};
const externalConfig = (external: CliProxyExternalConfig | undefined): ForkConfig => ({
  cliproxy: { mode: "external", ...(external === undefined ? {} : { external }) },
});

const awaitStatus = (
  service: CliProxyService["Service"],
  predicate: (status: CliProxyStatus) => boolean,
) =>
  Effect.gen(function* () {
    const now = yield* service.status;
    if (predicate(now)) return now;
    const [next] = yield* service.changes.pipe(
      Stream.filter(predicate),
      Stream.take(1),
      Stream.runCollect,
    );
    return next!;
  });

/**
 * Fork an `awaitStatus` and let the child run up to its PubSub subscription
 * before returning, so a transition triggered right after cannot be missed.
 */
const subscribeStatus = (
  service: CliProxyService["Service"],
  predicate: (status: CliProxyStatus) => boolean,
) =>
  awaitStatus(service, predicate).pipe(
    Effect.forkChild,
    Effect.tap(() => Effect.yieldNow),
  );

const readApiKey = Effect.fn("test.readApiKey")(function* (configPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(configPath);
  const match = /^ {2}- "([^"]+)"$/m.exec(text);
  return { text, apiKey: match?.[1] };
});

it("redacts every secret it is given", () => {
  assert.equal(
    redactSecrets("key=abc token=xyz", ["abc", "xyz", ""]),
    "key=[redacted] token=[redacted]",
  );
});

it("parses an external base URL as a bare http(s) origin with its effective port", () => {
  assert.deepEqual(parseCliProxyBaseUrl(" http://127.0.0.1:8317/ "), {
    baseUrl: "http://127.0.0.1:8317",
    port: 8317,
  });
  assert.deepEqual(parseCliProxyBaseUrl("https://proxy.internal"), {
    baseUrl: "https://proxy.internal",
    port: 443,
  });
  assert.deepEqual(parseCliProxyBaseUrl("http://proxy"), { baseUrl: "http://proxy", port: 80 });
  for (const bad of [
    "127.0.0.1:8317",
    "http://127.0.0.1:8317/v1",
    "http://127.0.0.1:8317?x=1",
    "http://user:pw@127.0.0.1:8317",
    "ws://127.0.0.1:8317",
    "",
  ]) {
    assert.isUndefined(parseCliProxyBaseUrl(bad), bad);
  }
});

// Restarts go through `Effect.retry`, which sleeps on the clock even for a zero
// delay; the schedule here has no delay, so run against the live clock.
it.layer(NodeServices.layer, { excludeTestServices: true })("CliProxyService", (it) => {
  it.effect("spawns nothing and writes nothing while the flag is off", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ flag: false });
      yield* Effect.gen(function* () {
        const service = yield* CliProxyService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { baseDir } = yield* ServerConfig.ServerConfig;
        assert.equal((yield* service.status).state, "off");
        assert.isTrue(Option.isNone(yield* service.endpoint));
        assert.equal(currentCliProxyEndpoint(), undefined);
        assert.isFalse(yield* fs.exists(cliproxyDirectories(baseDir, path).rootDir));
        const request = yield* service.management.request("/latest-version").pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(request));
      }).pipe(Effect.provide(harness.layer));
      assert.deepEqual(harness.launches, []);
    }),
  );

  it.effect("starts the sidecar, waits for readiness, and publishes the endpoint", () =>
    Effect.gen(function* () {
      const gate = Deferred.makeUnsafe<void>();
      const harness = makeHarness({
        flag: true,
        config: { cliproxy: { port: 9123, routingStrategy: "fill-first" } },
        readiness: [Deferred.await(gate)],
      });
      yield* Effect.gen(function* () {
        const service = yield* CliProxyService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { baseDir } = yield* ServerConfig.ServerConfig;
        const directories = cliproxyDirectories(baseDir, path);

        const starting = yield* awaitStatus(
          service,
          (s) => s.state === "starting" && s.pid !== undefined,
        );
        assert.equal(starting.port, 9123);
        assert.equal(starting.version, "7.2.147");
        assert.equal(starting.mode, "sidecar");
        assert.equal(starting.restarts, 0);
        assert.isUndefined(starting.baseUrl);
        assert.isTrue(isIsoTimestamp(starting.since));
        assert.equal(harness.launches.length, 1);
        assert.deepEqual(harness.launches[0]?.args, ["-config", directories.configPath]);
        assert.equal(harness.launches[0]?.binaryPath, "/fake/cli-proxy-api");
        assert.isTrue(Option.isNone(yield* service.endpoint));

        const config = yield* readApiKey(directories.configPath);
        assert.include(config.text, "\nport: 9123\n");
        assert.include(config.text, '\n  strategy: "fill-first"\n');
        assert.include(config.text, `\nauth-dir: "${directories.authsDir}"\n`);
        assert.equal((yield* fs.stat(directories.configPath)).mode & 0o777, 0o600);
        assert.equal((yield* fs.stat(directories.rootDir)).mode & 0o777, 0o700);
        assert.equal((yield* fs.stat(directories.authsDir)).mode & 0o777, 0o700);
        assert.isString(config.apiKey);

        const ready = yield* subscribeStatus(service, (s) => s.state === "ready");
        yield* Deferred.succeed(gate, undefined);
        const status = yield* Fiber.join(ready);
        assert.equal(status.pid, harness.launches[0]?.pid);
        assert.equal(status.baseUrl, "http://127.0.0.1:9123");
        assert.isUndefined(status.lastError);
        const endpoint = yield* service.endpoint;
        assert.deepEqual(
          endpoint,
          Option.some({ baseUrl: "http://127.0.0.1:9123", apiKey: config.apiKey! }),
        );
        assert.deepEqual(currentCliProxyEndpoint(), Option.getOrUndefined(endpoint));
        assert.equal(service.codexProxyHomePath, directories.codexHomeDir);
        const codexConfig = yield* fs.readFileString(
          path.join(directories.codexHomeDir, "config.toml"),
        );
        assert.include(codexConfig, 'base_url = "http://127.0.0.1:9123/v1"');
        assert.include(codexConfig, `Bearer ${config.apiKey}`);
      }).pipe(Effect.provide(harness.layer));
      // Layer teardown killed the child and unpublished the endpoint.
      assert.isTrue(harness.launches[0]?.killed);
      assert.equal(currentCliProxyEndpoint(), undefined);
    }),
  );

  it.effect("restarts after the child exits and after a failed readiness probe", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        flag: true,
        readiness: [Effect.fail(new CliProxyNotReady({ port: 8317, stage: "tcp" }))],
      });
      yield* Effect.gen(function* () {
        const service = yield* CliProxyService;
        // Attempt 1 fails readiness; attempt 2 is ready.
        const ready = yield* awaitStatus(service, (s) => s.state === "ready" && s.pid === 1001);
        assert.equal(harness.launches.length, 2);
        assert.isTrue(harness.launches[0]?.killed);
        assert.equal(ready.pid, 1001);
        assert.equal(ready.restarts, 1);
        // The failed first attempt is remembered until the proxy is ready.
        assert.isUndefined(ready.lastError);

        const failed = yield* subscribeStatus(service, (s) => s.state === "failed");
        yield* Deferred.succeed(harness.launches[1]!.exit, 2);
        const failure = yield* Fiber.join(failed);
        assert.include(failure.lastError, "exited with code 2");
        assert.equal(failure.pid, undefined);
        assert.isUndefined(failure.baseUrl);
        assert.isTrue(Option.isNone(yield* service.endpoint));

        const again = yield* awaitStatus(service, (s) => s.state === "ready" && s.pid === 1002);
        assert.equal(again.pid, 1002);
        assert.equal(again.restarts, 2);
        assert.equal(harness.launches.length, 3);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("stops on flag off, clears the endpoint, and starts again on flag on", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ flag: true });
      yield* Effect.gen(function* () {
        const service = yield* CliProxyService;
        yield* awaitStatus(service, (s) => s.state === "ready");
        assert.isDefined(currentCliProxyEndpoint());

        const off = yield* subscribeStatus(service, (s) => s.state === "off");
        yield* harness.setFlag(false);
        yield* Fiber.join(off);
        assert.isTrue(harness.launches[0]?.killed);
        assert.isTrue(Option.isNone(yield* service.endpoint));
        assert.equal(currentCliProxyEndpoint(), undefined);
        assert.equal(harness.launches.length, 1);

        const ready = yield* subscribeStatus(service, (s) => s.state === "ready" && s.pid === 1001);
        yield* harness.setFlag(true);
        yield* Fiber.join(ready);
        assert.equal(harness.launches.length, 2);
        assert.isFalse(harness.launches[1]?.killed);
      }).pipe(Effect.provide(harness.layer));
      assert.isTrue(harness.launches[1]?.killed);
    }),
  );
  it.effect("restart respawns the sidecar now and counts it", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ flag: true });
      yield* Effect.gen(function* () {
        const service = yield* CliProxyService;
        const first = yield* awaitStatus(service, (s) => s.state === "ready");
        assert.equal(first.pid, 1000);
        assert.equal(first.restarts, 0);

        const status = yield* service.restart;
        assert.equal(status.state, "ready");
        assert.equal(status.pid, 1001);
        assert.equal(status.restarts, 1);
        assert.isTrue(isIsoTimestamp(status.since));
        assert.isTrue(harness.launches[0]?.killed);
        assert.equal(harness.launches.length, 2);
        assert.isFalse(harness.launches[1]?.killed);
        assert.deepEqual(yield* service.status, status);
        assert.isDefined(currentCliProxyEndpoint());
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("external mode probes the configured proxy and publishes it without spawning", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        flag: true,
        config: externalConfig({ baseUrl: `${EXTERNAL_BASE_URL}/` }),
        secrets: EXTERNAL_SECRETS,
      });
      yield* Effect.gen(function* () {
        const service = yield* CliProxyService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { baseDir } = yield* ServerConfig.ServerConfig;
        const directories = cliproxyDirectories(baseDir, path);

        const ready = yield* awaitStatus(service, (s) => s.state === "ready");
        assert.equal(ready.mode, "external");
        assert.equal(ready.port, 9317);
        assert.equal(ready.baseUrl, EXTERNAL_BASE_URL);
        assert.equal(ready.restarts, 0);
        assert.isUndefined(ready.pid);
        assert.isUndefined(ready.version);
        assert.isUndefined(ready.lastError);
        assert.isTrue(isIsoTimestamp(ready.since));
        assert.deepEqual(harness.probeInputs[0], {
          baseUrl: EXTERNAL_BASE_URL,
          managementSecret: "mgmt-secret",
        });

        const endpoint = yield* service.endpoint;
        assert.deepEqual(
          endpoint,
          Option.some({ baseUrl: EXTERNAL_BASE_URL, apiKey: "client-key" }),
        );
        assert.deepEqual(currentCliProxyEndpoint(), Option.getOrUndefined(endpoint));

        // Nothing of the sidecar's: no binary, no config.yaml, no managed auths dir.
        assert.deepEqual(harness.launches, []);
        assert.isFalse(yield* fs.exists(directories.configPath));
        assert.isFalse(yield* fs.exists(directories.authsDir));
        const codexConfig = yield* fs.readFileString(
          path.join(directories.codexHomeDir, "config.toml"),
        );
        assert.include(codexConfig, `base_url = "${EXTERNAL_BASE_URL}/v1"`);
        assert.include(codexConfig, "Bearer client-key");
      }).pipe(Effect.provide(harness.layer));
      assert.equal(currentCliProxyEndpoint(), undefined);
    }),
  );

  it.effect(
    "external mode fails with the secret hint until the secret is stored, then restarts",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          flag: true,
          config: externalConfig({ baseUrl: EXTERNAL_BASE_URL }),
          secrets: { "cliproxy-api-key": "client-key" },
        });
        yield* Effect.gen(function* () {
          const service = yield* CliProxyService;
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          const failed = yield* awaitStatus(service, (s) => s.state === "failed");
          assert.equal(
            failed.lastError,
            'secret "cliproxy-management-secret" is not set; store it with: q1code fork secret set cliproxy-management-secret',
          );
          assert.equal(failed.mode, "external");
          assert.isTrue(Option.isNone(yield* service.endpoint));
          assert.deepEqual(harness.probeInputs, []);

          yield* secrets.set("cliproxy-management-secret", new TextEncoder().encode("late"));
          const status = yield* service.restart;
          assert.equal(status.state, "ready");
          assert.isUndefined(status.lastError);
          assert.equal(harness.probeInputs.at(-1)?.managementSecret, "late");
          assert.isDefined(currentCliProxyEndpoint());
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect(
    "external mode drops to failed on a bad probe and reconnects on the next good one",
    () =>
      Effect.gen(function* () {
        const recover = Deferred.makeUnsafe<void>();
        const harness = makeHarness({
          flag: true,
          config: externalConfig({ baseUrl: EXTERNAL_BASE_URL }),
          secrets: EXTERNAL_SECRETS,
          probes: [
            Effect.void,
            Effect.fail(
              new CliProxyProbeFailed({
                baseUrl: EXTERNAL_BASE_URL,
                detail: "connect ECONNREFUSED",
              }),
            ),
            Deferred.await(recover),
          ],
        });
        yield* Effect.gen(function* () {
          const service = yield* CliProxyService;
          yield* awaitStatus(service, (s) => s.state === "ready");
          const failed = yield* awaitStatus(service, (s) => s.state === "failed");
          assert.include(failed.lastError, "connect ECONNREFUSED");
          assert.isUndefined(failed.baseUrl);
          assert.isTrue(Option.isNone(yield* service.endpoint));
          assert.equal(currentCliProxyEndpoint(), undefined);

          const ready = yield* subscribeStatus(service, (s) => s.state === "ready");
          yield* Deferred.succeed(recover, undefined);
          const again = yield* Fiber.join(ready);
          assert.equal(again.restarts, 1);
          assert.equal(again.baseUrl, EXTERNAL_BASE_URL);
          assert.isUndefined(again.lastError);
          assert.isDefined(currentCliProxyEndpoint());
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("external mode rejects a missing section or a base URL that is not an origin", () =>
    Effect.gen(function* () {
      const noSection = makeHarness({
        flag: true,
        config: externalConfig(undefined),
        secrets: EXTERNAL_SECRETS,
      });
      yield* Effect.gen(function* () {
        const service = yield* CliProxyService;
        const failed = yield* awaitStatus(service, (s) => s.state === "failed");
        assert.include(failed.lastError, "no cliproxy.external section");
      }).pipe(Effect.provide(noSection.layer));

      const badUrl = makeHarness({
        flag: true,
        config: externalConfig({ baseUrl: "127.0.0.1:8317/v1" }),
        secrets: EXTERNAL_SECRETS,
      });
      yield* Effect.gen(function* () {
        const service = yield* CliProxyService;
        const failed = yield* awaitStatus(service, (s) => s.state === "failed");
        assert.include(failed.lastError, "absolute http(s) origin");
        assert.include(failed.lastError, "127.0.0.1:8317/v1");
      }).pipe(Effect.provide(badUrl.layer));
      assert.deepEqual(badUrl.probeInputs, []);
    }),
  );

  it.effect("flag off in external mode stops the monitor and clears the endpoint", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        flag: true,
        config: externalConfig({ baseUrl: EXTERNAL_BASE_URL }),
        secrets: EXTERNAL_SECRETS,
      });
      yield* Effect.gen(function* () {
        const service = yield* CliProxyService;
        yield* awaitStatus(service, (s) => s.state === "ready");
        const off = yield* subscribeStatus(service, (s) => s.state === "off");
        yield* harness.setFlag(false);
        const status = yield* Fiber.join(off);
        assert.equal(status.mode, "external");
        assert.isUndefined(status.baseUrl);
        assert.isUndefined(status.lastError);
        assert.equal(status.restarts, 0);
        assert.isTrue(Option.isNone(yield* service.endpoint));
        assert.equal(currentCliProxyEndpoint(), undefined);
        // With the flag off there is nothing to restart; the status is reported as is.
        assert.equal((yield* service.restart).state, "off");
        const probes = harness.probeInputs.length;
        yield* Effect.sleep(Duration.millis(30));
        assert.equal(harness.probeInputs.length, probes);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

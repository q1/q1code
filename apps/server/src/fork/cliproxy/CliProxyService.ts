/**
 * CliProxyService - the CLIProxyAPI sidecar as a supervised child of the server.
 *
 * Off by default: nothing is spawned, written, or published unless the
 * `cliproxy` fork flag is on. When it is, the service renders `config.yaml`,
 * resolves the binary, spawns `cli-proxy-api -config <path>`, waits for the
 * port and the management API, and publishes the endpoint for the provider
 * seams. Exits and failed starts restart with capped backoff. The flag turning
 * off (or server shutdown) interrupts the supervisor, which kills the child.
 *
 * The launcher, readiness probe, and restart schedule are services so tests
 * drive the state machine without a binary or a clock.
 */
import * as NodeNet from "node:net";

import { CLIPROXY_DEFAULT_PORT } from "@q1code/core/cliproxy";
import * as Context from "effect/Context";
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
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ForkFlags from "../ForkFlags.ts";
import * as CliProxyBinary from "./CliProxyBinary.ts";
import {
  cliproxyDirectories,
  renderCliProxyConfig,
  writeCliProxyConfig,
} from "./CliProxyConfig.ts";
import { type CliProxyEndpoint, publishCliProxyEndpoint } from "./CliProxyEnvironment.ts";
import { materializeCodexProxyHome } from "./CodexProxyHome.ts";

export type CliProxyState = "off" | "starting" | "ready" | "failed";

export interface CliProxyStatus {
  readonly state: CliProxyState;
  readonly port: number;
  readonly version?: string | undefined;
  readonly pid?: number | undefined;
  /** Last failure message while `failed`; never carries a secret. */
  readonly error?: string | undefined;
}

export class CliProxySpawnError extends Schema.TaggedErrorClass<CliProxySpawnError>()(
  "CliProxySpawnError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn CLIProxyAPI at '${this.path}'.`;
  }
}

export class CliProxyNotReady extends Schema.TaggedErrorClass<CliProxyNotReady>()(
  "CliProxyNotReady",
  {
    port: Schema.Number,
    stage: Schema.Literals(["tcp", "management"]),
  },
) {
  override get message(): string {
    return `CLIProxyAPI on port ${this.port} did not become ready (${this.stage}).`;
  }
}

export class CliProxyExited extends Schema.TaggedErrorClass<CliProxyExited>()("CliProxyExited", {
  code: Schema.Number,
}) {
  override get message(): string {
    return `CLIProxyAPI exited with code ${this.code}.`;
  }
}

export class CliProxySecretError extends Schema.TaggedErrorClass<CliProxySecretError>()(
  "CliProxySecretError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to load the CLIProxyAPI secrets.";
  }
}

export class CliProxyManagementError extends Schema.TaggedErrorClass<CliProxyManagementError>()(
  "CliProxyManagementError",
  {
    reason: Schema.Literals(["not-ready", "request-failed"]),
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "not-ready"
      ? `CLIProxyAPI management request to '${this.path}' needs a ready proxy.`
      : `CLIProxyAPI management request to '${this.path}' failed.`;
  }
}

export interface CliProxyManagementRequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | undefined;
  readonly headers?: Record<string, string> | undefined;
  /** Sent verbatim; set `content-type` in `headers` for JSON. */
  readonly body?: string | undefined;
}

export interface CliProxyChild {
  readonly pid: number;
  /** Interleaved stdout/stderr lines. */
  readonly output: Stream.Stream<string>;
  /** Resolves with the exit code once the process is gone. */
  readonly exit: Effect.Effect<number>;
}

/** Spawns the binary; the child dies with the scope. Tests provide a fake. */
export class CliProxyLauncher extends Context.Service<
  CliProxyLauncher,
  {
    readonly launch: (input: {
      readonly binaryPath: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd: string;
    }) => Effect.Effect<CliProxyChild, CliProxySpawnError, Scope.Scope>;
  }
>()("t3/fork/cliproxy/CliProxyService/CliProxyLauncher") {}

/** Blocks until the proxy answers on its port and its management API. Tests provide a fake. */
export class CliProxyReadiness extends Context.Service<
  CliProxyReadiness,
  {
    readonly awaitReady: (input: {
      readonly port: number;
      readonly managementSecret: string;
    }) => Effect.Effect<void, CliProxyNotReady>;
  }
>()("t3/fork/cliproxy/CliProxyService/CliProxyReadiness") {}

/** Delay between restarts after a failed start or an exit. Tests swap in a delay-free schedule. */
export const CliProxyRestartSchedule = Context.Reference<Schedule.Schedule<unknown, unknown>>(
  "t3/fork/cliproxy/CliProxyRestartSchedule",
  {
    defaultValue: () =>
      Schedule.exponential("1 second").pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, Duration.seconds(30))),
        ),
        Schedule.jittered,
      ),
  },
);

export class CliProxyService extends Context.Service<
  CliProxyService,
  {
    readonly status: Effect.Effect<CliProxyStatus>;
    /** Emits every status change. */
    readonly changes: Stream.Stream<CliProxyStatus>;
    /** Base URL and API key for provider wiring; `none` unless ready. */
    readonly endpoint: Effect.Effect<Option.Option<CliProxyEndpoint>>;
    /** Server-side only: calls `/v0/management<path>` with the management secret attached. */
    readonly management: {
      readonly request: (
        path: string,
        options?: CliProxyManagementRequestOptions,
      ) => Effect.Effect<HttpClientResponse.HttpClientResponse, CliProxyManagementError>;
    };
    /** Managed `CODEX_HOME` for a Codex instance that should talk to the proxy. */
    readonly codexProxyHomePath: string;
  }
>()("t3/fork/cliproxy/CliProxyService") {}

const SECRET_API_KEY = "cliproxy-api-key";
const SECRET_MANAGEMENT = "cliproxy-management-secret";
const SECRET_BYTES = 32;

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Blank out secrets before a sidecar line reaches the server log. */
export const redactSecrets = (line: string, secrets: ReadonlyArray<string>): string =>
  secrets.reduce(
    (text, secret) => (secret.length === 0 ? text : text.split(secret).join("[redacted]")),
    line,
  );

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const flags = yield* ForkFlags.ForkFlagsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const binaries = yield* CliProxyBinary.CliProxyBinary;
  const launcher = yield* CliProxyLauncher;
  const readiness = yield* CliProxyReadiness;
  const restartSchedule = yield* CliProxyRestartSchedule;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directories = cliproxyDirectories(config.baseDir, path);

  const statusRef = yield* Ref.make<CliProxyStatus>({ state: "off", port: CLIPROXY_DEFAULT_PORT });
  const endpointRef = yield* Ref.make<Option.Option<CliProxyEndpoint>>(Option.none());
  const managementRef = yield* Ref.make<Option.Option<{ port: number; secret: string }>>(
    Option.none(),
  );
  const statusPubSub = yield* PubSub.unbounded<CliProxyStatus>();
  const supervisorRef = yield* Ref.make<Option.Option<Fiber.Fiber<void>>>(Option.none());
  const lifecycle = yield* Semaphore.make(1);
  const runScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(runScope, Exit.void));

  const setStatus = (next: CliProxyStatus) =>
    Ref.set(statusRef, next).pipe(Effect.andThen(PubSub.publish(statusPubSub, next)));
  const patchStatus = (patch: Partial<CliProxyStatus>) =>
    Ref.get(statusRef).pipe(Effect.flatMap((current) => setStatus({ ...current, ...patch })));

  const publish = (endpoint: Option.Option<CliProxyEndpoint>) =>
    Ref.set(endpointRef, endpoint).pipe(
      Effect.andThen(Effect.sync(() => publishCliProxyEndpoint(Option.getOrUndefined(endpoint)))),
    );

  const loadSecret = (name: string) =>
    secrets.getOrCreateRandom(name, SECRET_BYTES).pipe(
      Effect.map(toHex),
      Effect.mapError((cause) => new CliProxySecretError({ cause })),
    );

  const ensureDirectory = (directory: string) =>
    fs
      .makeDirectory(directory, { recursive: true })
      .pipe(Effect.andThen(fs.chmod(directory, 0o700)));

  // One start-to-exit run. Fails on every way the sidecar can stop being
  // useful so the supervisor's retry drives the restart.
  const runOnce = Effect.scoped(
    Effect.gen(function* () {
      const forkConfig = yield* flags.config;
      const section = forkConfig.cliproxy ?? {};
      const port = section.port ?? CLIPROXY_DEFAULT_PORT;
      yield* setStatus({ state: "starting", port });

      const binary = yield* binaries.resolve({
        binaryPath: section.binaryPath,
        version: section.releaseVersion,
      });
      yield* patchStatus({ version: binary.version });

      yield* ensureDirectory(directories.rootDir);
      yield* ensureDirectory(directories.authsDir);
      const apiKey = yield* loadSecret(SECRET_API_KEY);
      const managementSecret = yield* loadSecret(SECRET_MANAGEMENT);
      const secretValues = [apiKey, managementSecret];
      yield* writeCliProxyConfig(
        directories.configPath,
        renderCliProxyConfig({
          port,
          authDir: directories.authsDir,
          apiKey,
          managementSecret,
          routingStrategy: section.routingStrategy,
        }),
      );
      const endpoint: CliProxyEndpoint = { baseUrl: `http://127.0.0.1:${port}`, apiKey };
      yield* materializeCodexProxyHome({ homeDir: directories.codexHomeDir, endpoint }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("cliproxy: codex proxy home not materialized", {
            cause: error.message,
          }),
        ),
      );

      const child = yield* launcher.launch({
        binaryPath: binary.path,
        args: ["-config", directories.configPath],
        cwd: directories.rootDir,
      });
      yield* patchStatus({ pid: child.pid });
      yield* child.output.pipe(
        Stream.runForEach((line) =>
          Effect.logDebug(`cliproxy: ${redactSecrets(line, secretValues)}`),
        ),
        Effect.ignoreCause(),
        Effect.forkScoped,
      );

      const exited = child.exit.pipe(
        Effect.flatMap((code) => Effect.fail(new CliProxyExited({ code }))),
      );
      yield* Effect.raceFirst(readiness.awaitReady({ port, managementSecret }), exited);

      yield* Ref.set(managementRef, Option.some({ port, secret: managementSecret }));
      yield* publish(Option.some(endpoint));
      yield* patchStatus({ state: "ready" });
      yield* Effect.logInfo("cliproxy: ready", { port, version: binary.version, pid: child.pid });
      return yield* exited;
    }).pipe(
      Effect.ensuring(
        publish(Option.none()).pipe(Effect.andThen(Ref.set(managementRef, Option.none()))),
      ),
    ),
  );

  const supervise = runOnce.pipe(
    Effect.tapError((error) =>
      patchStatus({ state: "failed", pid: undefined, error: error.message }).pipe(
        Effect.andThen(
          Effect.logWarning("cliproxy: sidecar stopped, restarting", { cause: error.message }),
        ),
      ),
    ),
    Effect.retry(restartSchedule),
    Effect.ignoreCause({ log: true }),
  );

  const start = Effect.gen(function* () {
    if (Option.isSome(yield* Ref.get(supervisorRef))) return;
    const fiber = yield* supervise.pipe(Effect.forkIn(runScope));
    yield* Ref.set(supervisorRef, Option.some(fiber));
  });

  const stop = Effect.gen(function* () {
    const fiber = yield* Ref.getAndSet(supervisorRef, Option.none());
    if (Option.isNone(fiber)) return;
    yield* Fiber.interrupt(fiber.value);
    yield* setStatus({ state: "off", port: (yield* Ref.get(statusRef)).port });
    yield* Effect.logInfo("cliproxy: stopped");
  });

  const apply = (values: { readonly cliproxy: boolean }) =>
    lifecycle.withPermits(1)(values.cliproxy ? start : stop);

  yield* apply(yield* flags.current);
  yield* flags.changes.pipe(
    Stream.runForEach(apply),
    Effect.ignoreCause({ log: true }),
    Effect.forkIn(runScope),
  );

  const request: CliProxyService["Service"]["management"]["request"] = (requestPath, options) =>
    Effect.gen(function* () {
      const management = yield* Ref.get(managementRef);
      if (Option.isNone(management)) {
        return yield* new CliProxyManagementError({ reason: "not-ready", path: requestPath });
      }
      const client = yield* HttpClient.HttpClient;
      let httpRequest = HttpClientRequest.make(options?.method ?? "GET")(
        `http://127.0.0.1:${management.value.port}/v0/management${requestPath}`,
        { headers: options?.headers },
      ).pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${management.value.secret}`));
      if (options?.body !== undefined) {
        httpRequest = HttpClientRequest.bodyText(httpRequest, options.body);
      }
      return yield* client
        .execute(httpRequest)
        .pipe(
          Effect.mapError(
            (cause) =>
              new CliProxyManagementError({ reason: "request-failed", path: requestPath, cause }),
          ),
        );
    }).pipe(Effect.provide(FetchHttpClient.layer));

  return CliProxyService.of({
    status: Ref.get(statusRef),
    changes: Stream.fromPubSub(statusPubSub),
    endpoint: Ref.get(endpointRef),
    management: { request },
    codexProxyHomePath: directories.codexHomeDir,
  });
});

export const READY_TIMEOUT = Duration.seconds(30);
const READY_POLL = Duration.millis(250);

const tcpConnect = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = NodeNet.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.succeed(true));
    });
    socket.once("error", () => resume(Effect.succeed(false)));
    return Effect.sync(() => socket.destroy());
  });

const managementProbe = (port: number, secret: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client.get(`http://127.0.0.1:${port}/v0/management/latest-version`, {
        headers: { Authorization: `Bearer ${secret}` },
      }),
    ),
    Effect.map((response) => response.status === 200),
    Effect.provide(FetchHttpClient.layer),
    Effect.orElseSucceed(() => false),
  );

const untilTrue = (probe: Effect.Effect<boolean>, onTimeout: CliProxyNotReady) =>
  probe.pipe(
    Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(onTimeout))),
    Effect.retry(Schedule.spaced(READY_POLL)),
    Effect.timeoutOption(READY_TIMEOUT),
    Effect.flatMap(
      Option.match({ onNone: () => Effect.fail(onTimeout), onSome: () => Effect.void }),
    ),
  );

export const readinessLayer = Layer.succeed(
  CliProxyReadiness,
  CliProxyReadiness.of({
    awaitReady: ({ port, managementSecret }) =>
      untilTrue(tcpConnect(port), new CliProxyNotReady({ port, stage: "tcp" })).pipe(
        Effect.andThen(
          untilTrue(
            managementProbe(port, managementSecret),
            new CliProxyNotReady({ port, stage: "management" }),
          ),
        ),
      ),
  }),
);

export const launcherLayer = Layer.effect(
  CliProxyLauncher,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return CliProxyLauncher.of({
      launch: (input) =>
        Effect.gen(function* () {
          const handle = yield* Effect.acquireRelease(
            spawner
              .spawn(
                ChildProcess.make(input.binaryPath, input.args, {
                  cwd: input.cwd,
                  stdin: "ignore",
                  stdout: "pipe",
                  stderr: "pipe",
                  killSignal: "SIGTERM",
                  forceKillAfter: Duration.seconds(5),
                }),
              )
              .pipe(
                Effect.mapError(
                  (cause) => new CliProxySpawnError({ path: input.binaryPath, cause }),
                ),
              ),
            (child) => child.kill().pipe(Effect.ignore),
          );
          return {
            pid: handle.pid,
            output: handle.all.pipe(Stream.decodeText(), Stream.splitLines, Stream.orDie),
            exit: handle.exitCode.pipe(
              Effect.map((code) => Number(code)),
              Effect.orElseSucceed(() => -1),
            ),
          } satisfies CliProxyChild;
        }),
    });
  }),
);

/** Production wiring. Needs ServerConfig, ForkFlagsService, ServerSecretStore, and the Node services from outside. */
export const layer = Layer.effect(CliProxyService, make).pipe(
  Layer.provide(CliProxyBinary.layer),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(launcherLayer),
  Layer.provide(readinessLayer),
);

/** The service body alone; tests supply the binary, launcher, readiness, and schedule. */
export const layerWithoutRuntime = Layer.effect(CliProxyService, make);

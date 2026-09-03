/**
 * CliProxyService - CLIProxyAPI as a supervised child of the server, or as an
 * externally run proxy the server only manages.
 *
 * Off by default: nothing is spawned, written, or published unless the
 * `cliproxy` fork flag is on. When it is, `fork.json` `cliproxy.mode` decides:
 *
 * - `sidecar` (default): render `config.yaml`, resolve the binary, spawn
 *   `cli-proxy-api -config <path>`, wait for the port and the management API,
 *   publish the endpoint for the provider seams. Exits and failed starts
 *   restart with capped backoff.
 * - `external`: read the management secret and client API key from the secret
 *   store, probe the configured `baseUrl`'s management API, publish the
 *   endpoint, and keep probing on a timer; a failed probe drops to `failed` and
 *   unpublishes, a later success comes back as `ready` (one reconnect).
 *
 * The flag turning off (or server shutdown) interrupts the supervisor, which
 * kills the child or stops the monitor. `restart` interrupts the current run
 * so the supervisor starts over right away; in external mode that is a fresh
 * secret read and an immediate probe.
 *
 * The launcher, readiness probe, restart schedule, and health interval are
 * services so tests drive the state machine without a binary or a clock.
 */
import * as NodeNet from "node:net";

import { CLIPROXY_DEFAULT_PORT } from "@q1code/core/cliproxy";
import {
  CLIPROXY_DEFAULT_API_KEY_SECRET_NAME,
  CLIPROXY_DEFAULT_MANAGEMENT_SECRET_NAME,
  type CliProxyConfig,
  type CliProxyMode,
} from "@q1code/core/config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
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
  readonly mode: CliProxyMode;
  /** Sidecar: the loopback port it listens on. External: the port of `baseUrl`. */
  readonly port: number;
  /** When the current `state` was entered. */
  readonly since: string;
  /** Runs beyond the first since the flag turned on (supervisor restarts, manual restarts) plus external reconnects. */
  readonly restarts: number;
  /** Sidecar binary version; unknown for an external proxy. */
  readonly version?: string | undefined;
  readonly pid?: number | undefined;
  /** The proxy origin provider CLIs are pointed at, only while `ready`. */
  readonly baseUrl?: string | undefined;
  /** Last failure message; never carries a secret. Cleared once the proxy is ready. */
  readonly lastError?: string | undefined;
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

/** One management probe against an external proxy failed; `detail` is transport or HTTP text with the secret redacted. */
export class CliProxyProbeFailed extends Schema.TaggedErrorClass<CliProxyProbeFailed>()(
  "CliProxyProbeFailed",
  {
    baseUrl: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `CLIProxyAPI at ${this.baseUrl} did not answer the management probe: ${this.detail}`;
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

/** External mode needs a secret the store does not hold; the message says how to add it. */
export class CliProxySecretMissing extends Schema.TaggedErrorClass<CliProxySecretMissing>()(
  "CliProxySecretMissing",
  {
    name: Schema.String,
  },
) {
  override get message(): string {
    return `secret "${this.name}" is not set; store it with: q1code fork secret set ${this.name}`;
  }
}

export class CliProxyExternalConfigError extends Schema.TaggedErrorClass<CliProxyExternalConfigError>()(
  "CliProxyExternalConfigError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
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

/**
 * `awaitReady` blocks until a freshly spawned sidecar answers on its port and
 * its management API; `probe` is one management call against any proxy origin.
 * Tests provide a fake.
 */
export class CliProxyReadiness extends Context.Service<
  CliProxyReadiness,
  {
    readonly awaitReady: (input: {
      readonly port: number;
      readonly managementSecret: string;
    }) => Effect.Effect<void, CliProxyNotReady>;
    readonly probe: (input: {
      readonly baseUrl: string;
      readonly managementSecret: string;
    }) => Effect.Effect<void, CliProxyProbeFailed>;
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

/** How often external mode re-probes the proxy. Tests shrink it. */
export const CliProxyHealthInterval = Context.Reference<Duration.Duration>(
  "t3/fork/cliproxy/CliProxyHealthInterval",
  { defaultValue: () => Duration.seconds(30) },
);

export class CliProxyService extends Context.Service<
  CliProxyService,
  {
    readonly status: Effect.Effect<CliProxyStatus>;
    /** Emits every status change. */
    readonly changes: Stream.Stream<CliProxyStatus>;
    /** Base URL and API key for provider wiring; `none` unless ready. */
    readonly endpoint: Effect.Effect<Option.Option<CliProxyEndpoint>>;
    /**
     * Start the current run over now (sidecar: kill and respawn; external:
     * re-read the secrets and probe) and answer once the state settles as
     * `ready` or `failed`, or after `READY_TIMEOUT`. With the flag off it only
     * reports the status.
     */
    readonly restart: Effect.Effect<CliProxyStatus>;
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

const SECRET_BYTES = 32;
const MANAGEMENT_PROBE_PATH = "/v0/management/latest-version";

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Blank out secrets before a sidecar line reaches the server log. */
export const redactSecrets = (line: string, secrets: ReadonlyArray<string>): string =>
  secrets.reduce(
    (text, secret) => (secret.length === 0 ? text : text.split(secret).join("[redacted]")),
    line,
  );

/** Pure: `cliproxy.external.baseUrl` as an origin plus its effective port, or undefined when it is not a bare http(s) origin. */
export const parseCliProxyBaseUrl = (
  raw: string,
): { readonly baseUrl: string; readonly port: number } | undefined => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  const isHttp = url.protocol === "http:" || url.protocol === "https:";
  const bare =
    (url.pathname === "/" || url.pathname === "") &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === "";
  if (!isHttp || !bare) return undefined;
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  return { baseUrl: url.origin, port };
};

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const flags = yield* ForkFlags.ForkFlagsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const binaries = yield* CliProxyBinary.CliProxyBinary;
  const launcher = yield* CliProxyLauncher;
  const readiness = yield* CliProxyReadiness;
  const restartSchedule = yield* CliProxyRestartSchedule;
  const healthInterval = yield* CliProxyHealthInterval;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directories = cliproxyDirectories(config.baseDir, path);

  const statusRef = yield* Ref.make<CliProxyStatus>({
    state: "off",
    mode: "sidecar",
    port: CLIPROXY_DEFAULT_PORT,
    since: yield* nowIso,
    restarts: 0,
  });
  const endpointRef = yield* Ref.make<Option.Option<CliProxyEndpoint>>(Option.none());
  const managementRef = yield* Ref.make<Option.Option<{ baseUrl: string; secret: string }>>(
    Option.none(),
  );
  const statusPubSub = yield* PubSub.unbounded<CliProxyStatus>();
  const supervisorRef = yield* Ref.make<Option.Option<Fiber.Fiber<void>>>(Option.none());
  // Completing it makes the supervisor abandon the current run and start over.
  const restartRef = yield* Ref.make<Option.Option<Deferred.Deferred<void>>>(Option.none());
  const runsRef = yield* Ref.make(0);
  const lifecycle = yield* Semaphore.make(1);
  const runScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(runScope, Exit.void));

  /** Apply a patch derived from the current status; entering a new state stamps `since`. */
  const updateStatus = (update: (current: CliProxyStatus) => Partial<CliProxyStatus>) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(statusRef);
      const patch = update(current);
      const entered = patch.state !== undefined && patch.state !== current.state;
      const next: CliProxyStatus = {
        ...current,
        ...patch,
        since: entered ? yield* nowIso : current.since,
      };
      yield* Ref.set(statusRef, next);
      yield* PubSub.publish(statusPubSub, next);
    });
  const patchStatus = (patch: Partial<CliProxyStatus>) => updateStatus(() => patch);

  const publish = (endpoint: Option.Option<CliProxyEndpoint>) =>
    Ref.set(endpointRef, endpoint).pipe(
      Effect.andThen(Effect.sync(() => publishCliProxyEndpoint(Option.getOrUndefined(endpoint)))),
    );

  const setManagement = (management: Option.Option<{ baseUrl: string; secret: string }>) =>
    Ref.set(managementRef, management);

  const loadSecret = (name: string) =>
    secrets.getOrCreateRandom(name, SECRET_BYTES).pipe(
      Effect.map(toHex),
      Effect.mapError((cause) => new CliProxySecretError({ cause })),
    );

  /** External mode never generates: a missing or blank secret is a configuration error with the fix in its message. */
  const readStoredSecret = (name: string) =>
    secrets.get(name).pipe(
      Effect.mapError((cause) => new CliProxySecretError({ cause })),
      Effect.flatMap((stored) => {
        const value = Option.isSome(stored) ? new TextDecoder().decode(stored.value).trim() : "";
        return value === ""
          ? Effect.fail(new CliProxySecretMissing({ name }))
          : Effect.succeed(value);
      }),
    );

  const ensureDirectory = (directory: string) =>
    fs
      .makeDirectory(directory, { recursive: true })
      .pipe(Effect.andThen(fs.chmod(directory, 0o700)));

  const materializeCodexHome = (endpoint: CliProxyEndpoint) =>
    materializeCodexProxyHome({ homeDir: directories.codexHomeDir, endpoint }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("cliproxy: codex proxy home not materialized", {
          cause: error.message,
        }),
      ),
    );

  const becomeReady = (
    endpoint: CliProxyEndpoint,
    managementSecret: string,
    patch: (current: CliProxyStatus) => Partial<CliProxyStatus>,
  ) =>
    setManagement(Option.some({ baseUrl: endpoint.baseUrl, secret: managementSecret })).pipe(
      Effect.andThen(publish(Option.some(endpoint))),
      Effect.andThen(
        updateStatus((current) => ({
          ...patch(current),
          state: "ready",
          baseUrl: endpoint.baseUrl,
          lastError: undefined,
        })),
      ),
    );

  const unpublish = publish(Option.none()).pipe(Effect.andThen(setManagement(Option.none())));

  type Begin = (port: number) => Effect.Effect<void>;

  // Spawn, wait for readiness, publish, then fail on the child's exit so the
  // supervisor's retry drives the restart.
  const runSidecar = Effect.fn("cliproxy.runSidecar")(function* (
    section: CliProxyConfig,
    begin: Begin,
  ) {
    const port = section.port ?? CLIPROXY_DEFAULT_PORT;
    yield* begin(port);

    const binary = yield* binaries.resolve({
      binaryPath: section.binaryPath,
      version: section.releaseVersion,
    });
    yield* patchStatus({ version: binary.version });

    yield* ensureDirectory(directories.rootDir);
    yield* ensureDirectory(directories.authsDir);
    const apiKey = yield* loadSecret(CLIPROXY_DEFAULT_API_KEY_SECRET_NAME);
    const managementSecret = yield* loadSecret(CLIPROXY_DEFAULT_MANAGEMENT_SECRET_NAME);
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
    yield* materializeCodexHome(endpoint);

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

    yield* becomeReady(endpoint, managementSecret, () => ({}));
    yield* Effect.logInfo("cliproxy: ready", { port, version: binary.version, pid: child.pid });
    return yield* exited;
  });

  // Validate the section and the secrets once, then probe on the health
  // interval until interrupted. Only the setup can fail; a probe failure is a
  // `failed` status the next probe can undo.
  const runExternal = Effect.fn("cliproxy.runExternal")(function* (
    section: CliProxyConfig,
    begin: Begin,
  ) {
    const external = section.external;
    const parsed = external === undefined ? undefined : parseCliProxyBaseUrl(external.baseUrl);
    yield* begin(parsed?.port ?? CLIPROXY_DEFAULT_PORT);
    if (external === undefined) {
      return yield* new CliProxyExternalConfigError({
        detail: 'cliproxy.mode is "external" but fork.json has no cliproxy.external section',
      });
    }
    if (parsed === undefined) {
      return yield* new CliProxyExternalConfigError({
        detail: `cliproxy.external.baseUrl must be an absolute http(s) origin such as http://127.0.0.1:8317, got "${external.baseUrl}"`,
      });
    }
    const managementSecret = yield* readStoredSecret(
      external.managementSecretName ?? CLIPROXY_DEFAULT_MANAGEMENT_SECRET_NAME,
    );
    const apiKey = yield* readStoredSecret(
      external.apiKeySecretName ?? CLIPROXY_DEFAULT_API_KEY_SECRET_NAME,
    );
    const endpoint: CliProxyEndpoint = { baseUrl: parsed.baseUrl, apiKey };
    yield* materializeCodexHome(endpoint);

    let wasReady = false;
    while (true) {
      const failure = yield* readiness.probe({ baseUrl: parsed.baseUrl, managementSecret }).pipe(
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed(error.message)),
      );
      const current = yield* Ref.get(statusRef);
      if (failure === undefined) {
        if (current.state !== "ready") {
          yield* becomeReady(endpoint, managementSecret, (status) => ({
            restarts: wasReady ? status.restarts + 1 : status.restarts,
          }));
          yield* Effect.logInfo("cliproxy: external proxy ready", { baseUrl: parsed.baseUrl });
          wasReady = true;
        }
      } else if (current.state !== "failed" || current.lastError !== failure) {
        yield* unpublish;
        yield* patchStatus({ state: "failed", baseUrl: undefined, lastError: failure });
        yield* Effect.logWarning("cliproxy: external proxy not reachable", {
          baseUrl: parsed.baseUrl,
          cause: failure,
        });
      }
      yield* Effect.sleep(healthInterval);
    }
  });

  // One run, in whichever mode `fork.json` names right now. Every way the
  // proxy can stop being useful is a failure so the supervisor restarts it.
  const runOnce = Effect.scoped(
    Effect.gen(function* () {
      const section = (yield* flags.config).cliproxy ?? {};
      const mode = section.mode ?? "sidecar";
      const run = yield* Ref.getAndUpdate(runsRef, (count) => count + 1);
      const begin: Begin = (port) =>
        updateStatus((current) => ({
          state: "starting",
          mode,
          port,
          pid: undefined,
          version: undefined,
          baseUrl: undefined,
          restarts: run === 0 ? 0 : current.restarts + 1,
        }));
      return mode === "external"
        ? yield* runExternal(section, begin)
        : yield* runSidecar(section, begin);
    }).pipe(Effect.ensuring(unpublish)),
  );

  const superviseOnce = runOnce.pipe(
    Effect.tapError((error) =>
      patchStatus({
        state: "failed",
        pid: undefined,
        baseUrl: undefined,
        lastError: error.message,
      }).pipe(
        Effect.andThen(
          Effect.logWarning("cliproxy: proxy stopped, restarting", { cause: error.message }),
        ),
      ),
    ),
    Effect.retry(restartSchedule),
    Effect.ignoreCause({ log: true }),
  );

  // Each pass owns one restart signal. When it fires, the current run (or the
  // backoff it is sleeping in) is interrupted and the next pass begins with a
  // fresh schedule; when the schedule itself gives up, only a signal continues.
  const supervise = Effect.gen(function* () {
    while (true) {
      const restartRequested = yield* Deferred.make<void>();
      yield* Ref.set(restartRef, Option.some(restartRequested));
      yield* Effect.raceFirst(superviseOnce, Deferred.await(restartRequested));
      yield* Deferred.await(restartRequested);
    }
  });

  const start = Effect.gen(function* () {
    if (Option.isSome(yield* Ref.get(supervisorRef))) return;
    yield* Ref.set(runsRef, 0);
    const fiber = yield* supervise.pipe(Effect.forkIn(runScope));
    yield* Ref.set(supervisorRef, Option.some(fiber));
  });

  const stop = Effect.gen(function* () {
    const fiber = yield* Ref.getAndSet(supervisorRef, Option.none());
    if (Option.isNone(fiber)) return;
    yield* Fiber.interrupt(fiber.value);
    yield* Ref.set(restartRef, Option.none());
    yield* patchStatus({
      state: "off",
      pid: undefined,
      version: undefined,
      baseUrl: undefined,
      lastError: undefined,
      restarts: 0,
    });
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

  const restart = Effect.gen(function* () {
    const signal = yield* Ref.get(restartRef);
    if (Option.isNone(signal)) return yield* Ref.get(statusRef);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        // Subscribe first so the `starting` that follows the signal cannot slip past.
        const subscription = yield* PubSub.subscribe(statusPubSub);
        yield* Deferred.succeed(signal.value, undefined);
        // `off` settles it too: the flag turned off while we waited.
        const settled = Effect.gen(function* () {
          while (true) {
            const status = yield* PubSub.take(subscription);
            if (status.state !== "starting") return status;
          }
        });
        const outcome = yield* settled.pipe(Effect.timeoutOption(READY_TIMEOUT));
        return Option.isSome(outcome) ? outcome.value : yield* Ref.get(statusRef);
      }),
    );
  });

  const request: CliProxyService["Service"]["management"]["request"] = (requestPath, options) =>
    Effect.gen(function* () {
      const management = yield* Ref.get(managementRef);
      if (Option.isNone(management)) {
        return yield* new CliProxyManagementError({ reason: "not-ready", path: requestPath });
      }
      const client = yield* HttpClient.HttpClient;
      let httpRequest = HttpClientRequest.make(options?.method ?? "GET")(
        `${management.value.baseUrl}/v0/management${requestPath}`,
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
    restart,
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

/** `GET /v0/management/latest-version` with the bearer secret; the cheapest authenticated management call. */
const managementProbe = (baseUrl: string, secret: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client.get(`${baseUrl}${MANAGEMENT_PROBE_PATH}`, {
        headers: { Authorization: `Bearer ${secret}` },
      }),
    ),
    Effect.provide(FetchHttpClient.layer),
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
            managementProbe(`http://127.0.0.1:${port}`, managementSecret).pipe(
              Effect.map((response) => response.status === 200),
              Effect.orElseSucceed(() => false),
            ),
            new CliProxyNotReady({ port, stage: "management" }),
          ),
        ),
      ),
    probe: ({ baseUrl, managementSecret }) =>
      managementProbe(baseUrl, managementSecret).pipe(
        Effect.mapError(
          (error) =>
            new CliProxyProbeFailed({
              baseUrl,
              detail: redactSecrets(error.message, [managementSecret]),
            }),
        ),
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.void
            : Effect.fail(
                new CliProxyProbeFailed({
                  baseUrl,
                  detail:
                    response.status === 401 || response.status === 403
                      ? `HTTP ${response.status} from GET ${MANAGEMENT_PROBE_PATH}; check the management secret`
                      : `HTTP ${response.status} from GET ${MANAGEMENT_PROBE_PATH}`,
                }),
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

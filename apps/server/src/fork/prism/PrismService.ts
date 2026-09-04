/**
 * PrismService - CLIProxyAPI as a supervised child of the server, or as an
 * externally run proxy the server only manages.
 *
 * Off by default: nothing is spawned, written, or published unless the
 * `prism` fork flag is on. When it is, `fork.json` `prism.mode` decides:
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

import { PRISM_DEFAULT_PORT } from "@q1code/core/prism";
import {
  PRISM_DEFAULT_API_KEY_SECRET_NAME,
  PRISM_DEFAULT_MANAGEMENT_SECRET_NAME,
  type PrismConfig,
  type PrismMode,
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
import * as PrismBinary from "./PrismBinary.ts";
import { prismDirectories, renderPrismConfig, writePrismConfig } from "./PrismConfig.ts";
import { type PrismEndpoint, publishPrismEndpoint } from "./PrismEnvironment.ts";
import { materializeCodexProxyHome } from "./CodexProxyHome.ts";

export type PrismState = "off" | "starting" | "ready" | "failed";

export interface PrismStatus {
  readonly state: PrismState;
  readonly mode: PrismMode;
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

export class PrismSpawnError extends Schema.TaggedErrorClass<PrismSpawnError>()("PrismSpawnError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to spawn CLIProxyAPI at '${this.path}'.`;
  }
}

export class PrismNotReady extends Schema.TaggedErrorClass<PrismNotReady>()("PrismNotReady", {
  port: Schema.Number,
  stage: Schema.Literals(["tcp", "management"]),
}) {
  override get message(): string {
    return `CLIProxyAPI on port ${this.port} did not become ready (${this.stage}).`;
  }
}

/** One management probe against an external proxy failed; `detail` is transport or HTTP text with the secret redacted. */
export class PrismProbeFailed extends Schema.TaggedErrorClass<PrismProbeFailed>()(
  "PrismProbeFailed",
  {
    baseUrl: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `CLIProxyAPI at ${this.baseUrl} did not answer the management probe: ${this.detail}`;
  }
}

export class PrismExited extends Schema.TaggedErrorClass<PrismExited>()("PrismExited", {
  code: Schema.Number,
}) {
  override get message(): string {
    return `CLIProxyAPI exited with code ${this.code}.`;
  }
}

export class PrismSecretError extends Schema.TaggedErrorClass<PrismSecretError>()(
  "PrismSecretError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to load the Prism secrets.";
  }
}

/** External mode needs a secret the store does not hold; the message says how to add it. */
export class PrismSecretMissing extends Schema.TaggedErrorClass<PrismSecretMissing>()(
  "PrismSecretMissing",
  {
    name: Schema.String,
  },
) {
  override get message(): string {
    return `secret "${this.name}" is not set; store it with: q1code fork secret set ${this.name}`;
  }
}

export class PrismExternalConfigError extends Schema.TaggedErrorClass<PrismExternalConfigError>()(
  "PrismExternalConfigError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class PrismManagementError extends Schema.TaggedErrorClass<PrismManagementError>()(
  "PrismManagementError",
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

export interface PrismManagementRequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | undefined;
  readonly headers?: Record<string, string> | undefined;
  /** Sent verbatim; set `content-type` in `headers` for JSON. */
  readonly body?: string | undefined;
}

export interface PrismChild {
  readonly pid: number;
  /** Interleaved stdout/stderr lines. */
  readonly output: Stream.Stream<string>;
  /** Resolves with the exit code once the process is gone. */
  readonly exit: Effect.Effect<number>;
}

/** Spawns the binary; the child dies with the scope. Tests provide a fake. */
export class PrismLauncher extends Context.Service<
  PrismLauncher,
  {
    readonly launch: (input: {
      readonly binaryPath: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd: string;
    }) => Effect.Effect<PrismChild, PrismSpawnError, Scope.Scope>;
  }
>()("t3/fork/prism/PrismService/PrismLauncher") {}

/**
 * `awaitReady` blocks until a freshly spawned sidecar answers on its port and
 * its management API; `probe` is one management call against any proxy origin.
 * Tests provide a fake.
 */
export class PrismReadiness extends Context.Service<
  PrismReadiness,
  {
    readonly awaitReady: (input: {
      readonly port: number;
      readonly managementSecret: string;
    }) => Effect.Effect<void, PrismNotReady>;
    readonly probe: (input: {
      readonly baseUrl: string;
      readonly managementSecret: string;
    }) => Effect.Effect<void, PrismProbeFailed>;
  }
>()("t3/fork/prism/PrismService/PrismReadiness") {}

/** Delay between restarts after a failed start or an exit. Tests swap in a delay-free schedule. */
export const PrismRestartSchedule = Context.Reference<Schedule.Schedule<unknown, unknown>>(
  "t3/fork/prism/PrismRestartSchedule",
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
export const PrismHealthInterval = Context.Reference<Duration.Duration>(
  "t3/fork/prism/PrismHealthInterval",
  { defaultValue: () => Duration.seconds(30) },
);

export class PrismService extends Context.Service<
  PrismService,
  {
    readonly status: Effect.Effect<PrismStatus>;
    /** Emits every status change. */
    readonly changes: Stream.Stream<PrismStatus>;
    /** Base URL and API key for provider wiring; `none` unless ready. */
    readonly endpoint: Effect.Effect<Option.Option<PrismEndpoint>>;
    /**
     * Start the current run over now (sidecar: kill and respawn; external:
     * re-read the secrets and probe) and answer once the state settles as
     * `ready` or `failed`, or after `READY_TIMEOUT`. With the flag off it only
     * reports the status.
     */
    readonly restart: Effect.Effect<PrismStatus>;
    /** Server-side only: calls `/v0/management<path>` with the management secret attached. */
    readonly management: {
      readonly request: (
        path: string,
        options?: PrismManagementRequestOptions,
      ) => Effect.Effect<HttpClientResponse.HttpClientResponse, PrismManagementError>;
    };
    /** Managed `CODEX_HOME` for a Codex instance that should talk to the proxy. */
    readonly codexProxyHomePath: string;
  }
>()("t3/fork/prism/PrismService") {}

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

/** Pure: `prism.external.baseUrl` as an origin plus its effective port, or undefined when it is not a bare http(s) origin. */
export const parsePrismBaseUrl = (
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
  const binaries = yield* PrismBinary.PrismBinary;
  const launcher = yield* PrismLauncher;
  const readiness = yield* PrismReadiness;
  const restartSchedule = yield* PrismRestartSchedule;
  const healthInterval = yield* PrismHealthInterval;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directories = prismDirectories(config.baseDir, path);

  const statusRef = yield* Ref.make<PrismStatus>({
    state: "off",
    mode: "sidecar",
    port: PRISM_DEFAULT_PORT,
    since: yield* nowIso,
    restarts: 0,
  });
  const endpointRef = yield* Ref.make<Option.Option<PrismEndpoint>>(Option.none());
  const managementRef = yield* Ref.make<Option.Option<{ baseUrl: string; secret: string }>>(
    Option.none(),
  );
  const statusPubSub = yield* PubSub.unbounded<PrismStatus>();
  const supervisorRef = yield* Ref.make<Option.Option<Fiber.Fiber<void>>>(Option.none());
  // Completing it makes the supervisor abandon the current run and start over.
  const restartRef = yield* Ref.make<Option.Option<Deferred.Deferred<void>>>(Option.none());
  const runsRef = yield* Ref.make(0);
  const lifecycle = yield* Semaphore.make(1);
  const runScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(runScope, Exit.void));

  /** Apply a patch derived from the current status; entering a new state stamps `since`. */
  const updateStatus = (update: (current: PrismStatus) => Partial<PrismStatus>) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(statusRef);
      const patch = update(current);
      const entered = patch.state !== undefined && patch.state !== current.state;
      const next: PrismStatus = {
        ...current,
        ...patch,
        since: entered ? yield* nowIso : current.since,
      };
      yield* Ref.set(statusRef, next);
      yield* PubSub.publish(statusPubSub, next);
    });
  const patchStatus = (patch: Partial<PrismStatus>) => updateStatus(() => patch);

  const publish = (endpoint: Option.Option<PrismEndpoint>) =>
    Ref.set(endpointRef, endpoint).pipe(
      Effect.andThen(Effect.sync(() => publishPrismEndpoint(Option.getOrUndefined(endpoint)))),
    );

  const setManagement = (management: Option.Option<{ baseUrl: string; secret: string }>) =>
    Ref.set(managementRef, management);

  const loadSecret = (name: string) =>
    secrets.getOrCreateRandom(name, SECRET_BYTES).pipe(
      Effect.map(toHex),
      Effect.mapError((cause) => new PrismSecretError({ cause })),
    );

  /** External mode never generates: a missing or blank secret is a configuration error with the fix in its message. */
  const readStoredSecret = (name: string) =>
    secrets.get(name).pipe(
      Effect.mapError((cause) => new PrismSecretError({ cause })),
      Effect.flatMap((stored) => {
        const value = Option.isSome(stored) ? new TextDecoder().decode(stored.value).trim() : "";
        return value === "" ? Effect.fail(new PrismSecretMissing({ name })) : Effect.succeed(value);
      }),
    );

  const ensureDirectory = (directory: string) =>
    fs
      .makeDirectory(directory, { recursive: true })
      .pipe(Effect.andThen(fs.chmod(directory, 0o700)));

  const materializeCodexHome = (endpoint: PrismEndpoint) =>
    materializeCodexProxyHome({ homeDir: directories.codexHomeDir, endpoint }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("prism: codex proxy home not materialized", {
          cause: error.message,
        }),
      ),
    );

  const becomeReady = (
    endpoint: PrismEndpoint,
    managementSecret: string,
    patch: (current: PrismStatus) => Partial<PrismStatus>,
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
  const runSidecar = Effect.fn("prism.runSidecar")(function* (section: PrismConfig, begin: Begin) {
    const port = section.port ?? PRISM_DEFAULT_PORT;
    yield* begin(port);

    const binary = yield* binaries.resolve({
      binaryPath: section.binaryPath,
      version: section.releaseVersion,
    });
    yield* patchStatus({ version: binary.version });

    yield* ensureDirectory(directories.rootDir);
    yield* ensureDirectory(directories.authsDir);
    const apiKey = yield* loadSecret(PRISM_DEFAULT_API_KEY_SECRET_NAME);
    const managementSecret = yield* loadSecret(PRISM_DEFAULT_MANAGEMENT_SECRET_NAME);
    const secretValues = [apiKey, managementSecret];
    yield* writePrismConfig(
      directories.configPath,
      renderPrismConfig({
        port,
        authDir: directories.authsDir,
        apiKey,
        managementSecret,
        routingStrategy: section.routingStrategy,
      }),
    );
    const endpoint: PrismEndpoint = { baseUrl: `http://127.0.0.1:${port}`, apiKey };
    yield* materializeCodexHome(endpoint);

    const child = yield* launcher.launch({
      binaryPath: binary.path,
      args: ["-config", directories.configPath],
      cwd: directories.rootDir,
    });
    yield* patchStatus({ pid: child.pid });
    yield* child.output.pipe(
      Stream.runForEach((line) => Effect.logDebug(`prism: ${redactSecrets(line, secretValues)}`)),
      Effect.ignoreCause(),
      Effect.forkScoped,
    );

    const exited = child.exit.pipe(
      Effect.flatMap((code) => Effect.fail(new PrismExited({ code }))),
    );
    yield* Effect.raceFirst(readiness.awaitReady({ port, managementSecret }), exited);

    yield* becomeReady(endpoint, managementSecret, () => ({}));
    yield* Effect.logInfo("prism: ready", { port, version: binary.version, pid: child.pid });
    return yield* exited;
  });

  // Validate the section and the secrets once, then probe on the health
  // interval until interrupted. Only the setup can fail; a probe failure is a
  // `failed` status the next probe can undo.
  const runExternal = Effect.fn("prism.runExternal")(function* (
    section: PrismConfig,
    begin: Begin,
  ) {
    const external = section.external;
    const parsed = external === undefined ? undefined : parsePrismBaseUrl(external.baseUrl);
    yield* begin(parsed?.port ?? PRISM_DEFAULT_PORT);
    if (external === undefined) {
      return yield* new PrismExternalConfigError({
        detail: 'prism.mode is "external" but fork.json has no prism.external section',
      });
    }
    if (parsed === undefined) {
      return yield* new PrismExternalConfigError({
        detail: `prism.external.baseUrl must be an absolute http(s) origin such as http://127.0.0.1:8317, got "${external.baseUrl}"`,
      });
    }
    const managementSecret = yield* readStoredSecret(
      external.managementSecretName ?? PRISM_DEFAULT_MANAGEMENT_SECRET_NAME,
    );
    const apiKey = yield* readStoredSecret(
      external.apiKeySecretName ?? PRISM_DEFAULT_API_KEY_SECRET_NAME,
    );
    const endpoint: PrismEndpoint = { baseUrl: parsed.baseUrl, apiKey };
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
          yield* Effect.logInfo("prism: external proxy ready", { baseUrl: parsed.baseUrl });
          wasReady = true;
        }
      } else if (current.state !== "failed" || current.lastError !== failure) {
        yield* unpublish;
        yield* patchStatus({ state: "failed", baseUrl: undefined, lastError: failure });
        yield* Effect.logWarning("prism: external proxy not reachable", {
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
      const section = (yield* flags.config).prism ?? {};
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
          Effect.logWarning("prism: proxy stopped, restarting", { cause: error.message }),
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
    yield* Effect.logInfo("prism: stopped");
  });

  const apply = (values: { readonly prism: boolean }) =>
    lifecycle.withPermits(1)(values.prism ? start : stop);

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

  const request: PrismService["Service"]["management"]["request"] = (requestPath, options) =>
    Effect.gen(function* () {
      const management = yield* Ref.get(managementRef);
      if (Option.isNone(management)) {
        return yield* new PrismManagementError({ reason: "not-ready", path: requestPath });
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
              new PrismManagementError({ reason: "request-failed", path: requestPath, cause }),
          ),
        );
    }).pipe(Effect.provide(FetchHttpClient.layer));

  return PrismService.of({
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

const untilTrue = (probe: Effect.Effect<boolean>, onTimeout: PrismNotReady) =>
  probe.pipe(
    Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(onTimeout))),
    Effect.retry(Schedule.spaced(READY_POLL)),
    Effect.timeoutOption(READY_TIMEOUT),
    Effect.flatMap(
      Option.match({ onNone: () => Effect.fail(onTimeout), onSome: () => Effect.void }),
    ),
  );

export const readinessLayer = Layer.succeed(
  PrismReadiness,
  PrismReadiness.of({
    awaitReady: ({ port, managementSecret }) =>
      untilTrue(tcpConnect(port), new PrismNotReady({ port, stage: "tcp" })).pipe(
        Effect.andThen(
          untilTrue(
            managementProbe(`http://127.0.0.1:${port}`, managementSecret).pipe(
              Effect.map((response) => response.status === 200),
              Effect.orElseSucceed(() => false),
            ),
            new PrismNotReady({ port, stage: "management" }),
          ),
        ),
      ),
    probe: ({ baseUrl, managementSecret }) =>
      managementProbe(baseUrl, managementSecret).pipe(
        Effect.mapError(
          (error) =>
            new PrismProbeFailed({
              baseUrl,
              detail: redactSecrets(error.message, [managementSecret]),
            }),
        ),
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.void
            : Effect.fail(
                new PrismProbeFailed({
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
  PrismLauncher,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return PrismLauncher.of({
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
                Effect.mapError((cause) => new PrismSpawnError({ path: input.binaryPath, cause })),
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
          } satisfies PrismChild;
        }),
    });
  }),
);

/** Production wiring. Needs ServerConfig, ForkFlagsService, ServerSecretStore, and the Node services from outside. */
export const layer = Layer.effect(PrismService, make).pipe(
  Layer.provide(PrismBinary.layer),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(launcherLayer),
  Layer.provide(readinessLayer),
);

/** The service body alone; tests supply the binary, launcher, readiness, and schedule. */
export const layerWithoutRuntime = Layer.effect(PrismService, make);

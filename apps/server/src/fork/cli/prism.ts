/**
 * `q1code prism status|accounts` - the Prism gateway as a fleet monitor sees
 * it, without the server running. Reads `fork.json` and the secret store from
 * the state directory (`--base-dir`, `--dev-url`, like `auth`), resolves the
 * gateway's base URL and management secret the way `PrismService` does, and
 * asks the management API directly.
 *
 * `status --json` prints one object with a fixed key set and exits 0 only
 * when the flag is on, the secret is stored, and the gateway answered every
 * call; every other outcome still prints the object, with `error`, and exits
 * 1. The secret is never printed.
 */
import {
  decodeForkConfigJson,
  type ForkConfig,
  FORK_CONFIG_FILENAME,
  PRISM_DEFAULT_MANAGEMENT_SECRET_NAME,
  type PrismConfig,
  PrismMode,
} from "@q1code/core/config";
import { envVarForFlag, resolveForkFlags } from "@q1code/core/flags";
import { PRISM_DEFAULT_PORT, PRISM_MANAGEMENT_PROBE_PATH } from "@q1code/core/prism";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";

import { authLocationFlags, type CliAuthLocationFlags } from "../../cli/config.ts";
import { ForkFlagsEnvironment, forkConfigPath } from "../ForkFlags.ts";
import { parsePrismBaseUrl, redactSecrets } from "../prism/PrismService.ts";
import { runWithSecretStore } from "./secret.ts";

/** The HTTP layer both subcommands talk to the gateway through; tests provide a scripted client. */
export const PrismCliHttp = Context.Reference<Layer.Layer<HttpClient.HttpClient>>(
  "t3/fork/cli/PrismCliHttp",
  { defaultValue: () => FetchHttpClient.layer },
);

/** One management call may take this long before it counts as unreachable. */
export const PRISM_CLI_TIMEOUT = Duration.seconds(5);

export const PRISM_OFF_ERROR = `prism is off (${envVarForFlag("prism")} / ${FORK_CONFIG_FILENAME} flags.prism)`;

/** What `status --json` prints: exactly these keys, `error` only when something is wrong. */
export const PrismStatusReport = Schema.Struct({
  mode: PrismMode,
  /** `null` only when the external section is missing or its `baseUrl` is not a bare origin. */
  baseUrl: Schema.NullOr(Schema.String),
  /** The gateway answered the management probe with 200. */
  reachable: Schema.Boolean,
  accounts: Schema.Int,
  disabled: Schema.Int,
  strategy: Schema.NullOr(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export type PrismStatusReport = typeof PrismStatusReport.Type;

/** One row of `accounts`: the auth file as the gateway lists it. */
export const PrismAccountReport = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  disabled: Schema.Boolean,
  weight: Schema.optionalKey(Schema.Number),
  requiresLogin: Schema.optionalKey(Schema.Boolean),
  expiresAt: Schema.optionalKey(Schema.String),
  lastRefreshedAt: Schema.optionalKey(Schema.String),
});
export type PrismAccountReport = typeof PrismAccountReport.Type;

export const encodePrismStatusReport = Schema.encodeSync(Schema.fromJsonString(PrismStatusReport));
export const encodePrismAccountReports = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(PrismAccountReport)),
);

const AuthFilesResponse = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.optionalKey(Schema.String),
      provider: Schema.optionalKey(Schema.String),
      disabled: Schema.optionalKey(Schema.Boolean),
      weight: Schema.optionalKey(Schema.Number),
      requires_login: Schema.optionalKey(Schema.Boolean),
      expires_at: Schema.optionalKey(Schema.String),
      last_refresh: Schema.optionalKey(Schema.String),
    }),
  ),
});
const RoutingResponse = Schema.Struct({ strategy: Schema.String });

/** `cause` carries the user-facing sentence. */
class PrismCliError extends CliError.UserError {
  override get message() {
    return typeof this.cause === "string" ? this.cause : "The prism command failed.";
  }
}

/** Exit 1 after the report was printed; the report already carries the message, so nothing is logged twice. */
class PrismStatusExit extends PrismCliError {
  override readonly [Runtime.errorReported] = false;
}

/** Where the gateway lives and which secret opens its management API, resolved like `PrismService` does. */
export interface PrismTarget {
  readonly mode: PrismMode;
  readonly baseUrl: string | null;
  readonly managementSecretName: string;
  readonly error?: string;
}

/** Pure: sidecar mode is loopback on the configured port; external mode is the configured origin. */
export const resolvePrismTarget = (section: PrismConfig | undefined): PrismTarget => {
  const mode = section?.mode ?? "sidecar";
  if (mode === "sidecar") {
    return {
      mode,
      baseUrl: `http://127.0.0.1:${section?.port ?? PRISM_DEFAULT_PORT}`,
      managementSecretName: PRISM_DEFAULT_MANAGEMENT_SECRET_NAME,
    };
  }
  const external = section?.external;
  const managementSecretName =
    external?.managementSecretName ?? PRISM_DEFAULT_MANAGEMENT_SECRET_NAME;
  if (external === undefined) {
    return {
      mode,
      baseUrl: null,
      managementSecretName,
      error: 'prism.mode is "external" but fork.json has no prism.external section',
    };
  }
  const parsed = parsePrismBaseUrl(external.baseUrl);
  if (parsed === undefined) {
    return {
      mode,
      baseUrl: null,
      managementSecretName,
      error: `prism.external.baseUrl must be an absolute http(s) origin such as http://127.0.0.1:8317, got "${external.baseUrl}"`,
    };
  }
  return { mode, baseUrl: parsed.baseUrl, managementSecretName };
};

/** A missing file is an empty config; a malformed one is an error the monitor should see. */
const readForkConfig = Effect.fn("prism.cli.readForkConfig")(function* (
  stateDir: string,
): Effect.fn.Return<
  Result.Result<ForkConfig, string>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = forkConfigPath(stateDir, path);
  if (!(yield* fs.exists(configPath))) return Result.succeed({});
  const decoded = decodeForkConfigJson(yield* fs.readFileString(configPath));
  if (Exit.isSuccess(decoded)) return Result.succeed(decoded.value);
  const detail = Cause.pretty(decoded.cause).split("\n")[0] ?? "invalid";
  return Result.fail(`${configPath} is malformed: ${detail}`);
});

type Gateway =
  | {
      readonly _tag: "unavailable";
      readonly mode: PrismMode;
      readonly baseUrl: string | null;
      readonly error: string;
    }
  | {
      readonly _tag: "ready";
      readonly mode: PrismMode;
      readonly baseUrl: string;
      readonly secret: string;
    };

/** Flag, config, and secret, in that order; the first thing missing names the fix. */
const resolveGateway = (flags: CliAuthLocationFlags) =>
  runWithSecretStore(flags, ({ secrets, config }) =>
    Effect.gen(function* () {
      const env = yield* ForkFlagsEnvironment;
      const read = yield* readForkConfig(config.stateDir);
      const forkConfig = Result.isSuccess(read) ? read.success : {};
      const target = resolvePrismTarget(forkConfig.prism);
      const unavailable = (error: string): Gateway => ({
        _tag: "unavailable",
        mode: target.mode,
        baseUrl: target.baseUrl,
        error,
      });
      if (Result.isFailure(read)) return unavailable(read.failure);
      if (!resolveForkFlags({ env, file: forkConfig.flags }).prism) {
        return unavailable(PRISM_OFF_ERROR);
      }
      if (target.error !== undefined || target.baseUrl === null) {
        return unavailable(target.error ?? "prism base URL could not be resolved");
      }
      const stored = yield* secrets
        .get(target.managementSecretName)
        .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
      if (Option.isNone(stored)) {
        return unavailable(
          `management secret "${target.managementSecretName}" is not stored; run q1code fork secret set ${target.managementSecretName}`,
        );
      }
      return {
        _tag: "ready",
        mode: target.mode,
        baseUrl: target.baseUrl,
        secret: new TextDecoder().decode(stored.value),
      } satisfies Gateway;
    }),
  );

/** The gateway answered, but not with 200. */
class GatewayRejected extends Schema.TaggedErrorClass<GatewayRejected>()("GatewayRejected", {
  message: Schema.String,
}) {}

/** `GET <baseUrl>/v0/management<path>` with the bearer secret, bounded by the timeout; any failure becomes one redacted sentence. */
const managementGet = <S extends Schema.Decoder<unknown>>(
  gateway: Extract<Gateway, { _tag: "ready" }>,
  path: string,
  schema: S,
): Effect.Effect<Result.Result<S["Type"], string>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .get(`${gateway.baseUrl}/v0/management${path}`, {
        headers: { Authorization: `Bearer ${gateway.secret}` },
      })
      .pipe(Effect.timeout(PRISM_CLI_TIMEOUT));
    if (response.status !== 200) {
      const hint =
        response.status === 401 || response.status === 403 ? "; check the management secret" : "";
      return yield* new GatewayRejected({
        message: `HTTP ${response.status} from GET ${path}${hint}`,
      });
    }
    return yield* HttpClientResponse.schemaBodyJson(schema)(response);
  }).pipe(
    Effect.result,
    Effect.map(
      Result.mapError((error) =>
        error._tag === "GatewayRejected"
          ? error.message
          : Cause.isTimeoutError(error)
            ? `GET ${path} timed out after ${Duration.format(PRISM_CLI_TIMEOUT)}`
            : `GET ${path} failed: ${redactSecrets(error.message, [gateway.secret])}`,
      ),
    ),
  );

const toAccountReport = (
  entry: (typeof AuthFilesResponse.Type)["files"][number],
): PrismAccountReport => ({
  id: entry.name,
  provider: entry.provider?.trim() || entry.type?.trim() || "unknown",
  disabled: entry.disabled ?? false,
  ...(entry.weight !== undefined ? { weight: entry.weight } : {}),
  ...(entry.requires_login !== undefined ? { requiresLogin: entry.requires_login } : {}),
  ...(entry.expires_at !== undefined ? { expiresAt: entry.expires_at } : {}),
  ...(entry.last_refresh !== undefined ? { lastRefreshedAt: entry.last_refresh } : {}),
});

/** Pins the success type of `collectStatus` so `error` reads as optional everywhere. */
const asReport = (report: PrismStatusReport): PrismStatusReport => report;

/** Probes local routing state, then counts accounts; the first failure ends the walk. */
const collectStatus = (flags: CliAuthLocationFlags) =>
  Effect.gen(function* () {
    const gateway = yield* resolveGateway(flags);
    const base = asReport({
      mode: gateway.mode,
      baseUrl: gateway.baseUrl,
      reachable: false,
      accounts: 0,
      disabled: 0,
      strategy: null,
    });
    if (gateway._tag === "unavailable") return asReport({ ...base, error: gateway.error });
    const httpLayer = yield* PrismCliHttp;
    return yield* Effect.gen(function* () {
      const probe = yield* managementGet(gateway, PRISM_MANAGEMENT_PROBE_PATH, RoutingResponse);
      if (Result.isFailure(probe)) return asReport({ ...base, error: probe.failure });
      const reachable = asReport({ ...base, reachable: true });
      const files = yield* managementGet(gateway, "/auth-files", AuthFilesResponse);
      if (Result.isFailure(files)) return asReport({ ...reachable, error: files.failure });
      const accounts = files.success.files.map(toAccountReport);
      const counted = asReport({
        ...reachable,
        accounts: accounts.length,
        disabled: accounts.filter((account) => account.disabled).length,
      });
      return asReport({ ...counted, strategy: probe.success.strategy });
    }).pipe(Effect.provide(httpLayer));
  });

/** One `key: value` line per report key, in the JSON order. */
export const formatPrismStatusReport = (report: PrismStatusReport): string =>
  [
    `mode: ${report.mode}`,
    `baseUrl: ${report.baseUrl ?? "(none)"}`,
    `reachable: ${report.reachable ? "yes" : "no"}`,
    `accounts: ${report.accounts}`,
    `disabled: ${report.disabled}`,
    `strategy: ${report.strategy ?? "(none)"}`,
    ...(report.error !== undefined ? [`error: ${report.error}`] : []),
  ].join("\n");

/** Fixed-width columns; `weight` is blank when the gateway did not report one. */
export const formatPrismAccountsTable = (accounts: ReadonlyArray<PrismAccountReport>): string => {
  if (accounts.length === 0) return "No accounts.";
  const lifecycle = accounts.some(
    (account) => account.requiresLogin !== undefined || account.expiresAt !== undefined,
  );
  const rows = accounts.map((account) => [
    account.id,
    account.provider,
    account.disabled ? "yes" : "no",
    account.weight === undefined ? "" : String(account.weight),
    ...(lifecycle
      ? [
          account.requiresLogin ? "sign-in required" : account.disabled ? "disabled" : "enabled",
          account.expiresAt ?? "unknown",
        ]
      : []),
  ]);
  const header = [
    "id",
    "provider",
    "disabled",
    "weight",
    ...(lifecycle ? ["health", "token expiry"] : []),
  ];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: ReadonlyArray<string>) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
};

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const prismStatusCommand = Command.make("status", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Probe the Prism gateway: mode, base URL, reachability, account counts, and routing strategy. Exit 1 when anything is wrong.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const report = yield* collectStatus(flags);
      yield* Console.log(
        flags.json ? encodePrismStatusReport(report) : formatPrismStatusReport(report),
      );
      if (report.error !== undefined) {
        return yield* new PrismStatusExit({ cause: report.error });
      }
    }),
  ),
);

const prismAccountsCommand = Command.make("accounts", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List the gateway's pooled accounts: id, provider, disabled, weight."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const gateway = yield* resolveGateway(flags);
      if (gateway._tag === "unavailable") {
        return yield* new PrismCliError({ cause: gateway.error });
      }
      const httpLayer = yield* PrismCliHttp;
      const files = yield* managementGet(gateway, "/auth-files", AuthFilesResponse).pipe(
        Effect.provide(httpLayer),
      );
      if (Result.isFailure(files)) {
        return yield* new PrismCliError({ cause: files.failure });
      }
      const accounts = files.success.files.map(toAccountReport);
      yield* Console.log(
        flags.json ? encodePrismAccountReports(accounts) : formatPrismAccountsTable(accounts),
      );
    }),
  ),
);

export const prismCommand = Command.make("prism").pipe(
  Command.withDescription("Inspect the Prism account gateway without a running server."),
  Command.withSubcommands([prismStatusCommand, prismAccountsCommand]),
);

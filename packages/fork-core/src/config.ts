/**
 * Schema for `fork.json`, the fork's own config file under the userdata
 * directory. Kept separate from upstream `settings.json` so the upstream
 * settings contract is never a seam. Unknown top-level and flag keys are
 * dropped, not rejected, so an older server can read a newer file.
 */
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { FORK_FLAG_KEYS, type ForkFlagKey } from "./flags.ts";

export const FORK_CONFIG_FILENAME = "fork.json";

const ForkFlagOverrides = Schema.Struct(
  Object.fromEntries(FORK_FLAG_KEYS.map((key) => [key, Schema.optionalKey(Schema.Boolean)])) as {
    readonly [K in ForkFlagKey]: Schema.optionalKey<typeof Schema.Boolean>;
  },
);

export const CliProxyRoutingStrategy = Schema.Literals([
  "round-robin",
  "weighted-round-robin",
  "fill-first",
]);
export type CliProxyRoutingStrategy = typeof CliProxyRoutingStrategy.Type;

export const CliProxySyncRole = Schema.Literals(["primary", "replica"]);
export type CliProxySyncRole = typeof CliProxySyncRole.Type;

export const CLIPROXY_SYNC_DEFAULT_INTERVAL_SECONDS = 300;
/** Secret-store names the sync reads when `fork.json` does not name others (`q1code fork secret set <name>`). */
export const CLIPROXY_SYNC_DEFAULT_TOKEN_SECRET_NAME = "cliproxy-sync-token";
export const CLIPROXY_SYNC_DEFAULT_KEY_SECRET_NAME = "cliproxy-sync-key";

/**
 * `cliproxy.sync` section: cross-machine auth-file sync. The bearer token and
 * the shared encryption secret are read from the server secret store first
 * (`tokenSecretName` / `sharedKeySecretName`, defaulting to the names above),
 * then from `Q1CODE_CLIPROXY_SYNC_TOKEN` / `Q1CODE_CLIPROXY_SYNC_KEY`.
 */
export const CliProxySyncConfig = Schema.Struct({
  role: CliProxySyncRole,
  /** Replica only: the primary's environment origin, e.g. `http://spark-01:3774`. */
  primaryUrl: Schema.optionalKey(Schema.String),
  /** Replica only: secret-store name of an admin-scoped bearer token issued on the primary. Default `cliproxy-sync-token`. */
  tokenSecretName: Schema.optionalKey(Schema.String),
  /** Secret-store name of the shared encryption secret; must match on every environment. Default `cliproxy-sync-key`. */
  sharedKeySecretName: Schema.optionalKey(Schema.String),
  /** Replica pull interval. Default 300. */
  intervalSeconds: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(5))),
});
export type CliProxySyncConfig = typeof CliProxySyncConfig.Type;

/**
 * `sidecar` (default): q1code spawns and supervises the bundled CLIProxyAPI.
 * `external`: q1code manages a CLIProxyAPI that something else runs (a container,
 * a system service) through its management API; nothing is spawned.
 */
export const CliProxyMode = Schema.Literals(["sidecar", "external"]);
export type CliProxyMode = typeof CliProxyMode.Type;

/** Secret-store names the sidecar generates into and external mode reads from (`q1code fork secret set <name>`). */
export const CLIPROXY_DEFAULT_MANAGEMENT_SECRET_NAME = "cliproxy-management-secret";
export const CLIPROXY_DEFAULT_API_KEY_SECRET_NAME = "cliproxy-api-key";

/** `cliproxy.external` section: where the externally managed CLIProxyAPI lives and how to talk to it. */
export const CliProxyExternalConfig = Schema.Struct({
  /** Origin of the running proxy, e.g. `http://127.0.0.1:8317`. No trailing slash, no path. */
  baseUrl: Schema.String,
  /** Secret-store name of the proxy's `remote-management.secret-key`. Default `cliproxy-management-secret`. */
  managementSecretName: Schema.optionalKey(Schema.String),
  /** Secret-store name of an API key the proxy accepts from clients; provider CLIs send it. Default `cliproxy-api-key`. */
  apiKeySecretName: Schema.optionalKey(Schema.String),
  /** The proxy's `auth-dir` on this host, when sync should read and write it directly. */
  authDir: Schema.optionalKey(Schema.String),
});
export type CliProxyExternalConfig = typeof CliProxyExternalConfig.Type;

/** `cliproxy` section: the few sidecar knobs a user may pin from the file. Everything else is generated. */
export const CliProxyConfig = Schema.Struct({
  /** Default `sidecar`. `external` requires the `external` section. */
  mode: Schema.optionalKey(CliProxyMode),
  external: Schema.optionalKey(CliProxyExternalConfig),
  /** Loopback port the sidecar listens on. Default 8317. Ignored in external mode. */
  port: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  routingStrategy: Schema.optionalKey(CliProxyRoutingStrategy),
  /** Use this executable instead of the bundled or downloaded one. */
  binaryPath: Schema.optionalKey(Schema.String),
  /** Download this upstream release instead of the pinned one. */
  releaseVersion: Schema.optionalKey(Schema.String),
  sync: Schema.optionalKey(CliProxySyncConfig),
});
export type CliProxyConfig = typeof CliProxyConfig.Type;

export const ForkConfig = Schema.Struct({
  flags: Schema.optionalKey(ForkFlagOverrides),
  cliproxy: Schema.optionalKey(CliProxyConfig),
});
export type ForkConfig = typeof ForkConfig.Type;

export const EMPTY_FORK_CONFIG: ForkConfig = {};

/** Decode an already-parsed JSON value. */
export const decodeForkConfig: (input: unknown) => Exit.Exit<ForkConfig, Schema.SchemaError> =
  Schema.decodeUnknownExit(ForkConfig);

/** Decode raw file contents. */
export const decodeForkConfigJson: (input: unknown) => Exit.Exit<ForkConfig, Schema.SchemaError> =
  Schema.decodeUnknownExit(Schema.fromJsonString(ForkConfig));

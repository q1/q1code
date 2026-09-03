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

/**
 * `cliproxy.sync` section: cross-machine auth-file sync. The bearer token and
 * the shared encryption secret come from `Q1CODE_CLIPROXY_SYNC_TOKEN` and
 * `Q1CODE_CLIPROXY_SYNC_KEY`, or from the server secret store under the names
 * given here when those variables are unset.
 */
export const CliProxySyncConfig = Schema.Struct({
  role: CliProxySyncRole,
  /** Replica only: the primary's environment origin, e.g. `http://spark-01:3774`. */
  primaryUrl: Schema.optionalKey(Schema.String),
  /** Replica only: secret-store name of an admin-scoped bearer token issued on the primary. */
  tokenSecretName: Schema.optionalKey(Schema.String),
  /** Secret-store name of the shared encryption secret; must match on every environment. */
  sharedKeySecretName: Schema.optionalKey(Schema.String),
  /** Replica pull interval. Default 300. */
  intervalSeconds: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(5))),
});
export type CliProxySyncConfig = typeof CliProxySyncConfig.Type;

/** `cliproxy` section: the few sidecar knobs a user may pin from the file. Everything else is generated. */
export const CliProxyConfig = Schema.Struct({
  /** Loopback port the sidecar listens on. Default 8317. */
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

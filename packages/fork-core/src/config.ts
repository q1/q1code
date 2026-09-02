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

/** `cliproxy` section: the few sidecar knobs a user may pin from the file. Everything else is generated. */
export const CliProxyConfig = Schema.Struct({
  /** Loopback port the sidecar listens on. Default 8317. */
  port: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  routingStrategy: Schema.optionalKey(CliProxyRoutingStrategy),
  /** Use this executable instead of the bundled or downloaded one. */
  binaryPath: Schema.optionalKey(Schema.String),
  /** Download this upstream release instead of the pinned one. */
  releaseVersion: Schema.optionalKey(Schema.String),
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

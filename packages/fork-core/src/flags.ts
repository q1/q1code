/**
 * Fork feature-flag registry. Adding a flag is one entry here; every consumer
 * (server resolution, capabilities wire, client hooks, the Settings section)
 * derives its types from this object.
 *
 * Resolution order on the server: `T3FORK_<SLUG>` env var, then `fork.json`
 * under the userdata directory, then the registry default.
 */
export const FORK_FLAGS = {
  "update-check": {
    description: "Poll q1/q1code GitHub Releases daily and surface a newer version to clients",
    scope: "server",
    default: false,
  },
  cliproxy: {
    description: "Run the bundled CLIProxyAPI sidecar and route provider CLIs through it",
    scope: "both",
    default: false,
  },
} as const satisfies Record<string, ForkFlagDefinition>;

export interface ForkFlagDefinition {
  readonly description: string;
  /** Who consults the flag: the server, the clients, or both. */
  readonly scope: "server" | "client" | "both";
  readonly default: boolean;
}

export type ForkFlagKey = keyof typeof FORK_FLAGS;
export type ForkFlagValues = Readonly<Record<ForkFlagKey, boolean>>;

export const FORK_FLAG_KEYS: ReadonlyArray<ForkFlagKey> = Object.keys(
  FORK_FLAGS,
) as Array<ForkFlagKey>;

export const isForkFlagKey = (key: string): key is ForkFlagKey =>
  Object.prototype.hasOwnProperty.call(FORK_FLAGS, key);

export const DEFAULT_FORK_FLAGS: ForkFlagValues = Object.fromEntries(
  FORK_FLAG_KEYS.map((key) => [key, FORK_FLAGS[key].default]),
) as Record<ForkFlagKey, boolean>;

/** Environment variable that overrides a flag: `update-check` -> `T3FORK_UPDATE_CHECK`. */
export const envVarForFlag = (key: ForkFlagKey): string =>
  `T3FORK_${key.replace(/-/g, "_").toUpperCase()}`;

const parseEnvFlag = (raw: string | undefined): boolean | undefined => {
  switch (raw?.trim().toLowerCase()) {
    case "1":
    case "true":
      return true;
    case "0":
    case "false":
      return false;
    default:
      return undefined;
  }
};

export interface ResolveForkFlagsInput {
  /** Process environment; only `T3FORK_*` entries are consulted. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** The `flags` section of `fork.json`. Unknown keys are ignored. */
  readonly file?: Readonly<Record<string, boolean | undefined>> | undefined;
}

/** Resolve every registry flag: env beats file beats registry default. Pure. */
export const resolveForkFlags = ({ env, file }: ResolveForkFlagsInput): ForkFlagValues =>
  Object.fromEntries(
    FORK_FLAG_KEYS.map((key) => [
      key,
      parseEnvFlag(env?.[envVarForFlag(key)]) ?? file?.[key] ?? FORK_FLAGS[key].default,
    ]),
  ) as Record<ForkFlagKey, boolean>;

/**
 * The pinned CLIProxyAPI release and the pure helpers that name its assets.
 * `prism.pin.json` is the single place the version lives: the server's
 * on-demand download, the release workflow's bundling step, and the Codex/
 * Claude wiring all read it from here.
 */
import pin from "./prism.pin.json" with { type: "json" };
import type { PrismAccount } from "./prismApi.ts";

export const PRISM_PIN = pin;

/** Name of the executable inside every release archive. */
export const PRISM_BINARY_NAME = "cli-proxy-api";

export const PRISM_DEFAULT_PORT = 8317;

/** Authenticated, local-only gateway state; readiness must not depend on GitHub release access. */
export const PRISM_MANAGEMENT_PROBE_PATH = "/routing/strategy";

/** Separates an expired access token from an account that needs a new login. */
export const prismAccountHealth = (
  account: Pick<PrismAccount, "disabled" | "lifecycle">,
  now: number,
) => {
  if (account.disabled) return "disabled";
  const lifecycle = account.lifecycle;
  if (lifecycle === undefined) return "unknown";
  if (lifecycle.lastErrorStatus === 401) return "needs-login";
  if (lifecycle.retryAt !== undefined && Date.parse(lifecycle.retryAt) > now) return "cooldown";
  if (lifecycle.unavailable || lifecycle.status === "error") return "unavailable";
  if (lifecycle.expiresAt !== undefined && Date.parse(lifecycle.expiresAt) <= now) return "expired";
  if (lifecycle.status === "active") return "ready";
  return "unknown";
};

export const PRISM_ACCOUNT_HEALTH_LABELS = {
  disabled: "Disabled",
  "needs-login": "Sign-in required",
  cooldown: "Waiting to retry",
  unavailable: "Unavailable",
  expired: "Token expired",
  ready: "Ready",
  unknown: "Health unknown",
} as const;

export type PrismPlatformKey = keyof typeof pin.platforms;

export const PRISM_PLATFORM_KEYS = Object.keys(pin.platforms) as ReadonlyArray<PrismPlatformKey>;

/** `darwin-arm64`, `linux-x64`, ... matching the resource monitor's bundle layout, or undefined when no release exists. */
export const prismPlatformKey = (
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): PrismPlatformKey | undefined => {
  const key = `${platform}-${architecture}`;
  return Object.prototype.hasOwnProperty.call(pin.platforms, key)
    ? (key as PrismPlatformKey)
    : undefined;
};

/** Windows releases are zip archives; everything else is a gzipped tarball. */
export const prismArchiveKind = (platform: NodeJS.Platform): "tar.gz" | "zip" =>
  platform === "win32" ? "zip" : "tar.gz";

export const prismExecutableName = (platform: NodeJS.Platform): string =>
  platform === "win32" ? `${PRISM_BINARY_NAME}.exe` : PRISM_BINARY_NAME;

/** `CLIProxyAPI_7.2.147_darwin_aarch64.tar.gz`, or undefined for an unsupported platform. */
export const prismAssetName = (
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
  version: string = pin.version,
): string | undefined => {
  const key = prismPlatformKey(platform, architecture);
  if (key === undefined) return undefined;
  return `CLIProxyAPI_${version}_${pin.platforms[key]}.${prismArchiveKind(platform)}`;
};

const releaseAssetUrl = (version: string, asset: string) =>
  `https://github.com/${pin.repository}/releases/download/v${version}/${asset}`;

export const prismReleaseUrl = (
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
  version: string = pin.version,
): string | undefined => {
  const asset = prismAssetName(platform, architecture, version);
  return asset === undefined ? undefined : releaseAssetUrl(version, asset);
};

export const prismChecksumsUrl = (version: string = pin.version): string =>
  releaseAssetUrl(version, "checksums.txt");

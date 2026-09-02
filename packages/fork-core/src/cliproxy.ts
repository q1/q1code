/**
 * The pinned CLIProxyAPI release and the pure helpers that name its assets.
 * `cliproxy.pin.json` is the single place the version lives: the server's
 * on-demand download, the release workflow's bundling step, and the Codex/
 * Claude wiring all read it from here.
 */
import pin from "./cliproxy.pin.json" with { type: "json" };

export const CLIPROXY_PIN = pin;

/** Name of the executable inside every release archive. */
export const CLIPROXY_BINARY_NAME = "cli-proxy-api";

export const CLIPROXY_DEFAULT_PORT = 8317;

export type CliProxyPlatformKey = keyof typeof pin.platforms;

export const CLIPROXY_PLATFORM_KEYS = Object.keys(
  pin.platforms,
) as ReadonlyArray<CliProxyPlatformKey>;

/** `darwin-arm64`, `linux-x64`, ... matching the resource monitor's bundle layout, or undefined when no release exists. */
export const cliproxyPlatformKey = (
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): CliProxyPlatformKey | undefined => {
  const key = `${platform}-${architecture}`;
  return Object.prototype.hasOwnProperty.call(pin.platforms, key)
    ? (key as CliProxyPlatformKey)
    : undefined;
};

/** Windows releases are zip archives; everything else is a gzipped tarball. */
export const cliproxyArchiveKind = (platform: NodeJS.Platform): "tar.gz" | "zip" =>
  platform === "win32" ? "zip" : "tar.gz";

export const cliproxyExecutableName = (platform: NodeJS.Platform): string =>
  platform === "win32" ? `${CLIPROXY_BINARY_NAME}.exe` : CLIPROXY_BINARY_NAME;

/** `CLIProxyAPI_7.2.147_darwin_aarch64.tar.gz`, or undefined for an unsupported platform. */
export const cliproxyAssetName = (
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
  version: string = pin.version,
): string | undefined => {
  const key = cliproxyPlatformKey(platform, architecture);
  if (key === undefined) return undefined;
  return `CLIProxyAPI_${version}_${pin.platforms[key]}.${cliproxyArchiveKind(platform)}`;
};

const releaseAssetUrl = (version: string, asset: string) =>
  `https://github.com/${pin.repository}/releases/download/v${version}/${asset}`;

export const cliproxyReleaseUrl = (
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
  version: string = pin.version,
): string | undefined => {
  const asset = cliproxyAssetName(platform, architecture, version);
  return asset === undefined ? undefined : releaseAssetUrl(version, asset);
};

export const cliproxyChecksumsUrl = (version: string = pin.version): string =>
  releaseAssetUrl(version, "checksums.txt");

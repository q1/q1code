/**
 * The q1code identity. Upstream strings stay upstream everywhere except at the
 * seams that identify this build: package/bin name, home directory, service
 * unit name, release download URLs, and the app title. Not a global rename.
 */
export const BRAND = Object.freeze({
  productName: "q1code",
  cliName: "q1code",
  /** Internal npm package name, kept as upstream's so `--filter t3` and service keys stay untouched. */
  packageName: "t3",
  /** Prefix for user-facing release assets (tarball name). */
  releaseAssetPrefix: "q1code",
  homeDirName: ".q1code",
  releaseRepository: "q1/q1code",
  releaseBaseUrl: "https://github.com/q1/q1code/releases/download",
  /** systemd/launchd unit base name; distinct from stock `t3code` so both can coexist. */
  serviceName: "q1code",
  /** Where `npm install <tarball>` puts the CLI entry inside a pinned runtime directory. */
  runtimeEntryRelativePath: "node_modules/t3/dist/bin.mjs",
  /** Upstream product this build is derived from, shown next to the version. */
  upstreamProductName: "T3 Code",
} as const);

const releaseVersionTag = (version: string) => `v${version}`;

/** Release asset filename for the server tarball published by fork-release. */
export const releaseTarballName = (version: string) => `${BRAND.releaseAssetPrefix}-${version}.tgz`;

/** Exact-version release asset URL, e.g. `.../download/v0.0.39-q1.1/q1code-0.0.39-q1.1.tgz`. */
export const releaseAssetUrl = (version: string, asset: string) =>
  `${BRAND.releaseBaseUrl}/${releaseVersionTag(version)}/${asset}`;

export const releaseTarballUrl = (version: string) =>
  releaseAssetUrl(version, releaseTarballName(version));

export const releaseChecksumsUrl = (version: string) => releaseAssetUrl(version, "checksums.txt");

export const releaseInstallScriptUrl = (version: string) => releaseAssetUrl(version, "install.sh");

/** The command handed to users whose server cannot update itself. */
export const manualInstallCommand = (version: string) =>
  `curl -fsSL ${releaseInstallScriptUrl(version)} | sh -s -- ${version}`;

const FORK_PRERELEASE_SUFFIX = /-q1(?:nightly)?\.[0-9A-Za-z.-]+$/;

/**
 * The upstream T3 Code version a q1code version is built on: `0.0.39-q1.3`
 * and `0.0.39-q1nightly.20260901.12` both map to `0.0.39`. Versions without a
 * q1 suffix are upstream versions already.
 */
export const upstreamVersionOf = (version: string) => version.replace(FORK_PRERELEASE_SUFFIX, "");

/** About/version label: `<version> on T3 Code <upstream version>`. */
export const formatAboutVersion = (version: string) =>
  `${version} on ${BRAND.upstreamProductName} ${upstreamVersionOf(version)}`;

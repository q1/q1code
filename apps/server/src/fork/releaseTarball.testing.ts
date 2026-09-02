import { releaseChecksumsUrl, releaseTarballName, releaseTarballUrl } from "@q1code/core/brand";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ReleaseDownloader, ReleaseDownloadError, sha256Hex } from "./releaseTarball.ts";

/**
 * In-memory GitHub release for tests: serves `checksums.txt` and the tarball
 * for one version. `checksums` overrides the published text to simulate a
 * mismatch or a missing entry; `tarball` overrides the bytes.
 */
export function releaseDownloaderTestLayer(
  version: string,
  options: {
    readonly tarball?: Uint8Array;
    readonly checksums?: string;
  } = {},
): Layer.Layer<ReleaseDownloader> {
  const tarball = options.tarball ?? new TextEncoder().encode(`fake tarball ${version}\n`);
  const checksums = options.checksums ?? `${sha256Hex(tarball)}  ${releaseTarballName(version)}\n`;
  const assets = new Map<string, Uint8Array>([
    [releaseChecksumsUrl(version), new TextEncoder().encode(checksums)],
    [releaseTarballUrl(version), tarball],
  ]);
  return Layer.succeed(ReleaseDownloader, {
    download: (url) => {
      const bytes = assets.get(url);
      return bytes === undefined
        ? Effect.fail(new ReleaseDownloadError({ url }))
        : Effect.succeed(bytes);
    },
  });
}

import {
  BRAND,
  releaseChecksumsUrl,
  releaseTarballName,
  releaseTarballUrl,
} from "@q1code/core/brand";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as NodeCrypto from "node:crypto";

/**
 * GitHub-only distribution for the pinned runtime. Upstream installs
 * `t3@<version>` from the npm registry, which carries an integrity field.
 * A GitHub release asset does not, so the tarball is downloaded here, checked
 * against the release's `checksums.txt` (`<sha256>  <asset name>` lines, as
 * `sha256sum` prints), and only then handed to `npm install` as a local file.
 */

export class ReleaseTarballError extends Schema.TaggedErrorClass<ReleaseTarballError>()(
  "ReleaseTarballError",
  {
    reason: Schema.Literals([
      "download-failed",
      "checksum-missing",
      "checksum-mismatch",
      "write-failed",
    ]),
    version: Schema.String,
    asset: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  /** Reads as a `PinnedRuntimeInstallError` step so the existing install error keeps its shape. */
  get step(): string {
    switch (this.reason) {
      case "download-failed":
        return `downloading ${this.asset} from the ${BRAND.productName} release`;
      case "checksum-missing":
        return `finding ${this.asset} in the release checksums`;
      case "checksum-mismatch":
        return `verifying the sha256 of ${this.asset}`;
      case "write-failed":
        return `saving ${this.asset} for install`;
    }
  }

  override get message(): string {
    return `Release tarball for ${BRAND.packageName}@${this.version} failed while ${this.step}.`;
  }
}

export class ReleaseDownloadError extends Schema.TaggedErrorClass<ReleaseDownloadError>()(
  "ReleaseDownloadError",
  {
    url: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not download ${this.url}.`;
  }
}

/** Fetches a release asset as bytes. Tests provide a fake; production uses fetch. */
export class ReleaseDownloader extends Context.Service<
  ReleaseDownloader,
  {
    readonly download: (url: string) => Effect.Effect<Uint8Array, ReleaseDownloadError>;
  }
>()("t3/fork/releaseTarball/ReleaseDownloader") {}

const fetchDownloader: ReleaseDownloader["Service"] = {
  download: (url) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client
        .get(url)
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      return new Uint8Array(yield* response.arrayBuffer);
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError((cause) => new ReleaseDownloadError({ url, cause })),
    ),
};

export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      entries.set(match[2], match[1].toLowerCase());
    }
  }
  return entries;
}

export const sha256Hex = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/**
 * Downloads and verifies `<packageName>-<version>.tgz` into `directory`, then
 * returns the local tarball path for `npm install`. Fails closed: no checksum
 * entry or a mismatch never leaves a tarball behind.
 */
export const stageReleaseTarball = Effect.fn("fork.release_tarball.stage")(function* (
  input: {
    readonly version: string;
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
  },
  directory: string,
) {
  const downloader = Option.getOrElse(
    yield* Effect.serviceOption(ReleaseDownloader),
    () => fetchDownloader,
  );
  const asset = releaseTarballName(input.version);
  const fail = (reason: ReleaseTarballError["reason"], cause?: unknown) =>
    new ReleaseTarballError({ reason, version: input.version, asset, cause });

  const checksumsText = yield* downloader.download(releaseChecksumsUrl(input.version)).pipe(
    Effect.map((bytes) => new TextDecoder().decode(bytes)),
    Effect.mapError((cause) => fail("download-failed", cause)),
  );
  const expected = parseChecksums(checksumsText).get(asset);
  if (expected === undefined) {
    return yield* fail("checksum-missing");
  }

  const tarball = yield* downloader
    .download(releaseTarballUrl(input.version))
    .pipe(Effect.mapError((cause) => fail("download-failed", cause)));
  if (sha256Hex(tarball) !== expected) {
    return yield* fail("checksum-mismatch");
  }

  const tarballPath = input.path.join(directory, asset);
  yield* input.fs
    .writeFile(tarballPath, tarball)
    .pipe(Effect.mapError((cause) => fail("write-failed", cause)));
  return tarballPath;
});

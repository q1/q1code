// @effect-diagnostics nodeBuiltinImport:off
/**
 * Where the CLIProxyAPI executable comes from, in order: an explicit
 * `fork.json.prism.binaryPath`, the copy `fork-release.yml` bundles next to
 * the server entry (`dist/prism/<platform-arch>/cli-proxy-api`), a cached
 * download under `<baseDir>/prism/bin/<version>/`, and finally a fresh
 * download of the pinned GitHub release verified against its `checksums.txt`.
 */
import {
  PRISM_PIN,
  prismArchiveKind,
  prismAssetName,
  prismChecksumsUrl,
  prismExecutableName,
  prismPlatformKey,
  prismReleaseUrl,
} from "@q1code/core/prism";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodePath from "node:path";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import {
  ReleaseDownloader,
  fetchReleaseDownloader,
  parseChecksums,
  sha256Hex,
} from "../releaseTarball.ts";
import { prismDirectories } from "./PrismConfig.ts";

export class PrismBinaryUnsupported extends Schema.TaggedErrorClass<PrismBinaryUnsupported>()(
  "PrismBinaryUnsupported",
  {
    platform: Schema.String,
    architecture: Schema.String,
  },
) {
  override get message(): string {
    return `CLIProxyAPI has no release for ${this.platform}/${this.architecture}.`;
  }
}

export class PrismBinaryNotFound extends Schema.TaggedErrorClass<PrismBinaryNotFound>()(
  "PrismBinaryNotFound",
  {
    path: Schema.String,
  },
) {
  override get message(): string {
    return `CLIProxyAPI binary was not found at '${this.path}'.`;
  }
}

export class PrismBinaryNotExecutable extends Schema.TaggedErrorClass<PrismBinaryNotExecutable>()(
  "PrismBinaryNotExecutable",
  {
    path: Schema.String,
    mode: Schema.Number,
  },
) {
  override get message(): string {
    return `CLIProxyAPI binary at '${this.path}' is not executable.`;
  }
}

export class PrismBinaryDownloadError extends Schema.TaggedErrorClass<PrismBinaryDownloadError>()(
  "PrismBinaryDownloadError",
  {
    reason: Schema.Literals([
      "download-failed",
      "checksum-missing",
      "checksum-mismatch",
      "extract-failed",
      "write-failed",
      "unsupported-archive",
    ]),
    version: Schema.String,
    asset: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `CLIProxyAPI ${this.version} download failed (${this.reason}) for ${this.asset}.`;
  }
}

const isDownloadError = Schema.is(PrismBinaryDownloadError);

export type PrismBinaryError =
  | PrismBinaryUnsupported
  | PrismBinaryNotFound
  | PrismBinaryNotExecutable
  | PrismBinaryDownloadError;

export interface ResolvedPrismBinary {
  readonly path: string;
  /** Upstream release version, or `custom` for an explicit `binaryPath`. */
  readonly version: string;
  readonly source: "override" | "bundled" | "cache" | "download";
}

export interface PrismBinaryOptions {
  readonly binaryPath?: string | undefined;
  readonly version?: string | undefined;
}

/** Directories that may hold `<platform-arch>/cli-proxy-api`; tests point this at a temp dir. */
export const PrismBundledRoots = Context.Reference<ReadonlyArray<string>>(
  "t3/fork/prism/PrismBinary/PrismBundledRoots",
  {
    // `import.meta.dirname` is `dist/` in the packed server and this source
    // directory in dev; both resolve to `apps/server/dist/prism/`.
    defaultValue: () => [
      NodePath.resolve(import.meta.dirname, "prism"),
      NodePath.resolve(import.meta.dirname, "../../../dist/prism"),
    ],
  },
);

export class PrismBinary extends Context.Service<
  PrismBinary,
  {
    readonly resolve: (
      options?: PrismBinaryOptions,
    ) => Effect.Effect<ResolvedPrismBinary, PrismBinaryError>;
  }
>()("t3/fork/prism/PrismBinary") {}

export const make = Effect.fn("prism.binary.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const downloader = Option.getOrElse(
    yield* Effect.serviceOption(ReleaseDownloader),
    () => fetchReleaseDownloader,
  );
  const executableName = prismExecutableName(platform);
  const platformKey = prismPlatformKey(platform, architecture);
  const directories = prismDirectories(config.baseDir, path);
  const bundledRoots = yield* PrismBundledRoots;
  const bundledCandidates =
    platformKey === undefined
      ? []
      : bundledRoots.map((root) => path.join(root, platformKey, executableName));

  const executableAt = Effect.fn("prism.binary.executableAt")(function* (candidate: string) {
    const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return Option.none<string>();
    if (platform !== "win32") {
      const stat = yield* fs.stat(candidate).pipe(Effect.option);
      if (Option.isSome(stat) && (stat.value.mode & 0o111) === 0) {
        // npm installs can drop the executable bit from bundled binaries; restore it once.
        const restored = yield* fs
          .chmod(candidate, 0o755)
          .pipe(Effect.andThen(fs.stat(candidate)), Effect.option);
        if (Option.isNone(restored) || (restored.value.mode & 0o111) === 0) {
          return yield* new PrismBinaryNotExecutable({ path: candidate, mode: stat.value.mode });
        }
      }
    }
    return Option.some(candidate);
  });

  const download = Effect.fn("prism.binary.download")(function* (
    version: string,
    target: string,
  ): Effect.fn.Return<string, PrismBinaryError> {
    const asset = prismAssetName(platform, architecture, version);
    if (asset === undefined) {
      return yield* new PrismBinaryUnsupported({ platform, architecture });
    }
    const fail = (reason: PrismBinaryDownloadError["reason"], cause?: unknown) =>
      new PrismBinaryDownloadError({ reason, version, asset, cause });
    if (prismArchiveKind(platform) !== "tar.gz") {
      return yield* fail("unsupported-archive");
    }
    const checksums = yield* downloader.download(prismChecksumsUrl(version)).pipe(
      Effect.map((bytes) => parseChecksums(new TextDecoder().decode(bytes))),
      Effect.mapError((cause) => fail("download-failed", cause)),
    );
    const expected = checksums.get(asset);
    if (expected === undefined) {
      return yield* fail("checksum-missing");
    }
    const url = prismReleaseUrl(platform, architecture, version);
    if (url === undefined) {
      return yield* new PrismBinaryUnsupported({ platform, architecture });
    }
    const archive = yield* downloader
      .download(url)
      .pipe(Effect.mapError((cause) => fail("download-failed", cause)));
    if (sha256Hex(archive) !== expected) {
      return yield* fail("checksum-mismatch");
    }

    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* fs.makeDirectory(directories.binDir, { recursive: true });
        const staging = yield* fs.makeTempDirectoryScoped({
          directory: directories.binDir,
          prefix: `${version}.download-`,
        });
        const archivePath = path.join(staging, asset);
        yield* fs.writeFile(archivePath, archive);
        const listing = yield* runner.run({
          command: "tar",
          args: ["-tzf", archivePath],
          cwd: staging,
          timeout: "2 minutes",
        });
        const member = listing.stdout
          .split("\n")
          .find((entry) => entry === executableName || entry === `./${executableName}`);
        if (listing.code !== 0 || member === undefined)
          return yield* fail(
            "extract-failed",
            new Error("Release archive has no root executable."),
          );
        const extracted = yield* runner.run({
          command: "tar",
          args: ["-xzf", archivePath, "-C", staging, member],
          cwd: staging,
          timeout: "2 minutes",
        });
        if (extracted.code !== 0) {
          return yield* fail("extract-failed", new Error(extracted.stderr.trim()));
        }
        const extractedPath = path.join(staging, executableName);
        yield* fs.chmod(extractedPath, 0o755);
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.rename(extractedPath, target);
        return target;
      }),
    ).pipe(
      Effect.catchIf(
        (error): error is Exclude<typeof error, PrismBinaryDownloadError> =>
          !isDownloadError(error),
        (cause) => fail("write-failed", cause),
      ),
    );
  });

  const resolve: PrismBinary["Service"]["resolve"] = Effect.fn("prism.binary.resolve")(function* (
    options = {},
  ) {
    const override = options.binaryPath?.trim();
    if (override !== undefined && override.length > 0) {
      const found = yield* executableAt(override);
      if (Option.isNone(found)) {
        return yield* new PrismBinaryNotFound({ path: override });
      }
      return { path: found.value, version: "custom", source: "override" } as const;
    }
    if (platformKey === undefined) {
      return yield* new PrismBinaryUnsupported({ platform, architecture });
    }
    for (const candidate of bundledCandidates) {
      const found = yield* executableAt(candidate);
      if (Option.isSome(found)) {
        return { path: found.value, version: PRISM_PIN.version, source: "bundled" } as const;
      }
    }
    const version = options.version?.trim() || PRISM_PIN.version;
    const cached = path.join(directories.binDir, version, executableName);
    const found = yield* executableAt(cached);
    if (Option.isSome(found)) {
      return { path: found.value, version, source: "cache" } as const;
    }
    const downloaded = yield* download(version, cached);
    return { path: downloaded, version, source: "download" } as const;
  });

  return PrismBinary.of({ resolve });
});

export const layer = Layer.effect(PrismBinary, make());

import * as NodeServices from "@effect/platform-node/NodeServices";
import { PRISM_PIN, prismAssetName, prismChecksumsUrl, prismReleaseUrl } from "@q1code/core/prism";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { ReleaseDownloader, ReleaseDownloadError, sha256Hex } from "../releaseTarball.ts";
import {
  PrismBinary,
  PrismBinaryDownloadError,
  PrismBinaryUnsupported,
  PrismBundledRoots,
  layer as binaryLayer,
} from "./PrismBinary.ts";

const isDownloadError = Schema.is(PrismBinaryDownloadError);
const isUnsupported = Schema.is(PrismBinaryUnsupported);

const PLATFORM = "linux" as const;
const ARCHITECTURE = "arm64" as const;
const VERSION = PRISM_PIN.version;
const ASSET = prismAssetName(PLATFORM, ARCHITECTURE, VERSION)!;

/** A real tar.gz holding a shell script named like the upstream binary. */
const makeArchive = Effect.fn("test.makeArchive")(function* (directory: string, dotPrefix = false) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const staging = path.join(directory, "archive-src");
  yield* fs.makeDirectory(staging, { recursive: true });
  yield* fs.writeFileString(path.join(staging, "cli-proxy-api"), "#!/bin/sh\necho fake\n");
  const archivePath = path.join(directory, ASSET);
  const result = yield* runner.run({
    command: "tar",
    args: ["-czf", archivePath, "-C", staging, dotPrefix ? "./cli-proxy-api" : "cli-proxy-api"],
  });
  assert.equal(result.code, 0, result.stderr);
  return yield* fs.readFile(archivePath);
});

const makeDownloader = (
  assets: ReadonlyMap<string, Uint8Array>,
): { readonly layer: Layer.Layer<ReleaseDownloader>; readonly urls: Array<string> } => {
  const urls: Array<string> = [];
  return {
    urls,
    layer: Layer.succeed(ReleaseDownloader, {
      download: (url) => {
        urls.push(url);
        const bytes = assets.get(url);
        return bytes === undefined
          ? Effect.fail(new ReleaseDownloadError({ url }))
          : Effect.succeed(bytes);
      },
    }),
  };
};

const makeLayers = (input: {
  readonly baseDir: string;
  readonly bundledRoot: string;
  readonly downloader: Layer.Layer<ReleaseDownloader>;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
}) =>
  binaryLayer.pipe(
    Layer.provide(ProcessRunner.layer),
    Layer.provide(input.downloader),
    Layer.provide(Layer.succeed(PrismBundledRoots, [input.bundledRoot])),
    Layer.provide(Layer.succeed(HostProcessPlatform, input.platform ?? PLATFORM)),
    Layer.provide(Layer.succeed(HostProcessArchitecture, input.architecture ?? ARCHITECTURE)),
    Layer.provide(ServerConfig.layerTest(process.cwd(), input.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

it.layer(NodeServices.layer)("PrismBinary", (it) => {
  it.effect("downloads, verifies, extracts, then serves the cache without downloading again", () =>
    Effect.gen(function* () {
      for (const dotPrefix of [false, true]) {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "q1code-prism-binary-" });
        const archive = yield* makeArchive(root, dotPrefix).pipe(
          Effect.provide(ProcessRunner.layer),
        );
        const downloader = makeDownloader(
          new Map([
            [
              prismChecksumsUrl(VERSION),
              new TextEncoder().encode(`${sha256Hex(archive)}  ${ASSET}\n`),
            ],
            [prismReleaseUrl(PLATFORM, ARCHITECTURE, VERSION)!, archive],
          ]),
        );
        const layers = makeLayers({
          baseDir: path.join(root, "base"),
          bundledRoot: path.join(root, "bundled"),
          downloader: downloader.layer,
        });

        const first = yield* Effect.gen(function* () {
          const binary = yield* PrismBinary;
          return yield* binary.resolve();
        }).pipe(Effect.provide(layers));
        assert.equal(first.source, "download");
        assert.equal(first.version, VERSION);
        assert.equal(first.path, path.join(root, "base", "prism", "bin", VERSION, "cli-proxy-api"));
        assert.equal((yield* fs.stat(first.path)).mode & 0o111, 0o111);
        assert.equal(yield* fs.readFileString(first.path), "#!/bin/sh\necho fake\n");
        assert.deepEqual(yield* fs.readDirectory(path.join(root, "base", "prism", "bin")), [
          VERSION,
        ]);
        assert.equal(downloader.urls.length, 2);

        const second = yield* Effect.gen(function* () {
          const binary = yield* PrismBinary;
          return yield* binary.resolve();
        }).pipe(Effect.provide(layers));
        assert.equal(second.source, "cache");
        assert.equal(second.path, first.path);
        assert.equal(downloader.urls.length, 2);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a checksum mismatch and leaves no binary behind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "q1code-prism-binary-" });
      const archive = yield* makeArchive(root).pipe(Effect.provide(ProcessRunner.layer));
      const downloader = makeDownloader(
        new Map([
          [prismChecksumsUrl(VERSION), new TextEncoder().encode(`${"0".repeat(64)}  ${ASSET}\n`)],
          [prismReleaseUrl(PLATFORM, ARCHITECTURE, VERSION)!, archive],
        ]),
      );
      const exit = yield* Effect.gen(function* () {
        const binary = yield* PrismBinary;
        return yield* binary.resolve();
      }).pipe(
        Effect.provide(
          makeLayers({
            baseDir: path.join(root, "base"),
            bundledRoot: path.join(root, "bundled"),
            downloader: downloader.layer,
          }),
        ),
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        assert.isTrue(isDownloadError(error));
        assert.equal(isDownloadError(error) ? error.reason : undefined, "checksum-mismatch");
      }
      assert.isFalse(yield* fs.exists(path.join(root, "base", "prism", "bin", VERSION)));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "prefers an explicit binaryPath, then the bundled copy, and never downloads for them",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "q1code-prism-binary-" });
        const bundledRoot = path.join(root, "bundled");
        const bundled = path.join(bundledRoot, `${PLATFORM}-${ARCHITECTURE}`, "cli-proxy-api");
        yield* fs.makeDirectory(path.dirname(bundled), { recursive: true });
        yield* fs.writeFileString(bundled, "#!/bin/sh\n");
        yield* fs.chmod(bundled, 0o755);
        const override = path.join(root, "custom-proxy");
        yield* fs.writeFileString(override, "#!/bin/sh\n");
        yield* fs.chmod(override, 0o755);
        const downloader = makeDownloader(new Map());
        const layers = makeLayers({
          baseDir: path.join(root, "base"),
          bundledRoot,
          downloader: downloader.layer,
        });

        const resolved = yield* Effect.gen(function* () {
          const binary = yield* PrismBinary;
          const fromOverride = yield* binary.resolve({ binaryPath: override });
          const fromBundle = yield* binary.resolve();
          const missing = yield* binary
            .resolve({ binaryPath: path.join(root, "nope") })
            .pipe(Effect.exit);
          return { fromOverride, fromBundle, missing };
        }).pipe(Effect.provide(layers));
        assert.deepEqual(resolved.fromOverride, {
          path: override,
          version: "custom",
          source: "override",
        });
        assert.deepEqual(resolved.fromBundle, {
          path: bundled,
          version: VERSION,
          source: "bundled",
        });
        assert.isTrue(Exit.isFailure(resolved.missing));
        assert.deepEqual(downloader.urls, []);
      }).pipe(Effect.scoped),
  );

  it.effect("restores the executable bit on a bundled copy that lost it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "q1code-prism-binary-" });
      const bundledRoot = path.join(root, "bundled");
      const bundled = path.join(bundledRoot, `${PLATFORM}-${ARCHITECTURE}`, "cli-proxy-api");
      yield* fs.makeDirectory(path.dirname(bundled), { recursive: true });
      yield* fs.writeFileString(bundled, "#!/bin/sh\n");
      yield* fs.chmod(bundled, 0o644);
      const downloader = makeDownloader(new Map());
      const layers = makeLayers({
        baseDir: path.join(root, "base"),
        bundledRoot,
        downloader: downloader.layer,
      });

      const resolved = yield* Effect.gen(function* () {
        const binary = yield* PrismBinary;
        return yield* binary.resolve();
      }).pipe(Effect.provide(layers));
      assert.equal(resolved.path, bundled);
      const mode = (yield* fs.stat(bundled)).mode;
      assert.notEqual(mode & 0o111, 0);
      assert.deepEqual(downloader.urls, []);
    }).pipe(Effect.scoped),
  );

  it.effect("fails fast on a platform without a release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "q1code-prism-binary-" });
      const exit = yield* Effect.gen(function* () {
        const binary = yield* PrismBinary;
        return yield* binary.resolve();
      }).pipe(
        Effect.provide(
          makeLayers({
            baseDir: path.join(root, "base"),
            bundledRoot: path.join(root, "bundled"),
            downloader: makeDownloader(new Map()).layer,
            platform: "freebsd",
            architecture: "x64",
          }),
        ),
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.isTrue(isUnsupported(Cause.squash(exit.cause)));
      }
    }).pipe(Effect.scoped),
  );
});

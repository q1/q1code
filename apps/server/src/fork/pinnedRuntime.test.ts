import { assert, it } from "@effect/vitest";
import { BRAND, releaseTarballName } from "@q1code/core/brand"; // fork: base
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  forkPinnedRuntimeTestLayer,
  releaseDownloaderTestLayer,
} from "./releaseTarball.testing.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ensurePinnedRuntimeInstalled, pinnedRuntimePaths } from "../cloud/pinnedRuntime.ts";

const successfulRunner = (fs: FileSystem.FileSystem, path: Path.Path) =>
  ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        const prefixIndex = input.args.indexOf("--prefix");
        const stagingDir = input.args[prefixIndex + 1];
        if (stagingDir === undefined) return yield* Effect.die("missing npm --prefix");
        const entry = path.join(stagingDir, BRAND.runtimeEntryRelativePath); // fork: base
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true }).pipe(Effect.orDie);
        yield* fs.writeFileString(entry, "export {};\n").pipe(Effect.orDie);
        return {
          stdout: "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });

it.layer(forkPinnedRuntimeTestLayer)("fork release installation", (it) => {
  // fork: base
  it.effect("installs the verified release tarball from the staging directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "q1code-pinned-runtime-tarball-",
      });
      let installArgs: ReadonlyArray<string> = [];
      let tarballExistedAtInstall = false;
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.gen(function* () {
            installArgs = input.args;
            const tarballPath = input.args.at(-1);
            if (tarballPath !== undefined) {
              tarballExistedAtInstall = yield* fs.exists(tarballPath).pipe(Effect.orDie);
            }
            return yield* successfulRunner(fs, path).run(input);
          }),
      });

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner,
        validate: () => Effect.void,
      });

      const tarballPath = installArgs.at(-1) ?? "";
      assert.equal(path.basename(tarballPath), releaseTarballName("1.2.3"));
      assert.equal(installArgs.at(-1)?.startsWith(path.join(baseDir, "runtime", "versions")), true);
      assert.isTrue(tarballExistedAtInstall);
      assert.deepEqual(installArgs.slice(0, 2), ["install", "--prefix"]);
    }),
  );

  // fork: base
  it.effect("fails closed on a checksum mismatch without running npm", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "q1code-pinned-runtime-mismatch-",
      });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");
      let npmRuns = 0;
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) => {
          npmRuns += 1;
          return successfulRunner(fs, path).run(input);
        },
      });

      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner,
        validate: () => Effect.void,
      }).pipe(
        Effect.flip,
        Effect.provide(
          releaseDownloaderTestLayer("1.2.3", {
            checksums: `${"0".repeat(64)}  ${releaseTarballName("1.2.3")}\n`,
          }),
        ),
      );

      assert.equal(error._tag, "PinnedRuntimeInstallError");
      assert.include(error.message, "verifying the sha256");
      assert.equal(npmRuns, 0);
      assert.isFalse(yield* fs.exists(finalPaths.versionDir));
      assert.deepEqual(
        (yield* fs.readDirectory(path.dirname(finalPaths.versionDir))).filter((entry) =>
          entry.startsWith(".staging-"),
        ),
        [],
      );
    }),
  );

  // fork: base
  it.effect("fails closed when the release checksums do not list the tarball", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "q1code-pinned-runtime-missing-",
      });
      let npmRuns = 0;
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) => {
          npmRuns += 1;
          return successfulRunner(fs, path).run(input);
        },
      });

      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        runner,
        validate: () => Effect.void,
      }).pipe(Effect.flip, Effect.provide(releaseDownloaderTestLayer("1.2.3", { checksums: "" })));

      assert.equal(error._tag, "PinnedRuntimeInstallError");
      assert.include(error.message, "release checksums");
      assert.equal(npmRuns, 0);
    }),
  );
});

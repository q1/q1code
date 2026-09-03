import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { afterEach, assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";

import { ServerConfig } from "../config.ts";
import * as ResourceMonitorBinary from "./ResourceMonitorBinary.ts";

describe("ResourceMonitorBinary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect("skips Linux libc detection on Windows", () =>
    Effect.gen(function* () {
      const getReport = vi.spyOn(process.report, "getReport").mockImplementation(() => {
        throw new Error("Linux libc detection must not run on Windows");
      });
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-resource-monitor-binary-",
      });
      const binaryPath = `${baseDir}/t3-resource-monitor.exe`;
      yield* fileSystem.writeFileString(binaryPath, "binary");

      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(HostProcessArchitecture, "arm64"),
        Effect.provideService(HostProcessEnvironment, {
          T3CODE_RESOURCE_MONITOR_PATH: binaryPath,
        }),
      );

      assert.equal(yield* service.resolve, binaryPath);
      expect(getReport).not.toHaveBeenCalled();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves an executable override", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-resource-monitor-binary-",
      });
      const binaryPath = `${baseDir}/t3-resource-monitor`;
      yield* fileSystem.writeFileString(binaryPath, "binary");
      yield* fileSystem.chmod(binaryPath, 0o755);

      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessArchitecture, "x64"),
        Effect.provideService(ResourceMonitorBinary.ResourceMonitorHostLinuxLibc, "musl"),
        Effect.provideService(HostProcessEnvironment, {
          T3CODE_RESOURCE_MONITOR_PATH: binaryPath,
        }),
      );

      assert.equal(yield* service.resolve, binaryPath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves an executable override on an unsupported platform", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-resource-monitor-binary-",
      });
      const binaryPath = `${baseDir}/custom-resource-monitor`;
      yield* fileSystem.writeFileString(binaryPath, "binary");
      yield* fileSystem.chmod(binaryPath, 0o755);

      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Effect.provideService(HostProcessPlatform, "freebsd"),
        Effect.provideService(HostProcessArchitecture, "ia32"),
        Effect.provideService(HostProcessEnvironment, {
          T3CODE_RESOURCE_MONITOR_PATH: binaryPath,
        }),
      );

      assert.equal(yield* service.resolve, binaryPath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("restores the executable bit on a non-executable POSIX binary", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-resource-monitor-binary-",
      });
      const binaryPath = `${baseDir}/t3-resource-monitor`;
      yield* fileSystem.writeFileString(binaryPath, "binary");
      yield* fileSystem.chmod(binaryPath, 0o644);

      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessArchitecture, "x64"),
        Effect.provideService(ResourceMonitorBinary.ResourceMonitorHostLinuxLibc, "gnu"),
        Effect.provideService(HostProcessEnvironment, {
          T3CODE_RESOURCE_MONITOR_PATH: binaryPath,
        }),
      );

      assert.equal(yield* service.resolve, binaryPath);
      const stat = yield* fileSystem.stat(binaryPath);
      assert.notEqual(stat.mode & 0o111, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a POSIX binary whose executable bit cannot be restored", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-resource-monitor-binary-",
      });
      const binaryPath = `${baseDir}/t3-resource-monitor`;
      yield* fileSystem.writeFileString(binaryPath, "binary");
      yield* fileSystem.chmod(binaryPath, 0o644);
      const readOnlyFileSystem = FileSystem.makeNoop({
        exists: fileSystem.exists,
        stat: fileSystem.stat,
        chmod: (path) =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "chmod",
              description: "read-only file system",
              pathOrDescriptor: path,
            }),
          ),
      });

      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provideService(FileSystem.FileSystem, readOnlyFileSystem),
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessArchitecture, "x64"),
        Effect.provideService(ResourceMonitorBinary.ResourceMonitorHostLinuxLibc, "gnu"),
        Effect.provideService(HostProcessEnvironment, {
          T3CODE_RESOURCE_MONITOR_PATH: binaryPath,
        }),
      );
      const error = yield* Effect.flip(service.resolve);

      assert.instanceOf(error, ResourceMonitorBinary.ResourceMonitorBinaryNotExecutable);
      assert.equal(error.path, binaryPath);
      assert.equal(error.mode & 0o777, 0o644);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects unsupported platform and architecture pairs", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-resource-monitor-binary-",
      });
      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Effect.provideService(HostProcessPlatform, "freebsd"),
        Effect.provideService(HostProcessArchitecture, "ia32"),
        Effect.provideService(HostProcessEnvironment, {}),
      );
      const error = yield* Effect.flip(service.resolve);

      assert.instanceOf(error, ResourceMonitorBinary.ResourceMonitorBinaryUnsupported);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects bundled glibc binaries on musl Linux hosts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-resource-monitor-binary-",
      });
      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessArchitecture, "x64"),
        Effect.provideService(ResourceMonitorBinary.ResourceMonitorHostLinuxLibc, "musl"),
        Effect.provideService(HostProcessEnvironment, {}),
      );
      const error = yield* Effect.flip(service.resolve);

      assert.instanceOf(error, ResourceMonitorBinary.ResourceMonitorBinaryUnsupported);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

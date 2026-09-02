import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_FORK_FLAGS } from "@q1code/core/flags";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ForkFlags from "./ForkFlags.ts";

const makeLayers = (env: Readonly<Record<string, string | undefined>> = {}) => {
  const configLayer = Layer.fresh(
    ServerConfig.layerTest(process.cwd(), { prefix: "q1code-fork-flags-test-" }),
  );
  const flagsLayer = ForkFlags.layer.pipe(
    Layer.provide(Layer.succeed(ForkFlagsEnvironment, env)),
    Layer.provideMerge(configLayer),
  );
  return flagsLayer;
};
const { ForkFlagsEnvironment } = ForkFlags;

const writeForkConfig = (contents: string) =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(stateDir, { recursive: true });
    yield* fs.writeFileString(ForkFlags.forkConfigPath(stateDir, path), contents);
  });

it.layer(NodeServices.layer)("ForkFlags", (it) => {
  it.effect("resolves registry defaults when fork.json is missing", () =>
    Effect.gen(function* () {
      const flags = yield* ForkFlags.ForkFlagsService;
      assert.deepEqual(yield* flags.current, DEFAULT_FORK_FLAGS);
    }).pipe(Effect.provide(makeLayers())),
  );

  it.effect("reads flag values from fork.json", () =>
    Effect.gen(function* () {
      const flags = yield* ForkFlags.ForkFlagsService;
      yield* writeForkConfig('{"flags":{"update-check":true}}');
      const reloaded = yield* flags.reload;
      assert.strictEqual(reloaded["update-check"], true);
      assert.strictEqual(reloaded.cliproxy, DEFAULT_FORK_FLAGS.cliproxy);
      assert.deepEqual(yield* flags.current, reloaded);
    }).pipe(Effect.provide(makeLayers())),
  );

  it.effect("environment overrides beat fork.json", () =>
    Effect.gen(function* () {
      const flags = yield* ForkFlags.ForkFlagsService;
      yield* writeForkConfig('{"flags":{"update-check":true,"cliproxy":true}}');
      const reloaded = yield* flags.reload;
      assert.strictEqual(reloaded["update-check"], false);
      assert.strictEqual(reloaded.cliproxy, true);
    }).pipe(Effect.provide(makeLayers({ T3FORK_UPDATE_CHECK: "0" }))),
  );

  it.effect("falls back to defaults and warns once on invalid JSON", () => {
    let warnings = 0;
    const countingLogger = Logger.make(({ logLevel }) => {
      if (logLevel === "Warn") warnings += 1;
    });
    return Effect.gen(function* () {
      const flags = yield* ForkFlags.ForkFlagsService;
      yield* writeForkConfig("{not json");
      assert.deepEqual(yield* flags.reload, DEFAULT_FORK_FLAGS);
      assert.deepEqual(yield* flags.reload, DEFAULT_FORK_FLAGS);
      assert.strictEqual(warnings, 1);
    }).pipe(
      Effect.provide(
        Layer.merge(makeLayers(), Logger.layer([countingLogger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("publishes a change when a reload moves a value", () =>
    Effect.gen(function* () {
      const flags = yield* ForkFlags.ForkFlagsService;
      const first = yield* flags.changes.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
      yield* writeForkConfig('{"flags":{"cliproxy":true}}');
      yield* flags.reload;
      const [emitted] = yield* Fiber.join(first);
      assert.strictEqual(emitted?.cliproxy, true);
    }).pipe(Effect.provide(makeLayers())),
  );
});

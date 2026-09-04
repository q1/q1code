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

const readForkConfigText = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(ForkFlags.forkConfigPath(stateDir, path));
});

const listStateDir = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readDirectory(stateDir);
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
      assert.strictEqual(reloaded.prism, DEFAULT_FORK_FLAGS.prism);
      assert.deepEqual(yield* flags.current, reloaded);
    }).pipe(Effect.provide(makeLayers())),
  );

  it.effect("environment overrides beat fork.json", () =>
    Effect.gen(function* () {
      const flags = yield* ForkFlags.ForkFlagsService;
      yield* writeForkConfig('{"flags":{"update-check":true,"prism":true}}');
      const reloaded = yield* flags.reload;
      assert.strictEqual(reloaded["update-check"], false);
      assert.strictEqual(reloaded.prism, true);
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

  it.effect(
    "warns once at start when fork.json or the environment still use the cliproxy names",
    () => {
      const warnings: Array<string> = [];
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn")
          warnings.push(String(Array.isArray(message) ? message[0] : message));
      });
      const configLayer = Layer.fresh(
        ServerConfig.layerTest(process.cwd(), { prefix: "q1code-fork-flags-test-" }),
      );
      return Effect.gen(function* () {
        yield* writeForkConfig('{"flags":{"prism":true},"cliproxy":{"port":9001}}');
        yield* Effect.gen(function* () {
          const flags = yield* ForkFlags.ForkFlagsService;
          assert.deepEqual(yield* flags.config, { flags: { prism: true } });
          yield* flags.reload;
        }).pipe(
          Effect.provide(
            ForkFlags.layer.pipe(
              Layer.provide(
                Layer.succeed(ForkFlagsEnvironment, {
                  T3FORK_CLIPROXY: "1",
                  Q1CODE_CLIPROXY_SYNC_KEY: "k",
                }),
              ),
            ),
          ),
        );
        assert.deepEqual(warnings, [
          'prism: fork.json key "cliproxy" was renamed to "prism" and is ignored',
          "prism: environment variable T3FORK_CLIPROXY was renamed to T3FORK_PRISM and is ignored",
          "prism: environment variable Q1CODE_CLIPROXY_SYNC_KEY was renamed to Q1CODE_PRISM_SYNC_KEY and is ignored",
        ]);
      }).pipe(
        Effect.provide(
          Layer.merge(configLayer, Logger.layer([logger], { mergeWithExisting: false })),
        ),
      );
    },
  );

  it.effect("exposes the decoded file config next to the flags", () =>
    Effect.gen(function* () {
      const flags = yield* ForkFlags.ForkFlagsService;
      assert.deepEqual(yield* flags.config, {});
      yield* writeForkConfig('{"flags":{"prism":true},"prism":{"port":9001}}');
      yield* flags.reload;
      assert.deepEqual(yield* flags.config, {
        flags: { prism: true },
        prism: { port: 9001 },
      });
    }).pipe(Effect.provide(makeLayers())),
  );

  it.effect("update rewrites one key, keeps unknown keys and formatting, and re-reads", () =>
    Effect.gen(function* () {
      const flags = yield* ForkFlags.ForkFlagsService;
      yield* writeForkConfig(
        '{"flags":{"prism":true},"prism":{"port":9001},"private":{"host":"x"}}',
      );
      yield* flags.reload;
      const config = yield* flags.update((raw) => ({
        ...raw,
        prism: { ...(raw.prism as object), routingStrategy: "fill-first" },
      }));
      assert.deepEqual(config, {
        flags: { prism: true },
        prism: { port: 9001, routingStrategy: "fill-first" },
      });
      assert.deepEqual(yield* flags.config, config);
      assert.equal(
        yield* readForkConfigText,
        [
          "{",
          '  "flags": {',
          '    "prism": true',
          "  },",
          '  "prism": {',
          '    "port": 9001,',
          '    "routingStrategy": "fill-first"',
          "  },",
          '  "private": {',
          '    "host": "x"',
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      assert.deepEqual(
        (yield* listStateDir).filter((name) => name.startsWith("fork.json")),
        ["fork.json"],
      );
    }).pipe(Effect.provide(makeLayers())),
  );

  it.effect("update creates the file when it is missing and moves flags", () =>
    Effect.gen(function* () {
      const flags = yield* ForkFlags.ForkFlagsService;
      const first = yield* flags.changes.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
      yield* flags.update((raw) => ({ ...raw, flags: { prism: true } }));
      const [emitted] = yield* Fiber.join(first);
      assert.strictEqual(emitted?.prism, true);
      assert.strictEqual((yield* flags.current).prism, true);
    }).pipe(Effect.provide(makeLayers())),
  );

  it.effect("update refuses a malformed file and an invalid result, touching nothing", () =>
    Effect.gen(function* () {
      const flags = yield* ForkFlags.ForkFlagsService;
      yield* writeForkConfig("{not json");
      const malformed = yield* flags.update((raw) => raw).pipe(Effect.flip);
      assert.strictEqual(malformed.reason, "malformed");
      assert.equal(yield* readForkConfigText, "{not json");

      yield* writeForkConfig('{"prism":{"port":1}}');
      const invalid = yield* flags
        .update((raw) => ({ ...raw, prism: { port: 70000 } }))
        .pipe(Effect.flip);
      assert.strictEqual(invalid.reason, "invalid");
      assert.equal(yield* readForkConfigText, '{"prism":{"port":1}}');
    }).pipe(Effect.provide(makeLayers())),
  );

  it.effect("publishes a change when a reload moves a value", () =>
    Effect.gen(function* () {
      const flags = yield* ForkFlags.ForkFlagsService;
      const first = yield* flags.changes.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
      yield* writeForkConfig('{"flags":{"prism":true}}');
      yield* flags.reload;
      const [emitted] = yield* Fiber.join(first);
      assert.strictEqual(emitted?.prism, true);
    }).pipe(Effect.provide(makeLayers())),
  );
});

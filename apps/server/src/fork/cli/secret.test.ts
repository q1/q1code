// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli } from "../../bin.ts";
import { ForkCliStdin } from "./secret.ts";

/** `stdin` is what a piped `set` reads; a TTY stdin carries no value. */
const runCli = (args: ReadonlyArray<string>, stdin: string | "tty" = "") =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NetService.layer,
        TestConsole.layer,
        Layer.succeed(ForkCliStdin, {
          isTTY: stdin === "tty",
          read: Effect.succeed(stdin === "tty" ? "" : stdin),
        }),
      ),
    ),
  );

const lastLine = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* effect;
    return (
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      ""
    );
  }).pipe(Effect.provide(TestConsole.layer));

const makeBaseDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "q1code-secret-cli-"));

const secretPath = (baseDir: string, name: string) =>
  NodePath.join(baseDir, "userdata", "secrets", `${name}.bin`);

describe("q1code fork secret", () => {
  it.effect("set stores the piped value without its trailing newline, owner-only", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const output = yield* lastLine(
        runCli(["fork", "secret", "set", "cliproxy-sync-key", "--base-dir", baseDir], "s3cret\n"),
      );
      assert.equal(output, "Stored secret cliproxy-sync-key.\n");
      const file = secretPath(baseDir, "cliproxy-sync-key");
      assert.equal(NodeFS.readFileSync(file, "utf8"), "s3cret");
      assert.equal(NodeFS.statSync(file).mode & 0o777, 0o600);

      // A second set overwrites.
      yield* runCli(["fork", "secret", "set", "cliproxy-sync-key", "--base-dir", baseDir], "next");
      assert.equal(NodeFS.readFileSync(file, "utf8"), "next");
    }),
  );

  it.effect("set reads --value-file instead of stdin", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const valueFile = NodePath.join(baseDir, "token.txt");
      NodeFS.writeFileSync(valueFile, "tok-1\r\n");
      yield* runCli(
        [
          "fork",
          "secret",
          "set",
          "cliproxy-sync-token",
          "--value-file",
          valueFile,
          "--base-dir",
          baseDir,
        ],
        "ignored",
      );
      assert.equal(
        NodeFS.readFileSync(secretPath(baseDir, "cliproxy-sync-token"), "utf8"),
        "tok-1",
      );
    }),
  );

  it.effect(
    "set refuses an empty value, a TTY stdin, and a name that is not one path segment",
    () =>
      Effect.gen(function* () {
        const baseDir = makeBaseDir();
        const empty = yield* runCli(
          ["fork", "secret", "set", "k", "--base-dir", baseDir],
          "\n",
        ).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(empty));
        const tty = yield* runCli(
          ["fork", "secret", "set", "k", "--base-dir", baseDir],
          "tty",
        ).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(tty));
        const traversal = yield* runCli(
          ["fork", "secret", "set", "../escape", "--base-dir", baseDir],
          "v",
        ).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(traversal));
        assert.isFalse(NodeFS.existsSync(NodePath.join(baseDir, "userdata", "secrets", "k.bin")));
      }),
  );

  it.effect("list names stored secrets and delete removes one", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      assert.equal(
        yield* lastLine(runCli(["fork", "secret", "list", "--base-dir", baseDir])),
        "No secrets stored.\n",
      );
      yield* runCli(["fork", "secret", "set", "b-name", "--base-dir", baseDir], "1");
      yield* runCli(["fork", "secret", "set", "a-name", "--base-dir", baseDir], "2");
      assert.equal(
        yield* lastLine(runCli(["fork", "secret", "list", "--base-dir", baseDir])),
        "a-name\nb-name\n",
      );
      assert.equal(
        yield* lastLine(runCli(["fork", "secret", "delete", "a-name", "--base-dir", baseDir])),
        "Deleted secret a-name.\n",
      );
      assert.isFalse(NodeFS.existsSync(secretPath(baseDir, "a-name")));
      assert.equal(
        yield* lastLine(runCli(["fork", "secret", "delete", "a-name", "--base-dir", baseDir])),
        "No secret named a-name.\n",
      );
      assert.equal(
        yield* lastLine(runCli(["fork", "secret", "list", "--base-dir", baseDir])),
        "b-name\n",
      );
    }),
  );
});

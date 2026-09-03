/**
 * `q1code fork secret set|list|delete` - arbitrary named secrets in the server
 * secret store, the same store the sidecar keys and the sync token/key are
 * read from. `set` reads the value from stdin or `--value-file`, never from
 * argv, so it stays out of shell history and process listings.
 *
 * Runs against the server's state directory (`--base-dir`, `--dev-url`), like
 * the `auth` commands; the server does not need to be running.
 */
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import {
  authLocationFlags,
  type CliAuthLocationFlags,
  resolveCliAuthConfig,
} from "../../cli/config.ts";

/** One path segment, no leading dot: the store keeps `<name>.bin` under the secrets directory. */
export const SecretName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/));

const SECRET_FILE_SUFFIX = ".bin";

export interface ForkCliStdinReader {
  /** An interactive terminal: nothing is piped, so `set` refuses instead of blocking on Ctrl-D. */
  readonly isTTY: boolean;
  /** Everything up to EOF. */
  readonly read: Effect.Effect<string>;
}

/** Where `set` reads the value when `--value-file` is absent; tests provide a fixed string. */
export const ForkCliStdin = Context.Reference<ForkCliStdinReader>("t3/fork/cli/ForkCliStdin", {
  defaultValue: () => ({
    isTTY: process.stdin.isTTY === true,
    read: Effect.promise(async () => {
      const chunks: Array<Uint8Array> = [];
      for await (const chunk of process.stdin) {
        chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
      }
      return new TextDecoder().decode(Buffer.concat(chunks));
    }),
  }),
});

/** `cause` carries the user-facing sentence. */
class SecretValueError extends CliError.UserError {
  override get message() {
    return typeof this.cause === "string" ? this.cause : "Invalid secret value.";
  }
}

/** One trailing line break is the shell's, not the secret's. */
const normalizeSecretValue = (raw: string) => raw.replace(/\r?\n$/, "");

const runWithSecretStore = <A, E>(
  flags: CliAuthLocationFlags,
  run: (input: {
    readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
    readonly config: ServerConfig.ServerConfig["Service"];
  }) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    return yield* Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      return yield* run({ secrets, config });
    }).pipe(
      Effect.provide(
        ServerSecretStore.layer.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    );
  });

const nameArgument = Argument.string("name").pipe(
  Argument.withDescription("Secret name, for example `cliproxy-sync-key`."),
  Argument.withSchema(SecretName),
);

const valueFileFlag = Flag.string("value-file").pipe(
  Flag.withDescription("Read the value from this file instead of stdin."),
  Flag.optional,
);

const secretSetCommand = Command.make("set", {
  ...authLocationFlags,
  name: nameArgument,
  valueFile: valueFileFlag,
}).pipe(
  Command.withDescription(
    "Store a secret. The value comes from stdin or --value-file, never from the command line.",
  ),
  Command.withHandler((flags) =>
    runWithSecretStore(flags, ({ secrets }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stdin = yield* ForkCliStdin;
        const raw = Option.isSome(flags.valueFile)
          ? yield* fs.readFileString(flags.valueFile.value)
          : stdin.isTTY
            ? yield* new SecretValueError({
                cause:
                  "Pipe the value on stdin or pass --value-file; it is never read from the command line.",
              })
            : yield* stdin.read;
        const value = normalizeSecretValue(raw);
        if (value.length === 0) {
          return yield* new SecretValueError({ cause: "The secret value is empty." });
        }
        yield* secrets.set(flags.name, new TextEncoder().encode(value));
        yield* Console.log(`Stored secret ${flags.name}.\n`);
      }),
    ),
  ),
);

const secretListCommand = Command.make("list", {
  ...authLocationFlags,
}).pipe(
  Command.withDescription("List stored secret names without revealing their values."),
  Command.withHandler((flags) =>
    runWithSecretStore(flags, ({ config }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // The store has no listing of its own; its layout is one `<name>.bin` per secret.
        const entries = yield* fs
          .readDirectory(config.secretsDir)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        const names = entries
          .filter((entry) => entry.endsWith(SECRET_FILE_SUFFIX))
          .map((entry) => entry.slice(0, -SECRET_FILE_SUFFIX.length))
          .sort();
        yield* Console.log(names.length === 0 ? "No secrets stored.\n" : `${names.join("\n")}\n`);
      }),
    ),
  ),
);

const secretDeleteCommand = Command.make("delete", {
  ...authLocationFlags,
  name: nameArgument,
}).pipe(
  Command.withDescription("Delete a stored secret."),
  Command.withHandler((flags) =>
    runWithSecretStore(flags, ({ secrets }) =>
      Effect.gen(function* () {
        const existing = yield* secrets.get(flags.name);
        if (Option.isNone(existing)) {
          yield* Console.log(`No secret named ${flags.name}.\n`);
          return;
        }
        yield* secrets.remove(flags.name);
        yield* Console.log(`Deleted secret ${flags.name}.\n`);
      }),
    ),
  ),
);

export const secretCommand = Command.make("secret").pipe(
  Command.withDescription("Manage named secrets in the server secret store."),
  Command.withSubcommands([secretSetCommand, secretListCommand, secretDeleteCommand]),
);

// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";

import { cli } from "../../bin.ts";
import { ForkFlagsEnvironment } from "../ForkFlags.ts";
import { PRISM_OFF_ERROR, PrismAccountReport, PrismCliHttp, PrismStatusReport } from "./prism.ts";
import { ForkCliStdin } from "./secret.ts";

const MANAGEMENT_SECRET = "mgmt-s3cret-value";

interface GatewayCall {
  readonly url: string;
  readonly authorization: string | undefined;
}

type GatewayReply = { readonly status?: number; readonly body?: unknown } | "hang" | "refuse";

/** A scripted gateway: `respond` maps a management path (after `/v0/management`) to a reply; `hanging` completes when a request hangs. */
const makeGateway = (
  respond: (path: string) => GatewayReply,
  hanging?: Deferred.Deferred<void>,
) => {
  const calls: Array<GatewayCall> = [];
  const client = HttpClient.make((request, url) =>
    Effect.suspend(() => {
      calls.push({ url: url.toString(), authorization: request.headers.authorization });
      const reply = respond(url.pathname.replace(/^\/v0\/management/, ""));
      if (reply === "hang") {
        return hanging
          ? Deferred.succeed(hanging, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.never;
      }
      if (reply === "refuse") {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              description: `connect ECONNREFUSED ${url.host} (secret ${MANAGEMENT_SECRET} echoed)`,
            }),
          }),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(reply.body ?? {}, { status: reply.status ?? 200 }),
        ),
      );
    }),
  );
  return {
    calls,
    layer: Layer.succeed(PrismCliHttp, Layer.succeed(HttpClient.HttpClient, client)),
  };
};

/** Local management calls work even when the remote release check fails. */
const healthyGateway = () =>
  makeGateway((path) => {
    switch (path) {
      case "/latest-version":
        return { status: 502, body: { error: "release service unavailable" } };
      case "/auth-files":
        return {
          body: {
            files: [
              { name: "codex-1.json", provider: "codex", weight: 2 },
              { name: "claude-1.json", type: "claude", disabled: true },
              { name: "gemini-1.json", provider: "gemini", disabled: false },
            ],
          },
        };
      case "/routing/strategy":
        return { body: { strategy: "round-robin" } };
      default:
        return { status: 404, body: { error: "unknown" } };
    }
  });

const runCli = (
  args: ReadonlyArray<string>,
  options: {
    readonly gateway?: ReturnType<typeof makeGateway>;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly stdin?: string;
  } = {},
) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NetService.layer,
        TestConsole.layer,
        (options.gateway ?? makeGateway(() => "refuse")).layer,
        Layer.succeed(ForkFlagsEnvironment, options.env ?? {}),
        Layer.succeed(ForkCliStdin, {
          isTTY: false,
          read: Effect.succeed(options.stdin ?? ""),
        }),
      ),
    ),
  );

/** The run's exit together with the last line it printed. */
const capture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    const output =
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      "";
    return { exit, output };
  }).pipe(Effect.provide(TestConsole.layer));

const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(PrismStatusReport));
const decodeAccounts = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(PrismAccountReport)),
);
const decodeKeys = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const makeBaseDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "q1code-prism-cli-"));

const writeForkConfig = (baseDir: string, json: string) => {
  const stateDir = NodePath.join(baseDir, "userdata");
  NodeFS.mkdirSync(stateDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(stateDir, "fork.json"), json);
};

const storeSecret = (baseDir: string, name: string, value = MANAGEMENT_SECRET) =>
  runCli(["fork", "secret", "set", name, "--base-dir", baseDir], { stdin: value });

const FLAG_ON = '{"flags":{"prism":true}}';

describe("q1code prism status", () => {
  it.effect("reports a ready sidecar when the release service is unavailable", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeForkConfig(baseDir, FLAG_ON);
      yield* storeSecret(baseDir, "prism-management-secret");
      const gateway = healthyGateway();
      const { exit, output } = yield* capture(
        runCli(["prism", "status", "--json", "--base-dir", baseDir], { gateway }),
      );
      assert.isTrue(Exit.isSuccess(exit));
      assert.deepEqual(Object.keys(decodeKeys(output)), [
        "mode",
        "baseUrl",
        "reachable",
        "accounts",
        "disabled",
        "strategy",
      ]);
      assert.deepEqual(decodeReport(output), {
        mode: "sidecar",
        baseUrl: "http://127.0.0.1:8317",
        reachable: true,
        accounts: 3,
        disabled: 1,
        strategy: "round-robin",
      });
      assert.deepEqual(
        gateway.calls.map((call) => call.url),
        [
          "http://127.0.0.1:8317/v0/management/routing/strategy",
          "http://127.0.0.1:8317/v0/management/auth-files",
        ],
      );
      assert.isTrue(
        gateway.calls.every((call) => call.authorization === `Bearer ${MANAGEMENT_SECRET}`),
      );
      assert.notInclude(output, MANAGEMENT_SECRET);
    }),
  );

  it.effect("prints one line per field without --json", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeForkConfig(baseDir, FLAG_ON);
      yield* storeSecret(baseDir, "prism-management-secret");
      const { exit, output } = yield* capture(
        runCli(["prism", "status", "--base-dir", baseDir], { gateway: healthyGateway() }),
      );
      assert.isTrue(Exit.isSuccess(exit));
      assert.equal(
        output,
        [
          "mode: sidecar",
          "baseUrl: http://127.0.0.1:8317",
          "reachable: yes",
          "accounts: 3",
          "disabled: 1",
          "strategy: round-robin",
        ].join("\n"),
      );
    }),
  );

  it.effect("exits 1 with the off hint when the flag is off, without touching the gateway", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const gateway = healthyGateway();
      const { exit, output } = yield* capture(
        runCli(["prism", "status", "--json", "--base-dir", baseDir], { gateway }),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.deepEqual(decodeReport(output), {
        mode: "sidecar",
        baseUrl: "http://127.0.0.1:8317",
        reachable: false,
        accounts: 0,
        disabled: 0,
        strategy: null,
        error: PRISM_OFF_ERROR,
      });
      assert.include(output, "T3FORK_PRISM");
      assert.equal(gateway.calls.length, 0);

      // The human form ends with the error line.
      const human = yield* capture(runCli(["prism", "status", "--base-dir", baseDir], { gateway }));
      assert.isTrue(Exit.isFailure(human.exit));
      assert.isTrue(human.output.endsWith(`error: ${PRISM_OFF_ERROR}`));
    }),
  );

  it.effect("exits 1 naming the secret command when the management secret is missing", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const gateway = healthyGateway();
      // The env override turns the flag on like it does for the server.
      const { exit, output } = yield* capture(
        runCli(["prism", "status", "--json", "--base-dir", baseDir], {
          gateway,
          env: { T3FORK_PRISM: "1" },
        }),
      );
      assert.isTrue(Exit.isFailure(exit));
      const report = decodeReport(output);
      assert.isFalse(report.reachable);
      assert.include(report.error ?? "", "q1code fork secret set prism-management-secret");
      assert.equal(gateway.calls.length, 0);
    }),
  );

  it.effect("exits 1 with a redacted transport error when the gateway refuses", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeForkConfig(baseDir, FLAG_ON);
      yield* storeSecret(baseDir, "prism-management-secret");
      const gateway = makeGateway(() => "refuse");
      const { exit, output } = yield* capture(
        runCli(["prism", "status", "--json", "--base-dir", baseDir], { gateway }),
      );
      assert.isTrue(Exit.isFailure(exit));
      const report = decodeReport(output);
      assert.isFalse(report.reachable);
      assert.include(report.error ?? "", "GET /routing/strategy failed");
      assert.include(report.error ?? "", "ECONNREFUSED");
      assert.notInclude(output, MANAGEMENT_SECRET);
      assert.equal(gateway.calls.length, 1);
    }),
  );

  it.effect("exits 1 and points at the secret on a 401", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeForkConfig(baseDir, FLAG_ON);
      yield* storeSecret(baseDir, "prism-management-secret");
      const gateway = makeGateway(() => ({ status: 401, body: { error: "unauthorized" } }));
      const { exit, output } = yield* capture(
        runCli(["prism", "status", "--json", "--base-dir", baseDir], { gateway }),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.deepEqual(decodeReport(output), {
        mode: "sidecar",
        baseUrl: "http://127.0.0.1:8317",
        reachable: false,
        accounts: 0,
        disabled: 0,
        strategy: null,
        error: "HTTP 401 from GET /routing/strategy; check the management secret",
      });
      assert.equal(gateway.calls.length, 1);
    }),
  );

  it.effect("stays reachable but exits 1 when a later call fails", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeForkConfig(baseDir, FLAG_ON);
      yield* storeSecret(baseDir, "prism-management-secret");
      const gateway = makeGateway((path) =>
        path === "/routing/strategy"
          ? { body: { strategy: "round-robin" } }
          : { status: 500, body: { error: "boom" } },
      );
      const { exit, output } = yield* capture(
        runCli(["prism", "status", "--json", "--base-dir", baseDir], { gateway }),
      );
      assert.isTrue(Exit.isFailure(exit));
      const report = decodeReport(output);
      assert.isTrue(report.reachable);
      assert.equal(report.accounts, 0);
      assert.equal(report.error, "HTTP 500 from GET /auth-files");
    }),
  );

  it.effect("gives up on a hanging gateway after the timeout", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeForkConfig(baseDir, FLAG_ON);
      yield* storeSecret(baseDir, "prism-management-secret");
      const hanging = yield* Deferred.make<void>();
      const gateway = makeGateway(() => "hang", hanging);
      const fiber = yield* Effect.forkChild(
        capture(runCli(["prism", "status", "--json", "--base-dir", baseDir], { gateway })),
      );
      // The request is in flight; one yield lets the timeout's sleeper register before the clock moves.
      yield* Deferred.await(hanging);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      const { exit, output } = yield* Fiber.join(fiber);
      assert.isTrue(Exit.isFailure(exit));
      const report = decodeReport(output);
      assert.isFalse(report.reachable);
      assert.include(report.error ?? "", "GET /routing/strategy timed out");
    }),
  );

  it.effect(
    "resolves the sidecar port and the external origin plus secret name from fork.json",
    () =>
      Effect.gen(function* () {
        const sidecarDir = makeBaseDir();
        writeForkConfig(sidecarDir, '{"flags":{"prism":true},"prism":{"port":9000}}');
        yield* storeSecret(sidecarDir, "prism-management-secret");
        const sidecar = healthyGateway();
        const sidecarRun = yield* capture(
          runCli(["prism", "status", "--json", "--base-dir", sidecarDir], { gateway: sidecar }),
        );
        assert.isTrue(Exit.isSuccess(sidecarRun.exit));
        assert.equal(decodeReport(sidecarRun.output).baseUrl, "http://127.0.0.1:9000");
        assert.equal(sidecar.calls[0]?.url, "http://127.0.0.1:9000/v0/management/routing/strategy");

        const externalDir = makeBaseDir();
        writeForkConfig(
          externalDir,
          '{"flags":{"prism":true},"prism":{"mode":"external","external":{"baseUrl":"https://proxy.example.test:9443/","managementSecretName":"proxy-mgmt"}}}',
        );
        yield* storeSecret(externalDir, "proxy-mgmt", "external-secret");
        const external = healthyGateway();
        const externalRun = yield* capture(
          runCli(["prism", "status", "--json", "--base-dir", externalDir], { gateway: external }),
        );
        assert.isTrue(Exit.isSuccess(externalRun.exit));
        const report = decodeReport(externalRun.output);
        assert.equal(report.mode, "external");
        assert.equal(report.baseUrl, "https://proxy.example.test:9443");
        assert.equal(
          external.calls[0]?.url,
          "https://proxy.example.test:9443/v0/management/routing/strategy",
        );
        assert.equal(external.calls[0]?.authorization, "Bearer external-secret");
      }),
  );

  it.effect("exits 1 with a null base URL when external mode is misconfigured", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeForkConfig(baseDir, '{"flags":{"prism":true},"prism":{"mode":"external"}}');
      const gateway = healthyGateway();
      const { exit, output } = yield* capture(
        runCli(["prism", "status", "--json", "--base-dir", baseDir], { gateway }),
      );
      assert.isTrue(Exit.isFailure(exit));
      const report = decodeReport(output);
      assert.equal(report.mode, "external");
      assert.isNull(report.baseUrl);
      assert.include(report.error ?? "", "prism.external");
      assert.equal(gateway.calls.length, 0);
    }),
  );
});

describe("q1code prism accounts", () => {
  it.effect("lists id, provider, disabled, and weight as JSON or a table", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeForkConfig(baseDir, FLAG_ON);
      yield* storeSecret(baseDir, "prism-management-secret");
      const json = yield* capture(
        runCli(["prism", "accounts", "--json", "--base-dir", baseDir], {
          gateway: healthyGateway(),
        }),
      );
      assert.isTrue(Exit.isSuccess(json.exit));
      assert.deepEqual(decodeAccounts(json.output), [
        { id: "codex-1.json", provider: "codex", disabled: false, weight: 2 },
        { id: "claude-1.json", provider: "claude", disabled: true },
        { id: "gemini-1.json", provider: "gemini", disabled: false },
      ]);

      const table = yield* capture(
        runCli(["prism", "accounts", "--base-dir", baseDir], { gateway: healthyGateway() }),
      );
      assert.isTrue(Exit.isSuccess(table.exit));
      assert.equal(
        table.output,
        [
          "id             provider  disabled  weight",
          "codex-1.json   codex     no        2",
          "claude-1.json  claude    yes",
          "gemini-1.json  gemini    no",
        ].join("\n"),
      );
    }),
  );

  it.effect("fails without output when the flag is off or the gateway rejects", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const gateway = healthyGateway();
      const off = yield* capture(
        runCli(["prism", "accounts", "--json", "--base-dir", baseDir], { gateway }),
      );
      assert.isTrue(Exit.isFailure(off.exit));
      assert.equal(off.output, "");
      assert.equal(gateway.calls.length, 0);

      writeForkConfig(baseDir, FLAG_ON);
      yield* storeSecret(baseDir, "prism-management-secret");
      const rejected = yield* capture(
        runCli(["prism", "accounts", "--json", "--base-dir", baseDir], {
          gateway: makeGateway(() => ({ status: 403, body: {} })),
        }),
      );
      assert.isTrue(Exit.isFailure(rejected.exit));
    }),
  );
});

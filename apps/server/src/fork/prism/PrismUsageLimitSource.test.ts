/**
 * The `UsageLimitSources.ts` seam end to end: upstream's reader, built through
 * its real `make`, polls the Prism entry like a hub the user configured, and
 * drops it again when the toggle goes off.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { UsageLimitSourceId } from "@t3tools/contracts";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { UsageLimitSources, make } from "../../usage/UsageLimitSources.ts";
import { type PrismEndpoint, publishPrismEndpoint } from "./PrismEnvironment.ts";

const endpoint: PrismEndpoint = {
  baseUrl: "http://127.0.0.1:8317",
  apiKey: "client-key",
  managementSecret: "mgmt",
  usageSource: true,
};

const quotaStatus = {
  accounts: {
    "claude-a@example.com.json": { provider: "claude", five_hour: { used_percent: 25 } },
  },
};

/** A proxy that answers the quota status only for Prism's management secret. */
const makeProxy = () => {
  const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const authorization = request.headers["authorization"];
      requests.push({ url: request.url, authorization });
      return HttpClientResponse.fromWeb(
        request,
        authorization === "Bearer mgmt"
          ? Response.json(quotaStatus)
          : new Response("nope", { status: 401 }),
      );
    }),
  );
  return { layer: Layer.succeed(HttpClient.HttpClient, client), requests };
};

const makeSources = (
  proxy: ReturnType<typeof makeProxy>,
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
) =>
  Layer.effect(UsageLimitSources, make).pipe(
    Layer.provide(proxy.layer),
    Layer.provide(ServerSettings.layerTest(settings)),
    Layer.provide(
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
    ),
  );

const firstSnapshotWhere = (
  sources: UsageLimitSources["Service"],
  predicate: (snapshots: ReadonlyArray<{ readonly id: string }>) => boolean,
) => sources.streamChanges.pipe(Stream.filter(predicate), Stream.take(1), Stream.runCollect);

it.layer(NodeServices.layer, { excludeTestServices: true })("Prism usage-limit source", (it) => {
  it.effect(
    "polls the Prism entry like a configured hub and drops it when the toggle goes off",
    () =>
      Effect.gen(function* () {
        const proxy = makeProxy();
        publishPrismEndpoint(endpoint);
        try {
          yield* Effect.gen(function* () {
            const sources = yield* UsageLimitSources;
            const [published] = yield* firstSnapshotWhere(sources, (s) => s.length > 0);
            assert.equal(published?.length, 1);
            const prism = published![0]!;
            assert.equal(prism.id, "prism");
            assert.equal(prism.kind, "cliproxy");
            assert.equal(prism.label, "Prism");
            assert.isUndefined(prism.error);
            assert.equal(prism.accounts.length, 1);
            assert.equal(prism.accounts[0]?.email, "a@example.com");
            assert.equal(prism.accounts[0]?.driver, "claudeAgent");
            assert.deepEqual(proxy.requests, [
              {
                url: "http://127.0.0.1:8317/v0/management/quota-scheduler/status",
                authorization: "Bearer mgmt",
              },
            ]);

            const emptied = yield* firstSnapshotWhere(sources, (s) => s.length === 0).pipe(
              Effect.forkChild,
              Effect.tap(() => Effect.yieldNow),
            );
            publishPrismEndpoint({ ...endpoint, usageSource: false });
            const [after] = yield* Fiber.join(emptied);
            assert.deepEqual(after, []);
            assert.deepEqual(yield* sources.current, []);
          }).pipe(Effect.provide(makeSources(proxy)));
        } finally {
          publishPrismEndpoint(undefined);
        }
      }),
  );

  it.effect("leaves a hub the user pointed at the proxy's origin alone", () =>
    Effect.gen(function* () {
      const proxy = makeProxy();
      publishPrismEndpoint(endpoint);
      try {
        yield* Effect.gen(function* () {
          const sources = yield* UsageLimitSources;
          const [snapshots] = yield* firstSnapshotWhere(sources, (s) => s.length > 0);
          assert.deepEqual(
            snapshots?.map((s) => s.id),
            ["mine"],
          );
          // The user's key, not Prism's, is what the hub saw.
          assert.deepEqual(
            proxy.requests.map((r) => r.authorization),
            ["Bearer user"],
          );
        }).pipe(
          Effect.provide(
            makeSources(proxy, {
              usageLimitSources: {
                [UsageLimitSourceId.make("mine")]: {
                  kind: "cliproxy",
                  url: "http://127.0.0.1:8317/",
                  managementKey: "user",
                  enabled: true,
                },
              },
            }),
          ),
        );
      } finally {
        publishPrismEndpoint(undefined);
      }
    }),
  );

  it.effect("reads only the configured hubs while nothing is published (flag off)", () =>
    Effect.gen(function* () {
      const proxy = makeProxy();
      publishPrismEndpoint(undefined);
      yield* Effect.gen(function* () {
        const sources = yield* UsageLimitSources;
        const [snapshots] = yield* firstSnapshotWhere(sources, (s) => s.length > 0);
        assert.deepEqual(
          snapshots?.map((s) => s.id),
          ["hub"],
        );
        assert.deepEqual(
          proxy.requests.map((r) => r.url),
          ["https://hub.example/v0/management/quota-scheduler/status"],
        );
      }).pipe(
        Effect.provide(
          makeSources(proxy, {
            usageLimitSources: {
              [UsageLimitSourceId.make("hub")]: {
                kind: "cliproxy",
                url: "https://hub.example",
                managementKey: "user",
                enabled: true,
              },
            },
          }),
        ),
      );
    }),
  );
});

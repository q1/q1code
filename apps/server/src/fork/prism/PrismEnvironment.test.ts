import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type UsageLimitSourceConfig, UsageLimitSourceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { makeClaudeEnvironment } from "../../provider/Drivers/ClaudeHome.ts";
import {
  currentPrismEndpoint,
  type PrismEndpoint,
  prismUsageLimitSource,
  prismUsageSourceChanges,
  publishPrismEndpoint,
  withPrismClaudeEnvironment,
  withPrismUsageLimitSource,
} from "./PrismEnvironment.ts";

const endpoint: PrismEndpoint = {
  baseUrl: "http://127.0.0.1:8317",
  apiKey: "k",
  managementSecret: "s",
  usageSource: true,
};

const hub = (url: string): readonly [string, UsageLimitSourceConfig] => [
  `hub-${url}`,
  { kind: "cliproxy", url, managementKey: "h", enabled: true },
];

const prismEntry = {
  kind: "cliproxy",
  label: "Prism",
  url: "http://127.0.0.1:8317",
  managementKey: "s",
  enabled: true,
} as const;

it("returns the very same env object while no proxy is published", () => {
  publishPrismEndpoint(undefined);
  const env = { PATH: "/bin" };
  assert.strictEqual(withPrismClaudeEnvironment(env), env);
  assert.equal(currentPrismEndpoint(), undefined);
});

it("adds the Anthropic base URL and bearer token while the proxy is ready", () => {
  publishPrismEndpoint(endpoint);
  try {
    const env = { PATH: "/bin", ANTHROPIC_BASE_URL: "https://api.anthropic.com" };
    const result = withPrismClaudeEnvironment(env);
    assert.notStrictEqual(result, env);
    assert.equal(result.PATH, "/bin");
    assert.equal(result.ANTHROPIC_BASE_URL, "http://127.0.0.1:8317");
    assert.equal(result.ANTHROPIC_AUTH_TOKEN, "k");
    assert.equal(env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  } finally {
    publishPrismEndpoint(undefined);
  }
});

it("publishes no usage-limit source while off or while the toggle is off", () => {
  publishPrismEndpoint(undefined);
  const entries = [hub("https://hub.example")];
  assert.isUndefined(prismUsageLimitSource());
  assert.strictEqual(withPrismUsageLimitSource(entries), entries);
  publishPrismEndpoint({ ...endpoint, usageSource: false });
  try {
    assert.isUndefined(prismUsageLimitSource());
    assert.strictEqual(withPrismUsageLimitSource(entries), entries);
    assert.strictEqual(withPrismUsageLimitSource([]).length, 0);
  } finally {
    publishPrismEndpoint(undefined);
  }
});

it("appends the Prism source after the user's hubs while the toggle is on", () => {
  publishPrismEndpoint(endpoint);
  try {
    const prismId = UsageLimitSourceId.make("prism");
    assert.deepEqual(prismUsageLimitSource(), [prismId, prismEntry]);
    const entries = [hub("https://hub.example")];
    const result = withPrismUsageLimitSource(entries);
    assert.notStrictEqual(result, entries);
    assert.deepEqual(result, [entries[0]!, [prismId, prismEntry]]);
    assert.deepEqual(withPrismUsageLimitSource([]), [[prismId, prismEntry]]);
    // The secret never leaks into the entry beyond the management key the reader needs.
    assert.notInclude(JSON.stringify(result), '"apiKey"');
  } finally {
    publishPrismEndpoint(undefined);
  }
});

it("leaves the list alone when a hub already targets the proxy's origin or reuses its id", () => {
  publishPrismEndpoint(endpoint);
  try {
    const sameOrigin = [hub("http://127.0.0.1:8317/")];
    assert.strictEqual(withPrismUsageLimitSource(sameOrigin), sameOrigin);
    const sameId: ReadonlyArray<readonly [string, UsageLimitSourceConfig]> = [
      ["prism", hub("https://elsewhere.example")[1]],
    ];
    assert.strictEqual(withPrismUsageLimitSource(sameId), sameId);
    const otherPort = [hub("http://127.0.0.1:9000")];
    assert.equal(withPrismUsageLimitSource(otherPort).length, 2);
    const unparsable = [hub("not a url")];
    assert.equal(withPrismUsageLimitSource(unparsable).length, 2);
  } finally {
    publishPrismEndpoint(undefined);
  }
});

it.effect("emits when the usage source appears, moves, and disappears, never on a repeat", () =>
  Effect.gen(function* () {
    publishPrismEndpoint(undefined);
    const collected = yield* prismUsageSourceChanges.pipe(
      Stream.take(3),
      Stream.runCollect,
      Effect.forkChild,
      Effect.tap(() => Effect.yieldNow),
    );
    try {
      publishPrismEndpoint(endpoint);
      // Same origin and secret: a republish with only the client key changed is not a change.
      publishPrismEndpoint({ ...endpoint, apiKey: "k2" });
      publishPrismEndpoint({ ...endpoint, baseUrl: "http://127.0.0.1:9000" });
      publishPrismEndpoint({ ...endpoint, baseUrl: "http://127.0.0.1:9000", usageSource: false });
    } finally {
      publishPrismEndpoint(undefined);
    }
    const emitted = yield* Fiber.join(collected);
    assert.deepEqual(
      emitted.map((entry) => entry?.[1].url),
      ["http://127.0.0.1:8317", "http://127.0.0.1:9000", undefined],
    );
  }),
);

it.layer(NodeServices.layer)("ClaudeHome seam", (it) => {
  it.effect("routes both the plain and the CLAUDE_CONFIG_DIR paths through the proxy", () =>
    Effect.gen(function* () {
      publishPrismEndpoint(endpoint);
      try {
        const plain = yield* makeClaudeEnvironment({ homePath: "" }, { PATH: "/bin" });
        assert.equal(plain.ANTHROPIC_BASE_URL, "http://127.0.0.1:8317");
        assert.equal(plain.ANTHROPIC_AUTH_TOKEN, "k");
        const isolated = yield* makeClaudeEnvironment(
          { homePath: "~/.claude-x" },
          { PATH: "/bin" },
        );
        assert.equal(isolated.ANTHROPIC_AUTH_TOKEN, "k");
        assert.isString(isolated.CLAUDE_CONFIG_DIR);
      } finally {
        publishPrismEndpoint(undefined);
      }
      const base = { PATH: "/bin" };
      assert.strictEqual(yield* makeClaudeEnvironment({ homePath: "" }, base), base);
    }),
  );
});

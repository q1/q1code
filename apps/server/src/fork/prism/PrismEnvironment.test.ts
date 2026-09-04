import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeClaudeEnvironment } from "../../provider/Drivers/ClaudeHome.ts";
import {
  currentPrismEndpoint,
  publishPrismEndpoint,
  withPrismClaudeEnvironment,
} from "./PrismEnvironment.ts";

const endpoint = { baseUrl: "http://127.0.0.1:8317", apiKey: "k" };

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

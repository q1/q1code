import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { servingCredential } from "./PrismServingCredentials.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "serving snapshots preserve access credentials and remove every refresh-token alias",
  () =>
    Effect.gen(function* () {
      for (const type of ["claude", "codex", "grok"]) {
        const source = {
          type,
          access_token: "test-access",
          refresh_token: "test-refresh",
          token: {
            refreshToken: "test-nested-refresh",
            access_token: "test-nested-access",
          },
          nested: [{ "refresh-token": "test-array-refresh" }],
          disabled: true,
        };
        const result = yield* servingCredential(
          new TextEncoder().encode(yield* encodeJson(source)),
        );
        assert.deepEqual(yield* decodeJson(new TextDecoder().decode(result)), {
          type,
          access_token: "test-access",
          token: { access_token: "test-nested-access" },
          nested: [{}],
          disabled: true,
          refresh_disabled: true,
        });
        assert.equal(source.refresh_token, "test-refresh");
      }
    }),
);

it.effect("invalid credential errors never contain source material", () =>
  Effect.gen(function* () {
    for (const value of ['{"refresh_token":"test-private-material"', "null", "[]"]) {
      const result = yield* servingCredential(new TextEncoder().encode(value)).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      assert.isFalse((yield* encodeJson(result)).includes("test-private-material"));
    }
  }),
);

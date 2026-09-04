import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { PrismSyncFailedError } from "@q1code/core/prismApi";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeCredential = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Refresh credentials stay with the primary, including provider-specific nested aliases. */
const withoutRefreshTokens = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutRefreshTokens);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key.replaceAll(/[_-]/g, "").toLowerCase() !== "refreshtoken")
      .map(([key, child]) => [key, withoutRefreshTokens(child)]),
  );
};

/** Never include the input or parser error: either can contain OAuth credentials. */
export const servingCredential = Effect.fn("prism.servingCredential")(function* (
  bytes: Uint8Array,
) {
  const invalid = () =>
    new PrismSyncFailedError({
      reason: "io",
      message: "Account file is not a valid JSON credential object.",
    });
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: invalid,
  });
  const source = yield* decodeCredential(text).pipe(Effect.mapError(invalid));
  const serving = withoutRefreshTokens(source);
  if (!isObject(serving)) return yield* invalid();
  const encoded = yield* encodeJson({
    ...serving,
    refresh_disabled: true,
  }).pipe(Effect.mapError(invalid));
  return new TextEncoder().encode(encoded);
});

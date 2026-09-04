import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { decryptSyncEntry, deriveSyncKey, encryptSyncEntry } from "./PrismSyncCrypto.ts";

const plaintext = new TextEncoder().encode('{"type":"codex","email":"a@example.com"}');

it.effect("round-trips an entry and never repeats a nonce", () =>
  Effect.gen(function* () {
    const key = deriveSyncKey("shared-secret");
    const first = yield* encryptSyncEntry(key, plaintext);
    const second = yield* encryptSyncEntry(key, plaintext);
    assert.notEqual(first, second);
    assert.deepEqual(yield* decryptSyncEntry(key, first), plaintext);
    assert.deepEqual(yield* decryptSyncEntry(key, second), plaintext);
  }),
);

it.effect("rejects a tampered payload, a foreign key, and garbage", () =>
  Effect.gen(function* () {
    const key = deriveSyncKey("shared-secret");
    const ciphertext = yield* encryptSyncEntry(key, plaintext);
    const bytes = Buffer.from(ciphertext, "base64");
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    const tampered = yield* decryptSyncEntry(key, bytes.toString("base64")).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(tampered));
    const foreign = yield* decryptSyncEntry(deriveSyncKey("other"), ciphertext).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(foreign));
    const garbage = yield* decryptSyncEntry(key, "AA==").pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(garbage));
  }),
);

it("derives the same key from the same secret and different keys otherwise", () => {
  assert.deepEqual(deriveSyncKey("s"), deriveSyncKey("s"));
  assert.notDeepEqual(deriveSyncKey("s"), deriveSyncKey("t"));
  assert.equal(deriveSyncKey("s").length, 32);
});

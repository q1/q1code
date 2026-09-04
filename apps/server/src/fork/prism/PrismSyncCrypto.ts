/**
 * Payload encryption for cross-machine auth-file sync. AES-256-GCM with a key
 * derived from the shared secret through HKDF-SHA256 and a fresh 12-byte
 * nonce per entry; the wire form is `base64(nonce || tag || data)`. Pure
 * functions over `node:crypto`; nothing here logs.
 */
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HKDF_SALT = "q1code-prism-sync";
const HKDF_INFO = "auth-file-v1";

/** An opaque 32-byte AES key. Keep it out of logs and error messages. */
export type SyncKey = Uint8Array & { readonly __brand: "PrismSyncKey" };

export class PrismSyncCryptoError extends Schema.TaggedErrorClass<PrismSyncCryptoError>()(
  "PrismSyncCryptoError",
  {
    operation: Schema.Literals(["encrypt", "decrypt"]),
  },
) {
  override get message(): string {
    return this.operation === "decrypt"
      ? "Sync entry could not be decrypted (wrong shared secret or corrupt payload)."
      : "Sync entry could not be encrypted.";
  }
}

export const deriveSyncKey = (sharedSecret: string): SyncKey =>
  new Uint8Array(
    NodeCrypto.hkdfSync("sha256", sharedSecret, HKDF_SALT, HKDF_INFO, KEY_BYTES),
  ) as SyncKey;

export const encryptSyncEntry = (
  key: SyncKey,
  plaintext: Uint8Array,
): Effect.Effect<string, PrismSyncCryptoError> =>
  Effect.try({
    try: () => {
      const nonce = NodeCrypto.randomBytes(NONCE_BYTES);
      const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
      const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString("base64");
    },
    catch: () => new PrismSyncCryptoError({ operation: "encrypt" }),
  });

export const decryptSyncEntry = (
  key: SyncKey,
  ciphertext: string,
): Effect.Effect<Uint8Array, PrismSyncCryptoError> =>
  Effect.try({
    try: () => {
      const bytes = Buffer.from(ciphertext, "base64");
      if (bytes.length < NONCE_BYTES + TAG_BYTES) {
        throw new Error("short");
      }
      const nonce = bytes.subarray(0, NONCE_BYTES);
      const tag = bytes.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
      const data = bytes.subarray(NONCE_BYTES + TAG_BYTES);
      const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAuthTag(tag);
      return new Uint8Array(Buffer.concat([decipher.update(data), decipher.final()]));
    },
    catch: () => new PrismSyncCryptoError({ operation: "decrypt" }),
  });

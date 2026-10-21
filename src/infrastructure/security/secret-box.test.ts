import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "./secret-box.js";

test("cifra y descifra secretos sin guardar el texto plano", () => {
  const previous = process.env.META_TOKEN_ENCRYPTION_KEY;
  process.env.META_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
  try {
    const plaintext = "instagram-token-sensible";
    const encrypted = encryptSecret(plaintext);
    assert.notEqual(encrypted, plaintext);
    assert.equal(decryptSecret(encrypted), plaintext);
    assert.notEqual(encrypted.includes(plaintext), true);
  } finally {
    if (previous === undefined) delete process.env.META_TOKEN_ENCRYPTION_KEY;
    else process.env.META_TOKEN_ENCRYPTION_KEY = previous;
  }
});

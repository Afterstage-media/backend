import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createInstagramOAuthState, readInstagramOAuthState } from "./instagram-oauth.js";

test("firma y valida el estado OAuth sin incluir tokens", () => {
  const previousKey = process.env.META_TOKEN_ENCRYPTION_KEY;
  process.env.META_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
  try {
    const state = createInstagramOAuthState("admin");
    const parsed = readInstagramOAuthState(state);
    assert.equal(parsed.actorId, "admin");
    assert.ok(parsed.nonce);
    assert.ok(!state.includes("access_token"));
    assert.throws(() => readInstagramOAuthState(`${state}x`), /Estado OAuth inválido/);
  } finally {
    if (previousKey === undefined) delete process.env.META_TOKEN_ENCRYPTION_KEY;
    else process.env.META_TOKEN_ENCRYPTION_KEY = previousKey;
  }
});

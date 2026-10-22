import test from "node:test";
import assert from "node:assert/strict";
import { canTransition } from "./workflow.js";

test("el flujo exige revisión antes de aprobar", () => {
  assert.equal(canTransition("draft", "approved"), false);
  assert.equal(canTransition("draft", "review"), true);
  assert.equal(canTransition("review", "approved"), true);
});

test("un contenido publicado puede retirarse y volver a borrador", () => {
  assert.equal(canTransition("published", "draft"), true);
  assert.equal(canTransition("published", "published"), true);
});

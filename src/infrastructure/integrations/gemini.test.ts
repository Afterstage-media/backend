import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { GeminiClient } from "./gemini.js";

test("llama Gemini con JSON y valida la salida tipada", async (context) => {
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  context.after(() => {
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey;
  });
  let requestedUrl = "";
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(input);
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "test-key");
    const request = JSON.parse(String(init?.body)) as { generationConfig: { responseMimeType: string } };
    assert.equal(request.generationConfig.responseMimeType, "application/json");
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"answer":"dato confirmado"}' }] } }] }),
      { status: 200 },
    );
  });
  const result = await new GeminiClient().generate({
    task: "resumir",
    data: { item: 1 },
    schema: z.object({ answer: z.string() }),
  });
  assert.match(requestedUrl, /models\/gemini-3\.8-flash:generateContent/);
  assert.deepEqual(result, { answer: "dato confirmado" });
});

test("requiere GEMINI_API_KEY explícita", async () => {
  const oldKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(
      () => new GeminiClient().generate({ task: "", data: {}, schema: z.object({}) }),
      /GEMINI_API_KEY/,
    );
  } finally {
    if (oldKey !== undefined) process.env.GEMINI_API_KEY = oldKey;
  }
});

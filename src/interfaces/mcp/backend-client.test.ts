import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { BackendClient } from "./backend-client.js";

test("el cliente MCP llama al backend con el token del usuario", async (context) => {
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer user-token");
    assert.equal(request.url, "/api/content/with-ai");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.deepEqual(JSON.parse(body), { brief: "Brief de prueba" });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "note-1", status: "draft" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo abrir el servidor de prueba");

  const client = new BackendClient(`http://127.0.0.1:${address.port}`, "user-token");
  const result = await client.send("/api/content/with-ai", { method: "POST", body: { brief: "Brief de prueba" } });
  assert.deepEqual(result, { id: "note-1", status: "draft" });
});

test("el cliente MCP exige el token del usuario antes de llamar al backend", async () => {
  const client = new BackendClient("http://127.0.0.1:1");
  await assert.rejects(() => client.get("/api/content"), /AFTERSTAGE_ACCESS_TOKEN/);
});

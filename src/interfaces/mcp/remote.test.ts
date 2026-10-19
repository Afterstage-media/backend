import assert from "node:assert/strict";
import test from "node:test";
import { ContentManager } from "../../application/content-manager.js";
import { PressManager } from "../../application/press-manager.js";
import type { ActiveUser, UserDirectory } from "../http/security.js";
import { createApp } from "../http/app.js";
import { MemoryMcpOAuthStore } from "./oauth.js";

test("publica metadata OAuth y desafía una llamada MCP sin credenciales", async () => {
  const previousPublicUrl = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = "https://afterstage.test";
  const user: ActiveUser = { id: "editor-1", roles: ["editor"], permissions: [], active: true };
  const users: UserDirectory = {
    findActiveUser: async (id: string) => (id === user.id ? user : undefined),
    findByIdentifier: async () => undefined,
  };
  const app = await createApp(
    new ContentManager(),
    new PressManager(),
    undefined,
    users,
    undefined,
    undefined,
    new MemoryMcpOAuthStore(),
  );
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo obtener el puerto de prueba");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const metadataResponse = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(metadataResponse.status, 200);
    assert.deepEqual((await metadataResponse.json()) as Record<string, unknown>, {
      resource: "https://afterstage.test/mcp",
      authorization_servers: ["https://afterstage.test/"],
      scopes_supported: ["notes:read", "notes:write"],
      resource_name: "Afterstage",
      resource_documentation: "https://afterstage.test/politica-editorial",
    });

    const mcpResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(mcpResponse.status, 401);
    assert.match(mcpResponse.headers.get("www-authenticate") ?? "", /oauth-protected-resource\/mcp/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (previousPublicUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousPublicUrl;
  }
});

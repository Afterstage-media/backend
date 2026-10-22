import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ContentManager } from "../../application/content-manager.js";
import { PressManager } from "../../application/press-manager.js";
import { hashPassword, issueAccessToken, type ActiveUser, type UserDirectory } from "../http/security.js";
import { createApp } from "../http/app.js";
import { MemoryMcpOAuthStore } from "./oauth.js";
import { createRemoteMcpServer } from "./remote.js";

test("expone la herramienta de creación con un nombre que describe la operación", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createRemoteMcpServer(new ContentManager());
  const client = new Client({ name: "afterstage-test-client", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const result = await client.listTools();
    const toolNames = result.tools.map((tool) => tool.name).sort();
    assert.ok(toolNames.includes("crear_nota"));
    assert.ok(toolNames.includes("get_profile"));
    assert.ok(toolNames.includes("listar_notas"));
    const createTool = result.tools.find((tool) => tool.name === "crear_nota");
    assert.equal(createTool?.title, "Guardar nota redactada por el agente");
    assert.match(createTool?.description ?? "", /Guarda como borrador/);
  } finally {
    await client.close();
    await server.close();
  }
});

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
      scopes_supported: [
        "notes:read",
        "notes:write",
        "agenda:read",
        "agenda:write",
        "directory:read",
        "directory:write",
        "replacements:read",
      ],
      resource_name: "Afterstage",
      resource_documentation: "https://afterstage.test/politica-editorial",
    });

    const authorizationServerMetadata = await fetch(`${base}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServerMetadata.status, 200);
    assert.equal(
      ((await authorizationServerMetadata.json()) as Record<string, unknown>)
        .authorization_response_iss_parameter_supported,
      true,
    );

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

test("permite consultar y revocar las conexiones MCP de la cuenta", async () => {
  const previousJwtSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "test-secret-for-access-management";
  const user: ActiveUser = { id: "admin-1", roles: ["admin"], permissions: [], active: true };
  const users: UserDirectory = { findActiveUser: async (id: string) => (id === user.id ? user : undefined) };
  const store = new MemoryMcpOAuthStore();
  await store.registerClient({
    client_id: "codex-client",
    client_name: "Codex",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: ["http://127.0.0.1:43123/callback"],
    token_endpoint_auth_method: "none",
  });
  await store.createRefreshToken({
    grantId: "6cc5f2d1-5f22-4a2a-971e-c7783fb8c1a1",
    clientId: "codex-client",
    userId: user.id,
    scopes: ["notes:read", "directory:write"],
    issuedAt: Date.now(),
    expiresAt: Date.now() + 30 * 24 * 60 * 60_000,
  });
  const app = await createApp(new ContentManager(), new PressManager(), undefined, users, undefined, undefined, store);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo obtener el puerto de prueba");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${issueAccessToken(user)}` };
  try {
    const listed = await fetch(`${base}/api/account/ai-access`, { headers });
    assert.equal(listed.status, 200);
    const listedConnection = (await listed.json())[0];
    assert.equal(listedConnection.id, "6cc5f2d1-5f22-4a2a-971e-c7783fb8c1a1");
    assert.equal(listedConnection.clientId, "codex-client");
    assert.equal(listedConnection.application, "Codex");
    assert.deepEqual(listedConnection.scopes, ["notes:read", "directory:write"]);
    assert.equal(typeof listedConnection.issuedAt, "number");
    assert.equal(typeof listedConnection.expiresAt, "number");
    const revoked = await fetch(`${base}/api/account/ai-access/6cc5f2d1-5f22-4a2a-971e-c7783fb8c1a1`, {
      method: "DELETE",
      headers,
    });
    assert.equal(revoked.status, 204);
    const remaining = await fetch(`${base}/api/account/ai-access`, { headers });
    assert.deepEqual(await remaining.json(), []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
  }
});

test("redirige al login, conserva la solicitud OAuth y crea la sesión HttpOnly", async () => {
  const previousPublicUrl = process.env.PUBLIC_BASE_URL;
  const previousJwtSecret = process.env.JWT_SECRET;
  process.env.PUBLIC_BASE_URL = "https://afterstage.test";
  process.env.JWT_SECRET = "test-secret-for-oauth-login";
  const password = "una-clave-segura-123";
  const user: ActiveUser & { passwordHash: string } = {
    id: "editor-1",
    roles: ["editor"],
    permissions: [],
    active: true,
    passwordHash: await hashPassword(password),
  };
  const users: UserDirectory = {
    findActiveUser: async (id: string) => (id === user.id ? user : undefined),
    findByIdentifier: async (identifier: string) => (identifier === "redaccion" ? user : undefined),
  };
  const store = new MemoryMcpOAuthStore();
  await store.registerClient({
    client_id: "oauth-test-client",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
    token_endpoint_auth_method: "none",
  });
  const app = await createApp(new ContentManager(), new PressManager(), undefined, users, undefined, undefined, store);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo obtener el puerto de prueba");
  const base = `http://127.0.0.1:${address.port}`;
  const authorizeUrl =
    "/authorize?response_type=code&client_id=oauth-test-client&state=test-state&code_challenge=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLM&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector%2Foauth%2Fcallback&scope=notes%3Aread%20notes%3Awrite&resource=https%3A%2F%2Fafterstage.test%2Fmcp";

  try {
    const redirect = await fetch(`${base}${authorizeUrl}`, { redirect: "manual" });
    assert.equal(redirect.status, 303);
    const loginLocation = redirect.headers.get("location");
    assert.ok(loginLocation);
    assert.match(loginLocation, /^\/oauth\/login\?return_to=/);

    const loginPage = await fetch(`${base}${loginLocation}`);
    assert.equal(loginPage.status, 200);
    const loginHtml = await loginPage.text();
    assert.match(loginHtml, /Ingresar a Afterstage/);
    assert.match(loginHtml, /name="password"/);
    assert.doesNotMatch(loginHtml, /una-clave-segura-123/);

    const login = await fetch(`${base}/oauth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        return_to: authorizeUrl,
        identifier: "redaccion",
        password,
      }),
    });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get("location"), authorizeUrl);
    assert.match(login.headers.get("set-cookie") ?? "", /afterstage_session=.*HttpOnly/);
    assert.match(login.headers.get("set-cookie") ?? "", /Secure/);
    assert.match(login.headers.get("set-cookie") ?? "", /SameSite=Lax/);

    const consent = await fetch(`${base}${authorizeUrl}`, {
      headers: { cookie: login.headers.get("set-cookie") ?? "" },
    });
    assert.equal(consent.status, 200);
    const consentHtml = await consent.text();
    assert.match(consentHtml, /Sesión iniciada en Afterstage/);
    assert.doesNotMatch(consentHtml, /name="password"/);
    assert.doesNotMatch(consentHtml, /name="identifier"/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (previousPublicUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousPublicUrl;
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
  }
});

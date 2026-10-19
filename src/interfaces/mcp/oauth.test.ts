import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, type ActiveUser, type UserDirectory } from "../http/security.js";
import { MemoryMcpOAuthStore, McpOAuthProvider } from "./oauth.js";

const response = () => {
  const result: { body?: string; redirectTo?: string } = {};
  return {
    result,
    type() {
      return this;
    },
    send(body: string) {
      result.body = body;
      return this;
    },
    redirect(_status: number, url: string) {
      result.redirectTo = url;
      return this;
    },
  };
};

test("emite tokens OAuth por usuario, cliente y scope sin credenciales en entorno", async () => {
  const passwordHash = await hashPassword("una-clave-segura-123");
  const user: ActiveUser = { id: "editor-1", roles: ["editor"], permissions: [], active: true };
  const users: UserDirectory = {
    findActiveUser: async (id: string) => (id === user.id ? user : undefined),
    findByIdentifier: async (identifier: string) =>
      identifier === "redaccion" ? { ...user, passwordHash } : undefined,
  };
  const resourceUrl = new URL("https://afterstage.ar/mcp");
  const provider = new McpOAuthProvider({ store: new MemoryMcpOAuthStore(), users, resourceUrl });
  const client = {
    client_id: "codex-client",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: ["http://127.0.0.1:43123/callback"],
    token_endpoint_auth_method: "none",
  };
  await provider.clientsStore.registerClient(client);

  const authorization = response();
  await provider.authorize(
    client,
    {
      redirectUri: client.redirect_uris[0]!,
      codeChallenge: "challenge",
      scopes: ["notes:read", "notes:write"],
      state: "state-1",
      resource: resourceUrl,
    },
    authorization as never,
  );
  const requestId = authorization.result.body?.match(/name="request_id" value="([^"]+)"/)?.[1];
  assert.ok(requestId);

  const approval = response();
  await provider.approveAuthorization(requestId, "redaccion", "una-clave-segura-123", approval as never);
  const code = new URL(approval.result.redirectTo!).searchParams.get("code");
  assert.ok(code);
  assert.equal(await provider.challengeForAuthorizationCode(client, code), "challenge");

  const tokens = await provider.exchangeAuthorizationCode(
    client,
    code,
    undefined,
    client.redirect_uris[0],
    resourceUrl,
  );
  assert.equal(tokens.token_type, "bearer");
  assert.equal(tokens.scope, "notes:read notes:write");
  assert.ok(tokens.refresh_token);

  const authInfo = await provider.verifyAccessToken(tokens.access_token);
  assert.deepEqual(authInfo.extra, { userId: user.id, roles: ["editor"], permissions: [] });
  assert.deepEqual(authInfo.scopes, ["notes:read", "notes:write"]);
});
